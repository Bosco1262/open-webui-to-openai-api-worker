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
import { PREFIX_CANDIDATES, confirmUpstreamPrefix } from "./upstream.ts";
import {
  parseProbeSettingsInput,
  readProbeSettings,
  writeProbeSettings,
} from "./probeSettings.ts";
import { RoundUnavailable } from "./probeRuntime.ts";
import type { ModelProbeCoordinator, ProbeCoordinatorView } from "./probeCoordinator.ts";
import { getTouchInterval, setTouchInterval } from "./touch.ts";
import { INTERVAL_OPTIONS } from "./intervals.ts";
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
} from "./kv.ts";

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
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
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
  // Reject names already used by an existing key (case-insensitive). `name` is
  // whatever KV returned, so it is coerced first: a hand-edited or foreign entry with a
  // numeric name would otherwise throw a TypeError here and the operator could not
  // create ANY key.
  //
  // 拒绝与已有 Key 重名的名称（不区分大小写）。`name` 是 KV 返回的任意值，因此先做
  // 强制转换：否则一条手改的或外来的、name 为数字的条目会在这里抛 TypeError，运维就
  // 一个 Key 都建不了了。
  const existing = await listApiKeys(env);
  if (existing.some(({ meta }) => String(meta.name ?? "").toLowerCase() === name.toLowerCase())) {
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
// Model probe
// 模型探测
// --------------------------------------------------------------------------- //

// GET /admin/api/probe — settings plus the per-model probe results.
// GET /admin/api/probe —— 设置与逐模型探测结果。
async function handleProbeInfo(env: Env): Promise<Response> {
  const settings = await readProbeSettings(env, { useCache: false });
  const coordinator = probeCoordinatorFor(env, await getSession(env));
  let view: ProbeCoordinatorView = { models: [], cached: 0, now: Date.now() / 1000 };
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
    models: view.models,
    cached: view.cached,
    now: view.now,
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
    const stats = requested ? await coordinator.probeOne(requested) : await coordinator.refresh(true);
    // `authExpired` is echoed at the top level for the console: the banner switches to
    // the "credentials expired, re-import the session" wording on it. Without this the
    // round stops on the first 401/403 yet the console still announced a green
    // "probe finished" summary.
    //
    // `authExpired` 在最外层回传给控制台：横幅据此切换为"凭证已过期，请重新导入
    // session"的措辞。没有它的话，整轮明明在首个 401/403 上中止，控制台却仍会宣布
    // 一条绿色的"探测完成"。
    return json({ ok: true, model: requested, stats, authExpired: stats.authExpired === true });
  } catch (err) {
    const roundCode = roundUnavailableCode(err);
    if (roundCode) {
      return fail(
        roundCode === "session_missing" ? "err.probe_session_missing" : "err.probe_models_failed",
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
function roundUnavailableCode(err: unknown): "session_missing" | "models_failed" | null {
  if (err instanceof RoundUnavailable) return err.code;
  if (err instanceof Error && err.name === "RoundUnavailable") {
    return err.message.includes("session_missing") ? "session_missing" : "models_failed";
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
