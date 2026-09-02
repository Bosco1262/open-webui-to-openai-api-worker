/**
 * OpenAI-compatible proxy for /v1/*.
 * 
 * Ported behavior from the original FastAPI project:
 *   - upstream prefix probing (/api/v1 vs /api) with automatic 404 fallback
 *   - model list normalization to {id, object, created, owned_by}
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
 *   - 模型列表规范化为 {id, object, created, owned_by}
 *   - SSE 流式直通并剔除逐跳（hop-by-hop）请求头
 *   - OpenAI 风格的错误体
 *   - 上游 401/403 → 明确提示重新导入 session 的错误
 *
 * 上游：直连 {session.base_url}/{path}。
 */

import type { Env, StoredSession } from "./types";
import { sessionHeaders } from "./session";
import { getSession } from "./kv";
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

/** Normalize an upstream model object into the OpenAI model structure. */
/** 将上游模型对象规范化为 OpenAI 模型结构。 */
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

  let created = obj.created ?? obj.created_at;
  if (typeof created === "string") created = Number(created);
  if (typeof created !== "number" || Number.isNaN(created)) created = 0;

  return {
    id: String(modelId),
    object: "model",
    created,
    owned_by: String(obj.owned_by ?? obj.user_id ?? "openai"),
  };
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
async function handleModels(request: Request, session: StoredSession): Promise<Response> {
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
  return Response.json({ object: "list", data: models });
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
      return await handleModels(request, session);
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
