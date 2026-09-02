/**
 * Admin REST API under /admin/api/*.
 *
 * All routes (except login/setup) require a valid admin session cookie.
 */

import type { ApiKeyMeta, CloudflareConfig, Env, StoredSession } from "./types";
import {
  adminHasPassword,
  adminSetupPassword,
  adminVerifyPassword,
  clearAdminCookie,
  createAdminToken,
  isAdminAuthed,
  setAdminCookie,
} from "./auth";
import {
  buildGatewayUrl,
  ensureGateway,
  sessionHeaders,
  testViaGateway,
  upsertCustomProvider,
} from "./ai-gateway";
import {
  bytesToBase64Url,
  deleteApiKey,
  deleteCloudflareConfig,
  deleteSession,
  getCloudflareConfig,
  getSession,
  listApiKeys,
  putApiKey,
  randomBytes,
  setCloudflareConfig,
  setSession,
} from "./kv";

const PREFIX_CANDIDATES = ["/api/v1", "/api"];
const DEFAULT_PROVIDER_SLUG = "open-webui";

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

function normalizeConfig(raw: CloudflareConfig | null): CloudflareConfig | null {
  if (!raw) return null;
  return {
    api_token: raw.api_token ?? "",
    account_id: raw.account_id ?? "",
    gateway_id: raw.gateway_id ?? "",
    provider_slug: raw.provider_slug || DEFAULT_PROVIDER_SLUG,
    cache_ttl: Number(raw.cache_ttl ?? 0),
    enabled: Boolean(raw.enabled),
  };
}

function generateApiKey(): string {
  return `sk-${bytesToBase64Url(randomBytes(36))}`;
}

// --------------------------------------------------------------------------- //
// Handlers
// --------------------------------------------------------------------------- //

async function handleStatus(env: Env, request: Request): Promise<Response> {
  const session = await getSession(env);
  const config = normalizeConfig(await getCloudflareConfig(env));
  const keys = await listApiKeys(env);
  const hasSecret = Boolean(env.ADMIN_PASSWORD);

  let gatewayUrl: string | null = null;
  if (config && config.enabled && config.gateway_id) {
    gatewayUrl = buildGatewayUrl(config);
  }

  const origin = new URL(request.url).origin;
  const hasKvPassword = !hasSecret && (await adminHasPassword(env));
  return json({
    ok: true,
    adminPasswordMode: hasSecret ? "secret" : hasKvPassword ? "kv" : "none",
    session: session
      ? {
          imported: true,
          summary: describeSession(session),
          base_url: session.base_url,
          captured_at: session.captured_at,
          usable: sessionIsUsable(session),
        }
      : { imported: false },
    cloudflare: config
      ? {
          configured: Boolean(config.api_token && config.account_id),
          enabled: config.enabled,
          gateway_id: config.gateway_id,
          provider_slug: config.provider_slug,
          cache_ttl: config.cache_ttl,
        }
      : null,
    gatewayUrl,
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
  const body = await readBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  const authed = await adminVerifyPassword(env, password);
  if (!authed) return fail("密码错误。", 401);
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
    const config = normalizeConfig(await getCloudflareConfig(env));
    if (config && config.enabled && config.gateway_id) {
      const r = await testViaGateway(config, session, PREFIX_CANDIDATES);
      test = { ok: r.ok, detail: r.ok ? `通过 AI Gateway 连通（前缀 ${r.prefix}，HTTP ${r.status}）` : `AI Gateway 连通失败（HTTP ${r.status}${r.detail ? `，${r.detail}` : ""}）` };
    } else {
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

async function handleSaveCloudflare(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const prev = normalizeConfig(await getCloudflareConfig(env));
  const config: CloudflareConfig = {
    api_token: typeof body.api_token === "string" ? body.api_token.trim() : (prev?.api_token ?? ""),
    account_id: typeof body.account_id === "string" ? body.account_id.trim() : (prev?.account_id ?? ""),
    gateway_id: typeof body.gateway_id === "string" ? body.gateway_id.trim() : (prev?.gateway_id ?? ""),
    provider_slug: typeof body.provider_slug === "string" && body.provider_slug.trim()
      ? body.provider_slug.trim()
      : (prev?.provider_slug || DEFAULT_PROVIDER_SLUG),
    cache_ttl: Number(body.cache_ttl ?? prev?.cache_ttl ?? 0),
    enabled: body.enabled === undefined ? (prev?.enabled ?? false) : body.enabled === true,
  };
  if (config.cache_ttl < 0) config.cache_ttl = 0;
  if (config.enabled && (!config.api_token || !config.account_id)) {
    return fail("启用 AI Gateway 前请先填写 Cloudflare API Token 与 Account ID。");
  }
  await setCloudflareConfig(env, config);
  return json({ ok: true, config: normalizeConfig(config) });
}

async function handleAiGatewaySetup(env: Env): Promise<Response> {
  const config = normalizeConfig(await getCloudflareConfig(env));
  if (!config || !config.api_token || !config.account_id) {
    return fail("请先保存 Cloudflare API Token 与 Account ID。");
  }
  const session = await getSession(env);
  if (!session || !session.base_url) {
    return fail("请先导入 session.json（需要其中的 base_url 作为上游地址）。");
  }

  // 1. ensure gateway
  const gatewayId = await ensureGateway(config);
  config.gateway_id = gatewayId;

  // 2. register/update custom provider
  const { gatewayUrl } = await upsertCustomProvider(config, session.base_url);

  // 3. persist the gateway id
  await setCloudflareConfig(env, { ...config, enabled: true });

  // 4. connectivity test through the gateway
  const r = await testViaGateway(config, session, PREFIX_CANDIDATES);
  if (!r.ok) {
    return json({
      ok: true,
      warning: true,
      message: `Custom Provider 已注册，但经网关连通测试未通过（HTTP ${r.status}${r.detail ? `，${r.detail}` : ""}）。请在导入新的 Session 后重试。`,
      gatewayUrl,
    });
  }
  return json({
    ok: true,
    message: `AI Gateway 接入成功（前缀 ${r.prefix}，HTTP ${r.status}）。`,
    gatewayUrl,
  });
}

async function handleAiGatewayDisconnect(env: Env): Promise<Response> {
  const config = normalizeConfig(await getCloudflareConfig(env));
  if (config) {
    await setCloudflareConfig(env, { ...config, enabled: false });
  }
  return json({ ok: true, message: "已切换为直连上游模式。" });
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

async function handleDeleteCloudflare(env: Env): Promise<Response> {
  await deleteCloudflareConfig(env);
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

  // Everything else requires admin auth
  if (!(await isAdminAuthed(env, request))) {
    return json({ ok: false, error: "未登录或会话已过期。", needLogin: true }, 401);
  }

  switch (`${method} ${path}`) {
    case "POST /admin/api/session":
      return handleImportSession(env, request);
    case "DELETE /admin/api/session":
      return handleDeleteSession(env);
    case "POST /admin/api/cloudflare":
      return handleSaveCloudflare(env, request);
    case "DELETE /admin/api/cloudflare":
      return handleDeleteCloudflare(env);
    case "POST /admin/api/ai-gateway/setup":
      return handleAiGatewaySetup(env);
    case "POST /admin/api/ai-gateway/disconnect":
      return handleAiGatewayDisconnect(env);
    case "GET /admin/api/keys":
      return handleListKeys(env);
    case "POST /admin/api/keys":
      return handleCreateKey(env, request);
    case "DELETE /admin/api/keys":
      return handleDeleteKey(env, request);
    default:
      return json({ ok: false, error: "未知的管理接口。" }, 404);
  }
}

/** Whether /admin should show the "set password" view instead of the login view. */
export async function adminNeedsSetup(env: Env): Promise<boolean> {
  return !(await adminHasPassword(env));
}
