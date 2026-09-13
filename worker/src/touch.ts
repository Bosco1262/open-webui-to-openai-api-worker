/**
 * API-key `last_used` write throttle ("usage tracking granularity").
 *
 * Split out of kv.ts: this is feature logic (when to write `last_used`), not
 * generic KV plumbing. Granularity steps come from intervals.ts and are shared
 * with the reasoning-effort auto-refresh; the persisted value lives in its own
 * KV key and only governs this throttle.
 *
 * API Key `last_used` 写入节流（"使用记录粒度"）。
 *
 * 从 kv.ts 拆分而来：这里属于功能逻辑（何时写入 last_used），而非通用 KV
 * 基础设施。粒度档位来自 intervals.ts，与思考挡位自动刷新共用；持久化的
 * 配置值存放在独立的 KV 键中，仅约束本节流逻辑。
 */

import type { ApiKeyMeta, Env } from "./types.ts";
import { apiKeyKVKey, cacheGet, cacheSet } from "./kv.ts";
import { DEFAULT_INTERVAL, isIntervalOption } from "./intervals.ts";

/** KV key storing the configured `last_used` refresh interval (seconds). */
/** 存储所配置 `last_used` 刷新间隔（秒）的 KV 键。 */
const K_TOUCH_INTERVAL = "settings:touch_interval";

/** Read the configured interval, served from the 60s instance cache. */
/** 读取配置的间隔，优先命中 60 秒实例缓存。 */
export async function getTouchInterval(env: Env): Promise<number> {
  const cached = cacheGet<number>(K_TOUCH_INTERVAL);
  if (cached !== null) return cached;
  const raw = await env.KV.get(K_TOUCH_INTERVAL);
  const interval = raw === null ? NaN : Number(raw);
  const value = isIntervalOption(interval) ? interval : DEFAULT_INTERVAL;
  cacheSet(K_TOUCH_INTERVAL, value);
  return value;
}

/** Persist a new interval; returns false for values outside the allowed set. */
/** 持久化新间隔；不在允许集合内的值返回 false。 */
export async function setTouchInterval(env: Env, seconds: number): Promise<boolean> {
  if (!isIntervalOption(seconds)) return false;
  await env.KV.put(K_TOUCH_INTERVAL, String(seconds));
  cacheSet(K_TOUCH_INTERVAL, seconds);
  return true;
}

// In-instance write markers: key -> last write time (ms). Keeps the throttle
// effective between the KV write and its eventual read-back.
//
// 实例内写入标记：Key -> 最近写入时间（毫秒）。在 KV 写入与其最终读回之间
// 保持节流有效。
const lastTouched = new Map<string, number>();

/**
 * Throttled asynchronous update of `last_used`, executed within `ctx.waitUntil`.
 *
 * - A granularity of 0 switches the feature off: nothing is written, and whatever
 *   history a key has stays in KV but is no longer refreshed or shown;
 * - For a never-used Key (last_used === 0), an immediate write is performed on the first call;
 * - Afterwards, each Key is written at most once per configured granularity (default: daily, adjustable in the management console).
 *
 * The write timestamp takes the greater value between the in-instance record and `last_used` in KV;
 * throttling remains in effect after an isolate restart.
 */
/**
 * 节流的 `last_used` 异步更新，在 `ctx.waitUntil` 内执行。
 *
 * - 粒度为 0 表示关闭该功能：什么都不写，Key 既有的历史数据仍留在 KV 里，但不再
 *   刷新、也不再显示；
 * - 从未使用的 Key（last_used === 0）首次调用立即写入一次；
 * - 之后每个 Key 至多按配置粒度写一次（默认每天，可在管理控制台调整）。
 * 写入时间取「实例内记录」与「KV 中 last_used」的较大者，isolate 重启后依然节流。
 */
export async function touchApiKey(env: Env, key: string, meta: ApiKeyMeta): Promise<void> {
  // One read serves the whole call; the second read this replaces was pure
  // redundancy (the instance cache makes it cheap, but not free).
  //
  // 一次读取服务整个调用；被替换的第二次读取纯属冗余（实例缓存让它便宜，但不免费）。
  const interval = await getTouchInterval(env);
  // The off switch is checked before the first-use write: "off" must mean no write
  // at all, not "one write and then never again".
  //
  // 关闭开关要在"首次使用写入"之前判断：关就是一次都不写，而不是"写一次以后再也不写"。
  if (interval === 0) return;
  const now = Date.now();
  // A never-used key is recorded immediately on its first call.
  // 从未使用的 Key 在首次调用时立即记录。
  if (!meta.last_used) {
    lastTouched.set(key, now);
    await env.KV.put(apiKeyKVKey(key), JSON.stringify({ ...meta, last_used: Math.floor(now / 1000) }));
    return;
  }
  const intervalMs = interval * 1000;
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
  await env.KV.put(apiKeyKVKey(key), JSON.stringify({ ...meta, last_used: Math.floor(now / 1000) }));
}
