/**
 * Shared types for the Worker.
 * 
 * Storage layout in the KV namespace:
 *   - "session"                    -> StoredSession (imported from the local login tool)
 *   - "apikey:{key}"               -> ApiKeyMeta (key itself is the KV key, O(1) lookup)
 *   - "admin:password_hash"        -> { salt, hash } (PBKDF2 via WebCrypto)
 *   - "admin:session_secret"       -> auto-derived HMAC secret for admin cookies
 *   - "admin:session_epoch"        -> number; bumped on every password change so all
 *                                     previously issued admin session tokens die at once
 *   - "settings:touch_interval"    -> number (seconds); how often a key's last_used is
 *                                     refreshed (default daily, adjustable in console)
 *   - "settings:reasoning"         -> ReasoningSettings; reasoning-effort probe feature
 *                                     switch, tuning knobs and auto-refresh granularity
 *   - "reasoning:cache"            -> ReasoningCacheFile; probed reasoning_effort sets
 *                                     per model, mirrored from the upstream project's
 *                                     reasoning_cache.json
 * 
 * Admin password sources (mirror of M365-Copilot2API-on-Cloudflare-Worker):
 *   - ADMIN_PASSWORD secret is verified directly and is NEVER written to KV.
 *   - The KV hash is written only by the web console: first-visit setup ("none"
 *     mode) or the "change password" flow.
 *   - When a KV hash exists it always wins over the secret binding.
 * 
 * Worker 共享类型。
 *
 * KV 命名空间中的存储布局：
 *   - "session"                    -> StoredSession（由本地登录工具导入）
 *   - "apikey:{key}"               -> ApiKeyMeta（Key 明文即 KV 键名，O(1) 查询）
 *   - "admin:password_hash"        -> { salt, hash }（WebCrypto 的 PBKDF2）
 *   - "admin:session_secret"       -> 自动派生的管理 Cookie HMAC 签名密钥
 *   - "admin:session_epoch"        -> 数字；每次修改密码时自增，使所有
 *                                     已签发的管理会话令牌立即全部失效
 *   - "settings:touch_interval"    -> 数字（秒）；Key last_used 的刷新粒度
 *                                     （默认每天，可在控制台调整）
 *   - "settings:reasoning"         -> ReasoningSettings；思考挡位探测的功能开关、
 *                                     调节参数与自动刷新粒度
 *   - "reasoning:cache"            -> ReasoningCacheFile；逐模型探测到的
 *                                     reasoning_effort 挡位集合（对应上游
 *                                     reasoning_cache.json）
 *
 * 管理密码来源（与 M365-Copilot2API-on-Cloudflare-Worker 对齐）：
 *   - ADMIN_PASSWORD Secret 直接参与验证，绝不写入 KV。
 *   - KV 哈希仅由网页控制台写入：首次访问设密（"none" 模式）或「修改密码」流程。
 *   - KV 哈希一旦存在，始终优先于 Secret 绑定。
 */

export interface Env {
  /** KV binding: session / config / api keys / admin credentials. */
  /** KV 绑定：session / 配置 / API Key / 管理员凭证。 */
  KV: KVNamespace;
  /**
   * Optional: preset admin password via `wrangler secret put ADMIN_PASSWORD`.
   * 
   * Verified directly (never stored in KV); a KV password, once set via the
   * console, takes priority over this binding.
   * 
   * 可选：通过 `wrangler secret put ADMIN_PASSWORD` 预设管理密码。
   * 
   * 直接验证（绝不写入 KV）；一旦通过控制台设置了 KV 密码，则优先于该绑定。
   */
  ADMIN_PASSWORD?: string;
  /** Optional: HMAC signing secret for admin session cookies. */
  /** 可选：管理会话 Cookie 的 HMAC 签名密钥。 */
  SESSION_SECRET?: string;
}

/** Where the effective admin password currently comes from. */
/** 当前生效的管理密码来源。 */
export type AdminPasswordSource = "none" | "secret" | "kv";

/** Credentials captured by the local login tool (mirrors session.json). */
/** 本地登录工具捕获的凭证（对应 session.json）。 */
export interface StoredSession {
  /** "Bearer eyJ..." — at least one of authorization / cookie must be non-empty. */
  /** "Bearer eyJ..." —— authorization / cookie 至少一项非空。 */
  authorization: string;
  /** "token=...; oauth_session_id=..." */
  /** "token=...; oauth_session_id=..."（Cookie 串） */
  cookie: string;
  user_agent: string;
  /** Unix epoch seconds when the credentials were captured. */
  /** 凭证捕获时间（Unix 秒级时间戳）。 */
  captured_at: number;
  /** Upstream root URL, e.g. "https://chat.example.com". */
  /** 上游根地址，例如 "https://chat.example.com"。 */
  base_url: string;
}

/** Metadata for a generated client API key (KV key: "apikey:{key}"). */
/** 生成的客户端 API Key 元数据（KV 键名："apikey:{key}"）。 */
export interface ApiKeyMeta {
  name: string;
  /** First 8 chars of the key, for display. */
  /** Key 的前 8 个字符，用于展示。 */
  prefix: string;
  created_at: number;
  last_used: number;
}

/** Full record returned only when a key is first generated. */
/** 仅在 Key 首次生成时返回的完整记录。 */
export interface ApiKeyRecord extends ApiKeyMeta {
  key: string;
}

/** Stored admin password hash. */
/** 存储的管理密码哈希。 */
export interface PasswordHash {
  salt: string;
  hash: string;
}

/** Admin session cookie payload (HMAC-signed). */
/** 管理会话 Cookie 负载（HMAC 签名）。 */
export interface AdminSession {
  exp: number;
  iat: number;
}

// --------------------------------------------------------------------------- //
// Reasoning-effort probe
// 思考挡位探测
// --------------------------------------------------------------------------- //

/** Settings for the reasoning-effort probe (KV key: "settings:reasoning"). */
/** 思考挡位探测设置（KV 键名："settings:reasoning"）。 */
export interface ReasoningSettings {
  /** Whether /v1/models serves the "reasoning" field (default true). */
  /** /v1/models 是否返回 reasoning 字段（默认 true）。 */
  enabled: boolean;
  /** Probe concurrency, 1–8 (default 4). */
  /** 探测并发数，1–8（默认 4）。 */
  concurrency: number;
  /** Per-model probe timeout in seconds, 1–120 (default 30). */
  /** 单模型探测超时秒数，1–120（默认 30）。 */
  timeout: number;
  /** Bounded wait on /v1/models for a missing-models probe, seconds, 0–30; 0 = never wait (default 5). */
  /** /v1/models 为等待缺失模型探测完成的最长秒数，0–30；0 = 不等待（默认 5）。 */
  wait: number;
  /** Auto-refresh granularity in seconds: 0 = off, otherwise a touch-interval option (default 86400). */
  /** 自动刷新粒度秒数：0 = 关闭，否则为使用记录粒度的挡位之一（默认 86400）。 */
  refreshInterval: number;
}

/** One probed model entry in the reasoning cache. */
/** 思考挡位缓存中的单模型条目。 */
export interface ReasoningCacheEntry {
  /** Accepted effort levels; empty means "probed, but the upstream accepted the sentinel without validating". */
  /** 接受的挡位列表；空列表表示"已探测，但上游未校验哨兵值"（不可探测）。 */
  supported_efforts: string[];
  /** Unix epoch seconds of the last successful probe. */
  /** 最近一次成功探测的 Unix 秒级时间戳。 */
  probed_at: number;
}

/** Persisted probe results (KV key: "reasoning:cache"; mirrors the upstream reasoning_cache.json). */
/** 持久化的探测结果（KV 键名："reasoning:cache"；对应上游 reasoning_cache.json）。 */
export interface ReasoningCacheFile {
  version: number;
  models: Record<string, ReasoningCacheEntry>;
}

/** The per-model "reasoning" object served on /v1/models. */
/** /v1/models 上每个模型附加的 "reasoning" 对象。 */
export interface ReasoningInfo {
  supported_efforts: string[];
  default_effort: string;
  default_enabled: boolean;
  /** True when "none" is absent, i.e. thinking cannot be turned off. */
  /** 缺少 "none" 时为 true，即思考无法关闭。 */
  mandatory: boolean;
}
