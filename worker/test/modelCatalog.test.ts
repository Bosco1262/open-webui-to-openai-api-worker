/**
 * Model catalog tests: normalization, the shared capability template, and the
 * engine fingerprint.
 *
 * The fingerprint vectors below were produced by the upstream Python project
 * (`json.dumps(identity, sort_keys=True, ensure_ascii=False, default=str)` +
 * `sha256(...)[:16]`), so this test pins byte-for-byte parity with it.
 *
 * 模型目录测试：规范化、共享能力模板与引擎指纹。
 *
 * 下面的指纹对照值由上游 Python 项目算出，因此这个用例把"与 Python 逐字节一致"
 * 钉住了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractModelList,
  isModelListPayload,
  looksLikeModelList,
  modelFingerprint,
  modelIdOf,
  normalizeModel,
  rawModelCapabilities,
  sharedDefaultCapabilities,
} from "../src/modelCatalog.ts";

const QWEN_RAW = {
  id: "Qwen3.8-27B",
  // vLLM rebuilds the model card per response; `created` must never enter the hash.
  // vLLM 每次响应都会重建模型卡；`created` 绝不能进入哈希。
  created: 1789036467,
  openai: { root: "/models/Qwen3.8-27B", owned_by: "vllm", max_model_len: 262144 },
  info: {
    base_model_id: "Qwen/Qwen3.8-27B",
    updated_at: 1789036467,
    meta: { description: "A reasoning model", capabilities: { vision: true, builtin_tools: true } },
  },
};

// --------------------------------------------------------------------------- //
// Fingerprint
// 指纹
// --------------------------------------------------------------------------- //

test("fingerprint matches the upstream Python implementation byte for byte", async () => {
  assert.equal(await modelFingerprint(QWEN_RAW, "Qwen3.8-27B"), "be3c49a51c39f215");
  assert.equal(await modelFingerprint({ id: "m" }, "m"), "87df25f07bbf04d9");
});

test("the top-level created never enters the fingerprint (it changes on every fetch)", async () => {
  const first = await modelFingerprint(QWEN_RAW, "Qwen3.8-27B");
  const threeSecondsLater = await modelFingerprint(
    { ...QWEN_RAW, created: 1789036470 },
    "Qwen3.8-27B",
  );
  assert.equal(first, threeSecondsLater);
});

test("a changed engine identity does move the fingerprint", async () => {
  const base = await modelFingerprint(QWEN_RAW, "Qwen3.8-27B");
  const restarted = await modelFingerprint(
    { ...QWEN_RAW, info: { ...QWEN_RAW.info, updated_at: 1789036999 } },
    "Qwen3.8-27B",
  );
  const renamed = await modelFingerprint(QWEN_RAW, "other-id");
  assert.notEqual(base, restarted);
  assert.notEqual(base, renamed);
});

test("a non-object model has no fingerprint", async () => {
  assert.equal(await modelFingerprint("just-a-string", "x"), "");
  assert.equal(await modelFingerprint(null, "x"), "");
});

test("a max_model_len of 0 is a value, not an absence (it changes the fingerprint)", async () => {
  // `||` would drop a legal 0 and hash `null` instead, so the fingerprint would differ
  // from the Python one -- and a drifting fingerprint looks exactly like "the engine
  // was swapped", i.e. a full re-probe.
  //
  // `||` 会丢掉合法的 0 而改哈希 `null`，于是指纹与 Python 侧不一致——而指纹漂移在行为上
  // 等同于"引擎被换掉了"，即触发全量重探。
  const zero = { id: "zero", max_model_len: 0, openai: { owned_by: "vllm" } };
  // Expected value computed by the upstream Python implementation for the same
  // identity (`json.dumps(sort_keys=True, default=str)` + sha256[:16]).
  //
  // 期望值由上游 Python 实现按同一身份算出（`json.dumps(sort_keys=True, default=str)`
  // + sha256[:16]）。
  assert.equal(await modelFingerprint(zero, "zero"), "67c52f2abff91a78");

  // And the served model keeps the 0 instead of omitting the context lengths.
  // 对外模型同样保留 0，而不是省略上下文字段。
  const model = normalizeModel(zero);
  assert.ok(model);
  assert.equal(model.max_model_len, 0);
  assert.equal(model.max_context_length, 0);
  assert.equal(model.context_length, 0);
});

// --------------------------------------------------------------------------- //
// Capabilities
// 能力
// --------------------------------------------------------------------------- //

test("raw capabilities keep boolean entries only", () => {
  assert.deepEqual(rawModelCapabilities(QWEN_RAW), { vision: true, builtin_tools: true });
  assert.deepEqual(rawModelCapabilities({ info: { meta: { capabilities: { a: "yes" } } } }), {});
  assert.deepEqual(rawModelCapabilities(null), {});
});

test("the shared template keeps only the keys every reporting model agrees on", () => {
  const template = sharedDefaultCapabilities([
    { info: { meta: { capabilities: { vision: true, usage: true, builtin_tools: true } } } },
    { info: { meta: { capabilities: { vision: true, builtin_tools: true } } } },
    { info: { meta: { capabilities: { vision: false, usage: true, builtin_tools: true } } } },
  ]);
  // `vision` disagrees, `usage` is not reported by everyone, `builtin_tools` is the
  // only shared fact.
  //
  // vision 取值不一致、usage 不是每个模型都上报，只有 builtin_tools 是共同事实。
  assert.deepEqual(template, { builtin_tools: true });
});

test("no reporting model means no template", () => {
  assert.equal(sharedDefaultCapabilities([{}, { id: "x" }]), null);
  assert.equal(sharedDefaultCapabilities([]), null);
});

// --------------------------------------------------------------------------- //
// Model-list payload recognition
// --------------------------------------------------------------------------- //

test("an empty but recognizable model list is trusted; an unreadable one is not", () => {
  // The coordinator must tell "the upstream really reports no models" (prune: good,
  // the models are gone) from "we could not read the response at all" (prune: wipes
  // every cached model and forces a full re-probe).
  //
  // 协调者必须区分"上游确实没有模型"（可以裁剪：模型确实下架了）与"我们完全读不懂这个
  // 响应"（裁剪会删光整个探测缓存并触发全量重探）。
  for (const empty of [[], { data: [] }, { items: [] }, { models: [] }]) {
    assert.equal(isModelListPayload(empty), true, `${JSON.stringify(empty)} is a list`);
  }
  for (const unreadable of [null, undefined, 42, "no", "<!doctype html>", {}, { data: "nope" }]) {
    assert.equal(isModelListPayload(unreadable), false, `${JSON.stringify(unreadable)} is not`);
  }
});

// --------------------------------------------------------------------------- //
// HTTP-level model-list recognition (prefix confirmation)
// --------------------------------------------------------------------------- //

test("only a readable JSON model list counts as a confirmed response", () => {
  const list = JSON.stringify({ object: "list", data: [{ id: "a" }] });
  assert.equal(looksLikeModelList(200, "application/json", list), true);
  // An EMPTY list is still a list ("the upstream really has no models"), which is what
  // lets the round prune instead of skipping.
  //
  // **空**列表也是列表（"上游确实没有模型"），这正是轮次可以裁剪而不是跳过的依据。
  assert.equal(looksLikeModelList(200, "application/json", '{"data":[]}'), true);
  assert.equal(looksLikeModelList(200, null, "[1]"), true);

  // The traps, each of which the old "anything but a 404" rule accepted.
  // 旧规则"不是 404 就算对"会接受的几种陷阱。
  assert.equal(looksLikeModelList(200, "text/html", "<!doctype html><html></html>"), false);
  assert.equal(looksLikeModelList(200, "text/html; charset=utf-8", "<html>"), false);
  // A 200 whose body is HTML but whose content-type lies.
  assert.equal(looksLikeModelList(200, "application/json", "<!doctype html>"), false);
  // A 5xx says nothing about the route.
  assert.equal(looksLikeModelList(500, "application/json", '{"detail":"boom"}'), false);
  assert.equal(looksLikeModelList(404, "application/json", '{"detail":"Not Found"}'), false);
  assert.equal(looksLikeModelList(200, "application/json", ""), false);
  assert.equal(looksLikeModelList(200, "application/json", "   "), false);
  assert.equal(looksLikeModelList(200, "application/json", "not json"), false);
  assert.equal(looksLikeModelList(200, "application/json", "null"), false);
  assert.equal(looksLikeModelList(200, "application/json", '{"data":"nope"}'), false);
});

// --------------------------------------------------------------------------- //
// Normalization
// --------------------------------------------------------------------------- //

test("normalization keeps the OpenAI shape and the whitelisted extras", () => {
  const model = normalizeModel({
    id: "GLM-5.2-NVFP4",
    name: "GLM 5.2",
    created: 1780000000,
    max_model_len: 131072,
    owned_by: "open-webui",
    openai: { owned_by: "vllm" },
    info: { created_at: 1770000000, name: "GLM", meta: { description: "A model" } },
  });
  assert.deepEqual(model, {
    id: "GLM-5.2-NVFP4",
    object: "model",
    created: 1770000000,
    owned_by: "vllm",
    name: "GLM 5.2",
    max_model_len: 131072,
    max_context_length: 131072,
    context_length: 131072,
    quantization: "NVFP4",
    description: "A model",
  });
});

test("normalization never echoes the upstream capability template", () => {
  const model = normalizeModel(QWEN_RAW);
  assert.ok(model);
  assert.equal("capabilities" in model, false);
  assert.equal("function_calling" in model, false);
  // The whole template is shared here (one reporting model), so no deviations.
  // 只有一个上报模型，全部键都属于模板，因此没有偏离。
  const withTemplate = normalizeModel(QWEN_RAW, { vision: true, builtin_tools: true });
  assert.equal("x_open_webui" in (withTemplate ?? {}), false);
});

test("a model that deviates from the template carries the deviation under x_open_webui", () => {
  const model = normalizeModel(
    { id: "DeepSeek-V4-Flash-0731", info: { meta: { capabilities: { vision: true, usage: true } } } },
    { vision: false, usage: true },
  );
  assert.ok(model);
  assert.deepEqual(model.x_open_webui, { capabilities: { vision: true } });
  assert.equal("capabilities" in model, false);
});

test("a bare string and an id-less object are handled like the upstream does", () => {
  assert.deepEqual(normalizeModel("plain-id"), {
    id: "plain-id",
    object: "model",
    created: 0,
    owned_by: "openai",
  });
  // `name` is an id fallback (upstream: `id or name or model`), and then it is also
  // published as the display name.
  //
  // name 是 id 的兜底（上游写法：id or name or model），随后同样作为展示名输出。
  assert.deepEqual(normalizeModel({ name: "fallback" }), {
    id: "fallback",
    object: "model",
    created: 0,
    owned_by: "openai",
    name: "fallback",
  });
  assert.equal(normalizeModel({}), null);
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel({ id: "" }), null);
  assert.equal(modelIdOf({ name: "fallback" }), "fallback");
  assert.equal(modelIdOf({ model: "fallback-2" }), "fallback-2");
  assert.equal(modelIdOf({}), null);
});

test("model list extraction tolerates the shapes different upstream versions use", () => {
  assert.deepEqual(extractModelList({ data: [1] }), [1]);
  assert.deepEqual(extractModelList({ items: [2] }), [2]);
  assert.deepEqual(extractModelList({ models: [3] }), [3]);
  assert.deepEqual(extractModelList([4]), [4]);
  assert.deepEqual(extractModelList({ nope: true }), []);
  assert.deepEqual(extractModelList(null), []);
});
