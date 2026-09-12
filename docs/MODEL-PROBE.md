# Model Probe: Design, Migration and Verification

[English](MODEL-PROBE.md) | [简体中文](MODEL-PROBE.zh-CN.md)

This document is the **source of truth** for the model-probe subsystem, consolidated from
the earlier `MIGRATION-model-probe.md` (migration notes) and `OPEN-ITEMS.md` (review /
fix checklist): the migration decisions, architecture, probe algorithm, served contract,
storage, platform limits, review dispositions and verification all live here. The README
describes the final behaviour; this document records **why** it is that way.

Aligned with the upstream Python project (commit `ffef6e2`: *Replace reasoning cache with
model probe cache*) and its follow-up refinement commit.

---

## 1. Scope and alignment

| Item | Python (`ffef6e2`) | This worker |
|---|---|---|
| Probe logic | `model_probe.py` (946 lines, pure) | `worker/src/modelProbe.ts` (1:1 port) |
| Probe execution | `app.py::_probe_model` (six steps, ~10 typical / 20 worst-case requests per model) | `worker/src/probeRound.ts` |
| Cache storage | `model_probe_cache.json` (version 2) | The `ModelProbeCoordinator` DO's SQLite (one row per model), exportable in the same JSON shape |
| Refresh orchestration | `app.py::_refresh_model_probe` (concurrency + Semaphore) | DO serial + budget sharding + self-continuing alarm |
| Re-probe triggers | Fingerprint change / backoff expiry / manual | Same (**no time-based TTL**) |
| Served contract | `/v1/models` fields, the `x_open_webui` envelope, `GET /v1/models/{id}`, 400 self-heal | Same |

Renames are hard, with no compatibility layer (decision D11), so old file names / KV keys /
admin endpoints are all gone.

## 2. Design decisions

| # | Decision | Outcome |
|---|---|---|
| D1 | Budget assumption | **Free plan**: default 40, switchable in the admin console to "paid 2000" or a custom value (4–9000) |
| D2 | Inter-model concurrency | **Serial**, with exact budget accounting (one invocation may have only six connections waiting for response headers; a serial round needs one) |
| D3 | Timeouts | Per-request timeout is tunable (1–120s, default 30) + a 45s per-model wall clock, an internal constant |
| D4 | Cron Trigger | **Not added** (no `triggers.crons` in `wrangler.jsonc`); the DO alarm keeps the queue going |
| D5 | Cross-colo coordination | **A single Durable Object coordinator**, and the **DO itself holds the probe cache** |
| D6 | Instance metadata | `exposeInstanceMeta=true` by default, `features` passed through verbatim; a model's own `x_open_webui.capabilities` is **not** governed by this switch (same as Python) |
| D7 | Unestablished capabilities | **Omitted**, never filled in from the OWUI template |
| D8 | `reasoning.default_*` | **Omitted** unless the engine says otherwise |
| D9 | Error bodies | This worker's own wording (structurally isomorphic to Python) |
| D10 | `/v1/models/{id}` | Copied: **no envelope, never triggers a probe** |
| D11 | Naming | **Hard rename**, no fallback; operators redeploy |
| D12 | Logging | Round-level summaries + one line per failure/exception (256 KB per-request cap in Workers Logs) |
| D13 | Persistence granularity | **Write as soon as each model lands** (DO SQLite has no KV 1-write/s/key limit) |
| D14 | Tests | Pure logic + stub-fetch timing tests (`node --test`, zero dependencies) |
| D15 | Single-model re-probe | Provided (row button in the admin table → `POST /admin/api/probe/refresh {model}`) |

## 3. Architecture

```
Worker (thin)                                 Durable Object: ModelProbeCoordinator (one instance per upstream base_url)
├─ GET  /v1/models            ──────────────▶ present(refs, waitSeconds)      strongly consistent + bounded wait
│    1 fetch upstream /models                  ├─ SQLite: models table (one JSON row per model: 13 fields + fingerprint + state)
│    2 fingerprint + normalize (modelCatalog.ts)│           meta table (cache version, upstream prefix, instance_meta)
│    3 ONE RPC for probe fields + envelope     ├─ alarm: drains the queue (15 min wall time per run, no client traffic needed)
│    4 KV: settings:probe                      └─ RPC: refresh / probeOne / invalidate / view
├─ GET  /v1/models/{id}       ──────────────▶ present([ref], 0)               never triggers a probe
├─ POST /v1/chat/completions  ── 400/422 mentioning the effort keyword ─▶ invalidate(model, effort)
└─ /admin/api/probe*          ──────────────▶ view / refresh / probeOne
```

**Why a DO instead of KV** (also the equivalent of Python's "one long-lived process"):

1. one instance for the whole deployment → no two colos probe the same model, and a request
   can wait for a round started elsewhere;
2. SQLite is strongly consistent and can be written per model (KV is eventually consistent
   for up to ~60s and allows one write per second per key);
3. an alarm handler gets 15 minutes of wall time, while `ctx.waitUntil` is cut off 30s after
   the response;
4. the RPC surface is also the read path → there is no second cache to reconcile.

The budget still applies: one invocation may spend at most `settings.budget` upstream
subrequests. When it runs out, the round persists what it has and arms an alarm
(`ALARM_CONTINUE_MS = 2s`), which is why a cold deployment converges over a few seconds
instead of one request.

## 4. Probe algorithm (six steps, all `max_tokens=1`)

1. **Candidate discovery** -- the sentinel `reasoning_effort: "__probe__"` makes the outer
   schema answer 400 and enumerate the levels it accepts; a 200 means `unprobeable` (the
   upstream never validates the field), **but the later steps still run**;
2. **Per-value verification** -- every candidate is sent for real and **only a 200 counts**;
   the 400/422 text is also mined for `default_effort` (the `(default)` marker only appears
   at this layer); if no candidate parses, sweep the seven canonical levels as a fallback
   (costs requests, never correctness);
3. **Request parameters** -- one request carrying all nine parameters; on a 400 the offender
   is attributed via pydantic `loc` first and keywords second, then retried without it;
   **`tools` and `tool_choice` are dropped together**; a blame on `reasoning_effort` or an
   unattributable 400 ⇒ `unresolved++` and stop; a blame on an **already-dropped** parameter
   also stops immediately (otherwise the loop spins to the round cap); exiting the loop with
   parameters still undecided ⇒ `unresolved++` (never claim `ok`);
4. **Vision** -- `content = [text, image_url(1x1 PNG)]`;
5. **Default behaviour** -- the same request without `reasoning_effort`; `responseHasReasoning`
   decides whether thinking is on by default (unknowable stays null, claiming nothing);
6. **Assembly** -- emit only established capability keys; `supported_parameters` = the
   parameters the engine did not reject ∪ `{reasoning_effort}` (when levels exist); status
   `ok` / `partial` (`unresolved>0`) / `unprobeable`.

**Fingerprint**: `sha256({id, root, max_model_len, owned_by, base_model_id, updated_at})[:16]`,
**deliberately excluding the top-level `created`** (vLLM rebuilds the model card on every
response; measured 1789036467 → 1789036470 three seconds apart). It is assembled with Python's
`json.dumps(sort_keys=True)` separators, so it is **byte-identical** to the Python side (pinned
by a unit test). `max_model_len: 0` is a legal value and must not be dropped as falsy (that
would drift the fingerprint and trigger a pointless full re-probe).

**State machine and backoff**: `status ∈ {ok, partial, unprobeable, failed}` describes the
data; `attempts` / `retry_after` / `last_error` describe when to try again, with backoff
`min(60·2^(n-1), 6h)`. `ok` / `unprobeable` are permanent conclusions (no re-probe while the
fingerprint holds, and **no waiting**); a failed re-probe **never** throws away facts that were
already established; a model truncated by the budget keeps its previous entry (that is not a
failure). A repeated id is probed once (`syncWithModels` deduplicates by id, first fingerprint
wins).

## 5. Served contract

- **Per model**: `id/object/created/owned_by` + optional `name`,
  `max_model_len`/`max_context_length`/`context_length`, `quantization`, `description`,
  `x_open_webui.capabilities` (the **diff keys** against the shared template) + probe-added
  `capabilities`, `supported_parameters`, `reasoning`, `architecture`.
  Rule: **omit what is not established, never fill in a default**; levels stay in ascending
  order `none → max`.
- **Envelope**: `{object:"list", data:[…], x_open_webui:{name?, version?, features?, default_model_capabilities?}}`;
  `default_model_capabilities` = the keys **every reporting model agrees on** (computed by the
  Worker and handed to the coordinator in the same RPC call); with `exposeInstanceMeta=false`
  or an unreadable `/api/config`, the whole block disappears.
- **`GET /v1/models/{id}`**: returns one model object on a hit (no envelope); a miss answers
  `404 {"error":{"message":"The model 'x' does not exist","type":"invalid_request_error","param":"model","code":"model_not_found"}}`.
  The route must be registered before the catch-all passthrough -- the upstream answers an
  unknown path with **200 and a page of HTML**.
- **`?limit=`** remains ignored (matching OpenAI proper).
- **400 self-heal**: the upstream error body is returned verbatim; healing happens
  asynchronously in `ctx.waitUntil` (`invalidate(model, effort)`).
- **Entry validation**: `model` must be a non-empty string after trimming, otherwise 400
  `invalid_type` (both chat and embeddings).

## 6. Storage and migration

| Key / store | Contents |
|---|---|
| `settings:probe` (KV) | `{enabled, timeout, wait, budget, exposeInstanceMeta}` |
| `settings:touch_interval` (KV) | `last_used` write-throttle granularity (seconds) |
| session / apikey / admin (KV) | Low-rate credentials and configuration |
| `ModelProbeCoordinator` (DO SQLite) | `models(id, data)` one row per model; `meta(key, value)` bookkeeping (cache version 2, upstream prefix, the `instance_meta` snapshot + shared capability template) |

**The instance snapshot is not in KV**: the `/api/config` snapshot and
`default_model_capabilities` live in the DO's `meta` table (key `instance_meta`), refreshed in
the background from the coordinator's `ctx.waitUntil` -- a Worker request never reads instance
state from KV and never fetches `/api/config` itself. Effect: the biggest single consumer of
the KV write budget (bumping `fetched_at` every 300s, ~288 writes/day) drops to zero, instance
data becomes strongly consistent, and a slow upstream no longer adds its latency to `/v1/models`.

The background refresh re-reads the **current** snapshot before writing, instead of merging into
the copy captured when the refresh was armed, so a capability template absorbed while the read
was in flight is never rolled back. The `/api/config` request itself has a 5s timeout
(`INSTANCE_CONFIG_TIMEOUT_MS`): it is a background read, a slow instance only delays the
snapshot by one TTL, while a hung connection would hold a `waitUntil` slot for the whole ceiling.

**Old keys are no longer read**: `settings:reasoning`, `reasoning:cache`, `instance:meta` (the
KV version). After deploying:

- probe settings fall back to their defaults (on / 30s / wait 5s / budget 40 / instance meta on);
- the probe cache is fully re-probed (cache version 2; older versions are ignored wholesale);
  the instance snapshot is rebuilt inside the DO -- the first request arms the background
  refresh, so it carries only the shared capability template, and `name` / `version` /
  `features` appear from the second request on;
- the old keys can be deleted by hand: `wrangler kv key delete --binding KV settings:reasoning`
  (likewise `reasoning:cache`, `instance:meta`);
- the first deploy needs the `migrations` entry (`new_sqlite_classes: ["ModelProbeCoordinator"]`),
  already present in `wrangler.jsonc`.

## 7. Platform limits and residual deviations

| Limit | Impact | Mitigation / residual |
|---|---|---|
| Subrequests per invocation: 50 free / 10,000 paid (KV and DO calls included) | One invocation cannot probe many models | Budget sharding + self-continuing alarms; a free-plan cold start over 7 models takes ~2 rounds, so the first response has fields missing for some models |
| `ctx.waitUntil` is 30s only | A whole round cannot be thrown into the background | Probing runs in the DO (RPC wall clock follows the caller; alarms get 15 minutes) |
| At most 6 connections waiting for response headers per invocation | Concurrency ceiling | D2 chose serial, which never hits it |
| Free-plan CPU 10ms per invocation (DO docs say 30s; to be measured) | JSON parsing + N sha256 calls over a large model list may approach it | Measure; reduce fingerprint cost if needed |
| KV eventual consistency (up to ~60s) | Now affects only `settings:*` and credentials (none of them sensitive) | Probe data and the instance snapshot both live in the DO |
| KV write budget 1,000/day, one write/s/key | The `last_used` throttle consumes it | The 10-minute step was removed; the finest remaining step (30 min) leaves room for ~20 API keys |
| One DO instance (sharded by upstream base_url) | Every `/v1/models` read for that upstream goes through it | Soft limit of 1,000 req/s per object; a personal deployment is far below it |
| Upstream load x10 (~10 requests per model) + Cloudflare egress IPs | May trigger upstream rate limits | Lower the budget/concurrency, raise backoff; a physical fact that cannot be removed |
| No CLI (Python has `--probe`) | Triggering is admin-console only | "Probe now" / per-row "re-probe" in the console |
| First wake-up depends on traffic | A cold deployment starts probing with the first request | The DO keeps going by itself once awake; D4 chose not to add a Cron Trigger |
| An upstream that accepts the connection and never answers | A request could hang forever | Every upstream request is bounded: 15s for metadata (model list, prefix probing), 300s for a body-producing call, and a streaming call bounds only the wait for headers (`fetchUpstream`) |
| Prefix probing: "anything but a 404 is a hit" (old rule) | The SPA's 200+HTML, or a temporary 5xx, was cached as "the prefix works" | Now **confirmation-based**: only a readable model list or a 401/403 confirms (`confirmUpstreamPrefix`); all three call sites share the rule |
| Blindly joining an in-flight round (old behaviour) | An admin "probe now" could force nothing yet return someone else's statistics | Now `canJoinRound`: join only when the in-flight round is at least as thorough and covers at least the same models, otherwise queue |

## 8. Review findings and dispositions

The items below come from a dedicated code review and a line-by-line comparison with the
upstream refinement commit; **all are landed**. What is worth keeping is the problem →
outcome mapping (the detailed reasoning lives in the corresponding code comments).

**Correctness and robustness**

| # | Finding | Disposition |
|---|---|---|
| U1 | Prefix probing treated "anything but 404" as a hit, so the SPA's 200+HTML / a 5xx was cached as "working" | Confirmation-based, consolidated in `upstream.ts`; all three call sites (proxy / connectivity test / coordinator) share it |
| U2 | `model` was only checked for falsiness: `123` / `[]` / blank strings got through | Must be a non-empty string, otherwise 400 `invalid_type` |
| U3 | The parameter loop spun to the round cap when a 400 blamed an already-dropped parameter | No intersection with `remaining` ⇒ `unresolved++` and stop |
| U4 | The loop could exit with parameters undecided yet report `ok` | `remaining` non-empty after the loop ⇒ `unresolved++` |
| U5 | `syncWithModels` did not deduplicate ids (especially on the `force` path) | Deduplicate by id, keeping the first fingerprint |
| U6 | `AUTH_FAILURE_CODES` defined in three places (one of them dead code) | Consolidated into `upstream.ts` as the single source of truth (`PREFIX_CANDIDATES` too) |
| U7 | `/api/config` timeout was 10s | Reduced to 5s (aligned with upstream `INSTANCE_META_TIMEOUT`) |
| R1 | The budget input still had the old 1–8 range | Now 4–9000 / placeholder 40 (matching `PROBE_SETTINGS_BOUNDS`) |
| R2 | Upstream `fetch` calls in the proxy and admin console had no timeout and could hang forever | `fetchUpstream`: 15s metadata / 300s body / streaming bounds only the header wait |
| R3 | `startRound`'s join swallowed an admin force re-probe | `canJoinRound`: incompatible requests queue; the decision is a pure function in `probeRuntime.ts` |
| R4 | KV `get(key,"json")` threw on malformed data and took the whole request down | `readKvJson` reads tolerantly: malformed data counts as absent |
| R5 | Key calls sat outside `try` (wrong error shape on KV failure / a stalled alarm) | Moved inside their `try` blocks (proxy entry, alarm, settings read) |
| R6 | First-visit setup could be claimed by whoever arrived first | With `ADMIN_PASSWORD` bound, `POST /admin/api/setup` answers 403 (`err.setup_secret_exists`) |
| R7 | A background refresh could roll the capability template back | Re-read the current snapshot before writing |
| R8 | `\|\|` dropped a legal `max_model_len: 0` (fingerprint drift) | Switched to `??`; the fingerprint is byte-identical to Python |
| R9 | `meta.name.toLowerCase()` assumed the field exists | `String(meta.name ?? "")` |
| R10 | `stats.cached` was sampled too early | Moved to the statistics assembly (before returning) |

**Cleanup (debris from the old baseline)**

| # | Item | Disposition |
|---|---|---|
| C1 | Dead code: `adminHasPassword` / `adminNeedsSetup` / `AUTH_FAILURE_CODES` (the probeRound copy) / `ApiKeyRecord` / `AdminSession` | All deleted |
| C2 | Surplus `export`s used only within their own file | Demoted to module-local functions (e.g. `timingSafeEqual`, `hashPassword`) |
| C3 | UI leftovers from the time-based-TTL / concurrency era (static copy, dead i18n keys, `concurrency` naming) | Cleaned and renamed (`mp.budget_*`; `mp.refresh_off` / `mp.st_fresh` / `mp.st_expired` deleted) |
| C4 | Duplicated implementations: `sessionIsUsable` x3, `isPlainObject` x3, prefix constants x3, prefix probing x2 | Extracted into shared modules (`session.ts` / `json.ts` / `upstream.ts`) |
| C5 | Stale comments (pointing at the deleted `reasoning.ts`, the KV layout list, ...) | All updated |

## 9. Verification

**Static checks and tests**

```powershell
cd worker
npm.cmd install --ignore-scripts --cache "$env:TEMP\dsh-npm-cache"   # npm.cmd is required in a sandbox
npm.cmd run typecheck        # tsc --noEmit, 0 errors (including the erasableSyntaxOnly guard)
npm.cmd test                 # node --test --test-isolation=none --test-concurrency=1
```

Current measured state: `typecheck` 0 errors; `npm test` **140/140 passing** (12 test files):

```text
ℹ tests 140
ℹ pass 140
ℹ fail 0
```

The suite runs with `--test-isolation=none --test-concurrency=1` (one process, files serial):
stub-fetch timing tests and the real-HTTP mock rehearsal share the process, so they must not
overlap; and every file that stubs `globalThis.fetch` restores the real fetch before each test
(see the `beforeEach` in each file).

Coverage (summary): the three real error wordings (including Qwen's missing `none`), the
two-layer "advertises 7, really accepts 4" verification, parameter attribution and the joint
`tools`/`tool_choice` drop, unattributable ⇒ `partial`, an empty `blamedSet` intersection ⇒
stop immediately, non-empty `remaining` ⇒ never report `ok`, unprobeable still yields
capabilities, budget truncation is not a failure, a 401 abort keeps established results,
network-failure backoff, the per-model wall clock, per-model persistence, the fingerprint being
byte-identical to Python's and excluding `created`, `max_model_len: 0` surviving, the shared
capability template intersection, the cache version gate, sharded SQL queries, subset alignment
not trimming other models, an id repeated only probed once, TTL cache hit/expiry/in-flight
sharing/failure-not-cached, the `/api/config` HTML trap and snapshot merging, the prefix
confirmation rule (500 / SPA 200+HTML do not confirm; 401/403 do), `canJoinRound`'s six
combinations, corrupt KV values degrading, setup 403 while `ADMIN_PASSWORD` is bound, and the
three outcomes of the connectivity test.

The contract test (`test/proxyContract.test.ts`, stub fetch + fake KV + fake DO) additionally
pins `/v1/models`' field set and envelope, the upstream template never leaking into
`capabilities`, the envelope disappearing entirely with `exposeInstanceMeta=false`, no probe
fields requested with `enabled=false`, the template being computed by the Worker and handed to
the coordinator in the same call, the Worker no longer fetching `/api/config` itself,
`/v1/models/{id}` supporting ids with slashes without waiting, the exact 404 structure for an
unknown id, the 400 self-heal calling `invalidate` through `ctx.waitUntil`, falling back to
`/api` when the preferred prefix answers 500 / 200+HTML, a structured 502 when no candidate can
be confirmed, a non-string/blank `model` rejected before forwarding, every upstream request
carrying a signal, forwarded requests omitting `accept-encoding`, and more.

**Locally reproducible runtime checks**

- Real SQLite statements: `SqliteProbeStore` was exercised end to end with Node 24's
  `node:sqlite` -- table creation, `ON CONFLICT ... DO UPDATE`, `IN (?, ...)` sharding (107 ids
  split into 2 statements), deletion, reopening the connection, and the version gate clearing.
- Configuration and bundling: `wrangler deploy --dry-run` passes, and
  `env.PROBE (ModelProbeCoordinator)` is recognised as a Durable Object binding.
- workerd end to end (`npm run mock` + `npm run dev`, mock upstream with 6 models):
  - probe convergence: `probe round finished` moves from `truncated:true` to `truncated:false`,
    the remaining models are probed by the **alarm continuing on its own**, with no further
    client requests;
  - the five hard assertions rehearse green against the mock (same assertions as
    `test/mockUpstream.test.ts`);
  - `/v1/models` fields and envelope, `/v1/models/{id}` 200, and the unknown-id 404 match the
    upstream structure;
  - **`instance:meta` no longer appears in KV** (measured: after a full probe round the KV key
    list only contains the session and API keys).

> The end-to-end above uses the local mock upstream, so it proves the **plumbing**; the real
> engine's numbers still need the checks below.

## 10. Open items (need a real deployment)

1. **The five hard assertions against the real upstream** (curl them after `wrangler deploy`,
   or use `wrangler dev` with a real session). They already rehearse green against the mock
   (real HTTP, real probe code), so deployment only has to confirm the real engine's numbers:
   - `Qwen3.8-27B` → `supported_efforts == [none, low, medium, xhigh]`, `default_effort == "xhigh"`
   - `gpt-oss-120b` → `[low, medium, high]`, `mandatory == true`
   - `DeepSeek-V4-Flash-0731` → `capabilities.vision == false`
   - `gemma-4-31B-it` / `GLM-OCR` → `capabilities.function_calling == false`
   - no model's `capabilities` ever contains `web_search` / `terminal` / `builtin_tools`
2. **Free-plan quota measurement**: one full probe round's DO subrequests / row writes / actual
   alarm CPU, and whether daily KV reads really shrink to "one per `/v1/models`". Thresholds to
   compare against: Workers requests 100,000/day, CPU 10ms/request, subrequests 50/invocation;
   KV reads 100,000/day, writes 1,000/day; DO has no daily request quota, 30s CPU per request,
   15 minutes of alarm wall time.
3. **First wake-up behaviour**: after deploying, request `/v1/models` once and then stop
   sending anything; the alarm should probe the remaining models (`probe round finished` in the
   logs).
4. **The two-request envelope semantics**: the first request should carry only
   `default_model_capabilities`, and `name` / `version` / `features` appear from the second
   request on -- the expected behaviour of the background `/api/config` refresh (`waitUntil`),
   not missing fields.
