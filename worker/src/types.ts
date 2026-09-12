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
 *   - "settings:probe"             -> ProbeSettings; model probe feature switch and
 *                                     tuning knobs
 *
 * Probe results are NOT stored in KV: they live in the ModelProbeCoordinator
 * Durable Object (SQLite, one row per model), which is the single coordinator for
 * the deployment and gives strongly consistent reads plus one write per model.
 * KV is only used for the low-rate, deployment-level keys above.
 *
 * The instance snapshot is NOT in KV either: `/api/config`'s name / version / features
 * and the shared capability template are stored in the coordinator's SQLite (key
 * `instance_meta`), beside the probe facts, and the coordinator refreshes them from its
 * own background `waitUntil`. The old KV key `instance:meta` is no longer read (and may
 * be deleted by hand).
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
 *   - "settings:probe"             -> ProbeSettings；模型探测的功能开关与调节参数
 *
 * 探测结果**不放在 KV**：它们存放在 ModelProbeCoordinator Durable Object 里
 * （SQLite，每模型一行）。该 DO 是本部署的唯一协调者，提供强一致读取与
 * "每模型一次写入"的能力。KV 只承载上面这些低频的部署级键。
 *
 * 实例快照同样**不在 KV**：`/api/config` 的 name / version / features 与共享能力模板
 * 存放在协调者的 SQLite（键 `instance_meta`），与探测事实相邻，并由协调者在自己的后台
 * `waitUntil` 里刷新。旧的 KV 键 `instance:meta` 已不再被读取（可手动删除）。
 * 
 * 管理密码来源（与 M365-Copilot2API-on-Cloudflare-Worker 对齐）：
 *   - ADMIN_PASSWORD Secret 直接参与验证，绝不写入 KV。
 *   - KV 哈希仅由网页控制台写入：首次访问设密（"none" 模式）或「修改密码」流程。
 *   - KV 哈希一旦存在，始终优先于 Secret 绑定。
 */

// Type-only import: the binding is typed by the coordinator's RPC surface, and the
// cycle (coordinator -> types) is erased at build time.
//
// 仅类型导入：该绑定按协调者的 RPC 面来定型，而这条循环（coordinator -> types）
// 在构建期会被完全擦除。
import type { ModelProbeCoordinator } from "./probeCoordinator.ts";

export interface Env {
  /** KV binding: session / config / api keys / admin credentials. */
  /** KV 绑定：session / 配置 / API Key / 管理员凭证。 */
  KV: KVNamespace;
  /**
   * Durable Object binding: the deployment's single probe coordinator.
   *
   * Probe results live there (SQLite, one row per model) instead of KV, so reads are
   * strongly consistent and each model is written as soon as it is established.
   *
   * Durable Object 绑定：本部署唯一的探测协调者。
   *
   * 探测结果存放在那里（SQLite，每模型一行）而不是 KV，使读取强一致，并且每个模型
   * 一探完就能落盘。
   */
  PROBE: DurableObjectNamespace<ModelProbeCoordinator>;
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

/** Stored admin password hash. */
/** 存储的管理密码哈希。 */
export interface PasswordHash {
  salt: string;
  hash: string;
}

// --------------------------------------------------------------------------- //
// Model probe
// 模型探测
// --------------------------------------------------------------------------- //

/**
 * Settings for the model probe (KV key: "settings:probe").
 *
 * Rounds are serial and budgeted, so the old `concurrency` knob is gone: one
 * invocation may only have six connections waiting for response headers, and a
 * serial round never needs more than one.
 *
 * 模型探测设置（KV 键名："settings:probe"）。
 *
 * 轮次是串行且有预算的，因此旧版的 `concurrency` 已被移除：单次调用最多只能有
 * 六个"等待响应头"的连接，而串行轮次一个就够。
 */
export interface ProbeSettings {
  /** Whether probe-derived model fields are served and probes are run (default true). */
  /** 是否对外输出探测得出的模型字段、以及是否发起探测（默认 true）。 */
  enabled: boolean;
  /** Per-request probe timeout in seconds, 1–120 (default 30). */
  /** 单个探测请求超时秒数，1–120（默认 30）。 */
  timeout: number;
  /** Bounded wait on /v1/models for missing facts, seconds, 0–30; 0 = never wait (default 5). */
  /** /v1/models 为缺失事实等待的最长秒数，0–30；0 = 不等待（默认 5）。 */
  wait: number;
  /** Upstream subrequests one probe round may spend (default 40; the free plan allows 50 per invocation). */
  /** 单轮探测可消耗的上游子请求数（默认 40；免费层每次调用上限 50）。 */
  budget: number;
  /** Whether the /v1/models envelope carries x_open_webui (default true). */
  /** /v1/models 信封是否携带 x_open_webui（默认 true）。 */
  exposeInstanceMeta: boolean;
}

/**
 * Probe outcome. `status` describes the DATA (how conclusive the cached facts
 * are); a failed attempt is expressed by `retry_after` + `last_error`, so a
 * failed re-probe never throws away facts that were already established.
 *
 * 探测结果状态。`status` 描述的是**数据**（缓存事实有多确定）；单次尝试的失败由
 * `retry_after` + `last_error` 表达，因此一次失败的重探不会丢掉已确立的事实。
 */
export type ProbeStatus = "ok" | "partial" | "unprobeable" | "failed";

/** Everything established about one model, plus how to treat it next time. */
/** 关于单个模型已确立的一切，以及下次该如何对待它。 */
export interface ModelProbe {
  /** Engine fingerprint; a change invalidates every fact below. */
  /** 引擎指纹；一旦变化，下面所有事实作废。 */
  fingerprint: string;
  /** Unix epoch seconds (float) of the probe. */
  /** 探测时刻的 Unix 秒级时间戳（浮点）。 */
  probed_at: number;
  status: ProbeStatus;
  /** Consecutive failed/incomplete attempts (drives the backoff). */
  /** 连续失败/未完成的次数（驱动退避）。 */
  attempts: number;
  /** Unix epoch seconds before which the model must not be re-probed. */
  /** 早于该时刻不得重探（Unix 秒级时间戳）。 */
  retry_after: number;
  /** One-line reason for the last failed/incomplete attempt. */
  /** 最近一次失败/未完成的原因（单行）。 */
  last_error: string;
  /** Accepted effort levels, only ever filled from a real 200. */
  /** 接受的挡位，只由真实的 200 填出。 */
  supported_efforts: string[];
  /** True when every candidate was conclusively verified. */
  /** 每个候选都得到了确定结论时为 true。 */
  efforts_verified: boolean;
  /** Engine-declared default level, when it names one. */
  /** 引擎自己声明的默认挡位（说了才有）。 */
  default_effort: string | null;
  /** Whether thinking happens when reasoning_effort is omitted. */
  /** 省略 reasoning_effort 时是否会产生思考。 */
  default_enabled: boolean | null;
  /** Only the keys actually established by probing. */
  /** 只包含确实被探测确立的能力键。 */
  capabilities: Record<string, boolean>;
  /** Request parameters the engine did not reject, plus reasoning_effort. */
  /** 引擎未拒绝的请求参数，外加 reasoning_effort。 */
  supported_parameters: string[];
  /** Engine build string reported in chat responses; diagnostics only. */
  /** 聊天响应里上报的引擎构建串；仅供诊断。 */
  system_fingerprint: string;
}

/** The per-model "reasoning" object served on /v1/models (OpenRouter's shape). */
/** /v1/models 上每个模型附加的 "reasoning" 对象（OpenRouter 的形状）。 */
export interface ReasoningInfo {
  supported_efforts: string[];
  /** True when "none" is absent, i.e. thinking cannot be turned off. */
  /** 缺少 "none" 时为 true，即思考无法关闭。 */
  mandatory: boolean;
  /** Omitted when the engine never named a default. */
  /** 引擎没说默认值时省略。 */
  default_effort?: string;
  /** Omitted when the default behaviour could not be observed. */
  /** 观察不出默认行为时省略。 */
  default_enabled?: boolean;
}

/** Modality description derived from the vision probe. */
/** 由视觉探测推导出的模态描述。 */
export interface ArchitectureInfo {
  modality: string;
  input_modalities: string[];
  output_modalities: string[];
}

/** The probe-derived fields merged into a /v1/models entry (each only when established). */
/** 合并进 /v1/models 条目的探测字段（各自只在确立后出现）。 */
export interface ModelProbeFields {
  capabilities?: Record<string, boolean>;
  supported_parameters?: string[];
  reasoning?: ReasoningInfo;
  architecture?: ArchitectureInfo;
}

/** A JSON primitive: the values `/api/config.features` actually carries, and the
 *  deepest shape the coordinator hands back over RPC.
 *
 *  A recursive "any JSON" type would be more faithful, but the Durable Object RPC
 *  layer maps return types with a recursive `Serializable<T>`, and a self-referencing
 *  type makes TypeScript give up ("Type instantiation is excessively deep"). Real
 *  `/api/config.features` payloads are flat maps of scalars, so this costs nothing --
 *  and a nested value would still survive at runtime, because the payload is passed
 *  through untouched (the annotation is simply narrower than the data).
 *
 *  JSON 原始值：`/api/config.features` 实际携带的取值，也是协调者通过 RPC 交回的
 *  最深层形状。
 *
 *  递归的"任意 JSON"类型更忠实，但 Durable Object 的 RPC 层用递归的
 *  `Serializable<T>` 映射返回类型，自引用类型会让 TypeScript 直接放弃
 *  （"Type instantiation is excessively deep"）。真实 `/api/config.features` 都是
 *  标量扁平映射，因此这样没有损失——嵌套值在运行时也依然能活下来，因为负载是原样
 *  透传的（类型标注只是比数据更窄）。 */
export type JsonPrimitive = string | number | boolean | null;

/** Facts about the Open WebUI deployment itself (coordinator SQLite, key "instance_meta"). */
/** 关于 Open WebUI 部署自身的事实（协调者 SQLite，键名 "instance_meta"）。 */
export interface InstanceMeta {
  name: string;
  version: string;
  /** Upstream /api/config.features, passed through verbatim.
   *
   *  Typed as JSON rather than `unknown` on purpose: this object crosses the Durable
   *  Object RPC boundary, and Cloudflare's serializable-type mapping resolves
   *  `unknown` to `never` -- which would make the whole `present` result unusable to
   *  the caller.
   *
   *  刻意用 JSON 类型（而非 `unknown`）：该对象要跨越 Durable Object 的 RPC 边界，
   *  而 Cloudflare 的可序列化类型映射会把 `unknown` 解析为 `never`，进而使整个
   *  `present` 返回值对调用方不可用。 */
  features: Record<string, JsonPrimitive>;
  /** The capability template every reporting model agrees on. */
  /** 所有上报能力的模型都一致同意的能力模板。 */
  default_model_capabilities?: Record<string, boolean>;
  /** Unix epoch seconds of the last /api/config read (successful or not). */
  /** 最近一次读取 /api/config 的时刻（无论成功与否）。 */
  fetched_at: number;
}

/** Counters returned by one probe round. */
/** 单轮探测返回的统计计数。 */
export interface ProbeRoundStats {
  ok: number;
  partial: number;
  unprobeable: number;
  failed: number;
  /** True when the round was aborted by an upstream 401/403. */
  /** 因上游 401/403 中止整轮时为 true。 */
  authExpired: boolean;
  /** Models selected for probing this round. */
  /** 本轮选入待探测集合的模型数。 */
  total: number;
  /** Cached entries once the round is over (models still upstream, the ones probed
   *  during this round included). */
  /** 本轮结束后缓存持有的条目数（仍在上游的模型，含本轮刚探完的）。 */
  cached: number;
  /** Upstream subrequests actually spent. */
  /** 实际消耗的上游子请求数。 */
  budgetUsed: number;
  /** True when the budget ran out before every selected model was probed. */
  /** 预算耗尽、仍有选中的模型未探测时为 true。 */
  truncated: boolean;
  /** The selected models a truncated round never got to, in upstream order.
   *
   *  A truncated round hands THIS list (not "everything") to its alarm: resuming a
   *  forced re-probe from the top would re-probe the models that just finished and
   *  never reach the rest, burning the budget in a loop.
   *
   *  被截断的轮次未能探到的已选模型，按上游顺序排列。
   *
   *  被截断的轮次交给 alarm 的是**这份列表**（而不是"全部"）：从头部续跑一次强制重探
   *  会重复刚探完的模型、永远到不了后面，把预算烧在循环里。 */
  remaining: string[];
}
