/**
 * API-key `last_used` write throttle ("usage tracking granularity").
 *
 * Usage is recorded under its OWN key (`usage:<sha256(key)>`, see kv.ts), never in
 * the credential record. That separation is the point: the previous implementation
 * rewrote the whole credential record (`apikey:<key>`) from `ctx.waitUntil` to bump
 * `last_used`, so a write racing a revoke could RE-CREATE a key that had just been
 * deleted -- an undo of a security action, with permanent effect. Writing to a
 * separate namespace makes that class of race structurally impossible.
 *
 * Granularity steps come from intervals.ts and are shared with the reasoning-effort
 * auto-refresh; the persisted value lives in its own KV key and only governs this
 * throttle. `last_used` on the console is now read from the usage records; the
 * `last_used` field still present in old credential records is shown as a fallback.
 *
 * API Key `last_used` 写入节流（"使用记录粒度"）。
 *
 * 使用记录写在**自己的**键下（`usage:<sha256(key)>`，见 kv.ts），绝不写进凭据记录。
 * 这一分离正是要点：旧实现会从 `ctx.waitUntil` 里重写整条凭据记录（`apikey:<key>`）
 * 来刷新 `last_used`，因此一次与"撤销"并发的写入可以把刚被删除的 Key **重建**出来
 * ——一次安全操作的撤销被回滚，且后果永久。写到独立命名空间使这类竞态在结构上不可能
 * 发生。
 *
 * 粒度档位来自 intervals.ts，与思考挡位自动刷新共用；持久化的配置值存放在独立的 KV
 * 键中，仅约束本节流逻辑。控制台上的 `last_used` 现在从使用记录读出；旧凭据记录里
 * 仍存在的 `last_used` 字段作为回退展示。
 */

import type { Env } from "./types.ts";
import { cacheGet, cacheSet, usageKVName } from "./kv.ts";
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

// In-instance write markers: key id -> last write time (ms). Keeps the throttle
// effective between the KV write and its eventual read-back, and (with the stored
// usage record) avoids a KV read on the steady-state hot path.
//
// 实例内写入标记：Key id -> 最近写入时间（毫秒）。在 KV 写入与其最终读回之间保持节流
// 有效，并且（配合已存储的使用记录）让稳态热路径省掉一次 KV 读取。
const lastTouched = new Map<string, number>();

/** The stored last-used timestamp (unix seconds) of a key, 0 when never recorded. */
/** 某把 Key 已存储的最近使用时刻（Unix 秒）；从未记录时为 0。 */
export async function readApiKeyUsage(env: Env, id: string): Promise<number> {
  const raw = await env.KV.get(usageKVName(id));
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Usage records for many keys at once (the console's key table). */
/** 一次性读取多把 Key 的使用记录（控制台的 Key 表）。 */
export async function readApiKeyUsages(
  env: Env,
  ids: readonly string[],
): Promise<Record<string, number>> {
  const pairs = await Promise.all(
    ids.map(async (id) => [id, await readApiKeyUsage(env, id)] as const),
  );
  return Object.fromEntries(pairs);
}

/**
 * Throttled asynchronous update of `last_used`, executed within `ctx.waitUntil`.
 *
 * - A granularity of 0 switches the feature off: nothing is written at all;
 * - For a never-used key, the first call records immediately;
 * - Afterwards each key is written at most once per configured granularity
 *   (default: daily, adjustable in the management console).
 *
 * Nothing here can ever touch a credential record -- see this module's header.
 *
 * 节流的 `last_used` 异步更新，在 `ctx.waitUntil` 内执行。
 *
 * - 粒度为 0 表示关闭该功能：一次都不写；
 * - 从未使用的 Key 在首次调用时立即记录一次；
 * - 之后每把 Key 至多按配置粒度写一次（默认每天，可在管理控制台调整）。
 *
 * 这里的一切都不可能碰到凭据记录——见本模块头部说明。
 */
export async function touchApiKey(env: Env, id: string): Promise<void> {
  const interval = await getTouchInterval(env);
  // The off switch is checked before the first-use write: "off" must mean no write
  // at all, not "one write and then never again".
  //
  // 关闭开关要在"首次使用写入"之前判断：关就是一次都不写，而不是"写一次以后再也不写"。
  if (interval === 0) return;
  const now = Date.now();
  const marker = lastTouched.get(id) ?? 0;
  if (marker !== 0 && now - marker < interval * 1000) return;
  // Not recently written BY THIS ISOLATE: the persisted record decides, so a fresh
  // isolate does not rewrite what a previous one wrote a moment ago.
  //
  // 本 isolate 最近没写过：由已落盘的记录决定，避免新 isolate 重写上一个刚刚写过的值。
  const stored = await readApiKeyUsage(env, id);
  if (stored !== 0 && now / 1000 - stored < interval) {
    lastTouched.set(id, now);
    return;
  }
  lastTouched.set(id, now);
  // Write off the critical path so the response is not delayed.
  // 写入不阻塞关键路径，避免拖慢响应。
  await env.KV.put(usageKVName(id), String(Math.floor(now / 1000)));
}

/** Drop the in-instance write marker (the key was deleted or rotated). */
/** 清除实例内的写入标记（Key 已删除或轮转）。 */
export function clearTouchMarker(id: string): void {
  lastTouched.delete(id);
}

/** Drop a revoked key's usage record along with its in-instance marker. */
/** 撤销 Key 时一并清除其使用记录与实例内标记。 */
export async function deleteApiKeyUsage(env: Env, id: string): Promise<void> {
  clearTouchMarker(id);
  await env.KV.delete(usageKVName(id));
}
