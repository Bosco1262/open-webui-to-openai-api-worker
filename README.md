# open-webui-to-openai-api-worker

[English](README.md) | [简体中文](README.zh-CN.md)

A Cloudflare Worker that reverse-proxies a "browser-login-only" Open WebUI into an **OpenAI-compatible API**, using a dual-end architecture to fit free-tier resource limits:

- **Local credential capture** (`local/`, Python + Playwright): sign in via a real browser → prints `session.json` in the terminal.
- **Worker side** (`worker/`, TypeScript): serves `/v1/*` OpenAI-compatible endpoints plus a bilingual web admin console, connecting directly to the upstream Open WebUI.

> This project is a Cloudflare Worker port of [open-webui-to-openai-api](https://github.com/Bosco1262/open-webui-to-openai-api). Proxy behavior is aligned with the original project (prefix probing with fallback, model list normalization, SSE streaming, OpenAI-style error bodies).

## Architecture

```
┌──────────────────┐   copy-paste JSON    ┌────────────────────────────────┐
│   Local side     │ ──────────────────▶ │  Worker (Free plan + KV)       │
│   login.py       │                      │  /admin        admin console   │
│   browser login  │                      │  /admin/api/*  admin REST API  │
│   → session      │                      │  /v1/*         OpenAI proxy    │
└──────────────────┘                      └──────────────┬─────────────────┘
OpenAI clients ──▶ Bearer sk-xxx ──▶  /v1/*            │
                                                         ▼
                                                 Open WebUI upstream
```

## Repository Layout

```
├── worker/                          # Cloudflare Worker side
│   ├── src/
│   │   ├── index.ts                 # Entry point and routing
│   │   ├── types.ts                 # Shared types
│   │   ├── kv.ts                    # KV data layer (in-memory cache)
│   │   ├── auth.ts                  # Admin / client authentication
│   │   ├── session.ts               # Upstream credential request headers
│   │   ├── proxy.ts                 # /v1/* OpenAI-compatible proxy
│   │   ├── admin.ts                 # Admin REST API
│   │   └── ui.ts                    # Admin console (embedded single page)
│   ├── wrangler.jsonc               # Worker config (KV binding)
│   ├── package.json / tsconfig.json
├── local/                           # Local credential capture
│   ├── login.py                     # Login capture + prints session.json
│   ├── requirements.txt
│   └── README.md
└── README.md
```

## Deploying the Worker

Two deployment methods are supported:

- **Method 1 (recommended): one-click deploy via Cloudflare Dashboard Git integration** — fork the repository and connect it in the Dashboard. The KV Namespace is **created automatically** on first deploy; no manual preparation is needed.
- **Method 2: CLI deployment with `wrangler`** — requires Node.js installed locally.

> Automatic Resource Provisioning is enabled in `worker/wrangler.jsonc`: the KV binding declares only a `binding` without an `id`. On deploy, the KV Namespace is created automatically (prefixed with the Worker name) and bound, making a fresh fork truly one-click. To reuse an existing KV, fill in the `id` manually.

### Method 1: Cloudflare Dashboard Git integration (Workers Builds)

> Workers Builds is Cloudflare's native Git integration: once the repository is connected, every push to the target branch triggers an automatic build and deploy — no local environment or CI scripts required.

1. Fork / push this project to a GitHub repository (keep the directory structure unchanged).
2. Sign in to the Cloudflare Dashboard → **Workers & Pages** → **Create** → **Connect to Git** (or for an existing Worker: **Settings → Builds → Connect Git Repository**).
3. Choose **GitHub** and authorize Cloudflare's GitHub App (organization repositories require access to be allowed in the GitHub org settings).
4. Select this repository and the deployment branch (e.g. `main`).
5. Configure the build settings:

   | Field              | Value            |
   | ------------------ | ---------------- |
   | **Root directory** | `/worker`        |
   | **Build command**  | `npm install`    |

   > The Worker code lives in the `worker/` subdirectory, so the root directory must be `/worker`; `npm install` installs dependencies from `package-lock.json` and `npx wrangler deploy` runs `wrangler deploy`.

6. After saving, Cloudflare builds and deploys immediately: the **KV Namespace is created automatically on first deploy**, and every subsequent **push to the branch auto-deploys**.

**Set the admin password (optional)**: Cloudflare Dashboard → the Worker → **Settings → Variables** → add a **Secret** named `ADMIN_PASSWORD`. If not set, the first visit to `/admin` will guide you through setting one in the web UI.

> Admin password sources and priority (aligned with M365-Copilot2API-on-Cloudflare-Worker):
> - When `ADMIN_PASSWORD` is configured, login compares against the Secret directly and **never writes to KV**;
> - After first-time web setup or a console "change password", the password is stored in **KV** as a PBKDF2 hash;
> - When both KV and Secret exist, **KV wins**; changing the password in the console **overrides the Secret** and immediately invalidates all logged-in admin sessions.

> The free plan includes a limited monthly build quota; upgrading is required beyond it. Day-to-day incremental deploys consume very little.

### Method 2: CLI deployment (wrangler)

Prerequisites: Node.js 18+ and npm.

```bash
cd worker
npm install
```

**1. Local development preview (optional)**

```bash
npm run dev
# Open http://127.0.0.1:8787/admin
```

**2. Deploy**

Just run the deploy — with automatic resource provisioning enabled, the KV Namespace is created on first deploy and the generated id is **written back to `worker/wrangler.jsonc` automatically**:

```bash
npm run deploy
```

> To specify a KV manually: `npx wrangler kv namespace create KV`, then fill the id into `kv_namespaces[0].id` in `wrangler.jsonc` and deploy again.

**3. (Optional) Preset the admin password**

Preset the admin password via `wrangler secret` (recommended; it can also be set on first web visit after deployment):

```bash
npx wrangler secret put ADMIN_PASSWORD
# Enter the password you want to set
```

After deployment, visit `https://<your-worker-domain>/admin`.

> Admin password: if the `ADMIN_PASSWORD` Secret is configured, login compares against it directly (not written to KV); if not, the first visit to `/admin` guides setup in the web UI (PBKDF2 hash stored in KV). If "change password" is used in the console, the new password is written to KV, overrides the Secret, and all old sessions are signed out. With no password configured at all (`none`), all admin endpoints return 403 except the ones required for first-time setup.

## Usage

1. **Capture credentials locally**: follow `local/README.md` and run `python login.py --base-url <Open WebUI URL>`; finish the browser login and copy the JSON printed in the terminal.
2. **Import the session**: open `/admin` → **Import Session** card → paste the JSON → click "Validate and Test" → "Import Session".
3. **Generate an API key**: create an `sk-`-prefixed key in the **Manage API Keys** card (the full key is shown only once at creation).
4. **Connect clients**:

```
Base URL:  https://<your-worker-domain>/v1
API Key:   sk-xxxxxxxx
```

```bash
curl https://<your-worker-domain>/v1/models \
  -H "Authorization: Bearer sk-xxxxxxxx"
```

Python (OpenAI SDK):

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-xxxxxxxx",
    base_url="https://<your-worker-domain>/v1",
)
resp = client.chat.completions.create(
    model="llama3:latest",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

## API Endpoints

| Method          | Path                                    | Auth         | Description                          |
| --------------- | --------------------------------------- | ------------ | ------------------------------------ |
| GET             | `/`                                     | none         | Service metadata                     |
| GET             | `/healthz`                              | none         | Health check                         |
| GET             | `/admin`                                | admin session | Admin console                       |
| GET             | `/admin/api/status`                     | admin session | Status overview                     |
| POST            | `/admin/api/login` / `setup` / `logout` | —            | Admin login                          |
| POST            | `/admin/api/password`                   | admin session | Change admin password (all old sessions invalidated) |
| POST            | `/admin/api/session`                    | admin session | Import session (supports `test`/`save`) |
| GET/POST/DELETE | `/admin/api/keys`                       | admin session | API key management                  |
| GET             | `/v1/models`                            | API key      | Model list (normalized)             |
| POST            | `/v1/chat/completions`                  | API key      | Chat completions (incl. SSE streaming) |
| POST            | `/v1/embeddings`                        | API key      | Embeddings                           |
| ANY             | `/v1/{path}`                            | API key      | Catch-all passthrough                |

Client authentication accepts both `Authorization: Bearer <key>` and `X-API-Key: <key>`.

## Configuration

| Config               | Method                                      | Description                                                                                   |
| -------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | `wrangler secret put` / Dashboard Variables | Admin password (optional; the Secret is verified directly and not written to KV; a console change stores it in KV and overrides it) |
| `SESSION_SECRET`     | `wrangler secret put`                       | Session signing secret (optional; auto-derived and stored in KV if not set)                   |
| KV Namespace         | `wrangler.jsonc` (auto-created)             | Stores session / API keys / admin password; omitting the binding `id` enables automatic provisioning and creation on first deploy |

## Free-tier Resource Adaptation

- Storage uses only **Workers KV** (100k reads/day, 1k writes/day): the session is cached in the Worker instance for 60 seconds; each proxy request performs only 1 KV read (API key verification).
- API key verification is O(1): the key plaintext is the KV key name, no iteration needed.
- `last_used` updates are throttled (10 minutes per key) and written asynchronously via `ctx.waitUntil`.
- SSE streaming passes through via `response.body`, keeping CPU usage extremely low.

## Security Notes

- The admin console and `/admin/api/*` all require a login session — always set a strong password.
- With no password configured at all (`none`, e.g. `ADMIN_PASSWORD` was removed and a web password was never set), all admin endpoints return 403 except the ones required for first-time setup; the admin features are unavailable until a password is set in the web UI.
- "Change password" in the console immediately invalidates all logged-in admin sessions and requires re-login; a Secret-sourced password is not written to KV unless overridden in the console.
- The login endpoint has failure lockout: 5 consecutive failures from the same client IP within 15 minutes return 429 and lock it out, which slows brute-force attempts.
- Keep client API keys safe; the full key is shown only once at creation.
- Imported Open WebUI credentials are stored only in KV; the UI shows only a redacted summary.

## License

This project is licensed under the [MIT License](LICENSE).
