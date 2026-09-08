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

import type { Env, StoredSession } from "./types";
import { sessionHeaders } from "./session";
import { getSession } from "./kv";
import {
  buildReasoningInfo,
  getReasoningCache,
  getReasoningSettings,
  refreshReasoningCache,
} from "./reasoning";
import { verifyClientApiKey } from "./auth";

/** Upstream prefixes in probe priority order (Open WebUI >= 0.6 vs legacy). */
/** 上游前缀探测优先级顺序（Open WebUI >= 0.6 与旧版本）。 */
const PREFIX_CANDIDATES = ["/api/v1", "/api"];

/** Upstream returning these means the credentials are dead. */
/** 上游返回这些状态码说明凭证已失效。 */
const AUTH_FAILURE_CODES = [401, 403];

/** Request headers that must not be forwarded upstream. */
/** 不得转发给上游的请求头。 */
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
export function openaiError(message: string, status = 400, opts: ErrorOpts = {}): Response {
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

// --------------------------------------------------------------------------- //
// Helpers
// 辅助函数
// --------------------------------------------------------------------------- //

// A session is usable if it carries a non-empty Authorization or Cookie.
// session 携带非空 Authorization 或 Cookie 即视为可用。
function sessionIsUsable(session: StoredSession): boolean {
  return Boolean(
    (session.authorization && session.authorization.trim()) ||
      (session.cookie && session.cookie.trim()),
  );
}

// Quantization tokens recognizable in model ids: NVFP4, FP8, FP16, INT8, GPTQ, AWQ, ...
// 模型名中可识别的量化标识：NVFP4、FP8、FP16、INT8、GPTQ、AWQ 等
const QUANT_PATTERN =
  /\b(NVFP4|FP4|FP8|FP16|INT8|INT4|GPTQ(?:-?[0-9]+BIT)?|AWQ|GGUF|Q[0-9](?:_[A-Z0-9]+)*)\b/i;

/** Collapse an upstream model object into the OpenAI model structure.
 *
 * Standard fields stay intact; a whitelist of safe, useful extras aligned
 * with the generic /v1/models template is preserved when present:
 * max_model_len (kept for compatibility) plus max_context_length and
 * context_length, quantization (parsed from the model id), capabilities
 * (with a derived function_calling flag) and description. Private upstream
 * fields (user_id, access_grants, permission, urlIdx, ...) are never exposed.
 *
 * 把上游的模型对象收敛成 OpenAI 的 model 结构。
 *
 * 标准字段原样保留，另有一份白名单按通用 /v1/models 模板透出安全且
 * 有用的扩展字段：max_model_len（兼容保留）+ max_context_length/
 * context_length、quantization（从模型名解析）、capabilities（含派生的
 * function_calling）与 description；上游私有字段（user_id、access_grants、
 * permission、urlIdx 等）一律不透出。
 */
function normalizeModel(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    return { id: raw, object: "model", created: 0, owned_by: "openai" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // Accept the various id-like fields used by different Open WebUI versions.
  // 兼容不同 Open WebUI 版本使用的各类 id 字段。
  const modelId = obj.id ?? obj.name ?? obj.model;
  if (!modelId) return null;

  const info = isPlainObject(obj.info) ? obj.info : {};
  const meta = isPlainObject(info.meta) ? info.meta : {};
  const openaiObj = isPlainObject(obj.openai) ? obj.openai : {};

  // info.created_at is the model's real creation time; the "created" on the
  // OpenAI layer is the serving engine's start time, not the model's.
  //
  // info.created_at 才是模型真实创建时间；OpenAI 层的 created 是推理引擎
  // 的启动时间，并非模型本身的。
  let created: unknown = info.created_at;
  if (created === null || created === undefined) created = obj.created;
  if (created === null || created === undefined) created = obj.created_at;
  if (typeof created === "string") created = Number(created);
  if (typeof created !== "number" || Number.isNaN(created)) created = 0;

  // Prefer the inner engine attribution (e.g. "vllm") over the OpenAI-layer default.
  // 优先取内层引擎归属（如 "vllm"），而非 OpenAI 层的默认值。
  const ownedBy = openaiObj.owned_by ?? obj.owned_by ?? "openai";

  const model: Record<string, unknown> = {
    id: String(modelId),
    object: "model",
    created,
    owned_by: String(ownedBy),
  };

  // Allowlisted extras: only emitted when the upstream provides them, so
  // minimal/legacy model objects keep the exact 4-field OpenAI shape.
  //
  // 白名单扩展字段：上游提供时才输出，极简/老版本模型对象仍保持
  // 精确的 4 字段 OpenAI 结构。
  const maxModelLen = obj.max_model_len || openaiObj.max_model_len;
  if (typeof maxModelLen === "number" && Number.isFinite(maxModelLen)) {
    const contextLength = Math.trunc(maxModelLen);
    // Generic-template field names; max_model_len stays as a compatibility alias
    // 通用模板字段名；max_model_len 作为兼容别名保留
    model.max_model_len = contextLength;
    model.max_context_length = contextLength;
    model.context_length = contextLength;
  }

  // Quantization is not a dedicated upstream field; parse it from the model id
  // (e.g. "GLM-5.2-NVFP4" -> "NVFP4"). Omitted when nothing matches.
  //
  // 量化信息不是上游的独立字段，从模型名解析（如 "GLM-5.2-NVFP4" ->
  // "NVFP4"）。匹配不到时不输出该字段。
  const quantMatch = QUANT_PATTERN.exec(String(modelId));
  if (quantMatch) {
    model.quantization = quantMatch[1].toUpperCase();
  }

  const description = meta.description;
  if (typeof description === "string" && description) {
    model.description = description;
  }

  const capabilities = meta.capabilities;
  if (isPlainObject(capabilities)) {
    const caps: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(capabilities)) {
      if (typeof value === "boolean") caps[key] = value;
    }
    if (Object.keys(caps).length > 0) {
      // Derived flag: builtin_tools maps onto the template's function_calling
      // 派生字段：builtin_tools 对应通用模板的 function_calling
      caps.function_calling = Boolean(caps.builtin_tools ?? false);
      model.capabilities = caps;
    }
  }

  return model;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract the model array from inconsistent upstream payload shapes. */
/** 从不一致的上游负载结构中提取模型数组。 */
function extractModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["data", "items", "models"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

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
    const lk = key.toLowerCase();
    // Drop hop-by-hop, CF-internal and client auth headers.
    // 剔除逐跳头、CF 内部头与客户端鉴权头。
    if (HOP_BY_HOP_REQUEST.has(lk) || lk.startsWith("cf-")) continue;
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

// Detect the working upstream API prefix by probing /models; 404 tries the next.
// 通过探测 /models 判定可用的上游 API 前缀；404 则尝试下一个。
async function detectPrefix(request: Request, session: StoredSession): Promise<string> {
  const base = session.base_url;
  if (cachedPrefixKey === base) return cachedPrefix;

  for (const prefix of PREFIX_CANDIDATES) {
    const resp = await fetch(`${base}${prefix}/models`, {
      method: "GET",
      headers: buildUpstreamHeaders(request, session),
    });
    await resp.text().catch(() => {});
    if (resp.status === 404) continue; // route does not exist, try the next prefix / 路由不存在，尝试下一个前缀
    cachedPrefix = prefix;
    cachedPrefixKey = base;
    return prefix;
  }
  // All candidates 404: fall back to the first so the caller gets a real error.
  // 所有候选前缀均 404：回退到第一个，让调用方拿到真实错误。
  cachedPrefix = PREFIX_CANDIDATES[0];
  cachedPrefixKey = base;
  return cachedPrefix;
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
    resp = await fetch(`${base}${prefix}/models`, { method: "GET", headers });
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
  const models = extractModelList(payload)
    .map(normalizeModel)
    .filter((m): m is Record<string, unknown> => m !== null);

  // Reasoning-effort info is best-effort: it must never fail the models list.
  // 思考挡位信息是尽力而为的：绝不能让模型列表请求失败。
  try {
    await attachReasoningInfo(env, ctx, models);
  } catch (err) {
    console.error(
      JSON.stringify({ message: "reasoning attach failed", error: err instanceof Error ? err.message : String(err) }),
    );
  }
  return Response.json({ object: "list", data: models });
}

// Attach cached reasoning-effort info to each model. When models lack cache
// coverage (fresh upstream additions, or entries older than the auto-refresh
// granularity) a background refresh fills the cache for the next request;
// the current response optionally waits `wait` seconds for it to land first.
//
// 为每个模型附加缓存中的思考挡位信息。缓存未覆盖的模型（上游新增，或条目
// 超过自动刷新粒度）由后台刷新补齐缓存供下次请求使用；当前响应可先等待
// `wait` 秒让刷新落地。
//
// Mirrors the upstream app.py /v1/models logic (missing -> bounded wait ->
// merge again).
// 与上游 app.py 的 /v1/models 逻辑一致（缺失 -> 有限等待 -> 再合并一轮）。
async function attachReasoningInfo(
  env: Env,
  ctx: ExecutionContext,
  models: Array<Record<string, unknown>>,
): Promise<void> {
  const settings = await getReasoningSettings(env);
  if (!settings.enabled) return;

  let cache = await getReasoningCache(env);
  const ttl = settings.refreshInterval;
  const now = Date.now() / 1000;

  // Covered = probed and still within the auto-refresh granularity.
  // refreshInterval=0 keeps serving whatever the cache holds (auto-refresh
  // off, manual refresh only).
  //
  // 已覆盖 = 已探测且仍在自动刷新粒度内。refreshInterval=0 时缓存里有什么
  // 就继续返回什么（自动刷新关闭，仅手动刷新）。
  const isCovered = (id: string): boolean => {
    const entry = cache.models[id];
    return Boolean(entry && (ttl <= 0 || entry.probed_at + ttl > now));
  };
  const attach = (): void => {
    for (const model of models) {
      if (typeof model.id !== "string" || model.reasoning !== undefined) continue;
      if (!isCovered(model.id)) continue;
      const info = buildReasoningInfo(cache.models[model.id].supported_efforts);
      if (info) model.reasoning = info;
    }
  };

  attach();
  if (models.every((m) => typeof m.id !== "string" || isCovered(m.id))) return;

  // Lazy refresh: deduped in-flight by base_url inside refreshReasoningCache.
  // waitUntil keeps the round running even after this response returns.
  //
  // 惰性刷新：refreshReasoningCache 内部按 base_url 去重进行中的刷新。
  // waitUntil 让本轮刷新在响应返回后仍能继续完成。
  const refresh = refreshReasoningCache(env, { force: false });
  ctx.waitUntil(refresh.catch(() => {}));

  if (settings.wait > 0) {
    // Bounded wait, then merge again: models probed during the wait are now
    // covered (putReasoningCache refreshes the instance cache, so the re-read
    // below sees fresh data).
    //
    // 有限等待后合并一轮：等待期间探测完成的模型现在已有缓存
    // （putReasoningCache 会同步实例缓存，下方重读即可拿到新数据）。
    await Promise.race([
      refresh.catch(() => null),
      new Promise((resolve) => setTimeout(resolve, settings.wait * 1000)),
    ]);
    cache = await getReasoningCache(env);
    attach();
  }
}

// POST /v1/chat/completions — validate the payload, then forward (SSE-aware).
// POST /v1/chat/completions —— 校验负载后转发（支持 SSE 流式）。
async function handleChat(request: Request, session: StoredSession): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return openaiError("Request body is not valid JSON.", 400, { code: "invalid_json" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return openaiError("Request body must be a JSON object.", 400, { code: "invalid_json" });
  }
  if (!payload.model) {
    return openaiError("Missing required field: model.", 400, { code: "missing_required_field", param: "model" });
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
    resp = await fetch(`${base}${prefix}/chat/completions`, {
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
  if (!payload.model || !("input" in payload)) {
    return openaiError("Missing required field: model / input.", 400, { code: "missing_required_field" });
  }

  const prefix = await detectPrefix(request, session);
  const base = session.base_url;
  const headers = buildUpstreamHeaders(request, session);

  let resp: Response;
  try {
    resp = await fetch(`${base}${prefix}/embeddings`, {
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
    resp = await fetch(target, {
      method: request.method,
      headers,
      body: body || undefined,
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

  const url = new URL(request.url);
  const subpath = url.pathname.slice("/v1".length) || "/";

  try {
    if (subpath === "/models" || subpath === "/models/") {
      return await handleModels(request, session, env, ctx);
    }
    if (subpath === "/chat/completions" || subpath === "/chat/completions/") {
      return await handleChat(request, session);
    }
    if (subpath === "/embeddings" || subpath === "/embeddings/") {
      return await handleEmbeddings(request, session);
    }
    return await handlePassthrough(request, session);
  } catch (err) {
    return openaiError(`Proxy request failed: ${String(err)}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }
}
