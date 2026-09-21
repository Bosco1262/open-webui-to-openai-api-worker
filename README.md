# open-webui-to-openai-api-worker

[English](README.md) | [简体中文](README.zh-CN.md)

A Cloudflare Worker that reverse-proxies a "browser-login-only" Open WebUI into an **OpenAI-compatible API**, using a dual-end architecture to fit free-tier resource limits:

- **Local credential capture** (`local/`, Python + Playwright): sign in via a real browser → prints `session.json` in the terminal.
- **Worker side** (`worker/`, TypeScript): serves `/v1/*` OpenAI-compatible endpoints plus a bilingual web admin console, connecting directly to the upstream Open WebUI.

> This project is a Cloudflare Worker port of [open-webui-to-openai-api](https://github.com/Bosco1262/open-webui-to-openai-api). Proxy behavior is aligned with the original project (prefix probing with fallback, sanitized model list responses, SSE streaming, OpenAI-style error bodies).

## Architecture

```
┌──────────────────┐   copy-paste JSON    ┌────────────────────────────────┐
│   Local side     │ ──────────────────▶ │  Worker (Free plan + KV + DO)  │
│   login.py       │                      │  /admin        admin console   │
│   browser login  │                      │  /admin/api/*  admin REST API  │
│   → session      │                      │  /v1/*         OpenAI proxy    │
└──────────────────┘                      └──────────────┬─────────────────┘
OpenAI clients ──▶ Bearer sk-xxx ──▶  /v1/*            │
                                                         ▼
                                                 Open WebUI upstream
```

`DO` = Durable Object `ModelProbeCoordinator` (SQLite): per-model probe facts and the instance snapshot, driven by its own alarms.

## Repository Layout

```
├── worker/                          # Cloudflare Worker side
│   ├── src/
│   │   ├── index.ts                 # Entry point and routing (re-exports the DO class)
│   │   ├── types.ts                 # Shared types
│   │   ├── kv.ts                    # KV data layer (generic primitives + instance cache)
│   │   ├── intervals.ts             # Shared granularity steps (daily … 30 min, plus 12 h and off)
│   │   ├── touch.ts                 # API-key last_used write throttle
│   │   ├── auth.ts                  # Admin / client authentication
│   │   ├── session.ts               # Upstream credential headers + bounded upstream fetch
│   │   ├── upstream.ts              # Prefix confirmation ("is this really a model list?")
│   │   ├── json.ts                  # isPlainObject shared by the parser modules
│   │   ├── proxy.ts                 # /v1/* OpenAI-compatible proxy
│   │   ├── modelCatalog.ts          # Normalization / engine fingerprint / capability template
│   │   ├── modelProbe.ts            # Probe logic: error-text parsing, payloads, fact assembly
│   │   ├── probeRound.ts            # Six-step probe execution (serial and budgeted)
│   │   ├── probeStore.ts            # Probe persistence (memory + Durable Object SQLite)
│   │   ├── probeRuntime.ts          # Round-scheduling decisions (pure, unit-tested)
│   │   ├── probeSettings.ts         # Probe settings (KV "settings:probe")
│   │   ├── probeCoordinator.ts      # ModelProbeCoordinator Durable Object (alarms + RPC)
│   │   ├── instanceMeta.ts          # Instance snapshot (/api/config) parsing and envelope
│   │   ├── admin.ts                 # Admin REST API
│   │   └── ui.ts                    # Admin console (embedded single page)
│   ├── test/                        # node --test suites (unit + stub-fetch contract tests)
│   ├── mock/                        # Local mock upstream for end-to-end rehearsal
│   ├── wrangler.jsonc               # Worker config (KV + Durable Object bindings, migrations)
│   ├── package.json / tsconfig.json
├── local/                           # Local credential capture
│   ├── login.py                     # Login capture + prints session.json
│   ├── requirements.txt
│   └── README.md
├── MODEL-PROBE.md                   # Model probe design, decisions and verification (EN)
├── MODEL-PROBE.zh-CN.md             # Same document in Simplified Chinese
├── README.md                        # This file
└── README.zh-CN.md                  # Simplified Chinese README
```

## Deploying the Worker

Two deployment methods are supported:

- **Method 1 (recommended): one-click deploy via Cloudflare Dashboard Git integration** — fork the repository and connect it in the Dashboard. The KV Namespace is **created automatically** on first deploy; no manual preparation is needed.
- **Method 2: CLI deployment with `wrangler`** — requires Node.js installed locally.

> **Bind an access entry before first use.** `worker/wrangler.jsonc` ships with `workers_dev: false` and no routes, so a fresh deployment has **no public URL at all**. After deploying, open the Cloudflare Dashboard → your Worker → **Settings → Domains & Routes** and either enable the `workers.dev` subdomain or bind a custom domain / route. Only then is `/admin` reachable for the first-time password setup.

> Automatic Resource Provisioning is enabled in `worker/wrangler.jsonc`: the KV binding declares only a `binding` without an `id`. On deploy, the KV Namespace is created automatically (prefixed with the Worker name) and bound, making a fresh fork truly one-click. To reuse an existing KV, fill in the `id` manually. The Durable Object needs no preparation either: the `migrations` entry creates `ModelProbeCoordinator` on first deploy.

### Method 1: Cloudflare Dashboard Git integration (Workers Builds)

> Workers Builds is Cloudflare's native Git integration: once the repository is connected, every push to the target branch triggers an automatic build and deploy — no local environment or CI scripts required.

1. Fork / push this project to a GitHub repository (keep the directory structure unchanged).
2. Sign in to the Cloudflare Dashboard → **Workers & Pages** → **Create** → **Connect to Git** (or for an existing Worker: **Settings → Builds → Connect Git Repository**).
3. Choose **GitHub** and authorize Cloudflare's GitHub App (organization repositories require access to be allowed in the GitHub org settings).
4. Select this repository and the deployment branch (e.g. `main`).
5. Configure the build settings:

   | Field              | Value                 |
   | ------------------ | --------------------- |
   | **Build command**  | *(leave empty)*       |
   | **Deploy command** | `npx wrangler deploy` |
   | **Root directory** | `/worker`             |

   > The Worker code lives in the `worker/` subdirectory, so the root directory must be `/worker`. The build command can be left empty: Workers Builds automatically installs dependencies (`npm clean-install` from `package-lock.json`) before the build step, and `npx wrangler deploy` runs as the default deploy command — a manually filled `npm install` would only duplicate the automatic dependency installation.

6. After saving, Cloudflare builds and deploys immediately: the **KV Namespace is created automatically on first deploy**, and every subsequent **push to the branch auto-deploys**.

**Set the admin password BEFORE the Worker is reachable (recommended)**: Cloudflare Dashboard → the Worker → **Settings → Variables** → add a **Secret** named `ADMIN_PASSWORD`. If it is not set, the first visit to `/admin` will guide you through setting a password in the web UI — no check is required, so **whoever reaches `/admin` first claims the console**. Set the secret before exposing the Worker, and web setup is closed outright while the secret exists.

> Admin password sources and priority:
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
3. **Generate an API key**: create an `sk-`-prefixed key in the **Manage API Keys** card (the full key is shown only once at creation; only its digest and a masked form are stored).
4. **Connect clients**:

```
Base URL:  https://<your-worker-domain>/v1
API Key:   sk-xxxxxxxx
```

```bash
curl https://<your-worker-domain>/v1/models \
  -H "Authorization: Bearer sk-xxxxxxxx"
```

> `/v1/models` collapses upstream model objects into the standard OpenAI shape `{id, object, created, owned_by}`, plus a whitelist of generic-template fields: `name`, `max_context_length` / `context_length` (with `max_model_len` kept as a compatibility alias), `quantization` (parsed from the model id, e.g. `NVFP4`) and `description`; a model's deviations from the deployment-wide template live under `x_open_webui_deviations.capabilities` (the envelope key `x_open_webui` is separately reserved for instance metadata). **The upstream `info.meta.capabilities` dictionary is no longer echoed** -- `capabilities` only ever carries probed facts. Private upstream fields (`user_id`, `access_grants`, `permission`, `urlIdx`, ...) are never exposed.

### Model probe

> Design record (alignment scope, decisions, architecture, residual deviations, verification): [`MODEL-PROBE.md`](MODEL-PROBE.md).

Aligned with the upstream project (commit `ffef6e2`), each model on `/v1/models` carries fields that were **established by asking the engine**, not an echo of upstream metadata:

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

Rule: **omit what is not established, never fill in a default** -- `architecture` only appears once vision is settled, `capabilities` only carries established keys, and `reasoning.default_effort` / `default_enabled` may be absent. Levels stay in ascending order `none -> max`.

How it works (typically 10, at most 20 real `max_tokens=1` requests per model):

1. **candidate discovery** -- the sentinel `reasoning_effort: "__probe__"` makes the outer schema answer 400 and enumerate the levels it accepts;
2. **per-value verification** -- every candidate is then sent for real and **only a 200 counts**; this is the only layer that catches the model's own parser (gpt-oss's Harmony, Qwen's parser), whose wording differs and may even be incomplete (Qwen's error never mentions `none`, yet `none` works);
3. **request parameters** -- one request carrying all nine parameters under test; on a 400 the offender is attributed (pydantic `loc`, else keywords) and retried without it; `tools` and `tool_choice` are one feature and are dropped together; an unattributable 400 claims nothing and leaves the probe `partial` (and so does a 400 naming a parameter that was already dropped -- the loop stops instead of spinning);
4. **vision** -- `content` becomes `[text, image_url(1x1 PNG)]`;
5. **default behaviour** -- the same request without `reasoning_effort`, observing whether thinking came back (unknowable stays unknown).

- **Facts vs template**: the upstream `info.meta.capabilities` dictionary is a **deployment-wide default template** and is no longer echoed into `capabilities`; the keys every reporting model agrees on become an instance-level fact in the envelope's `x_open_webui.default_model_capabilities`, and a model's own deviating values go under that model's `x_open_webui_deviations.capabilities`.
- **Instance metadata**: the envelope carries `x_open_webui{name, version, features, default_model_capabilities}` read from the upstream `/api/config` (which exists under the legacy `/api` prefix only -- the modern prefix answers 200 with an HTML page, so the legacy prefix is hard-coded and the body is validated as JSON).
- **Controls**: admin console -> **Upstream Server -> Model Probe** card -- feature switch, per-round subrequest budget (presets: free plan 40 / paid plan 2000), per-request timeout (30s) and the bounded `/v1/models` wait (5s, 0 = never wait).
- **State machine**: `ok` (conclusive), `partial` (some request left the answer open; retried with backoff), `unprobeable` (the upstream never validates the field: permanent, no `reasoning` but capabilities are still served) and `failed` (retried with backoff). A failed re-probe **never** throws away facts that were already established.
- **Health and suspension**: the console shows the queue's state as the session's own badge -- the dashboard's "Session Credential" card and the upstream page's "Status" field, where a bare "Imported" used to sit, so a credential the upstream is rejecting can never read as merely "imported". Probing **pauses** after 3 consecutive *permanent* failures (no session, or the upstream rejecting the credentials with 401/403) — transient failures keep retrying with backoff, because only they can be fixed by waiting. A pause costs nothing until an operator acts: re-import the session, run the connectivity check, or press "Probe now" (all three resume it).
- **Re-probe triggers**: an engine fingerprint change (derived from the model list, zero requests, deliberately excluding the top-level `created` that changes on every fetch), backoff expiry, or an operator action. There is **no time-based TTL**. An id repeated in the upstream list is probed once (the first fingerprint wins). An optional **scheduled patrol** (off by default, one of the shared granularity steps from 30 minutes to daily -- the same table as the usage-tracking granularity) rides the DO alarm as a heartbeat: when due it re-aligns the model list and probes only on a fingerprint change, so an idle deployment notices model additions/removals and expired credentials sooner.
- **Prefix detection**: a candidate prefix counts as correct only when the answer really is a model list, or when the upstream rejects the credentials (401/403) -- i.e. the route exists but the session died. A 404, a 5xx and the SPA's "200 + HTML" page all move on to the next candidate, so a broken modern prefix can no longer be cached as "working".
- **Upstream timeouts**: every request this Worker sends upstream is bounded -- 15s for the model list and prefix probes, 300s for a body-producing call, and a streaming call bounds only the wait for the response headers (the SSE body is never cut off). An upstream that accepts the connection and never answers can therefore no longer pin a Worker request open.
- **Concurrent rounds**: the coordinator joins a round only when it is at least as thorough and covers at least the same models; an admin "probe now" therefore queues behind an unrelated request-driven round instead of returning someone else's statistics.
- **Scheduling**: a single Durable Object coordinator drains the queue with its own alarms, so **no client has to trigger it repeatedly**; `/v1/models` only waits (bounded) when a probe for those models is genuinely in flight -- a model in backoff, or one the upstream never validates, is answered immediately.
- **400 self-heal**: a 400/422 on `chat/completions` whose text mentions `reasoning[_ ]effort` drops the level the client used from the cache and schedules a re-probe; **the client still receives the upstream error, re-wrapped exactly as before**.
- **Single-model read**: `GET /v1/models/{id}` returns one normalized model (probe fields included); an unknown id answers 404 `model_not_found`. It carries no envelope and never waits — if that model's probe facts are missing, a background round fills them in for that model alone without blocking the response.

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

This Worker implements the OpenAI-compatible endpoints listed below, plus an allowlisted passthrough (deny-by-default, see below). It does **not** implement image / audio / file endpoints: those requests are forwarded to the upstream as-is, and whether they work depends entirely on the upstream deployment.

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
| GET             | `/admin/api/probe`                      | admin session | Model probe settings & per-model results |
| GET             | `/v1/models`                            | API key      | Model list (sanitized, safe fields only) |
| POST            | `/v1/chat/completions`                  | API key      | Chat completions (incl. SSE streaming) |
| POST            | `/v1/embeddings`                        | API key      | Embeddings                           |
| GET             | `/v1/models/{id}`                       | API key      | One model (probe fields included; unknown id answers 404 `model_not_found`) |

Client authentication accepts both `Authorization: Bearer <key>` and `X-API-Key: <key>`.

> **Passthrough allowlist (what a key may reach).** The `/v1/{path}` catch-all is **deny-by-default**: it forwards `/images`, `/audio` and `/files` (and their subtrees) only. Every other path answers 403 `endpoint_not_allowed` **without making any upstream request**. Previously ANY `/v1/*` path was relayed with the operator's imported credentials, which made every client key equivalent to full access on the upstream account (`/auths`, `/users`, `/configs`, `/chats`, ...). To open another route, change `PASSTHROUGH_ALLOWLIST` in `worker/src/proxy.ts` **and** document it here — each entry hands key holders the operator's upstream privileges on that route.

> **Server-side clients only.** The `/v1` proxy serves no CORS headers and answers no `OPTIONS` preflight, so browser-based pages cannot call it directly — point OpenAI-compatible server-side clients (SDKs, CLIs, gateways) at it.

## Configuration

| Config               | Method                                      | Description                                                                                   |
| -------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | `wrangler secret put` / Dashboard Variables | Admin password (optional; the Secret is verified directly and not written to KV; a console change stores it in KV and overrides it) |
| `SESSION_SECRET`     | `wrangler secret put`                       | Session signing secret (optional; auto-derived and stored in KV if not set). **Use at least 32 characters** — a shorter one weakens the HMAC and the console warns about it |
| KV Namespace         | `wrangler.jsonc` (auto-created)             | Stores session / API-key metadata (`apikey:<sha256>`, the secret itself is never stored) / usage records (`usage:<sha256>`) / admin password / `settings:probe` / `settings:touch_interval`; omitting the binding `id` enables automatic provisioning and creation on first deploy |
| DO `ModelProbeCoordinator` | `wrangler.jsonc` (`migrations`)        | Stores per-model probe results, the upstream prefix and the instance snapshot (`instance_meta`); created on first deploy |

## Free-tier Resource Adaptation

Storage is split in two, each half sitting next to how its data is used.

**KV** (100k reads/day, 1k writes/day; the *rate* limit is about 1 write per second **to the same key**, which is a different figure from the daily quota) carries the low-rate, deployment-level data: session, API-key metadata, usage records, admin credentials and `settings:*`.

- API key verification is O(1): the presented key is hashed and read back as `apikey:<sha256(key)>`, with no iteration needed — and the key material itself is **never stored**, so the dashboard, `wrangler kv key list` or a KV backup cannot hand out working credentials. Keys created under the old layout (plaintext as the KV name) still authenticate and are migrated onto their digest off the critical path. The session is cached in the Worker instance for 60 seconds, so **each proxy request costs exactly one KV read**.
- A corrupt, truncated or hand-edited KV value (a session that no longer parses, a credential record of the wrong shape) degrades to "absent" or to the defaults instead of failing the request that read it, so it stays repairable from the console.
- `last_used` lives under its **own** key (`usage:<sha256(key)>`), written asynchronously via `ctx.waitUntil` and throttled: a never-used key is recorded immediately on its first call, afterwards at most once per configured interval (default: daily, adjustable in the admin console under API Management → Usage Tracking Granularity). With the "Off" step, recording stops entirely: existing history stays, but the "Last Used" column shows a disabled notice. Keeping usage out of the credential record is deliberate — when the two shared one key, a usage write racing a delete could **re-create** the key that had just been revoked.
- **Write budget**: the free plan allows 1,000 writes per day, and "granularity × active API keys" decides the consumption. The 10-minute step wrote 144 times per key per day — seven keys would exhaust the whole daily quota — so it was removed; the finest remaining step (30 minutes) leaves room for roughly 20 keys.

**Durable Object `ModelProbeCoordinator`** (SQLite, one row per model) carries the probe facts and the instance snapshot.

- One row per model probed: this avoids KV's one-write-per-second-per-key limit and never approaches the 1,000-writes-per-day ceiling.
- Reads are strongly consistent: KV is eventually consistent for up to ~60 seconds across locations, which would make a freshly probed model invisible elsewhere; the DO is a single instance backed by SQLite.
- The coordinator caches the probe settings for 15 seconds, keeping a `/v1/models` request at exactly one KV read.
- The instance snapshot (name / version / features from `/api/config`, plus the shared capability template) lives beside the probe facts: the Worker neither reads nor writes instance state in KV, and it no longer fetches `/api/config` itself — the coordinator does that in the background (`waitUntil`), so a slow upstream never adds its latency to `/v1/models`. The background refresh merges into the *current* snapshot rather than the copy captured when it was armed, so a capability template absorbed while the read was in flight is never rolled back.

Model probing costs typically 10 and at most 20 real `max_tokens=1` requests per model. A round is bounded by the per-round subrequest budget (the free plan allows 50 subrequests per invocation, KV and Durable Object calls included); when it runs out, an alarm continues the queue, so **no client has to trigger it repeatedly**. SSE streaming passes through via `response.body`, keeping CPU usage extremely low. Bodies are never forwarded compressed (`accept-encoding` is stripped from the upstream request and `content-encoding` from the response), so a body can always be inspected as text — the same effect as the upstream project's `aiter_raw` → `aiter_bytes` fix — while a streamed body still passes through untouched.

## Security Notes

- The admin console and `/admin/api/*` all require a login session — always set a strong password.
- With no password configured at all (`none`, e.g. `ADMIN_PASSWORD` was removed and a web password was never set), all admin endpoints return 403 except the ones required for first-time setup; the admin features are unavailable until a password is set in the web UI.
- **Preset the `ADMIN_PASSWORD` secret before the domain is public.** The first-visit setup exists for the "nothing configured yet" state, and that state is claimable by anyone who reaches `/admin` first. With the secret bound, `POST /admin/api/setup` answers 403 (`err.setup_secret_exists`) and the web UI cannot replace it; clearing the secret (and deleting the KV hash) is the documented way back to setup.
- **A client key's privileges are exactly the passthrough allowlist above**: `/models`, `/chat/completions`, `/embeddings` plus `/images`, `/audio`, `/files`. The upstream's account, user, config and chat APIs are unreachable with it (403, and no upstream request is made). Passthrough paths are **normalized before that check, and the normalized path is what gets forwarded**, so a spelling like `images/..%2f..%2fapi/config` cannot pass the allowlist and then be resolved into a different upstream route by whatever decodes the path next; a path carrying a parent segment, a backslash or a control character is refused outright. Check that this matches your expectations before handing a key to a third party.
- **Client keys are stored as a digest only**: KV holds `apikey:<sha256(key)>` plus the masked display string. The full key is echoed once, at creation (or rotation).
- "Change password" revokes every logged-in admin session. Both password and API-key revocation go through KV, which **converges across edge locations within about 60 seconds** — not instantly everywhere. Account for that window in any incident response.
- The login endpoint has failure lockout: 5 consecutive failures from the same client IP within 15 minutes return 429. The counter is per Worker isolate, and only `CF-Connecting-IP` is trusted (`X-Forwarded-For` is client-controlled and no longer consulted). **Deployment requirement:** add a Cloudflare WAF Rate Limiting rule for `/admin/api/login` (and `/admin/api/setup`) — rotating across edge locations is only stopped by the WAF layer.
- `/v1/*` carries its own failure interlock: 10 failed proxy-key attempts from the same client address inside 60 seconds answer `429` + `Retry-After` instead of another `401`. It is per Worker isolate on `CF-Connecting-IP` and **carries the same deployment requirement as the login lockout above** — the WAF rate-limiting rule is what makes it binding. Verification runs before the limiter (as in the upstream project), so a correct key still works from an address that is at the limit, and that success clears its streak.
- **The upstream must be HTTPS** (standard port; only `localhost` / `127.0.0.1` may use `http://`, for the local mock rehearsal). Private, link-local and cloud-metadata addresses are refused at import, and the proxy **never follows an upstream redirect** (a 3xx is an error) — so session credentials cannot be put on the wire in cleartext or handed to a third party by a redirect. **This is a platform constraint, not a judgement about local deployments**: a Worker runs on Cloudflare with the upstream somewhere on the public internet, so `http://` really would expose your JWT and cookies. The original Python project is a local process and legitimately supports `http://localhost:8080` / LAN addresses — it does not need (and does not apply) this rule.
- Upstream `set-cookie` / `www-authenticate` and similar session or challenge headers are **not** relayed to clients; a client's own `X-API-Key`, `Cookie`, `X-Forwarded-*`, `Forwarded` and `X-Real-IP` are **not** forwarded upstream (the upstream only ever sees the imported session's credentials).
- **Client headers are forwarded by policy, per endpoint**: the JSON endpoints (`/models`, `/models/{id}`, `/chat/completions`, `/embeddings`) use an **allowlist** — only `accept`, `accept-language`, `content-type`, `range`, `x-request-id` and `openai-*` travel upstream, everything else is dropped by default. The `/v1/{path}` passthrough keeps a denylist (hop-by-hop headers, the client's credentials, `CF-*` and the forwarding headers), because a generic relay has to preserve client-specific headers for multipart uploads and Range downloads to work.
- JSON request bodies are capped at **10 MiB** (the same ceiling the upstream project uses), enforced on the bytes actually read — a chunked body without a `Content-Length` cannot slip past it. Bodies above it answer `413 payload_too_large`.
- An upstream error's own `Retry-After` is passed through to the client (so SDKs back off instead of retrying into a struggling upstream).
- **Deviation from the upstream project:** an upstream error body **is** relayed to the client, truncated, inside the OpenAI error message. The Python project defaults to `EXPOSE_UPSTREAM_ERROR=false`, which logs the body and answers a fixed message plus a request id instead, on the grounds that those bodies name internal hosts and paths. Here the body stays: it is what makes a failing request debuggable for the SDK's user, and this proxy's own internal failures (KV, the coordinator) still answer the fixed message + request id. Set `EXPOSE_UPSTREAM_ERROR` in the Python project, or trim `upstreamErrorResponse` here, if you would rather have the stricter behaviour.
- Admin responses carry `Cache-Control: no-store, private`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a CSP; on HTTPS the admin session cookie uses the `__Host-` prefix.
- Signing out clears the admin session cookie but does **not** revoke an already-issued token — the tokens are stateless, so a stolen one stays valid until it expires. Changing the admin password is what invalidates every outstanding session. Sessions issued before the `__Host-` change keep working; both cookie names are cleared on logout.
- `SESSION_SECRET` (when bound) signs the admin session cookie: use at least 32 characters. Without it the Worker auto-derives a 32-byte random secret in KV — fine for a single-location deployment, but two edge locations can briefly disagree about a freshly derived one (an admin may have to sign in again during that window), so a bound secret is preferred.
- Imported Open WebUI credentials are stored only in KV; the UI shows only a redacted summary. Note that the locally captured `local/session.json` **is a live credential**: delete it once the import has succeeded, and sign in again upstream if it ever leaves your machine.

## License

This project is licensed under the [MIT License](LICENSE).
