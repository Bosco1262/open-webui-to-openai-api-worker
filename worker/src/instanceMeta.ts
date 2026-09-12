/**
 * Instance metadata: facts about the Open WebUI deployment itself, as opposed to any
 * single model -- the feature switches it has turned on, and the default model
 * metadata template it merges into every model.
 *
 * Ported from the upstream Python project (commit ffef6e2: app.py `_InstanceMeta`
 * and `_ensure_instance_meta`).
 *
 * This module is deliberately PURE: it owns the shape, the freshness rule, the
 * envelope, and the decision "what counts as a usable /api/config response". The
 * snapshot itself is stored by the ModelProbeCoordinator (SQLite, beside the probe
 * facts) and the /api/config request is issued from there -- so KV carries no
 * instance state at all, and a Worker request never fetches /api/config directly.
 *
 * The upstream trap is encoded in `parseInstanceConfig`: `/api/config` exists under
 * the LEGACY prefix only, and `/api/v1/config` is not a route at all -- it falls
 * through to the SPA and answers **200 with an HTML page**, so the status code alone
 * can never be trusted.
 *
 * 实例元信息：关于 Open WebUI 部署自身（而非任何单个模型）的事实——它开启了哪些功能
 * 开关，以及它合并进每个模型的默认模型元数据模板。
 *
 * 从上游 Python 项目移植（提交 ffef6e2：app.py 的 `_InstanceMeta` 与
 * `_ensure_instance_meta`）。
 *
 * 本模块刻意**纯逻辑**：它只负责结构、新鲜度规则、信封，以及"什么样的 /api/config
 * 答复算可用"。快照本身由 ModelProbeCoordinator 存储（SQLite，与探测事实放在一起），
 * /api/config 请求也从那里发出——因此 KV 不承载任何实例状态，Worker 请求也不再直接
 * 拉 /api/config。
 *
 * 上游那个陷阱固化在 `parseInstanceConfig` 里：`/api/config` 只存在于**旧前缀**下，
 * 而 `/api/v1/config` 根本不是路由——它会落到 SPA 上并返回 **200 + 一页 HTML**，
 * 因此只看状态码永远不可信。
 */

import type { InstanceMeta, JsonPrimitive } from "./types.ts";

/** Storage key holding the instance metadata snapshot (coordinator SQLite). */
/** 存储实例元信息快照的键（协调者的 SQLite）。 */
export const K_INSTANCE_META = "instance_meta";

/** How long a snapshot is reused before /api/config is read again (seconds). */
/** 快照复用多久后重新读取 /api/config（秒）。 */
export const INSTANCE_META_TTL_SECONDS = 300;

/** `/api/config` lives under the legacy prefix only -- see the module comment. */
/** `/api/config` 只存在于旧前缀下——见模块注释。 */
export const INSTANCE_CONFIG_PATH = "/api/config";

/** Timeout for the /api/config request (ms). Five seconds, deliberately far below the
 *  proxy's upstream ceiling: this read happens in the background and a slow instance
 *  only delays the snapshot by one TTL, while a hung connection would hold a
 *  `waitUntil` slot for the whole ceiling. */
/** /api/config 请求的超时（毫秒）。刻意取 5 秒，远低于代理的上游上限：这次读取在后台
 *  进行，慢实例只会让快照晚一个 TTL，而挂住的连接会占满整个上限的 `waitUntil` 槽位。 */
export const INSTANCE_CONFIG_TIMEOUT_MS = 5_000;

/** A fresh, empty snapshot. */
/** 一份全新的空快照。 */
export function emptyInstanceMeta(): InstanceMeta {
  return { name: "", version: "", features: {}, fetched_at: 0 };
}

/** Whether anything worth publishing is known. */
/** 是否有值得输出的内容。 */
export function isInstanceMetaUsable(meta: InstanceMeta): boolean {
  return Boolean(
    meta.name ||
      meta.version ||
      Object.keys(meta.features).length > 0 ||
      (meta.default_model_capabilities &&
        Object.keys(meta.default_model_capabilities).length > 0),
  );
}

/** Whether the snapshot is still fresh. */
/** 快照是否仍然新鲜。 */
export function isInstanceMetaFresh(meta: InstanceMeta, now: number): boolean {
  return Boolean(meta.fetched_at) && now - meta.fetched_at < INSTANCE_META_TTL_SECONDS;
}

/** The envelope shape: only the keys that are actually present. */
/** 信封结构：只输出确实存在的键。 */
export function instanceMetaToEnvelope(meta: InstanceMeta): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (meta.name) payload.name = meta.name;
  if (meta.version) payload.version = meta.version;
  if (Object.keys(meta.features).length > 0) payload.features = meta.features;
  if (meta.default_model_capabilities && Object.keys(meta.default_model_capabilities).length > 0) {
    payload.default_model_capabilities = meta.default_model_capabilities;
  }
  return payload;
}

/**
 * Tolerant parse of a stored snapshot: accepts the JSON string as read from storage,
 * or an already-parsed object.
 *
 * 宽容地解析已存储的快照：既接受从存储读出的 JSON 字符串，也接受已解析的对象。
 */
export function parseInstanceMeta(raw: unknown): InstanceMeta {
  const meta = emptyInstanceMeta();
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      return meta;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return meta;
  const obj = source as Record<string, unknown>;
  if (typeof obj.name === "string") meta.name = obj.name;
  if (typeof obj.version === "string") meta.version = obj.version;
  if (obj.features && typeof obj.features === "object" && !Array.isArray(obj.features)) {
    // `features` came out of JSON in the first place, so it is JSON by construction.
    // features 本来就来自 JSON，因此它在构造上就是 JSON。
    meta.features = obj.features as Record<string, JsonPrimitive>;
  }
  const template = obj.default_model_capabilities;
  if (template && typeof template === "object" && !Array.isArray(template)) {
    const capabilities: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(template)) {
      if (typeof value === "boolean") capabilities[key] = value;
    }
    if (Object.keys(capabilities).length > 0) meta.default_model_capabilities = capabilities;
  }
  const fetchedAt = Number(obj.fetched_at);
  if (Number.isFinite(fetchedAt)) meta.fetched_at = fetchedAt;
  return meta;
}

/**
 * Decide whether a /api/config response is usable, and read the facts out of it.
 *
 * The status code alone is not enough: an unknown route under the modern prefix is
 * served by the SPA, so a 200 can carry an HTML page. Anything that is not a JSON
 * object is rejected here, which is why a caller may treat a non-null result as a
 * real snapshot.
 *
 * 判断一份 /api/config 响应是否可用，并从中读出事实。
 *
 * 只看状态码是不够的：现代前缀下的未知路由会落到 SPA 上，因此 200 也可能带一页
 * HTML。这里拒绝任何不是 JSON 对象的响应，因此调用方可以把"非 null"当作真实快照。
 */
export function parseInstanceConfig(
  status: number,
  contentType: string | null,
  text: string,
): Record<string, unknown> | null {
  if (status !== 200) return null;
  if ((contentType ?? "").toLowerCase().includes("text/html")) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/**
 * Merge a /api/config payload into a snapshot, always stamping `fetched_at`.
 *
 * The timestamp moves whether or not the read worked, so an unreachable instance is
 * retried once per TTL instead of once per request.
 *
 * 把 /api/config 负载合并进快照，并总是打上 `fetched_at`。
 *
 * 无论读取成功与否都推进时间戳，使不可达的实例每个 TTL 才重试一次，而不是每个请求。
 */
export function applyInstanceConfig(
  meta: InstanceMeta,
  config: Record<string, unknown> | null,
  fetchedAt: number,
): InstanceMeta {
  const next: InstanceMeta = { ...meta, fetched_at: fetchedAt };
  if (!config) return next;
  if (typeof config.name === "string" && config.name) next.name = config.name;
  if (typeof config.version === "string" && config.version) next.version = config.version;
  if (config.features && typeof config.features === "object" && !Array.isArray(config.features)) {
    next.features = config.features as Record<string, JsonPrimitive>;
  }
  return next;
}

/** Whether two capability templates carry exactly the same entries. */
/** 两份能力模板是否携带完全相同的条目。 */
export function sameCapabilities(
  a: Record<string, boolean> | undefined,
  b: Record<string, boolean> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => right[key] === left[key]);
}
