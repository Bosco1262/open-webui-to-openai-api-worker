/**
 * Shared granularity options for periodic, KV-write-throttled features.
 *
 * The API-key `last_used` write throttle ("usage tracking granularity")
 * uses this set of short-period to daily steps, so the UI shows one consistent set
 * of time options and the
 * server-side validation has a single source of truth. The *setting values*
 * themselves stay independent per feature; only the offered steps are shared.
 *
 * 周期性、按 KV 写入节流的共用量表。
 *
 * API Key `last_used` 写入节流（"使用记录粒度"）使用同一组"短周期到每天"的档位，
 * 使界面只呈现一套一致的时间选项，服务端
 * 校验也有唯一事实来源。各功能的*设置值*相互独立，共享的只是可选档位。
 */

/** Allowed granularity steps in seconds (30 minutes to daily). */
/** 允许的粒度档位（秒），从每三十分钟到每天。 */
export const INTERVAL_OPTIONS: readonly number[] = [86_400, 21_600, 10_800, 3_600, 1_800];

/** Default granularity (once per day). */
/** 默认粒度（每天一次）。 */
export const DEFAULT_INTERVAL = 86_400;

/** Whether `seconds` is one of the offered granularity steps. */
/** `seconds` 是否命中某个可选档位。 */
export function isIntervalOption(seconds: number): boolean {
  return (INTERVAL_OPTIONS as readonly number[]).includes(seconds);
}
