# 与上游的契约对照表（跨语言同步面）

> 上游：`open-webui-to-openai-api`（Python/FastAPI，同一作者）。本仓库是它的 Cloudflare Worker 移植版。
> 背景与方案取舍见 [`UPSTREAM-DIFF.zh-CN.md`](../UPSTREAM-DIFF.zh-CN.md) 的 8.10 与 11.1（**已决策：方案 B——契约快照测试 + 对照表**）。
> 首次建立：2026-09-15（对应上游快照：`ce7eac6` + 未提交工作区）。
> 最近核对：2026-09-21（上游快照推进到 `b7599c6`：新增第 15/16 行，其余各行不变）。

## 这张表解决什么问题

两边的契约（字段名、常量表、错误形状）**只存在于各自的源码里**，没有共享 schema。本仓库的测试钉的是"我们自己的形状"，所以"上游改了、我们没跟"这种漂移**不会让我们的测试变红**——已经发生过 2 次：

- **B-8**：上游把模型的偏离值键从 `x_open_webui` 改成 `x_open_webui_deviations`（本仓库已跟进）；
- **B-17**：上游把量化正则从 `Q[0-9](?:_[A-Z0-9]+)*` 收紧为 `+`（本仓库已跟进）。

这张表把"漂移"变成**可发现**：上游发版时按表核对下面每一行（只看这十几处，不必读整份 diff），有变化就更新实现 + 期望值 + "最近核对"日期；没变化也顺手更新日期。

## 使用方式

1. 上游有新提交/发版时，逐行看"上游位置"指向的代码（或 `git -C <上游> diff <旧>..<新> -- <文件>`）。
2. 有变化 → 改本仓库实现 → 改对应测试期望值 → 更新本行的"最近核对"。
3. 新发现的契约 → 在下面**加一行**，并在测试文件顶部/用例注释里补上游锚点（见"锚点约定"）。
4. 只对本仓库生效、与上游无关的差异**不要**写进这张表（那些属于 `UPSTREAM-DIFF` 的 D/F 类）。

预计单次核对的成本：**10-20 分钟**。

## 契约表

| # | 契约 | 上游位置 | 本仓库实现 | 本仓库测试 | 上游测试 | 最近核对 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 挡位顺序 `none→minimal→low→medium→high→xhigh→max` | `model_probe.py:79` | `modelProbe.ts:72`（`EFFORT_ORDER`） | `modelProbe.test.ts`（挡位排序/`sortEfforts` 用例） | `tests/test_units.py` | 2026-09-15 |
| 2 | 能力键四项（vision / function_calling / reasoning / structured_outputs） | `model_probe.py:89-94` | `modelProbe.ts:89`（`CAPABILITY_KEYS`） | `modelProbe.test.ts`（"capabilities never leak keys…"） | `tests/test_units.py` | 2026-09-15 |
| 3 | 9 个受测请求参数（tools、tool_choice、response_format、logprobs、temperature、top_p、stop、seed、parallel_tool_calls） | `model_probe.py:102-112` | `modelProbe.ts:100`（`PROBED_PARAMETERS`） | `probeRound.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 4 | 探测五步与 20 次请求上限（哨兵枚举 → 逐值仅 200 算支持 → 合并参数 + 归因剔除 → 1×1 PNG 视觉 → 省略 effort 的默认行为；`tools`/`tool_choice` 同进退） | `probe_runner.py:328-500` | `probeRound.ts`（`runProbeRound`） | `probeRound.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 5 | 引擎指纹字段集：`{id,root,max_model_len,owned_by,base_model_id,updated_at}` → sha256[:16]，**排除**顶层 `created` | `models.py:141-168` | `modelCatalog.ts`（`modelFingerprint`） | `modelCatalog.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 6 | 对外模型字段白名单（id/object/created/owned_by + name / max_model_len·max_context_length·context_length / quantization / description；私有字段永不出境） | `models.py:239-295` | `modelCatalog.ts`（`normalizeModel`） | `modelCatalog.test.ts`（"normalization keeps…"） | `tests/test_units.py` | 2026-09-15 |
| 7 | 量化正则：`Q<n>` 分支**要求至少一个下划线段**（裸 `Q3` / `q3-omni` 不输出该字段） | `models.py:36-44`（R4） | `modelCatalog.ts`（`QUANT_PATTERN`） | `modelCatalog.test.ts`（"quantization is only claimed when the id really names one"） | `tests/test_units.py` | 2026-09-15 |
| 8 | 偏离值键名：模型对象用 `x_open_webui_deviations.capabilities`（`x_open_webui` 留给信封） | `models.py:289-295`（R9） | `modelCatalog.ts`（`normalizeModel` 尾部） | `modelCatalog.test.ts` / `proxyContract.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 9 | 能力模板语义：`info.meta.capabilities` 是**部署级模板**；模板 = 所有上报模型一致同意的键 | `models.py:104-138` | `modelCatalog.ts`（`sharedDefaultCapabilities`） | `modelCatalog.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 10 | 探测状态机四态与语义（ok / partial / unprobeable / failed；失败不清事实，用 `retry_after`+`last_error` 表达） | `model_probe.py:114-131,904-939` | `types.ts`（`ProbeStatus`/`ModelProbe`）、`modelProbe.ts`（`recordResult`/`recordFailure`） | `modelProbe.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 11 | 退避公式：n=1 → 60s，否则 `min(60·2^(n-1), 21600)`，无抖动 | `model_probe.py:131-132,678-686` | `modelProbe.ts:125-126,694-695` | `modelProbe.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 12 | 被线上请求证伪的挡位（`invalidated_efforts`）：同指纹内跨轮继承、从新结果剔除、并让 `efforts_verified=false` | `model_probe.py:880-911` | `modelProbe.ts`（`recordResult` / `invalidateEffort`）、`types.ts` | `modelProbe.test.ts`（"a level a live request disproved is not resurrected…"） | `tests/test_units.py` | 2026-09-15 |
| 13 | 前缀候选与确认规则（`/api/v1` → `/api`；只有"真的是模型列表"或 401/403 才算确认） | `config.py:217-226`、`upstream.py:303-309` | `upstream.ts:33-39`、`modelCatalog.ts`（`looksLikeModelList`） | `upstream.test.ts` | `tests/test_units.py` | 2026-09-15 |
| 14 | 错误体形状与错误码（`{error:{message,type,param,code}}`；4xx 透传、5xx → 502 `upstream_error`；401/403 → `upstream_unauthorized`；上游的 `Retry-After` 随响应头透传） | `app.py:283-330,595-616` | `proxy.ts`（`openaiError` / `upstreamErrorResponse` / `authFailureResponse`） | `proxyContract.test.ts` | `tests/test_smoke.py` | 2026-09-15 |
| 15 | 透传路径归一化与白名单（H1）：判定值与转发值是同一字符串；含父段、反斜杠或控制字符一律拒绝（最多 3 轮解码，每轮复核）；空段与 `.` 段折叠；白名单为默认拒绝的精确/子树匹配；解析后的最终目标再复核一次 | `config.py:87-132`、`config.py:457-487`、`app.py:1245-1265` | `passthrough.ts`（`normalizePassthroughPath` / `isPassthroughAllowed` / `targetStaysWithinAllowlist`） | `passthrough.test.ts` | `tests/test_units.py:2385-2434` | 2026-09-21 |
| 16 | 爆破联锁（L3）：同一客户端地址窗口内失败达上限 → 429 + `Retry-After`（`too_many_requests`）；触发上限的那次不追记；有效 Key 清零该地址计数；上限 10 / 窗口 60s / 最多记忆 4096 个地址 | `app.py:454-524`、`config.py:389-390` | `auth.ts`（`authThrottleRecord` / `authThrottleClear`）、`proxy.ts`（`handleV1Request` 接线） | `authThrottle.test.ts` | `tests/test_units.py:2565-2611` | 2026-09-21 |

> 上表是与 8.10 的"10 组契约"对应的展开版：原 10 组中的"对外字段白名单 + 量化正则"拆成第 6/7 行、"偏差键名"单列为第 8 行、"被证伪挡位"单列为第 12 行。

## 锚点约定

- **测试文件顶部**：写一段"Contract anchors"注释，列出该文件钉住的契约编号 + 上游位置；
- **单个用例**：在标题或注释里写 `contract with <上游文件:行>`；
- **源码侧**：改动契约实现时，注释里注明上游对应位置（本仓库已有此习惯，如 `modelProbe.ts` 的 `CACHE_VERSION` 注释、`modelCatalog.ts` 的量化正则注释）。

## 触发升级到方案 A 的条件

本表是"人工核对 + 测试兜底"。若出现以下情况，考虑升级为"共享清单 + 代码生成"（见 `UPSTREAM-DIFF.zh-CN.md` 的 11.1.2）：

- 漂移出现**第 3 次**（目前 2 次，均已收口）；或
- 表中契约条数**显著增长**（例如超过 20 条），人工核对成本超过生成器的维护成本。

注意：即使升级到方案 A，**行为型契约**（第 4、10、12 行的"语义"，而不只是常量）仍要靠这张表 + 测试兜底——生成器只能生成数据，生成不了逻辑。
