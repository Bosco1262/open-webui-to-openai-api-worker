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
 * Client API keys are checked in O(1) by hashing the presented key and reading
 * `apikey:<sha256(key)>` -- the key material itself is never stored, so a KV listing
 * or backup cannot hand out working credentials.
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
 * 客户端 API Key 的校验是 O(1)：对提交的 Key 求哈希后读取 `apikey:<sha256(key)>`
 * ——密钥本身从不存储，因此 KV 列表或备份都无法交出一批可用凭证。
 */

import type { AdminPasswordSource, Env, PasswordHash } from "./types.ts";
import {
  base64UrlToBytes,
  bumpSessionEpoch,
  bytesToBase64Url,
  getOrCreateSessionSecret,
  getPasswordHash,
  getSessionEpoch,
  getSessionSecretReadonly,
  lookupApiKey,
  migrateLegacyApiKey,
  randomBytes,
  setPasswordHash,
} from "./kv.ts";
import { touchApiKey } from "./touch.ts";

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_BITS = 256;
const ADMIN_TOKEN_TTL = 7 * 24 * 3600; // 7 days / 7 天

/**
 * Admin session cookie names.
 *
 * On HTTPS the cookie carries the `__Host-` prefix, which browsers only accept from
 * the exact host (no `Domain`, `Path=/`, `Secure`): a sibling subdomain -- or any
 * response that manages to set a cookie on the parent domain -- cannot shadow or
 * overwrite the admin session any more. Over plain HTTP (local development) the
 * prefix is not allowed by browsers, so the bare name is used there instead.
 *
 * Verification and logout accept BOTH names: sessions issued before this change stay
 * valid until they expire, and logging out clears whichever one the browser holds.
 *
 * 管理会话 Cookie 名。
 *
 * HTTPS 下 Cookie 带 `__Host-` 前缀，浏览器只接受来自精确主机（无 `Domain`、
 * `Path=/`、`Secure`）的同名 Cookie：同级子域——或任何能在父域上写 Cookie 的响应
 * ——再也无法遮蔽或覆盖管理会话。纯 HTTP（本地开发）下浏览器不允许该前缀，因此那里
 * 使用裸名。
 *
 * 校验与登出**同时接受**两个名字：本改动之前签发的会话在过期前依然有效，登出则会
 * 清除浏览器实际持有的那一个。
 */
const ADMIN_COOKIE_BARE = "ow2_admin";
const ADMIN_COOKIE_PREFIXED = `__Host-${ADMIN_COOKIE_BARE}`;

// --------------------------------------------------------------------------- //
// Constant-time comparison
// 常数时间比较
// --------------------------------------------------------------------------- //

/**
 * Byte comparison that never short-circuits.
 *
 * `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension of WebCrypto:
 * the test runner imports these sources directly under Node, whose WebCrypto does
 * not have it, so fall back to a plain loop. Workers always take the native branch.
 *
 * 不会提前返回的逐字节比较。
 *
 * `crypto.subtle.timingSafeEqual` 是 Cloudflare Workers 对 WebCrypto 的扩展：测试
 * 运行器会在 Node 下直接导入这些源码，而 Node 的 WebCrypto 没有它，因此回退为普通
 * 循环。Workers 上始终走原生分支。
 */
function compareBytesConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(a.buffer as ArrayBuffer, b.buffer as ArrayBuffer);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return compareBytesConstantTime(a, b);
}

/** Hash both sides to a fixed size first, then compare in constant time. */
/** 先将两侧哈希到定长，再做常数时间比较。 */
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  return compareBytesConstantTime(new Uint8Array(ha), new Uint8Array(hb));
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
async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt);
  return {
    salt: bytesToBase64Url(salt),
    hash: bytesToBase64Url(hash),
  };
}

// Verify a password against the stored PBKDF2 hash in constant time.
// 对存储的 PBKDF2 哈希做常数时间密码校验。
async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
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

/**
 * Set the admin password from the web UI (only allowed in "none" mode).
 *
 * The write is verified by reading the value back: the check above and the write below
 * are not atomic, so two concurrent setups could both pass -- and then "who owns the
 * console" would be decided by KV's last-write-wins instead of by the operator. A KV
 * read made right after a write in the same location sees that write, so a read-back
 * mismatch means someone else's setup landed in between: that caller is told the
 * console is already set up instead of being handed a session for a password that is
 * not the one in force.
 *
 * 从网页 UI 设置管理密码（仅允许在 "none" 模式下）。
 *
 * 写入后回读校验：上面的检查与下面的写入并非原子，两个并发的设密可能同时通过——随后
 * "谁占有控制台"就由 KV 的后写者胜决定，而不是由运维决定。同一机房内的写入之后立即
 * 读取能看到该写入，因此回读不一致即意味着另一个设密插在中间：该调用方被告知控制台
 * 已完成设密，而不是拿到一个对应"并非生效密码"的会话。
 */
export async function adminSetupPassword(env: Env, password: string): Promise<void> {
  if (env.ADMIN_PASSWORD) {
    throw new Error("err.setup_secret_exists");
  }
  if (await getPasswordHash(env)) {
    throw new Error("err.already_setup");
  }
  const hash = await hashPassword(password);
  await setPasswordHash(env, hash);
  const stored = await getPasswordHash(env);
  if (!stored || stored.hash !== hash.hash || stored.salt !== hash.salt) {
    throw new Error("err.already_setup");
  }
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
  const hash = await hashPassword(nextPassword);
  // Order matters (invalidate FIRST, then replace the secret). The other order had a
  // state that reads as "the change failed" while nothing was revoked: the new hash
  // was already live, the epoch bump had failed, and the operator's retry with the OLD
  // password was rejected with `err.pw_cur_wrong`. This way a failure leaves the old
  // password valid -- a retry just works -- and every session is already gone.
  //
  // PBKDF2 note: 100,000 iterations sit exactly on workerd's platform limit and
  // were VERIFIED live on workerd (wrangler dev): deriveBits completes well within
  // the free-plan CPU budget (setup / login / wrong-password all return cleanly).
  // Do NOT raise this value — the platform rejects iterations above the cap.
  //
  // 顺序很重要（**先失效，再换密**）。反过来会出现一种"报告为失败、实际什么都没吊销"
  // 的状态：新哈希已经生效、纪元自增失败，而运维用**旧**口令重试又会得到
  // `err.pw_cur_wrong`。现在失败时旧口令仍然有效——重试即可——而所有会话已经失效。
  //
  // PBKDF2 说明：100,000 次迭代恰好处于 workerd 的平台限制边界，并已在 workerd 中
  // 实测通过（wrangler dev）：deriveBits 远在免费层 CPU 预算内完成（设密 / 登录 /
  // 错误密码三条路径均正常返回）。**不要调高该值**——平台会拒绝超出上限的迭代数。
  //
  // Known residual limit (unchanged): KV is read/written per location with up to ~60s
  // of convergence, so "all sessions die at once" means "within about a minute", not
  // "instantly everywhere". The README states the same bound.
  //
  // 已知残余限制（未变）：KV 按机房读写、最长约 60 秒收敛，因此"所有会话立即失效"
  // 的准确含义是"约一分钟内全部失效"。README 中给出的是同一个界限。
  try {
    await bumpSessionEpoch(env);
  } catch {
    await bumpSessionEpoch(env);
  }
  await setPasswordHash(env, hash);
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
async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
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
  // Read-only on purpose: verification must not carry write side effects (a
  // missing secret is generated by the setup/login paths, not minted
  // mid-verification — see getSessionSecretReadonly).
  //
  // 刻意只读：校验不得携带写副作用（缺失的 secret 由设密 / 登录路径生成，而不是在
  // 校验中途凭空铸造——见 getSessionSecretReadonly）。
  const secret = await getSessionSecretReadonly(env);
  if (!secret) return false;
  const expected = await hmacSign(secret, payload);
  return timingSafeEqualStr(expected, sig);
}

// Extract the admin session cookie value from the request, if present. Both the
// `__Host-`-prefixed name and the pre-upgrade bare name are accepted; see the cookie
// name constants above.
//
// 从请求中提取管理会话 Cookie 值（若存在）。`__Host-` 前缀名与升级前的裸名都接受；
// 见上方的 Cookie 名常量。
function readAdminCookie(request: Request): string {
  const header = request.headers.get("Cookie") || "";
  const values = new Map<string, string>();
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    values.set(part.slice(0, eqIndex).trim(), part.slice(eqIndex + 1).trim());
  }
  return values.get(ADMIN_COOKIE_PREFIXED) ?? values.get(ADMIN_COOKIE_BARE) ?? "";
}

function cookieAttributes(isHttps: boolean, maxAge: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps ? "; Secure" : ""}`;
}

export function setAdminCookie(token: string, isHttps: boolean): string {
  const name = isHttps ? ADMIN_COOKIE_PREFIXED : ADMIN_COOKIE_BARE;
  return `${name}=${token}; ${cookieAttributes(isHttps, ADMIN_TOKEN_TTL)}`;
}

/**
 * Expire the admin session cookie.
 *
 * BOTH names are cleared: a browser that logged in before this change still holds the
 * bare name, and logging out has to actually end the session.
 *
 * 使管理会话 Cookie 过期。
 *
 * **两个**名字都被清除：在本改动之前登录的浏览器仍持有裸名，而登出必须真的结束会话。
 */
export function clearAdminCookie(isHttps: boolean): string[] {
  const attributes = cookieAttributes(isHttps, 0);
  return [`${ADMIN_COOKIE_PREFIXED}=; ${attributes}`, `${ADMIN_COOKIE_BARE}=; ${attributes}`];
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
    for (const [entryIp] of localLoginFailures) localLockoutPrune(entryIp);
    if (localLoginFailures.size >= LOCAL_LOCKOUT_MAX_ENTRIES) {
      let oldestIp = "";
      let oldestTs = Infinity;
      for (const [entryIp, timestamps] of localLoginFailures) {
        const first = timestamps[0] ?? 0;
        if (first < oldestTs) {
          oldestTs = first;
          oldestIp = entryIp;
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

/**
 * Client IP for the login lockout: `CF-Connecting-IP` ONLY.
 *
 * The old fallback to `X-Forwarded-For` was worse than useless: that header is
 * client-controlled, so it allowed BOTH bypassing the lockout (a fresh value per
 * attempt) and weaponising it (spraying a victim's IP with failures to lock them out).
 * Cloudflare always sets `CF-Connecting-IP` for traffic that reaches the Worker, and a
 * caller cannot forge it; an empty answer simply means "no lockout subject".
 *
 * Additionally: this counter lives in ONE isolate (see below), so edge-location
 * rotation sidesteps it -- a WAF rate limiting rule on `/admin/api/login` is what
 * makes the protection binding, and the README lists it as a deployment requirement.
 *
 * 登录锁定所用的客户端 IP：**只**信任 `CF-Connecting-IP`。
 *
 * 旧的回退到 `X-Forwarded-For` 有害无益：该头由客户端控制，因而既能绕过锁定（每次
 * 尝试换一个值），也能把锁定武器化（用失败请求刷爆受害者的 IP 将其锁死）。Cloudflare
 * 对到达 Worker 的流量总会设置 `CF-Connecting-IP`，且调用方无法伪造；返回空值只意味着
 * "没有可锁定的对象"。
 *
 * 另外：该计数器位于**单个** isolate（见下），因此多机房轮换即可绕过——真正有约束力的
 * 是 `/admin/api/login` 上的 WAF 速率限制规则，README 已把它列为部署必选项。
 */
export function clientIP(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "";
}

// --------------------------------------------------------------------------- //
// Client API keys (/v1/*)
// 客户端 API Key（/v1/*）
// --------------------------------------------------------------------------- //

/**
 * Longest client key this Worker will even look at.
 *
 * Every key it issues is 51 characters (`sk-` + 48); anything far longer is either a
 * mistake or an attempt to make the KV layer choke on an oversized key name (which
 * used to surface as a 500 instead of a plain 401).
 *
 * 本 Worker 愿意查看的客户端 Key 长度上限。
 *
 * 它签发的 Key 都是 51 个字符（`sk-` + 48）；远长于此的要么是误用，要么是想让 KV
 * 层被超长键名噎住（此前这会表现为 500，而不是干净的 401）。
 */
const MAX_CLIENT_KEY_CHARS = 512;

// Read the client key from "Authorization: Bearer <key>" or "X-API-Key: <key>".
// 从 "Authorization: Bearer <key>" 或 "X-API-Key: <key>" 读取客户端 Key。
function extractClientApiKey(request: Request): string {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice("bearer ".length).trim()
    : (request.headers.get("X-API-Key") || "").trim();
  return key.length > MAX_CLIENT_KEY_CHARS ? "" : key;
}

/**
 * Verify a client API key and update its usage record (throttled).
 *
 * The presented key is hashed and looked up as `apikey:<sha256(key)>`; a key stored
 * under the legacy plaintext name still resolves, and is migrated to the hashed name
 * off the critical path.
 *
 * 校验客户端 API Key，并（节流地）更新其使用记录。
 *
 * 提交的 Key 会被哈希后按 `apikey:<sha256(key)>` 查找；仍存放在旧明文键名下的 Key
 * 依然可用，并会在关键路径之外迁移到哈希键名。
 */
export async function verifyClientApiKey(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
): Promise<boolean> {
  const key = extractClientApiKey(request);
  if (!key) return false;
  const entry = await lookupApiKey(env, key);
  if (!entry) return false;
  // Entire throttled write runs off the critical path, and is never allowed to break
  // the request: a failed migration or usage write must not turn a valid key into a
  // 500.
  //
  // 整个节流写入都在关键路径之外执行，且绝不允许影响请求：迁移或使用记录写入失败
  // 不能把一把有效的 Key 变成 500。
  ctx.waitUntil(
    (async () => {
      try {
        if (entry.legacy) await migrateLegacyApiKey(env, entry);
        await touchApiKey(env, entry.id);
      } catch (err) {
        console.error(
          JSON.stringify({
            message: "api key bookkeeping failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    })(),
  );
  return true;
}

// --------------------------------------------------------------------------- //
// Client-key brute-force interlock (/v1/*)
// 客户端 Key 爆破联锁（/v1/*）
// --------------------------------------------------------------------------- //

/**
 * Failed proxy-key attempts per client address, oldest first (upstream's L3).
 *
 * Key verification is already a digest lookup rather than a comparison, but on its
 * own that only says the guess is cheap to REJECT -- nothing bounded how many guesses
 * an address could make. Measured on the upstream project, 30 wrong-key requests were
 * answered in 0.34s with no backoff, no lockout, and the correct key still working
 * immediately afterwards; a public endpoint answers guesses at full request rate.
 *
 * Once one address has produced AUTH_FAILURE_LIMIT failures inside
 * AUTH_FAILURE_WINDOW_MS, further attempts are answered 429 (with Retry-After) until
 * the oldest failure ages out of the window. A valid key clears the address's streak.
 *
 * The numbers are the upstream project's defaults, kept as constants because this
 * Worker has no `vars` and the login lockout above is likewise constant-only, so the
 * two controls read the same way.
 *
 *
 * 逐客户端地址的失败代理 Key 尝试，最早在前（上游的 L3）。
 *
 * Key 校验本就是摘要查找而非比较，但那只说明"猜错"很便宜地被拒绝，完全没有限制某个
 * 地址能猜多少次。上游项目实测：30 次错误 Key 请求在 0.34 秒内被逐一应答，没有退避、
 * 没有锁定，随后正确 Key 立即可用；公网端点等于以全速率应答猜测。
 *
 * 同一地址在 AUTH_FAILURE_WINDOW_MS 内失败达到 AUTH_FAILURE_LIMIT 次后，后续尝试一律
 * 回 429（带 Retry-After），直到最早的失败滑出窗口。有效 Key 会清零该地址的计数。
 *
 * 数值取上游项目的默认值，并保持为常量：本 Worker 没有 `vars`，上面的登录锁定同样
 * 只有常量，两道控制读起来才一致（对应上游 `AUTH_FAILURE_LIMIT=10` / `AUTH_FAILURE_WINDOW=60s`）。
 */
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 10;

/** How many client addresses are remembered at most, so the limiter itself cannot be
 *  turned into a memory sink by a spray from many source addresses (upstream keeps the
 *  same bound). */
/** 最多记忆多少个客户端地址，避免攻击者用海量源地址把限速器本身变成内存池（上游同界限）。 */
const AUTH_FAILURE_MAX_CLIENTS = 4096;

/** ip -> failure timestamps (ms); isolate-local, no cross-isolate coordination.
 *
 *  Unlike the login lockout, the subject here is the caller of `/v1/*`, and an empty
 *  address (no `CF-Connecting-IP`) disables the limiter for that request: every such
 *  caller would otherwise share one bucket and lock each other out.
 *
 *  ip -> 失败时间戳（毫秒）；isolate 本地，不跨 isolate 协调。
 *
 *  与登录锁定不同，这里的对象是 `/v1/*` 的调用方；地址为空（没有 `CF-Connecting-IP`）
 *  时该请求不受限速：否则这些调用方会共用一个桶、互相锁死。 */
const clientAuthFailures = new Map<string, number[]>();

/** Drop timestamps outside the window; remove empty entries. */
/** 清除窗口之外的时间戳；删除空条目。 */
function pruneAuthFailures(ip: string, now: number): number[] {
  const list = (clientAuthFailures.get(ip) ?? []).filter((ts) => now - ts < AUTH_FAILURE_WINDOW_MS);
  if (list.length === 0) clientAuthFailures.delete(ip);
  else clientAuthFailures.set(ip, list);
  return list;
}

/**
 * Record one failed proxy-key attempt.
 *
 * Returns the `Retry-After` seconds the caller must answer 429 with when the address
 * is already at the limit, or null when the caller answers its ordinary 401. The
 * attempt that trips the limit is the one that gets the 429 and is NOT appended --
 * mirroring the upstream project's `_record_auth_failure`, whose call site is what
 * makes a throttled address answer `[401, 401, ..., 429]` rather than `[401, ..., 401]`.
 *
 *
 * 记录一次失败的代理 Key 尝试。
 *
 * 地址已达上限时返回调用方应据以回 429 的 `Retry-After` 秒数；否则返回 null，由调用方
 * 回它常规的 401。触发上限的那一次就是拿到 429 的那一次，且**不**被追记——与上游项目的
 * `_record_auth_failure` 一致；正是这一取舍让被节流的地址给出 `[401, 401, ..., 429]`
 * 而不是 `[401, ..., 401]`。
 */
export function authThrottleRecord(ip: string): number | null {
  if (ip === "") return null;
  const now = Date.now();
  const failures = pruneAuthFailures(ip, now);
  if (failures.length >= AUTH_FAILURE_LIMIT) {
    // The window reopens when the OLDEST failure ages out -- that is the moment the
    // count drops below the limit again. +1s of slack, floor 1s: a Retry-After of 0
    // would invite an immediate retry that is still throttled.
    //
    // 窗口在**最早**那次失败滑出时重新打开——那一刻计数才会重新低于上限。+1 秒余量、
    // 下限 1 秒：Retry-After 为 0 会招来一次立刻重试，而它仍会被节流。
    const retryAfterSec = Math.max(
      1,
      Math.floor((failures[0] + AUTH_FAILURE_WINDOW_MS - now) / 1000) + 1,
    );
    clientAuthFailures.set(ip, failures);
    return retryAfterSec;
  }
  failures.push(now);
  clientAuthFailures.set(ip, failures);
  // Bound the map like upstream: drop the addresses whose newest failure is already
  // outside the window, i.e. the entries that no longer constrain anything.
  //
  // 像上游一样限制容量：丢弃"最新一次失败也已在窗口之外"的地址，即那些已不再起约束作用
  // 的条目。
  if (clientAuthFailures.size > AUTH_FAILURE_MAX_CLIENTS) {
    for (const [entryIp, timestamps] of clientAuthFailures) {
      const newest = timestamps[timestamps.length - 1] ?? 0;
      if (now - newest >= AUTH_FAILURE_WINDOW_MS) clientAuthFailures.delete(entryIp);
    }
  }
  return null;
}

/** A valid key clears the address's failure streak. */
/** 有效 Key 会清零该地址的失败计数。 */
export function authThrottleClear(ip: string): void {
  if (ip === "") return;
  clientAuthFailures.delete(ip);
}
