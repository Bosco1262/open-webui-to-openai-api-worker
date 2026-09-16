# open-webui-to-openai-api-worker

[English](README.md) | [简体中文](README.zh-CN.md)

将「仅支持浏览器登录的 Open WebUI」反代为 **OpenAI 兼容 API** 的 Cloudflare Worker 版本，采用双端架构适配免费层资源限制：

- **本地认证获取端**（`local/`，Python + Playwright）：浏览器登录捕获凭证 → 终端输出 `session.json`。
- **Worker 端**（`worker/`，TypeScript）：对外提供 `/v1/*` OpenAI 兼容接口 + 中英文网页管理后台，直接连接上游 Open WebUI。

> 本项目为 [open-webui-to-openai-api](https://github.com/Bosco1262/open-webui-to-openai-api) 的 Cloudflare Worker 迁移版，代理行为与原项目对齐（前缀探测回退、模型列表安全收敛、SSE 流式、OpenAI 风格错误体）。

## 架构

```
┌─────────────┐   复制粘贴 JSON      ┌───────────────────────────────┐
│  本地端     │ ──────────────────▶ │  Worker（Free + KV + DO）     │
│ login.py    │                     │  /admin        管理界面        │
│ 浏览器登录  │                      │  /admin/api/*  管理 API       │
│ → session   │                     │  /v1/*         OpenAI 兼容代理 │
└─────────────┘                     └──────────────┬────────────────┘
OpenAI 客户端 ──▶ Bearer sk-xxx ──▶  /v1/*        │
                                                   ▼
                                            Open WebUI 上游
```

`DO` = Durable Object `ModelProbeCoordinator`（SQLite）：逐模型探测事实与实例快照，由自身的 alarm 驱动刷新。

## 目录结构

```
├── worker/                          # Cloudflare Worker 端
│   ├── src/
│   │   ├── index.ts                 # 入口与路由（再导出 Durable Object 类）
│   │   ├── types.ts                 # 共享类型
│   │   ├── kv.ts                    # KV 数据层（通用原语 + 实例缓存）
│   │   ├── intervals.ts             # 共享粒度档位（每天 … 每三十分钟，含 12 小时与关闭）
│   │   ├── touch.ts                 # API Key last_used 写入节流
│   │   ├── auth.ts                  # 管理员 / 客户端鉴权
│   │   ├── session.ts               # 上游凭证请求头 + 带上限的上游 fetch
│   │   ├── upstream.ts              # 前缀确认（候选前缀 + "这真的是模型列表吗"）
│   │   ├── json.ts                  # 各解析模块共用的 isPlainObject
│   │   ├── proxy.ts                 # /v1/* OpenAI 兼容代理
│   │   ├── modelCatalog.ts          # 模型规范化 / 引擎指纹 / 共享能力模板
│   │   ├── modelProbe.ts            # 探测逻辑：报错文本解析、载荷构造、事实组装
│   │   ├── probeRound.ts            # 六步探测执行（串行 + 预算）
│   │   ├── probeStore.ts            # 探测持久化（内存 + Durable Object SQLite）
│   │   ├── probeRuntime.ts          # 轮次调度决策（纯函数，带单测）
│   │   ├── probeSettings.ts         # 探测设置（KV "settings:probe"）
│   │   ├── probeCoordinator.ts      # ModelProbeCoordinator Durable Object（alarm + RPC）
│   │   ├── instanceMeta.ts          # 实例快照（/api/config）解析与信封
│   │   ├── admin.ts                 # 管理 REST API
│   │   └── ui.ts                    # 管理界面（内嵌单页）
│   ├── test/                        # node --test 测试（单元 + stub fetch 契约测试）
│   ├── mock/                        # 本地 mock 上游（端到端彩排）
│   ├── wrangler.jsonc               # Worker 配置（KV + Durable Object 绑定与 migrations）
│   ├── package.json / tsconfig.json
├── local/                           # 本地认证获取端
│   ├── login.py                     # 登录捕获 + 终端输出 session.json
│   ├── requirements.txt
│   └── README.md
├── MODEL-PROBE.md                   # 模型探测：设计与迁移说明（英文）
├── MODEL-PROBE.zh-CN.md             # 同一文档的简体中文版
├── README.md                        # 英文版说明
└── README.zh-CN.md                  # 本文件
```

## 部署 Worker

支持两种方式：

- **方式一（推荐）：Cloudflare 网页连接 GitHub 一键部署** —— fork 仓库后在 Dashboard 连接即可，KV Namespace 会在首次部署时**自动创建**，无需任何手动准备。
- **方式二：命令行 `wrangler` 部署** —— 需要本机安装 Node.js。

> **首次使用前请先绑定访问入口。** `worker/wrangler.jsonc` 中 `workers_dev` 为 `false` 且未声明任何 routes，因此**全新部署没有任何公网入口**。部署完成后，请在 Cloudflare Dashboard → 对应 Worker → **Settings → Domains & Routes** 中启用 `workers.dev` 子域或绑定自定义域名 / 路由；之后 `/admin` 才可达，才能进行首次管理密码设置。

> 本项目已在 `worker/wrangler.jsonc` 中启用 Wrangler 的**自动资源供应（Automatic Resource Provisioning）**：KV 绑定只声明 `binding` 不写 `id`，部署时自动创建 KV Namespace（以 Worker 名为前缀）并完成绑定，实现真正的 fork 即一键部署。如需复用已有 KV，可手动补充 `id`。Durable Object 同样无需任何准备：`migrations` 声明会在首次部署时创建 `ModelProbeCoordinator`。

### 方式一：Cloudflare 网页连接 GitHub 一键部署（Workers Builds）

> Workers Builds 是 Cloudflare 原生 Git 集成：连接仓库后，每次 push 到目标分支都会自动构建并部署，无需本地环境与 CI 脚本。

1. 将本项目 fork / 推送到 GitHub 仓库（保持目录结构不变）。
2. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Connect to Git**（或对已有 Worker：**Settings → Builds → Connect Git Repository**）。
3. 选择 **GitHub**，授权 Cloudflare 的 GitHub App（组织仓库需在 GitHub 组织设置中允许访问）。
4. 选择本仓库与部署分支（如 `main`）。
5. 配置构建设置：

   | 字段                |  值                    |
   | ------------------- | ---------------------- |
   | **构建命令**         | *（留空）*             |
   | **部署命令**         | `npx wrangler deploy`  |
   | **高级设置 - 路径**  | `/worker`              |

   > 因为 Worker 代码位于仓库的 `worker/` 子目录，根目录必须填 `/worker`。构建命令可以留空：Workers Builds 在构建前会自动安装依赖（按 `package-lock.json` 执行 `npm clean-install`），部署命令默认就是 `npx wrangler deploy`——手动填 `npm install` 只会重复自动安装依赖这一步。

6. 保存后 Cloudflare 会立即构建并部署：**KV Namespace 首次部署时自动创建**，之后 **push 到该分支即自动部署**。

**建议在 Worker 对外可达之前就设好管理密码**：Cloudflare Dashboard → 该 Worker → **Settings → Variables** → 添加 **Secret** `ADMIN_PASSWORD`。若未设置，首次访问 `/admin` 时会在网页引导设密——设密过程没有任何校验，因此**谁先访问 `/admin` 谁就占住控制台**。请务必先设 Secret；Secret 存在期间网页设密入口直接关闭。

> 密码来源与优先级：
> - 配置了 `ADMIN_PASSWORD` 时登录直接与 Secret 比对，**不写入 KV**；
> - 首次网页自助设密或后台「修改密码」后，密码以 PBKDF2 哈希存入 **KV**；
> - KV 与 Secret 并存时 **KV 优先**；在管理页修改密码会**覆盖 Secret 生效**，并使所有已登录管理会话立即失效。

> 免费计划包含一定月度构建配额，超出后需升级付费计划；日常增量部署消耗很小。

### 方式二：命令行部署（wrangler CLI）

前置条件：安装 Node.js 18+ 与 npm。

```bash
cd worker
npm install
```

**1. 本地开发预览（可选）**

```bash
npm run dev
# 打开 http://127.0.0.1:8787/admin
```

**2. 部署**

直接执行部署即可——由于启用了自动资源供应，KV Namespace 会在首次部署时自动创建，并把生成的 id **自动写回 `worker/wrangler.jsonc`**：

```bash
npm run deploy
```

> 若想手动指定 KV：`npx wrangler kv namespace create KV` 后把 id 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id` 再部署。

**3.（可选）预设管理密码**

通过 `wrangler secret` 预设管理密码（推荐，也可部署后首次访问网页时设置）：

```bash
npx wrangler secret put ADMIN_PASSWORD
# 输入你要设置的密码
```

部署完成后访问 `https://<你的worker域名>/admin`。

> 管理密码：配置了 `ADMIN_PASSWORD` Secret 则登录时直接与之比对（不写入 KV）；未设置时首次访问 `/admin` 会在网页引导设置（PBKDF2 哈希存入 KV）。若在后台「修改密码」，新密码会写入 KV 并覆盖 Secret 生效，同时踢掉所有旧会话。无任何密码配置（`none`）时，除首次设密相关的必要接口外，其余管理接口一律返回 403。

## 使用流程

1. **本地获取凭证**：按 `local/README.md` 运行 `python login.py --base-url <Open WebUI 地址>`，完成浏览器登录，复制终端输出的 JSON。
2. **导入 Session**：打开 `/admin` → **导入 Session** 卡片 → 粘贴 JSON → 点「校验并测试连通」→「导入 Session」。
3. **生成 API Key**：在 **管理 API Key** 卡片生成 `sk-` 开头的密钥（完整 Key 仅创建时显示一次；KV 中只保存其摘要与脱敏串）。
4. **客户端接入**：

```
Base URL:  https://<你的worker域名>/v1
API Key:   sk-xxxxxxxx
```

```bash
curl https://<你的worker域名>/v1/models \
  -H "Authorization: Bearer sk-xxxxxxxx"
```

> `/v1/models` 会把上游模型对象收敛成标准的 OpenAI 结构 `{id, object, created, owned_by}`，并按白名单透出通用模板字段：`name`、`max_context_length` / `context_length`（`max_model_len` 作为兼容别名保留）、`quantization`（从模型名解析，如 `NVFP4`）与 `description`；模型相对部署级模板的偏离值放在 `x_open_webui_deviations.capabilities`（信封上的 `x_open_webui` 另有含义，专门承载实例元信息）。**上游的 `info.meta.capabilities` 不再透传**——`capabilities` 只承载探测实证的结论。上游私有字段（`user_id`、`access_grants`、`permission`、`urlIdx` 等）一律不透出。

### 模型探测（Model Probe）

> 完整设计记录（对齐范围、决策、架构、残余偏差、验收）：[`MODEL-PROBE.zh-CN.md`](MODEL-PROBE.zh-CN.md)。

与上游项目（提交 `ffef6e2`）对齐，`/v1/models` 的每个模型附带**实证得出**的字段，而不是上游元数据的回声：

```json
{
  "id": "Qwen3.8-27B", "object": "model", "created": 1787109489, "owned_by": "vllm",
  "name": "Qwen3.8-27B", "max_model_len": 262144, "max_context_length": 262144, "context_length": 262144,
  "quantization": "NVFP4",
  "architecture": { "modality": "text->text", "input_modalities": ["text"], "output_modalities": ["text"] },
  "supported_parameters": ["logprobs", "parallel_tool_calls", "reasoning_effort", "response_format", "seed", "stop", "temperature", "tool_choice", "tools", "top_p"],
  "capabilities": { "vision": false, "function_calling": true, "reasoning": true, "structured_outputs": true },
  "reasoning": { "supported_efforts": ["none", "low", "medium", "xhigh"], "mandatory": false, "default_effort": "xhigh", "default_enabled": true }
}
```

规则：**拿不准就省略，绝不填默认值**——`architecture` 只在有视觉结论时输出，`capabilities` 只输出已确立的键，`reasoning.default_effort` / `default_enabled` 可缺省；挡位顺序保持升序 `none → max`。

探测原理（每个模型典型 10 次、最坏 20 次 `max_tokens=1` 的真实请求）：

1. **候选发现**：发送哨兵值 `reasoning_effort: "__probe__"`，外层 schema 会以 400 枚举它接受的挡位；
2. **逐值实证**：每个候选各发一次，**只有 200 算支持**——只有这一层能抓住模型自带解析器（gpt-oss 的 Harmony、Qwen 的解析器）的第二次校验，它们措辞不同、甚至可能不完整（Qwen 的报错没提 `none`，而 `none` 实测可用）；
3. **请求参数**：一次带上 9 个待测参数，400 时按 pydantic `loc` 或关键词归因后剔除重试；`tools` 与 `tool_choice` 属于同一特性，一起剔除；归因不出就不猜，整体标记为 `partial`（400 归因到**已被剔除**的参数也一样——循环会立即停止而不是空转）；
4. **视觉**：`content` 换成 `[text, image_url(1×1 PNG)]`；
5. **默认行为**：省略 `reasoning_effort`，看返回是否带思考文本（看不出来时不下结论）。

- **实证与模板分离**：上游 `info.meta.capabilities` 是**部署级默认模板**，不再透传进 `capabilities`；所有上报模型一致同意的键作为实例级事实放进信封的 `x_open_webui.default_model_capabilities`，某模型自己的偏离值放在该模型的 `x_open_webui_deviations.capabilities`。
- **实例元信息**：信封带 `x_open_webui{name, version, features, default_model_capabilities}`，读自上游 `/api/config`（只存在于旧前缀 `/api`；现代前缀 `/api/v1/config` 会回 200 + 一页 HTML，因此这里硬编码旧前缀并校验 JSON）。
- **开关与调参**：管理控制台 → **上游服务端 → 模型探测** 卡片——功能开关、每轮子请求预算（预设：免费层 40 / 付费层 2000）、单请求超时（默认 30 秒）、`/v1/models` 有限等待（默认 5 秒，0 为不等待）。
- **状态机**：`ok`（结论完整）/ `partial`（有请求未得出答案，按退避重试）/ `unprobeable`（上游从不校验该字段：永久结论，不给 `reasoning` 但仍给能力）/ `failed`（本轮失败，按退避重试）。重探失败**绝不丢弃**已确立的事实。
- **健康与挂起**：控制台把队列状态显示为 Session 自身的徽标——仪表盘「Session 凭证」卡与上游页「状态」字段（取代原先只写「已导入」的那个徽标），因此一份正被上游拒绝的凭证绝不会只显示成"已导入"。**永久类**失败（无 session，或上游以 401/403 拒绝凭证）连续 3 次后探测**暂停**——瞬时类失败继续按退避重试，因为只有它们能靠等待自愈。暂停期间不再消耗任何子请求，直到运维动作：重新导入 Session、跑一次连通性检测、或点「立即探测」（三者都会恢复）。
- **重探判据**：引擎指纹变化（指纹取自模型列表，零请求成本，刻意不含每次响应都变的顶层 `created`）、退避到期或手动触发；**没有时间型 TTL**。上游列表里重复出现的 id 只探一次（以首个指纹为准）。另有可选的**定时巡检**（默认关闭，间隔取共享刻度表的档位：每三十分钟到每天，与「使用记录粒度」同一套刻度）：由 DO alarm 心跳实现，到期时拉一次模型列表对齐、有指纹变化才探测，空闲部署也能更早发现模型增减与凭证过期。
- **前缀判定**：只有当答复确实是模型列表、或上游以 401/403 拒绝凭证（路由存在但会话已死）时，候选前缀才算正确；404、5xx 与 SPA 的 "200 + HTML" 都会继续试下一个。因此"坏掉的现代前缀"不会再被缓存成"可用"。
- **上游超时**：本 Worker 发往上游的每个请求都带上限——元信息（模型列表、前缀探测）15 秒，需要响应体的请求 300 秒，流式请求只限制等待响应头的时间（SSE 响应体绝不被截断）。因此"接了连接却永不答复"的上游无法再永久占住 Worker 请求。
- **并发轮次**：协调者只在在途轮次至少同样彻底、且至少覆盖同样模型时才加入；因此管理端「立即探测」会排在无关的请求驱动轮次后面，而不是返回别人的统计。
- **调度**：Durable Object 单点协调者按自身 alarm 排空队列，**不需要客户端反复触发**；`/v1/models` 只在确有这些模型的探测在飞行中时才做有界等待，退避中或不可探测的模型立即返回。
- **400 自愈**：`chat/completions` 收到 400/422 且文本匹配 `reasoning[_ ]effort` 时，立即从缓存剔除客户端使用的那个挡位并安排重探；**返回给客户端的仍是原样的上游错误包装体**。
- **单模型读取**：`GET /v1/models/{id}` 返回单个规范化模型（含探测字段），未知 id 返回 404 `model_not_found`；它不带信封、不做有限等待——该模型缺探测字段时仅会在后台为它单独补探，不阻塞响应。

Python（OpenAI SDK）：

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-xxxxxxxx",
    base_url="https://<你的worker域名>/v1",
)
resp = client.chat.completions.create(
    model="llama3:latest",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

## API 端点

本 Worker 实现下面列出的 OpenAI 兼容端点，另有**白名单内**的兜底透传（默认拒绝，见下），**不实现**图片 / 音频 / 文件类端点：这类请求会原样转发给上游，能否可用完全取决于上游部署。

| 方法            | 路径                                    | 鉴权     | 说明                               |
| --------------- | --------------------------------------- | -------- | ---------------------------------- |
| GET             | `/`                                     | 无       | 服务信息                           |
| GET             | `/healthz`                              | 无       | 健康检查                           |
| GET             | `/admin`                                | 管理会话 | 管理界面                           |
| GET             | `/admin/api/status`                     | 管理会话 | 状态总览                           |
| POST            | `/admin/api/login` / `setup` / `logout` | —        | 管理登录                           |
| POST            | `/admin/api/password`                  | 管理会话 | 修改管理密码（旧会话全部失效）         |
| POST            | `/admin/api/session`                    | 管理会话 | 导入 Session（支持 `test`/`save`） |
| GET/POST/DELETE | `/admin/api/keys`                       | 管理会话 | API Key 管理                       |
| GET             | `/admin/api/probe`                      | 管理会话 | 模型探测设置与逐模型结果           |
| GET             | `/v1/models`                            | API Key  | 模型列表（安全收敛，仅透出安全字段） |
| POST            | `/v1/chat/completions`                  | API Key  | 对话补全（含 SSE 流式）            |
| POST            | `/v1/embeddings`                        | API Key  | 向量嵌入                           |
| GET             | `/v1/models/{id}`                       | API Key  | 单个模型（含探测字段；未知 id 返回 404 `model_not_found`） |

客户端鉴权支持 `Authorization: Bearer <key>` 与 `X-API-Key: <key>` 两种方式。

> **透传白名单（Key 的权限边界）。** `/v1/{path}` 兜底透传**默认拒绝**：只转发 `/images`、`/audio`、`/files` 三个前缀（含其子树），其余路径一律返回 403 `endpoint_not_allowed`，且**不会发出任何上游请求**。此前任意 `/v1/*` 都会以运维导入的凭证原样转发，等于让每把客户端 Key 拥有上游账号的全权（`/auths`、`/users`、`/configs`、`/chats` 等业务与管理 API 全部可达）。需要放开其它路由时，请同时改 `worker/src/proxy.ts` 的 `PASSTHROUGH_ALLOWLIST` 与本节的说明——每加一条都等于把运维在上游的权限交给 Key 持有者。

> **仅面向服务端客户端。** `/v1` 代理不返回 CORS 头、也不应答 `OPTIONS` 预检，浏览器端页面无法直接调用——请将 OpenAI 兼容的服务端客户端（SDK、CLI、网关）接入本代理。

## 配置说明

| 配置                 | 方式                                        | 说明                                                                                     |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | `wrangler secret put` / Dashboard Variables | 管理密码（可选；Secret 直接验证不写 KV，后台改密后存 KV 并覆盖它） |
| `SESSION_SECRET`     | `wrangler secret put`                       | 会话签名密钥（可选，未设则自动派生存 KV；**建议 ≥ 32 字符**，过短会削弱 HMAC 强度并在控制台提示）                                                |
| KV Namespace         | `wrangler.jsonc`（自动创建）                | 存储 session / API Key 元数据（`apikey:<sha256>`，密钥本身不落盘）/ 使用记录（`usage:<sha256>`）/ 管理密码 / `settings:probe` / `settings:touch_interval`；绑定省略 `id` 即自动资源供应，首次部署自动创建 |
| DO `ModelProbeCoordinator` | `wrangler.jsonc`（`migrations`）      | 存储逐模型探测结果、上游前缀与实例快照（`instance_meta`）；随首次部署自动创建 |

## 免费层资源适配

存储分两处，各自贴近数据的使用方式：

**KV**（100k 读/天、1k 写/天；注意"约 1 写/秒"是**同键写入速率**，与每天 1,000 次的配额是两个不同的口径，不要混用）承载低频的部署级数据：session、API Key 元数据、使用记录、管理凭证与 `settings:*`。

- API Key 校验为 O(1)：对提交的 Key 求 SHA-256 后读取 `apikey:<sha256(key)>`，无需遍历；**密钥本身从不落盘**，因此 Dashboard、`wrangler kv key list` 或一份 KV 备份都无法交出一批可用凭证。旧布局（明文即键名）的 Key 仍可正常鉴权，并会在首次命中时于关键路径之外迁移到哈希键名。`session` 在 Worker 实例内缓存 60 秒，因此**代理路径每次请求恒为 1 次 KV 读**。
- 损坏、被截断或手改过的 KV 值（例如解析不出的 session，或形状不对的 Key 记录）会退化为"不存在"或默认值，而不是让读它的请求失败，因此始终可以从控制台修复。
- `last_used` 写在**独立的** `usage:<sha256(key)>` 键下，通过 `ctx.waitUntil` 异步写入并节流：从未使用的 Key 首次调用立即记录一次，之后至多按配置粒度写一次（默认每天，可在「API 管理 → 使用记录粒度」调整）。粒度选「关闭」后不再记录：历史数据保留，但「最近使用」列会显示"已关闭此功能"。使用记录与凭据记录分离是刻意的——它们共用同一个键时，一次与"删除 Key"并发的使用写入会把刚被撤销的 Key **重建**出来。
- **写入预算**：免费层每天 1,000 次写入，「粒度 × 有效 API Key 数」决定消耗。10 分钟档每个 Key 每天写 144 次、7 个 Key 就会吃满全天配额，因此该档位已移除；保留的最细档位（30 分钟）对应约 20 个 Key 的安全线。

**Durable Object `ModelProbeCoordinator`**（SQLite，每模型一行）承载探测事实与实例快照。

- 每探完一个模型写一行：既避开 KV 的「1 写/秒/键」限制，也不会撞上每天 1,000 次写入的上限。
- 读取强一致：KV 跨机房最长约 60 秒最终一致，会让刚探完的模型在别的机房读不到；DO 是单实例 + SQLite。
- 协调者内部的探测设置缓存 15 秒，因此一次 `/v1/models` 的 KV 读恒为 1 次。
- 实例快照（`/api/config` 的 name / version / features 与共享能力模板）与探测事实同处 DO：Worker 既不读写 KV 里的实例状态，也不直接拉 `/api/config`——后者由协调者在后台（`waitUntil`）完成，慢上游不会把延迟加到 `/v1/models` 上。后台刷新合并进的是**当前**快照，而不是安排刷新时捕获的那一份，因此在读取期间吸收到的新能力模板绝不会被回退。

模型探测每个模型典型 10 次、最坏 20 次 `max_tokens=1` 的真实请求；单轮受「每轮子请求预算」限制（免费层每次调用上限 50 个子请求，KV 与 DO 调用也计入），预算用完由 alarm 续跑，**不依赖客户端反复触发**。SSE 流式通过 `response.body` 直通，CPU 消耗极低。响应体一律不以压缩形式转发（上游请求剥掉 `accept-encoding`，响应剥掉 `content-encoding`），因此响应体总能当文本检查——等价于上游项目把 `aiter_raw` 改为 `aiter_bytes` 的修复——而流式响应体依然原样直通。

## 安全提示

- 管理界面与 `/admin/api/*` 全部要求登录会话，请务必设置强密码。
- 无任何密码配置（`none`，如 `ADMIN_PASSWORD` 被移除且从未设过网页密码）时，除首次设密相关接口外管理接口一律返回 403，管理功能不可用，需先在网页设置密码。
- **请在域名公开之前预设 `ADMIN_PASSWORD` Secret。** 首次设密是为"尚未配置任何密码"的状态而存在的，而那个状态会被第一个访问 `/admin` 的人占住。Secret 绑定时 `POST /admin/api/setup` 会返回 403（`err.setup_secret_exists`），网页无法覆盖它；要回到设密流程，需先清除 Secret（并删除 KV 中的哈希）。
- **客户端 Key 的权限边界就是上面那张透传白名单**：Key 只能访问 `/models`、`/chat/completions`、`/embeddings` 与 `/images`、`/audio`、`/files`；上游的账号、用户、配置、会话等 API 对它不可达（403，且不发上游请求）。分享 Key 给第三方之前请先确认这一点符合预期。
- **客户端 Key 只以摘要形式存储**：KV 里只有 `apikey:<sha256(key)>` 与展示用的脱敏串，完整 Key 仅在创建（或轮转）时回显一次。
- 后台「修改密码」会吊销所有已登录管理会话；密码与 API Key 的吊销都依赖 KV，**最长约 60 秒在所有边缘节点收敛**（并非同一瞬间全局生效）。安全响应（发现泄露后的撤销）请把这个窗口计入。
- 登录接口带失败锁定：同一客户端 IP 15 分钟内连续失败 5 次将返回 429 并锁定。该计数保存在 **Worker 实例本地**，且只信任 `CF-Connecting-IP`（`X-Forwarded-For` 由客户端控制，不再采信）；**部署必选项**：在 Cloudflare WAF 中为 `/admin/api/login`（及 `/admin/api/setup`）配置 Rate Limiting 规则兜底——跨边缘节点轮换只有 WAF 才拦得住。
- **上游必须使用 HTTPS**（`https://`，标准端口；仅 `localhost` / `127.0.0.1` 回环地址允许 `http://`，供本地 mock 彩排）。导入时会拒绝私网、链路本地与云元数据地址，且代理**不会跟随上游的重定向**（3xx 视为错误），避免把 session 凭证以明文或经重定向交给第三方。**这是平台约束，而不是对本地部署的否定**：Worker 跑在 Cloudflare、上游在公网，`http://` 确实会把 JWT 与 Cookie 暴露在链路上；Python 原版是本地进程，支持 `http://localhost:8080` 与局域网地址是合理的——它不需要、也不适用这条规则。
- 上游响应中的 `set-cookie` / `www-authenticate` 等会话与质询头**不会**回传给客户端；客户端自带的 `X-API-Key`、`Cookie`、`X-Forwarded-*`、`Forwarded`、`X-Real-IP` 等也不会被转发给上游（上游只会看到导入的 session 凭证）。
- **客户端请求头按端点分策略转发**：JSON 端点（`/models`、`/models/{id}`、`/chat/completions`、`/embeddings`）使用**白名单**——只有 `accept`、`accept-language`、`content-type`、`range`、`x-request-id` 与 `openai-*` 会送到上游，其余默认丢弃；`/v1/{path}` 兜底透传保留黑名单（逐跳头、客户端凭证、`CF-*` 与转发头），因为通用转发必须保留客户端特有的头，否则 multipart 上传与 Range 下载会坏。
- JSON 请求体上限 **10 MiB**（与上游项目同一数值），且作用于**实际读到的字节**——没有 `Content-Length` 的 chunked 请求体绕不过去；超限返回 `413 payload_too_large`。
- 上游错误自带的 `Retry-After` 会透传给客户端（让 SDK 正确退避，而不是对着已经在请求暂停的上游继续重试）。
- 管理响应统一带 `Cache-Control: no-store, private`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 与 CSP；HTTPS 下管理会话 Cookie 使用 `__Host-` 前缀。
- 登出只会清除管理会话 Cookie，**不会**吊销已签发的令牌——令牌是无状态的，被盗的令牌在过期前依然有效。要让所有设备上的会话一起作废，请修改管理密码。升级前签发的会话仍可用，登出时两个 Cookie 名都会被清除。
- `SESSION_SECRET`（绑定时）用于签发管理会话 Cookie，请使用**不少于 32 个字符**的随机串。未绑定时 Worker 会在 KV 中自动派生一个 32 字节随机密钥——单机房部署完全够用，但两个边缘机房在刚派生的一小段时间内可能各持一份（管理员可能需要在窗口内重新登录一次），因此更推荐显式绑定。
- 导入的 Open WebUI 凭证仅存于 KV，界面只展示脱敏摘要。但**本地捕获的 `local/session.json` 是一份仍然有效的凭证**：导入成功后请删除该文件；一旦它离开你的机器，请重新登录上游以使其失效。

## 开源许可

本项目采用 [MIT License](LICENSE)。
