/**
 * Probe runtime decisions: the small pieces of policy the Durable Object needs,
 * kept pure so they can be tested without workerd.
 *
 * The coordinator itself cannot be imported outside the Workers runtime (it extends
 * `cloudflare:workers`), and it cannot be exercised in every environment. Everything
 * in this file is the part that decides *when* work happens -- the piece whose bugs
 * are silent: a wrong answer either never wakes the queue again (models stay stale
 * until a client happens to ask) or wakes it in a loop (burning the subrequest
 * budget and the free plan's daily quota). Keeping it here means both failure modes
 * are covered by unit tests.
 *
 * 探测运行时决策：Durable Object 需要的少量策略，保持纯函数以便在没有 workerd 的环境
 * 里测试。
 *
 * 协调者本身无法在 Workers 运行时之外导入（它继承 `cloudflare:workers`），也不是每个
 * 环境都能跑它。本文件里的东西是决定"**什么时候**干活"的那部分——它的 bug 是静默的：
 * 算错要么再也不唤醒队列（模型一直停在旧结论，直到恰好有客户端来问），要么循环唤醒
 * （烧掉子请求预算与免费层的日配额）。放在这里，两种失效模式都有单测兜住。
 */

import { modelFingerprint, modelIdOf } from "./modelCatalog.ts";
import type { ModelProbe } from "./types.ts";

/**
 * Raised when a round cannot even start (no session, or the model list is
 * unreachable). Exported so the admin API can turn it into a message.
 *
 * It lives here, next to the other round-scheduling decisions, because the admin API
 * needs it and the coordinator itself cannot be imported outside the Workers runtime
 * (it extends `cloudflare:workers`). Keeping the error class out of that module lets
 * the admin routes stay testable under plain Node.
 *
 * 轮次连启动条件都不具备时抛出（无会话，或模型列表不可达）。导出以便管理端转成提示。
 *
 * 它放在这里，与其它轮次调度决策相邻：管理端需要它，而协调者本身无法在 Workers 运行时
 * 之外导入（它继承 `cloudflare:workers`）。把这个错误类留在那个模块之外，使管理端路由
 * 能在普通 Node 下被测试。
 */
export class RoundUnavailable extends Error {
  readonly code: "session_missing" | "models_failed";

  constructor(code: "session_missing" | "models_failed") {
    super(code);
    // Embed the code in the NAME as well: Durable Object RPC keeps only `name`
    // and `message` across the boundary, and the admin router parses the code
    // back out of the name — an explicit coupling instead of an incidental one.
    //
    // 把 code 同时嵌进 name：Durable Object RPC 跨边界只保留 name 与 message，
    // 管理端路由从 name 中解析出 code——让这层耦合显式化，而不是凭巧合成立。
    this.name = `RoundUnavailable:${code}`;
    this.code = code;
  }
}

/** What a caller wants probed, reduced to what "can I join?" needs to know. */
/** 调用方想要探测的内容，收敛为"能否加入"所需的信息。 */
export interface RoundRequest {
  /** Re-probe every model regardless of the cache (admin "probe now"). */
  /** 无视缓存重探全部模型（管理端「立即探测」）。 */
  force: boolean;
  /** The models this request wants probed; undefined = the whole upstream list. */
  /** 本请求想要探测的模型；undefined 表示上游完整列表。 */
  only?: readonly string[];
}

/**
 * Whether a caller may join the round already in flight instead of queueing behind it.
 *
 * Joining blindly (the old behaviour) silently swallowed admin actions: a forced
 * re-probe that joined a request-driven subset round did NOT force anything, yet the
 * admin was shown that unrelated round's statistics -- and `probeOne` could return a
 * summary that did not even mention the model it was asked about.
 *
 * A join is safe only when the running round is at least as thorough and covers at
 * least the same models:
 *   - it must be at least as forceful (`force` cannot be dropped), and
 *   - a request for the whole list can only join a whole-list round, while a request
 *     for specific models may join a whole-list round or one covering those models.
 *
 * 调用方能否加入正在飞的轮次，而不是排在它后面。
 *
 * 盲目加入（旧行为）会静默吞掉管理端动作：一次强制重探若加入了请求驱动的子集轮，实际上
 * 什么都没强制，管理端却看到那个无关轮次的统计；`probeOne` 甚至可能返回一份根本没提到
 * 它要探的那个模型的汇总。
 *
 * 只有当在途轮次至少同样彻底、且至少覆盖同样的模型时，加入才是安全的：
 *   - 它的强制程度不能更低（`force` 不能被降级）；
 *   - 全量请求只能加入全量轮次，而指定模型的请求可以加入全量轮次或覆盖这些模型的轮次。
 */
export function canJoinRound(running: RoundRequest, request: RoundRequest): boolean {
  if (request.force && !running.force) return false;
  const runningOnly = running.only;
  if (!runningOnly) return true;
  const wanted = request.only;
  if (!wanted) return false;
  return runningOnly.every((modelId) => wanted.includes(modelId));
}

/**
 * Serialize the request a truncated round must hand to its alarm.
 *
 * A round that runs out of budget persists what it was asked to do; the alarm then
 * resumes THAT request instead of a default one. Without this, a forced re-probe
 * ("probe now") silently loses its forcedness on the way to the alarm, which then
 * skips every model that still holds an `ok` conclusion -- so the second half of the
 * list is never re-probed and the console's "the rest continues in the background"
 * would simply be untrue.
 *
 * 序列化被预算截断的轮次必须交给 alarm 的请求。
 *
 * 预算耗尽的轮次会把它被要求做的事落盘；alarm 随后**按原请求**继续，而不是按默认请求。
 * 没有它时，一次强制重探（「立即探测」）会在交给 alarm 的路上悄悄丢掉"强制"属性，
 * 于是 alarm 跳过所有仍持有 `ok` 结论的模型——列表的后半部分永远不会被重探，而控制台
 * 那句"其余由后台继续"就成了假话。
 */
export function pendingRoundMeta(request: RoundRequest): string {
  return JSON.stringify({ force: request.force, only: request.only ?? null });
}

/**
 * Parse that bookkeeping value back.
 *
 * Anything missing, empty or unparseable means "no pending round": a corrupt value
 * must degrade to the default alarm behaviour, never to a crash.
 *
 * 解析该记账值。
 *
 * 缺失、为空或解析不了一律表示"没有待续轮次"：坏值必须退化为默认的 alarm 行为，
 * 绝不能变成崩溃。
 */
export function pendingRoundFromMeta(raw: string | null): RoundRequest | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as { force?: unknown; only?: unknown };
  const only = Array.isArray(record.only)
    ? record.only.filter((id): id is string => typeof id === "string")
    : [];
  return { force: record.force === true, only: only.length > 0 ? only : undefined };
}

/** Never wake sooner than this (milliseconds): an alarm that fires immediately in a
 *  loop is worse than a slightly late probe. */
/** 唤醒最快不早于这个间隔（毫秒）：立刻循环触发的 alarm 比稍晚一点的探测更糟。 */
export const WAKE_MIN_MS = 1_000;

/** Never arm an alarm further out than this (the backoff cap is 6h anyway). */
/** alarm 最远不超过这个时间（退避上限本来也是 6h）。 */
export const WAKE_MAX_MS = 6 * 3600_000;

/**
 * When the queue should next be revisited, in epoch seconds, or null when nothing is
 * waiting.
 *
 * Only `failed` and `partial` entries wait for anything: `ok` and `unprobeable` are
 * conclusive until the engine fingerprint changes, and a fingerprint change is only
 * ever observed from a model list (a request or an alarm's own fetch), never from a
 * timer.
 *
 * 队列下次应该在什么时候再看一眼（Unix 秒），没有等待中的模型时返回 null。
 *
 * 只有 `failed` 与 `partial` 条目在等待：`ok` 与 `unprobeable` 在引擎指纹变化前都是
 * 结论，而指纹变化只能从模型列表观察（来自请求，或 alarm 自己拉取），绝不会来自定时器。
 */
export function retryWakeAtSeconds(
  entries: Iterable<readonly [string, ModelProbe]>,
  now: number,
): number | null {
  let earliest: number | null = null;
  for (const [, probe] of entries) {
    if (probe.status !== "failed" && probe.status !== "partial") continue;
    const at = Math.max(probe.retry_after, now + WAKE_MIN_MS / 1000);
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * How long to wait before the next alarm, in milliseconds, or null when the alarm
 * should be cleared. Always within [WAKE_MIN_MS, WAKE_MAX_MS].
 *
 * 距离下一个 alarm 还有多久（毫秒）；应清除 alarm 时返回 null。始终落在
 * [WAKE_MIN_MS, WAKE_MAX_MS] 内。
 */
export function retryWakeDelayMs(
  entries: Iterable<readonly [string, ModelProbe]>,
  now: number,
  bounds: { minMs?: number; maxMs?: number } = {},
): number | null {
  const earliest = retryWakeAtSeconds(entries, now);
  if (earliest === null) return null;
  const minMs = bounds.minMs ?? WAKE_MIN_MS;
  const maxMs = bounds.maxMs ?? WAKE_MAX_MS;
  return Math.min(Math.max((earliest - now) * 1000, minMs), maxMs);
}

// --------------------------------------------------------------------------- //
// Heartbeat wake axis (the optional patrol)
// 心跳唤醒轴（可选巡检）
// --------------------------------------------------------------------------- //

/**
 * The earlier of the two wake axes -- the backoff deadline and the next heartbeat
 * tick -- or null when NEITHER has anything pending. This is the whole scheduling
 * rule for the single alarm: a heartbeat must never pull a backoff wake earlier than
 * the backoff itself, and with the heartbeat off (null tick) the backoff axis keeps
 * exactly its old shape.
 *
 * 两条唤醒轴——退避到期与下一次心跳刻度——中较早者；两者皆无待办时返回 null。这就是
 * 唯一 alarm 的全部排程规则：心跳绝不能把退避唤醒提前到退避本身之前，而心跳关闭
 * （刻度为 null）时，退避轴保持与从前完全一致的形态。
 */
export function nextWakeAtSeconds(retryAt: number | null, heartbeatAt: number | null): number | null {
  if (retryAt === null) return heartbeatAt;
  if (heartbeatAt === null) return retryAt;
  return Math.min(retryAt, heartbeatAt);
}

/**
 * Whether the stored heartbeat tick has arrived. A missing tick (heartbeat off, or no
 * tick persisted yet) is never due: "due" must come from something an operator opted
 * into, never from an absent value.
 *
 * 已存储的心跳刻度是否已到期。缺失的刻度（心跳关闭，或尚未落盘）永不到期："到期"
 * 必须来自运维主动开启的东西，绝不能来自一个不存在的值。
 */
export function heartbeatDue(next: number | null, now: number): boolean {
  return next !== null && next <= now;
}

/**
 * Parse the persisted heartbeat tick (coordinator meta key `heartbeat_next`).
 *
 * Empty or unparseable means "no tick" -- the caller then anchors a fresh one a full
 * interval out. A parseable number is kept as-is, INCLUDING one in the past: a tick
 * that already passed is exactly "the heartbeat is due", and degrading it to "no
 * tick" would postpone the patrol by another whole interval.
 *
 * 解析已落盘的心跳刻度（协调者 meta 键 `heartbeat_next`）。
 *
 * 空 或解析不了一律表示"没有刻度"——调用方随后向外锚定一个完整间隔后的新刻度。
 * 能解析的数字原样保留，**包括过去的时间**：已经过去的刻度恰恰意味着"心跳到期"，
 * 把它退化成"没有刻度"会让巡检再推迟整整一个间隔。
 */
export function heartbeatNextFromMeta(raw: string | null): number | null {
  if (!raw || !raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The upstream prefixes to try, remembered one first.
 *
 * Trying the remembered prefix first costs one request when it is right (the normal
 * case) and one wasted request when it is not; trying the canonical order first would
 * cost the same on average but would re-404 on every round for a legacy upstream.
 *
 * 要尝试的上游前缀顺序，把记住的那个放最前。
 *
 * 记住的前缀正确时（常态）这只需要一次请求，不正确时也只多花一次；若总是按规范顺序
 * 先试，平均代价相同，但对旧版上游每一轮都要再撞一次 404。
 */
export function prefixCandidates(
  remembered: string | null | undefined,
  candidates: readonly string[],
): string[] {
  if (!remembered || !candidates.includes(remembered)) return [...candidates];
  return [remembered, ...candidates.filter((prefix) => prefix !== remembered)];
}

/**
 * (modelId, engine fingerprint) for every usable model card, in upstream order.
 *
 * Cards without an id are skipped exactly like the proxy skips them, so the
 * coordinator and the served list agree on which models exist.
 *
 * 每个可用模型卡的 (模型 id, 引擎指纹)，保持上游顺序。
 *
 * 没有 id 的卡片按与代理相同的方式跳过，使协调者与对外列表对"有哪些模型"的判断一致。
 */
export async function refsFromCards(
  cards: readonly unknown[],
): Promise<Array<[string, string]>> {
  // Fingerprints are independent: hash them concurrently instead of serially
  // awaiting one SHA-256 per card. Promise.all preserves input order, so the
  // upstream order is kept.
  //
  // 各指纹相互独立：并发哈希，而不是逐卡串行等待一次 SHA-256。Promise.all 保持
  // 输入顺序，上游顺序不变。
  const work = cards.map(async (card): Promise<[string, string] | null> => {
    const modelId = modelIdOf(card);
    if (!modelId) return null;
    return [modelId, await modelFingerprint(card, modelId)];
  });
  const refs = await Promise.all(work);
  return refs.filter((ref): ref is [string, string] => ref !== null);
}

/**
 * A tiny TTL cache around an async loader.
 *
 * Used for values that are cheap to hold but not free to fetch: the probe settings
 * live in KV, and a Durable Object would otherwise read them ONCE PER REQUEST.
 * Caching them for a few seconds turns that per-request read into a per-window one
 * (at any request rate, the source is hit at most `86400/ttlMs` times a day).
 *
 * The loader runs at most once per window and concurrent callers share a single
 * in-flight load, so a burst cannot stampede the source. A FAILING loader is never
 * cached -- the next call retries immediately, which is what a transient error wants.
 *
 * 围绕异步 loader 的极小 TTL 缓存。
 *
 * 用于"持有很便宜、但获取不免费"的值：探测设置存在 KV 里，而 Durable Object 否则会
 * **每请求读一次**。缓存几秒就把那次读取从"每请求一次"变成"每窗口一次"（无论请求
 * 速率如何，来源每天最多被读 `86400/ttlMs` 次）。
 *
 * loader 每个窗口至多运行一次，且并发调用共享同一个在途加载，因此突发请求不会打爆
 * 来源。**失败绝不缓存**——下一次调用立即重试，这正是瞬时错误想要的。
 */
export function createTtlCache<T>(
  loader: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let cached: { value: T; expireAt: number } | null = null;
  let inFlight: Promise<T> | null = null;

  return () => {
    if (cached && now() < cached.expireAt) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;

    const pending: Promise<T> = loader()
      .then((value) => {
        cached = { value, expireAt: now() + ttlMs };
        return value;
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };
}
