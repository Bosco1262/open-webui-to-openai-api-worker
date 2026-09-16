/**
 * Admin REST API under /admin/api/*.
 * All routes (except login/setup) require a valid admin session cookie.
 * 
 * /admin/api/* 下的管理 REST API。
 * 除 login/setup 外，所有路由均要求有效的管理会话 Cookie。
 */

import type { ApiKeyMeta, Env, StoredSession } from "./types.ts";
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
} from "./auth.ts";
import { fetchUpstream, sessionHeaders, sessionIsUsable } from "./session.ts";
import { PREFIX_CANDIDATES, checkUpstreamBaseUrl, confirmUpstreamPrefix } from "./upstream.ts";
import {
  parseProbeSettingsInput,
  readProbeSettings,
  writeProbeSettings,
} from "./probeSettings.ts";
import { RoundUnavailable } from "./probeRuntime.ts";
import type { ProbeHealth } from "./probeRuntime.ts";
import type { ModelProbeCoordinator, ProbeCoordinatorView } from "./probeCoordinator.ts";
import { clearTouchMarker, deleteApiKeyUsage, getTouchInterval, readApiKeyUsages, setTouchInterval } from "./touch.ts";
import { INTERVAL_OPTIONS } from "./intervals.ts";
import {
  apiKeyId,
  bytesToBase64Url,
  deleteApiKeyById,
  deleteSession,
  getApiKeyEntryById,
  getSession,
  listApiKeyEntries,
  listApiKeys,
  putApiKey,
  randomBytes,
  sessionSecretWarnings,
  setSession,
} from "./kv.ts";

interface JsonResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Headers every admin response carries.
 *
 * Admin responses include one-time plaintext API keys and the credential summary, so
 * they must never be cached by the browser or an intermediary; `nosniff` keeps a
 * mislabelled response from being re-interpreted as HTML, and the CSP (also applied
 * to the console page itself, see index.ts) bounds what any future injection could do.
 *
 * 所有管理端响应携带的响应头。
 *
 * 管理端响应包含一次性明文 API Key 与凭证摘要，因此绝不能被浏览器或中间层缓存；
 * `nosniff` 阻止被错误标注的响应被重新解释成 HTML；CSP（控制台页面本身也带，见
 * index.ts）则限定未来任何注入能做到的事。
 */
export const ADMIN_SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// Build a JSON response for the admin API.
// 构造管理 API 的 JSON 响应。
function json(data: JsonResult, status = 200): Response {
  return Response.json(data, { status, headers: ADMIN_SECURITY_HEADERS });
}

// Shorthand for a failed admin API response.
// 管理 API 失败响应的简写形式。
function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

// A JSON response carrying security headers plus any number of Set-Cookie values.
// Signing out expires BOTH admin cookie names (see clearAdminCookie), which a plain
// object cannot express -- `Headers.append` is what keeps the second one.
//
// 携带安全响应头与任意数量 Set-Cookie 的 JSON 响应。登出会使**两个**管理 Cookie 名
// 一起过期（见 clearAdminCookie），这是普通对象无法表达的——靠 `Headers.append` 才能
// 保住第二个。
function jsonWithCookies(data: unknown, cookies: readonly string[], status = 200): Response {
  const headers = new Headers(ADMIN_SECURITY_HEADERS);
  headers.set("content-type", "application/json");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
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

// A base URL is valid when the upstream policy accepts it (HTTPS, no private or
// metadata literal host, standard port; loopback exempt). See `checkUpstreamBaseUrl`.
// base URL 的合法性由上游策略判定（HTTPS、非私网/元数据字面主机、标准端口；回环例外）。
// 见 `checkUpstreamBaseUrl`。
function isValidBaseUrl(url: string): boolean {
  return checkUpstreamBaseUrl(url).ok;
}

/** The i18n error code for a refused base URL. */
/** 被拒绝的 base URL 对应的 i18n 错误码。 */
function baseUrlErrorCode(url: string): string {
  const check = checkUpstreamBaseUrl(url);
  if (check.ok) return "";
  if (check.reason === "https_required") return "err.base_url_https_required";
  if (check.reason === "forbidden_host") return "err.base_url_forbidden_host";
  return "err.session_bad_base_url";
}

/** Redacted credential summary, safe for the UI. */
/** 脱敏后的凭证摘要，可安全展示在 UI 中。 */
function describeSession(session: StoredSession): string {
  const parts: string[] = [];
  if (session.authorization) parts.push(`token=${session.authorization.slice(0, 16)}…(len=${session.authorization.length})`);
  if (session.cookie) parts.push(`cookie(len=${session.cookie.length})`);
  if (session.captured_at) parts.push(`age=${((Date.now() / 1000 - session.captured_at) / 86400).toFixed(1)}d`);
  return parts.join(", ") || "<empty>";
}

// Generate a random client API key (36 random bytes, base64url, sk- prefixed).
// 生成随机客户端 API Key（36 随机字节，base64url，sk- 前缀）。
function generateApiKey(): string {
  return `sk-${bytesToBase64Url(randomBytes(36))}`;
}

/** The only display form of a key that is ever stored or listed. */
/** 一把 Key 唯一会被存储或列出的展示形式。 */
function maskApiKey(key: string): string {
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

/**
 * The key a mutating request addresses, as its public id.
 *
 * The console sends `id` (the key's digest). A plaintext `key` is still accepted -- and
 * immediately hashed -- so a console page cached from before this change keeps working;
 * the plaintext is never stored, compared or echoed.
 *
 * 变更类请求所指向的 Key，以其公开 id 表示。
 *
 * 控制台发送 `id`（Key 的摘要）。明文 `key` 仍被接受——并立即哈希——使本改动之前
 * 缓存的页面继续可用；明文本身绝不会被存储、比较或回显。
 */
async function keyIdFromBody(body: Record<string, unknown>): Promise<string> {
  if (typeof body.id === "string" && body.id) return body.id;
  if (typeof body.key === "string" && body.key) return apiKeyId(body.key);
  return "";
}

// --------------------------------------------------------------------------- //
// Handlers
// 处理函数
// --------------------------------------------------------------------------- //

// GET /admin/api/status — overview of session, keys and password mode.
//
// Public on purpose, but only partially: the console hits this endpoint BEFORE
// logging in to pick the login vs first-run-setup view, so the password mode must
// be readable unauthenticated. Everything else -- the upstream base_url, the
// credential summary (token prefix, cookie length, credential age), the key
// count, this Worker's own /v1 address -- is deployment info an unauthenticated
// visitor has no need for, so the unauthenticated answer carries the mode and
// nothing else.
//
// GET /admin/api/status —— session、Key 与密码模式的状态总览。
//
// 刻意公开，但只公开一部分：控制台在登录**前**就要访问本端点，用于选择登录还是
// 首次设密视图，因此密码模式必须可以未鉴权读取。其余一切——上游 base_url、凭证
// 摘要（token 前缀、Cookie 长度、凭证年龄）、Key 数量、本 Worker 的 /v1 接入地址
// ——都是未登录访问者无需知道的部署信息，因此未鉴权的答复只带密码模式，别无其它。
async function handleStatus(env: Env, request: Request): Promise<Response> {
  if (!(await isAdminAuthed(env, request))) {
    return json({ ok: true, adminPasswordMode: await adminPasswordSource(env) });
  }
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
    // Operator-facing configuration warnings (i18n keys); the console shows each one
    // once per page load. Currently: a bound SESSION_SECRET that is too short.
    //
    // 面向运维的配置告警（i18n 键）；控制台每次页面加载各提示一次。目前是：绑定的
    // SESSION_SECRET 过短。
    warnings: sessionSecretWarnings(env),
    session: session
      ? {
          imported: true,
          summary: describeSession(session),
          base_url: session.base_url,
          captured_at: session.captured_at,
          usable: sessionIsUsable(session),
        }
      : { imported: false },
    // The queue's health rides along with the session summary: the console shows both in
    // the same card, and "imported" alone would hide the case that matters most --
    // credentials the upstream is rejecting.
    //
    // 队列健康与 session 摘要同行：控制台把它们放在同一张卡片里，而只显示"已导入"会掩盖最
    // 要紧的那种情形——上游正在拒绝这份凭证。
    health: await probeHealthFor(env, session),
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
  return jsonWithCookies({ ...data, ok: true }, [setAdminCookie(token, isHttps)]);
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
            ...ADMIN_SECURITY_HEADERS,
            "content-type": "application/json",
            "retry-after": String(lock.retryAfterSec),
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
  // When the password comes from the ADMIN_PASSWORD secret, setup is closed outright:
  // the web setup exists only for the "nothing configured yet" state. That state is
  // inherently claimable by whoever reaches /admin first, which is why the README
  // tells operators to preset the secret before exposing the Worker.
  //
  // 密码来自 ADMIN_PASSWORD Secret 时，设密入口直接关闭：网页设密只为"尚未配置任何
  // 密码"的状态而存在，而那个状态本来就会被第一个访问 /admin 的人占住——这正是 README
  // 要求运维在暴露 Worker 之前先预设 Secret 的原因。
  if ((await adminPasswordSource(env)) === "secret") {
    return fail("err.setup_secret_exists", 403);
  }
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
  return jsonWithCookies({ ok: true }, clearAdminCookie(isHttps));
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
  return jsonWithCookies({ ok: true, reauthenticate: true }, clearAdminCookie(isHttps));
}

// Probe the upstream /models endpoint with the candidate prefixes and return
// a structured connectivity result for the UI. Shared by "test pasted JSON"
// (handleImportSession) and "check stored session" (handleCheckSession).
//
// The prefix is confirmed with the SAME rule the proxy and the coordinator use, and
// the loop must `continue` rather than fail on the first candidate: a deployment whose
// first candidate is the SPA's "200 + HTML" page would otherwise never test OK, no
// matter how healthy it is.
//
// 用候选前缀探测上游 /models，返回供 UI 展示的结构化连通性结果。
// 由"测试粘贴的 JSON"（handleImportSession）与"检测已导入 session"
// （handleCheckSession）共用。
//
// 前缀确认规则与代理、协调者完全相同；循环必须 `continue` 而不是在首个候选上直接
// 失败：否则首选候选是 SPA 的 "200 + HTML" 页面的部署，无论多健康都永远测不通。
async function testUpstreamSession(
  session: StoredSession,
): Promise<{
  ok: boolean;
  code: string;
  prefix?: string;
  status?: number;
  error?: string;
}> {
  try {
    const confirmed = await confirmUpstreamPrefix(PREFIX_CANDIDATES, async (prefix) => {
      const resp = await fetchUpstream(
        `${session.base_url}${prefix}/models`,
        { headers: sessionHeaders(session) },
        { metadata: true },
      );
      return {
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        text: await resp.text().catch(() => ""),
      };
    });
    if (confirmed) {
      // A 401/403 confirms the route but not the credentials: the UI wording differs
      // ("credentials may have expired" rather than "direct connection OK").
      //
      // 401/403 确认了路由但没确认凭证：UI 的措辞不同（"凭证可能已过期"而不是"直连
      // 连通"）。
      return confirmed.authFailure
        ? { ok: false, code: "up.test_http", prefix: confirmed.prefix, status: confirmed.status }
        : { ok: true, code: "up.test_ok", prefix: confirmed.prefix, status: confirmed.status };
    }
  } catch (err) {
    // A transport failure on ANY candidate is reported as a network error: the other
    // candidates would fail the same way.
    //
    // 任意一个候选出现传输层失败都报网络错误：其余候选会以同样方式失败。
    return { ok: false, code: "up.test_network", error: String(err) };
  }
  // Nothing could be confirmed: no candidate answered with a model list, and the
  // upstream never rejected the credentials either. The old `up.test_404` wording
  // ("all prefixes returned 404") is no longer true -- a SPA-hijacked 200 and a 5xx
  // land here too.
  //
  // 一个都确认不了：没有任何候选以模型列表作答，上游也没有拒绝凭证。旧的
  // `up.test_404`（"所有前缀都返回 404"）已不再准确——被 SPA 接管的 200 与 5xx 也会
  // 落到这里。
  return { ok: false, code: "up.test_not_models" };
}

/**
 * Size ceilings for an imported session.
 *
 * A stored session is read on the import path, on every `/admin/api/session/check`
 * and by the probe coordinator -- so an unvalidated blob is re-read (and re-parsed)
 * forever. Real captures are a few kilobytes at most; these caps are generous for
 * them and still bounded.
 *
 * 导入 session 的大小上限。
 *
 * 已存储的 session 会在导入路径、每次 `/admin/api/session/check` 以及探测协调者中被
 * 读取——因此一个不受校验的巨型负载会被**反复**读出并解析。真实捕获最多几 KB；这些
 * 上限对它足够宽松，同时仍是有限的。
 */
const MAX_SESSION_JSON_CHARS = 64 * 1024;
const MAX_CREDENTIAL_CHARS = 8 * 1024;
const MAX_USER_AGENT_CHARS = 512;
const MAX_BASE_URL_CHARS = 2048;

// POST /admin/api/session — validate (`test`) and/or store (`save`) a session.
// POST /admin/api/session —— 校验（test）和/或保存（save）session。
async function handleImportSession(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const rawJson = typeof body.json === "string" ? body.json.trim() : "";
  const shouldTest = body.test === true;
  const shouldSave = body.save === true;

  if (!rawJson) return fail("err.session_empty");
  if (rawJson.length > MAX_SESSION_JSON_CHARS) return fail("err.session_too_large");
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
  if (
    session.authorization.length > MAX_CREDENTIAL_CHARS ||
    session.cookie.length > MAX_CREDENTIAL_CHARS ||
    session.user_agent.length > MAX_USER_AGENT_CHARS ||
    session.base_url.length > MAX_BASE_URL_CHARS
  ) {
    return fail("err.session_too_large");
  }
  if (!sessionIsUsable(session)) {
    return fail("err.session_missing_credentials");
  }
  // The upstream URL policy is enforced here, at import time: HTTPS unless the host
  // is loopback, no private/link-local/metadata literal host, standard port. See
  // `checkUpstreamBaseUrl` for why (cleartext credentials, request forgery).
  //
  // 上游地址策略在这里、即导入时就强制执行：除回环主机外必须是 HTTPS，不接受私网/
  // 链路本地/元数据字面主机，端口须为标准端口。理由见 `checkUpstreamBaseUrl`
  // （明文凭证、请求伪造）。
  if (!session.base_url || !isValidBaseUrl(session.base_url)) {
    return fail(baseUrlErrorCode(session.base_url) || "err.session_bad_base_url");
  }

  // Structured test result; the UI composes the localized message.
  // 结构化的测试结果；由 UI 负责拼出本地化的消息。
  const test = shouldTest ? await testUpstreamSession(session) : null;

  if (shouldSave) {
    // A failed connectivity test means the credentials may be dead: refuse to
    // overwrite the stored session (which may still be working) unless the
    // operator explicitly forces the import.
    //
    // 连通性测试失败说明凭证可能已死：拒绝覆盖已存储（可能仍可用）的 session，
    // 除非运维显式强制导入。
    if (test && !test.ok && body.force !== true) {
      return json({ ok: false, error: "err.session_test_failed", needForce: true, test }, 409);
    }
    await setSession(env, session);
    // A fresh import is exactly the thing that fixes a rejected credential: let the queue
    // move again (best effort -- the save has already happened).
    //
    // 重新导入正是修复"凭证被拒"的那件事：让队列重新动起来（尽力而为——保存已经完成了）。
    await resumeProbesFor(env, session);
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
  // The coordinator is told BEFORE the session disappears from KV, because it needs the
  // base_url to find its own instance (and because "the queue is stopped, no session" is
  // the truth from that moment on -- a later round would only re-learn it).
  //
  // 先告诉协调者、再删 KV 里的 session：它需要 base_url 找到自己的实例（也因为从那一刻起
  // "队列已停、没有 session"就是事实——之后再跑一轮也只能重新得知它）。
  await suspendProbesForDeletedSession(env, await getSession(env));
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
  // A green check is a second proof (besides a fresh import) that the credentials work:
  // resume a suspended queue instead of leaving the operator to wonder why probing is
  // still paused. A red one changes nothing -- the next round will record it anyway.
  //
  // 检测通过是"凭证可用"的第二个证据（除了重新导入）：解除挂起，别让运维纳闷探测为什么还是
  // 停着。检测不通过则什么都不改——下一轮自然会记录。
  if (test.ok) await resumeProbesFor(env, session);
  return json({ ok: true, test, summary: describeSession(session) });
}

// GET /admin/api/keys — list keys as id + display metadata, never the secret.
//
// The full key is unavailable by construction: only its digest (the id) and the
// pre-rendered masked form are stored, so this endpoint cannot leak a usable
// credential even to a caller holding the admin session.
//
// GET /admin/api/keys —— 以 id + 展示元数据列出 Key，绝不含密钥。
//
// 完整 Key 在构造上就取不到：存储的只有它的摘要（即 id）与预先渲染的脱敏形式，
// 因此本端点即便对持有管理会话的调用方也无法泄露可用凭证。
async function handleListKeys(env: Env): Promise<Response> {
  const entries = await listApiKeyEntries(env);
  const usage = await readApiKeyUsages(env, entries.map((entry) => entry.id));
  return json({
    ok: true,
    keys: entries.map(({ id, meta }) => ({
      id,
      prefix: meta.prefix,
      name: meta.name,
      created_at: meta.created_at,
      // Usage records are the live source; `meta.last_used` is what keys created
      // before this change still carry.
      //
      // 使用记录是实时来源；`meta.last_used` 是本改动之前创建的 Key 仍然携带的值。
      last_used: usage[id] || meta.last_used || 0,
      masked: meta.masked ?? `${meta.prefix || "sk-"}…`,
    })),
  });
}

// POST /admin/api/keys — generate a new client API key.
// POST /admin/api/keys —— 生成新的客户端 API Key。
async function handleCreateKey(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 64) : "";
  if (!name) return fail("err.key_name_required");
  // Reject names already used by an existing key (case-insensitive). `name` is
  // whatever KV returned, so it is coerced first: a hand-edited or foreign entry with a
  // numeric name would otherwise throw a TypeError here and the operator could not
  // create ANY key.
  //
  // 拒绝与已有 Key 重名的名称（不区分大小写）。`name` 是 KV 返回的任意值，因此先做
  // 强制转换：否则一条手改的或外来的、name 为数字的条目会在这里抛 TypeError，运维就
  // 一个 Key 都建不了了。
  const existing = await listApiKeyEntries(env);
  if (existing.some(({ meta }) => String(meta.name ?? "").toLowerCase() === name.toLowerCase())) {
    return fail("err.key_name_duplicate");
  }
  const key = generateApiKey();
  const meta: ApiKeyMeta = {
    name,
    prefix: key.slice(0, 8),
    created_at: Math.floor(Date.now() / 1000),
    last_used: 0,
    masked: maskApiKey(key),
  };
  const id = await putApiKey(env, key, meta);
  // The plaintext is echoed exactly ONCE, here: nothing storeable can produce it again.
  // `id`/`masked` let the console render the new row without re-listing (KV list is
  // eventually consistent and may lag a fresh write).
  //
  // 明文只在这里回显**一次**：任何可存储的内容都无法再产生它。`id`/`masked` 让控制台
  // 无需重新 list 即可渲染新行（KV list 是最终一致的，可能滞后于刚完成的写入）。
  return json({ ok: true, id, key, masked: meta.masked, ...meta });
}

// DELETE /admin/api/keys — revoke a client API key by its public id.
// DELETE /admin/api/keys —— 按公开 id 撤销客户端 API Key。
async function handleDeleteKey(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const id = await keyIdFromBody(body);
  if (!id) return fail("err.key_missing");
  await deleteApiKeyById(env, id);
  // The usage record goes with the key: it is the key's own bookkeeping, and leaving
  // it behind would make the next key that happens to reuse the id inherit a
  // last-used timestamp out of nowhere.
  //
  // 使用记录随 Key 一起删除：它属于该 Key 自己的记账，残留会让"恰好复用同一 id"的
  // 下一把 Key 凭空继承一个最近使用时刻。
  await deleteApiKeyUsage(env, id);
  // Drop the in-instance touch marker: the key no longer exists.
  // 清除实例内的写入标记：这个 Key 已不存在。
  clearTouchMarker(id);
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
  const id = await keyIdFromBody(body);
  if (!id) return fail("err.key_missing");
  const existing = await getApiKeyEntryById(env, id);
  if (!existing) return fail("err.key_missing");
  const newKey = generateApiKey();
  const meta: ApiKeyMeta = {
    // Name AND last_used are kept verbatim (operator decision): the rotation
    // re-issues the credential for the same client, so "has this client been
    // used and when" survives the swap; only the secret itself is replaced.
    //
    // 名称与 last_used 原样保留（运维决策）：轮转是为同一客户端换发凭证，因此
    // "这个客户端是否被用过、何时" 在换发后延续；被替换的只是密钥本身。
    name: existing.meta.name,
    prefix: newKey.slice(0, 8),
    created_at: existing.meta.created_at,
    last_used: existing.meta.last_used,
    masked: maskApiKey(newKey),
  };
  const newId = await putApiKey(env, newKey, meta);
  await env.KV.delete(existing.kvName);
  await deleteApiKeyUsage(env, id);
  // Drop the in-instance touch marker of the OLD key: it no longer exists.
  // 清除**旧** Key 的实例内写入标记：它已不存在。
  clearTouchMarker(id);
  return json({
    ok: true,
    id: newId,
    key: newKey,
    masked: meta.masked,
    ...meta,
  });
}

// --------------------------------------------------------------------------- //
// Model probe
// 模型探测
// --------------------------------------------------------------------------- //

// GET /admin/api/probe — settings plus the per-model probe results.
// GET /admin/api/probe —— 设置与逐模型探测结果。
async function handleProbeInfo(env: Env): Promise<Response> {
  const settings = await readProbeSettings(env, { useCache: false });
  const coordinator = probeCoordinatorFor(env, await getSession(env));
  let view: ProbeCoordinatorView | null = null;
  if (coordinator) {
    try {
      view = await coordinator.view();
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "probe view unavailable",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return json({
    ok: true,
    settings,
    // The heartbeat steps are the shared granularity table itself (same source as the
    // usage-tracking select), so the console never hardcodes its own cadences.
    //
    // 心跳档位就是共享刻度表本身（与「使用记录粒度」下拉框同源），控制台绝不自行
    // 硬编码节奏。
    heartbeatOptions: INTERVAL_OPTIONS,
    // Health travels with the table so the console can explain an empty one ("probing is
    // paused: the upstream rejected the credentials") instead of showing nothing.
    //
    // 健康状态与表格同行：空表时控制台才能解释原因（"探测已暂停：上游拒绝了凭证"），而不是
    // 什么都不显示。
    health: view ? view.health : null,
    models: view?.models ?? [],
  });
}

// POST /admin/api/probe/settings — validate and persist probe settings.
// POST /admin/api/probe/settings —— 校验并持久化探测设置。
async function handleProbeSettings(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const settings = parseProbeSettingsInput(body);
  if (!settings) return fail("err.settings_invalid");
  await writeProbeSettings(env, settings);
  // Re-arm (or cancel) the coordinator's heartbeat immediately: an idle deployment has
  // no other occasion to notice the change. Best effort -- the settings ARE saved, and
  // a hiccup here (no session, DO restart) must not turn into a failed console save.
  //
  // 立即重排（或取消）协调者的心跳：空闲部署没有别的时机感知改动。尽力而为——设置
  // 已经落盘，这里的意外（无 session、DO 重启）绝不能变成控制台的一次保存失败。
  try {
    const coordinator = probeCoordinatorFor(env, await getSession(env));
    if (coordinator) await coordinator.rescheduleHeartbeat();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "probe heartbeat reschedule failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return json({ ok: true, settings });
}

// POST /admin/api/probe/refresh — force a re-probe (one model when `model` is given,
// everything otherwise). The coordinator bounds it by `budget` and keeps going with
// its own alarm, so a truncated answer means "the rest is still being probed".
//
// POST /admin/api/probe/refresh —— 强制重探（带 `model` 时只探该模型，否则全部）。
// 协调者按 `budget` 限流并用自身的 alarm 继续推进，因此被截断的答复含义是
// "其余仍在探测中"。
async function handleProbeRefresh(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const coordinator = probeCoordinatorFor(env, await getSession(env));
  if (!coordinator) return fail("err.probe_session_missing", 502);
  try {
    const requested = typeof body.model === "string" && body.model ? body.model : null;
    // Ack-and-poll: the round runs on the coordinator's alarm (a full round can
    // outlive an HTTP invocation), so this answers as soon as the up-front checks
    // (session, model list, model existence) pass. Round results surface in the
    // probe table, which the console refreshes on timers.
    //
    // 应答后轮询：轮次由协调者的 alarm 执行（完整轮次可能超出一次 HTTP 调用的生存
    // 期），因此前置检查（session、模型列表、模型存在性）一通过就应答。轮次结果
    // 由探测表呈现，控制台按定时器刷新。
    await coordinator.refreshInBackground(requested);
    return json({ ok: true, accepted: true, model: requested });
  } catch (err) {
    const roundCode = roundUnavailableCode(err);
    if (roundCode) {
      return fail(
        roundCode === "session_missing"
          ? "err.probe_session_missing"
          : roundCode === "auth_rejected"
            ? "err.probe_auth_rejected"
            : "err.probe_models_failed",
        502,
      );
    }
    // A per-model refresh naming a model the upstream does not have is the caller's
    // mistake, not a server failure: 404 with its own code instead of a raw English
    // 500. The error NAME survives the RPC boundary (the message too), which is
    // what makes the match possible.
    //
    // 单模型重探指名了上游不存在的模型，这是调用方的错误而非服务器故障：回 404 与
    // 专用错误码，而不是原始英文 500。错误**名字**（连同消息）能穿过 RPC 边界，
    // 这正是匹配可行的原因。
    if (err instanceof Error && err.name === "ModelNotInList") {
      return fail("err.probe_model_missing", 404);
    }
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}

/**
 * Recognize `RoundUnavailable` raised on the far side of the Durable Object RPC.
 *
 * The coordinator throws the class from probeRuntime.ts, but error serialization
 * across the RPC boundary keeps only `name` and `message`: what arrives here is a
 * plain `Error`, so `instanceof` is false and the custom `code` field is gone.
 * Missing that made the console display the raw string "models_failed" -- with HTTP
 * 500 -- instead of the localized "cannot fetch the upstream model list" 502.
 *
 * The constructor passes the code as the message, so a surviving message identifies
 * the case; anything else keeps the generic 500 path.
 *
 * 识别从 Durable Object RPC 另一侧抛来的 `RoundUnavailable`。
 *
 * 协调者抛出 probeRuntime.ts 里的类，但跨 RPC 边界的错误序列化只保留 `name` 与
 * `message`：到达这里的是普通 `Error`，`instanceof` 为 false，自定义的 `code` 字段
 * 也不复存在。此前正是漏掉了这一点，控制台才会显示原始字符串 "models_failed"（且
 * HTTP 500），而不是本地化的"无法获取上游模型列表"（502）。
 *
 * 构造函数把 code 当作 message 传入，因此幸存的 message 足以判定；其余情况继续走
 * 通用的 500 路径。
 */
function roundUnavailableCode(
  err: unknown,
): "session_missing" | "models_failed" | "auth_rejected" | null {
  if (err instanceof RoundUnavailable) return err.code;
  if (err instanceof Error) {
    // Across the RPC boundary only `name` and `message` survive. The coordinator
    // embeds the code in the name ("RoundUnavailable:<code>", see RoundUnavailable);
    // the bare name plus message match stays as a fallback for older deployed
    // instances still serving the previous format.
    //
    // 跨 RPC 边界只保留 name 与 message。协调者把 code 嵌进 name
    // （"RoundUnavailable:<code>"，见 RoundUnavailable）；裸 name + message 的匹配
    // 作为仍在运行旧格式的已部署实例的兜底。
    const named = /^RoundUnavailable:(.+)$/.exec(err.name);
    if (named) {
      const code = named[1];
      return code === "session_missing" || code === "auth_rejected" ? code : "models_failed";
    }
    if (err.name === "RoundUnavailable") {
      if (err.message.includes("session_missing")) return "session_missing";
      if (err.message.includes("auth_rejected")) return "auth_rejected";
      return "models_failed";
    }
  }
  return null;
}

/** The coordinator stub, or null while no session has been imported (there is
 *  nothing to probe, and no upstream to name the instance after). */
/** 协调者 stub；尚未导入 session 时为 null（没有可探测的对象，也没有可用于命名实例的
 *  上游）。 */
function probeCoordinatorFor(env: Env, session: StoredSession | null): DurableObjectStub<ModelProbeCoordinator> | null {
  if (!session || !session.base_url) return null;
  return env.PROBE.getByName(session.base_url);
}

/** The health for `/admin/api/status` (one cheap RPC; null when there is nothing to ask --
 *  no session, or the coordinator did not answer). The coordinator's record travels
 *  verbatim: the console renders its state as the session badges, and nothing else about
 *  the queue is the deployment's business to invent. */
/** `/admin/api/status` 用的健康数据（一次廉价 RPC；无对象可问时返回 null——没有 session，
 *  或协调者没有回应）。协调者的记录原样透出：控制台把其中的状态渲染成 Session 徽标，队列的
 *  其它一切都不是部署层有权凭空补上的东西。 */
async function probeHealthFor(env: Env, session: StoredSession | null): Promise<ProbeHealth | null> {
  // The lookup is inside the try on purpose: a binding that cannot even name the object
  // (no session, a stub namespace in a test, a binding mistake) must degrade to "unknown
  // health", never break the status page.
  //
  // 查找刻意放在 try 内：连对象都指不出来的绑定（没有 session、测试里的占位命名空间、绑定写错）
  // 必须退化为"健康未知"，绝不能让状态页整体失败。
  try {
    const coordinator = probeCoordinatorFor(env, session);
    if (!coordinator) return null;
    return await coordinator.healthView();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "probe health unavailable",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * Tell the coordinator the credentials may be back (a session was imported, or a
 * connectivity check just succeeded) so a suspended queue starts moving again.
 *
 * Best effort on purpose: the operator's own result (a saved session, a green check)
 * must not fail because a Durable Object was busy.
 *
 * 告诉协调者凭证可能回来了（导入了 session，或连通性检测刚刚通过），让挂起的队列重新动起来。
 *
 * 刻意做成尽力而为：运维自己的结果（保存成功、检测通过）绝不能因为 Durable Object 忙而失败。
 */
async function resumeProbesFor(env: Env, session: StoredSession | null): Promise<void> {
  try {
    const coordinator = probeCoordinatorFor(env, session);
    if (!coordinator) return;
    await coordinator.resumeProbes();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "probe resume failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Tell the coordinator the session is gone, so it stops at once and the console can say
 *  why (see noteSessionRemoved). Best effort, same reasoning as above. */
/** 告诉协调者 session 没了，让它立刻停下、并让控制台能说明原因（见 noteSessionRemoved）。
 *  同样尽力而为，理由同上。 */
async function suspendProbesForDeletedSession(env: Env, session: StoredSession | null): Promise<void> {
  try {
    const coordinator = probeCoordinatorFor(env, session);
    if (!coordinator) return;
    await coordinator.noteSessionRemoved();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "probe suspend failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

// --------------------------------------------------------------------------- //
// Router
// 路由
// --------------------------------------------------------------------------- //

// Routes that exist behind the auth gate. Checked BEFORE authentication so an
// unknown path answers 404 ("no such route") instead of 401 ("not logged in") —
// keep this list in sync with the switch below.
//
// 鉴权门后实际存在的路由。在鉴权**之前**检查：未知路径应答 404（"无此路由"），
// 而不是被误报成 401（"未登录"）——本列表需与下方 switch 保持同步。
const AUTHED_ROUTES: readonly string[] = [
  "POST /admin/api/session",
  "DELETE /admin/api/session",
  "POST /admin/api/session/check",
  "GET /admin/api/keys",
  "POST /admin/api/keys",
  "DELETE /admin/api/keys",
  "POST /admin/api/keys/rotate",
  "POST /admin/api/password",
  "POST /admin/api/settings",
  "GET /admin/api/probe",
  "POST /admin/api/probe/settings",
  "POST /admin/api/probe/refresh",
];

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

  // Unknown endpoints: 404 before the auth gate (see AUTHED_ROUTES above). The
  // switch's default below stays as a belt for anyone editing the list out of sync.
  //
  // 未知端点：在鉴权门之前即答 404（见上方 AUTHED_ROUTES）。下方 switch 的 default
  // 保留作为兜底，防止两处列表不同步时漏网。
  if (!AUTHED_ROUTES.includes(`${method} ${path}`)) {
    return json({ ok: false, error: "err.unknown_endpoint" }, 404);
  }

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
    case "GET /admin/api/probe":
      return handleProbeInfo(env);
    case "POST /admin/api/probe/settings":
      return handleProbeSettings(env, request);
    case "POST /admin/api/probe/refresh":
      return handleProbeRefresh(env, request);
    default:
      return json({ ok: false, error: "err.unknown_endpoint" }, 404);
  }
}
