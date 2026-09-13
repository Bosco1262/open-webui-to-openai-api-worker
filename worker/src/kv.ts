/**
 * KV data layer: generic persistence primitives.
 *
 * Everything the Worker persists lives in the single KV namespace. Reads on
 * the hot proxy path are minimized (one API-key lookup per request) and the
 * session is cached in the instance for 60s so management writes don't force
 * repeated KV reads. Feature-specific storage lives beside it: the `last_used`
 * write throttle in touch.ts, the model-probe settings in probeSettings.ts, and the
 * probe facts themselves in the Durable Object (probeStore.ts). The first two reuse
 * the instance-cache primitives exported here.
 *
 * KV 数据层：通用持久化原语。
 *
 * Worker 持久化的所有数据都存放在单一 KV 命名空间中。热代理路径上的读取被
 * 压到最低（每次请求仅 1 次 API Key 查询），session 在实例内缓存 60 秒，
 * 管理端写入不会强制触发重复的 KV 读取。各功能的存储逻辑分布在旁边：
 * `last_used` 写入节流在 touch.ts，模型探测设置在 probeSettings.ts，而探测事实本身
 * 存放在 Durable Object 里（probeStore.ts）。前两者复用此处导出的实例缓存原语。
 */

import type { ApiKeyMeta, Env, PasswordHash, StoredSession } from "./types.ts";

/** KV key constants. */
/** KV 键名常量。 */
const K_SESSION = "session";
const K_API_KEY_PREFIX = "apikey:";
const K_PASSWORD_HASH = "admin:password_hash";
const K_SESSION_SECRET = "admin:session_secret";
const K_SESSION_EPOCH = "admin:session_epoch";

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

/** Instance-cache read primitive, shared by the feature modules. */
/** 实例缓存读取原语，供各功能模块共用。 */
export function cacheGet<T>(key: string): T | null {
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

/** Instance-cache write primitive, shared by the feature modules. */
/** 实例缓存写入原语，供各功能模块共用。 */
export function cacheSet(key: string, value: unknown): void {
  cache.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}

function cacheDelete(key: string): void {
  cache.delete(key);
}

/** KV key for a client API key (the plaintext is the key name, O(1) lookup). */
/** 客户端 API Key 的 KV 键名（Key 明文即键名，O(1) 查询）。 */
export function apiKeyKVKey(key: string): string {
  return K_API_KEY_PREFIX + key;
}

/**
 * Read a JSON value from KV, treating anything unparseable as absent.
 *
 * `KV.get(key, "json")` does NOT mean "parse this as JSON and swallow the error":
 * Cloudflare throws on malformed JSON, so a hand-edited, truncated or foreign value
 * used to take the whole request down with it (an unparseable `session` made every
 * `/v1/*` request fail, and it was not even repairable from the console). Every read
 * of a value this Worker parses therefore goes through here.
 *
 * The value is fetched as TEXT and parsed locally, deliberately: catching the error
 * from `type: "json"` instead would also swallow a genuine KV outage (an unreachable
 * namespace would look exactly like "this key does not exist"), which would report a
 * transport failure as "invalid API key" or "no session imported". Only a value we
 * cannot parse degrades here; a failing read still propagates.
 *
 * 读取 KV 中的 JSON 值，任何解析不了的内容都按"不存在"处理。
 *
 * `KV.get(key, "json")` **不是**"解析成 JSON 并吞掉错误"：Cloudflare 在 JSON 损坏时会
 * 抛出，因此一条被手改过、被截断或来自外部的值会把整个请求一起带走（一个解析不了的
 * `session` 会让每个 `/v1/*` 请求都失败，而且从控制台都修不回来）。因此本 Worker 凡是
 * 要解析的读取都走这里。
 *
 * 刻意按**文本**读取后在本地解析：若改为吞掉 `type: "json"` 的报错，就会连真正的 KV
 * 故障一起吞掉（一个读不到的命名空间会和"这个键不存在"长得一模一样），从而把传输层故障
 * 报成"API Key 无效"或"尚未导入 session"。这里只有"解析不了"才退化为不存在；读取失败
 * 依然向上抛出。
 */
export async function readKvJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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
function randomBase64Url(n: number): string {
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
  const raw = await readKvJson<StoredSession>(env.KV, K_SESSION);
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
  return readKvJson<ApiKeyMeta>(env.KV, apiKeyKVKey(key));
}

export async function putApiKey(env: Env, key: string, meta: ApiKeyMeta): Promise<void> {
  await env.KV.put(apiKeyKVKey(key), JSON.stringify(meta));
}

export async function deleteApiKey(env: Env, key: string): Promise<void> {
  await env.KV.delete(apiKeyKVKey(key));
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
      const meta = await readKvJson<ApiKeyMeta>(env.KV, item.name);
      if (meta) out.push({ key: item.name.slice(K_API_KEY_PREFIX.length), meta });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// The `last_used` write throttle (getTouchInterval / setTouchInterval /
// touchApiKey) lives in touch.ts: it is feature logic reusing the instance
// cache and the shared granularity steps from intervals.ts.
//
// `last_used` 写入节流（getTouchInterval / setTouchInterval / touchApiKey）
// 位于 touch.ts：属于复用实例缓存与 intervals.ts 共享档位的功能逻辑。

// --------------------------------------------------------------------------- //
// Admin credentials
// 管理员凭证
// --------------------------------------------------------------------------- //

export async function getPasswordHash(env: Env): Promise<PasswordHash | null> {
  return readKvJson<PasswordHash>(env.KV, K_PASSWORD_HASH);
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
    const generated = randomBase64Url(32);
    await env.KV.put(K_SESSION_SECRET, generated);
    // Two isolates can reach the "no secret" branch in the same instant, and KV is
    // last-write-wins: re-read and adopt the actual winner, or tokens signed with
    // our value would fail verification on the next read -- an admin signed out for
    // no visible reason.
    //
    // 两个 isolate 可能在同一瞬间走进"无 secret"分支，而 KV 是后写者胜：回读并采用
    // 真正生效的那个值，否则用我们这份签发的令牌在下一次读取时就会验签失败——管理员
    // 会莫名其妙地掉线。
    secret = (await env.KV.get(K_SESSION_SECRET)) || generated;
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
  const epoch = raw === null ? NaN : Number(raw);
  return Number.isFinite(epoch) && epoch >= 0 ? Math.floor(epoch) : 0;
}

/**
 * Increment the epoch, invalidating every previously issued admin session.
 *
 * Known limitation: the read-modify-write is not atomic, so two password changes
 * landing in the same instant can lose one increment. The consequence is bounded
 * -- a handful of pre-change tokens stay valid for their remaining TTL -- and an
 * atomic counter would put a Durable Object on the path of every epoch read,
 * a cost this low-frequency operation does not justify.
 *
 * 自增纪元，使所有此前签发的管理会话立即失效。
 *
 * 已知限制：读改写不是原子的，同一瞬间落下的两次改密可能丢失一次自增。后果有限
 * ——少数改密前的令牌在其剩余 TTL 内仍有效——而原子计数器会在每条纪元读取路径上
 * 引入 Durable Object，对这个低频操作不值得。
 */
export async function bumpSessionEpoch(env: Env): Promise<void> {
  await env.KV.put(K_SESSION_EPOCH, String((await getSessionEpoch(env)) + 1));
}
