/**
 * Probe execution: the six-step conversation with the engine, plus the round
 * orchestration around it.
 *
 * Ported from the upstream Python project (commit ffef6e2: app.py `_probe_model`
 * and `_refresh_model_probe`). Every step is a real request with max_tokens=1, so
 * a full probe costs at most a handful of output tokens:
 *
 *   1. candidate discovery -- a sentinel `reasoning_effort` makes the outer schema
 *      enumerate the levels it accepts;
 *   2. per-value verification -- only a 200 for a concrete level counts, which is
 *      what catches the second validation layer (Harmony, the model's own parser);
 *   3. request parameters -- one merged request, retried without whatever the 400
 *      blames; this also establishes function calling and structured outputs;
 *   4. vision -- one request carrying a 1x1 image;
 *   5. default behaviour -- one request with `reasoning_effort` omitted;
 *   6. assembly -- only the facts that were actually established.
 *
 * Worker-side differences from the Python original (both deliberate):
 *   - Rounds are SERIAL and BUDGETED. One invocation may spend at most `budget`
 *     upstream subrequests (the free plan allows 50 per invocation, KV and Durable
 *     Object calls included), and at most six connections may be waiting for
 *     response headers at once, so probing one model at a time is both the safest
 *     and the only predictable accounting.
 *   - Each model is persisted as soon as it lands, so an interrupted round loses
 *     at most the model in flight instead of everything.
 *
 * 探测执行：与引擎的六步对话，以及围绕它的轮次编排。
 *
 * 从上游 Python 项目移植（提交 ffef6e2：app.py 的 `_probe_model` 与
 * `_refresh_model_probe`）。每一步都是 max_tokens=1 的真实请求，完整探测最多花费
 * 个位数输出 token：
 *
 *   1. 候选发现 —— 用哨兵 `reasoning_effort` 让外层 schema 枚举它接受的挡位；
 *   2. 逐值实证 —— 只有具体挡位返回 200 才算数，这正是抓住第二层校验（Harmony、
 *      模型自带解析器）的关键；
 *   3. 请求参数 —— 一次合并请求，命中 400 就剔除被归因的参数后重试；这一步同时
 *      确立函数调用与结构化输出；
 *   4. 视觉 —— 一次携带 1x1 图片的请求；
 *   5. 默认行为 —— 一次省略 `reasoning_effort` 的请求；
 *   6. 组装 —— 只保留确实被确立的事实。
 *
 * Worker 侧与 Python 原版的两处差异（都是有意为之）：
 *   - 轮次是**串行**且**带预算**的。单次调用最多只能花 `budget` 个上游子请求
 *     （免费层每次调用上限 50，KV 与 Durable Object 调用也计入），且同时最多只有
 *     六个连接处于"等待响应头"状态，因此逐模型串行既最安全，也是唯一可精确记账的
 *     方式。
 *   - 每个模型探完立即落盘，因此被打断的轮次最多损失"正在探测的那一个模型"，
 *     而不是全部。
 */

import {
  EFFORT_ORDER,
  PROBED_PARAMETERS,
  PROBE_SENTINEL,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_UNPROBEABLE,
  baselinePayload,
  createModelProbe,
  deriveReasoningCapability,
  effortPayload,
  engineBuild,
  extractDefaultEffort,
  extractEffortCandidates,
  parameterOfError,
  parameterPayload,
  responseHasReasoning,
  visionPayload,
} from "./modelProbe.ts";
import type { ModelProbeCache, ProbeCacheChanges } from "./modelProbe.ts";
import type { ProbeStore } from "./probeStore.ts";
import type { ModelProbe, ProbeRoundStats } from "./types.ts";

/** Upstream 400/422: the engine rejected the request -- the expected probe answer. */
/** 上游 400/422：引擎拒绝了请求——这正是探测期望的答复。 */
const VALIDATION_FAILURE_CODES: readonly number[] = [400, 422];

/** Per-model wall clock (seconds). Not exposed as a setting: the upstream Python
 *  project bounded a whole model at `MODEL_PROBE_TIMEOUT`, while a Worker bounds
 *  each request, so this is the belt to that braces. */
/** 单模型墙钟（秒）。不作为设置暴露：上游 Python 用 `MODEL_PROBE_TIMEOUT` 限制
 *  整个模型，而 Worker 限制的是单个请求，这一条是额外的保险。 */
const PROBE_MODEL_WALL_CLOCK_SECONDS = 45;

/** Thrown when the upstream answers a probe with 401/403: the credentials died, so
 *  the whole round must stop instead of hammering a dead session once per model. */
/** 上游对探测请求返回 401/403 时抛出：凭证已失效，整个轮次应立即停止，而不是对每个模型都拿着死凭证再撞一遍。 */
export class ProbeAuthExpired extends Error {
  readonly status: string;

  constructor(status: string) {
    super(status);
    this.name = "ProbeAuthExpired";
    this.status = status;
  }
}

/** A transient failure (network error, timeout, unexpected status): never a claim
 *  about the model, always worth retrying later. */
/** 暂时性失败（网络错误、超时、意外状态码）：绝不构成关于该模型的任何声明，值得稍后重试。 */
export class ProbeTransient extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeTransient";
  }
}

/** The round's subrequest budget ran out. The model being probed is neither
 *  confirmed nor disproved, so it must stay queued for the next round. */
/** 本轮子请求预算耗尽。正在探测的模型既没被证实也没被证伪，因此必须留给下一轮。 */
export class ProbeBudgetExhausted extends Error {
  constructor() {
    super("probe round budget exhausted");
    this.name = "ProbeBudgetExhausted";
  }
}

/** One upstream answer, reduced to what the probe logic needs. */
/** 一次上游答复，收敛为探测逻辑所需的字段。 */
export interface ProbeAnswer {
  status: number;
  body: string;
}

/** What `probeModel` needs from the outside world. */
/** `probeModel` 需要外部提供的东西。 */
export interface ProbeTransport {
  /** POST one probe request for a model. Throws ProbeTransient on a network error
   *  or timeout, ProbeAuthExpired on 401/403 and ProbeBudgetExhausted when the
   *  round has no budget left. */
  /** 为某个模型 POST 一次探测请求。网络错误或超时抛 ProbeTransient，401/403 抛
   *  ProbeAuthExpired，预算耗尽抛 ProbeBudgetExhausted。 */
  ask(modelId: string, payload: Record<string, unknown>): Promise<ProbeAnswer>;
  /** Monotonic-ish seconds, used for timestamps and the per-model wall clock. */
  /** 秒级时间戳，用于记录时刻与单模型墙钟。 */
  now(): number;
  /** Upstream requests this round may still spend. */
  /** 本轮还能花费的上游请求数。 */
  budgetLeft(): number;
  /** Upstream requests already spent this round. */
  /** 本轮已花费的上游请求数。 */
  budgetUsed(): number;
}

/**
 * Establish, by asking the engine, what one model accepts.
 *
 * Raises ProbeAuthExpired (abort the whole round) or ProbeTransient (retry the
 * model later); every other outcome is a ModelProbe, complete or partial.
 *
 * 通过"问引擎"确立单个模型接受什么。
 *
 * 抛出 ProbeAuthExpired（中止整轮）或 ProbeTransient（稍后重试该模型）；其它任何
 * 结果都返回 ModelProbe，可能是完整的也可能是部分的。
 */
async function probeModel(
  modelId: string,
  fingerprint: string,
  transport: ProbeTransport,
  wallClockSeconds: number = PROBE_MODEL_WALL_CLOCK_SECONDS,
): Promise<ModelProbe> {
  const probe = createModelProbe(fingerprint, transport.now());
  let unresolved = 0;
  const deadline = transport.now() + wallClockSeconds;

  const ask = async (payload: Record<string, unknown>): Promise<ProbeAnswer> => {
    if (transport.now() >= deadline) {
      throw new ProbeTransient(`model probe exceeded its ${wallClockSeconds}s wall clock`);
    }
    return transport.ask(modelId, payload);
  };

  // --- 1. candidate discovery: the sentinel makes the outer schema talk --------
  const sentinel = await ask(effortPayload(modelId, PROBE_SENTINEL));
  const unprobeable = sentinel.status === 200;
  let candidates: string[] = [];
  if (unprobeable) {
    // The upstream ignored the sentinel: it does not validate the field, so a
    // per-value answer would not mean anything either.
    //
    // 上游忽略了哨兵值：它不校验该字段，逐值回答同样没有意义。
    probe.status = STATUS_UNPROBEABLE;
  } else if (VALIDATION_FAILURE_CODES.includes(sentinel.status)) {
    probe.default_effort = extractDefaultEffort(sentinel.body);
    // The enumeration is only the OUTER schema. When the phrasing is unknown,
    // sweep the whole canonical list rather than give up: verification is what
    // decides, so an unparsed candidate list costs requests, not correctness.
    //
    // 这个枚举只是**外层** schema。措辞不认识时改为遍历完整规范列表而不是放弃：
    // 结论由实证决定，因此候选解析不出只多花几次请求，不影响正确性。
    candidates = extractEffortCandidates(sentinel.body);
    if (candidates.length === 0) candidates = [...EFFORT_ORDER];
  } else {
    throw new ProbeTransient(`sentinel probe returned HTTP ${sentinel.status}`);
  }

  // --- 2. per-value verification: only a 200 counts ---------------------------
  for (const effort of candidates) {
    const answer = await ask(effortPayload(modelId, effort));
    if (answer.status === 200) {
      probe.supported_efforts.push(effort);
      if (!probe.system_fingerprint) probe.system_fingerprint = engineBuild(answer.body);
    } else if (VALIDATION_FAILURE_CODES.includes(answer.status)) {
      // The model-level layer is the only place the engine sometimes names its
      // default level ("Supported types are xhigh (default), ..."), so mine it
      // here as well -- the outer schema error never carries that marker.
      //
      // 模型级那一层是引擎偶尔声明默认挡位的唯一地方（"Supported types are xhigh
      // (default), ..."），所以这里也要挖一遍——外层 schema 的报错从不带这个标注。
      if (probe.default_effort === null) {
        probe.default_effort = extractDefaultEffort(answer.body);
      }
    } else {
      unresolved += 1;
    }
  }
  probe.efforts_verified = !unprobeable && unresolved === 0;

  // --- 3. request parameters: one merged request, retried without the offender --
  let remaining: string[] = [...PROBED_PARAMETERS];
  const parameterAccepted: Record<string, boolean> = {};
  for (let round = 0; round <= PROBED_PARAMETERS.length; round += 1) {
    if (remaining.length === 0) break;
    const answer = await ask(parameterPayload(modelId, remaining));
    if (answer.status === 200) {
      for (const parameter of remaining) parameterAccepted[parameter] = true;
      if (!probe.system_fingerprint) probe.system_fingerprint = engineBuild(answer.body);
      remaining = [];
      break;
    }
    if (!VALIDATION_FAILURE_CODES.includes(answer.status)) {
      unresolved += 1;
      break;
    }
    const blamed = parameterOfError(answer.body);
    if (blamed === "reasoning_effort") {
      unresolved += 1;
      break;
    }
    let blamedSet: string[];
    if (blamed === "tools" || blamed === "tool_choice") {
      // `tools` and `tool_choice` are one feature: an engine built without a
      // tool-call parser rejects whichever of the two it sees first, so both
      // are disproved together.
      //
      // `tools` 与 `tool_choice` 属于同一特性：没带 tool-call parser 的引擎会拒绝
      // 先看到的那个，因此两者一起被证伪。
      blamedSet = ["tools", "tool_choice"];
    } else if (blamed) {
      blamedSet = [blamed];
    } else {
      // The 400 cannot be attributed to one parameter: claim nothing about the
      // ones still under test instead of guessing.
      //
      // 这个 400 无法归因到某个参数：对仍在测试的参数不做任何声明，而不是猜。
      unresolved += 1;
      break;
    }
    // A 400 blamed on a parameter that is no longer under test would leave
    // `remaining` untouched and spin until the round cap, spending requests and
    // ending with parameters that are neither accepted nor marked unresolved. Stop
    // instead: the answer is already open, so the model is partial either way.
    //
    // 归因到一个**已被剔除**的参数的 400，不会改变 `remaining`，于是会一直空转到轮次
    // 上限：既浪费请求，最后还会留下既未被接受、也未被标记为未定的参数。这里直接停止：
    // 答案本来就未定，模型无论如何都是 partial。
    if (!blamedSet.some((parameter) => remaining.includes(parameter))) {
      unresolved += 1;
      break;
    }
    for (const parameter of blamedSet) {
      if (remaining.includes(parameter)) parameterAccepted[parameter] = false;
    }
    remaining = remaining.filter((item) => !blamedSet.includes(item));
  }

  // The loop must not exit with parameters left undecided: that would publish a
  // "complete" probe whose parameter set is quietly missing entries. The invariant
  // holds on every exit path -- the round cap, an unattributable 400, and the early
  // exit above.
  //
  // 循环结束时参数必须全部定性：否则会对外发布一个"完整"的探测，而它的参数集合里
  // 悄悄少了若干条目。轮次上限、无法归因的 400、以及上面的提前退出，各条路径都要满足
  // 这一不变式。
  if (remaining.length > 0) unresolved += 1;

  // --- 4. vision: does the engine accept image content at all? ----------------
  const visionAnswer = await ask(visionPayload(modelId));
  let vision: boolean | null;
  if (visionAnswer.status === 200) {
    vision = true;
    if (!probe.system_fingerprint) probe.system_fingerprint = engineBuild(visionAnswer.body);
  } else if (VALIDATION_FAILURE_CODES.includes(visionAnswer.status)) {
    vision = false;
  } else {
    vision = null;
    unresolved += 1;
  }

  // --- 5. default behaviour: the same request without reasoning_effort --------
  const baselineAnswer = await ask(baselinePayload(modelId));
  if (baselineAnswer.status === 200) {
    probe.default_enabled = responseHasReasoning(baselineAnswer.body);
    if (!probe.system_fingerprint) probe.system_fingerprint = engineBuild(baselineAnswer.body);
  } else if (!VALIDATION_FAILURE_CODES.includes(baselineAnswer.status)) {
    unresolved += 1;
  }

  // --- 6. assemble the facts --------------------------------------------------
  const capabilities: Record<string, boolean> = {};
  if (vision !== null) capabilities.vision = vision;
  if ("tools" in parameterAccepted) capabilities.function_calling = parameterAccepted.tools;
  if ("response_format" in parameterAccepted) {
    capabilities.structured_outputs = parameterAccepted.response_format;
  }
  const reasoningCapable = deriveReasoningCapability(
    unprobeable ? null : probe.supported_efforts,
    probe.default_enabled,
  );
  if (reasoningCapable !== null) capabilities.reasoning = reasoningCapable;
  probe.capabilities = capabilities;

  const acceptedParameters = Object.entries(parameterAccepted)
    .filter(([, accepted]) => accepted)
    .map(([parameter]) => parameter);
  if (probe.supported_efforts.length > 0 && !unprobeable) {
    acceptedParameters.push("reasoning_effort");
  }
  probe.supported_parameters = acceptedParameters.sort();

  if (unprobeable) {
    probe.status = STATUS_UNPROBEABLE;
  } else if (unresolved > 0) {
    probe.status = STATUS_PARTIAL;
    probe.last_error = `${unresolved} probe request(s) left the answer open`;
  } else {
    probe.status = STATUS_OK;
  }
  return probe;
}

// --------------------------------------------------------------------------- //
// Round orchestration
// 轮次编排
// --------------------------------------------------------------------------- //

/** Everything a round needs. */
/** 一轮探测所需的全部输入。 */
export interface ProbeRoundInput {
  cache: ModelProbeCache;
  store: ProbeStore;
  /** (modelId, engine fingerprint) for every model currently upstream. */
  /** 当前上游全部模型的 (模型 id, 引擎指纹)。 */
  models: ReadonlyArray<readonly [string, string]>;
  transport: ProbeTransport;
  /** Re-probe every model regardless of the cache (the admin "probe now"). */
  /** 无视缓存重探全部模型（管理端「立即探测」）。 */
  force?: boolean;
  /** Restrict the round to these ids (admin "re-probe this model" and the 400
   *  self-heal). The reconciliation still sees the FULL model list, so probing one
   *  model never drops the other models' entries. */
  /** 把本轮限定在这些 id 上（管理端「重探此模型」与 400 自愈）。对齐仍然看到**完整**
   *  模型列表，因此只探一个模型绝不会删掉其它模型的条目。 */
  only?: readonly string[];
  /** Whether `models` is the authoritative full upstream list, so entries missing
   *  from it may be dropped. Defaults to true; a caller holding only a subset (the
   *  single-model read path) MUST pass false, or the reconciliation deletes every
   *  model it was not asked about. */
  /** `models` 是否为权威的完整上游列表，从而可以删除其中缺失的条目。默认 true；
   *  只持有上游列表子集的调用方（单模型读取路径）**必须**传 false，否则对齐会删掉
   *  所有未被问及的模型。 */
  prune?: boolean;
  /** Timestamp used for the reconciliation decision. */
  /** 用于对齐判定的时间戳。 */
  now: number;
  wallClockSeconds?: number;
  /** Called after every model so a caller can react (logging, scheduling). */
  /** 每探完一个模型时回调，便于调用方记录日志或安排后续动作。 */
  onModelDone?: (modelId: string, probe: ModelProbe) => void;
  /** Called whenever entries were persisted. */
  /** 每次落盘后回调。 */
  onPersist?: (changes: ProbeCacheChanges) => void;
}

/**
 * Reconcile the cache with the current model list, probe what is missing (serially,
 * within the budget), persist each model as it lands, and return the counters.
 *
 * Whatever was collected before a 401/403 abort is still persisted. A model whose
 * probe is cut short by the budget is left exactly as it was -- the run proves
 * nothing about it, so it must not be recorded as a failure.
 *
 * `prune` (default true) is handed to the reconciliation; see
 * `ModelProbeCache.syncWithModels`. A caller whose `models` is only the subset it
 * asked about must pass `prune: false`.
 *
 * 将缓存与当前模型列表对齐，串行探测缺失项（受预算约束），每探完一个模型立即落盘，
 * 并返回统计计数。
 *
 * 凭证失效中止前收集到的结果仍然落盘。被预算截断的模型保持原样——这一轮并没有
 * 得出关于它的任何结论，因此不能记成失败。
 *
 * `prune`（默认 true）会透传给对齐逻辑，见 `ModelProbeCache.syncWithModels`；
 * 若调用方的 `models` 只是它所问的子集，必须传 `prune: false`。
 */
export async function runProbeRound(input: ProbeRoundInput): Promise<ProbeRoundStats> {
  const { cache, store, models, transport } = input;
  const wallClockSeconds = input.wallClockSeconds ?? PROBE_MODEL_WALL_CLOCK_SECONDS;

  const toProbe = cache.syncWithModels(models, {
    force: input.force === true,
    now: input.now,
    prune: input.prune !== false,
  });
  const selected = input.only ? toProbe.filter((modelId) => input.only?.includes(modelId)) : toProbe;

  // Persist the reconciliation immediately (vanished models lose their rows).
  // 立即落盘对齐结果（消失的模型要删行）。
  const reconciled = cache.takeChanges();
  store.apply(reconciled);
  input.onPersist?.(reconciled);

  const stats: ProbeRoundStats = {
    ok: 0,
    partial: 0,
    unprobeable: 0,
    failed: 0,
    authExpired: false,
    total: selected.length,
    // Filled in just before returning, so it reports how many entries the cache
    // holds AFTER the round -- entries added or dropped while probing included.
    //
    // 在返回前才填入，因此它报告的是本轮**结束后**缓存持有的条目数——包含探测期间
    // 新增或删除的条目。
    cached: 0,
    budgetUsed: 0,
    truncated: false,
    remaining: [],
  };

  const fingerprints = new Map(models.map(([modelId, fingerprint]) => [modelId, fingerprint]));

  for (let index = 0; index < selected.length; index += 1) {
    const modelId = selected[index];
    if (transport.budgetLeft() <= 0) {
      stats.truncated = true;
      // What this round owed but never got to. The caller hands exactly this list to
      // its alarm; "everything" would restart from the top of a forced re-probe and
      // never reach the tail.
      //
      // 本轮该做却没轮到的模型。调用方把**这一份**交给 alarm；若交"全部"，强制重探就会
      // 从头部重新开始，永远到不了尾部。
      stats.remaining = selected.slice(index);
      break;
    }
    const fingerprint = fingerprints.get(modelId) ?? "";
    let probe: ModelProbe;
    try {
      probe = await probeModel(modelId, fingerprint, transport, wallClockSeconds);
    } catch (err) {
      if (err instanceof ProbeAuthExpired) {
        // Credentials died: stop the round. Everything already probed stays.
        // 凭证失效：停止本轮。已经探完的结果全部保留。
        stats.authExpired = true;
        break;
      }
      if (err instanceof ProbeBudgetExhausted) {
        // Out of budget mid-model: leave the entry untouched for the next round. This
        // model is part of what the round owes, so it stays in `remaining`.
        //
        // 探测中途预算耗尽：条目保持原样，留给下一轮。这个模型属于本轮欠下的工作，因此
        // 仍在 `remaining` 里。
        stats.truncated = true;
        stats.remaining = selected.slice(index);
        break;
      }
      // Per-model isolation: one bad probe never kills the round.
      // 逐模型隔离：单个探测失败不影响整轮。
      cache.recordFailure(modelId, fingerprint, errorMessage(err), input.now);
      stats.failed += 1;
      const changes = cache.takeChanges();
      store.apply(changes);
      input.onPersist?.(changes);
      continue;
    }

    cache.recordResult(modelId, probe, input.now);
    switch (probe.status) {
      case STATUS_OK:
        stats.ok += 1;
        break;
      case STATUS_PARTIAL:
        stats.partial += 1;
        break;
      case STATUS_UNPROBEABLE:
        stats.unprobeable += 1;
        break;
      default:
        stats.failed += 1;
        break;
    }
    const changes = cache.takeChanges();
    store.apply(changes);
    input.onPersist?.(changes);
    input.onModelDone?.(modelId, probe);
  }

  stats.budgetUsed = transport.budgetUsed();
  stats.cached = cache.size;
  return stats;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
