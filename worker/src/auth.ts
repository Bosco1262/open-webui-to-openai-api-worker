/**
 * Authentication: admin console access + client API-key verification.
 *
 * Admin password sources (mirror of M365-Copilot2API-on-Cloudflare-Worker):
 *   1. `ADMIN_PASSWORD` secret (set via `wrangler secret put`) — verified
 *      directly and NEVER written to KV.
 *   2. PBKDF2 password hash in KV, written only by the web console (first-visit
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
const ADMIN_TOKEN_TTL = 7 * 24 * 3600; // 7 days
const ADMIN_COOKIE = "ow2_admin";

// --------------------------------------------------------------------------- //
// Constant-time comparison
// --------------------------------------------------------------------------- //

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a.buffer as ArrayBuffer, b.buffer as ArrayBuffer);
}

/** Hash both sides to a fixed size first, then compare in constant time. */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// --------------------------------------------------------------------------- //
// Password hashing (PBKDF2-SHA256 via WebCrypto)
// --------------------------------------------------------------------------- //

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

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt);
  return {
    salt: bytesToBase64Url(salt),
    hash: bytesToBase64Url(hash),
  };
}

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
// --------------------------------------------------------------------------- //

/**
 * Where the effective admin password currently comes from:
 *   "kv"     – a KV hash exists (set via web setup or a console password
 *              change) and always takes priority over the secret.
 *   "secret" – no KV hash yet and ADMIN_PASSWORD is bound; verified directly,
 *              never written to KV.
 *   "none"   – nothing configured: the console must run first-visit setup.
 */
export async function adminPasswordSource(env: Env): Promise<AdminPasswordSource> {
  if (await getPasswordHash(env)) return "kv";
  if (env.ADMIN_PASSWORD) return "secret";
  return "none";
}

/** Whether an admin password is available (secret or KV). */
export async function adminHasPassword(env: Env): Promise<boolean> {
  return (await adminPasswordSource(env)) !== "none";
}

/** Set the admin password from the web UI (only allowed in "none" mode). */
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
// --------------------------------------------------------------------------- //

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
  if (parsed.ver !== (await getSessionEpoch(env))) return false;
  const secret = await getOrCreateSessionSecret(env);
  const expected = await hmacSign(secret, payload);
  return timingSafeEqualStr(expected, sig);
}

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
export async function isAdminAuthed(env: Env, request: Request): Promise<boolean> {
  const token = readAdminCookie(request);
  if (!token) return false;
  return verifyAdminToken(env, token);
}

// --------------------------------------------------------------------------- //
// Login failure lockout (isolate-local, mirrors M365's localLockout fallback)
// --------------------------------------------------------------------------- //

const LOCAL_LOCKOUT_WINDOW_MS = 15 * 60_000; // 15 min
const LOCAL_LOCKOUT_MAX_FAILURES = 5;
const LOCAL_LOCKOUT_MAX_ENTRIES = 4096;

/** ip -> failure timestamps (ms); isolate-local, no cross-isolate coordination. */
const localLoginFailures = new Map<string, number[]>();

function localLockoutPrune(ip: string): number[] {
  const now = Date.now();
  const list = (localLoginFailures.get(ip) ?? []).filter((ts) => now - ts < LOCAL_LOCKOUT_WINDOW_MS);
  if (list.length === 0) localLoginFailures.delete(ip);
  else localLoginFailures.set(ip, list);
  return list;
}

/** Locked until the 5th failure timestamp + 15 min (matches upstream). */
export function lockoutCheck(ip: string): { locked: boolean; retryAfterSec: number } {
  const list = localLockoutPrune(ip);
  if (list.length < LOCAL_LOCKOUT_MAX_FAILURES) {
    return { locked: false, retryAfterSec: Math.ceil(LOCAL_LOCKOUT_WINDOW_MS / 1000) };
  }
  const lockStart = list[list.length - LOCAL_LOCKOUT_MAX_FAILURES];
  const remaining = Math.max(0, lockStart + LOCAL_LOCKOUT_WINDOW_MS - Date.now());
  return { locked: true, retryAfterSec: Math.ceil(remaining / 1000) };
}

export function lockoutRecord(ip: string): void {
  if (ip === "") return;
  const now = Date.now();
  // Bound the map like upstream: prune expired entries first, then evict the
  // oldest-timestamp entry as a last resort.
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

export function lockoutClear(ip: string): void {
  if (ip === "") return;
  localLoginFailures.delete(ip);
}

/** Best-effort client IP: CF-Connecting-IP first, X-Forwarded-For fallback. */
export function clientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    ""
  );
}

// --------------------------------------------------------------------------- //
// Client API keys (/v1/*)
// --------------------------------------------------------------------------- //

export function extractClientApiKey(request: Request): string {
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return (request.headers.get("X-API-Key") || "").trim();
}

/** Verify a client API key and (throttled) update its last_used timestamp. */
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
