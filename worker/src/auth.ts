/**
 * Authentication: admin console access + client API-key verification.
 *
 * Admin password has two sources, whichever is configured first wins:
 *   1. `ADMIN_PASSWORD` secret (set via `wrangler secret put`).
 *   2. Password hash stored in KV, set from the web UI on first visit.
 *
 * A successful login issues an HMAC-SHA256 signed cookie (`ow2_admin`) with an
 * expiry timestamp; the signing secret is `SESSION_SECRET` or an auto-derived
 * random secret persisted in KV.
 *
 * Client API keys are checked in O(1) by using the key itself as the KV key.
 */

import type { Env, PasswordHash } from "./types";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  getApiKeyMeta,
  getOrCreateSessionSecret,
  getPasswordHash,
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

/** Whether an admin password is available (secret or KV). */
export async function adminHasPassword(env: Env): Promise<boolean> {
  if (env.ADMIN_PASSWORD) return true;
  const stored = await getPasswordHash(env);
  return stored !== null;
}

/** Set the admin password from the web UI (only allowed when no secret is set and none exists in KV). */
export async function adminSetupPassword(env: Env, password: string): Promise<void> {
  if (env.ADMIN_PASSWORD) {
    throw new Error("管理员密码已由部署配置（ADMIN_PASSWORD）提供，无需在网页设置。");
  }
  if (await getPasswordHash(env)) {
    throw new Error("管理员密码已设置。");
  }
  await setPasswordHash(env, await hashPassword(password));
}

export async function adminVerifyPassword(env: Env, password: string): Promise<boolean> {
  if (env.ADMIN_PASSWORD) {
    return timingSafeEqualStr(password, env.ADMIN_PASSWORD);
  }
  const stored = await getPasswordHash(env);
  if (!stored) return false;
  return verifyPassword(password, stored);
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
  const payload = JSON.stringify({ exp: now + ADMIN_TOKEN_TTL, iat: now });
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
  let parsed: { exp?: unknown };
  try {
    parsed = JSON.parse(payload) as { exp?: unknown };
  } catch {
    return false;
  }
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now() / 1000) return false;
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
