/**
 * ModelProbeCoordinator: the deployment's single probe coordinator.
 *
 * Why a Durable Object instead of KV (the shape the upstream Python project gets
 * for free from being one long-lived process):
 *
 *   - ONE instance for the whole deployment means no two colos probe the same model,
 *     and a request in one location can wait for a round started in another;
 *   - SQLite rows are strongly consistent and can be written per model (KV is
 *     eventually consistent for up to ~60s and allows one write per second per key);
 *   - an alarm handler gets 15 minutes of wall time, so the queue drains even when
 *     no client is asking -- `ctx.waitUntil` would be cut off 30 seconds after the
 *     response;
 *   - the RPC surface is also the read path, so /v1/models sees exactly the facts the
 *     coordinator has, with no separate cache to reconcile.
 *
 * The budget still applies: one invocation may spend at most `settings.budget`
 * upstream subrequests. When a round runs out, it persists what it has and arms an
 * alarm to continue, which is why a cold deployment converges over a few seconds
 * instead of one request. The optional heartbeat patrol rides the SAME single alarm:
 * its tick is the wake-at-latest bound (the wake is `min(backoff, tick)`), so an idle
 * deployment can be aligned every few hours for the cost of one model-list pull --
 * never a new trigger type, never a forced re-probe.
 *
 * ModelProbeCoordinator：本部署唯一的探测协调者。
 *
 * 为什么用 Durable Object 而不是 KV（上游 Python 项目靠"单个长驻进程"天然获得的形态）：
 *
 *   - 全部署唯一实例，因此不会有两个机房同时探同一个模型，一个机房的请求也能等待
 *     另一个机房起的轮次；
 *   - SQLite 行是强一致的，且可以"每模型一次写入"（KV 最长约 60 秒最终一致，且
 *     单键每秒只能写一次）；
 *   - alarm 处理器有 15 分钟墙钟，因此没有客户端访问时队列也能排空——`ctx.waitUntil`
 *     在响应之后 30 秒就会被切断；
 *   - RPC 面同时就是读取路径，因此 /v1/models 看到的正是协调者掌握的事实，不存在
 *     需要对齐的第二份缓存。
 *
 * 预算依然生效：单次调用最多花 `settings.budget` 个上游子请求。一轮用完就落盘已有
 * 结果并安排 alarm 继续，这也是冷启动能在几秒内收敛、而不是靠一次请求跑完的原因。
 * 可选的心跳巡检复用**同一个** alarm：它的刻度是"最晚唤醒"的上界（唤醒时刻取
 * `min(退避, 刻度)`），因此空闲部署可以每隔几小时花一次拉模型列表的代价完成对齐——
 * 不新增触发器类型，也绝不是强制重探。
 */

import { DurableObject } from "cloudflare:workers";

import { ModelProbeCache } from "./modelProbe.ts";
import { extractModelList, isModelListPayload } from "./modelCatalog.ts";
import {
  RoundUnavailable,
  WAKE_MAX_MS,
  WAKE_MIN_MS,
  canJoinRound,
  createTtlCache,
  heartbeatDue,
  heartbeatNextFromMeta,
  nextWakeAtSeconds,
  pendingRoundFromMeta,
  pendingRoundMeta,
  prefixCandidates,
  refsFromCards,
  retryWakeAtSeconds,
  retryWakeDelayMs,
} from "./probeRuntime.ts";
import type { RoundRequest } from "./probeRuntime.ts";
import { SqliteProbeStore } from "./probeStore.ts";
import {
  ProbeAuthExpired,
  ProbeBudgetExhausted,
  ProbeTransient,
  isPlatformSubrequestError,
  runProbeRound,
} from "./probeRound.ts";
import type { ProbeAnswer, ProbeTransport } from "./probeRound.ts";
import { readProbeSettings } from "./probeSettings.ts";
import { getSession } from "./kv.ts";
import { fetchUpstream, sessionHeaders, sessionIsUsable } from "./session.ts";
import { AUTH_FAILURE_CODES, PREFIX_CANDIDATES, confirmUpstreamPrefix } from "./upstream.ts";
import {
  INSTANCE_CONFIG_PATH,
  INSTANCE_CONFIG_TIMEOUT_MS,
  K_INSTANCE_META,
  applyInstanceConfig,
  isInstanceMetaFresh,
  parseInstanceConfig,
  parseInstanceMeta,
  sameCapabilities,
} from "./instanceMeta.ts";
import type {
  Env,
  InstanceMeta,
  ModelProbe,
  ModelProbeFields,
  ProbeRoundStats,
  ProbeSettings,
  StoredSession,
} from "./types.ts";

/** Bookkeeping key for the resolved upstream prefix. */
/** 已确定的上游前缀的记账键。 */
const META_PREFIX_KEY = "upstream_prefix";

/** Bookkeeping key for the round request a budget-truncated round hands to its alarm. */
/** 被预算截断的轮次交给 alarm 的轮次请求的记账键。 */
const META_PENDING_ROUND_KEY = "pending_round";

/**
 * Bookkeeping key for an ADMIN-requested round (written by `refreshInBackground`,
 * consumed by the alarm). The heavy work runs on the alarm machinery on purpose:
 * a full round can outlive a request's `waitUntil` budget (~30s), while the alarm
 * handler gets 15 minutes of wall time and the existing pending/backoff machinery
 * already knows how to resume a truncated round.
 *
 * 管理端请求的轮次的记账键（由 `refreshInBackground` 写入、alarm 消费）。重活刻意
 * 交给 alarm 机制：完整轮次可能超出请求的 `waitUntil` 预算（约 30 秒），而 alarm
 * 处理器有 15 分钟墙钟，且既有的 pending/退避机制本就知道如何续跑被截断的轮次。
 */
const META_REQUESTED_ROUND_KEY = "requested_round";

/** Bookkeeping key for the next heartbeat tick (epoch seconds). Persisted in the meta
 *  table so the patrol survives eviction: an in-memory-only tick would be re-derived
 *  "a full interval out" on every wake and never actually fire. */
/** 下一次心跳刻度（Unix 秒）的记账键。持久化在 meta 表使巡检跨驱逐存活：只放在内存
 *  的刻度会在每次唤醒时被重新推导成"一个完整间隔之后"，永远不会真正触发。 */
const META_HEARTBEAT_KEY = "heartbeat_next";

/** How soon to continue when a round ran out of budget (milliseconds). */
/** 预算耗尽后多久继续（毫秒）。 */
const ALARM_CONTINUE_MS = 2_000;

/** How long to wait before retrying when the model list itself was unreachable. */
/** 连模型列表都拿不到时，隔多久重试。 */
const ALARM_RETRY_MS = 300_000;

/** How long the probe settings are cached inside the coordinator (milliseconds).
 *
 *  Without this the coordinator reads the settings from KV on EVERY call, which
 *  doubled the KV reads of a `/v1/models` request. Fifteen seconds is far shorter
 *  than the Worker-side 60s instance cache, so no operator change is delayed by it.
 *
 *  协调者内部缓存探测设置的时长（毫秒）。
 *
 *  没有它时，协调者**每次调用**都要从 KV 读设置，使一次 `/v1/models` 的 KV 读翻倍。
 *  15 秒远短于 Worker 侧的 60 秒实例缓存，因此运维改动不会因此延迟。 */
const SETTINGS_CACHE_MS = 15_000;

/** The admin view of one cached model. */
/** 管理端看到的单模型缓存视图。 */
interface ProbeModelView {
  id: string;
  status: string;
  supported_efforts: string[];
  efforts_verified: boolean;
  default_effort: string | null;
  default_enabled: boolean | null;
  capabilities: Record<string, boolean>;
  supported_parameters: string[];
  fingerprint: string;
  system_fingerprint: string;
  probed_at: number;
  attempts: number;
  retry_after: number;
  last_error: string;
}

/** The admin view of the whole cache. */
/** 管理端看到的整个缓存视图。 */
export interface ProbeCoordinatorView {
  models: ProbeModelView[];
  cached: number;
  now: number;
}

/** A list of (modelId, engine fingerprint) pairs, as sent over RPC. */
/** 通过 RPC 传递的 (模型 id, 引擎指纹) 列表。 */
type ModelRefs = Array<[string, string]>;

/** Options for `present`. */
/** `present` 的选项。 */
interface PresentOptions {
  /** Whether the caller wants the instance envelope. The single-model read does
   *  not, so it can skip the snapshot entirely. */
  /** 调用方是否需要实例信封。单模型读取不需要，因此可以完全跳过快照。 */
  wantInstanceMeta?: boolean;
  /** The capability template the caller computed from the raw model cards; the
   *  coordinator has no cards of its own (only ids and fingerprints). */
  /** 调用方从原始模型卡算出的能力模板；协调者自己没有模型卡（只有 id 与指纹）。 */
  defaultModelCapabilities?: Record<string, boolean> | null;
}

/** What `present` returns: the per-model fields, plus the instance snapshot when the
 *  caller asked for it. Both travel in ONE round trip -- the snapshot lives beside
 *  the probe facts, so there is no second store to read. */
/** `present` 的返回值：逐模型字段，以及调用方索取时的实例快照。两者在**一次**往返
 *  中返回——快照就存放在探测事实旁边，不存在需要读的第二个存储。 */
interface PresentResult {
  fields: Record<string, ModelProbeFields>;
  instanceMeta: InstanceMeta | null;
}

export class ModelProbeCoordinator extends DurableObject<Env> {
  private readonly store: SqliteProbeStore;
  private readonly cache: ModelProbeCache;
  /** Probe settings, cached for a few seconds: without this the object would read
   *  them from KV on every single call, doubling the KV reads of /v1/models. */
  /** 探测设置，缓存几秒：否则本对象每次调用都要从 KV 读它，使 /v1/models 的 KV 读翻倍。 */
  private readonly probeSettingsCache: () => Promise<ProbeSettings>;
  /** The round currently running (or the tail of the queue), so compatible callers
   *  join it instead of stacking duplicate probes (the upstream reuses its single
   *  refresh task). */
  /** 正在运行的轮次（或队列尾），使兼容的调用方加入它而不是叠加重复探测（上游也是复用
   *  同一个刷新任务）。 */
  private round: Promise<ProbeRoundStats> | null = null;
  /** What the round above is doing, for the join-compatibility decision. */
  /** 上面那个轮次在做什么，用于"能否加入"的判定。 */
  private runningRequest: RoundRequest | null = null;
  /** Resolved upstream prefix, also persisted in the meta table. */
  /** 已确定的上游前缀，同时持久化在 meta 表里。 */
  private prefix: string | null = null;
  /** Whether a background /api/config refresh is in flight (see touchInstanceMeta). */
  /** 是否已有一次后台 /api/config 刷新在飞行中（见 touchInstanceMeta）。 */
  private instanceRefreshRunning = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // SQLite-backed storage is the only backend available on the free plan, and a
    // per-model row keeps writes at "one row per model probed".
    //
    // SQLite 存储是免费层唯一可用的后端；每模型一行使写入恒为"探测一个模型写一行"。
    const sqlite = new SqliteProbeStore(ctx.storage.sql);
    sqlite.migrate();
    this.store = sqlite;
    this.cache = new ModelProbeCache();
    this.probeSettingsCache = createTtlCache(
      () => readProbeSettings(this.env, { useCache: false }),
      SETTINGS_CACHE_MS,
    );
  }

  // ------------------------------------------------------------------ //
  // RPC: read path
  // RPC：读取路径
  // ------------------------------------------------------------------ //

  /**
   * The probe-derived fields for these models, and -- when `waitSeconds > 0` -- a
   * bounded wait for the missing ones to be established.
   *
   * Waiting only ever covers models this call is actually asking about: a model in
   * backoff, or one the upstream never validates, is answered immediately.
   *
   * 这些模型由探测得出的字段；当 `waitSeconds > 0` 时，为尚未确立的模型做有界等待。
   *
   * 等待只覆盖本次调用真正问到的模型：处于退避中、或上游从不校验的模型立即返回。
   */
  async present(
    models: ModelRefs,
    waitSeconds: number,
    options: PresentOptions = {},
  ): Promise<PresentResult> {
    this.ensureLoaded();
    const settings = await this.probeSettingsCache();

    const fields: Record<string, ModelProbeFields> = {};
    const fill = (): void => {
      for (const [modelId] of models) {
        if (fields[modelId]) continue;
        const presented = this.cache.present(modelId);
        if (presented) fields[modelId] = presented;
      }
    };
    fill();

    // The instance snapshot comes from THIS object's SQLite: the Worker neither reads
    // it from KV nor fetches /api/config itself. Best effort -- a failure here must
    // never cost the caller its probe fields.
    //
    // 实例快照由**本对象**的 SQLite 提供：Worker 既不必从 KV 读它，也不必自己拉
    // /api/config。尽力而为——这里的失败绝不能连累调用方的探测字段。
    const instanceMeta =
      options.wantInstanceMeta === false
        ? null
        : this.touchInstanceMeta(options.defaultModelCapabilities ?? null);

    if (!settings.enabled || models.length === 0) return { fields, instanceMeta };

    const missing = models.filter(([modelId, fingerprint]) =>
      this.cache.needsProbe(modelId, fingerprint),
    );
    if (missing.length === 0) return { fields, instanceMeta };

    // Reconcile + probe in the background; the alarm keeps it going after this
    // invocation ends. The extra catch handler keeps a background failure (no
    // session, unreachable model list) from surfacing as an unhandled rejection.
    //
    // `prune: false`: `models` here is whatever THIS caller asked about -- the
    // single-model read path passes exactly one ref -- and reconciling a subset as if
    // it were the authoritative upstream list would delete every other model's entry.
    // Only callers holding the full list (refresh / probeOne / the alarm) may prune.
    //
    // `only` is exactly the models this call asked about: it does not change what this
    // round selects (the set is derived from those refs anyway), but it tells the
    // join-compatibility check what this round covers -- without it, the request could
    // join a round that does not cover its models and wait for nothing.
    //
    // 后台对齐并探测；本次调用结束后由 alarm 接力。额外的 catch 处理器避免后台失败
    // （无会话、模型列表不可达）变成未处理的 rejection。
    //
    // `prune: false`：这里的 `models` 是**本次调用**所问的内容——单模型读取路径只传
    // 一个 ref——把子集当成权威上游列表来对齐会删掉其他所有模型的条目。只有持有完整
    // 列表的调用方（refresh / probeOne / alarm）才可以裁剪。
    //
    // `only` 就是本次问到的那些模型：它不改变本轮的选择（待探集合本来就从这些 ref
    // 算出），但它让"能否加入在途轮次"的判定知道本轮的覆盖范围——否则这个请求可能加入
    // 一个根本不覆盖它的轮次，白等一场。
    const running = this.startRound(models, false, settings, {
      prune: false,
      only: models.map(([modelId]) => modelId),
    });
    void running.catch(() => {});

    if (waitSeconds > 0) {
      // Only the wait is bounded: the round itself keeps running for later callers.
      // The timer is cleared when the round wins the race — a DO lives long, and an
      // orphaned timeout would otherwise sit idle for the full wait window.
      //
      // 只有"等待"是有界的：轮次本身继续为后续调用方运行。轮次先完成时清除定时器
      // ——DO 的存活期很长，被遗落的定时器会白白挂满整个等待窗口。
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          running.catch(() => null),
          new Promise((resolve) => {
            timer = setTimeout(resolve, Math.max(0, waitSeconds) * 1000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      fill();
    }
    return { fields, instanceMeta };
  }

  // ------------------------------------------------------------------ //
  // Instance metadata (stored here, not in KV)
  // 实例元信息（存在这里，不在 KV）
  // ------------------------------------------------------------------ //

  /**
   * Read the instance snapshot, absorb the caller's capability template, and arm a
   * background /api/config refresh when the snapshot is stale.
   *
   * The template is persisted synchronously -- one local SQLite write, no network --
   * while /api/config is fetched in the BACKGROUND: the caller receives the previous
   * snapshot right away and the next request sees the result. A slow upstream
   * therefore never adds its latency to /v1/models, which the previous Worker-side
   * implementation did once per TTL because it awaited the fetch.
   *
   * 读取实例快照、吸收调用方给的能力模板，并在快照过期时安排一次后台 /api/config 刷新。
   *
   * 模板同步落盘——只是一次本地 SQLite 写，不涉及网络——而 /api/config 在**后台**
   * 拉取：调用方立即拿到上一份快照，下一次请求看到结果。因此慢上游永远不会把延迟加到
   * /v1/models 上；而旧的 Worker 侧实现每 TTL 就会同步等它一次。
   */
  private touchInstanceMeta(defaultCapabilities: Record<string, boolean> | null): InstanceMeta {
    const stored = parseInstanceMeta(this.store.readMeta(K_INSTANCE_META));
    let current = stored;

    if (
      defaultCapabilities &&
      !sameCapabilities(current.default_model_capabilities, defaultCapabilities)
    ) {
      current = { ...current, default_model_capabilities: defaultCapabilities };
      this.store.writeMeta(K_INSTANCE_META, JSON.stringify(current));
    }

    const now = Date.now() / 1000;
    if (!isInstanceMetaFresh(current, now) && !this.instanceRefreshRunning) {
      // One refresh at a time: without the flag, every request arriving before the
      // background write lands would arm yet another /api/config fetch.
      //
      // 同一时刻只允许一次刷新：没有该标记时，在后台写入落盘前到达的每个请求都会再
      // 安排一次 /api/config 拉取。
      this.instanceRefreshRunning = true;
      this.ctx.waitUntil(
        this.refreshInstanceMeta().finally(() => {
          this.instanceRefreshRunning = false;
        }),
      );
    }
    return current;
  }

  /** Fetch /api/config and persist the merged snapshot (background only). */
  /** 拉取 /api/config 并落盘合并后的快照（只在后台运行）。 */
  private async refreshInstanceMeta(): Promise<void> {
    const session = await getSession(this.env);
    const config = session ? await this.fetchInstanceConfig(session) : null;
    // Re-read the CURRENT snapshot before writing instead of merging into the one
    // captured when the refresh was armed: a request that arrived while /api/config was
    // in flight may have absorbed a newer capability template, and writing the captured
    // copy back would roll that template back for one TTL window.
    //
    // 写入前重读**当前**快照，而不是合并到"安排刷新时捕获的那一份"：在 /api/config
    // 飞行期间到达的请求可能已经吸收了更新的能力模板，把捕获的那份写回去会让该模板回退
    // 一个 TTL 窗口。
    const current = parseInstanceMeta(this.store.readMeta(K_INSTANCE_META));
    // The timestamp moves whether or not the read worked, so an unreachable instance
    // is retried once per TTL instead of once per request.
    //
    // 无论读取成功与否都推进时间戳，使不可达的实例每个 TTL 才重试一次，而不是每请求。
    this.store.writeMeta(
      K_INSTANCE_META,
      JSON.stringify(applyInstanceConfig(current, config, Date.now() / 1000)),
    );
  }

  /** GET the Open WebUI instance config (the legacy `/api/config` route only). */
  /** 读取 Open WebUI 实例配置（只在旧前缀 `/api/config`）。 */
  private async fetchInstanceConfig(
    session: StoredSession,
  ): Promise<Record<string, unknown> | null> {
    const base = session.base_url;
    if (!base) return null;
    let response: Response;
    try {
      response = await fetch(`${base}${INSTANCE_CONFIG_PATH}`, {
        method: "GET",
        headers: sessionHeaders(session),
        signal: AbortSignal.timeout(INSTANCE_CONFIG_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    try {
      const text = await response.text();
      return parseInstanceConfig(response.status, response.headers.get("content-type"), text);
    } catch {
      return null;
    } finally {
      void response.body?.cancel().catch(() => {});
    }
  }

  /**
   * Queue a forced round (every model, or one model when `modelId` is given) and
   * return immediately; the round itself runs on the coordinator's alarm.
   *
   * An up-front check on a FRESH model list lets the caller learn synchronously
   * whether the session works and whether the requested model exists — the list
   * is then re-fetched by the alarm before the round (freshness contract), which
   * costs one extra subrequest per admin action: the price of not exceeding the
   * `waitUntil` budget with a round that can run for minutes.
   *
   * 排入一轮强制探测（全部模型；`modelId` 给定时仅该模型）并立即返回；轮次本身
   * 由协调者的 alarm 执行。
   *
   * 前置检查用**新鲜**的模型列表，调用方能同步得知 session 是否可用、所请求的
   * 模型是否存在——随后 alarm 在轮次开始前会重新拉取列表（新鲜性契约）。每次管理
   * 动作因此多花一个子请求：这是不让一个可能运行数分钟的轮次超出 `waitUntil`
   * 预算的代价。
   */
  async refreshInBackground(modelId: string | null): Promise<void> {
    this.ensureLoaded();
    const settings = await this.probeSettingsCache();
    const models = await this.fetchModelRefs(settings);
    if (!models) throw new RoundUnavailable("models_failed");
    if (modelId !== null && !models.some(([id]) => id === modelId)) {
      // A dedicated error NAME, not just a message: Durable Object RPC keeps only
      // `name` and `message` across the boundary, so the admin API matches on the
      // name to answer its own localized 404 (the same mechanism
      // `roundUnavailableCode` uses for RoundUnavailable).
      //
      // 用专门的错误**名字**而不只是消息：Durable Object RPC 跨边界只保留 `name` 与
      // `message`，管理端按名字识别并回它自己的本地化 404（与 roundUnavailableCode
      // 对 RoundUnavailable 的机制相同）。
      const err = new Error(`model '${modelId}' is not in the upstream model list`);
      err.name = "ModelNotInList";
      throw err;
    }
    this.store.writeMeta(
      META_REQUESTED_ROUND_KEY,
      pendingRoundMeta({ force: true, only: modelId === null ? undefined : [modelId] }),
    );
    // Wake the queue immediately; the alarm consumes the marker and runs the round.
    // 立即唤醒队列；alarm 消费该标记并执行轮次。
    await this.ctx.storage.setAlarm(Date.now() + WAKE_MIN_MS);
  }

  /**
   * Drop one effort level a live request just disproved, and make sure the model is
   * re-probed. Returns whether anything changed.
   *
   * 剔除某个刚被线上请求证伪的挡位，并确保该模型会被重探。返回是否有改动。
   */
  async invalidate(modelId: string, effort: string | null): Promise<boolean> {
    this.ensureLoaded();
    const changed = this.cache.invalidateEffort(modelId, effort);
    if (!changed) return false;
    this.store.apply(this.cache.takeChanges());
    // The invalidation sets retry_after to 0, so an alarm is the cheapest way to
    // make the re-probe happen even if the client never comes back.
    //
    // 证伪会把 retry_after 置 0，因此"安排一个 alarm"是让重探发生的最省事方式，
    // 哪怕客户端再也不回来。
    const settings = await this.probeSettingsCache();
    if (settings.enabled) await this.scheduleRetryWake();
    return true;
  }

  /** Everything the admin console needs to render the probe table. */
  /** 管理控制台渲染探测表所需的全部数据。 */
  async view(): Promise<ProbeCoordinatorView> {
    this.ensureLoaded();
    const now = Date.now() / 1000;
    const models: ProbeModelView[] = this.cache
      .all()
      .map(([id, probe]) => toView(id, probe))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { models, cached: this.cache.size, now };
  }

  // ------------------------------------------------------------------ //
  // Alarms
  // alarm
  // ------------------------------------------------------------------ //

  /**
   * Continue the queue without a client: fetch the current model list, probe what is
   * due, and arm the next alarm.
   *
   * The single alarm serves TWO wake axes: the backoff (a failed model waiting out its
   * retry) and the optional heartbeat patrol (the operator-chosen interval). The wake
   * time is `min(backoff, tick)`, and a wake that is due on NEITHER axis re-arms the
   * earlier one and returns WITHOUT touching the upstream -- that early exit is what
   * keeps a quiet deployment at zero upstream requests between heartbeat ticks, and
   * what keeps "heartbeat off" at exactly the old semantics. A due heartbeat runs the
   * same NON-forced round as any other wake: with no debt its entire cost is the 1-2
   * model-list requests, and probing still follows the fingerprint/backoff rules --
   * the heartbeat is never a forced full re-probe.
   *
   * When the previous round ran out of budget it left its request behind (see
   * `runRound`), and the continuation resumes THAT request: a forced re-probe must
   * stay forced, or the alarm's default selection would skip every model that still
   * holds an `ok` conclusion and the rest of the list would never be re-probed.
   *
   * 在没有客户端的情况下继续排空队列：拉取当前模型列表、探测到期项、并安排下一个
   * alarm。
   *
   * 这一个 alarm 承载两条唤醒轴：退避（失败模型等待重试）与可选的心跳巡检（运维选择
   * 的间隔）。唤醒时刻取 `min(退避, 刻度)`，而两条轴**都不**到期的那次唤醒会按较早的
   * 一轴重新排程并返回，完全不碰上游——这个提前返回让安静的部署在两次心跳之间保持
   * 零上游请求，也让"关闭心跳"与旧语义完全一致。到期的心跳与其他唤醒一样跑同一轮
   * **非强制**探测：无欠账时整轮成本只有拉模型列表的 1-2 个请求，是否探测仍按
   * 指纹/退避规则——心跳绝不是强制全量重探。
   *
   * 上一轮预算耗尽时会把它的请求留下（见 `runRound`），续跑就按**那个**请求进行：
   * 强制重探必须保持强制，否则 alarm 的默认选择会跳过所有仍持有 `ok` 结论的模型，
   * 列表的其余部分永远不会被重探。
   */
  async alarm(): Promise<void> {
    this.ensureLoaded();
    if (this.round) return; // a request-driven round is already working
    // Everything after the early exits runs inside the try: a KV failure while
    // reading the settings or fetching the model list is exactly the case this
    // handler must survive, and an exception escaping it would leave the queue with
    // no next alarm at all.
    //
    // 除提前返回外的一切都放在 try 里：读设置或拉模型列表时的 KV 故障正是本处理器必须
    // 扛住的情况，而异常逃逸出去会让队列连下一个 alarm 都没有。
    try {
      const settings = await this.probeSettingsCache();
      if (!settings.enabled) return;

      const now = Date.now() / 1000;
      // All three gates are local reads (SQLite meta + the in-memory cache): deciding
      // whether to wake costs no upstream request. The pending round is READ here but
      // only ever written after the model list is in hand (inside runRound), so an
      // unreachable upstream below cannot throw away what the next attempt has to
      // finish.
      //
      // 三个门控全是本地读取（SQLite meta + 内存缓存）：判断"要不要干活"不花任何上游
      // 请求。待续请求在这里**读取**，但只在拿到模型列表之后（runRound 内部）才会被
      // 写入，因此下面遇到的上游不可达绝不会丢掉下一次尝试要完成的事。
      // An admin-requested round takes priority over a truncated continuation:
      // both are drained by the round below, and the completion re-arms whatever
      // is still owed.
      //
      // 管理端请求的轮次优先于被截断的续跑：两者都由下面的轮次排空，轮次完成时会
      // 重排 alarm 继续处理仍欠的部分。
      const owed =
        pendingRoundFromMeta(this.store.readMeta(META_REQUESTED_ROUND_KEY)) ??
        pendingRoundFromMeta(this.store.readMeta(META_PENDING_ROUND_KEY));
      const retryAt = retryWakeAtSeconds(this.cache.all(), now);
      const heartbeatAt = this.heartbeatDeadline(settings, now);
      const backoffDue = retryAt !== null && retryAt <= now;
      if (!owed && !backoffDue && !heartbeatDue(heartbeatAt, now)) {
        // A wake with nothing due on any axis: the heartbeat tick re-arming itself, or
        // an alarm that fired slightly ahead of its deadline. Re-arm at the earlier
        // axis and stay silent.
        //
        // 任何一条轴都没有到期任务的唤醒：心跳刻度给自己排的下一次唤醒，或略早于到期
        // 时刻触发的 alarm。按较早的一轴重新排程，保持静默。
        await this.armWake(now, retryAt, heartbeatAt);
        return;
      }

      // The model list is fetched inside runRound, when the round actually
      // executes — a queued round no longer runs on the list captured at request
      // time (see runRound).
      //
      // 模型列表改在 runRound 内、即轮次真正执行时拉取——排队的轮次不再拿着请求
      // 时刻捕获的列表运行（见 runRound）。
      await this.startRound(null, owed?.force ?? false, settings, {
        only: owed?.only,
        requireOnlyInList: true,
      });
      // Consume the admin marker once the round it spawned has finished. A
      // pending_round continuation (budget-truncated tail) keeps its own marker
      // and is drained by the alarm this completion re-arms.
      //
      // 它所启动的轮次结束后即消费管理标记。若本轮被预算截断，pending_round 的
      // 续跑标记仍在，由本次完成所重排的 alarm 继续排空。
      if (this.store.readMeta(META_REQUESTED_ROUND_KEY)) {
        this.store.writeMeta(META_REQUESTED_ROUND_KEY, "");
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "probe alarm could not run",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // A missing session is permanent until the operator re-imports: stop the
      // alarm instead of looping every five minutes (a deleted/rotated session
      // must not leave a zombie wake loop).
      //
      // session 缺失在运维重新导入前是永久状态：停止 alarm，而不是每五分钟循环
      // （被删除/更换的 session 不能留下僵尸唤醒循环）。
      if (err instanceof RoundUnavailable && err.code === "session_missing") {
        await this.stopAlarmForMissingSession();
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
    }
  }

  /**
   * Re-arm (or cancel) the heartbeat from freshly persisted settings. Called by the
   * admin API right after a settings save: an idle deployment has no other occasion
   * to notice the change, and the coordinator's own 15s settings cache could still
   * serve the previous window's copy.
   *
   * Turning the heartbeat off cancels ONLY the heartbeat wake: backoff retries and
   * pending_round continuations keep whatever alarm they already have, and the next
   * round still runs exactly as before.
   *
   * 按刚落盘的设置重排（或取消）心跳。由管理端在设置保存成功后立即调用：空闲部署
   * 没有别的时机感知改动，而协调者自身 15 秒的设置缓存可能还在返回上一窗口的副本。
   *
   * 关闭心跳只取消"心跳维度的唤醒"：退避重试与 pending_round 续跑保留其已有的
   * alarm，下一轮的行为与从前完全一致。
   */
  async rescheduleHeartbeat(): Promise<void> {
    this.ensureLoaded();
    // A fresh read on purpose -- see the docstring.
    // 刻意绕过缓存直读 KV——理由见方法注释。
    const settings = await readProbeSettings(this.env, { useCache: false });
    const now = Date.now() / 1000;
    if (!settings.enabled || settings.heartbeatInterval <= 0) {
      // Drop the stored tick so a later re-enable starts counting from "now".
      // 清掉已存的刻度，让之后重新开启时从"现在"起算。
      this.store.writeMeta(META_HEARTBEAT_KEY, "");
      const retryAt = retryWakeAtSeconds(this.cache.all(), now);
      await this.armWake(now, retryAt, null);
      return;
    }
    const heartbeatAt = now + settings.heartbeatInterval;
    this.store.writeMeta(META_HEARTBEAT_KEY, String(heartbeatAt));
    const retryAt = retryWakeAtSeconds(this.cache.all(), now);
    await this.armWake(now, retryAt, heartbeatAt);
  }

  // ------------------------------------------------------------------ //
  // Internals
  // 内部实现
  // ------------------------------------------------------------------ //

  private ensureLoaded(): void {
    if (this.cache.isLoaded) return;
    this.cache.load(this.store.loadAll());
  }

  /**
   * Start (or join) a round, deduplicating concurrent callers. `models: null`
   * means "fetch the list when the round actually executes" (see runRound);
   * only the proxy's present() path hands over a list it already read.
   *
   * 启动（或加入）一轮，并对并发调用方去重。`models: null` 表示"轮次真正执行时
   * 再拉取列表"（见 runRound）；只有代理的 present() 路径会传入已经读取的列表。
   */
  private startRound(
    models: ModelRefs | null,
    force: boolean,
    settings: ProbeSettings,
    options: { only?: readonly string[]; prune?: boolean; requireOnlyInList?: boolean } = {},
  ): Promise<ProbeRoundStats> {
    const request: RoundRequest = { force, only: options.only };
    // Join only when the running round is at least as thorough and covers at least the
    // same models (see `canJoinRound`); otherwise queue behind it. Joining blindly
    // would let an admin "probe now" come back with another caller's statistics while
    // forcing nothing.
    //
    // 只有当在途轮次至少同样彻底且至少覆盖同样的模型时才加入（见 `canJoinRound`）；
    // 否则排在它后面。盲目加入会让管理端「立即探测」什么都没强制，却返回另一个调用方的
    // 统计。
    if (this.round && this.runningRequest && canJoinRound(this.runningRequest, request)) {
      return this.round;
    }

    const previous = this.round;
    let task: Promise<ProbeRoundStats>;
    task = (previous ? previous.catch(() => null) : Promise.resolve(null))
      .then(() => this.runRound(models, force, settings, options))
      .finally(() => {
        // Only the newest link may clear the fields: an older link clearing them would
        // let the next caller start a second round alongside the queued one.
        //
        // 只有最新的一环可以清空这些字段：旧的一环清空会让下一个调用方与排队中的轮次
        // 并行地再起一轮。
        if (this.round === task) {
          this.round = null;
          this.runningRequest = null;
        }
      });
    this.round = task;
    this.runningRequest = request;
    return task;
  }

  private async runRound(
    models: ModelRefs | null,
    force: boolean,
    settings: ProbeSettings,
    options: { only?: readonly string[]; prune?: boolean; requireOnlyInList?: boolean } = {},
  ): Promise<ProbeRoundStats> {
    const session = await getSession(this.env);
    if (!session || !sessionIsUsable(session)) throw new RoundUnavailable("session_missing");
    const prefix = await this.resolvePrefix(session, settings);
    if (!prefix) throw new RoundUnavailable("models_failed");

    // The model list is fetched HERE, when the round actually executes — not when
    // it was requested. A round queued behind another one used to run on the list
    // captured at request time: stale fingerprints forced needless re-probes and,
    // with prune on, a stale list deleted entries for models still upstream. The
    // one exception is the proxy's present() path, which hands over the list it
    // just read for the client response (prune:false).
    //
    // 模型列表在**这里**、即轮次真正执行时拉取——而不是在请求时。此前排在其它轮次
    // 之后的轮次会拿着请求时刻捕获的列表运行：陈旧指纹触发无谓重探，prune 开启时
    // 陈旧列表还会删掉上游仍在的模型条目。唯一例外是代理的 present() 路径——它
    // 传入刚为客户端响应读取的列表（prune:false）。
    const modelRefs = models ?? (await this.fetchModelRefs(settings));
    if (!modelRefs) throw new RoundUnavailable("models_failed");
    if (options.requireOnlyInList && options.only) {
      for (const modelId of options.only) {
        if (!modelRefs.some(([id]) => id === modelId)) {
          const err = new Error(`model '${modelId}' is not in the upstream model list`);
          err.name = "ModelNotInList";
          throw err;
        }
      }
    }

    const transport = this.transportFor(session, prefix, settings);
    let stats: ProbeRoundStats;
    try {
      stats = await runProbeRound({
        cache: this.cache,
        store: this.store,
        models: modelRefs,
        transport,
        force,
        only: options.only,
        prune: options.prune,
        now: Date.now() / 1000,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "probe round failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await this.scheduleRetryWake();
      throw err;
    }

    // Log the round summary, not every request: Workers Logs cap a request at
    // 256 KB, and a full round is dozens of requests.
    //
    // 只记录轮次汇总，不记录每个请求：Workers Logs 单次请求上限 256 KB，而完整一轮
    // 有几十个请求。
    console.log(
      JSON.stringify({
        message: "probe round finished",
        ok: stats.ok,
        partial: stats.partial,
        unprobeable: stats.unprobeable,
        failed: stats.failed,
        authExpired: stats.authExpired,
        total: stats.total,
        cached: stats.cached,
        budgetUsed: stats.budgetUsed,
        truncated: stats.truncated,
      }),
    );
    if (stats.authExpired) {
      console.error(JSON.stringify({ message: "probe round aborted: upstream rejected the credentials" }));
    }

    if (stats.truncated) {
      // Hand the unfinished models to the alarm together with the round's force flag:
      // the continuation must be exactly as thorough, and it must start where this
      // round stopped. Resuming a forced re-probe "from the top" would re-probe what
      // just finished and never reach the tail, burning the budget in a loop.
      //
      // 把未完成的模型连同本轮的强制标记一起交给 alarm：续跑必须同样彻底，而且必须从
      // 本轮停下的地方开始。让强制重探"从头再来"会重复刚探完的模型、永远到不了尾部，
      // 把预算烧在循环里。
      this.store.writeMeta(
        META_PENDING_ROUND_KEY,
        pendingRoundMeta({ force, only: stats.remaining }),
      );
      await this.ctx.storage.setAlarm(Date.now() + ALARM_CONTINUE_MS);
    } else {
      // The queue is drained: drop any request a previous truncated round left behind.
      // The model list was just pulled, so this also advances the heartbeat tick a
      // full interval out -- a drained round IS an alignment.
      //
      // 队列已排空：清掉此前被截断的轮次留下的请求。模型列表刚刚拉过，因此这里同时
      // 把心跳刻度后移一个完整间隔——一轮排空的轮次本身就是一次对齐。
      this.store.writeMeta(META_PENDING_ROUND_KEY, "");
      await this.scheduleNextWake();
    }
    return stats;
  }

  /**
   * Arm an alarm for the earliest model that is waiting out its backoff.
   *
   * The empty case carries the SAME guard as `armWake`: a truncated round still
   * owes the queue a continuation, which must survive a "nothing to wake for"
   * decision. This path is reachable from a request-driven round whose SQLite
   * write failed -- the present() caller swallows the rejection (`void
   * running.catch`), so without the check the alarm, the heartbeat included,
   * would be deleted here and never re-armed by anyone.
   *
   * 为最早一个退避到期的模型安排 alarm。
   *
   * 空情形带着与 `armWake` 相同的守卫：被截断的轮次仍欠队列一次续跑，它必须比
   * "无事可唤醒"的判断活得更久。这条路径可由"SQLite 写入失败的请求驱动轮次"到达
   * ——present() 的调用方会吞掉 rejection（`void running.catch`），若不加检查，
   * alarm（连同心跳）会在这里被删掉且无人重设。
   */
  private async scheduleRetryWake(): Promise<void> {
    const delayMs = retryWakeDelayMs(this.cache.all(), Date.now() / 1000);
    if (delayMs === null) {
      if (this.hasOwedRound()) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_CONTINUE_MS);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * Arm the next alarm after a round that actually pulled the model list: the list was
   * just aligned, so the heartbeat tick moves a full interval out (any round -- client
   * driven, admin, or the heartbeat itself -- counts as an alignment), and the wake
   * lands on the earlier of (backoff, that tick).
   *
   * 在真正拉过模型列表的一轮之后安排下一个 alarm：对齐刚刚发生，心跳刻度整体后移一个
   * 间隔（无论哪条来的轮次——客户端、管理端或心跳本身——都算对齐），唤醒落在
   * （退避，刻度）中更早者上。
   */
  private async scheduleNextWake(): Promise<void> {
    const settings = await this.probeSettingsCache();
    if (!settings.enabled) return;
    const now = Date.now() / 1000;
    let heartbeatAt: number | null = null;
    if (settings.heartbeatInterval > 0) {
      heartbeatAt = now + settings.heartbeatInterval;
      this.store.writeMeta(META_HEARTBEAT_KEY, String(heartbeatAt));
    }
    const retryAt = retryWakeAtSeconds(this.cache.all(), now);
    await this.armWake(now, retryAt, heartbeatAt);
  }

  /**
   * The stored heartbeat tick, anchoring and persisting one when none exists. Only
   * meaningful while the heartbeat is on (`heartbeatInterval > 0`); a missing tick MUST
   * be anchored and written, or the "not due yet" branch would keep re-deriving a
   * perpetually future tick and the patrol would never actually fire.
   *
   * 已存储的心跳刻度；没有时锚定并落盘一个。仅在心跳开启（`heartbeatInterval > 0`）时
   * 有意义；缺失的刻度**必须**锚定并写入，否则"尚未到期"分支会一直派生出一个永远
   * 指向未来的刻度，巡检永远不会再真正触发。
   */
  private heartbeatDeadline(settings: ProbeSettings, now: number): number | null {
    if (settings.heartbeatInterval <= 0) return null;
    const stored = heartbeatNextFromMeta(this.store.readMeta(META_HEARTBEAT_KEY));
    if (stored !== null) return stored;
    const anchored = now + settings.heartbeatInterval;
    this.store.writeMeta(META_HEARTBEAT_KEY, String(anchored));
    return anchored;
  }

  /**
   * Arm the single alarm at the earlier of the two wake axes; delete it when neither
   * has anything -- unless a truncated round still owes the queue a continuation,
   * which must survive even a "nothing to wake for" decision. Only a backoff-driven
   * wake is capped at WAKE_MAX_MS: the backoff itself cannot exceed 6h, and the cap
   * keeps a corrupt retry_after from arming an absurdly distant alarm. A heartbeat
   * tick may legitimately sit further out (the shared table goes up to daily); alarms
   * have no platform horizon, and capping one would only add a no-op wake every 6h.
   *
   * 在两条唤醒轴中较早者上安排唯一的 alarm；两者皆无时删除——除非被截断的轮次仍欠
   * 队列一次续跑，它必须比"无事可唤醒"的判断活得更久。只有退避驱动的唤醒才受
   * WAKE_MAX_MS 约束：退避本身不超过 6 小时，该上限还能防住损坏的 retry_after 安排
   * 出荒诞遥远的 alarm。心跳刻度可以合法地更远（共享档位表最远到每天）；alarm 没有
   * 平台层的时间上限，强行夹紧只会每 6 小时多一次空唤醒。
   */
  private async armWake(now: number, retryAt: number | null, heartbeatAt: number | null): Promise<void> {
    const next = nextWakeAtSeconds(retryAt, heartbeatAt);
    if (next === null) {
      if (this.hasOwedRound()) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_CONTINUE_MS);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }
    const delayMs = Math.max((next - now) * 1000, WAKE_MIN_MS);
    const heartbeatBound = heartbeatAt !== null && next >= heartbeatAt;
    await this.ctx.storage.setAlarm(Date.now() + (heartbeatBound ? delayMs : Math.min(delayMs, WAKE_MAX_MS)));
  }

  /** The transport the round talks through: one upstream POST per request, with the
   *  round's budget enforced and auth failures turned into a round abort. */
  /** 轮次使用的传输层：每次请求一个上游 POST，强制本轮预算，并把凭证失效转成整轮中止。 */
  private transportFor(
    session: StoredSession,
    prefix: string,
    settings: ProbeSettings,
  ): ProbeTransport {
    const budget = Math.max(1, settings.budget);
    let used = 0;
    return {
      ask: async (modelId: string, payload: Record<string, unknown>): Promise<ProbeAnswer> => {
        if (used >= budget) throw new ProbeBudgetExhausted();
        used += 1;
        let response: Response;
        try {
          response = await fetchUpstream(
            `${session.base_url}${prefix}/chat/completions`,
            {
              method: "POST",
              headers: sessionHeaders(session),
              body: JSON.stringify(payload),
            },
            { timeoutMs: Math.max(1, settings.timeout) * 1000 },
          );
        } catch (err) {
          // The platform's per-invocation subrequest cap (the free plan allows 50)
          // says nothing about the model being probed. Recording it as that model's
          // failure would fill the cache with a configuration artifact and burn
          // backoff cycles on it, so it is handled exactly like budget exhaustion:
          // stop the round, leave the model untouched, and let the alarm continue in
          // a FRESH invocation that starts with its own allowance.
          //
          // 平台的"单次调用子请求上限"（免费层 50 个）与被探测的模型毫无关系。把它记成
          // 该模型的失败只会让缓存装满配置产物、并在退避上空转，因此处理方式与预算耗尽
          // 完全一致：停止本轮、该模型保持原样，让 alarm 在拥有自己配额的新一次调用中
          // 继续。
          if (isPlatformSubrequestError(err)) throw new ProbeBudgetExhausted();
          throw new ProbeTransient(`probe request failed: ${String(err)}`);
        }
        try {
          if (AUTH_FAILURE_CODES.includes(response.status)) {
            throw new ProbeAuthExpired(String(response.status));
          }
          const body = await response.text();
          return { status: response.status, body };
        } finally {
          void response.body?.cancel().catch(() => {});
        }
      },
      now: () => Date.now() / 1000,
      budgetLeft: () => budget - used,
      budgetUsed: () => used,
    };
  }

  /**
   * (modelId, fingerprint) for every model upstream, or null when unreachable.
   *
   * This is how refresh / probeOne / the alarm satisfy the freshness contract on
   * `ProbeRoundInput.models` (see probeRound.ts): the list is fetched here, at
   * the trigger site, immediately before `startRound` -- never inside the round.
   * The single exception is the proxy's present() path, which passes the list it
   * just read for the client response (prune:false), so no second fetch happens.
   *
   * 返回上游全部模型的 (模型 id, 指纹)；不可达时返回 null。
   *
   * 这正是 refresh / probeOne / alarm 满足 `ProbeRoundInput.models` 新鲜性契约的
   * 方式（见 probeRound.ts）：列表在触发点、`startRound` 之前在此拉取，绝不放进
   * 轮次内部。唯一的例外是代理的 present() 路径——它传入刚为客户端响应读取的列表
   * （prune:false），因此不会发生第二次拉取。
   */
  private async fetchModelRefs(settings: ProbeSettings): Promise<ModelRefs | null> {
    const session = await getSession(this.env);
    if (!session || !sessionIsUsable(session)) return null;
    const prefix = await this.resolvePrefix(session, settings);
    if (!prefix) return null;

    let response: Response;
    try {
      response = await fetchUpstream(
        `${session.base_url}${prefix}/models`,
        { method: "GET", headers: sessionHeaders(session) },
        { timeoutMs: Math.max(1, settings.timeout) * 1000 },
      );
    } catch {
      return null;
    }
    try {
      if (response.status !== 200) {
        // The remembered prefix stopped answering: forget it so the NEXT round
        // re-probes the candidates instead of pinning to a dead route forever.
        //
        // 记忆的前缀不再应答：遗忘它，让**下一轮**重新探测候选，而不是永远钉死在
        // 失效路由上。
        this.forgetPrefix();
        return null;
      }
      const payload: unknown = await response.json().catch(() => null);
      // A 200 we cannot read as a model list is NOT "the upstream has no models",
      // and it is just as likely a sign the prefix is wrong: forget it and skip
      // the round either way — reconciling against an HTML page or an empty list
      // would corrupt the cache.
      //
      // 读不成模型列表的 200 不等于"上游没有模型"，它同样可能是前缀错了：无论
      // 哪种都遗忘前缀并跳过本轮——按 HTML 页面或空列表对齐都会污染缓存。
      if (!isModelListPayload(payload)) {
        this.forgetPrefix();
        return null;
      }
      return await refsFromCards(extractModelList(payload));
    } finally {
      void response.body?.cancel().catch(() => {});
    }
  }

  /** Forget the remembered prefix (memory + meta): the next round re-probes. */
  /** 遗忘已记忆的前缀（内存 + meta）：下一轮重新探测。 */
  private forgetPrefix(): void {
    this.prefix = null;
    this.store.writeMeta(META_PREFIX_KEY, "");
  }

  /**
   * Whether a requested or truncated round still owes the queue work. Checked by
   * every "nothing to wake for" decision: dropping the alarm while such a marker
   * survives would strand the queue.
   *
   * 是否仍有管理请求或被截断的轮次欠着队列的工作。所有"无事可唤醒"的判定都要检查
   * 它：在标记尚存时删除 alarm 会让队列搁浅。
   */
  private hasOwedRound(): boolean {
    if (this.store.readMeta(META_REQUESTED_ROUND_KEY)) return true;
    return Boolean(pendingRoundFromMeta(this.store.readMeta(META_PENDING_ROUND_KEY)));
  }

  /**
   * Stop the alarm because the session is gone. Any owed round (admin request or
   * budget-truncated continuation) is dropped with it: with no session the queue
   * could do nothing, and a surviving marker would only make the next alarm wake
   * into the same dead end. A fresh import re-arms everything.
   *
   * 因 session 消失而停止 alarm。一切欠账（管理请求或截断续跑）随之丢弃：没有
   * session 队列什么也做不了，残留的标记只会让下一次 alarm 撞进同一个死胡同。
   * 重新导入 session 会重建一切。
   */
  private async stopAlarmForMissingSession(): Promise<void> {
    this.store.writeMeta(META_REQUESTED_ROUND_KEY, "");
    this.store.writeMeta(META_PENDING_ROUND_KEY, "");
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Resolve the upstream API prefix once, remembering it across evictions.
   *
   * The confirmation rule is shared with the proxy and the admin test
   * (`confirmUpstreamPrefix`): a prefix is accepted when the answer really is a model
   * list or proves the route exists with dead credentials. "Anything but a 404" was
   * the old rule, and it accepts the SPA's "200 + HTML" page -- which then gets
   * remembered, so every later round talks to a route that does not exist.
   *
   * 只解析一次上游 API 前缀，并跨驱逐记住它。
   *
   * 确认规则与代理、管理端测试共用（`confirmUpstreamPrefix`）：只有当答复确实是模型列表，
   * 或证明了路由存在但凭证失效时，才接受该前缀。"不是 404 就算对"是旧规则，它会接受 SPA
   * 的 "200 + HTML" 页面——而该前缀随后被记住，于是此后每一轮都在对不存在的路由说话。
   */
  private async resolvePrefix(session: StoredSession, settings: ProbeSettings): Promise<string | null> {
    if (this.prefix) return this.prefix;
    const remembered = this.store.readMeta(META_PREFIX_KEY);
    const candidates = prefixCandidates(remembered, PREFIX_CANDIDATES);
    const timeoutMs = Math.max(1, settings.timeout) * 1000;

    let confirmed = null;
    try {
      confirmed = await confirmUpstreamPrefix(candidates, async (prefix) => {
        const response = await fetchUpstream(
          `${session.base_url}${prefix}/models`,
          { method: "GET", headers: sessionHeaders(session) },
          { timeoutMs },
        );
        // The body is read for the confirmation itself, so "drain the connection" and
        // "decide whether this really is a model list" are the same action.
        //
        // 响应体正是为了确认而读的，因此"排空连接"与"判定它是否真的是模型列表"是同一个
        // 动作。
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          text: await response.text().catch(() => ""),
        };
      });
    } catch {
      // Unreachable (or timed out) for every candidate: no prefix to remember —
      // and a poisoned memory must not survive either.
      //
      // 所有候选都连不上（或超时）：没有可记住的前缀——被污染的记忆同样不能长存。
      this.forgetPrefix();
      return null;
    }
    if (!confirmed) {
      this.forgetPrefix();
      return null;
    }
    this.prefix = confirmed.prefix;
    this.store.writeMeta(META_PREFIX_KEY, confirmed.prefix);
    return confirmed.prefix;
  }
}

// --------------------------------------------------------------------------- //
// Helpers
// 小工具
// --------------------------------------------------------------------------- //

function toView(id: string, probe: ModelProbe): ProbeModelView {
  return {
    id,
    status: probe.status,
    supported_efforts: [...probe.supported_efforts],
    efforts_verified: probe.efforts_verified,
    default_effort: probe.default_effort,
    default_enabled: probe.default_enabled,
    capabilities: { ...probe.capabilities },
    supported_parameters: [...probe.supported_parameters],
    fingerprint: probe.fingerprint,
    system_fingerprint: probe.system_fingerprint,
    probed_at: probe.probed_at,
    attempts: probe.attempts,
    retry_after: probe.retry_after,
    last_error: probe.last_error,
  };
}
