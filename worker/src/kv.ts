/**
 * KV data layer.
 * 
 * Everything the Worker persists lives in the single KV namespace. Reads on
 * the hot proxy path are minimized (one API-key lookup per request) and the
 * session is cached in the instance for 60s so management writes don't force
 * repeated KV reads.
 * 
 * KV 数据层。
 *
 * Worker 持久化的所有数据都存放在单一 KV 命名空间中。热代理路径上的读取被
 * 压到最低（每次请求仅 1 次 API Key 查询），session 在实例内缓存 60 秒，
 * 管理端写入不会强制触发重复的 KV 读取。
 */

import type { ApiKeyMeta, Env, PasswordHash, StoredSession } from "./types";

/** KV key constants. */
/** KV 键名常量。 */
const K_SESSION = "session";
const K_API_KEY_PREFIX = "apikey:";
const K_PASSWORD_HASH = "admin:password_hash";
const K_SESSION_SECRET = "admin:session_secret";
const K_SESSION_EPOCH = "admin:session_epoch";
const K_TOUCH_INTERVAL = "settings:touch_interval";

/** Instance-level read cache TTL (ms). */
/** 实例级读缓存 TTL（毫秒）。 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expireAt: number;
}

// Simple per-instance cache: one entry per KV key, with expiry.
// 简单的实例级缓存：每个 KV 键一条记录，带过期时间。
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  // Lazily evict expired entries on read.
  // 读取时惰性清除过期条目。
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
// Base64url 辅助函数
// --------------------------------------------------------------------------- //

// Encode bytes as unpadded base64url (URL-safe alphabet).
// 将字节编码为无填充的 base64url（URL 安全字符集）。
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode a base64url string back to bytes, tolerating missing padding.
// 将 base64url 字符串解码回字节，容忍缺失的填充。
export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Cryptographically secure random bytes (WebCrypto).
// 密码学安全的随机字节（WebCrypto）。
export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

// Random base64url string of n random bytes (n*8 bits of entropy).
// n 个随机字节的 base64url 随机串（n*8 位熵）。
export function randomBase64Url(n: number): string {
  return bytesToBase64Url(randomBytes(n));
}

// --------------------------------------------------------------------------- //
// Session
// 上游会话凭证
// --------------------------------------------------------------------------- //

// Get the stored session, served from the 60s instance cache when possible.
// 读取已存储的 session，优先命中 60 秒实例缓存。
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
// 客户端 API Key
// --------------------------------------------------------------------------- //

// O(1) lookup: the key plaintext is the KV key name.
// O(1) 查询：Key 明文即 KV 键名。
export async function getApiKeyMeta(env: Env, key: string): Promise<ApiKeyMeta | null> {
  return env.KV.get<ApiKeyMeta>(K_API_KEY_PREFIX + key, "json");
}

export async function putApiKey(env: Env, key: string, meta: ApiKeyMeta): Promise<void> {
  await env.KV.put(K_API_KEY_PREFIX + key, JSON.stringify(meta));
}

export async function deleteApiKey(env: Env, key: string): Promise<void> {
  await env.KV.delete(K_API_KEY_PREFIX + key);
}

// List all keys by paginating the KV namespace under the key prefix.
// 按 Key 前缀分页遍历 KV 命名空间，列出全部 Key。
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

/**
 * Throttled asynchronous update of `last_used`, executed within `ctx.waitUntil`.
 *
 * - For a never-used Key (last_used === 0), an immediate write is performed on the first call;
 * - Afterwards, each Key is written at most once per configured granularity (default: daily, adjustable in the management console).
 *
 * The write timestamp takes the greater value between the in-instance record and `last_used` in KV;
 * throttling remains in effect after an isolate restart.
 */
/**
 * 节流的 `last_used` 异步更新，在 `ctx.waitUntil` 内执行。
 *
 * - 从未使用的 Key（last_used === 0）首次调用立即写入一次；
 * - 之后每个 Key 至多按配置粒度写一次（默认每天，可在管理控制台调整）。
 * 写入时间取「实例内记录」与「KV 中 last_used」的较大者，isolate 重启后依然节流。
 */

/** Allowed `last_used` refresh intervals in seconds (daily default). */
/** 允许的 `last_used` 刷新间隔（秒），默认每天。 */
export const TOUCH_INTERVAL_OPTIONS: readonly number[] = [86_400, 21_600, 10_800, 3_600, 1_800, 600];

/** Default `last_used` refresh interval (once per day). */
/** 默认 `last_used` 刷新间隔（每天一次）。 */
export const DEFAULT_TOUCH_INTERVAL = 86_400;

/** Read the configured interval, served from the 60s instance cache. */
/** 读取配置的间隔，优先命中 60 秒实例缓存。 */
export async function getTouchInterval(env: Env): Promise<number> {
  const cached = cacheGet<number>(K_TOUCH_INTERVAL);
  if (cached !== null) return cached;
  const raw = await env.KV.get(K_TOUCH_INTERVAL);
  const n = raw === null ? NaN : Number(raw);
  const value = TOUCH_INTERVAL_OPTIONS.includes(n) ? n : DEFAULT_TOUCH_INTERVAL;
  cacheSet(K_TOUCH_INTERVAL, value);
  return value;
}

/** Persist a new interval; returns false for values outside the allowed set. */
/** 持久化新间隔；不在允许集合内的值返回 false。 */
export async function setTouchInterval(env: Env, seconds: number): Promise<boolean> {
  if (!TOUCH_INTERVAL_OPTIONS.includes(seconds)) return false;
  await env.KV.put(K_TOUCH_INTERVAL, String(seconds));
  cacheSet(K_TOUCH_INTERVAL, seconds);
  return true;
}

const lastTouched = new Map<string, number>();

export async function touchApiKey(env: Env, key: string, meta: ApiKeyMeta): Promise<void> {
  const now = Date.now();
  // A never-used key is recorded immediately on its first call.
  // 从未使用的 Key 在首次调用时立即记录。
  if (!meta.last_used) {
    lastTouched.set(key, now);
    await env.KV.put(K_API_KEY_PREFIX + key, JSON.stringify({ ...meta, last_used: Math.floor(now / 1000) }));
    return;
  }
  const intervalMs = (await getTouchInterval(env)) * 1000;
  // Skip if the key was written within the throttle window; the persisted
  // last_used also counts so a fresh isolate does not rewrite early.
  //
  // 若 Key 在节流窗口内已写入则跳过；持久化的 last_used 同样计入，
  // 避免新 isolate 提前重写。
  const lastWrite = Math.max(lastTouched.get(key) ?? 0, meta.last_used * 1000);
  if (now - lastWrite < intervalMs) return;
  lastTouched.set(key, now);
  // Write off the critical path so the response is not delayed.
  // 写入不阻塞关键路径，避免拖慢响应。
  await env.KV.put(K_API_KEY_PREFIX + key, JSON.stringify({ ...meta, last_used: Math.floor(now / 1000) }));
}

// --------------------------------------------------------------------------- //
// Admin credentials
// 管理员凭证
// --------------------------------------------------------------------------- //

export async function getPasswordHash(env: Env): Promise<PasswordHash | null> {
  return env.KV.get<PasswordHash>(K_PASSWORD_HASH, "json");
}

export async function setPasswordHash(env: Env, ph: PasswordHash): Promise<void> {
  await env.KV.put(K_PASSWORD_HASH, JSON.stringify(ph));
}

/** Auto-derived HMAC secret for admin cookies, cached per instance. */
/** 自动派生的管理 Cookie HMAC 密钥，按实例缓存。 */
let sessionSecretCache: string | null = null;

export async function getOrCreateSessionSecret(env: Env): Promise<string> {
  // An explicitly bound secret always wins.
  // 显式绑定的 Secret 始终优先。
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (sessionSecretCache) return sessionSecretCache;
  let secret = await env.KV.get(K_SESSION_SECRET);
  if (!secret) {
    // Generate once and persist; reused by every isolate afterwards.
    // 只生成一次并持久化，之后所有 isolate 复用。
    secret = randomBase64Url(32);
    await env.KV.put(K_SESSION_SECRET, secret);
  }
  sessionSecretCache = secret;
  return secret;
}

// --------------------------------------------------------------------------- //
// Admin session epoch
// 管理会话纪元（epoch）
// --------------------------------------------------------------------------- //
//
// Read/written directly on every admin-authenticated path (no instance cache):
// bumping the epoch on a password change must invalidate every previously
// issued stateless token immediately, so a stale cached value is unacceptable.
//
// 每条管理鉴权路径都直接读写（不做实例缓存）：修改密码时自增纪元必须立即使
// 所有已签发的无状态令牌失效，因此不能容忍过期的缓存值。

/** Current epoch embedded in admin session tokens (default 0). */
/** 嵌入管理会话令牌的当前纪元（默认 0）。 */
export async function getSessionEpoch(env: Env): Promise<number> {
  const raw = await env.KV.get(K_SESSION_EPOCH);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Increment the epoch, invalidating every previously issued admin session. */
/** 自增纪元，使所有此前签发的管理会话立即失效。 */
export async function bumpSessionEpoch(env: Env): Promise<void> {
  await env.KV.put(K_SESSION_EPOCH, String((await getSessionEpoch(env)) + 1));
}
