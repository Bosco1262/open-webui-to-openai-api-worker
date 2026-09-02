# open-webui-to-openai-api-worker

将「仅支持浏览器登录的 Open WebUI」反代为 **OpenAI 兼容 API** 的 Cloudflare Worker 版本，采用双端架构适配免费层资源限制：

- **本地认证获取端**（`local/`，Python + Playwright）：浏览器登录捕获凭证 → 终端输出 `session.json`。
- **Worker 端**（`worker/`，TypeScript）：对外提供 `/v1/*` OpenAI 兼容接口 + 中文网页管理后台，直接连接上游 Open WebUI。

> 本项目为 [open-webui-to-openai-api](https://github.com/Bosco1262/open-webui-to-openai-api) 的 Cloudflare Worker 迁移版，代理行为与原项目对齐（前缀探测回退、模型列表规范化、SSE 流式、OpenAI 风格错误体）。

## 架构

```
┌─────────────┐   复制粘贴 JSON    ┌───────────────────────────────┐
│  本地端      │ ──────────────────▶ │  Worker（Free + KV）            │
│ login.py    │                    │  /admin        管理界面          │
│ 浏览器登录   │                    │  /admin/api/*  管理 API          │
│ → session   │                    │  /v1/*         OpenAI 兼容代理    │
└─────────────┘                    └──────────────┬────────────────┘
OpenAI 客户端 ──▶ Bearer sk-xxx ──▶  /v1/*        │
                                                  ▼
                                            Open WebUI 上游
```

## 目录结构

```
├── worker/                          # Cloudflare Worker 端
│   ├── src/
│   │   ├── index.ts                 # 入口与路由
│   │   ├── types.ts                 # 共享类型
│   │   ├── kv.ts                    # KV 数据层（内存缓存）
│   │   ├── auth.ts                  # 管理员/客户端鉴权
│   │   ├── session.ts               # 上游凭证请求头
│   │   ├── proxy.ts                 # /v1/* OpenAI 兼容代理
│   │   ├── admin.ts                 # 管理 REST API
│   │   └── ui.ts                    # 管理界面（内嵌单页）
│   ├── wrangler.jsonc               # Worker 配置（KV 绑定）
│   ├── package.json / tsconfig.json
├── local/                           # 本地认证获取端
│   ├── login.py                     # 登录捕获 + 终端输出 session.json
│   ├── requirements.txt
│   └── README.md
└── README.md
```

## 部署 Worker

支持两种方式：

- **方式一（推荐）：Cloudflare 网页连接 GitHub 一键部署** —— fork 仓库后在 Dashboard 连接即可，KV Namespace 会在首次部署时**自动创建**，无需任何手动准备。
- **方式二：命令行 `wrangler` 部署** —— 需要本机安装 Node.js。

> 本项目已在 `worker/wrangler.jsonc` 中启用 Wrangler 的**自动资源供应（Automatic Resource Provisioning）**：KV 绑定只声明 `binding` 不写 `id`，部署时自动创建 KV Namespace（以 Worker 名为前缀）并完成绑定，实现真正的 fork 即一键部署。如需复用已有 KV，可手动补充 `id`。

### 方式一：Cloudflare 网页连接 GitHub 一键部署（Workers Builds）

> Workers Builds 是 Cloudflare 原生 Git 集成：连接仓库后，每次 push 到目标分支都会自动构建并部署，无需本地环境与 CI 脚本。

1. 将本项目 fork / 推送到 GitHub 仓库（保持目录结构不变）。
2. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Connect to Git**（或对已有 Worker：**Settings → Builds → Connect Git Repository**）。
3. 选择 **GitHub**，授权 Cloudflare 的 GitHub App（组织仓库需在 GitHub 组织设置中允许访问）。
4. 选择本仓库与部署分支（如 `main`）。
5. 配置构建设置：

   | 字段         | 值                         |
   | ------------ | -------------------------- |
   | **根目录**   | `worker`                   |
   | **构建命令** | `npm ci && npm run deploy` |

   > 因为 Worker 代码位于仓库的 `worker/` 子目录，Root directory 必须填 `worker`；`npm ci` 按 `package-lock.json` 安装依赖，`npm run deploy` 执行 `wrangler deploy`。

6. 保存后 Cloudflare 会立即构建并部署：**KV Namespace 首次部署时自动创建**，之后 **push 到该分支即自动部署**。

**设置管理密码（可选）**：Cloudflare Dashboard → 该 Worker → **Settings → Variables** → 添加 **Secret** `ADMIN_PASSWORD`。若未设置，首次访问 `/admin` 时会在网页引导设置。

> 密码来源与优先级（与 M365-Copilot2API-on-Cloudflare-Worker 对齐）：
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
3. **生成 API Key**：在 **管理 API Key** 卡片生成 `sk-` 开头的密钥（完整 Key 仅创建时显示一次）。
4. **客户端接入**：

```
Base URL:  https://<你的worker域名>/v1
API Key:   sk-xxxxxxxx
```

```bash
curl https://<你的worker域名>/v1/models \
  -H "Authorization: Bearer sk-xxxxxxxx"
```

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
| GET             | `/v1/models`                            | API Key  | 模型列表（规范化）                 |
| POST            | `/v1/chat/completions`                  | API Key  | 对话补全（含 SSE 流式）            |
| POST            | `/v1/embeddings`                        | API Key  | 向量嵌入                           |
| ANY             | `/v1/{path}`                            | API Key  | 兜底透传                           |

客户端鉴权支持 `Authorization: Bearer <key>` 与 `X-API-Key: <key>` 两种方式。

## 配置说明

| 配置                 | 方式                                        | 说明                                                                                     |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | `wrangler secret put` / Dashboard Variables | 管理密码（可选；Secret 直接验证不写 KV，后台改密后存 KV 并覆盖它） |
| `SESSION_SECRET`     | `wrangler secret put`                       | 会话签名密钥（可选，未设则自动派生存 KV）                                                |
| KV Namespace         | `wrangler.jsonc`（自动创建）                | 存储 session / API Key / 管理密码；绑定省略 `id` 即自动资源供应，首次部署自动创建 |

## 免费层资源适配

- 存储仅使用 **Workers KV**（100k 读/天、1k 写/天）：session 在 Worker 实例内缓存 60 秒；代理路径每次请求仅 1 次 KV 读（API Key 校验）。
- API Key 校验为 O(1)：Key 明文即 KV 键名，无需遍历。
- `last_used` 更新节流（10 分钟/Key）并通过 `ctx.waitUntil` 异步写入。
- SSE 流式通过 `response.body` 直通，CPU 消耗极低。

## 安全提示

- 管理界面与 `/admin/api/*` 全部要求登录会话，请务必设置强密码。
- 无任何密码配置（`none`，如 `ADMIN_PASSWORD` 被移除且从未设过网页密码）时，除首次设密相关接口外管理接口一律返回 403，管理功能不可用，需先在网页设置密码。
- 后台「修改密码」会使所有已登录管理会话立即失效并需重新登录；来自 Secret 的密码在未被后台覆盖前不会写入 KV。
- 登录接口带失败锁定：同一客户端 IP 15 分钟内连续失败 5 次将返回 429 并锁定，可有效减缓暴力破解。
- 客户端 API Key 请妥善保管；完整 Key 仅在生成时显示一次。
- 导入的 Open WebUI 凭证仅存于 KV，界面只展示脱敏摘要。
