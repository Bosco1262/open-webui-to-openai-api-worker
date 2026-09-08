/**
 * Admin REST API under /admin/api/*.
 * All routes (except login/setup) require a valid admin session cookie.
 * 
 * /admin/api/* 下的管理 REST API。
 * 除 login/setup 外，所有路由均要求有效的管理会话 Cookie。
 */

import type { ApiKeyMeta, Env, StoredSession } from "./types";
import {
  adminChangePassword,
  adminPasswordSource,
  adminSetupPassword,
  adminVerifyPassword,
  clearAdminCookie,
  clientIP,
  createAdminToken,
  isAdminAuthed,
  lockoutCheck,
  lockoutClear,
  lockoutRecord,
  setAdminCookie,
} from "./auth";
import { sessionHeaders } from "./session";
import {
  ReasoningRefreshError,
  getReasoningCache,
  getReasoningSettings,
  putReasoningSettings,
  refreshReasoningCache,
} from "./reasoning";
import { getTouchInterval, setTouchInterval } from "./touch";
import { INTERVAL_OPTIONS } from "./intervals";
import {
  bytesToBase64Url,
  deleteApiKey,
  deleteSession,
  getApiKeyMeta,
  getSession,
  listApiKeys,
  putApiKey,
  randomBytes,
  setSession,
} from "./kv";

/** Upstream prefixes in probe priority order (Open WebUI >= 0.6 vs legacy). */
/** 上游前缀探测优先级顺序（Open WebUI >= 0.6 与旧版本）。 */
const PREFIX_CANDIDATES = ["/api/v1", "/api"];

interface JsonResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// Build a JSON response for the admin API.
// 构造管理 API 的 JSON 响应。
function json(data: JsonResult, status = 200): Response {
  return Response.json(data, { status });
}

// Shorthand for a failed admin API response.
// 管理 API 失败响应的简写形式。
function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

// Safely parse the JSON body, falling back to an empty object.
// 安全解析 JSON 请求体，失败时回退为空对象。
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

// A base URL is valid if it parses and uses http/https.
// 能解析且协议为 http/https 的 base URL 即为合法。
function isValidBaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// A session is usable if it carries a non-empty Authorization or Cookie.
// session 携带非空 Authorization 或 Cookie 即视为可用。
function sessionIsUsable(s: StoredSession): boolean {
  return Boolean((s.authorization && s.authorization.trim()) || (s.cookie && s.cookie.trim()));
}

/** Redacted credential summary, safe for the UI. */
/** 脱敏后的凭证摘要，可安全展示在 UI 中。 */
function describeSession(s: StoredSession): string {
  const parts: string[] = [];
  if (s.authorization) parts.push(`token=${s.authorization.slice(0, 16)}…(len=${s.authorization.length})`);
  if (s.cookie) parts.push(`cookie(len=${s.cookie.length})`);
  if (s.captured_at) parts.push(`age=${((Date.now() / 1000 - s.captured_at) / 86400).toFixed(1)}d`);
  return parts.join(", ") || "<empty>";
}

// Generate a random client API key (36 random bytes, base64url, sk- prefixed).
// 生成随机客户端 API Key（36 随机字节，base64url，sk- 前缀）。
function generateApiKey(): string {
  return `sk-${bytesToBase64Url(randomBytes(36))}`;
}

// --------------------------------------------------------------------------- //
// Handlers
// 处理函数
// --------------------------------------------------------------------------- //

// GET /admin/api/status — overview of session, keys and password mode.
// GET /admin/api/status —— session、Key 与密码模式的状态总览。
async function handleStatus(env: Env, request: Request): Promise<Response> {
  const session = await getSession(env);
  const keys = await listApiKeys(env);
  const source = await adminPasswordSource(env);
  const touchInterval = await getTouchInterval(env);

  const origin = new URL(request.url).origin;
  return json({
    ok: true,
    adminPasswordMode: source,
    passwordSource: source,
    touchInterval,
    touchIntervalOptions: INTERVAL_OPTIONS,
    session: session
      ? {
          imported: true,
          summary: describeSession(session),
          base_url: session.base_url,
          captured_at: session.captured_at,
          usable: sessionIsUsable(session),
        }
      : { imported: false },
    apiKeys: { count: keys.length },
    baseUrl: `${origin}/v1`,
  });
}

// Issue an admin session cookie together with a JSON payload.
// 签发管理会话 Cookie，并附带 JSON 负载一起返回。
async function issueSession(
  env: Env,
  request: Request,
  data: Record<string, unknown>,
): Promise<Response> {
  const token = await createAdminToken(env);
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify({ ...data, ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": setAdminCookie(token, isHttps) },
  });
}

// POST /admin/api/login — verify the password under lockout protection.
// POST /admin/api/login —— 在失败锁定保护下校验密码。
async function handleLogin(env: Env, request: Request): Promise<Response> {
  const source = await adminPasswordSource(env);
  // No password configured at all: the console must run first-visit setup.
  // 完全未配置密码：控制台必须先完成首次设密。
  if (source === "none") {
    return json({ ok: false, error: "err.need_setup", needSetup: true }, 403);
  }
  const body = await readBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  const ip = clientIP(request);
  if (ip !== "") {
    const lock = lockoutCheck(ip);
    if (lock.locked) {
      // 429 with Retry-After while the IP is locked out.
      // IP 处于锁定期内时返回 429 并附带 Retry-After。
      return new Response(JSON.stringify({ ok: false, error: "err.too_many" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(lock.retryAfterSec ?? 900),
          },
        },
      );
    }
  }
  const authed = await adminVerifyPassword(env, password);
  if (!authed) {
    if (ip !== "") lockoutRecord(ip);
    return fail("err.wrong_password", 401);
  }
  if (ip !== "") lockoutClear(ip);
  return issueSession(env, request, {});
}

// POST /admin/api/setup — first-visit password setup (only in "none" mode).
// POST /admin/api/setup —— 首次访问设密（仅 "none" 模式允许）。
async function handleSetup(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  if (password.length < 8) return fail("err.pw_too_short");
  if (password !== confirm) return fail("err.pw_mismatch");
  try {
    await adminSetupPassword(env, password);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "err.setup_failed", 400);
  }
  return issueSession(env, request, {});
}

// POST /admin/api/logout — clear the admin session cookie.
// POST /admin/api/logout —— 清除管理会话 Cookie。
async function handleLogout(env: Env, request: Request): Promise<Response> {
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": clearAdminCookie(isHttps) },
  });
}

// POST /admin/api/password — change the admin password (requires the old one).
// POST /admin/api/password —— 修改管理密码（需提供当前密码）。
async function handleChangePassword(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const current = typeof body.current_password === "string" ? body.current_password : "";
  const next = typeof body.new_password === "string" ? body.new_password : "";
  if (!current) return fail("err.pw_cur_required");
  if (!next) return fail("err.pw_new_required");
  try {
    await adminChangePassword(env, current, next);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "err.pw_change_failed", 400);
  }
  // The epoch bump invalidated every session, ours included: clear the cookie
  // and let the UI route back to the login view.
  //
  // 纪元自增使所有会话（含当前会话）失效：清除 Cookie，让 UI 回到登录视图。
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify({ ok: true, reauthenticate: true }), {
    headers: { "content-type": "application/json", "set-cookie": clearAdminCookie(isHttps) },
  });
}

// Probe the upstream /models endpoint with the candidate prefixes and return
// a structured connectivity result for the UI. Shared by "test pasted JSON"
// (handleImportSession) and "check stored session" (handleCheckSession).
//
// 用候选前缀探测上游 /models，返回供 UI 展示的结构化连通性结果。
// 由"测试粘贴的 JSON"（handleImportSession）与"检测已导入 session"
// （handleCheckSession）共用。
async function testUpstreamSession(
  session: StoredSession,
): Promise<{
  ok: boolean;
  code: string;
  prefix?: string;
  status?: number;
  error?: string;
}> {
  for (const prefix of PREFIX_CANDIDATES) {
    try {
      const resp = await fetch(`${session.base_url}${prefix}/models`, {
        headers: sessionHeaders(session),
      });
      await resp.text().catch(() => {});
      if (resp.status === 404) continue;
      return resp.ok
        ? { ok: true, code: "up.test_ok", prefix, status: resp.status }
        : { ok: false, code: "up.test_http", prefix, status: resp.status };
    } catch (err) {
      return { ok: false, code: "up.test_network", error: String(err) };
    }
  }
  return { ok: false, code: "up.test_404" };
}

// POST /admin/api/session — validate (`test`) and/or store (`save`) a session.
// POST /admin/api/session —— 校验（test）和/或保存（save）session。
async function handleImportSession(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const rawJson = typeof body.json === "string" ? body.json.trim() : "";
  const shouldTest = body.test === true;
  const shouldSave = body.save === true;

  if (!rawJson) return fail("err.session_empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return fail("err.session_json_bad");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("err.session_format_bad");
  }

  // Accept any key casing from the pasted JSON (case-insensitive mapping).
  // 接受粘贴 JSON 中任意大小写的键（大小写不敏感映射）。
  const raw = parsed as Record<string, unknown>;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

  const session: StoredSession = {
    authorization: typeof lower.authorization === "string" ? lower.authorization : "",
    cookie: typeof lower.cookie === "string" ? lower.cookie : "",
    user_agent: typeof lower.user_agent === "string" ? lower.user_agent : "",
    captured_at: Number(lower.captured_at ?? lower.capturedat ?? 0) || 0,
    base_url: typeof lower.base_url === "string" ? lower.base_url : "",
  };
  if (!sessionIsUsable(session)) {
    return fail("err.session_missing_credentials");
  }
  if (!session.base_url || !isValidBaseUrl(session.base_url)) {
    return fail("err.session_bad_base_url");
  }

  // Structured test result; the UI composes the localized message.
  // 结构化的测试结果；由 UI 负责拼出本地化的消息。
  const test = shouldTest ? await testUpstreamSession(session) : null;

  if (shouldSave) {
    await setSession(env, session);
  }

  return json({ ok: true, saved: shouldSave, test, summary: describeSession(session) });
}

// POST /admin/api/settings — update console settings (currently: last_used interval).
// POST /admin/api/settings —— 更新控制台设置（当前：last_used 记录粒度）。
async function handleSettings(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const seconds = Number(body.touch_interval);
  if (!Number.isFinite(seconds) || !(await setTouchInterval(env, seconds))) {
    return fail("err.settings_invalid");
  }
  return json({ ok: true, touchInterval: seconds });
}

// DELETE /admin/api/session — remove the stored session credentials.
// DELETE /admin/api/session —— 删除已存储的 session 凭证。
async function handleDeleteSession(env: Env): Promise<Response> {
  await deleteSession(env);
  return json({ ok: true });
}

// POST /admin/api/session/check — test the connectivity of the session already
// stored in KV (no request body needed), reusing the structured test result.
//
// POST /admin/api/session/check —— 检测已导入 KV 的 session 连通性（无需请求
// 体），复用结构化的测试结果。
async function handleCheckSession(env: Env): Promise<Response> {
  const session = await getSession(env);
  if (!session) return fail("err.session_not_imported");
  const test = await testUpstreamSession(session);
  return json({ ok: true, test, summary: describeSession(session) });
}

// GET /admin/api/keys — list keys with masked display values.
// GET /admin/api/keys —— 列出 Key，附带脱敏展示值。
async function handleListKeys(env: Env): Promise<Response> {
  const keys = await listApiKeys(env);
  return json({
    ok: true,
    keys: keys.map(({ key, meta }) => ({
      key,
      prefix: meta.prefix,
      name: meta.name,
      created_at: meta.created_at,
      last_used: meta.last_used,
      masked: `${key.slice(0, 12)}…${key.slice(-4)}`,
    })),
  });
}

// POST /admin/api/keys — generate a new client API key.
// POST /admin/api/keys —— 生成新的客户端 API Key。
async function handleCreateKey(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 64) : "";
  if (!name) return fail("err.key_name_required");
  // Reject names already used by an existing key (case-insensitive).
  // 拒绝与已有 Key 重名的名称（不区分大小写）。
  const existing = await listApiKeys(env);
  if (existing.some(({ meta }) => meta.name.toLowerCase() === name.toLowerCase())) {
    return fail("err.key_name_duplicate");
  }
  const key = generateApiKey();
  const meta: ApiKeyMeta = {
    name,
    prefix: key.slice(0, 8),
    created_at: Math.floor(Date.now() / 1000),
    last_used: 0,
  };
  await putApiKey(env, key, meta);
  // Echo `masked` so the console can render the new row immediately without
  // re-listing (KV list is eventually consistent and may lag a fresh write).
  //
  // 回传 `masked`，让控制台无需重新 list 即可立即渲染新行
  // （KV list 是最终一致的，可能滞后于刚完成的写入）。
  return json({ ok: true, key, masked: `${key.slice(0, 12)}…${key.slice(-4)}`, ...meta });
}

// DELETE /admin/api/keys — revoke a client API key by its plaintext value.
// DELETE /admin/api/keys —— 按 Key 明文撤销客户端 API Key。
async function handleDeleteKey(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) return fail("err.key_missing");
  await deleteApiKey(env, key);
  return json({ ok: true });
}

// POST /admin/api/keys/rotate — re-issue a key keeping its name. The old key
// is invalidated immediately (clients using it must switch to the new one).
// Write-new-then-delete-old ordering: a mid-way failure can only leave both
// keys valid, never neither.
//
// POST /admin/api/keys/rotate —— 保留名称重新签发 Key。旧 Key 立即失效
// （使用它的客户端必须换用新 Key）。先写新再删旧的顺序：中途失败最多
// 导致新旧并存，绝不会两者皆失。
async function handleRotateKey(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) return fail("err.key_missing");
  const existing = await getApiKeyMeta(env, key);
  if (!existing) return fail("err.key_missing");
  const newKey = generateApiKey();
  const meta: ApiKeyMeta = {
    // Name is kept verbatim: uniqueness is unchanged, no duplicate check needed.
    // 名称原样保留：唯一性不变，无需重名检查。
    name: existing.name,
    prefix: newKey.slice(0, 8),
    created_at: Math.floor(Date.now() / 1000),
    last_used: 0,
  };
  await putApiKey(env, newKey, meta);
  await deleteApiKey(env, key);
  return json({
    ok: true,
    key: newKey,
    masked: `${newKey.slice(0, 12)}…${newKey.slice(-4)}`,
    ...meta,
  });
}

// --------------------------------------------------------------------------- //
// Reasoning-effort probe
// 思考挡位探测
// --------------------------------------------------------------------------- //

// GET /admin/api/reasoning — settings plus the per-model probe results.
// GET /admin/api/reasoning —— 设置与逐模型探测结果。
async function handleReasoningInfo(env: Env): Promise<Response> {
  const settings = await getReasoningSettings(env);
  const cache = await getReasoningCache(env);
  const now = Math.floor(Date.now() / 1000);
  const models = Object.entries(cache.models)
    .map(([id, entry]) => ({
      id,
      supported_efforts: entry.supported_efforts,
      probed_at: entry.probed_at,
      // Empty set = probed but the upstream accepted the sentinel without
      // validating; expired = older than the auto-refresh granularity.
      //
      // 空集合 = 已探测但上游未校验哨兵（不可探测）；过期 = 超过自动刷新粒度。
      unprobeable: entry.supported_efforts.length === 0,
      expired:
        settings.refreshInterval > 0 &&
        entry.probed_at + settings.refreshInterval <= now,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return json({
    ok: true,
    settings,
    // 0 = auto-refresh off, then the shared granularity options.
    // 0 = 关闭自动刷新，其后为共用的粒度挡位。
    refreshIntervalOptions: [0, ...INTERVAL_OPTIONS],
    models,
    now,
  });
}

// POST /admin/api/reasoning/settings — validate and persist probe settings.
// POST /admin/api/reasoning/settings —— 校验并持久化探测设置。
async function handleReasoningSettings(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (typeof body.enabled !== "boolean") return fail("err.settings_invalid");
  const intIn = (v: unknown, lo: number, hi: number): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  };
  const concurrency = intIn(body.concurrency, 1, 8);
  const timeout = intIn(body.timeout, 1, 120);
  const wait = intIn(body.wait, 0, 30);
  if (concurrency === null || timeout === null || wait === null) {
    return fail("err.settings_invalid");
  }
  const refreshInterval = Number(body.refresh_interval);
  // 0 = auto-refresh off; otherwise must be a known granularity option.
  // 0 = 关闭自动刷新；其余必须是已知粒度挡位。
  if (
    !Number.isInteger(refreshInterval) ||
    (refreshInterval !== 0 && !INTERVAL_OPTIONS.includes(refreshInterval))
  ) {
    return fail("err.settings_invalid");
  }
  const settings = { enabled: body.enabled, concurrency, timeout, wait, refreshInterval };
  await putReasoningSettings(env, settings);
  return json({ ok: true, settings });
}

// POST /admin/api/reasoning/refresh — force a full synchronous re-probe.
// Probe requests are I/O-bound, so waiting inline inside the Worker is fine.
// Free-plan sub-request limits may cut very large model lists short; the
// partial stats are still returned and a later refresh resumes.
//
// POST /admin/api/reasoning/refresh —— 强制同步全量重探。探测请求以 I/O
// 等待为主，Worker 内同步等待可行。免费层的子请求上限可能截断超大模型
// 列表；仍返回部分统计，后续刷新可续。
async function handleReasoningRefresh(env: Env): Promise<Response> {
  let stats;
  try {
    stats = await refreshReasoningCache(env, { force: true });
  } catch (err) {
    if (err instanceof ReasoningRefreshError) {
      return fail(
        err.code === "session_missing" ? "err.reasoning_session_missing" : "err.reasoning_models_failed",
        502,
      );
    }
    return fail(String(err), 500);
  }
  return json({ ok: true, ...stats });
}

// --------------------------------------------------------------------------- //
// Router
// 路由
// --------------------------------------------------------------------------- //

// Dispatch /admin/api/* requests: public routes first, then auth-protected ones.
// 分发 /admin/api/* 请求：先处理公开路由，再处理需鉴权的路由。
export async function handleAdminApiRequest(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, ""); // strip trailing slashes / 去掉末尾斜杠
  const method = request.method;

  // Public routes
  // 公开路由
  if (method === "GET" && path === "/admin/api/status") return handleStatus(env, request);
  if (method === "POST" && path === "/admin/api/login") return handleLogin(env, request);
  if (method === "POST" && path === "/admin/api/setup") return handleSetup(env, request);
  if (method === "POST" && path === "/admin/api/logout") return handleLogout(env, request);

  // Everything else requires admin auth, and is blocked outright while no
  // admin password exists yet (mirrors M365: the console must be set up first).
  //
  // 其余路由均要求管理员鉴权；尚无管理密码时直接拒绝
  // （与 M365 对齐：控制台必须先完成设密）。
  const source = await adminPasswordSource(env);
  const authed = await isAdminAuthed(env, request);
  if (!authed || source === "none") {
    if (source === "none") {
      return json(
        { ok: false, error: "err.need_setup", needSetup: true },
        403,
      );
    }
    return json({ ok: false, error: "err.not_logged_in", needLogin: true }, 401);
  }

  switch (`${method} ${path}`) {
    case "POST /admin/api/session":
      return handleImportSession(env, request);
    case "DELETE /admin/api/session":
      return handleDeleteSession(env);
    case "POST /admin/api/session/check":
      return handleCheckSession(env);
    case "GET /admin/api/keys":
      return handleListKeys(env);
    case "POST /admin/api/keys":
      return handleCreateKey(env, request);
    case "DELETE /admin/api/keys":
      return handleDeleteKey(env, request);
    case "POST /admin/api/keys/rotate":
      return handleRotateKey(env, request);
    case "POST /admin/api/password":
      return handleChangePassword(env, request);
    case "POST /admin/api/settings":
      return handleSettings(env, request);
    case "GET /admin/api/reasoning":
      return handleReasoningInfo(env);
    case "POST /admin/api/reasoning/settings":
      return handleReasoningSettings(env, request);
    case "POST /admin/api/reasoning/refresh":
      return handleReasoningRefresh(env);
    default:
      return json({ ok: false, error: "err.unknown_endpoint" }, 404);
  }
}

/** Whether /admin should show the "set password" view instead of the login view. */
/** /admin 是否应显示「设置密码」视图而非登录视图。 */
export async function adminNeedsSetup(env: Env): Promise<boolean> {
  return (await adminPasswordSource(env)) === "none";
}
