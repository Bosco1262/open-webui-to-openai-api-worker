/**
 * Authentication: admin console access + client API-key verification.
 *
 * Admin password sources (mirror of M365-Copilot2API-on-Cloudflare-Worker):
 * 1. `ADMIN_PASSWORD` secret (set via `wrangler secret put`) — verified
 *      directly and NEVER written to KV.
 * 2. PBKDF2 password hash in KV, written only by the web console (first-visit
 *      setup, or the "change password" flow).
 * A KV hash, once it exists, always wins over the secret binding.
 * 
 * A successful login issues an HMAC-SHA256 signed cookie (`ow2_admin`) with an
 * expiry timestamp; the signing secret is `SESSION_SECRET` or an auto-derived
 * random secret persisted in KV. The token also carries the current admin
 * session epoch (`admin:session_epoch`), which is bumped on every password
 * change so all previously issued sessions die at once.
 * 
 * Client API keys are checked in O(1) by using the key itself as the KV key.
 * 
 * 鉴权：管理后台访问 + 客户端 API Key 校验。
 * 管理密码来源（与 M365-Copilot2API-on-Cloudflare-Worker 对齐）：
 *   1. `ADMIN_PASSWORD` Secret（通过 `wrangler secret put` 设置）—— 直接验证，
 *      绝不写入 KV。
 *   2. 存于 KV 的 PBKDF2 密码哈希，仅由网页控制台写入（首次访问设密或
 *      「修改密码」流程）。
 * KV 哈希一旦存在，始终优先于 Secret 绑定。
 *
 * 登录成功后签发带过期时间戳的 HMAC-SHA256 签名 Cookie（`ow2_admin`）；
 * 签名密钥为 `SESSION_SECRET` 或自动派生并持久化到 KV 的随机密钥。令牌还
 * 携带当前管理会话纪元（`admin:session_epoch`），每次修改密码时纪元自增，
 * 所有此前签发的会话随之立即失效。
 *
 * 客户端 API Key 以 Key 明文作为 KV 键名，实现 O(1) 校验。
 */

import type { AdminPasswordSource, Env, PasswordHash } from "./types";
import {
  base64UrlToBytes,
  bumpSessionEpoch,
  bytesToBase64Url,
  getApiKeyMeta,
  getOrCreateSessionSecret,
  getPasswordHash,
  getSessionEpoch,
  randomBytes,
  setPasswordHash,
  touchApiKey,
} from "./kv";

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_BITS = 256;
const ADMIN_TOKEN_TTL = 7 * 24 * 3600; // 7 days / 7 天
const ADMIN_COOKIE = "ow2_admin";

// --------------------------------------------------------------------------- //
// Constant-time comparison
// 常数时间比较
// --------------------------------------------------------------------------- //

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a.buffer as ArrayBuffer, b.buffer as ArrayBuffer);
}

/** Hash both sides to a fixed size first, then compare in constant time. */
/** 先将两侧哈希到定长，再做常数时间比较。 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// --------------------------------------------------------------------------- //
// Password hashing (PBKDF2-SHA256 via WebCrypto)
// 密码哈希（WebCrypto 的 PBKDF2-SHA256）
// --------------------------------------------------------------------------- //

// Derive a PBKDF2-SHA256 bit string from the password and salt.
// 由密码与盐派生 PBKDF2-SHA256 位串。
async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    PBKDF2_BITS,
  );
  return new Uint8Array(bits);
}

// Hash a password with a fresh random salt (returned base64url-encoded).
// 用新随机盐对密码做哈希（返回 base64url 编码的盐与哈希）。
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt);
  return {
    salt: bytesToBase64Url(salt),
    hash: bytesToBase64Url(hash),
  };
}

// Verify a password against the stored PBKDF2 hash in constant time.
// 对存储的 PBKDF2 哈希做常数时间密码校验。
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  try {
    const salt = base64UrlToBytes(stored.salt);
    const expected = base64UrlToBytes(stored.hash);
    const actual = await pbkdf2(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Admin password modes
// 管理密码模式
// --------------------------------------------------------------------------- //

/**
 * Where the effective admin password currently comes from:
 *   "kv"     – a KV hash exists (set via web setup or a console password
 *              change) and always takes priority over the secret.
 *   "secret" – no KV hash yet and ADMIN_PASSWORD is bound; verified directly,
 *              never written to KV.
 *   "none"   – nothing configured: the console must run first-visit setup.
 * 
 * 当前生效的管理密码来源：
 *   "kv"     – 存在 KV 哈希（网页设密或控制台改密写入），始终优先于 Secret。
 *   "secret" – 尚无 KV 哈希且已绑定 ADMIN_PASSWORD；直接验证，不写入 KV。
 *   "none"   – 完全未配置：控制台必须先完成首次设密。
 */
export async function adminPasswordSource(env: Env): Promise<AdminPasswordSource> {
  if (await getPasswordHash(env)) return "kv";
  if (env.ADMIN_PASSWORD) return "secret";
  return "none";
}

/** Whether an admin password is available (secret or KV). */
/** 是否已有可用的管理密码（Secret 或 KV）。 */
export async function adminHasPassword(env: Env): Promise<boolean> {
  return (await adminPasswordSource(env)) !== "none";
}

/** Set the admin password from the web UI (only allowed in "none" mode). */
/** 从网页 UI 设置管理密码（仅允许在 "none" 模式下）。 */
export async function adminSetupPassword(env: Env, password: string): Promise<void> {
  if (env.ADMIN_PASSWORD) {
    throw new Error("err.setup_secret_exists");
  }
  if (await getPasswordHash(env)) {
    throw new Error("err.already_setup");
  }
  await setPasswordHash(env, await hashPassword(password));
}

/**
 * Verify a candidate password.
 *
 * Priority mirrors M365: a KV hash (web setup / console change) always wins
 * over the ADMIN_PASSWORD secret; the secret is only a fallback while no KV
 * hash exists. Verification never writes to KV.
 * 
 * 校验候选密码。
 * 
 * 优先级与 M365 对齐：KV 哈希（网页设密 / 控制台改密）始终优先于
 * ADMIN_PASSWORD Secret；Secret 仅在尚无 KV 哈希时作为回退。校验绝不写 KV。
 */
export async function adminVerifyPassword(env: Env, password: string): Promise<boolean> {
  const stored = await getPasswordHash(env);
  if (stored) return verifyPassword(password, stored);
  if (env.ADMIN_PASSWORD) return timingSafeEqualStr(password, env.ADMIN_PASSWORD);
  return false;
}

/**
 * Change the admin password from the console. Requires the current password,
 * persists the new PBKDF2 hash in KV and bumps the session epoch so every
 * previously issued admin session is invalidated. Works regardless of whether
 * the current source is the secret or a KV hash; once written, the new KV hash
 * overrides the ADMIN_PASSWORD secret.
 * 
 * 从控制台修改管理密码。需要提供当前密码，将新的 PBKDF2 哈希写入 KV，并
 * 自增会话纪元使所有此前签发的管理会话失效。无论当前来源是 Secret 还是
 * KV 哈希均可执行；写入后新的 KV 哈希将覆盖 ADMIN_PASSWORD Secret。
 */
export async function adminChangePassword(
  env: Env,
  currentPassword: string,
  nextPassword: string,
): Promise<void> {
  const ok = await adminVerifyPassword(env, currentPassword);
  if (!ok) throw new Error("err.pw_cur_wrong");
  if (nextPassword.length < 8) throw new Error("err.pw_new_short");
  if (nextPassword === currentPassword) throw new Error("err.pw_new_same");
  await setPasswordHash(env, await hashPassword(nextPassword));
  await bumpSessionEpoch(env);
}

// --------------------------------------------------------------------------- //
// Admin session cookie
// 管理会话 Cookie
// --------------------------------------------------------------------------- //

// HMAC-SHA256 sign a message with the given secret (base64url output).
// 用给定密钥对消息做 HMAC-SHA256 签名（base64url 输出）。
async function hmacSign(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

// Mint a signed admin session token: base64url(payload).base64url(hmac).
// 签发管理会话令牌：base64url(负载).base64url(HMAC 签名)。
export async function createAdminToken(env: Env): Promise<string> {
  const secret = await getOrCreateSessionSecret(env);
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    exp: now + ADMIN_TOKEN_TTL,
    iat: now,
    ver: await getSessionEpoch(env),
  });
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(payload));
  const sig = await hmacSign(secret, payload);
  return `${payloadB64}.${sig}`;
}

// Verify signature, expiry and epoch of an admin session token.
// 校验管理会话令牌的签名、过期时间与纪元。
export async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try {
    payload = new TextDecoder().decode(base64UrlToBytes(payloadB64));
  } catch {
    return false;
  }
  let parsed: { exp?: unknown; ver?: unknown };
  try {
    parsed = JSON.parse(payload) as { exp?: unknown; ver?: unknown };
  } catch {
    return false;
  }
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now() / 1000) return false;
  // Tokens minted before an epoch bump (or before this feature existed) are stale.
  // 纪元自增前（或该特性存在前）签发的令牌视为过期。
  if (parsed.ver !== (await getSessionEpoch(env))) return false;
  const secret = await getOrCreateSessionSecret(env);
  const expected = await hmacSign(secret, payload);
  return timingSafeEqualStr(expected, sig);
}

// Extract the admin session cookie value from the request, if present.
// 从请求中提取管理会话 Cookie 值（若存在）。
export function readAdminCookie(request: Request): string {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === ADMIN_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return "";
}

export function setAdminCookie(token: string, isHttps: boolean): string {
  const secure = isHttps ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_TOKEN_TTL}${secure}`;
}

export function clearAdminCookie(isHttps: boolean): string {
  const secure = isHttps ? "; Secure" : "";
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/** Whether the request carries a valid admin session cookie. */
/** 请求是否携带有效的管理会话 Cookie。 */
export async function isAdminAuthed(env: Env, request: Request): Promise<boolean> {
  const token = readAdminCookie(request);
  if (!token) return false;
  return verifyAdminToken(env, token);
}

// --------------------------------------------------------------------------- //
// Login failure lockout (isolate-local, mirrors M365's localLockout fallback)
// 登录失败锁定（isolate 本地实现，与 M365 的 localLockout 回退一致）
// --------------------------------------------------------------------------- //

const LOCAL_LOCKOUT_WINDOW_MS = 15 * 60_000; // 15 min / 15 分钟
const LOCAL_LOCKOUT_MAX_FAILURES = 5;
const LOCAL_LOCKOUT_MAX_ENTRIES = 4096;

/** ip -> failure timestamps (ms); isolate-local, no cross-isolate coordination. */
/** IP -> 失败时间戳（毫秒）；isolate 本地，不跨 isolate 协调。 */
const localLoginFailures = new Map<string, number[]>();

// Drop timestamps outside the lockout window; remove empty entries.
// 清除锁定窗口之外的时间戳；删除空条目。
function localLockoutPrune(ip: string): number[] {
  const now = Date.now();
  const list = (localLoginFailures.get(ip) ?? []).filter((ts) => now - ts < LOCAL_LOCKOUT_WINDOW_MS);
  if (list.length === 0) localLoginFailures.delete(ip);
  else localLoginFailures.set(ip, list);
  return list;
}

/** Locked until the 5th failure timestamp + 15 min (matches upstream). */
/** 锁定至第 5 次失败时间戳 + 15 分钟（与上游行为一致）。 */
export function lockoutCheck(ip: string): { locked: boolean; retryAfterSec: number } {
  const list = localLockoutPrune(ip);
  if (list.length < LOCAL_LOCKOUT_MAX_FAILURES) {
    return { locked: false, retryAfterSec: Math.ceil(LOCAL_LOCKOUT_WINDOW_MS / 1000) };
  }
  const lockStart = list[list.length - LOCAL_LOCKOUT_MAX_FAILURES];
  const remaining = Math.max(0, lockStart + LOCAL_LOCKOUT_WINDOW_MS - Date.now());
  return { locked: true, retryAfterSec: Math.ceil(remaining / 1000) };
}

// Record a login failure for the IP, bounding the map size like upstream.
// 记录该 IP 的一次登录失败，并像上游一样限制 Map 容量。
export function lockoutRecord(ip: string): void {
  if (ip === "") return;
  const now = Date.now();
  // Bound the map like upstream: prune expired entries first, then evict the
  // oldest-timestamp entry as a last resort.
  //
  // 像上游一样限制容量：先清理过期条目，仍超限再逐出最早时间戳的条目。
  if (localLoginFailures.size >= LOCAL_LOCKOUT_MAX_ENTRIES && !localLoginFailures.has(ip)) {
    for (const [k] of localLoginFailures) localLockoutPrune(k);
    if (localLoginFailures.size >= LOCAL_LOCKOUT_MAX_ENTRIES) {
      let oldestIp = "";
      let oldestTs = Infinity;
      for (const [k, list] of localLoginFailures) {
        const first = list[0] ?? 0;
        if (first < oldestTs) {
          oldestTs = first;
          oldestIp = k;
        }
      }
      if (oldestIp !== "") localLoginFailures.delete(oldestIp);
    }
  }
  const list = localLockoutPrune(ip);
  list.push(now);
  localLoginFailures.set(ip, list);
}

// Clear the failure history of an IP after a successful login.
// 登录成功后清除该 IP 的失败记录。
export function lockoutClear(ip: string): void {
  if (ip === "") return;
  localLoginFailures.delete(ip);
}

/** Best-effort client IP: CF-Connecting-IP first, X-Forwarded-For fallback. */
/** 尽力获取客户端 IP：优先 CF-Connecting-IP，回退 X-Forwarded-For。 */
export function clientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    ""
  );
}

// --------------------------------------------------------------------------- //
// Client API keys (/v1/*)
// 客户端 API Key（/v1/*）
// --------------------------------------------------------------------------- //

// Read the client key from "Authorization: Bearer <key>" or "X-API-Key: <key>".
// 从 "Authorization: Bearer <key>" 或 "X-API-Key: <key>" 读取客户端 Key。
export function extractClientApiKey(request: Request): string {
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return (request.headers.get("X-API-Key") || "").trim();
}

/** Verify a client API key and (throttled) update its last_used timestamp. */
/** 校验客户端 API Key，并（节流地）更新其 last_used 时间戳。 */
export async function verifyClientApiKey(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<boolean> {
  const key = extractClientApiKey(request);
  if (!key) return false;
  const meta = await getApiKeyMeta(env, key);
  if (!meta) return false;
  touchApiKey(env, key, meta, ctx);
  return true;
}
