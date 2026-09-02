/**
 * Admin REST API under /admin/api/*.
 *
 * All routes (except login/setup) require a valid admin session cookie.
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
  bytesToBase64Url,
  deleteApiKey,
  deleteSession,
  getSession,
  listApiKeys,
  putApiKey,
  randomBytes,
  setSession,
} from "./kv";

const PREFIX_CANDIDATES = ["/api/v1", "/api"];

interface JsonResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

function json(data: JsonResult, status = 200): Response {
  return Response.json(data, { status });
}

function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function isValidBaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function sessionIsUsable(s: StoredSession): boolean {
  return Boolean((s.authorization && s.authorization.trim()) || (s.cookie && s.cookie.trim()));
}

/** Redacted credential summary, safe for the UI. */
function describeSession(s: StoredSession): string {
  const parts: string[] = [];
  if (s.authorization) parts.push(`token=${s.authorization.slice(0, 16)}…(len=${s.authorization.length})`);
  if (s.cookie) parts.push(`cookie(len=${s.cookie.length})`);
  if (s.captured_at) parts.push(`age=${((Date.now() / 1000 - s.captured_at) / 86400).toFixed(1)}d`);
  return parts.join(", ") || "<empty>";
}

function generateApiKey(): string {
  return `sk-${bytesToBase64Url(randomBytes(36))}`;
}

// --------------------------------------------------------------------------- //
// Handlers
// --------------------------------------------------------------------------- //

async function handleStatus(env: Env, request: Request): Promise<Response> {
  const session = await getSession(env);
  const keys = await listApiKeys(env);
  const source = await adminPasswordSource(env);

  const origin = new URL(request.url).origin;
  return json({
    ok: true,
    adminPasswordMode: source,
    passwordSource: source,
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

async function handleLogin(env: Env, request: Request): Promise<Response> {
  const source = await adminPasswordSource(env);
  if (source === "none") {
    return json(
      { ok: false, error: "管理员密码尚未设置，请先完成首次设置。", needSetup: true },
      403,
    );
  }
  const body = await readBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  const ip = clientIP(request);
  if (ip !== "") {
    const lock = lockoutCheck(ip);
    if (lock.locked) {
      return new Response(
        JSON.stringify({ ok: false, error: "登录失败次数过多，请稍后重试。" }),
        {
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
    return fail("密码错误。", 401);
  }
  if (ip !== "") lockoutClear(ip);
  return issueSession(env, request, {});
}

async function handleSetup(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  if (password.length < 8) return fail("密码长度至少 8 位。");
  if (password !== confirm) return fail("两次输入的密码不一致。");
  try {
    await adminSetupPassword(env, password);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "设置密码失败。", 400);
  }
  return issueSession(env, request, {});
}

async function handleLogout(env: Env, request: Request): Promise<Response> {
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": clearAdminCookie(isHttps) },
  });
}

async function handleChangePassword(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const current = typeof body.current_password === "string" ? body.current_password : "";
  const next = typeof body.new_password === "string" ? body.new_password : "";
  if (!current) return fail("请填写当前密码。");
  if (!next) return fail("请填写新密码。");
  try {
    await adminChangePassword(env, current, next);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "修改密码失败。", 400);
  }
  // The epoch bump invalidated every session, ours included: clear the cookie
  // and let the UI route back to the login view.
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify({ ok: true, reauthenticate: true }), {
    headers: { "content-type": "application/json", "set-cookie": clearAdminCookie(isHttps) },
  });
}

async function handleImportSession(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const rawJson = typeof body.json === "string" ? body.json.trim() : "";
  const shouldTest = body.test === true;
  const shouldSave = body.save === true;

  if (!rawJson) return fail("请粘贴 session.json 的 JSON 内容。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return fail("JSON 解析失败，请检查粘贴内容。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("内容格式不正确，应为 JSON 对象。");
  }

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
    return fail("缺少 Authorization 与 Cookie（至少需要其一）。");
  }
  if (!session.base_url || !isValidBaseUrl(session.base_url)) {
    return fail("base_url 缺失或不是合法地址（需 http/https 开头）。");
  }

  let test: { ok: boolean; detail: string } | null = null;
  if (shouldTest) {
    // Direct connectivity test
    for (const prefix of PREFIX_CANDIDATES) {
      try {
        const resp = await fetch(`${session.base_url}${prefix}/models`, {
          headers: sessionHeaders(session),
        });
        await resp.text().catch(() => {});
        if (resp.status === 404) continue;
        test = resp.ok
          ? { ok: true, detail: `直连连通（前缀 ${prefix}，HTTP ${resp.status}）` }
          : { ok: false, detail: `上游返回 HTTP ${resp.status}（前缀 ${prefix}），凭证可能已过期` };
        break;
      } catch (err) {
        test = { ok: false, detail: `无法连接上游：${String(err)}` };
        break;
      }
    }
    if (!test) test = { ok: false, detail: "所有候选前缀均返回 404，请确认地址指向 Open WebUI" };
  }

  if (shouldSave) {
    await setSession(env, session);
  }

  return json({ ok: true, saved: shouldSave, test, summary: describeSession(session) });
}

async function handleDeleteSession(env: Env): Promise<Response> {
  await deleteSession(env);
  return json({ ok: true });
}

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

async function handleCreateKey(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "未命名";
  const key = generateApiKey();
  const meta: ApiKeyMeta = {
    name,
    prefix: key.slice(0, 8),
    created_at: Math.floor(Date.now() / 1000),
    last_used: 0,
  };
  await putApiKey(env, key, meta);
  return json({ ok: true, key, ...meta });
}

async function handleDeleteKey(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) return fail("缺少要删除的 API Key。");
  await deleteApiKey(env, key);
  return json({ ok: true });
}

// --------------------------------------------------------------------------- //
// Router
// --------------------------------------------------------------------------- //

export async function handleAdminApiRequest(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, ""); // strip trailing slashes
  const method = request.method;

  // Public routes
  if (method === "GET" && path === "/admin/api/status") return handleStatus(env, request);
  if (method === "POST" && path === "/admin/api/login") return handleLogin(env, request);
  if (method === "POST" && path === "/admin/api/setup") return handleSetup(env, request);
  if (method === "POST" && path === "/admin/api/logout") return handleLogout(env, request);

  // Everything else requires admin auth, and is blocked outright while no
  // admin password exists yet (mirrors M365: the console must be set up first).
  const source = await adminPasswordSource(env);
  const authed = await isAdminAuthed(env, request);
  if (!authed || source === "none") {
    if (source === "none") {
      return json(
        { ok: false, error: "管理员密码尚未设置，请先完成首次设置。", needSetup: true },
        403,
      );
    }
    return json({ ok: false, error: "未登录或会话已过期。", needLogin: true }, 401);
  }

  switch (`${method} ${path}`) {
    case "POST /admin/api/session":
      return handleImportSession(env, request);
    case "DELETE /admin/api/session":
      return handleDeleteSession(env);
    case "GET /admin/api/keys":
      return handleListKeys(env);
    case "POST /admin/api/keys":
      return handleCreateKey(env, request);
    case "DELETE /admin/api/keys":
      return handleDeleteKey(env, request);
    case "POST /admin/api/password":
      return handleChangePassword(env, request);
    default:
      return json({ ok: false, error: "未知的管理接口。" }, 404);
  }
}

/** Whether /admin should show the "set password" view instead of the login view. */
export async function adminNeedsSetup(env: Env): Promise<boolean> {
  return (await adminPasswordSource(env)) === "none";
}
