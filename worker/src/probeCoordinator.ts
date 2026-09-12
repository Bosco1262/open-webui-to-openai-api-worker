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
 * instead of one request.
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
 */

import { DurableObject } from "cloudflare:workers";

import { ModelProbeCache } from "./modelProbe.ts";
import { extractModelList, isModelListPayload } from "./modelCatalog.ts";
import {
  RoundUnavailable,
  canJoinRound,
  createTtlCache,
  pendingRoundFromMeta,
  pendingRoundMeta,
  prefixCandidates,
  refsFromCards,
  retryWakeDelayMs,
} from "./probeRuntime.ts";
import type { RoundRequest } from "./probeRuntime.ts";
import { SqliteProbeStore } from "./probeStore.ts";
import { ProbeAuthExpired, ProbeBudgetExhausted, ProbeTransient, runProbeRound } from "./probeRound.ts";
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
      // 只有"等待"是有界的：轮次本身继续为后续调用方运行。
      await Promise.race([
        running.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, waitSeconds) * 1000)),
      ]);
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

  /** Force a fresh round for every model currently upstream. */
  /** 为当前上游的全部模型强制开一轮。 */
  async refresh(force: boolean): Promise<ProbeRoundStats> {
    this.ensureLoaded();
    const settings = await this.probeSettingsCache();
    const models = await this.fetchModelRefs(settings);
    if (!models) throw new RoundUnavailable("models_failed");
    return this.startRound(models, force, settings);
  }

  /**
   * Force a round for ONE model; the full model list is still reconciled so the
   * other entries survive.
   *
   * 只对**一个**模型强制开一轮；仍然用完整模型列表做对齐，因此其它条目不受影响。
   */
  async probeOne(modelId: string): Promise<ProbeRoundStats> {
    this.ensureLoaded();
    const settings = await this.probeSettingsCache();
    const models = await this.fetchModelRefs(settings);
    if (!models) throw new RoundUnavailable("models_failed");
    if (!models.some(([id]) => id === modelId)) {
      throw new Error(`model '${modelId}' is not in the upstream model list`);
    }
    return this.startRound(models, true, settings, { only: [modelId] });
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
   * When the previous round ran out of budget it left its request behind (see
   * `runRound`), and the continuation resumes THAT request: a forced re-probe must
   * stay forced, or the alarm's default selection would skip every model that still
   * holds an `ok` conclusion and the rest of the list would never be re-probed.
   *
   * 在没有客户端的情况下继续排空队列：拉取当前模型列表、探测到期项、并安排下一个
   * alarm。
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

      const models = await this.fetchModelRefs(settings);
      if (!models) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
        return;
      }
      // The pending request is read only once the model list is in hand: an
      // unreachable upstream must not throw away what the next attempt has to finish.
      //
      // 等到模型列表到手后才读取待续请求：上游不可达时绝不能丢掉下一次尝试要完成的事。
      const pending = pendingRoundFromMeta(this.store.readMeta(META_PENDING_ROUND_KEY));
      await this.startRound(models, pending?.force ?? false, settings, {
        only: pending?.only,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "probe alarm could not run",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
    }
  }

  // ------------------------------------------------------------------ //
  // Internals
  // 内部实现
  // ------------------------------------------------------------------ //

  private ensureLoaded(): void {
    if (this.cache.isLoaded) return;
    this.cache.load(this.store.loadAll());
  }

  /** Start (or join) a round, deduplicating concurrent callers. */
  /** 启动（或加入）一轮，并对并发调用方去重。 */
  private startRound(
    models: ModelRefs,
    force: boolean,
    settings: ProbeSettings,
    options: { only?: readonly string[]; prune?: boolean } = {},
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
    models: ModelRefs,
    force: boolean,
    settings: ProbeSettings,
    options: { only?: readonly string[]; prune?: boolean } = {},
  ): Promise<ProbeRoundStats> {
    const session = await getSession(this.env);
    if (!session || !sessionIsUsable(session)) throw new RoundUnavailable("session_missing");
    const prefix = await this.resolvePrefix(session, settings);
    if (!prefix) throw new RoundUnavailable("models_failed");

    const transport = this.transportFor(session, prefix, settings);
    let stats: ProbeRoundStats;
    try {
      stats = await runProbeRound({
        cache: this.cache,
        store: this.store,
        models,
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
      //
      // 队列已排空：清掉此前被截断的轮次留下的请求。
      this.store.writeMeta(META_PENDING_ROUND_KEY, "");
      await this.scheduleRetryWake();
    }
    return stats;
  }

  /** Arm an alarm for the earliest model that is waiting out its backoff. */
  /** 为最早一个退避到期的模型安排 alarm。 */
  private async scheduleRetryWake(): Promise<void> {
    const delayMs = retryWakeDelayMs(this.cache.all(), Date.now() / 1000);
    if (delayMs === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
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

  /** (modelId, fingerprint) for every model upstream, or null when unreachable. */
  /** 上游全部模型的 (模型 id, 指纹)；不可达时返回 null。 */
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
      if (response.status !== 200) return null;
      const payload: unknown = await response.json().catch(() => null);
      // A 200 we cannot read as a model list is NOT "the upstream has no models".
      // Reconciling the cache with an empty list would drop every model and force a
      // full re-probe, so this round is skipped instead.
      //
      // 200 但读不成模型列表，绝不等于"上游没有模型"。按空列表对齐缓存会删掉所有模型并
      // 触发全量重探，因此这里选择跳过本轮。
      if (!isModelListPayload(payload)) return null;
      return await refsFromCards(extractModelList(payload));
    } finally {
      void response.body?.cancel().catch(() => {});
    }
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
      // Unreachable (or timed out) for every candidate: no prefix to remember.
      // 所有候选都连不上（或超时）：没有可记住的前缀。
      return null;
    }
    if (!confirmed) return null;
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
