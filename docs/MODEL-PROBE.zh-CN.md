# 模型探测：设计、迁移与验收

[English](MODEL-PROBE.md) | [简体中文](MODEL-PROBE.zh-CN.md)

本文档是模型探测（model probe）子系统的**事实来源**，整合自早期的
`MIGRATION-model-probe.md`（迁移记录）与 `OPEN-ITEMS.md`（审查 / 修复清单）：
迁移决策、架构、探测算法、对外契约、存储、平台限制、审查处置与验收都在这里。
README 只描述最终行为，本文档记录"**为什么**是这样"。

上游参照：Python 项目提交 `ffef6e2`（*Replace reasoning cache with model probe cache*）
及其后的完善提交。

---

## 1. 对齐范围

| 项目 | Python（`ffef6e2`） | 本 worker |
|---|---|---|
| 探测逻辑 | `model_probe.py`（946 行，纯逻辑） | `worker/src/modelProbe.ts`（1:1 移植） |
| 探测执行 | `app.py::_probe_model`（六步，每模型典型 10 / 最坏 20 次请求） | `worker/src/probeRound.ts` |
| 缓存存放 | `model_probe_cache.json`（version 2） | DO `ModelProbeCoordinator` 的 SQLite（每模型一行），可导出为同样的 JSON 形状 |
| 刷新编排 | `app.py::_refresh_model_probe`（并发 + Semaphore） | DO 串行 + 预算分片 + alarm 自续 |
| 重探判据 | 指纹变化 / 退避到期 / 手动 | 同（**无时间型 TTL**；另有可选「定时巡检」，默认关闭） |
| 对外契约 | `/v1/models` 字段、`x_open_webui` 信封、`GET /v1/models/{id}`、400 自愈 | 同 |

命名硬改名、不做兼容层（决策 D11），因此旧文件名 / 旧 KV 键 / 旧管理端点全部失效。

## 2. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| D1 | 预算档位假设 | **免费层**：默认 40，管理端可改为「付费层 2000」或自定义（4–9000） |
| D2 | 模型间并发 | **串行**，预算精确扣减（单次调用最多 6 个连接处于等待响应头状态，串行只需 1 个） |
| D3 | 超时 | 单请求超时可调（1–120 秒，默认 30）+ 单模型墙钟内部常量 45 秒 |
| D4 | Cron Trigger | **不加**（`wrangler.jsonc` 无 `triggers.crons`）；改由 DO alarm 自续 |
| D5 | 跨机房协调 | **Durable Object 单点协调**，且 **DO 直接持有探测缓存** |
| D6 | 实例元信息 | 默认 `exposeInstanceMeta=true`，`features` 原样透出；**模型内 `x_open_webui.capabilities` 不受该开关控制**（与 Python 一致） |
| D7 | 未确立的能力 | **省略**，不回落到 OWUI 模板 |
| D8 | `reasoning.default_*` | 引擎没说就**省略** |
| D9 | 错误体文案 | 保持 worker 原文案（结构与 Python 同构） |
| D10 | `/v1/models/{id}` | 照抄：**不带信封、不做有限等待**（该模型缺字段时仅在后台为它单独补探，不阻塞响应） |
| D11 | 命名 | **硬改名**，无回落；操作者需重新部署 |
| D12 | 日志 | 轮次级汇总 + 失败/异常逐条（Workers Logs 单请求上限 256 KB） |
| D13 | 落盘粒度 | **每探完一个模型立即写**（DO SQLite 无 KV 的 1 写/秒/键限制） |
| D14 | 测试 | 纯逻辑 + stub fetch 时序测试（`node --test`，零依赖） |
| D15 | 单模型重探 | 提供（管理端表格行内按钮 → `POST /admin/api/probe/refresh {model}`） |

## 3. 架构

```
Worker（薄）                                  Durable Object: ModelProbeCoordinator（每个上游 base_url 一个实例）
├─ GET  /v1/models            ──────────────▶ present(refs, waitSeconds)      强一致读取 + 有界等待
│    1 拉上游 /models                          ├─ SQLite: models 表（每模型一行 JSON，13 字段 + 指纹 + 状态机）
│    2 算指纹 + 规范化（modelCatalog.ts）       │           meta 表（缓存版本、上游前缀、instance_meta、heartbeat_next）
│    3 1 次 RPC 取探测字段 + 实例信封            ├─ alarm: 自续排空队列（15 分钟墙钟/次，无需客户端流量）
│    4 KV: settings:probe                      └─ RPC: refresh / probeOne / invalidate / view
├─ GET  /v1/models/{id}       ──────────────▶ present([ref], 0)               只补该模型、不等待
├─ POST /v1/chat/completions  ── 400/422 命中挡位关键词 ─▶ invalidate(model, effort)
└─ /admin/api/probe*          ──────────────▶ view / refresh / probeOne
```

**为什么用 DO 而不是 KV**（也是对 Python"单进程"的等价物）：

1. 全局唯一实例 → 不会两个机房重复探测同一模型，请求可以等待别处起的轮次；
2. SQLite 强一致 + 可每模型一行写入（KV 跨机房最长约 60 秒最终一致，且单键 1 写/秒）；
3. alarm 单次 15 分钟墙钟，`ctx.waitUntil` 只有响应后 30 秒；
4. RPC 面即读取路径 → 不存在需要对齐的第二份缓存。

预算依然生效：单次调用最多花 `settings.budget` 个上游子请求；预算耗尽就落盘已有结果并
安排 alarm 继续（`ALARM_CONTINUE_MS = 2s`），这也是冷启动能在几秒内收敛、而不是靠一次
请求跑完的原因。

**触发点清单**：管理端「立即探测」/ 行内「重探」（`POST /admin/api/probe/refresh`）、
`/v1/models` 与 `/v1/models/{id}` 的按需补探、400 自愈重探、被预算截断轮次的 alarm 续跑
（`pending_round`），以及**可选的定时巡检**（默认关闭）：复用同一个 DO alarm，唤醒时刻取
`min(退避到期, 心跳刻度)`，刻度到期那次照常跑非强制轮次——无欠账时整轮成本只有拉模型
列表的 1–2 个子请求，有指纹变化才探测，绝不是强制全量重探。间隔取共享刻度表的档位
（每三十分钟到每天，0=关闭），控制台调整、保存后立即重排；刻度持久化在协调者 meta 表
（键 `heartbeat_next`），跨驱逐可恢复。不使用 Cron Trigger，不改 `wrangler.jsonc`。

## 4. 探测算法（六步，全部 `max_tokens=1`）

1. **候选发现**：哨兵 `reasoning_effort: "__probe__"` → 400 枚举外层 schema 的挡位；返回 200 ⇒ `unprobeable`（上游不校验该字段），**但后续步骤照做**；
2. **逐值实证**：每个候选各发一次，**只有 200 计入**；400/422 时顺便挖 `default_effort`（`(default)` 标注只出现在这一层）；解析不出候选 ⇒ 兜底遍历 7 个规范挡位（多花请求，不影响正确性）；
3. **请求参数**：一次带 9 个参数；400 时用 pydantic `loc` 优先、关键词兜底归因，剔除后重试；**`tools` 与 `tool_choice` 一起剔除**；归因到 `reasoning_effort` 或无法归因 ⇒ `unresolved++` 并停止；归因到**已剔除**的参数也会立即停止（否则空转到轮次上限）；循环结束时若有参数未定性 ⇒ `unresolved++`（不得谎报 `ok`）；
4. **视觉**：`content = [text, image_url(1×1 PNG)]`；
5. **默认行为**：省略 `reasoning_effort` → `responseHasReasoning` 判断思考是否默认开启（看不出 ⇒ null，不当结论）；
6. **组装**：只输出已确立的能力键；`supported_parameters` = 未被拒绝的参数 ∪ `{reasoning_effort}`（当挡位非空）；状态 `ok` / `partial`（`unresolved>0`）/ `unprobeable`。

**指纹**：`sha256({id, root, max_model_len, owned_by, base_model_id, updated_at})[:16]`，
**刻意排除顶层 `created`**（vLLM 每次响应重建 model card，实测相隔 3 秒 1789036467 → 1789036470）。
本实现用 Python `json.dumps(sort_keys=True)` 的分隔符拼装，因此与 Python 侧**逐字节一致**（有单测钉住）。
`max_model_len: 0` 是合法值，不得被当成 falsy 丢掉（否则指纹漂移、触发无谓的全量重探）。

**状态机与退避**：`status ∈ {ok, partial, unprobeable, failed}` 描述数据；
`attempts` / `retry_after` / `last_error` 描述下次何时重试，退避 `min(60·2^(n-1), 6h)`。
`ok` / `unprobeable` 是永久结论（指纹不变不再重探、**不等待**）；
**重探失败绝不丢弃已确立的事实**；被预算截断的模型保持原样（不记成失败）。
同 id 重复只探一次（`syncWithModels` 按 id 去重，保留首个指纹）。

## 5. 对外契约

- **每模型**：`id/object/created/owned_by` + 可选 `name`、`max_model_len`/`max_context_length`/`context_length`、`quantization`、`description`、`x_open_webui.capabilities`（相对共享模板的**差异键**）+ 探测附加的 `capabilities`、`supported_parameters`、`reasoning`、`architecture`。
  规则：**拿不准就省略，绝不填默认值**；挡位按 OpenRouter 的排列从大到小 `max → none`（未知挡位排在末尾）。
- **信封**：`{object:"list", data:[…], x_open_webui:{name?, version?, features?, default_model_capabilities?}}`；
  `default_model_capabilities` = **所有上报模型都一致同意的键**（由 Worker 计算并随同一次 RPC 交给协调者）；
  `exposeInstanceMeta=false` 或 `/api/config` 读不到 ⇒ 该键整块不出现。
- **`GET /v1/models/{id}`**：命中返回单个模型对象（无信封）；未命中
  `404 {"error":{"message":"The model 'x' does not exist","type":"invalid_request_error","param":"model","code":"model_not_found"}}`。
  路由必须排在兜底透传之前——上游对未知路径回 **200 + 一页 HTML**。
- **`?limit=`** 继续忽略（与 OpenAI 官方一致）。
- **400 自愈**：上游错误包装体原样返回，自愈在 `ctx.waitUntil` 里异步进行（`invalidate(model, effort)`）。
- **入口校验**：`model` 必须是去空白后非空的字符串，否则 400 `invalid_type`（chat 与 embeddings 两处）。

## 6. 存储与迁移

| 键 / 存储 | 内容 |
|---|---|
| `settings:probe`（KV） | `{enabled, timeout, wait, budget, exposeInstanceMeta}` |
| `settings:touch_interval`（KV） | `last_used` 写入节流粒度（秒） |
| session / apikey / admin（KV） | 低频凭证与配置 |
| `ModelProbeCoordinator`（DO SQLite） | `models(id, data)` 每模型一行；`meta(key, value)` 记账（缓存版本 2、上游前缀、`instance_meta` 实例快照 + 共享能力模板） |

**实例元信息不在 KV**：`/api/config` 快照与 `default_model_capabilities` 存放在 DO 的 `meta` 表
（键 `instance_meta`），刷新由协调者在 `ctx.waitUntil` 里后台完成——Worker 请求既不读 KV 里的
实例状态，也不直接拉 `/api/config`。效果：KV 写预算的最大单项消耗（每 300 秒推进 `fetched_at`
的写入，约 288 次/天）归零，实例数据从"最终一致"变为强一致，慢上游不再把延迟加到 `/v1/models` 上。

后台刷新在**落盘前重读当前快照**再合并（而不是合并到安排刷新时捕获的那一份），因此读取期间
吸收的新能力模板绝不会被回退。`/api/config` 请求本身有 5 秒超时（`INSTANCE_CONFIG_TIMEOUT_MS`）——
它是后台读取，慢实例只让快照晚一个 TTL，而挂住的连接会占满整个上限的 `waitUntil` 槽位。

**旧键不再被读取**：`settings:reasoning`、`reasoning:cache`、`instance:meta`（KV 版）。部署后：

- 探测设置回到默认值（开启 / 30 秒 / 等待 5 秒 / 预算 40 / 实例元信息开启）；
- 探测缓存整体重探（缓存版本 2，旧版本一律忽略）；实例快照在 DO 中重建——首个请求触发后台
  刷新，因此它只带共享能力模板，第二个请求起才带 `name` / `version` / `features`；
- 旧键可手动清理：`wrangler kv key delete --binding KV settings:reasoning`（同理 `reasoning:cache`、`instance:meta`）；
- 首次部署需要 `migrations`（`new_sqlite_classes: ["ModelProbeCoordinator"]`），已写入 `wrangler.jsonc`。

## 7. 平台限制与残余偏差

| 限制 | 影响 | 缓解 / 残余 |
|---|---|---|
| 单次调用子请求上限：免费 50 / 付费 10,000（KV、DO 调用也计入） | 一次调用探不完很多模型 | 预算分片 + alarm 自续；免费层 7 模型冷启动约 2 轮，首轮返回时部分模型尚无字段 |
| `ctx.waitUntil` 仅 30 秒 | 不能把整轮扔后台 | 探测跑在 DO（RPC 墙钟随调用方、alarm 15 分钟） |
| 单次调用最多 6 个连接等待响应头 | 并发上限 | D2 选串行，天然规避 |
| 免费层 CPU 10ms/次调用（DO 文档标 30 秒，待实测） | 大模型列表的 JSON 解析 + N 次 sha256 可能逼近 | 实测确认；必要时降低指纹成本 |
| KV 最终一致（下限 ~60 秒） | 只剩 `settings:*` 与凭证受影响（都不敏感） | 探测数据与实例快照都已移入 DO，不再受影响 |
| KV 写入预算 1,000/天、同键 1 写/秒 | `last_used` 节流会消耗它 | 已移除最细的 10 分钟档位；30 分钟档的安全线约 20 个 API Key |
| DO 单实例（按上游 base_url 分片） | 同一上游的全部 `/v1/models` 读都过它 | 单对象软限制 1,000 请求/秒，个人部署远低于此 |
| 上游压力 ×10（每模型 10 次请求）+ Cloudflare 出口 IP | 可能触发上游限流 | 调小预算/并发、提高退避；属物理事实，无法消除 |
| 无 CLI（Python 有 `--probe`） | 只能从管理端触发 | 管理端「立即探测」/ 行内「重探」 |
| 首次唤醒依赖流量 | 冷部署后第一个请求才开始探测 | DO 被唤醒后自续；D4 选择不加 Cron Trigger；空闲部署可开启「定时巡检」兜底（可选，默认关闭，DO alarm 心跳实现） |
| 上游"接了连接却不答复" | 请求可能被永久挂住 | 全部上游请求都带上限：元信息（模型列表、前缀探测）15 秒、需要响应体 300 秒、流式只限"等待响应头"（`fetchUpstream`） |
| 前缀"不是 404 就算对"（旧规则） | SPA 的 200 + HTML 或临时 5xx 会被缓存成"前缀可用" | 已改为**确认式判定**：只有可读的模型列表或 401/403 才算确认（`confirmUpstreamPrefix`），三个调用方共用同一规则 |
| 盲目 join 在途轮次（旧行为） | 管理端「立即探测」可能什么都没强制、却拿到无关轮次的统计 | 已改为 `canJoinRound`：只有在途轮次至少同样彻底且覆盖同样模型时才加入，否则排队 |

## 8. 审查发现与处置

以下条目来自对代码的专项审查与上游完善提交的逐项核对；**全部已落地**，值得保留的是
"问题 → 结论"的映射（详细的推理已写进对应代码注释）。

**正确性与健壮性**

| 编号 | 发现 | 处置 |
|---|---|---|
| U1 | 前缀判定"非 404 即命中"，SPA 的 200+HTML / 5xx 会被缓存成"可用" | 确认式判定，收敛到 `upstream.ts`；三处调用方（代理 / 连通性测试 / 协调者）共用 |
| U2 | `model` 只判 falsy，`123` / `[]` / 空白串可穿过校验 | 必须是非空字符串，否则 400 `invalid_type` |
| U3 | 参数循环归因到已剔除参数时空转到轮次上限 | 无交集即 `unresolved++` 并中止 |
| U4 | 循环退出时可能仍有未定性参数却报 `ok` | 循环后 `remaining` 非空即 `unresolved++` |
| U5 | `syncWithModels` 未按 id 去重（`force` 路径尤甚） | 按 id 去重、保留首个指纹 |
| U6 | `AUTH_FAILURE_CODES` 三处定义（其中一处是死代码） | 收敛到 `upstream.ts` 单一真源（`PREFIX_CANDIDATES` 一并收敛） |
| U7 | `/api/config` 超时 10 秒 | 改为 5 秒（对齐上游 `INSTANCE_META_TIMEOUT`） |
| R1 | 预算输入框仍是旧的 1–8 范围 | 改为 4–9000 / placeholder 40（与 `PROBE_SETTINGS_BOUNDS` 一致） |
| R2 | 代理与管理端的上游 `fetch` 无超时，可能永久挂住 | `fetchUpstream`：15 秒元信息 / 300 秒响应体 / 流式只限响应头 |
| R3 | `startRound` 的 join 吞掉管理端强制重探 | `canJoinRound`：不兼容则排队，判断抽成 `probeRuntime.ts` 的纯函数 |
| R4 | KV `get(key,"json")` 遇到坏数据会抛错、波及整个请求 | `readKvJson` 宽容读取：坏数据按"不存在"处理 |
| R5 | 关键调用落在 `try` 之外（KV 故障时错误形状不对 / alarm 停摆） | 移入各自的 `try`（proxy 入口、alarm、设置读取） |
| R6 | 首次设密可被抢注 | `ADMIN_PASSWORD` 存在时 `POST /admin/api/setup` 返回 403（`err.setup_secret_exists`） |
| R7 | 后台刷新可能回退能力模板 | 写回前重读当前快照再合并 |
| R8 | `\|\|` 丢弃合法的 `max_model_len: 0`（指纹漂移） | 改用 `??`，指纹与 Python 逐字节一致 |
| R9 | `meta.name.toLowerCase()` 假设字段存在 | `String(meta.name ?? "")` |
| R10 | `stats.cached` 取值时机偏早 | 挪到统计组装处（返回前） |

**清理（新基线的历史包袱）**

| 编号 | 内容 | 处置 |
|---|---|---|
| C1 | 死代码：`adminHasPassword` / `adminNeedsSetup` / `AUTH_FAILURE_CODES`（probeRound 版）/ `ApiKeyRecord` / `AdminSession` | 全部删除 |
| C2 | 仅本文件使用的多余 `export` | 降级为模块内函数（如 `timingSafeEqual`、`hashPassword` 等） |
| C3 | UI 的时间型 TTL / 并发数时代残留（静态文案、失效 i18n 键、`concurrency` 命名） | 清理并改名（`mp.budget_*`、删除 `mp.refresh_off` / `mp.st_fresh` / `mp.st_expired`） |
| C4 | 重复实现：`sessionIsUsable` ×3、`isPlainObject` ×3、前缀常量 ×3、前缀探测 ×2 | 抽成共享模块（`session.ts` / `json.ts` / `upstream.ts`） |
| C5 | 过时注释（指向已删除的 `reasoning.ts`、KV 布局清单等） | 全部更新 |

**部署验证阶段的新发现（2026-09-12，真实部署 + 本地 workerd 复核）**

| 编号 | 问题 | 处置 |
|---|---|---|
| A1 | `RoundUnavailable` 跨 Durable Object RPC 边界后只剩 `name`/`message`：`instanceof` 恒为 false、`code` 字段丢失，控制台把原始字符串 `models_failed` 当错误文案显示（且 HTTP 500） | `roundUnavailableCode()` 按 `name`/`message` 识别，映射回 `err.probe_models_failed` / `err.probe_session_missing`（502） |
| A2 | 刷新响应没有把 `stats.authExpired` 带到顶层，凭证失效中止整轮后控制台仍宣布绿色的"探测完成" | 顶层回传 `authExpired`；横幅改从轮次统计读取（新旧响应都兼容） |
| A3 | 轮次横幅挂在「已缓存的模型及其探测结果」小节标题**上方**，与触发它的「立即探测」按钮脱节 | 横幅移到标题行之下、表格之上（紧邻按钮；DOM 顺序经浏览器实测） |
| A4 | 被预算截断的轮次只把"还有活"交给 alarm，强制属性丢失：alarm 按 `force=false` 重启，会跳过所有仍持有 `ok` 结论的模型——免费层上「立即探测」只重探前 ~4 个，后半列表永远不会被重探，横幅那句"其余由后台继续"也就成了假话 | `runProbeRound` 统计未探完的 `stats.remaining`；截断时把它连同 force 标志写入协调者 meta 表，alarm 按原请求续跑（本地实测：强制重探按 `total` 6→5→4→3→2 逐跳排空）；横幅新增"探测进行中 / 本轮预算已用完 / 其余由后台自动继续"文案 |
| A5 | 预算下拉框把非预设值显示成"免费层（40 子请求/轮）"，与"自定义预算"输入框的关系容易被误解为两个设置 | 下拉框为非预设值增加「自定义（N 子请求/轮）」条目；提示文字说明两者是**同一个** `budget` 值 |

**控制台第二轮调整（2026-09-12，应用户反馈）**

| 编号 | 内容 | 处置 |
|---|---|---|
| A6 | 预算有两个控件（预设下拉框 + 自定义输入框），语义重复 | 删除预设下拉框与 `budgetPresets` API 字段；「每轮子请求预算」成为唯一入口（4–9000，按「保存」生效），提示写明免费层上限 50、建议 ≤40 |
| A7 | 挡位按 `none → max` 升序输出 | 对齐 OpenRouter，改为从大到小 `max → none`（未知挡位仍排末尾）；`EFFORT_ORDER` 同时决定兜底候选的遍历顺序 |
| A8 | 平台的"单次调用子请求上限"（Too many subrequests）被记成**该模型**的失败并进入退避，污染缓存语义 | `isPlatformSubrequestError()` 识别后按预算耗尽处理：整轮截断、该模型保持原样、alarm 在新一次调用中继续——错误绝不进入缓存，客户端不受影响 |
| A9 | 挡位/能力/参数挤在一行，长报错把"支持参数"挤成一行一个字母 | 三列改为一行一条（`.mp-list`），报错独立成行可换行（`.mp-error`）；探测失败的红色报告**常驻**在轮次横幅框中（每次加载都会重新渲染），成功后自动消失 |

## 9. 验收

**静态检查与测试**

```powershell
cd worker
npm.cmd install --ignore-scripts --cache "$env:TEMP\dsh-npm-cache"   # 沙箱内必须用 npm.cmd
npm.cmd run typecheck        # tsc --noEmit，0 error（含 erasableSyntaxOnly 守卫）
npm.cmd test                 # node --test --test-isolation=none --test-concurrency=1
```

当前实测：`typecheck` 0 error；`npm test` **162 项全部通过**（12 个测试文件）：

```text
ℹ tests 162
ℹ pass 162
ℹ fail 0
```

测试套件以 `--test-isolation=none --test-concurrency=1`（同进程、文件串行）运行：stub fetch
的时序测试与走真实 HTTP 的 mock 彩排共存于一个进程，因此必须串行；并且每个替换
`globalThis.fetch` 的测试文件都会在测试前恢复真实 fetch（见各文件的 `beforeEach`）。

覆盖面（摘要）：三种真实报错措辞（含 Qwen 缺 `none`）、"枚举 7 个实际只收 4 个"的两层校验、
参数归因与 `tools`/`tool_choice` 联动剔除、不可归因 ⇒ `partial`、`blamedSet` 无交集 ⇒ 立即停止、
`remaining` 非空 ⇒ 不报 `ok`、unprobeable 仍出能力、预算截断不记失败、401 中止保留已有结果、
截断轮次上报 `stats.remaining`、待续轮次请求在 meta 表中的序列化/解析（含坏值退化、非字符串 id 剔除）、
跨 RPC 边界的 `RoundUnavailable` 仍映射为本地化 502、刷新响应回传 `authExpired`、
网络失败退避、单模型墙钟、逐模型落盘、指纹与 Python 逐字节一致且不含 `created`、
`max_model_len: 0` 不丢、共享能力模板交集、缓存版本闸门、SQL 分片查询、子集对齐不裁剪其它模型、
同 id 重复只探一次、TTL 缓存的命中/过期/在途共享/失败不缓存、`/api/config` 的 HTML 陷阱与
快照合并规则、前缀确认规则（500 / SPA 200+HTML 都不算确认，401/403 算确认）、
`canJoinRound` 的六种组合、KV 坏值退化、`ADMIN_PASSWORD` 存在时 setup 403、连通性测试的三种结果、
心跳唤醒轴（两轴取更早 / 关闭不扰退避 / 不提前唤醒 / 坏刻度退化）、心跳间隔对共享档位
全集的严格写校验、保存设置立即重排心跳。

契约测试（`test/proxyContract.test.ts`，stub fetch + 假 KV + 假 DO）钉住 `/v1/models` 的字段集合与
信封、上游能力模板不泄进 `capabilities`、`exposeInstanceMeta=false` 时信封整块消失、
`enabled=false` 时不请求探测字段、模板由 Worker 计算并随同一次调用交给协调者、
Worker 不再直接请求 `/api/config`、`/v1/models/{id}` 支持含斜杠的 id 且不等待、
未知 id 的 404 精确结构、400 自愈经 `ctx.waitUntil` 调用 `invalidate`、
首选前缀 500 / 200+HTML 时改选 `/api`、全部候选无法确认时仍返回结构化 502、
`model` 非字符串/空白在转发前被拒、上游请求都带 signal、转发请求不含 `accept-encoding` 等。

**本机可复现的运行验证**

- 真实 SQLite 语句：用 Node 24 的 `node:sqlite` 把 `SqliteProbeStore` 全流程跑通——建表、
  `ON CONFLICT ... DO UPDATE`、`IN (?, ...)` 分片（107 个 id 切成 2 条语句）、删除、重开连接、
  版本闸门清空。
- 配置与打包：`wrangler deploy --dry-run` 通过，`env.PROBE (ModelProbeCoordinator)` 被识别为
  Durable Object 绑定。
- workerd 端到端（`npm run mock` + `npm run dev`，mock 上游 6 个模型）：
  - 探测收敛：`probe round finished` 从 `truncated:true` 走到 `truncated:false`，剩余模型由
    **alarm 自续**探完，期间客户端不再发任何请求；
  - 5 条硬断言在 mock 上彩排通过（与 `test/mockUpstream.test.ts` 的断言一致）；
  - `/v1/models` 的字段与信封、`/v1/models/{id}` 的 200、未知 id 的 404 结构与上游一致；
  - **KV 里不再出现 `instance:meta`**（实测：跑完整轮探测后，KV 键列表只剩 session 与 API Key）。

> 上述端到端用的是本机 mock 上游，因此它证明的是**管线**正确；真实引擎的数字仍需按下文核对。

## 10. 真实部署环境验证结果（2026-09-12）

以下结果实测自已部署的 Worker（免费层，上游为真实 Open WebUI 实例，7 个模型全部 `ok`），
其中第 3 项另在本地 workerd（`npm run mock` + `wrangler dev`，budget=12）复核过逐跳排空。

1. **真实上游 5 条硬断言 — 全部通过**：
   - `Qwen3.8-27B` → `supported_efforts == [xhigh, medium, low, none]`（OpenRouter 顺序）、`default_effort == "xhigh"` ✓
   - `gpt-oss-120b` → `[low, medium, high]`、`mandatory == true` ✓
   - `DeepSeek-V4-Flash-0731` → `capabilities.vision == false` ✓
   - `gemma-4-31B-it` / `GLM-OCR` → `capabilities.function_calling == false` ✓
   - 任何模型的 `capabilities` 都没有 `web_search` / `terminal` / `builtin_tools`（它们只出现在
     信封的 `default_model_capabilities` 模板里）✓
   - 注：上游模型列表已从此前的 5 个变为 7 个（新增 `GLM-5.3-Flash`、`Qwen3.5-397B-A17B`），
     两者同样被完整探测，`/v1/models/{id}` 与未知 id 的 404 结构均符合 §5。
2. **免费层额度 — 部分实测**：一次强制全量重探（7 模型 ≈ 70 个子请求）在 `budget=40` 处截断，
   返回 `budgetUsed=40, truncated=true`，与"单次调用最多 `settings.budget` 个子请求"一致；
   本地 workerd（budget=12）逐跳观测到单轮 `budgetUsed=12`、`total` 6→5→4→3→2 递减。
   DO 行写入数与 alarm 内 CPU、每日 KV 读的精确数字仍需 Cloudflare 分析面板，未直接测得。
3. **首次唤醒 / alarm 自续 — 通过**：真实部署上一次「立即探测」在预算处截断（成功 4 个）后，
   客户端不再发任何请求，其余 3 个模型由 alarm 在约 40 秒内探完（`probed_at` 更新、无新请求）；
   本地 workerd 上冷启动与强制重探都以同样方式排空（`probe round finished` 从
   `truncated:true` 走到 `truncated:false`）。
4. **实例信封的两次请求语义 — 通过**：首个 `/v1/models` 请求的信封只含
   `default_model_capabilities`，第二个请求起才带 `name` / `version` / `features`，
   与 `/api/config` 后台刷新（`waitUntil`）的预期一致。

**仍然待办**

- §8 的 A1–A5 修复需要一次重新部署才会在线上生效（见 git 工作区改动）。
- 免费层配额的精确读数（DO 子请求/行写入、alarm CPU、每日 KV 读写）建议在 Cloudflare
  Dashboard → Workers → Metrics / Durable Objects 面板对照观察一轮全量探测。
