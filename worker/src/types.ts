/**
 * Shared types for the Worker.
 *
 * Storage layout in the KV namespace:
 *   - "session"                    -> StoredSession (imported from the local login tool)
 *   - "config:cloudflare"          -> CloudflareConfig (AI Gateway / CF API settings)
 *   - "apikey:{key}"               -> ApiKeyMeta (key itself is the KV key, O(1) lookup)
 *   - "admin:password_hash"        -> { salt, hash } (PBKDF2 via WebCrypto)
 *   - "admin:session_secret"       -> auto-derived HMAC secret for admin cookies
 */

export interface Env {
  /** KV binding: session / config / api keys / admin credentials. */
  KV: KVNamespace;
  /** Optional: preset admin password via `wrangler secret put ADMIN_PASSWORD`. */
  ADMIN_PASSWORD?: string;
  /** Optional: HMAC signing secret for admin session cookies. */
  SESSION_SECRET?: string;
}

/** Credentials captured by the local login tool (mirrors session.json). */
export interface StoredSession {
  /** "Bearer eyJ..." — at least one of authorization / cookie must be non-empty. */
  authorization: string;
  /** "token=...; oauth_session_id=..." */
  cookie: string;
  user_agent: string;
  /** Unix epoch seconds when the credentials were captured. */
  captured_at: number;
  /** Upstream root URL, e.g. "https://chat.example.com". */
  base_url: string;
}

/** AI Gateway / Cloudflare API settings managed from the admin UI. */
export interface CloudflareConfig {
  /** Cloudflare API token with "AI Gateway - Edit" permission. */
  api_token: string;
  account_id: string;
  /** Leave empty to auto-create on one-click setup. */
  gateway_id: string;
  /** Custom provider slug; the gateway route is "custom-{slug}". */
  provider_slug: string;
  /** cf-aig-cache-ttl in seconds for non-streaming requests (0 = disabled). */
  cache_ttl: number;
  /** true = route through AI Gateway, false = direct upstream. */
  enabled: boolean;
}

/** Metadata for a generated client API key (KV key: "apikey:{key}"). */
export interface ApiKeyMeta {
  name: string;
  /** First 8 chars of the key, for display. */
  prefix: string;
  created_at: number;
  last_used: number;
}

/** Full record returned only when a key is first generated. */
export interface ApiKeyRecord extends ApiKeyMeta {
  key: string;
}

/** Stored admin password hash. */
export interface PasswordHash {
  salt: string;
  hash: string;
}

/** Admin session cookie payload (HMAC-signed). */
export interface AdminSession {
  exp: number;
  iat: number;
}
