/**
 * OpenAI-compatible proxy for /v1/*.
 * 
 * Ported behavior from the original FastAPI project:
 *   - upstream prefix probing (/api/v1 vs /api) with automatic 404 fallback
 *   - model list sanitized to the OpenAI shape, exposing only safe fields
 *     (private upstream fields like user_id are never exposed)
 *   - SSE streaming passthrough with hop-by-hop header stripping
 *   - OpenAI-style error bodies
 *   - upstream 401/403 -> clear "re-import session" error
 * 
 * Upstream: direct connection to {session.base_url}/{path}.
 * 
 * /v1/* 的 OpenAI 兼容代理。
 *
 * 从原 FastAPI 项目移植的行为：
 *   - 上游前缀探测（/api/v1 与 /api）并自动按 404 回退
 *   - 模型列表收敛为 OpenAI 结构并只透出安全字段
 *     （不透出 user_id 等上游私有字段）
 *   - SSE 流式直通并剔除逐跳（hop-by-hop）请求头
 *   - OpenAI 风格的错误体
 *   - 上游 401/403 → 明确提示重新导入 session 的错误
 *
 * 上游：直连 {session.base_url}/{path}。
 */

import type { Env, InstanceMeta, ModelProbeFields, ProbeSettings, StoredSession } from "./types.ts";
import { fetchUpstream, sessionHeaders, sessionIsUsable } from "./session.ts";
import { AUTH_FAILURE_CODES, PREFIX_CANDIDATES, confirmUpstreamPrefix } from "./upstream.ts";
import type { ConfirmedPrefix } from "./upstream.ts";
import { getSession } from "./kv.ts";
import { extractModelList, modelFingerprint, modelIdOf, normalizeModel, sharedDefaultCapabilities } from "./modelCatalog.ts";
import { instanceMetaToEnvelope, isInstanceMetaUsable } from "./instanceMeta.ts";
import { readProbeSettings } from "./probeSettings.ts";
import { looksLikeEffortError } from "./modelProbe.ts";
import type { ModelProbeCoordinator } from "./probeCoordinator.ts";
import { verifyClientApiKey } from "./auth.ts";

/**
 * Request headers that must not be forwarded upstream.
 *
 * `accept-encoding` is the Worker-side equivalent of the upstream project's
 * compression fix (it changed `aiter_raw` to `aiter_bytes` so an upstream-compressed
 * body is decoded before use): this proxy never asks for a compressed body and
 * `HOP_BY_HOP_RESPONSE` likewise drops `content-encoding`, so a body can always be
 * inspected as text -- and a streamed body is still passed through untouched.
 *
 * 不得转发给上游的请求头。
 *
 * `accept-encoding` 相当于上游项目压缩修复（把 `aiter_raw` 改为 `aiter_bytes`，以便
 * 上游压缩的响应体先被解码再使用）在本项目里的对应实现：本代理从不索取压缩响应体，
 * `HOP_BY_HOP_RESPONSE` 同样会剥掉 `content-encoding`，因此响应体总是能当文本检查——
 * 而流式响应体依然原样直通。
 */
const HOP_BY_HOP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
  "authorization",
]);

/** Response headers that must not be passed through to the client. */
/** 不得透传给客户端的响应头。 */
const HOP_BY_HOP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "date",
  "server",
]);

// --------------------------------------------------------------------------- //
// OpenAI-style errors
// OpenAI 风格错误
// --------------------------------------------------------------------------- //

interface ErrorOpts {
  type?: string;
  code?: string | null;
  param?: string | null;
}

// Build an OpenAI-style error response body with the given status.
// 用给定状态码构造 OpenAI 风格的错误响应体。
function openaiError(message: string, status = 400, opts: ErrorOpts = {}): Response {
  return Response.json(
    {
      error: {
        message,
        type: opts.type ?? "invalid_request_error",
        param: opts.param ?? null,
        code: opts.code ?? null,
      },
    },
    { status },
  );
}

// Uniform error for upstream credential failures (prompts re-import).
// 上游凭证失效的统一错误（提示重新导入 session）。
function authFailureResponse(status: number): Response {
  return openaiError(
    "Open WebUI rejected this request (credentials may have expired). Please re-import session.json from the admin console.",
    status,
    { code: "upstream_unauthorized" },
  );
}

// The handler's own configuration could not be read (a KV failure). That is not an
// upstream problem, so it answers its own code instead of `upstream_error` -- which
// would send the operator hunting for a fault on the Open WebUI side.
//
// 处理函数自己的配置读不出来（KV 故障）。这不是上游的问题，因此回它自己的错误码，
// 而不是 `upstream_error`——后者会让运维去 Open WebUI 那一侧找故障。
function settingsUnavailable(err: unknown): Response {
  return openaiError(`Probe settings unavailable: ${String(err)}`, 500, {
    type: "server_error",
    code: "settings_unavailable",
  });
}

// --------------------------------------------------------------------------- //
// Helpers
// 辅助函数
// --------------------------------------------------------------------------- //

// Model normalization, the shared capability template and the engine fingerprint live
// in modelCatalog.ts: the Durable Object needs exactly the same three when it probes
// on its own alarm, and duplicating them would let the two drift apart.
//
// 模型规范化、共享能力模板与引擎指纹都放在 modelCatalog.ts：Durable Object 按自身
// alarm 探测时需要的正是同样这三样，复制一份只会让两边逐渐不一致。

// Copy response headers while dropping hop-by-hop and identity headers.
// 复制响应头，同时剔除逐跳头与身份相关头。
function filterResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of src.entries()) {
    if (HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  return out;
}

/** Build the request headers for the upstream: client headers + session credentials. */
/** 构造上游请求头：客户端请求头 + 会话凭证。 */
function buildUpstreamHeaders(request: Request, session: StoredSession): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    // Drop hop-by-hop, CF-internal and client auth headers.
    // 剔除逐跳头、CF 内部头与客户端鉴权头。
    if (HOP_BY_HOP_REQUEST.has(lowerKey) || lowerKey.startsWith("cf-")) continue;
    headers.set(key, value);
  }
  // Session credentials override everything (the client can't set its own auth).
  // 会话凭证覆盖一切（客户端无法自带上游鉴权）。
  for (const [key, value] of Object.entries(sessionHeaders(session))) {
    headers.set(key, value);
  }
  return headers;
}

// --------------------------------------------------------------------------- //
// Prefix probing (cached per upstream base)
// 前缀探测（按上游 base 缓存）
// --------------------------------------------------------------------------- //

// Probe result cache: base_url -> chosen prefix, per isolate.
// 探测结果缓存：base_url -> 选定前缀，按 isolate 存放。
let cachedPrefixKey = "";
let cachedPrefix = PREFIX_CANDIDATES[0];

// Detect the working upstream API prefix by probing /models. A prefix is only
// accepted when the answer CONFIRMS it (a model list, or 401/403); a 404, a 5xx or the
// SPA's "200 + HTML" all move on to the next candidate. The body is read here anyway
// (the connection is drained either way) and reused for that decision, so confirming
// costs no extra request.
//
// 通过探测 /models 判定可用的上游 API 前缀。只有答案**确认**了该前缀才接受（可读的模型
// 列表，或 401/403）；404、5xx、以及 SPA 的 "200 + HTML" 都会继续试下一个候选。响应体
// 在这里本来就要读完（无论如何都要排空连接），正好用于这个判定，因此确认过程不多花请求。
async function detectPrefix(request: Request, session: StoredSession): Promise<string> {
  const base = session.base_url;
  if (cachedPrefixKey === base) return cachedPrefix;

  const headers = buildUpstreamHeaders(request, session);
  let confirmed: ConfirmedPrefix | null = null;
  let probingCompleted = true;
  try {
    confirmed = await confirmUpstreamPrefix(PREFIX_CANDIDATES, async (prefix) => {
      const resp = await fetchUpstream(`${base}${prefix}/models`, { method: "GET", headers }, { metadata: true });
      return {
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        text: await resp.text().catch(() => ""),
      };
    });
  } catch {
    // Unreachable or timed out: fail fast on THIS request (the other candidate shares
    // the same host and would fail identically) and let the actual request report the
    // real error. The fallback below is returned but NOT remembered in this case --
    // remembering it would freeze a legacy deployment onto the wrong prefix for the
    // isolate's whole lifetime after a single transient outage.
    //
    // 连不上或超时：本次请求快速失败（另一个候选共用同一主机，必然同样失败），让真正的
    // 那次请求去报告错误。这种情况下下面的兜底会返回但**不会**被记住——否则一次瞬时故障
    // 就会让旧版部署在整个 isolate 生命周期内都锁在错误的前缀上。
    probingCompleted = false;
  }
  if (confirmed) {
    cachedPrefix = confirmed.prefix;
    cachedPrefixKey = base;
    return confirmed.prefix;
  }
  if (probingCompleted) {
    // Every candidate answered and none could be confirmed: the deployment's routes are
    // not going to change between two requests, so the fallback IS remembered. This is
    // still not a success and must not be reported as one (the warn is its only trace).
    //
    // 所有候选都作答了、且一个都确认不了：部署的路由不会在两次请求之间改变，因此兜底
    // 值**会**被记住。这依然不是成功，也不得当成成功上报（warn 是它唯一的痕迹）。
    console.warn(
      JSON.stringify({
        message: "upstream prefix not confirmed",
        base_url: base,
        candidates: PREFIX_CANDIDATES,
      }),
    );
    cachedPrefix = PREFIX_CANDIDATES[0];
    cachedPrefixKey = base;
  }
  // Fall back to the first candidate so the caller gets a real error from the actual
  // request.
  //
  // 回退到第一个候选，让调用方从真正的那次请求拿到真实错误。
  return PREFIX_CANDIDATES[0];
}

// --------------------------------------------------------------------------- //
// Route handlers
// 路由处理函数
// --------------------------------------------------------------------------- //

// GET /v1/models — fetch and normalize the upstream model list.
// GET /v1/models —— 获取并规范化上游模型列表。
async function handleModels(
  request: Request,
  session: StoredSession,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const prefix = await detectPrefix(request, session);
  const base = session.base_url;
  const headers = buildUpstreamHeaders(request, session);

  let resp: Response;
  try {
    resp = await fetchUpstream(`${base}${prefix}/models`, { method: "GET", headers }, { metadata: true });
  } catch (err) {
    return openaiError(`Failed to connect to upstream: ${String(err)}`, 502, {
      type: "server_error",
      code: "upstream_unavailable",
    });
  }

  if (AUTH_FAILURE_CODES.includes(resp.status)) {
    await resp.text().catch(() => {});
    return authFailureResponse(resp.status);
  }
  if (resp.status !== 200) {
    const text = (await resp.text()).slice(0, 500);
    return openaiError(`Upstream /models returned HTTP ${resp.status}: ${text}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }

  const text = await resp.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return openaiError(`Upstream /models returned invalid JSON: ${text.slice(0, 500)}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }
  const rawModels = extractModelList(payload);
  const { models, refs } = await normalizeCatalog(rawModels);

  // Probe-derived fields and the instance envelope are best-effort: neither may ever
  // fail the model list. BOTH now arrive in ONE coordinator call -- the instance
  // snapshot lives beside the probe facts, so the Worker neither reads a second store
  // nor fetches /api/config itself.
  //
  // 探测字段与实例信封都是尽力而为的：两者都绝不能让模型列表请求失败。现在两者来自
  // **同一次**协调者调用——实例快照就存放在探测事实旁边，因此 Worker 既不用读第二个
  // 存储，也不用自己拉 /api/config。
  //
  // Reading the settings is NOT best-effort: it is this handler's own configuration,
  // and a failure here has nothing to do with the upstream, so it gets its own
  // structured error instead of being reported as one.
  //
  // 读取设置**不是**尽力而为的：它是本处理函数自己的配置，这里失败与上游毫无关系，
  // 因此给它自己的结构化错误，而不是报成上游错误。
  let settings: ProbeSettings;
  try {
    settings = await readProbeSettings(env);
  } catch (err) {
    return settingsUnavailable(err);
  }
  const wantsFields = settings.enabled;
  const wantsEnvelope = settings.exposeInstanceMeta;
  let instanceMeta: InstanceMeta | null = null;
  if (wantsFields || wantsEnvelope) {
    try {
      const presented = await probeCoordinatorFor(env, session).present(
        wantsFields ? refs : [],
        wantsFields ? settings.wait : 0,
        {
          wantInstanceMeta: wantsEnvelope,
          defaultModelCapabilities: sharedDefaultCapabilities(rawModels),
        },
      );
      if (wantsFields) {
        for (const model of models) {
          const id = typeof model.id === "string" ? model.id : "";
          const fields = presented.fields[id];
          if (fields) Object.assign(model, fields);
        }
      }
      instanceMeta = presented.instanceMeta;
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "probe fields unavailable",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const envelope: Record<string, unknown> = { object: "list", data: models };
  if (instanceMeta && isInstanceMetaUsable(instanceMeta)) {
    envelope.x_open_webui = instanceMetaToEnvelope(instanceMeta);
  }
  return Response.json(envelope);
}

/**
 * Normalize the upstream model list and compute the (id, engine fingerprint) pairs
 * the coordinator needs.
 *
 * Fingerprints are derived from the RAW upstream objects -- normalization drops
 * `info.updated_at` and `openai.root`, which are exactly what makes a fingerprint
 * move when the engine behind a model is swapped.
 *
 * 规范化上游模型列表，并算出协调者需要的 (模型 id, 引擎指纹) 对。
 *
 * 指纹由**原始**上游对象推导——规范化会丢掉 `info.updated_at` 与 `openai.root`，
 * 而这两个恰是"模型背后的引擎被换掉"时让指纹变化的字段。
 */
async function normalizeCatalog(
  rawModels: unknown[],
): Promise<{ models: Array<Record<string, unknown>>; refs: Array<[string, string]> }> {
  const shared = sharedDefaultCapabilities(rawModels);
  const models: Array<Record<string, unknown>> = [];
  const refs: Array<[string, string]> = [];
  for (const raw of rawModels) {
    const model = normalizeModel(raw, shared);
    if (!model) continue;
    models.push(model);
    const modelId = typeof model.id === "string" ? model.id : String(modelIdOf(raw) ?? "");
    refs.push([modelId, await modelFingerprint(raw, modelId)]);
  }
  return { models, refs };
}

/** The coordinator stub for this upstream. One instance per upstream base URL, so
 *  every location talks to the same coordinator. */
/** 该上游的协调者 stub。每个上游根地址一个实例，因此所有机房都对话同一个协调者。 */
function probeCoordinatorFor(env: Env, session: StoredSession): DurableObjectStub<ModelProbeCoordinator> {
  return env.PROBE.getByName(session.base_url);
}

/**
 * Fire-and-forget self-heal: drop the level the upstream just rejected and make the
 * model eligible for a re-probe.
 *
 * Never blocks and never throws -- the client's error is already on its way, and a
 * failing heal must not turn a clean 400 into a 500.
 *
 * 即发即忘的自愈：剔除上游刚刚拒绝的那个挡位，并让该模型可以被重探。
 *
 * 绝不阻塞、绝不抛出——客户端的错误已经在路上，自愈失败不能把一个干净的 400
 * 变成 500。
 */
function triggerProbeHeal(
  env: Env,
  ctx: ExecutionContext,
  session: StoredSession,
  modelId: unknown,
  effort: unknown,
): void {
  if (typeof modelId !== "string" || !modelId) return;
  const level = typeof effort === "string" && effort ? effort : null;
  const work = probeCoordinatorFor(env, session)
    .invalidate(modelId, level)
    .catch((err: unknown) => {
      console.error(
        JSON.stringify({
          message: "probe self-heal failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  ctx.waitUntil(work);
}

// GET /v1/models/{id} -- one normalized model, or an OpenAI-style 404.
// GET /v1/models/{id} —— 单个规范化模型，或 OpenAI 风格的 404。
async function handleRetrieveModel(
  request: Request,
  session: StoredSession,
  env: Env,
  modelId: string,
): Promise<Response> {
  const prefix = await detectPrefix(request, session);
  const headers = buildUpstreamHeaders(request, session);
  let resp: Response;
  try {
    resp = await fetchUpstream(`${session.base_url}${prefix}/models`, { method: "GET", headers }, { metadata: true });
  } catch (err) {
    return openaiError(`Failed to connect to upstream: ${String(err)}`, 502, {
      type: "server_error",
      code: "upstream_unavailable",
    });
  }
  if (AUTH_FAILURE_CODES.includes(resp.status)) {
    await resp.text().catch(() => {});
    return authFailureResponse(resp.status);
  }
  if (resp.status !== 200) {
    const text = (await resp.text()).slice(0, 500);
    return openaiError(`Upstream /models returned HTTP ${resp.status}: ${text}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }

  const text = await resp.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return openaiError(`Upstream /models returned invalid JSON: ${text.slice(0, 500)}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }

  const rawModels = extractModelList(payload);
  const { models, refs } = await normalizeCatalog(rawModels);
  const model = models.find((candidate) => candidate.id === modelId);

  // Deliberately no envelope and no background refresh here: the upstream project
  // does the same, so a single-model read never changes what is being probed.
  //
  // 这里刻意不带信封、也不触发后台刷新：上游项目同样如此，因此单模型读取不会改变
  // 正在探测的内容。
  if (!model) return modelNotFound(modelId);

  let settings: ProbeSettings;
  try {
    settings = await readProbeSettings(env);
  } catch (err) {
    return settingsUnavailable(err);
  }
  if (settings.enabled) {
    try {
      const presented = await probeCoordinatorFor(env, session).present(
        refs.filter(([id]) => id === modelId),
        0,
        { wantInstanceMeta: false },
      );
      const fields: ModelProbeFields | undefined = presented.fields[modelId];
      if (fields) Object.assign(model, fields);
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "probe fields unavailable",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return Response.json(model);
}

/** The OpenAI "model not found" body, worded exactly like the upstream project. */
/** OpenAI 的 "model not found" 错误体，措辞与上游项目完全一致。 */
function modelNotFound(modelId: string): Response {
  return openaiError(`The model '${modelId}' does not exist`, 404, {
    code: "model_not_found",
    param: "model",
  });
}

// POST /v1/chat/completions — validate the payload, then forward (SSE-aware).
// POST /v1/chat/completions —— 校验负载后转发（支持 SSE 流式）。
async function handleChat(
  request: Request,
  session: StoredSession,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return openaiError("Request body is not valid JSON.", 400, { code: "invalid_json" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return openaiError("Request body must be a JSON object.", 400, { code: "invalid_json" });
  }
  // `model` must be a non-empty STRING: `0` / `false` / `[]` / `{}` and a blank
  // string are all truthy or falsy in ways that let them slip through a plain falsy
  // check, and forwarding them upstream hands the client "an upstream error" instead
  // of "your request is invalid".
  //
  // `model` 必须是去空白后非空的**字符串**：`0` / `false` / `[]` / `{}` 与纯空白串用
  // 简单的真假判断都拦不住，原样转发给上游只会让客户端拿到"上游错误"，而不是"你的请求
  // 不合法"。
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    return openaiError("`model` must be a non-empty string.", 400, {
      code: "invalid_type",
      param: "model",
    });
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return openaiError("messages must be a non-empty array.", 400, { code: "missing_required_field", param: "messages" });
  }

  const isStream = Boolean(payload.stream);
  const prefix = await detectPrefix(request, session);
  const base = session.base_url;
  const headers = buildUpstreamHeaders(request, session);

  let resp: Response;
  try {
    // Streaming only bounds the wait for the headers; the SSE body itself must not be
    // cut off (see `fetchUpstream`).
    //
    // 流式只限制等待响应头的时间；SSE 响应体本身绝不能被打断（见 `fetchUpstream`）。
    resp = await fetchUpstream(`${base}${prefix}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, { stream: isStream });
  } catch (err) {
    return openaiError(`Failed to connect to upstream: ${String(err)}`, 502, {
      type: "server_error",
      code: "upstream_unavailable",
    });
  }

  if (AUTH_FAILURE_CODES.includes(resp.status)) {
    await resp.text().catch(() => {});
    return authFailureResponse(resp.status);
  }
  if (resp.status >= 400) {
    const text = (await resp.text()).slice(0, 2000);
    // Self-heal: a 400/422 that names the reasoning effort disproves the level the
    // client just used, so the cache drops it and the model is re-probed. The
    // upstream's own error is what the client receives either way -- the heal never
    // delays or rewrites it.
    //
    // 自愈：点名思考挡位的 400/422 证伪了客户端刚用的那个挡位，因此缓存剔除它并重探
    // 该模型。无论是否自愈，客户端收到的都是上游原本的错误——自愈既不延迟也不改写它。
    if ((resp.status === 400 || resp.status === 422) && looksLikeEffortError(text)) {
      triggerProbeHeal(env, ctx, session, payload.model, payload.reasoning_effort);
    }
    // 4xx maps back to the client, 5xx is masked as 502 upstream_error.
    // 4xx 原样映射回客户端，5xx 统一掩蔽为 502 upstream_error。
    return openaiError(
      `Upstream returned HTTP ${resp.status}: ${text}`,
      resp.status < 500 ? resp.status : 502,
      {
        type: resp.status < 500 ? "invalid_request_error" : "server_error",
        code: "upstream_error",
      },
    );
  }

  if (!isStream) {
    // Non-streaming: validate upstream JSON, then return it as-is.
    // 非流式：校验上游 JSON 后原样返回。
    const text = await resp.text();
    try {
      JSON.parse(text);
      return new Response(text, {
        status: resp.status,
        headers: { "content-type": "application/json" },
      });
    } catch {
      return openaiError(`Upstream returned invalid JSON: ${text.slice(0, 500)}`, 502, {
        type: "server_error",
        code: "upstream_error",
      });
    }
  }

  // Streaming: pass the upstream body through untouched.
  // 流式：上游响应体原样直通，不做任何改动。
  const headersOut = filterResponseHeaders(resp.headers);
  headersOut.set("content-type", resp.headers.get("content-type") || "text/event-stream");
  headersOut.set("cache-control", "no-cache");
  headersOut.set("x-accel-buffering", "no");
  return new Response(resp.body, { status: resp.status, headers: headersOut });
}

// POST /v1/embeddings — forward the embedding request to the upstream.
// POST /v1/embeddings —— 将向量嵌入请求转发给上游。
async function handleEmbeddings(request: Request, session: StoredSession): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return openaiError("Request body is not valid JSON.", 400, { code: "invalid_json" });
  }
  // Same `model` rule as chat/completions, plus the required `input` field. The two
  // are reported separately so the client is told which one is wrong.
  //
  // 与 chat/completions 相同的 `model` 规则，另加必填的 `input` 字段。两者分开报，
  // 客户端才知道到底哪个字段不合法。
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    return openaiError("`model` must be a non-empty string.", 400, {
      code: "invalid_type",
      param: "model",
    });
  }
  if (!("input" in payload)) {
    return openaiError("Missing required field: input.", 400, {
      code: "missing_required_field",
      param: "input",
    });
  }

  const prefix = await detectPrefix(request, session);
  const base = session.base_url;
  const headers = buildUpstreamHeaders(request, session);

  let resp: Response;
  try {
    resp = await fetchUpstream(`${base}${prefix}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return openaiError(`Failed to connect to upstream: ${String(err)}`, 502, {
      type: "server_error",
      code: "upstream_unavailable",
    });
  }

  if (AUTH_FAILURE_CODES.includes(resp.status)) {
    await resp.text().catch(() => {});
    return authFailureResponse(resp.status);
  }
  if (resp.status >= 400) {
    const text = (await resp.text()).slice(0, 2000);
    return openaiError(
      `Upstream returned HTTP ${resp.status}: ${text}`,
      resp.status < 500 ? resp.status : 502,
      {
        type: resp.status < 500 ? "invalid_request_error" : "server_error",
        code: "upstream_error",
      },
    );
  }
  return new Response(resp.body, { status: resp.status, headers: filterResponseHeaders(resp.headers) });
}

// ANY /v1/{path} — catch-all passthrough for every other upstream route.
// ANY /v1/{path} —— 其余上游路由的兜底透传。
async function handlePassthrough(request: Request, session: StoredSession): Promise<Response> {
  const url = new URL(request.url);
  const subpath = url.pathname.slice("/v1".length);
  if (!subpath.replace(/^\//, "")) {
    return openaiError("Please specify the upstream path to forward in the URL.", 404, { code: "not_found" });
  }

  const prefix = await detectPrefix(request, session);
  const base = session.base_url;
  const target = `${base}${prefix}${subpath}${url.search}`;
  const headers = buildUpstreamHeaders(request, session);
  const body = await request.text();

  let resp: Response;
  try {
    // The caller may have asked for a stream (the passthrough is route-agnostic), so
    // only the wait for the response headers is bounded here as well.
    //
    // 调用方可能请求了流式（本透传不区分路由），因此这里同样只限制等待响应头的时间。
    resp = await fetchUpstream(target, {
      method: request.method,
      headers,
      body: body || undefined,
    }, { stream: true });
  } catch (err) {
    return openaiError(`Failed to connect to upstream: ${String(err)}`, 502, {
      type: "server_error",
      code: "upstream_unavailable",
    });
  }

  if (AUTH_FAILURE_CODES.includes(resp.status)) {
    await resp.text().catch(() => {});
    return authFailureResponse(resp.status);
  }
  return new Response(resp.body, { status: resp.status, headers: filterResponseHeaders(resp.headers) });
}

// --------------------------------------------------------------------------- //
// Entry point
// 入口
// --------------------------------------------------------------------------- //

// Handle any /v1/* request: verify the client key, load the session, dispatch.
// 处理所有 /v1/* 请求：校验客户端 Key，加载 session，然后分发。
export async function handleV1Request(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const subpath = url.pathname.slice("/v1".length) || "/";

  // Credential verification and session loading run INSIDE the try: a KV read that
  // throws used to bubble up to the Worker entry point, which answers a plain 500
  // body that an OpenAI client cannot parse. Failure codes below are deliberately
  // distinct from the upstream ones -- the upstream was never reached.
  //
  // 凭证校验与 session 加载放在 try **内部**：一次抛错的 KV 读取此前会冒泡到 Worker
  // 入口，返回 OpenAI 客户端无法解析的普通 500 响应体。下面的错误码刻意与上游错误区分：
  // 这些情况下根本没碰到上游。
  try {
    const authorized = await verifyClientApiKey(env, request, ctx);
    if (!authorized) {
      return openaiError("Invalid proxy API key.", 401, { code: "invalid_api_key" });
    }

    const session = await getSession(env);
    if (!session) {
      return openaiError("No session credentials imported. Please import session.json in the admin console first.", 503, {
        type: "server_error",
        code: "session_missing",
      });
    }
    if (!sessionIsUsable(session)) {
      return openaiError("Session credentials are unusable (missing Authorization / Cookie). Please re-import.", 500, {
        type: "server_error",
        code: "session_invalid",
      });
    }

    if (subpath === "/models" || subpath === "/models/") {
      return await handleModels(request, session, env, ctx);
    }
    // Registered BEFORE the catch-all passthrough (and before `/models` can swallow
    // it): an unknown id must answer a JSON 404 here, because the upstream answers
    // an unknown path with 200 and a page of HTML.
    //
    // 必须注册在兜底透传之前：未知 id 要在这里返回 JSON 404，因为上游对未知路径会
    // 回 200 加一页 HTML。
    if (subpath.startsWith("/models/")) {
      const modelId = decodeURIComponent(subpath.slice("/models/".length));
      return await handleRetrieveModel(request, session, env, modelId);
    }
    if (subpath === "/chat/completions" || subpath === "/chat/completions/") {
      return await handleChat(request, session, env, ctx);
    }
    if (subpath === "/embeddings" || subpath === "/embeddings/") {
      return await handleEmbeddings(request, session);
    }
    return await handlePassthrough(request, session);
  } catch (err) {
    // Safety net for the plumbing (KV, RPC, an unexpected throw). Upstream failures
    // are handled -- and coded -- by the individual handlers, so this one says
    // "internal" rather than blaming Open WebUI.
    //
    // 兜底处理管线自身的失败（KV、RPC、未预期的抛出）。上游失败由各处理函数自行处理并
    // 给出错误码，因此这一条说的是 "internal"，而不是甩锅给 Open WebUI。
    return openaiError(`Proxy request failed: ${String(err)}`, 500, {
      type: "server_error",
      code: "internal",
    });
  }
}
