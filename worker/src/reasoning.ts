/**
 * Reasoning-effort probe & cache.
 *
 * Ported from the upstream Python project (commit 3145e03: reasoning_cache.py
 * + the probe orchestration in app.py). Discovery trick: the upstream (vLLM
 * and friends) validates reasoning_effort as a Literal enum. Sending the
 * sentinel "__probe__" makes it fail with a 400 whose error text enumerates
 * every accepted value:
 *
 *     Input should be 'none', 'low', 'medium' or 'high'
 *
 * Validation happens before generation, so a probe costs (almost) no tokens.
 * Levels are model-specific, hence one probe per model; results persist in KV
 * under "reasoning:cache" and are refreshed incrementally (missing or expired
 * models only).
 *
 * Worker-side adaptation: there is no long-lived process, so the refresh is
 * triggered lazily by /v1/models requests (ctx.waitUntil) and manually from
 * the admin console, instead of by a startup background task.
 *
 * 思考挡位探测与缓存。
 *
 * 从上游 Python 项目移植（提交 3145e03：reasoning_cache.py 与 app.py 中的探测
 * 编排）。探测原理：上游（vLLM 等）把 reasoning_effort 声明为 Literal 枚举校验，
 * 发送哨兵值 "__probe__" 会得到 400，错误文本里恰好枚举了全部可接受值：
 *
 *     Input should be 'none', 'low', 'medium' or 'high'
 *
 * 校验发生在生成之前，因此一次探测的 token 成本趋近于零。挡位与模型挂钩，
 * 所以按模型逐一探测；结果持久化到 KV 键 "reasoning:cache"，仅对缺失或
 * 过期的模型增量重探。
 *
 * Worker 侧适配：无常驻进程，刷新改由 /v1/models 请求惰性触发
 * （ctx.waitUntil）与管理端手动触发，替代上游的启动后台任务。
 */

import type {
  Env,
  ReasoningCacheFile,
  ReasoningInfo,
  ReasoningSettings,
  StoredSession,
} from "./types";
import { cacheGet, cacheSet, getSession } from "./kv";
import { DEFAULT_INTERVAL, isIntervalOption } from "./intervals";
import { sessionHeaders } from "./session";

/** Upstream prefixes in probe priority order (Open WebUI >= 0.6 vs legacy).
 *  Kept in sync with proxy.ts / admin.ts. */
/** 上游前缀探测优先级顺序（Open WebUI >= 0.6 与旧版本），与 proxy.ts / admin.ts 保持一致。 */
const PREFIX_CANDIDATES = ["/api/v1", "/api"];

/** Upstream returning these means the credentials are dead. */
/** 上游返回这些状态码说明凭证已失效。 */
const AUTH_FAILURE_CODES = [401, 403];

/** Sentinel value that can never be a real effort level; the upstream's Literal
 *  validation rejects it and names the accepted values in the error text. */
/** 哨兵值，绝不可能是真实挡位；上游的 Literal 校验会拒绝它，并在错误文本里点名可接受的值。 */
export const PROBE_SENTINEL = "__probe__";

/** Canonical effort order from fully-off to maximum thinking. Used to sort the
 *  emitted list and to derive defaults. Values unknown to this list (other
 *  upstreams may invent their own) still pass through, sorted to the end. */
/** 规范挡位顺序：从全关到最大思考。用于输出排序与默认值推导。未知挡位照样透传，只是排在末尾。 */
export const EFFORT_ORDER: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const KNOWN_EFFORTS = new Set(EFFORT_ORDER);

// "Input should be 'a', 'b' or 'c'" -> captures the run of quoted values.
// Handles both the "or"-joined tail and comma-separated middles, and tolerates
// the same text appearing (escaped) inside a JSON detail string.
//
// "Input should be 'a', 'b' or 'c'" -> 捕获连续的引号值序列。兼容末尾的 or
// 连接与中间的逗号分隔，也容忍同一段文本（带转义）出现在 JSON detail 里。
const INPUT_SHOULD_RE = /Input should be ((?:'[^']+'(?:\s*,\s*|\s+or\s+)?)+)/g;
const QUOTED_RE = /'([^']+)'/g;

// --------------------------------------------------------------------------- //
// Settings & cache persistence
// 设置与缓存的持久化
// --------------------------------------------------------------------------- //

/** KV key storing the probe settings (enabled / concurrency / timeout / wait / refreshInterval). */
/** 存储探测设置（enabled / concurrency / timeout / wait / refreshInterval）的 KV 键。 */
const K_REASONING_SETTINGS = "settings:reasoning";

/** KV key storing the probed reasoning_effort sets per model. */
/** 存储逐模型探测到的 reasoning_effort 集合的 KV 键。 */
const K_REASONING_CACHE = "reasoning:cache";

/** Defaults mirror the upstream project (config.py): enabled, 4-way concurrency, 30s probe timeout, 5s wait, daily refresh. */
/** 默认值与上游项目一致（config.py）：开启、并发 4、单模型超时 30 秒、等待 5 秒、每天自动刷新。 */
const DEFAULT_REASONING_SETTINGS: ReasoningSettings = {
  enabled: true,
  concurrency: 4,
  timeout: 30,
  wait: 5,
  refreshInterval: DEFAULT_INTERVAL,
};

// Field-by-field validation with clamping; anything invalid falls back to its
// default so a corrupt or partially-written KV value can never disable the
// proxy path.
//
// 逐字段校验并夹紧取值范围；任何非法值都回退默认，损坏或写一半的 KV 数据
// 永远不会阻断代理路径。
function normalizeReasoningSettings(raw: unknown): ReasoningSettings {
  const out = { ...DEFAULT_REASONING_SETTINGS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
  };
  out.concurrency = clamp(obj.concurrency, 1, 8, out.concurrency);
  out.timeout = clamp(obj.timeout, 1, 120, out.timeout);
  out.wait = clamp(obj.wait, 0, 30, out.wait);
  const interval = Number(obj.refreshInterval);
  if (Number.isFinite(interval)) {
    const n = Math.trunc(interval);
    // 0 means "auto-refresh off"; anything else must be a known granularity.
    // 0 表示关闭自动刷新；其余必须命中已知档位。
    out.refreshInterval = n === 0 || isIntervalOption(n) ? n : out.refreshInterval;
  }
  return out;
}

/** Read the reasoning settings, served from the 60s instance cache when possible. */
/** 读取思考挡位设置，优先命中 60 秒实例缓存。 */
export async function getReasoningSettings(env: Env): Promise<ReasoningSettings> {
  const cached = cacheGet<ReasoningSettings>(K_REASONING_SETTINGS);
  if (cached) return cached;
  const raw = await env.KV.get(K_REASONING_SETTINGS, "json");
  const settings = normalizeReasoningSettings(raw);
  cacheSet(K_REASONING_SETTINGS, settings);
  return settings;
}

/** Persist the reasoning settings (values are assumed pre-validated by the caller). */
/** 持久化思考挡位设置（假定调用方已完成取值校验）。 */
export async function putReasoningSettings(env: Env, settings: ReasoningSettings): Promise<void> {
  await env.KV.put(K_REASONING_SETTINGS, JSON.stringify(settings));
  cacheSet(K_REASONING_SETTINGS, settings);
}

// Shape-check a KV-loaded cache file; malformed entries are dropped instead of
// trusted, mirroring the upstream loader's tolerance for corrupt files.
//
// 校验 KV 中的缓存文件结构；损坏条目直接丢弃而非信任，与上游加载器对
// 损坏文件的容忍行为一致。
function normalizeReasoningCache(raw: unknown): ReasoningCacheFile {
  const out: ReasoningCacheFile = { version: 1, models: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const models = (raw as Record<string, unknown>).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return out;
  for (const [id, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (!Array.isArray(e.supported_efforts)) continue;
    out.models[id] = {
      supported_efforts: e.supported_efforts.filter((x): x is string => typeof x === "string"),
      probed_at: typeof e.probed_at === "number" && Number.isFinite(e.probed_at) ? e.probed_at : 0,
    };
  }
  return out;
}

/** Read the reasoning-effort cache (empty structure when absent/corrupt). */
/** 读取思考挡位缓存（缺失或损坏时返回空结构）。 */
export async function getReasoningCache(env: Env): Promise<ReasoningCacheFile> {
  const cached = cacheGet<ReasoningCacheFile>(K_REASONING_CACHE);
  if (cached) return cached;
  const raw = await env.KV.get(K_REASONING_CACHE, "json");
  const file = normalizeReasoningCache(raw);
  cacheSet(K_REASONING_CACHE, file);
  return file;
}

/** Persist the reasoning-effort cache and refresh the instance copy (readers see it immediately). */
/** 持久化思考挡位缓存并同步实例副本（读取方立即可见）。 */
export async function putReasoningCache(env: Env, file: ReasoningCacheFile): Promise<void> {
  await env.KV.put(K_REASONING_CACHE, JSON.stringify(file));
  cacheSet(K_REASONING_CACHE, file);
}

// --------------------------------------------------------------------------- //
// Error-text parsing
// 报错文本解析
// --------------------------------------------------------------------------- //

/**
 * Pull the accepted effort levels out of an upstream validation error.
 *
 * Two guards make this robust rather than just greedy (mirrors the upstream
 * extract_supported_efforts):
 * 1. The text must mention reasoning_effort -- otherwise an "Input should be"
 *    clause belonging to a *different* field would be misparsed;
 * 2. At least one extracted value must be a known effort level -- otherwise a
 *    same-shape error about an unrelated enum slips through.
 *
 * Returns [] when nothing could be extracted.
 *
 * 从上游校验错误中提取可接受的挡位列表。
 *
 * 两道防线让它比单纯贪心匹配更稳（与上游 extract_supported_efforts 一致）：
 * 1. 文本必须提到 reasoning_effort —— 否则别的字段的 "Input should be"
 *    子句会被误解析；
 * 2. 提取值中至少一个是已知挡位 —— 否则同构的无关枚举错误会漏进来。
 *
 * 提取不到时返回 []。
 */
export function extractSupportedEfforts(errorText: string): string[] {
  if (!errorText || !errorText.includes("reasoning_effort")) return [];
  for (const match of errorText.matchAll(INPUT_SHOULD_RE)) {
    const values = [...match[1].matchAll(QUOTED_RE)].map((q) => q[1]);
    if (values.length > 0 && values.some((v) => KNOWN_EFFORTS.has(v))) {
      return values;
    }
  }
  return [];
}

/** Sort effort levels into canonical order (none -> max); unknown values keep
 *  their original relative order at the end. */
/** 把挡位按规范顺序（none -> max）排序；未知值按原相对顺序排在末尾。 */
export function sortEfforts(efforts: string[]): string[] {
  const known = EFFORT_ORDER.filter((e) => efforts.includes(e));
  const knownSet = new Set(known);
  const unknown = efforts.filter((e) => !knownSet.has(e));
  return [...known, ...unknown];
}

/**
 * Heuristic default: "medium" when supported, otherwise the median of the
 * canonical ordering. The validation error carries no default information,
 * so this is the best honest guess.
 *
 * 启发式默认值：支持 "medium" 就用它，否则取规范顺序的中位数。校验错误里
 * 不包含默认值信息，这是最诚实的一个推断。
 */
export function deriveDefaultEffort(efforts: string[]): string {
  if (efforts.includes("medium")) return "medium";
  const ordered = EFFORT_ORDER.filter((e) => efforts.includes(e));
  if (ordered.length === 0) return efforts[0] ?? "";
  return ordered[Math.floor(ordered.length / 2)];
}

/**
 * Assemble the per-model "reasoning" object served on /v1/models.
 *
 * Field semantics (derived, since the probe only reveals the accepted set):
 *   - supported_efforts: exactly what the upstream validation accepts;
 *   - default_effort:    heuristic (medium / median);
 *   - default_enabled:   true -- the field is accepted, so reasoning is on by
 *                        default as far as the upstream is concerned;
 *   - mandatory:         true when "none" is absent, i.e. thinking cannot be
 *                        turned off at all.
 *
 * Returns null when efforts is empty (nothing presentable).
 *
 * 组装 /v1/models 上每个模型的 "reasoning" 对象。
 *
 * 字段语义（均为推导值，探测只能揭示可接受集合）：
 *   - supported_efforts：上游校验接受的确切集合；
 *   - default_effort：启发式（medium / 中位数）；
 *   - default_enabled：true —— 该字段被接受，就上游而言思考默认开启；
 *   - mandatory：缺少 "none" 时为 true，即完全无法关闭思考。
 *
 * efforts 为空（没有可呈现的信息）时返回 null。
 */
export function buildReasoningInfo(efforts: string[]): ReasoningInfo | null {
  if (efforts.length === 0) return null;
  return {
    supported_efforts: sortEfforts(efforts),
    default_effort: deriveDefaultEffort(efforts),
    default_enabled: true,
    mandatory: !efforts.includes("none"),
  };
}

// --------------------------------------------------------------------------- //
// Probe
// 探测
// --------------------------------------------------------------------------- //

/** Thrown when the upstream answers a probe with 401/403: credentials died
 *  mid-refresh, so the whole round must stop instead of hammering a dead
 *  session once per model. */
/** 上游对探测请求返回 401/403 时抛出：凭证在探测中途失效，整个刷新应立即停止，而不是对每个模型都拿着死凭证再撞一遍。 */
export class ProbeAuthExpired extends Error {}

/**
 * Discover which reasoning_effort levels one model accepts.
 *
 * Sends a minimal completion request carrying the sentinel; the upstream's
 * Literal validation then rejects it with a 400 whose error text enumerates
 * the accepted values. max_tokens=1 bounds the worst case where an upstream
 * ignores the field entirely and actually generates.
 *
 * Return values:
 *   - string[]: probe succeeded;
 *   - []:       upstream accepted the sentinel without validating (no info,
 *               but remember it so we do not re-probe every refresh);
 *   - null:     probe failed (network/HTTP error, unparseable error) --
 *               retry on the next refresh.
 *
 * 探测单个模型接受哪些 reasoning_effort 挡位。
 *
 * 发送一个携带哨兵值的最小补全请求；上游的 Literal 校验会以 400 拒绝它，
 * 错误文本恰好枚举可接受的值。max_tokens=1 兜住最坏情况——上游完全忽略
 * 该字段并真的生成时，代价也只有 1 个 token。
 *
 * 返回值：
 *   - string[]：探测成功；
 *   - []：上游未校验直接接受（拿不到信息，但记住它，避免每轮重探）；
 *   - null：探测失败（网络/HTTP 错误、错误体解析不出）——下次刷新再试。
 */
async function probeModelEfforts(
  session: StoredSession,
  prefix: string,
  modelId: string,
  timeoutSec: number,
): Promise<string[] | null> {
  const payload = {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
    reasoning_effort: PROBE_SENTINEL,
  };
  let resp: Response;
  try {
    resp = await fetch(`${session.base_url}${prefix}/chat/completions`, {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
  } catch {
    // Network error / timeout: transient, retried on the next refresh.
    // 网络错误 / 超时：暂时性失败，留给下次刷新重试。
    return null;
  }
  try {
    if (AUTH_FAILURE_CODES.includes(resp.status)) {
      throw new ProbeAuthExpired(String(resp.status));
    }
    if (resp.status === 200) {
      // Upstream ignored the sentinel: no validation, no information.
      // 上游忽略了哨兵值：没有校验，也就没有信息。
      return [];
    }
    // 400/422 are the expected outcome; anything else (404 model vanished,
    // 5xx) is treated as a transient failure worth retrying later.
    //
    // 400/422 才是预期结果；其它状态（404 模型消失、5xx）视为暂时性
    // 失败，留给下次刷新重试。
    if (resp.status !== 400 && resp.status !== 422) return null;
    const text = await resp.text();
    const efforts = extractSupportedEfforts(text);
    return efforts.length > 0 ? efforts : null;
  } finally {
    // Release the (possibly unconsumed) body to free the connection.
    // 释放（可能未读取的）响应体，归还连接。
    void resp.body?.cancel().catch(() => {});
  }
}

/**
 * Fetch the current upstream model id list. Mirrors proxy.normalizeModel's
 * id extraction (id ?? name ?? model) without importing it, keeping the
 * proxy <-> reasoning dependency one-directional.
 *
 * Returns null when the list could not be retrieved (caller skips the round).
 *
 * 拉取当前上游的模型 id 列表。id 提取逻辑与 proxy.normalizeModel
 * （id ?? name ?? model）保持一致，但不导入它，让 proxy 与 reasoning
 * 保持单向依赖。
 *
 * 拉取失败时返回 null（调用方跳过本轮刷新）。
 */
async function fetchUpstreamModelIds(
  session: StoredSession,
  timeoutSec: number,
): Promise<{ prefix: string; ids: string[] } | null> {
  for (const prefix of PREFIX_CANDIDATES) {
    let resp: Response;
    try {
      resp = await fetch(`${session.base_url}${prefix}/models`, {
        headers: sessionHeaders(session),
        signal: AbortSignal.timeout(timeoutSec * 1000),
      });
    } catch {
      continue;
    }
    try {
      if (resp.status === 404) continue; // route does not exist, try the next prefix
      if (AUTH_FAILURE_CODES.includes(resp.status)) {
        throw new ProbeAuthExpired(String(resp.status));
      }
      if (resp.status !== 200) return null;
      const payload: unknown = await resp.json().catch(() => null);
      if (!payload || typeof payload !== "object") return null;
      const list = Array.isArray(payload)
        ? payload
        : (() => {
            const obj = payload as Record<string, unknown>;
            for (const key of ["data", "items", "models"]) {
              if (Array.isArray(obj[key])) return obj[key] as unknown[];
            }
            return [];
          })();
      const ids = list
        .map((item) => {
          if (typeof item === "string") return item;
          if (!item || typeof item !== "object") return "";
          const obj = item as Record<string, unknown>;
          const id = obj.id ?? obj.name ?? obj.model;
          return typeof id === "string" || typeof id === "number" ? String(id) : "";
        })
        .filter((id) => id.length > 0);
      return { prefix, ids };
    } finally {
      void resp.body?.cancel().catch(() => {});
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Refresh orchestration
// 刷新编排
// --------------------------------------------------------------------------- //

/** Refresh outcome counters, surfaced to the admin console. */
/** 刷新统计计数，展示在管理控制台。 */
export interface RefreshStats {
  /** Models whose probe returned a non-empty effort set. */
  /** 探测到非空挡位集合的模型数。 */
  probed: number;
  /** Models where the upstream accepted the sentinel without validating. */
  /** 上游未校验哨兵（不可探测）的模型数。 */
  unknown: number;
  /** Models whose probe failed (retried on the next refresh). */
  /** 探测失败的模型数（下次刷新重试）。 */
  failed: number;
  /** True when the round was aborted by a 401/403 mid-probe. */
  /** 探测中途因 401/403 被中止时为 true。 */
  authExpired: boolean;
  /** Number of models selected for probing this round. */
  /** 本轮选入待探测集合的模型数。 */
  total: number;
  /** Number of cache entries after reconciliation (models still upstream). */
  /** 对齐后缓存条目数（仍在上游的模型）。 */
  cached: number;
}

/** Refresh could not even start: no usable session, or the model list was
 *  unreachable. */
/** 刷新无法启动：session 不可用，或模型列表拉取失败。 */
export class ReasoningRefreshError extends Error {
  constructor(public readonly code: "session_missing" | "models_failed") {
    super(code);
    this.name = "ReasoningRefreshError";
  }
}

// In-flight refresh dedup, keyed by base_url, per isolate. Prevents a burst of
// /v1/models requests from stacking up concurrent probe rounds (and KV writes)
// for the same upstream.
//
// 进行中刷新去重，按 base_url 键控，按 isolate 存放。避免 /v1/models 请求
// 突发时对同一上游叠加多轮并发探测（以及并发 KV 写入）。
const inFlight = new Map<string, Promise<RefreshStats>>();

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Reconcile the cache with the current model list, probe whatever is missing
 * or expired, persist once at the end, and return the counters.
 *
 * With force=false (the lazy /v1/models path) this is a no-op when the cache
 * already covers every current model within the auto-refresh granularity --
 * i.e. refreshInterval seconds (0 disables auto-refresh entirely, leaving
 * only the manual admin trigger). force=true (admin refresh button) probes
 * every current model regardless.
 *
 * Whatever was collected before an auth-expiry abort is still persisted,
 * mirroring the upstream's save-before-return behavior. The single write per
 * round also keeps us clear of KV same-key write-rate limits.
 *
 * 将缓存与当前模型列表对齐，探测缺失或过期的模型，最后统一持久化一次，
 * 并返回统计计数。
 *
 * force=false（/v1/models 惰性路径）时，若缓存已在自动刷新粒度内覆盖全部
 * 当前模型则什么都不做——即 refreshInterval 秒（0 表示完全关闭自动刷新，
 * 仅保留管理端手动触发）。force=true（管理端刷新按钮）时无条件重探全部
 * 当前模型。
 *
 * 凭证失效中止前收集到的结果仍然落盘，与上游"保存后再返回"的行为一致；
 * 每轮仅写一次 KV 也规避了同键写入限流。
 */
export async function refreshReasoningCache(
  env: Env,
  opts: { force?: boolean } = {},
): Promise<RefreshStats> {
  const session = await getSession(env);
  const usable = Boolean(
    session &&
      ((session.authorization && session.authorization.trim()) ||
        (session.cookie && session.cookie.trim())),
  );
  if (!session || !usable) {
    throw new ReasoningRefreshError("session_missing");
  }

  const force = opts.force === true;
  const key = session.base_url;
  if (!force) {
    const running = inFlight.get(key);
    if (running) return running;
  }
  const task = doRefresh(env, session, force).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function doRefresh(
  env: Env,
  session: StoredSession,
  force: boolean,
): Promise<RefreshStats> {
  const settings = await getReasoningSettings(env);
  const fetched = await fetchUpstreamModelIds(session, settings.timeout);
  if (!fetched) {
    throw new ReasoningRefreshError("models_failed");
  }

  const cache = await getReasoningCache(env);
  const now = nowSec();

  // Reconcile: drop entries for models that no longer exist upstream (a
  // disappearing model frees its cache slot; a re-added model is probed
  // again because its entry was removed), then select what to probe:
  // force -> everything; otherwise missing entries, plus entries older than
  // the auto-refresh granularity.
  //
  // 对齐：清除上游已不存在的模型条目（模型消失即释放缓存槽位；重新上架的
  // 模型因条目已删会再次探测），然后选出待探测集合：force 时为全部当前
  // 模型；否则为缓存缺失的，加上超过自动刷新粒度的过期条目。
  const models: ReasoningCacheFile["models"] = {};
  for (const id of fetched.ids) {
    const entry = cache.models[id];
    if (entry) models[id] = entry;
  }
  const toProbe: string[] = [];
  for (const id of fetched.ids) {
    if (force) {
      toProbe.push(id);
      continue;
    }
    const entry = models[id];
    if (!entry) {
      toProbe.push(id);
      continue;
    }
    if (settings.refreshInterval > 0 && entry.probed_at + settings.refreshInterval <= now) {
      toProbe.push(id);
    }
  }

  const stats: RefreshStats = {
    probed: 0,
    unknown: 0,
    failed: 0,
    authExpired: false,
    total: toProbe.length,
    cached: Object.keys(models).length,
  };
  const result: ReasoningCacheFile = { version: 1, models };

  if (toProbe.length > 0) {
    let next = 0;
    let expired = false;
    const workerCount = Math.min(Math.max(settings.concurrency, 1), toProbe.length);
    const workers = Array.from({ length: workerCount }, async () => {
      // A 401/403 sets `expired` so the remaining workers stop after their
      // in-flight probe instead of hammering the dead session per model.
      //
      // 401/403 会置 `expired`，其余 worker 在完成手头探测后即停止，
      // 而不是对每个模型都拿着死凭证再撞一遍。
      while (!expired) {
        const index = next++;
        if (index >= toProbe.length) return;
        const modelId = toProbe[index];
        try {
          const efforts = await probeModelEfforts(
            session,
            fetched.prefix,
            modelId,
            settings.timeout,
          );
          const probedAt = nowSec();
          if (efforts === null) {
            stats.failed++;
          } else if (efforts.length === 0) {
            stats.unknown++;
            // Empty set is meaningful: "probed, but unprobeable" -- remember
            // it so the model is not re-probed until the entry expires.
            //
            // 空集合是有意义的：记录"已探测但不可探测"，在条目过期前
            // 不会重探该模型。
            result.models[modelId] = { supported_efforts: [], probed_at: probedAt };
          } else {
            stats.probed++;
            result.models[modelId] = { supported_efforts: efforts, probed_at: probedAt };
          }
        } catch (err) {
          if (err instanceof ProbeAuthExpired) {
            expired = true;
            stats.authExpired = true;
            return;
          }
          // Per-model isolation: one bad probe never kills the round.
          // 逐模型隔离：单个探测失败不影响整轮。
          stats.failed++;
        }
      }
    });
    await Promise.all(workers);
  }

  // Persist exactly once per round -- including partial results collected
  // before an auth-expiry abort.
  //
  // 每轮只写一次 KV —— 凭证失效中止前的部分结果同样落盘。
  await putReasoningCache(env, result);
  return stats;
}
