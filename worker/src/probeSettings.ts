/**
 * Probe settings (KV key: "settings:probe").
 *
 * The upstream Python project configures the probe with environment variables
 * (`MODEL_PROBE_CONCURRENCY`, `MODEL_PROBE_TIMEOUT`, `MODEL_PROBE_WAIT`,
 * `EXPOSE_INSTANCE_META`). A Worker has no process restart to pick those up, and
 * this project already keeps operator-tunable knobs in KV behind the admin console,
 * so the settings live there instead -- same meaning, same defaults.
 *
 * `MODEL_PROBE_CONCURRENCY` is deliberately NOT carried over: rounds are serial
 * (one model at a time), because an invocation may only have six connections
 * waiting for response headers and a serial round needs one. `refreshInterval` (this
 * project's old time-based TTL) is gone too: the upstream design re-probes on an
 * engine fingerprint change or when a previous attempt left the answer open, not on
 * a clock.
 *
 * 探测设置（KV 键名："settings:probe"）。
 *
 * 上游 Python 项目用环境变量配置探测（`MODEL_PROBE_CONCURRENCY`、
 * `MODEL_PROBE_TIMEOUT`、`MODEL_PROBE_WAIT`、`EXPOSE_INSTANCE_META`）。Worker 没有
 * 进程重启来读取它们，而本项目已经把运维可调的旋钮放在 KV 里、由管理控制台管理，
 * 因此设置就放在那里——含义与默认值保持一致。
 *
 * `MODEL_PROBE_CONCURRENCY` 刻意不搬：轮次是串行的（一次一个模型），因为单次调用
 * 最多只能有六个连接处于"等待响应头"状态，而串行轮次只需要一个。旧的时间型 TTL
 * `refreshInterval` 也一并去掉：上游设计只在引擎指纹变化、或上次尝试没有定论时才
 * 重探，而不是按钟表。
 */

import { cacheGet, cacheSet, readKvJson } from "./kv.ts";
import type { Env, ProbeSettings } from "./types.ts";

/** KV key holding the probe settings. */
/** 存储探测设置的 KV 键。 */
const K_PROBE_SETTINGS = "settings:probe";

/** Defaults mirror the upstream project: on, 30s requests, a 5s bounded wait.
 *  `budget` is the worker-specific one: the free plan allows 50 subrequests per
 *  invocation and a typical model costs ~10 of them (worst case ~20). */
/** 默认值与上游项目一致：开启、请求 30 秒、有界等待 5 秒。`budget` 是 worker 特有的：
 *  免费层单次调用上限 50 个子请求，而一个模型典型消耗约 10 个（最坏约 20 个）。 */
const DEFAULT_PROBE_SETTINGS: ProbeSettings = {
  enabled: true,
  timeout: 30,
  wait: 5,
  budget: 40,
  exposeInstanceMeta: true,
};

/** Budget presets offered by the admin console, with the documented ceilings. */
/** 管理控制台提供的预算预设，附各自的平台上限。 */
export const PROBE_BUDGET_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 40, label: "free" },
  { value: 2000, label: "paid" },
];

/** Hard bounds for the settings an operator may write. */
/** 运维可写设置的硬边界。 */
const PROBE_SETTINGS_BOUNDS = {
  timeout: { min: 1, max: 120 },
  wait: { min: 0, max: 30 },
  budget: { min: 4, max: 9000 },
} as const;

// Field-by-field validation with clamping; anything invalid falls back to its
// default so a corrupt or partially-written KV value can never break the proxy.
//
// 逐字段校验并夹紧取值范围；任何非法值都回退默认，损坏或写一半的 KV 数据永远不会
// 破坏代理路径。
function normalizeProbeSettings(raw: unknown): ProbeSettings {
  const out: ProbeSettings = { ...DEFAULT_PROBE_SETTINGS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  if (typeof obj.exposeInstanceMeta === "boolean") {
    out.exposeInstanceMeta = obj.exposeInstanceMeta;
  }
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  };
  out.timeout = clamp(
    obj.timeout,
    PROBE_SETTINGS_BOUNDS.timeout.min,
    PROBE_SETTINGS_BOUNDS.timeout.max,
    out.timeout,
  );
  out.wait = clamp(obj.wait, PROBE_SETTINGS_BOUNDS.wait.min, PROBE_SETTINGS_BOUNDS.wait.max, out.wait);
  out.budget = clamp(
    obj.budget,
    PROBE_SETTINGS_BOUNDS.budget.min,
    PROBE_SETTINGS_BOUNDS.budget.max,
    out.budget,
  );
  return out;
}

/** Validate a settings payload coming from the admin console (strict, unlike the
 *  tolerant loader: an invalid write is rejected instead of silently clamped). */
/** 校验来自管理控制台（严格，与宽容的读取不同：非法写入会被拒绝而不是静默夹紧）。 */
export function parseProbeSettingsInput(body: Record<string, unknown>): ProbeSettings | null {
  if (typeof body.enabled !== "boolean") return null;
  if (typeof body.expose_instance_meta !== "boolean") return null;
  const integerIn = (value: unknown, min: number, max: number): number | null => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
  };
  const timeout = integerIn(
    body.timeout,
    PROBE_SETTINGS_BOUNDS.timeout.min,
    PROBE_SETTINGS_BOUNDS.timeout.max,
  );
  const wait = integerIn(body.wait, PROBE_SETTINGS_BOUNDS.wait.min, PROBE_SETTINGS_BOUNDS.wait.max);
  const budget = integerIn(
    body.budget,
    PROBE_SETTINGS_BOUNDS.budget.min,
    PROBE_SETTINGS_BOUNDS.budget.max,
  );
  if (timeout === null || wait === null || budget === null) return null;
  return {
    enabled: body.enabled,
    timeout,
    wait,
    budget,
    exposeInstanceMeta: body.expose_instance_meta,
  };
}

/** Read the probe settings, optionally from the 60s instance cache. The Durable
 *  Object's alarm path reads them straight from KV so an operator change applies on
 *  the next round. A value that is missing, corrupt or unparseable degrades to the
 *  defaults rather than failing the request that needed it. */
/** 读取探测设置，可选择走 60 秒的实例缓存。Durable Object 的 alarm 路径直接读 KV，
 *  以便运维改动在下一轮生效。取值缺失、损坏或无法解析时回退默认值，而不是让需要它的请求
 *  失败。 */
export async function readProbeSettings(
  env: Env,
  options: { useCache?: boolean } = {},
): Promise<ProbeSettings> {
  if (options.useCache !== false) {
    const cached = cacheGet<ProbeSettings>(K_PROBE_SETTINGS);
    if (cached) return cached;
  }
  // `readKvJson` swallows a malformed value (Cloudflare's `"json"` type throws on
  // one); `normalizeProbeSettings` then fills in whatever is missing or wrong-typed.
  //
  // `readKvJson` 吞掉损坏的值（Cloudflare 的 `"json"` 类型遇到它会抛错）；
  // `normalizeProbeSettings` 随后补齐缺失或类型不对的字段。
  const raw = await readKvJson<unknown>(env.KV, K_PROBE_SETTINGS);
  const settings = normalizeProbeSettings(raw);
  cacheSet(K_PROBE_SETTINGS, settings);
  return settings;
}

/** Persist the probe settings (values are assumed pre-validated by the caller). */
/** 持久化探测设置（假定调用方已完成取值校验）。 */
export async function writeProbeSettings(env: Env, settings: ProbeSettings): Promise<void> {
  await env.KV.put(K_PROBE_SETTINGS, JSON.stringify(settings));
  cacheSet(K_PROBE_SETTINGS, settings);
}
