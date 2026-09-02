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
 * Two upstream modes:
 *   - AI Gateway mode:   https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-{slug}/{path}
 *   - Direct mode:       {session.base_url}/{path}
 */

import type { CloudflareConfig, Env, StoredSession } from "./types";
import { buildGatewayUrl, gatewayAuthHeader, sessionHeaders } from "./ai-gateway";
import { getCloudflareConfig, getSession } from "./kv";
import { verifyClientApiKey } from "./auth";

/** Upstream prefixes in probe priority order (Open WebUI >= 0.6 vs legacy). */
const PREFIX_CANDIDATES = ["/api/v1", "/api"];

/** Upstream returning these means the credentials are dead. */
const AUTH_FAILURE_CODES = [401, 403];

/** Request headers that must not be forwarded upstream. */
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
// --------------------------------------------------------------------------- //

interface ErrorOpts {
  type?: string;
  code?: string | null;
  param?: string | null;
}

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

function authFailureResponse(status: number): Response {
  return openaiError(
    "Open WebUI 拒绝了本次请求（凭证可能已过期）。请到管理界面重新导入 session.json。",
    status,
    { code: "upstream_unauthorized" },
  );
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function sessionIsUsable(session: StoredSession): boolean {
  return Boolean(
    (session.authorization && session.authorization.trim()) ||
      (session.cookie && session.cookie.trim()),
  );
}

/** Normalize an upstream model object into the OpenAI model structure. */
function normalizeModel(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    return { id: raw, object: "model", created: 0, owned_by: "openai" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
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

function filterResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of src.entries()) {
    if (HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  return out;
}

/** Build the request headers for the upstream: client headers + session credentials. */
function buildUpstreamHeaders(
  request: Request,
  session: StoredSession,
  config: CloudflareConfig | null,
  usingGateway: boolean,
): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_REQUEST.has(lk) || lk.startsWith("cf-")) continue;
    headers.set(key, value);
  }
  // Session credentials override everything (the client can't set its own auth).
  for (const [key, value] of Object.entries(sessionHeaders(session))) {
    headers.set(key, value);
  }
  if (usingGateway && config) {
    for (const [key, value] of Object.entries(gatewayAuthHeader(config))) {
      headers.set(key, value);
    }
  }
  return headers;
}

function getUpstreamBase(
  config: CloudflareConfig | null,
  session: StoredSession,
  usingGateway: boolean,
): string {
  if (usingGateway && config) return buildGatewayUrl(config);
  return session.base_url;
}

// --------------------------------------------------------------------------- //
// Prefix probing (cached per upstream base)
// --------------------------------------------------------------------------- //

let cachedPrefixKey = "";
let cachedPrefix = PREFIX_CANDIDATES[0];

async function detectPrefix(
  request: Request,
  session: StoredSession,
  config: CloudflareConfig | null,
  usingGateway: boolean,
): Promise<string> {
  const base = getUpstreamBase(config, session, usingGateway);
  const cacheKey = `${usingGateway ? "gw:" : "direct:"}${base}`;
  if (cachedPrefixKey === cacheKey) return cachedPrefix;

  for (const prefix of PREFIX_CANDIDATES) {
    const resp = await fetch(`${base}${prefix}/models`, {
      method: "GET",
      headers: buildUpstreamHeaders(request, session, config, usingGateway),
    });
    await resp.text().catch(() => {});
    if (resp.status === 404) continue; // route does not exist, try the next prefix
    cachedPrefix = prefix;
    cachedPrefixKey = cacheKey;
    return prefix;
  }
  // All candidates 404: fall back to the first so the caller gets a real error.
  cachedPrefix = PREFIX_CANDIDATES[0];
  cachedPrefixKey = cacheKey;
  return cachedPrefix;
}

// --------------------------------------------------------------------------- //
// Route handlers
// --------------------------------------------------------------------------- //

async function handleModels(
  request: Request,
  session: StoredSession,
  config: CloudflareConfig | null,
  usingGateway: boolean,
): Promise<Response> {
  const prefix = await detectPrefix(request, session, config, usingGateway);
  const base = getUpstreamBase(config, session, usingGateway);
  const headers = buildUpstreamHeaders(request, session, config, usingGateway);
  if (usingGateway && config && (config.cache_ttl ?? 0) > 0) {
    headers.set("cf-aig-cache-ttl", String(config.cache_ttl));
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}${prefix}/models`, { method: "GET", headers });
  } catch (err) {
    return openaiError(`无法连接上游：${String(err)}`, 502, {
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
    return openaiError(`上游 /models 返回 HTTP ${resp.status}：${text}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }

  const text = await resp.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return openaiError(`上游 /models 返回的不是合法 JSON：${text.slice(0, 500)}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }
  const models = extractModelList(payload)
    .map(normalizeModel)
    .filter((m): m is Record<string, unknown> => m !== null);
  return Response.json({ object: "list", data: models });
}

async function handleChat(
  request: Request,
  session: StoredSession,
  config: CloudflareConfig | null,
  usingGateway: boolean,
): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return openaiError("请求体不是合法 JSON。", 400, { code: "invalid_json" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return openaiError("请求体必须是 JSON 对象。", 400, { code: "invalid_json" });
  }
  if (!payload.model) {
    return openaiError("缺少必填字段：model。", 400, { code: "missing_required_field", param: "model" });
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return openaiError("messages 必须是非空数组。", 400, { code: "missing_required_field", param: "messages" });
  }

  const isStream = Boolean(payload.stream);
  const prefix = await detectPrefix(request, session, config, usingGateway);
  const base = getUpstreamBase(config, session, usingGateway);
  const headers = buildUpstreamHeaders(request, session, config, usingGateway);
  if (usingGateway && config && (config.cache_ttl ?? 0) > 0 && !isStream) {
    headers.set("cf-aig-cache-ttl", String(config.cache_ttl));
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}${prefix}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return openaiError(`无法连接上游：${String(err)}`, 502, {
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
      `上游返回 HTTP ${resp.status}：${text}`,
      resp.status < 500 ? resp.status : 502,
      {
        type: resp.status < 500 ? "invalid_request_error" : "server_error",
        code: "upstream_error",
      },
    );
  }

  if (!isStream) {
    const text = await resp.text();
    try {
      JSON.parse(text);
      return new Response(text, {
        status: resp.status,
        headers: { "content-type": "application/json" },
      });
    } catch {
      return openaiError(`上游返回的不是合法 JSON：${text.slice(0, 500)}`, 502, {
        type: "server_error",
        code: "upstream_error",
      });
    }
  }

  // Streaming: pass the upstream body through untouched.
  const headersOut = filterResponseHeaders(resp.headers);
  headersOut.set("content-type", resp.headers.get("content-type") || "text/event-stream");
  headersOut.set("cache-control", "no-cache");
  headersOut.set("x-accel-buffering", "no");
  return new Response(resp.body, { status: resp.status, headers: headersOut });
}

async function handleEmbeddings(
  request: Request,
  session: StoredSession,
  config: CloudflareConfig | null,
  usingGateway: boolean,
): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return openaiError("请求体不是合法 JSON。", 400, { code: "invalid_json" });
  }
  if (!payload.model || !("input" in payload)) {
    return openaiError("缺少必填字段：model / input。", 400, { code: "missing_required_field" });
  }

  const prefix = await detectPrefix(request, session, config, usingGateway);
  const base = getUpstreamBase(config, session, usingGateway);
  const headers = buildUpstreamHeaders(request, session, config, usingGateway);
  if (usingGateway && config && (config.cache_ttl ?? 0) > 0) {
    headers.set("cf-aig-cache-ttl", String(config.cache_ttl));
  }

  let resp: Response;
  try {
    resp = await fetch(`${base}${prefix}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return openaiError(`无法连接上游：${String(err)}`, 502, {
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
      `上游返回 HTTP ${resp.status}：${text}`,
      resp.status < 500 ? resp.status : 502,
      {
        type: resp.status < 500 ? "invalid_request_error" : "server_error",
        code: "upstream_error",
      },
    );
  }
  return new Response(resp.body, { status: resp.status, headers: filterResponseHeaders(resp.headers) });
}

async function handlePassthrough(
  request: Request,
  session: StoredSession,
  config: CloudflareConfig | null,
  usingGateway: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const subpath = url.pathname.slice("/v1".length);
  if (!subpath.replace(/^\//, "")) {
    return openaiError("请在路径中指定要转发的上游接口。", 404, { code: "not_found" });
  }

  const prefix = await detectPrefix(request, session, config, usingGateway);
  const base = getUpstreamBase(config, session, usingGateway);
  const target = `${base}${prefix}${subpath}${url.search}`;
  const headers = buildUpstreamHeaders(request, session, config, usingGateway);
  const body = await request.text();

  let resp: Response;
  try {
    resp = await fetch(target, {
      method: request.method,
      headers,
      body: body || undefined,
    });
  } catch (err) {
    return openaiError(`无法连接上游：${String(err)}`, 502, {
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
// --------------------------------------------------------------------------- //

export async function handleV1Request(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const authorized = await verifyClientApiKey(env, request, ctx);
  if (!authorized) {
    return openaiError("无效的代理 API Key。", 401, { code: "invalid_api_key" });
  }

  const session = await getSession(env);
  if (!session) {
    return openaiError("未导入会话凭证，请先到管理界面导入 session.json。", 503, {
      type: "server_error",
      code: "session_missing",
    });
  }
  if (!sessionIsUsable(session)) {
    return openaiError("会话凭证不可用（缺少 Authorization / Cookie），请重新导入。", 500, {
      type: "server_error",
      code: "session_invalid",
    });
  }

  const config = await getCloudflareConfig(env);
  const usingGateway = Boolean(config && config.enabled && config.gateway_id);

  const url = new URL(request.url);
  const subpath = url.pathname.slice("/v1".length) || "/";

  try {
    if (subpath === "/models" || subpath === "/models/") {
      return await handleModels(request, session, config, usingGateway);
    }
    if (subpath === "/chat/completions" || subpath === "/chat/completions/") {
      return await handleChat(request, session, config, usingGateway);
    }
    if (subpath === "/embeddings" || subpath === "/embeddings/") {
      return await handleEmbeddings(request, session, config, usingGateway);
    }
    return await handlePassthrough(request, session, config, usingGateway);
  } catch (err) {
    return openaiError(`代理请求失败：${String(err)}`, 502, {
      type: "server_error",
      code: "upstream_error",
    });
  }
}
