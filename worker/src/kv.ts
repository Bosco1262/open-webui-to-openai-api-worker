/**
 * KV data layer.
 *
 * Everything the Worker persists lives in the single KV namespace. Reads on
 * the hot proxy path are minimized (one API-key lookup per request) and the
 * session is cached in the instance for 60s so management writes don't force
 * repeated KV reads.
 */

import type { ApiKeyMeta, Env, PasswordHash, StoredSession } from "./types";

/** KV key constants. */
const K_SESSION = "session";
const K_API_KEY_PREFIX = "apikey:";
const K_PASSWORD_HASH = "admin:password_hash";
const K_SESSION_SECRET = "admin:session_secret";
const K_SESSION_EPOCH = "admin:session_epoch";

/** Instance-level read cache TTL (ms). */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expireAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}

function cacheDelete(key: string): void {
  cache.delete(key);
}

// --------------------------------------------------------------------------- //
// Base64url helpers
// --------------------------------------------------------------------------- //

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomBase64Url(n: number): string {
  return bytesToBase64Url(randomBytes(n));
}

// --------------------------------------------------------------------------- //
// Session
// --------------------------------------------------------------------------- //

export async function getSession(env: Env): Promise<StoredSession | null> {
  const cached = cacheGet<StoredSession>(K_SESSION);
  if (cached) return cached;
  const raw = await env.KV.get<StoredSession>(K_SESSION, "json");
  if (!raw) return null;
  cacheSet(K_SESSION, raw);
  return raw;
}

export async function setSession(env: Env, session: StoredSession): Promise<void> {
  await env.KV.put(K_SESSION, JSON.stringify(session));
  cacheSet(K_SESSION, session);
}

export async function deleteSession(env: Env): Promise<void> {
  await env.KV.delete(K_SESSION);
  cacheDelete(K_SESSION);
}

// --------------------------------------------------------------------------- //
// Client API keys
// --------------------------------------------------------------------------- //

export async function getApiKeyMeta(env: Env, key: string): Promise<ApiKeyMeta | null> {
  return env.KV.get<ApiKeyMeta>(K_API_KEY_PREFIX + key, "json");
}

export async function putApiKey(env: Env, key: string, meta: ApiKeyMeta): Promise<void> {
  await env.KV.put(K_API_KEY_PREFIX + key, JSON.stringify(meta));
}

export async function deleteApiKey(env: Env, key: string): Promise<void> {
  await env.KV.delete(K_API_KEY_PREFIX + key);
}

export async function listApiKeys(
  env: Env,
): Promise<Array<{ key: string; meta: ApiKeyMeta }>> {
  const out: Array<{ key: string; meta: ApiKeyMeta }> = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: K_API_KEY_PREFIX, cursor });
    for (const item of page.keys) {
      const meta = await env.KV.get<ApiKeyMeta>(item.name, "json");
      if (meta) out.push({ key: item.name.slice(K_API_KEY_PREFIX.length), meta });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Throttled async `last_used` update (once per 10 min per key, via waitUntil). */
const lastTouched = new Map<string, number>();
const TOUCH_INTERVAL_MS = 10 * 60_000;

export function touchApiKey(
  env: Env,
  key: string,
  meta: ApiKeyMeta,
  ctx: ExecutionContext,
): void {
  const now = Date.now();
  if (now - (lastTouched.get(key) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouched.set(key, now);
  const updated: ApiKeyMeta = { ...meta, last_used: Math.floor(now / 1000) };
  ctx.waitUntil(env.KV.put(K_API_KEY_PREFIX + key, JSON.stringify(updated)));
}

// --------------------------------------------------------------------------- //
// Admin credentials
// --------------------------------------------------------------------------- //

export async function getPasswordHash(env: Env): Promise<PasswordHash | null> {
  return env.KV.get<PasswordHash>(K_PASSWORD_HASH, "json");
}

export async function setPasswordHash(env: Env, ph: PasswordHash): Promise<void> {
  await env.KV.put(K_PASSWORD_HASH, JSON.stringify(ph));
}

/** Auto-derived HMAC secret for admin cookies, cached per instance. */
let sessionSecretCache: string | null = null;

export async function getOrCreateSessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (sessionSecretCache) return sessionSecretCache;
  let secret = await env.KV.get(K_SESSION_SECRET);
  if (!secret) {
    secret = randomBase64Url(32);
    await env.KV.put(K_SESSION_SECRET, secret);
  }
  sessionSecretCache = secret;
  return secret;
}

// --------------------------------------------------------------------------- //
// Admin session epoch
// --------------------------------------------------------------------------- //
//
// Read/written directly on every admin-authenticated path (no instance cache):
// bumping the epoch on a password change must invalidate every previously
// issued stateless token immediately, so a stale cached value is unacceptable.

/** Current epoch embedded in admin session tokens (default 0). */
export async function getSessionEpoch(env: Env): Promise<number> {
  const raw = await env.KV.get(K_SESSION_EPOCH);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Increment the epoch, invalidating every previously issued admin session. */
export async function bumpSessionEpoch(env: Env): Promise<void> {
  await env.KV.put(K_SESSION_EPOCH, String((await getSessionEpoch(env)) + 1));
}
