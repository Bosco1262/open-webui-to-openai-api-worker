/**
 * Probe execution tests.
 *
 * The fake upstream below reproduces the two validation layers that made the old
 * implementation wrong: the OUTER pydantic literal enumerates a superset of the
 * levels, while the model's own parser (Harmony / Qwen) rejects a subset of it --
 * and its wording is different, sometimes naming a default and sometimes not. Only
 * a real 200 may be advertised, so every test below is about counting, not about
 * trusting an enumeration.
 *
 * 探测执行测试。
 *
 * 下面的假上游复刻了让旧实现出错的两层校验：**外层** pydantic 枚举的是超集，
 * 而模型自带解析器（Harmony / Qwen）会以另一种措辞拒绝其中的子集，有时还会声明
 * 默认挡位、有时不会。只有真实的 200 才能对外声明，因此下面每个用例考的都是
 * "数请求"，而不是"信枚举"。
 *
 * Run: node --test --test-isolation=none test/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ModelProbeCache } from "../src/modelProbe.ts";
import { MemoryProbeStore } from "../src/probeStore.ts";
import type { ProbeStore, ProbeStoreChanges } from "../src/probeStore.ts";
import {
  ProbeAuthExpired,
  ProbeBudgetExhausted,
  ProbeTransient,
  isPlatformSubrequestError,
  runProbeRound,
} from "../src/probeRound.ts";
import type { ProbeAnswer, ProbeTransport } from "../src/probeRound.ts";
import type { ModelProbe } from "../src/types.ts";

// --------------------------------------------------------------------------- //
// Fake upstream
// 假上游
// --------------------------------------------------------------------------- //

interface FakeModel {
  /** Values the OUTER schema enumerates when it sees the sentinel. */
  literal: string[];
  /** Values the model's own parser actually accepts (200). */
  accepted: string[];
  /** Second-layer wording; only the qwen style names a default. */
  style?: "harmony" | "qwen";
  default?: string;
  /** Whether the engine was built with a tool-call parser. */
  tools?: boolean;
  /** Whether the engine rejects response_format. */
  rejectsResponseFormat?: boolean;
  vision?: boolean;
  /** Thinking happens when reasoning_effort is omitted. */
  reasoningByDefault?: boolean;
  /** The upstream does not validate the field at all (sentinel returns 200). */
  ignoresEffortField?: boolean;
  /** Answer 401 for every request of this model. */
  unauthorized?: boolean;
  /** Fail the request at the transport level. */
  networkError?: boolean;
}

const ENGINE_BUILD = "vllm-0.28.1rc1";

function literalError(efforts: string[]): string {
  const quoted =
    efforts
      .slice(0, -1)
      .map((effort) => `'${effort}'`)
      .join(", ") + ` or '${efforts[efforts.length - 1]}'`;
  return JSON.stringify({
    detail:
      "1 validation error:\n" +
      "  {'type': 'literal_error', 'loc': ('body', 'reasoning_effort'), " +
      `'msg': "Input should be ${quoted}", 'input': '__probe__'}`,
  });
}

function secondLayerError(model: FakeModel, value: string): string {
  if (model.style === "qwen") {
    const rest = model.accepted.filter((level) => level !== model.default);
    const tail = rest.length > 1 ? `${rest.slice(0, -1).join(", ")}, and ${rest[rest.length - 1]}` : rest.join("");
    const named = model.default ? `${model.default} (default), ${tail}` : tail;
    return JSON.stringify({
      detail: `Unexpected reasoning effort ${value}. Supported types are ${named}.`,
    });
  }
  return JSON.stringify({
    detail:
      `reasoning_effort='${value}' is not supported by Harmony. ` +
      `Supported values are: ${model.accepted.join(", ")}.`,
  });
}

function completion(hasReasoning: boolean): string {
  return JSON.stringify({
    system_fingerprint: ENGINE_BUILD,
    choices: [
      {
        message: hasReasoning
          ? { content: null, reasoning: "Thinking" }
          : { content: "Pong", reasoning: null },
      },
    ],
  });
}

class FakeUpstream implements ProbeTransport {
  /** Every request, in order, as "modelId:kind". */
  readonly log: string[] = [];
  /** How many requests each model consumed. */
  readonly perModel = new Map<string, number>();
  private readonly models: Record<string, FakeModel>;
  private readonly budgetAllocation: number;
  private readonly secondsPerRequest: number;
  private clock: number;
  private used = 0;

  constructor(
    models: Record<string, FakeModel>,
    budgetAllocation: number,
    secondsPerRequest = 0.01,
  ) {
    this.models = models;
    this.budgetAllocation = budgetAllocation;
    this.secondsPerRequest = secondsPerRequest;
    this.clock = 1_000;
  }

  now(): number {
    return this.clock;
  }

  budgetLeft(): number {
    return this.budgetAllocation - this.used;
  }

  budgetUsed(): number {
    return this.used;
  }

  async ask(modelId: string, payload: Record<string, unknown>): Promise<ProbeAnswer> {
    const model = this.models[modelId];
    if (!model) throw new ProbeTransient(`unknown model ${modelId}`);
    if (this.used >= this.budgetAllocation) throw new ProbeBudgetExhausted();
    this.used += 1;
    this.clock += this.secondsPerRequest;
    this.perModel.set(modelId, (this.perModel.get(modelId) ?? 0) + 1);

    if (model.networkError) throw new ProbeTransient("connection reset");
    if (model.unauthorized) throw new ProbeAuthExpired("401");

    const effort = payload.reasoning_effort;
    // Any request carrying one of the probed parameters is the merged parameter
    // request -- including the retry, which no longer carries `tools`.
    //
    // 任何携带待测参数之一的请求就是参数合并请求——包括已经不含 tools 的重试。
    const carriesParameters = [
      "tools",
      "tool_choice",
      "response_format",
      "logprobs",
      "temperature",
      "top_p",
      "stop",
      "seed",
      "parallel_tool_calls",
    ].some((key) => key in payload);
    const kind =
      effort === "__probe__"
        ? "sentinel"
        : typeof effort === "string"
          ? `verify:${effort}`
          : carriesParameters
            ? "params"
            : Array.isArray((payload.messages as Array<{ content?: unknown }>)[0].content)
              ? "vision"
              : "baseline";
    this.log.push(`${modelId}:${kind}`);

    if (kind === "sentinel") {
      if (model.ignoresEffortField) {
        return { status: 200, body: completion(model.reasoningByDefault ?? true) };
      }
      return { status: 400, body: literalError(model.literal) };
    }

    if (kind.startsWith("verify:")) {
      const value = kind.slice("verify:".length);
      if (model.accepted.includes(value)) {
        return { status: 200, body: completion(model.reasoningByDefault ?? true) };
      }
      return { status: 400, body: secondLayerError(model, value) };
    }

    if (kind === "params") {
      // An engine without a tool-call parser rejects whichever of the two it sees
      // first; once the caller drops both, the retry succeeds.
      //
      // 没有 tool-call parser 的引擎会拒绝它先看到的那个；调用方把两者都剔除后，
      // 重试就会成功。
      if (model.tools === false && ("tools" in payload || "tool_choice" in payload)) {
        return {
          status: 400,
          body: JSON.stringify({
            detail:
              '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
          }),
        };
      }
      if (model.rejectsResponseFormat && "response_format" in payload) {
        return {
          status: 400,
          body: JSON.stringify({
            detail: "1 validation error: {'loc': ('body', 'response_format'), 'type': 'extra_forbidden'}",
          }),
        };
      }
      return { status: 200, body: completion(model.reasoningByDefault ?? true) };
    }

    if (kind === "vision") {
      if (model.vision === false) {
        return { status: 400, body: JSON.stringify({ detail: "This model does not support image input" }) };
      }
      return { status: 200, body: completion(model.reasoningByDefault ?? false) };
    }

    return { status: 200, body: completion(model.reasoningByDefault ?? false) };
  }
}

/** A store that records how many times it was written. */
class CountingStore implements ProbeStore {
  readonly inner: MemoryProbeStore;
  writes = 0;

  constructor(initial: Iterable<readonly [string, ModelProbe]> = []) {
    this.inner = new MemoryProbeStore(initial);
  }

  loadAll(): Array<[string, ModelProbe]> {
    return this.inner.loadAll();
  }

  apply(changes: ProbeStoreChanges): void {
    this.writes += 1;
    this.inner.apply(changes);
  }

  snapshot(): Map<string, ModelProbe> {
    return this.inner.snapshot();
  }
}

function roundWith(
  fake: FakeUpstream,
  store: CountingStore,
  entries: ReadonlyArray<readonly [string, string]>,
  options: { force?: boolean; wallClockSeconds?: number; prune?: boolean } = {},
) {
  const cache = new ModelProbeCache();
  cache.load(store.loadAll());
  return runProbeRound({
    cache,
    store,
    models: entries,
    transport: fake,
    force: options.force,
    prune: options.prune,
    now: fake.now(),
    wallClockSeconds: options.wallClockSeconds,
  }).then((stats) => ({ stats, cache, store }));
}

// --------------------------------------------------------------------------- //
// The two validation layers
// 两层校验
// --------------------------------------------------------------------------- //

test("a level the outer schema advertises but the model rejects is never claimed", async () => {
  const fake = new FakeUpstream(
    {
      "Qwen3.8-27B": {
        literal: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        accepted: ["none", "low", "medium", "xhigh"],
        style: "qwen",
        default: "xhigh",
        tools: true,
        vision: true,
        reasoningByDefault: true,
      },
    },
    40,
  );
  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [["Qwen3.8-27B", "fp-1"]]);

  const probe = store.snapshot().get("Qwen3.8-27B");
  assert.ok(probe);
  assert.equal(probe.status, "ok");
  // Largest effort first, aligned with how OpenRouter lists levels.
  // 最大挡位在前，与 OpenRouter 的排列一致。
  assert.deepEqual(probe.supported_efforts, ["xhigh", "medium", "low", "none"]);
  assert.equal(probe.default_effort, "xhigh");
  assert.equal(probe.efforts_verified, true);
  assert.deepEqual(probe.capabilities, {
    vision: true,
    function_calling: true,
    structured_outputs: true,
    reasoning: true,
  });
  assert.deepEqual(probe.supported_parameters, [
    "logprobs",
    "parallel_tool_calls",
    "reasoning_effort",
    "response_format",
    "seed",
    "stop",
    "temperature",
    "tool_choice",
    "tools",
    "top_p",
  ]);
  assert.equal(probe.system_fingerprint, ENGINE_BUILD);

  // 1 sentinel + 7 verifications + 1 merged parameter request + 1 vision + 1 baseline
  assert.equal(fake.perModel.get("Qwen3.8-27B"), 11);
  assert.equal(stats.ok, 1);
  assert.equal(stats.budgetUsed, 11);
});

test("Harmony wording is understood and a mandatory model is flagged", async () => {
  const fake = new FakeUpstream(
    {
      "gpt-oss-120b": {
        literal: ["low", "medium", "high", "xhigh", "max"],
        accepted: ["low", "medium", "high"],
        style: "harmony",
        tools: true,
        vision: false,
        reasoningByDefault: true,
      },
    },
    40,
  );
  const store = new CountingStore();
  await roundWith(fake, store, [["gpt-oss-120b", "fp-1"]]);

  const probe = store.snapshot().get("gpt-oss-120b");
  assert.ok(probe);
  assert.deepEqual(probe.supported_efforts, ["high", "medium", "low"]);
  // "none" was never accepted, and Harmony named no default.
  assert.equal(probe.default_effort, null);
  assert.equal(probe.capabilities.vision, false);
  assert.equal(probe.default_enabled, true);
  assert.equal(probe.efforts_verified, true);
});

test("tools and tool_choice are disproved together and the round carries on", async () => {
  const fake = new FakeUpstream(
    {
      "gemma-4-31B-it": {
        literal: ["none", "low", "medium"],
        accepted: ["none", "low"],
        style: "harmony",
        tools: false,
        vision: true,
        reasoningByDefault: false,
      },
    },
    40,
  );
  const store = new CountingStore();
  await roundWith(fake, store, [["gemma-4-31B-it", "fp-1"]]);

  const probe = store.snapshot().get("gemma-4-31B-it");
  assert.ok(probe);
  assert.equal(probe.status, "ok");
  assert.equal(probe.capabilities.function_calling, false);
  // The parameter step is retried without the blamed pair.
  assert.equal(fake.log.filter((entry) => entry.endsWith(":params")).length, 2);
  assert.equal(probe.supported_parameters.includes("tools"), false);
  assert.equal(probe.supported_parameters.includes("tool_choice"), false);
  // Everything else was cleared by the retry.
  assert.equal(probe.supported_parameters.includes("temperature"), true);
});

test("a 400 that cannot be attributed leaves the parameters unclaimed (partial)", async () => {
  const fake = new FakeUpstream(
    {
      "mystery": {
        literal: ["none"],
        accepted: ["none"],
        tools: false,
        vision: true,
        // Blame-free 400: the round must not guess which parameter caused it.
        rejectsResponseFormat: true,
      },
    },
    40,
  );
  // Sabotage: make the parameter step fail without a loc and without keywords.
  const originalAsk = fake.ask.bind(fake);
  fake.ask = async (modelId: string, payload: Record<string, unknown>) => {
    if ("tools" in payload) {
      return { status: 400, body: JSON.stringify({ detail: "Internal Server Error" }) };
    }
    return originalAsk(modelId, payload);
  };

  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [["mystery", "fp-1"]]);
  const probe = store.snapshot().get("mystery");
  assert.ok(probe);
  assert.equal(probe.status, "partial");
  assert.equal(probe.efforts_verified, true);
  assert.equal("function_calling" in probe.capabilities, false);
  assert.deepEqual(probe.supported_parameters, ["reasoning_effort"]);
  assert.match(probe.last_error, /left the answer open/);
  assert.equal(stats.partial, 1);
});

// --------------------------------------------------------------------------- //
// Unprobeable, budget, auth, transient failures
// 不可探测、预算、凭证、暂时性失败
// --------------------------------------------------------------------------- //

test("an upstream that ignores the field is unprobeable but still yields capabilities", async () => {
  const fake = new FakeUpstream(
    {
      legacy: {
        literal: [],
        accepted: [],
        ignoresEffortField: true,
        tools: true,
        vision: true,
        reasoningByDefault: true,
      },
    },
    40,
  );
  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [["legacy", "fp-1"]]);

  const probe = store.snapshot().get("legacy");
  assert.ok(probe);
  assert.equal(probe.status, "unprobeable");
  assert.deepEqual(probe.supported_efforts, []);
  assert.equal(probe.efforts_verified, false);
  // Capabilities are still established; reasoning comes from observed behaviour.
  assert.deepEqual(probe.capabilities, {
    vision: true,
    function_calling: true,
    structured_outputs: true,
    reasoning: true,
  });
  assert.deepEqual(probe.supported_parameters, [
    "logprobs",
    "parallel_tool_calls",
    "response_format",
    "seed",
    "stop",
    "temperature",
    "tool_choice",
    "tools",
    "top_p",
  ]);
  // sentinel + params + vision + baseline: no verification requests at all.
  assert.equal(fake.perModel.get("legacy"), 4);
  assert.equal(stats.unprobeable, 1);

  // A second round is a no-op: the result is conclusive until the fingerprint moves.
  const second = await roundWith(fake, new CountingStore(store.snapshot()), [["legacy", "fp-1"]]);
  assert.equal(second.stats.total, 0);
});

// --------------------------------------------------------------------------- //
// Platform subrequest cap
// 平台子请求上限
// --------------------------------------------------------------------------- //

test("the platform's per-invocation subrequest cap is recognised", () => {
  // The exact wording workerd answers with on the free plan.
  // 免费层上 workerd 的原始报错原文。
  const platform = new Error(
    "Too many subrequests by single Worker invocation. To configure this limit, " +
      "refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits",
  );
  assert.equal(isPlatformSubrequestError(platform), true);
  assert.equal(isPlatformSubrequestError("Error: too many subrequests"), true);
  // Anything about the upstream or the model stays a per-model failure.
  // 与上游或模型相关的失败仍然按逐模型失败处理。
  assert.equal(isPlatformSubrequestError(new Error("probe request failed: TypeError: x")), false);
  assert.equal(isPlatformSubrequestError(null), false);
  assert.equal(isPlatformSubrequestError(new Error("upstream did not answer within the header timeout")), false);
});

test("the budget truncates the round without recording a failure", async () => {
  const fake = new FakeUpstream(
    {
      first: {
        literal: ["none", "low"],
        accepted: ["none", "low"],
        tools: true,
        vision: true,
        reasoningByDefault: true,
      },
      second: {
        literal: ["none", "low"],
        accepted: ["none", "low"],
        tools: true,
        vision: true,
        reasoningByDefault: true,
      },
    },
    // Each model costs 1 sentinel + 2 verifications + 1 params + 1 vision +
    // 1 baseline = 6 requests; 9 leaves the second model half-probed.
    //
    // 每个模型花 1 哨兵 + 2 逐值 + 1 参数 + 1 视觉 + 1 基线 = 6 个请求；
    // 给 9 就会让第二个模型探到一半。
    9,
  );
  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [
    ["first", "fp-1"],
    ["second", "fp-1"],
  ]);

  assert.equal(stats.truncated, true);
  assert.equal(stats.ok, 1);
  assert.equal(stats.failed, 0);
  assert.equal(stats.budgetUsed, 9);
  assert.ok(store.snapshot().has("first"));
  // The model cut short by the budget is left untouched: this round proved
  // nothing about it, so it must not be recorded as a failure.
  assert.equal(store.snapshot().has("second"), false);
  // Whatever the round did not finish travels with the stats so the alarm can start
  // where it stopped. Resuming "from the top" would re-probe `first` and never reach
  // `second`, burning the budget in a loop.
  //
  // 本轮没做完的部分随统计一起返回，使 alarm 能从停下的地方开始。若"从头再来"，就会
  // 重复 `first` 而永远到不了 `second`，把预算烧在循环里。
  assert.deepEqual(stats.remaining, ["second"]);
});

test("credentials dying mid-round stop it and keep what was already established", async () => {
  const fake = new FakeUpstream(
    {
      good: {
        literal: ["none"],
        accepted: ["none"],
        tools: true,
        vision: true,
        reasoningByDefault: false,
      },
      dead: { literal: [], accepted: [], unauthorized: true },
    },
    40,
  );
  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [
    ["good", "fp-1"],
    ["dead", "fp-1"],
  ]);

  assert.equal(stats.authExpired, true);
  assert.equal(stats.ok, 1);
  assert.equal(stats.failed, 0);
  assert.ok(store.snapshot().has("good"));
  assert.equal(store.snapshot().has("dead"), false);
});

test("a transport failure backs the model off and never kills the round", async () => {
  const fake = new FakeUpstream(
    {
      flaky: { literal: [], accepted: [], networkError: true },
      solid: {
        literal: ["none"],
        accepted: ["none"],
        tools: true,
        vision: true,
        reasoningByDefault: true,
      },
    },
    40,
  );
  const store = new CountingStore();
  const { stats, cache } = await roundWith(fake, store, [
    ["flaky", "fp-1"],
    ["solid", "fp-1"],
  ]);

  assert.equal(stats.failed, 1);
  assert.equal(stats.ok, 1);
  const flaky = store.snapshot().get("flaky");
  assert.ok(flaky);
  assert.equal(flaky.status, "failed");
  assert.equal(flaky.attempts, 1);
  assert.equal(flaky.last_error, "connection reset");
  // Backoff: not immediately re-probed.
  assert.equal(cache.needsProbe("flaky", "fp-1", fake.now()), false);
  assert.equal(cache.needsProbe("flaky", "fp-1", flaky.retry_after + 1), true);
});

test("a per-model wall clock turns a stalled probe into a retryable failure", async () => {
  const fake = new FakeUpstream(
    {
      slow: {
        literal: ["none", "low", "medium", "high", "xhigh", "max"],
        accepted: ["none"],
        tools: true,
        vision: true,
        reasoningByDefault: false,
      },
    },
    40,
    // 0.2s per request against a 0.5s wall clock: the probe stalls mid-way.
    0.2,
  );
  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [["slow", "fp-1"]], { wallClockSeconds: 0.5 });

  assert.equal(stats.failed, 1);
  const probe = store.snapshot().get("slow");
  assert.ok(probe);
  assert.equal(probe.status, "failed");
  assert.match(probe.last_error, /wall clock/);
});

// --------------------------------------------------------------------------- //
// Persistence discipline
// 落盘纪律
// --------------------------------------------------------------------------- //

test("each model is persisted as it lands, not once at the end", async () => {
  const fake = new FakeUpstream(
    {
      a: { literal: ["none"], accepted: ["none"], tools: true, vision: true, reasoningByDefault: true },
      b: { literal: ["none"], accepted: ["none"], tools: true, vision: true, reasoningByDefault: true },
      c: { literal: ["none"], accepted: ["none"], tools: true, vision: true, reasoningByDefault: true },
    },
    40,
  );
  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [
    ["a", "fp"],
    ["b", "fp"],
    ["c", "fp"],
  ]);

  assert.equal(stats.ok, 3);
  // One write for the reconciliation plus one per model.
  assert.equal(store.writes, 4);
  assert.equal(store.snapshot().size, 3);
  // A completed round owes nothing: an empty list clears the alarm's pending work.
  // 完成的轮次不欠任何工作：空列表会清掉 alarm 的待续工作。
  assert.deepEqual(stats.remaining, []);
});

test("a changed fingerprint forces a re-probe, force overrides everything", async () => {
  const fake = new FakeUpstream(
    {
      a: { literal: ["none"], accepted: ["none"], tools: true, vision: true, reasoningByDefault: true },
    },
    40,
  );
  const store = new CountingStore();
  await roundWith(fake, store, [["a", "fp-1"]]);
  const requestsAfterFirst = fake.perModel.get("a") ?? 0;

  // Same fingerprint: conclusive, nothing to do.
  const idle = await roundWith(fake, new CountingStore(store.snapshot()), [["a", "fp-1"]]);
  assert.equal(idle.stats.total, 0);

  // New fingerprint: re-probe.
  const moved = await roundWith(fake, new CountingStore(store.snapshot()), [["a", "fp-2"]]);
  assert.equal(moved.stats.total, 1);
  assert.equal(moved.stats.ok, 1);
  assert.ok((fake.perModel.get("a") ?? 0) > requestsAfterFirst);
});

test("a 400 blaming an already-dropped parameter stops the loop instead of spinning", async () => {
  const fake = new FakeUpstream(
    {
      "flaky-parser": {
        literal: ["none", "low"],
        accepted: ["none", "low"],
        tools: false,
        vision: true,
        reasoningByDefault: false,
      },
    },
    40,
  );
  // The first parameter request is answered by the real fake (a tools rejection, which
  // drops `tools` and `tool_choice` together); every later one blames `tool_choice`,
  // which is by then already dropped.
  //
  // 第一次参数请求由真实的假上游作答（tools 被拒绝，于是 `tools` 与 `tool_choice`
  // 一起被剔除）；此后每次都由 `tool_choice` 背锅，而它此时早已被剔除。
  const originalAsk = fake.ask.bind(fake);
  let parameterRequests = 0;
  fake.ask = async (modelId: string, payload: Record<string, unknown>) => {
    const isParameterRequest = [
      "tools",
      "tool_choice",
      "response_format",
      "logprobs",
      "temperature",
      "top_p",
      "stop",
      "seed",
      "parallel_tool_calls",
    ].some((key) => key in payload);
    if (!isParameterRequest) return originalAsk(modelId, payload);
    parameterRequests += 1;
    if (parameterRequests === 1) return originalAsk(modelId, payload);
    return {
      status: 400,
      body: JSON.stringify({
        detail: "1 validation error:\n  {'loc': ('body', 'tool_choice'), 'type': 'literal_error'}",
      }),
    };
  };

  const store = new CountingStore();
  const { stats } = await roundWith(fake, store, [["flaky-parser", "fp-1"]]);
  const probe = store.snapshot().get("flaky-parser");
  assert.ok(probe);

  // The old loop retried the same request until the round cap (10 times); a wrong
  // verdict costs requests and still ends "ok" with parameters left undecided.
  //
  // 旧循环会把同一个请求重试到轮次上限（10 次）；错误结论既浪费请求，又会以"ok"收场却
  // 留下未定性的参数。
  assert.equal(parameterRequests, 2, "the loop must stop after the second blame");
  assert.equal(probe.status, "partial");
  assert.match(probe.last_error, /left the answer open/);
  // The facts established before the stop survive (tools/tool_choice are disproved).
  // 停止之前确立的事实保留（tools/tool_choice 已被证伪）。
  assert.equal(probe.capabilities.function_calling, false);
  assert.deepEqual(probe.supported_parameters, ["reasoning_effort"]);
  assert.equal(stats.partial, 1);
  assert.equal(stats.ok, 0);
});

test("a subset round leaves the models it was not asked about alone", async () => {
  const fake = new FakeUpstream(
    {
      a: { literal: ["none"], accepted: ["none"], tools: true, vision: true, reasoningByDefault: true },
      b: { literal: ["none"], accepted: ["none"], tools: true, vision: true, reasoningByDefault: true },
    },
    40,
  );
  const store = new CountingStore();
  const full = await roundWith(fake, store, [
    ["a", "fp-a"],
    ["b", "fp-b"],
  ]);
  assert.equal(full.stats.ok, 2);
  assert.equal(store.snapshot().size, 2);

  // The single-model read path: ONE ref, and `prune: false` because that ref is not
  // the authoritative upstream list.
  //
  // 单模型读取路径：**一个** ref，且 `prune: false`——因为它并非权威的上游列表。
  const subset = await roundWith(fake, new CountingStore(store.snapshot()), [["a", "fp-a"]], {
    prune: false,
  });
  assert.equal(subset.stats.total, 0);
  assert.equal(subset.store.snapshot().size, 2, "b must survive a single-model read");

  // Without the flag the very same call drops `b` -- the bug this test pins down.
  // 没有该标志时，完全相同的调用会删掉 `b`——这正是本测试钉住的 bug。
  const pruned = await roundWith(fake, new CountingStore(store.snapshot()), [["a", "fp-a"]]);
  assert.equal(pruned.store.snapshot().size, 1, "the full-list path still prunes");
});
