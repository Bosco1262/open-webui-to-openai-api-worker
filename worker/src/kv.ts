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
/** Usage records live under their own namespace so a `last_used` write can never
 *  touch (and therefore never restore) a credential record -- see touch.ts. */
/** 使用记录位于独立命名空间，因此 `last_used` 的写入永远不会碰到（从而不会复活）
 *  凭据记录——见 touch.ts。 */
const K_USAGE_PREFIX = "usage:";
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

/**
 * Look up a JSON-shaped record by its KV key, degrading anything unexpected to
 * "absent" (see readKvJson). Used for values whose shape must be validated before
 * they are trusted.
 *
 * 按键名读取形状为 JSON 的记录，任何意外内容都退化为"不存在"（见 readKvJson）。
 * 用于"信任之前必须先校验形状"的值。
 */
async function readKvRecord(kv: KVNamespace, key: string): Promise<Record<string, unknown> | null> {
  const raw = await readKvJson<unknown>(kv, key);
  return isPlainRecord(raw) ? raw : null;
}

/** A plain (non-array, non-null) object. */
/** 普通对象（非数组、非 null）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
//
// The key material itself is NEVER stored: the KV name is `apikey:<sha256(key)>` and
// the value carries display metadata only. Verification stays O(1) (one hash + one
// read), and -- this is the point -- listing the namespace, opening the dashboard or
// restoring a backup no longer hands out working credentials. Previously the
// plaintext key WAS the KV name, so "the full key is shown only once at creation"
// (README) was simply untrue: anyone with the KV namespace could read every key back.
//
// 密钥本身**绝不存储**：KV 键名是 `apikey:<sha256(key)>`，值里只有展示用元数据。
// 校验依然是 O(1)（一次哈希 + 一次读取）；而关键在于：遍历命名空间、打开 Dashboard
// 或恢复备份，都不再等于交出一批可用凭证。此前明文本身即键名，于是"完整 Key 只在创建
// 时显示一次"（README）根本不成立——拿到 KV 命名空间的任何人都能把每一把 Key 读回来。

/** One API key as stored: its public id, its metadata, and where it lives. */
/** 存储中的一把 API Key：公开 id、元数据，以及它当前所在的键名。 */
export interface ApiKeyEntry {
  /** Stable, non-secret identifier: the hex SHA-256 of the key. */
  /** 稳定且非机密的标识：Key 的十六进制 SHA-256。 */
  id: string;
  meta: ApiKeyMeta;
  /** The KV name this entry currently lives under. */
  /** 该条目当前所在的 KV 键名。 */
  kvName: string;
  /** True while the entry still sits under its pre-hashing plaintext name. */
  /** 条目仍位于哈希之前的明文键名下时为 true。 */
  legacy: boolean;
}

const API_KEY_ID_RE = /^[0-9a-f]{64}$/;

/** The public id of a client key. Stable, and useless without the key itself. */
/** 客户端 Key 的公开 id。稳定，且脱离 Key 本身毫无用处。 */
export async function apiKeyId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function apiKeyKVName(id: string): string {
  return K_API_KEY_PREFIX + id;
}

/** The pre-hashing name of a legacy entry: the plaintext key was the KV name. */
/** 旧条目的哈希之前键名：明文 Key 即 KV 键名。 */
function legacyApiKeyKVName(key: string): string {
  return K_API_KEY_PREFIX + key;
}

/** KV name of a key's usage record (see touch.ts). */
/** Key 使用记录的 KV 键名（见 touch.ts）。 */
export function usageKVName(id: string): string {
  return K_USAGE_PREFIX + id;
}

/**
 * Validate a stored credential record before trusting it.
 *
 * Anything of the wrong shape (an empty object, a hand-written value, an entry left
 * by an older layout) counts as "no such key" rather than crashing the caller -- a
 * `{}` used to be accepted as a valid credential and then blew up as a TypeError while
 * rendering the key table.
 *
 * 信任之前先校验存储的凭据记录。
 *
 * 形状不对的一律按"没有这把 Key"处理，而不是让调用方崩溃——此前一个 `{}` 会被当成
 * 有效凭证接受，随后在渲染 Key 表格时抛成 TypeError。
 */
function normalizeApiKeyMeta(raw: Record<string, unknown> | null): ApiKeyMeta | null {
  if (!raw) return null;
  if (typeof raw.name !== "string") return null;
  if (typeof raw.created_at !== "number" || !Number.isFinite(raw.created_at)) return null;
  return {
    name: raw.name,
    prefix: typeof raw.prefix === "string" ? raw.prefix : "",
    created_at: raw.created_at,
    last_used:
      typeof raw.last_used === "number" && Number.isFinite(raw.last_used) ? raw.last_used : 0,
    masked: typeof raw.masked === "string" ? raw.masked : undefined,
  };
}

/**
 * Resolve a client key to its stored entry, hashed name first, legacy name second.
 *
 * 把客户端 Key 解析为它的存储条目：先查哈希键名，再查旧明文键名。
 */
export async function lookupApiKey(env: Env, key: string): Promise<ApiKeyEntry | null> {
  const id = await apiKeyId(key);
  const kvName = apiKeyKVName(id);
  const hashed = normalizeApiKeyMeta(await readKvRecord(env.KV, kvName));
  if (hashed) return { id, meta: hashed, kvName, legacy: false };
  // Legacy: written before this change, when the plaintext key was the KV name.
  // 旧条目：本改动之前写入，那时明文 Key 就是 KV 键名。
  const legacyName = legacyApiKeyKVName(key);
  const legacy = normalizeApiKeyMeta(await readKvRecord(env.KV, legacyName));
  if (legacy) return { id, meta: legacy, kvName: legacyName, legacy: true };
  return null;
}

/**
 * Move a legacy entry onto its hashed name (best effort, off the critical path).
 *
 * The re-read before writing is deliberate: the operator may have deleted the key
 * while this migration was in flight, and writing unconditionally would restore the
 * credential that was just revoked.
 *
 * 把旧条目迁移到哈希键名（尽力而为，远离关键路径）。
 *
 * 写入前的重新读取是刻意的：迁移在飞行中时运维可能已经删除了这把 Key，无条件写入会
 * 把刚撤销的凭证复活。
 */
export async function migrateLegacyApiKey(env: Env, entry: ApiKeyEntry): Promise<void> {
  if (!entry.legacy) return;
  if ((await env.KV.get(entry.kvName)) === null) return;
  await env.KV.put(apiKeyKVName(entry.id), JSON.stringify(entry.meta), { metadata: entry.meta });
  await env.KV.delete(entry.kvName);
}

/** Store a key's metadata under its hashed name; returns the public id. */
/** 在哈希键名下保存 Key 元数据；返回公开 id。 */
export async function putApiKey(env: Env, key: string, meta: ApiKeyMeta): Promise<string> {
  // metadata mirrors the value: KV.list returns it inline, so listing keys costs no
  // extra GET per key (the name-uniqueness check and the console's key table both
  // list). Entries written before this change carry no metadata -- listApiKeyEntries
  // falls back to a GET for those.
  //
  // metadata 与值互为镜像：KV.list 会内联返回它，列 Key 不再需要每键一次 GET
  // （重名检查与控制台的 Key 表都会触发列表）。本改动之前写入的条目没有
  // metadata——listApiKeyEntries 对它们回退 GET。
  const id = await apiKeyId(key);
  await env.KV.put(apiKeyKVName(id), JSON.stringify(meta), { metadata: meta });
  return id;
}

/** Revoke a key by its public id (the plaintext is never needed, nor known). */
/** 按公开 id 撤销一把 Key（既不需要、也不知道明文）。 */
export async function deleteApiKeyById(env: Env, id: string): Promise<void> {
  await env.KV.delete(apiKeyKVName(id));
  // A legacy plaintext-named entry for the same key would otherwise keep working --
  // and would be migrated back into place later. Remove it too when one still exists.
  //
  // 同一把 Key 若还存在旧明文键名条目，撤销就不算完成——而且它之后还会被迁移回来。
  // 因此存在时一并删除。
  const legacyName = await findLegacyKVNameForId(env, id);
  if (legacyName) await env.KV.delete(legacyName);
}

/** The legacy KV name of the entry whose id is `id`, or null. */
/** id 对应条目的旧明文键名；不存在时为 null。 */
async function findLegacyKVNameForId(env: Env, id: string): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: K_API_KEY_PREFIX, cursor });
    for (const item of page.keys) {
      const suffix = item.name.slice(K_API_KEY_PREFIX.length);
      if (API_KEY_ID_RE.test(suffix)) continue;
      if ((await apiKeyId(suffix)) === id) return item.name;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

/** Every stored key, with its legacy/hashed location resolved. */
/** 全部已存储的 Key，同时给出它位于旧键名还是哈希键名。 */
export async function listApiKeyEntries(env: Env): Promise<ApiKeyEntry[]> {
  const out: ApiKeyEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: K_API_KEY_PREFIX, cursor });
    for (const item of page.keys) {
      const suffix = item.name.slice(K_API_KEY_PREFIX.length);
      const legacy = !API_KEY_ID_RE.test(suffix);
      // Prefer the inline metadata (zero extra reads); entries written before
      // metadata mirroring exist only as values and fall back to a GET.
      //
      // 优先用内联 metadata（零额外读取）；镜像上线前写入的旧条目只有值，
      // 对它们回退 GET。
      const meta =
        normalizeApiKeyMeta(isPlainRecord(item.metadata) ? item.metadata : null) ??
        normalizeApiKeyMeta(await readKvRecord(env.KV, item.name));
      if (!meta) continue;
      out.push({
        id: legacy ? await apiKeyId(suffix) : suffix,
        meta,
        kvName: item.name,
        legacy,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Every stored key, as the admin API sees it (id + metadata, never the secret). */
/** 全部已存储的 Key，按管理 API 的视角（id + 元数据，绝不含密钥）。 */
export async function listApiKeys(env: Env): Promise<Array<{ id: string; meta: ApiKeyMeta }>> {
  const entries = await listApiKeyEntries(env);
  return entries.map(({ id, meta }) => ({ id, meta }));
}

/**
 * Resolve a public id back to its stored entry, hashed name first, legacy second.
 *
 * 把公开 id 解析回它的存储条目：先查哈希键名，再查旧明文键名。
 */
export async function getApiKeyEntryById(env: Env, id: string): Promise<ApiKeyEntry | null> {
  if (!API_KEY_ID_RE.test(id)) return null;
  const kvName = apiKeyKVName(id);
  const hashed = normalizeApiKeyMeta(await readKvRecord(env.KV, kvName));
  if (hashed) return { id, meta: hashed, kvName, legacy: false };
  const legacyName = await findLegacyKVNameForId(env, id);
  if (!legacyName) return null;
  const legacy = normalizeApiKeyMeta(await readKvRecord(env.KV, legacyName));
  return legacy ? { id, meta: legacy, kvName: legacyName, legacy: true } : null;
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

/**
 * Auto-derived HMAC secret for admin cookies, cached per instance WITH a TTL.
 * A cache without an expiry would keep signing and verifying with an old value
 * after the operator rotates SESSION_SECRET or re-creates the KV entry, until
 * the isolate happens to be recycled.
 *
 * 自动派生的管理 Cookie HMAC 密钥，按实例缓存并**带 TTL**。无过期的缓存会在运维
 * 更换 SESSION_SECRET 或重建 KV 条目后继续用旧值签发/校验，直到 isolate 恰好被回收。
 */
const SESSION_SECRET_CACHE_TTL_MS = 60_000;
let sessionSecretCache: { value: string; expireAt: number } | null = null;

function cachedSessionSecret(): string | null {
  if (sessionSecretCache && Date.now() < sessionSecretCache.expireAt) {
    return sessionSecretCache.value;
  }
  return null;
}

/**
 * READ-ONLY lookup for token verification paths. Verification must never carry
 * write side effects: generating and persisting a missing secret is the setup /
 * login paths' job (see getOrCreateSessionSecret), not something minted
 * mid-verification.
 *
 * 供令牌校验路径使用的**只读**查找。校验绝不能携带写副作用：生成并持久化缺失的
 * secret 是设密 / 登录路径的职责（见 getOrCreateSessionSecret），不能在校验中途
 * 凭空铸造。
 */
export async function getSessionSecretReadonly(env: Env): Promise<string | null> {
  // An explicitly bound secret always wins.
  // 显式绑定的 Secret 始终优先。
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const cached = cachedSessionSecret();
  if (cached) return cached;
  const secret = await env.KV.get(K_SESSION_SECRET);
  if (secret) {
    sessionSecretCache = { value: secret, expireAt: Date.now() + SESSION_SECRET_CACHE_TTL_MS };
  }
  return secret;
}

/**
 * Minimum length for an explicitly bound `SESSION_SECRET`.
 *
 * The secret is the HMAC key behind every admin session cookie; a short one is
 * guessable offline from a single captured cookie+signature pair, which is exactly the
 * kind of thing that ends up in a screenshot or a log. The auto-derived secret is
 * always 32 random bytes, so this only ever concerns an operator-provided value.
 *
 * 显式绑定的 `SESSION_SECRET` 的最小长度。
 *
 * 该密钥是每个管理会话 Cookie 背后的 HMAC 密钥；过短的密钥可以仅凭一对捕获到的
 * Cookie+签名离线爆破出来，而这类东西恰恰容易出现在截图或日志里。自动派生的密钥
 * 始终是 32 个随机字节，因此这一条只针对运维自己提供的值。
 */
export const MIN_SESSION_SECRET_CHARS = 32;

/**
 * Configuration warnings for the console (i18n keys). Empty when everything is fine.
 *
 * Currently one check: a bound `SESSION_SECRET` shorter than
 * `MIN_SESSION_SECRET_CHARS`. It is reported rather than enforced -- an existing
 * deployment must not lose its console because an operator typed eleven characters
 * once -- and the console shows it once per page load.
 *
 * 供控制台展示的配置告警（i18n 键）。一切正常时为空。
 *
 * 目前只有一条检查：绑定的 `SESSION_SECRET` 短于 `MIN_SESSION_SECRET_CHARS`。它只做提示
 * 而不强制——已有部署不该因为运维当初随手敲了十一个字符就丢掉控制台——控制台每次页面
 * 加载提示一次。
 */
export function sessionSecretWarnings(env: Env): string[] {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < MIN_SESSION_SECRET_CHARS) {
    return ["warn.session_secret_short"];
  }
  return [];
}

export async function getOrCreateSessionSecret(env: Env): Promise<string> {
  // An explicitly bound secret always wins -- and it is also the way to remove the
  // residual race described below: a bound value is the same on every isolate, so
  // there is never anything to converge.
  //
  // 显式绑定的 Secret 始终优先——它同时也是消除下述残余竞态的办法：绑定的值在每个
  // isolate 上都相同，根本不存在需要收敛的东西。
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const cached = cachedSessionSecret();
  if (cached) return cached;
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
    // Residual limit (operator decision, documented in the README): KV reads are
    // served from the location's own cache, so an isolate in a DIFFERENT location can
    // still read its own value back for up to ~60s and keep signing with it. The
    // effect is bounded -- at worst an admin has to sign in again during that window
    // -- and it is the reason the README tells operators to bind `SESSION_SECRET`
    // (the console also warns when a bound value is too short). Making this a single
    // value everywhere would need a strongly consistent store (a Durable Object) on
    // every verification path, which is not worth it for this consequence.
    //
    // 两个 isolate 可能在同一瞬间走进"无 secret"分支，而 KV 是后写者胜：回读并采用
    // 真正生效的那个值，否则用我们这份签发的令牌在下一次读取时就会验签失败——管理员
    // 会莫名其妙地掉线。
    //
    // 残余限制（运维决策，README 已写明）：KV 读取由各机房自己的缓存提供，因此位于
    // **其它机房**的 isolate 最长约 60 秒内仍会读回它自己的值并继续用它签发。后果有限
    // ——最坏情况是管理员在这段窗口里重新登录一次——这也正是 README 建议绑定
    // `SESSION_SECRET` 的原因（绑定的值过短时控制台也会提示）。要让所有机房取值一致，
    // 就得在每条校验路径上引入强一致存储（Durable Object），为这点后果不值得。
    secret = (await env.KV.get(K_SESSION_SECRET)) || generated;
  }
  sessionSecretCache = { value: secret, expireAt: Date.now() + SESSION_SECRET_CACHE_TTL_MS };
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

/**
 * Current epoch embedded in admin session tokens (default 0).
 *
 * Threat model note: this is a plain KV number with NO monotonicity guarantee — a
 * hand-edited or cross-copied KV namespace can move it backwards. The read is
 * therefore FAIL-CLOSED (operator decision): a MISSING key means "never bumped"
 * and reads as the legal 0, but a key that exists with a corrupt value reads as
 * -1, which no issued token can match — every admin session is invalidated and
 * must re-login, instead of a pre-first-bump `ver: 0` token passing again.
 *
 * 嵌入管理会话令牌的当前纪元（默认 0）。
 *
 * 威胁模型说明：这是一个普通的 KV 数字，**没有**单调性保障——手改或跨站复制的
 * KV 命名空间可以让它倒退。因此读取采取 **fail-closed**（运维决策）：键**缺失**
 * 表示"从未自增"，按合法的 0 读取；键存在但值损坏按 -1 处理——没有任何已签发
 * 令牌能匹配它，所有管理会话失效、需重新登录，而不是让首次自增前的 `ver: 0`
 * 令牌重新通过校验。
 */
export async function getSessionEpoch(env: Env): Promise<number> {
  const raw = await env.KV.get(K_SESSION_EPOCH);
  if (raw === null) return 0;
  const epoch = Number(raw);
  return Number.isFinite(epoch) && epoch >= 0 ? Math.floor(epoch) : -1;
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
export async function bumpSessionEpoch(env: Env): Promise<number> {
  const current = await getSessionEpoch(env);
  // A corrupt current value (-1) has no knowable successor: restart from 1. Every
  // live token was minted with ver -1 (paired with the corrupt read) or older, and
  // the write below moves the epoch away from both — nothing survives that should.
  //
  // 当前值损坏（-1）时没有可推算的后继：从 1 重新起算。现存的令牌要么签发于损坏
  // 期间（ver=-1，与损坏读取配对），要么更旧——下方写入会让纪元离开这两种取值，
  // 该失效的都不会漏掉。
  const next = current < 0 ? 1 : current + 1;
  await env.KV.put(K_SESSION_EPOCH, String(next));
  return next;
}
