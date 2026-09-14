/**
 * Unit tests for modelProbe.ts -- the pure half of the model probe, ported
 * alongside the upstream Python project (commit ffef6e2: tests/test_units.py
 * test_effort_candidate_parsing / test_parameter_attribution /
 * test_probe_payloads / test_reasoning_info_derivation / test_probe_cache_store).
 *
 * Every error string below is a REAL upstream phrasing, including the ones the
 * previous implementation could not read at all: the outer pydantic literal is a
 * superset, and the model's own parser (Harmony / Qwen) rejects a subset of it
 * with a different wording.
 *
 * modelProbe.ts 纯逻辑部分的单元测试 —— 与上游 Python 项目同步移植（提交 ffef6e2：
 * tests/test_units.py 中的五个用例）。下面每一条报错文本都是**真实上游措辞**，
 * 包括旧实现完全读不懂的那些：外层 pydantic 枚举是超集，而模型自带解析器
 * （Harmony / Qwen）会以另一种措辞拒绝其中的子集。
 *
 * Run: node --test --test-isolation=none test/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKOFF_MAX_SECONDS,
  ModelProbeCache,
  buildArchitecture,
  buildReasoningInfo,
  backoffSeconds,
  createModelProbe,
  deriveReasoningCapability,
  effortPayload,
  engineBuild,
  extractDefaultEffort,
  extractEffortCandidates,
  looksLikeEffortError,
  modelProbeFromDict,
  modelProbeToDict,
  parameterOfError,
  parameterPayload,
  responseHasReasoning,
  baselinePayload,
  sortEfforts,
  visionPayload,
} from "../src/modelProbe.ts";

// --------------------------------------------------------------------------- //
// Real upstream error texts
// 真实上游报错文本
// --------------------------------------------------------------------------- //

/** Rebuild the vLLM-style outer-schema error captured from a real upstream (as
 *  JSON-wrapped by Open WebUI) for a given accepted-efforts list. */
function literalError(efforts: string[]): string {
  const quoted =
    efforts
      .slice(0, -1)
      .map((effort) => `'${effort}'`)
      .join(", ") + ` or '${efforts[efforts.length - 1]}'`;
  const detail =
    "1 validation error:\n" +
    "  {'type': 'literal_error', 'loc': ('body', 'reasoning_effort'), " +
    `'msg': "Input should be ${quoted}", ` +
    "'input': '__probe__', " +
    `'ctx': {'expected': "${quoted}"}}`;
  return JSON.stringify({ detail });
}

/** gpt-oss / Harmony second-layer rejection. */
const HARMONY =
  '{"detail": "reasoning_effort=\'max\' is not supported by Harmony. ' +
  'Supported values are: high, medium, low."}';

/** Harmony rejecting a single value without naming what it accepts. */
const HARMONY_NEGATIVE_ONLY =
  '{"detail": "Harmony does not support reasoning_effort=\'none\'"}';

/** Qwen second-layer rejection; note the space instead of an underscore, and the
 *  "(default)" marker the outer schema error never carries. */
const QWEN =
  '{"detail": "Unexpected reasoning effort max. ' +
  'Supported types are xhigh (default), medium, and low."}';

// --------------------------------------------------------------------------- //
// Effort candidate parsing
// 挡位候选解析
// --------------------------------------------------------------------------- //

test("outer schema: all seven canonical levels are read", () => {
  const full = literalError(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(extractEffortCandidates(full), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
    "none",
  ]);
});

test("outer schema: a four-level enumeration is read", () => {
  const partial = literalError(["none", "low", "medium", "high"]);
  assert.deepEqual(extractEffortCandidates(partial), ["high", "medium", "low", "none"]);
});

test("second layer: Harmony wording is understood (the old parser could not read it)", () => {
  assert.deepEqual(extractEffortCandidates(HARMONY), ["high", "medium", "low"]);
});

test("second layer: rejecting one value without naming alternatives claims nothing", () => {
  assert.deepEqual(extractEffortCandidates(HARMONY_NEGATIVE_ONLY), []);
});

test("second layer: Qwen wording (space, not underscore) is understood", () => {
  assert.deepEqual(extractEffortCandidates(QWEN), ["xhigh", "medium", "low"]);
});

test("engine-declared default is mined from the second layer only", () => {
  assert.equal(extractDefaultEffort(QWEN), "xhigh");
  assert.equal(extractDefaultEffort(HARMONY), null);
});

test("the default-effort parse is stable across repeated calls", () => {
  // The marker patterns are driven with `.exec()`. A stray `g` flag made `lastIndex`
  // survive between calls, so the SAME text parsed on one call and returned null on
  // the next -- measured as "xhigh", null, "xhigh" while probing several models in a
  // row. A missing default_effort is a wrong fact served to clients, not a crash, so
  // it needs its own assertion.
  //
  // 标注模式由 `.exec()` 驱动。多余的 `g` 会让 `lastIndex` 在调用间残留，于是**同一段
  // 文本**会一次解析成功、下一次返回 null——连续探测多个模型时实测为 "xhigh"、null、
  // "xhigh"。缺失的 default_effort 是一个错误的对外事实（而非崩溃），因此需要单独断言。
  for (let call = 1; call <= 4; call += 1) {
    assert.equal(extractDefaultEffort(QWEN), "xhigh", `call ${call} must stay stable`);
  }
  assert.equal(extractDefaultEffort(HARMONY), null, "a miss in between");
  assert.equal(extractDefaultEffort(QWEN), "xhigh", "and the next call must still hit");

  // The phrase form ("the default is high") is stateful in exactly the same way.
  // The topical guard in extractDefaultEffort requires the text to mention the
  // reasoning effort — real callers only ever pass effort-related 400 bodies,
  // and an unrelated "default is X" must NOT be mined.
  //
  // 措辞形式（"the default is high"）有完全相同的状态性问题。extractDefaultEffort
  // 的切题防线要求文本提到 reasoning effort——真实调用方只会传入与 effort 相关的
  // 400 响应体，而无关的 "default is X" 不应被挖出。
  const phrase = '{"detail": "reasoning_effort: the default is high"}';
  for (let call = 1; call <= 3; call += 1) {
    assert.equal(extractDefaultEffort(phrase), "high", `phrase call ${call}`);
  }
  // The topical guard itself: an unrelated "default is X" yields nothing.
  // 切题防线本身：与 effort 无关的 "default is X" 不得产出结果。
  assert.equal(
    extractDefaultEffort('{"detail": "the default is high"}'),
    null,
    "an off-topic default marker must be ignored",
  );
});

test("candidate extraction stays stable too (it uses matchAll, not exec)", () => {
  for (let call = 1; call <= 3; call += 1) {
    assert.deepEqual(extractEffortCandidates(QWEN), ["xhigh", "medium", "low"], `call ${call}`);
    assert.deepEqual(extractEffortCandidates(HARMONY), ["high", "medium", "low"], `call ${call}`);
  }
});

test("an unrelated literal error is not misparsed", () => {
  assert.deepEqual(
    extractEffortCandidates(
      "1 validation error:\n  {'type': 'literal_error', 'loc': ('body', 'stop'), " +
        `'msg': "Input should be 'stop' or 'length'", 'input': 'x'}`,
    ),
    [],
  );
});

test("a same-shaped error whose values are not levels is not misparsed", () => {
  assert.deepEqual(
    extractEffortCandidates(
      "loc: ('body', 'reasoning_effort'), msg: \"Input should be 'left' or 'right'\"",
    ),
    [],
  );
});

test("empty and unrelated texts yield no candidates", () => {
  assert.deepEqual(extractEffortCandidates(""), []);
  assert.deepEqual(extractEffortCandidates("Internal Server Error"), []);
});

test("looksLikeEffortError decides whether a live 400 is about the effort", () => {
  assert.equal(looksLikeEffortError(QWEN), true);
  assert.equal(looksLikeEffortError(HARMONY_NEGATIVE_ONLY), true);
  assert.equal(looksLikeEffortError("Model is not available"), false);
  assert.equal(looksLikeEffortError(""), false);
});

// --------------------------------------------------------------------------- //
// Request-parameter attribution
// 请求参数归因
// --------------------------------------------------------------------------- //

test("pydantic loc attributes precisely", () => {
  assert.equal(
    parameterOfError(
      "1 validation error:\n  {'type': 'literal_error', 'loc': ('body', 'reasoning_effort')}",
    ),
    "reasoning_effort",
  );
  assert.equal(
    parameterOfError("1 validation error:\n  {'type': 'extra_forbidden', 'loc': ('body', 'seed')}"),
    "seed",
  );
});

test("keyword attribution covers vLLM's tool-call-parser complaint", () => {
  const blamed = parameterOfError(
    '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
  );
  assert.ok(blamed === "tools" || blamed === "tool_choice", `unexpected blame: ${blamed}`);
});

test("an unattributable error returns null instead of guessing", () => {
  assert.equal(parameterOfError("Internal Server Error"), null);
  assert.equal(parameterOfError(""), null);
});

// --------------------------------------------------------------------------- //
// Probe payloads
// 探测载荷
// --------------------------------------------------------------------------- //

test("effort payload is minimal and carries exactly one level", () => {
  const effort = effortPayload("m", "high");
  assert.equal(effort.model, "m");
  assert.equal(effort.reasoning_effort, "high");
  assert.equal(effort.max_tokens, 1);
  assert.equal(effort.stream, false);
  assert.equal(effort.messages instanceof Array, true);
});

test("baseline payload omits reasoning_effort", () => {
  assert.equal("reasoning_effort" in baselinePayload("m"), false);
});

test("merged parameter payload carries every parameter under test", () => {
  const merged = parameterPayload("m", [
    "tools",
    "tool_choice",
    "response_format",
    "logprobs",
    "temperature",
    "top_p",
    "stop",
    "seed",
    "parallel_tool_calls",
  ]);
  assert.ok(Array.isArray(merged.tools));
  assert.equal(merged.tool_choice, "auto");
  assert.equal((merged.response_format as Record<string, unknown>).type, "json_schema");
  assert.equal(merged.logprobs, true);
  assert.equal(merged.top_logprobs, 1);
  assert.equal(merged.temperature, 0.7);
  assert.equal(merged.top_p, 0.9);
  assert.deepEqual(merged.stop, ["\n\n"]);
  assert.equal(merged.seed, 42);
  assert.equal(merged.parallel_tool_calls, true);
});

test("vision payload carries a 1x1 image content block", () => {
  const vision = visionPayload("m");
  const messages = vision.messages as Array<Record<string, unknown>>;
  const parts = messages[0].content as Array<Record<string, unknown>>;
  assert.ok(parts.some((part) => part.type === "image_url"));
  assert.match(String((parts[1].image_url as Record<string, unknown>).url), /^data:image\/png;base64,/);
});

test("responseHasReasoning reads thinking text, its absence, and its unknowability", () => {
  assert.equal(
    responseHasReasoning(JSON.stringify({ choices: [{ message: { content: null, reasoning: "We" } }] })),
    true,
  );
  assert.equal(
    responseHasReasoning(
      JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "We" } }] }),
    ),
    true,
  );
  assert.equal(
    responseHasReasoning(JSON.stringify({ choices: [{ message: { content: "P", reasoning: null } }] })),
    false,
  );
  assert.equal(
    responseHasReasoning(JSON.stringify({ choices: [{ message: { content: null, reasoning: null } }] })),
    null,
  );
  assert.equal(responseHasReasoning("<html>"), null);
});

test("engineBuild mines the engine build string and tolerates junk", () => {
  assert.equal(
    engineBuild(JSON.stringify({ system_fingerprint: "vllm-0.28.1rc1" })),
    "vllm-0.28.1rc1",
  );
  assert.equal(engineBuild(JSON.stringify({})), "");
  assert.equal(engineBuild("<html>"), "");
});

// --------------------------------------------------------------------------- //
// Reasoning info derivation
// 思考挡位信息推导
// --------------------------------------------------------------------------- //

test("supported_efforts are sorted into canonical order (largest effort first, as OpenRouter lists them) and unknown ones pass through last", () => {
  assert.deepEqual(
    sortEfforts(["high", "none", "medium", "low", "minimal", "xhigh", "max"]),
    ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
  );
  assert.deepEqual(sortEfforts(["turbo", "low", "none"]), ["low", "none", "turbo"]);
});

test("reasoning info carries the engine-declared default and mandatory flag", () => {
  const info = buildReasoningInfo(
    ["high", "none", "medium", "low", "minimal", "xhigh", "max"],
    "xhigh",
    true,
  );
  assert.deepEqual(info, {
    supported_efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
    mandatory: false,
    default_effort: "xhigh",
    default_enabled: true,
  });
});

test("unknown defaults are omitted rather than guessed", () => {
  const unverified = buildReasoningInfo(["low", "medium", "high"]);
  assert.ok(unverified);
  assert.equal("default_effort" in unverified, false);
  assert.equal("default_enabled" in unverified, false);
  assert.equal(unverified.mandatory, true);
  assert.equal(buildReasoningInfo([]), null);
});

test("architecture is derived from the vision conclusion only", () => {
  assert.deepEqual(buildArchitecture(false), {
    modality: "text->text",
    input_modalities: ["text"],
    output_modalities: ["text"],
  });
  assert.deepEqual(buildArchitecture(true), {
    modality: "text+image->text",
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
  });
  assert.equal(buildArchitecture(null), null);
  assert.equal(buildArchitecture(undefined), null);
});

test("reasoning capability falls back from efforts to observed default behaviour", () => {
  assert.equal(deriveReasoningCapability(["none", "low"], null), true);
  assert.equal(deriveReasoningCapability(["none"], null), false);
  assert.equal(deriveReasoningCapability(null, true), true);
  assert.equal(deriveReasoningCapability(null, false), false);
  assert.equal(deriveReasoningCapability(null, null), null);
});

// --------------------------------------------------------------------------- //
// Cache semantics
// 缓存语义
// --------------------------------------------------------------------------- //

function seededCache(): ModelProbeCache {
  const cache = new ModelProbeCache();
  cache.load([]);
  assert.deepEqual(
    cache.syncWithModels([
      ["a", "fp-a"],
      ["b", "fp-b"],
    ]),
    ["a", "b"],
  );
  cache.recordResult("a", {
    ...createModelProbe("fp-a", 1),
    status: "ok",
    supported_efforts: ["none", "low"],
    efforts_verified: true,
    default_effort: "low",
    default_enabled: true,
    capabilities: { vision: true, function_calling: false, reasoning: true },
    supported_parameters: ["temperature", "tools"],
  });
  cache.recordResult("b", {
    ...createModelProbe("fp-b", 1),
    status: "unprobeable",
    capabilities: { vision: true },
  });
  return cache;
}

test("present() emits only established facts", () => {
  const cache = seededCache();
  const presented = cache.present("a");
  assert.ok(presented);
  // present() re-sorts into the canonical order (largest effort first).
  // present() 会重新按规范顺序排序（最大挡位在前）。
  assert.deepEqual(presented.reasoning, {
    supported_efforts: ["low", "none"],
    mandatory: false,
    default_effort: "low",
    default_enabled: true,
  });
  assert.deepEqual(presented.capabilities, {
    vision: true,
    function_calling: false,
    reasoning: true,
  });
  assert.deepEqual(presented.supported_parameters, ["temperature", "tools"]);
  assert.equal(presented.architecture?.modality, "text+image->text");

  // Unprobeable: capabilities yes, reasoning no.
  const unprobeable = cache.present("b");
  assert.ok(unprobeable);
  assert.deepEqual(unprobeable.capabilities, { vision: true });
  assert.equal("reasoning" in unprobeable, false);
  assert.equal(unprobeable.architecture?.modality, "text+image->text");

  // An entry that established nothing at all presents nothing (mirrors the
  // upstream `presented or None`).
  cache.recordResult("empty", { ...createModelProbe("fp-e", 1), status: "unprobeable" });
  assert.equal(cache.present("empty"), null);

  // Nothing known yet.
  assert.equal(cache.present("c"), null);
});

test("capabilities never leak keys the probe did not establish", () => {
  const cache = new ModelProbeCache();
  cache.load([]);
  cache.recordResult("m", {
    ...createModelProbe("fp", 1),
    status: "partial",
    capabilities: { vision: false, web_search: true, builtin_tools: true, usage: true },
  });
  const presented = cache.present("m");
  assert.ok(presented);
  assert.deepEqual(presented.capabilities, { vision: false });
  // No architecture: the vision conclusion is known, so it IS emitted here.
  assert.equal(presented.architecture?.modality, "text->text");
});

test("conclusive entries are not re-probed until the engine fingerprint changes", () => {
  const cache = seededCache();
  assert.equal(cache.needsProbe("a", "fp-a"), false);
  assert.equal(cache.needsProbe("a", "fp-a2"), true);
  assert.equal(cache.needsProbe("b", "fp-b"), false);
  assert.equal(cache.needsProbe("c", "fp-c"), true);
});

test("failed probes back off instead of being retried immediately", () => {
  const cache = seededCache();
  const failed = cache.recordFailure("c", "fp-c", "boom");
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(cache.needsProbe("c", "fp-c"), false);
  assert.equal(cache.needsProbe("c", "fp-c", failed.retry_after + 1), true);
  assert.ok(backoffSeconds(1) < backoffSeconds(3));
  assert.equal(backoffSeconds(50), BACKOFF_MAX_SECONDS);
  assert.equal(backoffSeconds(1), 60);
});

test("a failed re-probe never throws away established facts", () => {
  const cache = seededCache();
  cache.recordFailure("a", "fp-a", "boom");
  // present() re-sorts into the canonical order (largest effort first).
  // present() 会重新按规范顺序排序（最大挡位在前）。
  assert.deepEqual(cache.present("a")?.reasoning?.supported_efforts, ["low", "none"]);
  assert.equal(cache.entry("a")?.status, "ok");
  assert.equal(cache.entry("a")?.last_error, "boom");
});

test("a changed fingerprint voids the previous facts", () => {
  const cache = seededCache();
  const entry = cache.recordFailure("a", "fp-a2", "engine swapped");
  assert.equal(entry.attempts, 1);
  assert.equal(entry.status, "failed");
  assert.deepEqual(entry.supported_efforts, []);
});

test("a live 400 that names a level disproves it and re-arms the model", () => {
  const cache = seededCache();
  assert.equal(cache.invalidateEffort("a", "low"), true);
  const entry = cache.entry("a");
  assert.deepEqual(entry?.supported_efforts, ["none"]);
  assert.equal(entry?.default_effort, null);
  assert.equal(entry?.status, "partial");
  assert.equal(entry?.retry_after, 0);
  assert.equal(entry?.last_error, "upstream rejected reasoning_effort='low'");
  assert.equal(cache.needsProbe("a", "fp-a"), true);
  assert.equal(cache.present("a")?.reasoning?.supported_efforts.includes("low"), false);

  // Levels the model never claimed are not "invalidated".
  assert.equal(cache.invalidateEffort("a", "max"), false);
  assert.equal(cache.invalidateEffort("nope", "low"), false);
  assert.equal(cache.invalidateEffort("a", null), false);
});

test("an id repeated in the upstream list is probed once", () => {
  // Upstreams can list the same id under two providers. Probing it twice would spend a
  // whole extra model's budget and overstate `total` by one -- and the fingerprint of
  // the duplicate must not overwrite the first one mid-round.
  //
  // 上游可能在两个 provider 下列出同一个 id。探两遍会白白多花一整个模型的预算，并让
  // `total` 多算一个——而重复项的指纹也绝不能在轮次中途覆盖第一个。
  const cache = new ModelProbeCache();
  cache.load([]);
  assert.deepEqual(
    cache.syncWithModels([
      ["dup", "fp-first"],
      ["other", "fp-other"],
      ["dup", "fp-second"],
    ]),
    ["dup", "other"],
  );

  // Force is a filter, not an early return: it must not bypass the deduplication.
  // force 是过滤条件，不是提前返回：它不能绕过去重。
  assert.deepEqual(
    cache.syncWithModels(
      [
        ["dup", "fp-first"],
        ["dup", "fp-second"],
      ],
      { force: true },
    ),
    ["dup"],
  );

  // A conclusive duplicate is not re-armed by its own repeat, and the stored entry
  // keeps the FIRST fingerprint.
  // 结论性的重复项不会被自己再次唤醒，且存储条目保留**首个**指纹。
  cache.recordResult("dup", { ...createModelProbe("fp-first", 1), status: "ok" });
  assert.deepEqual(cache.syncWithModels([["dup", "fp-first"], ["dup", "fp-second"]]), []);
  assert.equal(cache.entry("dup")?.fingerprint, "fp-first");
});

test("reconciliation drops vanished models and honours force", () => {
  const cache = seededCache();
  const missing = cache.syncWithModels([["a", "fp-a"]]);
  assert.equal(cache.size, 1);
  assert.deepEqual(missing, []);
  assert.deepEqual(cache.syncWithModels([["a", "fp-a"]], { force: true }), ["a"]);
  assert.deepEqual(
    cache.syncWithModels([
      ["a", "fp-a"],
      ["z", "fp-z"],
    ]),
    ["z"],
  );
});

test("reconciling a subset must not prune the models it was not asked about", () => {
  // The single-model read path holds exactly ONE ref. Pruning against it treats every
  // model it did not name as "gone from the upstream" and deletes its entry --
  // measured before the fix: two single-model reads took the cache from 4 entries
  // to 0.
  //
  // 单模型读取路径只持有**一个** ref。按它裁剪会把所有未被点名的模型当成"上游已下架"
  // 并删掉其条目——修复前实测：两次单模型读取把缓存从 4 条清到 0 条。
  const cache = seededCache();
  assert.equal(cache.size, 2);

  assert.deepEqual(cache.syncWithModels([["a", "fp-a"]], { prune: false }), []);
  assert.equal(cache.size, 2, "the model that was not asked about must survive");
  assert.equal(cache.entry("b")?.fingerprint, "fp-b");

  // The subset is still reconciled for the ids it DID name (a changed fingerprint
  // still re-arms them).
  //
  // 子集仍然会被对齐——对它**确实**点名的 id（指纹变了照样重新待探）。
  assert.deepEqual(cache.syncWithModels([["a", "fp-a2"]], { prune: false }), ["a"]);
  assert.equal(cache.size, 2);

  // And the authoritative full-list path keeps pruning, exactly as before.
  // 而权威的完整列表路径仍然照旧裁剪。
  assert.deepEqual(cache.syncWithModels([["a", "fp-a"]]), []);
  assert.equal(cache.size, 1, "the full-list path still drops what is gone");
});

test("change tracking reports exactly what has to be persisted", () => {
  const cache = new ModelProbeCache();
  cache.load([]);
  cache.syncWithModels([
    ["a", "fp-a"],
    ["b", "fp-b"],
  ]);
  cache.recordResult("a", { ...createModelProbe("fp-a", 1), status: "ok" });
  cache.recordResult("b", { ...createModelProbe("fp-b", 1), status: "ok" });

  const first = cache.takeChanges();
  assert.deepEqual(
    first.upserts.map(([id]) => id).sort(),
    ["a", "b"],
  );
  assert.deepEqual(first.deletes, []);
  // Taking the changes clears them: a second call has nothing to persist.
  assert.deepEqual(cache.takeChanges(), { upserts: [], deletes: [] });

  // A vanished model shows up as a delete.
  cache.syncWithModels([["a", "fp-a"]]);
  assert.deepEqual(cache.takeChanges().deletes, ["b"]);
});

test("loading is idempotent, like the upstream loader", () => {
  const cache = new ModelProbeCache();
  cache.load([["a", modelProbeFromDict({ fingerprint: "fp-a", status: "ok" })]]);
  cache.load([["b", modelProbeFromDict({ fingerprint: "fp-b", status: "ok" })]]);
  assert.equal(cache.size, 1);
  assert.ok(cache.entry("a"));
});

test("stored entries round-trip and corrupt ones degrade to a retryable default", () => {
  const probe = {
    ...createModelProbe("fp", 12.5),
    status: "ok" as const,
    attempts: 3,
    supported_efforts: ["none", "low"],
    efforts_verified: true,
    default_effort: "low",
    default_enabled: false,
    capabilities: { vision: true, function_calling: false },
    supported_parameters: ["tools"],
    system_fingerprint: "vllm-0.28.1rc1",
  };
  assert.deepEqual(modelProbeFromDict(modelProbeToDict(probe)), probe);

  // An unknown status must become "failed" so the model gets re-probed rather
  // than being mistaken for a conclusive result.
  const weird = modelProbeFromDict({ fingerprint: "fp", status: "banana" });
  assert.equal(weird.status, "failed");
  assert.equal(modelProbeFromDict(null).status, "failed");
  assert.equal(modelProbeFromDict(null).fingerprint, "");
  assert.deepEqual(modelProbeFromDict({ capabilities: { a: true, b: "yes" } }).capabilities, {
    a: true,
  });
});
