/**
 * Contract tests for the /v1 surface: the per-model fields, the envelope, the
 * single-model endpoint and the 400 self-heal.
 *
 * Everything upstream is stubbed (fetch, KV, the Durable Object), so these tests
 * pin the CONTRACT -- which fields may appear, what is deliberately absent, and what
 * an unknown model answers. The real numbers (which levels Qwen/gpt-oss really
 * accept) can only come from a real upstream and are checked in the acceptance run.
 *
 * /v1 契约测试：每模型字段、信封、单模型端点与 400 自愈。
 *
 * 上游全部被 stub（fetch、KV、Durable Object），因此用例钉住的是**契约**——哪些字段
 * 可以出现、哪些刻意不出现、未知模型回什么。真实数字（Qwen/gpt-oss 真正接受哪些挡位）
 * 只能来自真实上游，在验收阶段核对。
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { handleV1Request } from "../src/proxy.ts";
import { modelFingerprint } from "../src/modelCatalog.ts";
import { setSession } from "../src/kv.ts";
import { writeProbeSettings } from "../src/probeSettings.ts";
import type { Env, InstanceMeta, ModelProbeFields, ProbeSettings } from "../src/types.ts";

// --------------------------------------------------------------------------- //
// Fakes
// 测试替身
// --------------------------------------------------------------------------- //

const BASE_URL = "https://upstream.test";
const API_KEY = "sk-contract-test";

/**
 * The pristine fetch, restored before every test in this file.
 *
 * Every harness stubs `globalThis.fetch`; the suite runs with
 * `--test-isolation=none` (all files in one process), so a stub left behind by the
 * previous test (or file) would answer this file's tests instead of their harness.
 * Module top-level code executes before any test, so this captures the real fetch.
 *
 * 原始的 fetch，本文件每个测试开始前恢复。
 *
 * 每个 harness 都会替换 `globalThis.fetch`；测试套件以 `--test-isolation=none`
 * 运行（所有文件同进程），上一个测试（或文件）留下的 stub 会替本文件的测试作答，
 * 而不是走它们各自的 harness。模块顶层代码在任何测试之前执行，因此这里捕获的是
 * 真正的 fetch。
 */
const REAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

class FakeKV {
  private readonly store = new Map<string, string>();
  /** Key prefixes whose reads FAIL (a broken namespace, not a missing value). */
  readonly failOn = new Set<string>();

  seed(key: string, value: unknown): void {
    this.store.set(key, JSON.stringify(value));
  }

  async get(key: string, type?: unknown): Promise<unknown> {
    for (const prefix of this.failOn) {
      if (key.startsWith(prefix)) throw new Error(`KV unavailable for ${prefix}`);
    }
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === "json") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Records what the proxy asked the coordinator to do. */
class FakeCoordinator {
  readonly invalidated: Array<[string, string | null]> = [];
  /** Every `present` call, in order, with the options it carried. */
  readonly presents: Array<{
    refs: Array<[string, string]>;
    waitSeconds: number;
    options: { wantInstanceMeta?: boolean; defaultModelCapabilities?: Record<string, boolean> | null };
  }> = [];
  calls = 0;
  fields: Record<string, ModelProbeFields> = {};
  /** What the coordinator would serve as the instance snapshot. */
  instanceMeta: InstanceMeta | null = null;
  refs: Array<[string, string]> = [];
  waitSeconds = -1;

  async present(
    refs: Array<[string, string]>,
    waitSeconds: number,
    options: { wantInstanceMeta?: boolean; defaultModelCapabilities?: Record<string, boolean> | null } = {},
  ): Promise<{ fields: Record<string, ModelProbeFields>; instanceMeta: InstanceMeta | null }> {
    this.calls += 1;
    this.refs = refs;
    this.waitSeconds = waitSeconds;
    this.presents.push({ refs, waitSeconds, options });
    return {
      fields: this.fields,
      // Mirrors the coordinator: a caller that does not want the envelope gets null.
      // 与协调者一致：不要信封的调用方拿到 null。
      instanceMeta: options.wantInstanceMeta === false ? null : this.instanceMeta,
    };
  }

  async invalidate(modelId: string, effort: string | null): Promise<boolean> {
    this.invalidated.push([modelId, effort]);
    return true;
  }
}

interface Harness {
  env: Env;
  coordinator: FakeCoordinator;
  kv: FakeKV;
  waitUntil: Promise<unknown>[];
  upstream: {
    calls: string[];
    /** Headers sent upstream, one entry per call, for "what is forwarded" assertions. */
    headers: Array<Record<string, string>>;
    /** Body text sent upstream, one entry per call ("" when there was none). */
    bodies: string[];
    /** Whether each call carried an abort signal (the upstream timeout). */
    signals: boolean[];
    /** Models path -> status, for prefix-detection tests. */
    modelsStatus: Map<string, number>;
    /** Paths whose `/models` answer is the SPA's HTML page (200 + text/html). */
    modelsHtmlPaths: Set<string>;
    /** Set to make every models call reject the way a timeout does. */
    modelsTimeout: boolean;
  };
}

const RAW_MODELS = [
  {
    id: "Shared-1",
    name: "Shared One",
    created: 1789036467,
    max_model_len: 262144,
    openai: { root: "/models/Shared-1", owned_by: "vllm", max_model_len: 262144 },
    info: {
      base_model_id: "org/Shared-1",
      updated_at: 1789036467,
      meta: {
        description: "A shared model",
        capabilities: { vision: true, builtin_tools: true, usage: true },
      },
    },
  },
  {
    // Deviates from the template: claims vision the shared template also claims is
    // true here, so instead disagree on `vision` to exercise the deviation path.
    //
    // 与模板不一致：这里让 vision 取值不同，用来验证差异键路径。
    id: "Deviant-2",
    openai: { root: "/models/Deviant-2", owned_by: "vllm" },
    info: {
      base_model_id: "org/Deviant-2",
      updated_at: 1789036999,
      meta: { capabilities: { vision: false, builtin_tools: true, usage: true } },
    },
  },
];

interface HarnessOptions {
  settings: ProbeSettings;
  chatStatus?: number;
  chatBody?: string;
  /**
   * Upstream root. Each prefix-detection test needs its OWN value: `detectPrefix`
   * caches the confirmed prefix per base URL in module state, so sharing one URL
   * would leak a result from a previous test.
   *
   * 上游根地址。每个前缀探测用例都需要自己的值：`detectPrefix` 按 base URL 把确认结果
   * 缓存在模块状态里，共用一个地址会让上一个用例的结果泄进来。
   */
  baseUrl?: string;
  /** Status the upstream answers a `/models` path with, keyed by pathname. */
  /** 上游对某个 `/models` 路径回的状态码，按 pathname 指定。 */
  modelsStatus?: Record<string, number>;
  /** Answer these `/models` paths with the SPA's HTML page (200 + text/html). */
  /** 让这些 `/models` 路径回 SPA 的 HTML 页面（200 + text/html）。 */
  modelsHtmlPaths?: string[];
  /** Make the `/models` request reject the way a timed-out fetch does. */
  /** 让 `/models` 请求像超时那样 reject。 */
  modelsTimeout?: boolean;
}

async function makeHarness(options: HarnessOptions): Promise<Harness> {
  const kv = new FakeKV();
  const coordinator = new FakeCoordinator();
  const waitUntil: Promise<unknown>[] = [];
  const baseUrl = options.baseUrl ?? BASE_URL;
  const upstream: Harness["upstream"] = {
    calls: [],
    headers: [],
    bodies: [],
    signals: [],
    modelsStatus: new Map(Object.entries(options.modelsStatus ?? {})),
    modelsHtmlPaths: new Set(options.modelsHtmlPaths ?? []),
    modelsTimeout: options.modelsTimeout === true,
  };

  kv.seed(`apikey:${API_KEY}`, { name: "test", prefix: API_KEY, created_at: 0, last_used: 0 });

  const env = {
    KV: kv as unknown as KVNamespace,
    PROBE: { getByName: () => coordinator } as unknown as DurableObjectNamespace,
  } as unknown as Env;

  // `setSession` (rather than a raw KV seed) because `getSession` is served from a
  // module-level 60-second instance cache: the first harness in this file owns that
  // entry, so a later harness with a different upstream root must go through the API
  // that refreshes it -- otherwise every harness would talk to the first one's
  // upstream.
  //
  // 用 `setSession`（而不是直接写 KV）：`getSession` 由模块级 60 秒实例缓存提供，本文件
  // 里第一个 harness 占住了那条缓存，因此后续要换上游根地址的 harness 必须走会刷新缓存的
  // API——否则所有 harness 都会对上第一个的上游说话。
  await setSession(env, {
    authorization: "Bearer upstream-token",
    cookie: "",
    user_agent: "test-agent",
    captured_at: 0,
    base_url: baseUrl,
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    upstream.calls.push(`${method} ${url}`);
    const sentHeaders: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      sentHeaders[key.toLowerCase()] = value;
    });
    upstream.headers.push(sentHeaders);
    upstream.signals.push(init?.signal instanceof AbortSignal);
    upstream.bodies.push(
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : "",
    );
    if (url.includes("/models")) {
      const pathname = new URL(url).pathname;
      const forced = upstream.modelsStatus.get(pathname);
      if (forced !== undefined) {
        return new Response(JSON.stringify({ detail: `forced ${forced}` }), {
          status: forced,
          headers: { "content-type": "application/json" },
        });
      }
      if (upstream.modelsHtmlPaths.has(pathname)) {
        return new Response("<!doctype html><html><body>SPA</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (upstream.modelsTimeout) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return Response.json({ object: "list", data: RAW_MODELS });
    }
    if (url.endsWith("/api/config")) {
      return Response.json({
        name: "Test OWUI",
        version: "0.9.2",
        features: { enable_signup: false, web_search: true },
      });
    }
    if (url.endsWith("/chat/completions")) {
      const status = options.chatStatus ?? 400;
      const body =
        options.chatBody ??
        JSON.stringify({
          detail:
            "reasoning_effort='max' is not supported by Harmony. Supported values are: high, medium, low.",
        });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  // writeProbeSettings also refreshes the module-level instance cache, so each test
  // starts from exactly the settings it asked for. Instance metadata is NOT seeded
  // here any more: it now comes from the coordinator (see `instanceMeta` above).
  //
  // writeProbeSettings 会同时刷新模块级实例缓存，因此每个用例都从它自己声明的设置
  // 开始。实例元数据不再在此预置：它现在来自协调者（见上面的 `instanceMeta`）。
  void writeProbeSettings(env, options.settings);

  return {
    env,
    coordinator,
    kv,
    waitUntil,
    upstream,
  };
}

function requestFor(path: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const ctx = (waitUntil: Promise<unknown>[]): ExecutionContext =>
  ({ waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise) }) as unknown as ExecutionContext;

const DEFAULT_SETTINGS: ProbeSettings = {
  enabled: true,
  timeout: 30,
  wait: 5,
  budget: 40,
  exposeInstanceMeta: true,
};

// --------------------------------------------------------------------------- //
// /v1/models
// --------------------------------------------------------------------------- //

test("the model list carries probe facts, the instance envelope and no template echo", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS });
  h.coordinator.fields = {
    "Shared-1": {
      capabilities: { vision: true, function_calling: true, reasoning: true, structured_outputs: true },
      supported_parameters: ["temperature", "tools", "reasoning_effort"],
      reasoning: { supported_efforts: ["none", "low", "medium", "xhigh"], mandatory: false, default_effort: "xhigh" },
      architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] },
    },
  };
  // The instance snapshot is served by the coordinator now; the Worker no longer
  // fetches /api/config itself.
  //
  // 实例快照现在由协调者提供；Worker 不再自己拉 /api/config。
  h.coordinator.instanceMeta = {
    name: "Test OWUI",
    version: "0.9.2",
    features: { enable_signup: false, web_search: true },
    default_model_capabilities: { builtin_tools: true, usage: true },
    fetched_at: 1_700_000_000,
  };

  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  const data = payload.data as Array<Record<string, unknown>>;

  assert.equal(payload.object, "list");
  assert.equal(data.length, 2);

  const shared = data.find((model) => model.id === "Shared-1");
  assert.ok(shared);
  assert.deepEqual(shared.capabilities, {
    vision: true,
    function_calling: true,
    reasoning: true,
    structured_outputs: true,
  });
  assert.deepEqual(shared.reasoning, {
    supported_efforts: ["none", "low", "medium", "xhigh"],
    mandatory: false,
    default_effort: "xhigh",
  });
  assert.deepEqual(shared.supported_parameters, ["temperature", "tools", "reasoning_effort"]);
  assert.equal((shared.architecture as Record<string, unknown>).modality, "text+image->text");
  assert.equal(shared.name, "Shared One");
  assert.equal(shared.max_context_length, 262144);
  // The upstream template never leaks into `capabilities`. `vision` is NOT part of
  // the shared template here (the two models disagree), so each model publishes its
  // own value as a deviation instead.
  //
  // 上游模板绝不泄进 capabilities。这里两个模型对 vision 的取值不一致，因此 vision
  // 不进共享模板，而是各自作为差异键输出自己的取值。
  assert.deepEqual(shared.x_open_webui, { capabilities: { vision: true } });

  // The other model disagrees with the template about `vision` too.
  // 另一个模型同样在 vision 上与模板不一致。
  const deviant = data.find((model) => model.id === "Deviant-2");
  assert.ok(deviant);
  assert.deepEqual(deviant.x_open_webui, { capabilities: { vision: false } });
  assert.equal("capabilities" in deviant, false);

  const envelope = payload.x_open_webui as Record<string, unknown>;
  assert.equal(envelope.name, "Test OWUI");
  assert.equal(envelope.version, "0.9.2");
  assert.deepEqual(envelope.features, { enable_signup: false, web_search: true });
  // The template is the part every reporting model agrees on: `builtin_tools` and
  // `usage` agree, `vision` does not.
  //
  // 模板取"所有上报模型一致同意"的部分：builtin_tools 与 usage 一致，vision 不一致。
  assert.deepEqual(envelope.default_model_capabilities, { builtin_tools: true, usage: true });

  // The coordinator was asked about the models with their engine fingerprints.
  // 协调者收到的是带引擎指纹的模型引用。
  assert.equal(h.coordinator.calls, 1);
  assert.equal(h.coordinator.waitSeconds, DEFAULT_SETTINGS.wait);
  assert.deepEqual(
    h.coordinator.refs.map(([id]) => id),
    ["Shared-1", "Deviant-2"],
  );
  assert.equal(h.coordinator.refs[0][1], await modelFingerprint(RAW_MODELS[0], "Shared-1"));

  // The template is computed by the Worker (the coordinator holds no model cards) and
  // handed over on the same call, so the envelope costs no second round trip.
  //
  // 模板由 Worker 计算（协调者不持有模型卡）并随同一次调用交给它，因此信封不需要
  // 第二次往返。
  assert.deepEqual(h.coordinator.presents[0].options.defaultModelCapabilities, {
    builtin_tools: true,
    usage: true,
  });
  assert.equal(h.coordinator.presents[0].options.wantInstanceMeta, true);
  // And instance metadata is never fetched from the Worker side any more.
  // Worker 侧不再拉取实例元信息。
  assert.equal(
    h.upstream.calls.some((call) => call.includes("/api/config")),
    false,
  );
});

test("the envelope disappears when instance metadata is switched off", async () => {
  const h = await makeHarness({ settings: { ...DEFAULT_SETTINGS, exposeInstanceMeta: false } });
  h.coordinator.instanceMeta = {
    name: "Test OWUI",
    version: "0.9.2",
    features: {},
    fetched_at: 1_700_000_000,
  };
  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal("x_open_webui" in payload, false);
  // The coordinator is still asked for the fields, but explicitly NOT for the
  // envelope -- so it never even builds one.
  //
  // 协调者仍被问及探测字段，但**明确不要**信封——因此它根本不会构造信封。
  assert.equal(h.coordinator.presents[0].options.wantInstanceMeta, false);
});

test("a disabled probe asks for no fields but still serves the instance envelope", async () => {
  const h = await makeHarness({ settings: { ...DEFAULT_SETTINGS, enabled: false } });
  h.coordinator.fields = { "Shared-1": { reasoning: { supported_efforts: ["none"], mandatory: false } } };
  h.coordinator.instanceMeta = {
    name: "Test OWUI",
    version: "0.9.2",
    features: { web_search: true },
    fetched_at: 1_700_000_000,
  };

  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  const payload = (await response.json()) as Record<string, unknown>;
  const data = payload.data as Array<Record<string, unknown>>;

  // No fields are requested and none are served, even though the coordinator holds
  // some: disabling the probe must not leak probe facts back into the list.
  //
  // 不请求字段、也不输出字段——即使协调者手上有：禁用探测不得让探测事实泄回列表。
  assert.deepEqual(h.coordinator.presents[0].refs, []);
  assert.equal(h.coordinator.presents[0].waitSeconds, 0);
  for (const model of data) {
    assert.equal("capabilities" in model, false);
    assert.equal("reasoning" in model, false);
  }

  // The envelope is a separate switch and stays on: it no longer comes from KV, so the
  // instance snapshot must still reach the client.
  //
  // 信封是另一个开关，仍然开启：它已不来自 KV，因此实例快照仍必须到达客户端。
  const envelope = payload.x_open_webui as Record<string, unknown>;
  assert.equal(envelope.name, "Test OWUI");
});

// --------------------------------------------------------------------------- //
// /v1/models/{id}
// --------------------------------------------------------------------------- //

test("a single model is retrieved by id, including ids that contain slashes", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS });
  h.coordinator.fields = { "Shared-1": { reasoning: { supported_efforts: ["none"], mandatory: false } } };
  const raw = [...RAW_MODELS, { id: "org/nested/Model-3", openai: { owned_by: "vllm" } }];
  const baseFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/models")) return Response.json({ object: "list", data: raw });
    return baseFetch(input, init);
  }) as typeof fetch;

  const response = await handleV1Request(
    h.env,
    requestFor(`/v1/models/${encodeURIComponent("org/nested/Model-3")}`),
    ctx(h.waitUntil),
  );
  assert.equal(response.status, 200);
  const model = (await response.json()) as Record<string, unknown>;
  assert.equal(model.id, "org/nested/Model-3");
  assert.equal(model.object, "model");
  assert.equal("x_open_webui" in model, false);
  // A single-model read never waits, never triggers a round, and never asks for the
  // instance envelope (it returns a bare model object).
  //
  // 单模型读取不等待、不触发轮次、也不要实例信封（它返回裸的模型对象）。
  assert.equal(h.coordinator.waitSeconds, 0);
  assert.equal(h.coordinator.presents[0].options.wantInstanceMeta, false);
});

test("an unknown model answers the OpenAI 404 instead of the upstream HTML page", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS });
  const response = await handleV1Request(h.env, requestFor("/v1/models/nope"), ctx(h.waitUntil));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      message: "The model 'nope' does not exist",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  });
});

test("a malformed percent-escape in the model id answers 400, not 500", async () => {
  // The URIError used to bubble into handleV1Request's catch-all and surface as a
  // bare 500 an OpenAI client cannot interpret.
  //
  // URIError 此前会冒泡进 handleV1Request 的兜底 catch，变成 OpenAI 客户端无法解读的
  // 裸 500。
  const h = await makeHarness({ settings: DEFAULT_SETTINGS, baseUrl: "https://bad-escape.test" });
  const response = await handleV1Request(h.env, requestFor("/v1/models/%E0%A4%A"), ctx(h.waitUntil));
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; param: string } };
  assert.equal(body.error.code, "invalid_model_id");
  assert.equal(body.error.param, "model");
  // The upstream is never reached.
  // 从未到达上游。
  assert.equal(h.upstream.calls.length, 0);
});

// --------------------------------------------------------------------------- //
// 400 self-heal
// --------------------------------------------------------------------------- //

test("a reasoning-effort 400 disproves the level and still returns the upstream error", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS });
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "Shared-1",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      }),
    }),
    ctx(h.waitUntil),
  );

  // The client still gets the upstream error, re-wrapped exactly as before.
  // 客户端仍然拿到上游错误，只是像以前一样重新包装。
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "upstream_error");
  assert.match(body.error.message, /Harmony/);

  // The heal runs through ctx.waitUntil: the response was produced without waiting
  // for the coordinator, and the work was registered for after the response (the
  // key's last_used write shares that channel, hence "at least one").
  //
  // 自愈通过 ctx.waitUntil 执行：响应没有等待协调者，工作被登记到响应之后（Key 的
  // last_used 写入共用这条通道，因此断言"至少一个"）。
  assert.ok(h.waitUntil.length >= 1);
  await Promise.all(h.waitUntil);
  assert.deepEqual(h.coordinator.invalidated, [["Shared-1", "max"]]);
});

test("an unrelated 400 does not touch the probe cache", async () => {
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    chatBody: JSON.stringify({ detail: "Model is not available" }),
  });
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "Shared-1", messages: [{ role: "user", content: "hi" }] }),
    }),
    ctx(h.waitUntil),
  );
  assert.equal(response.status, 400);
  await Promise.all(h.waitUntil);
  assert.deepEqual(h.coordinator.invalidated, []);
});

test("an effort error past the truncation point still triggers the self-heal", async () => {
  // The client-facing error is truncated to 2000 chars, but the heal decision must
  // see the FULL body: a verbose upstream that mentions the effort late in a long
  // page of diagnostics used to escape the check.
  //
  // 给客户端的错误被截到 2000 字符，但自愈判定必须看到**完整**响应体：冗长的上游把
  // 挡位字样放在长篇诊断的尾部时，旧实现会漏掉它。
  const filler = "x".repeat(3000);
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    chatBody: JSON.stringify({ detail: filler + " reasoning_effort='max' is not supported" }),
  });
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "Shared-1",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      }),
    }),
    ctx(h.waitUntil),
  );
  assert.equal(response.status, 400);
  await Promise.all(h.waitUntil);
  assert.deepEqual(h.coordinator.invalidated, [["Shared-1", "max"]]);
});

// --------------------------------------------------------------------------- //
// Instance metadata trap
// --------------------------------------------------------------------------- //

test("the envelope is served from the coordinator, never from a direct /api/config fetch", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS });
  h.coordinator.instanceMeta = {
    name: "Known OWUI",
    version: "0.9.1",
    features: { web_search: true },
    fetched_at: 1,
  };

  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  const payload = (await response.json()) as Record<string, unknown>;
  const envelope = payload.x_open_webui as Record<string, unknown>;
  assert.equal(envelope.name, "Known OWUI");
  assert.equal(envelope.version, "0.9.1");

  // The Worker must not touch /api/config any more: the snapshot is the coordinator's
  // business, HTML trap included. That parsing lives in `parseInstanceConfig` and is
  // unit-tested in instanceMeta.test.ts.
  //
  // Worker 不再碰 /api/config：快照是协调者的事，HTML 陷阱也一样。该解析逻辑位于
  // `parseInstanceConfig`，在 instanceMeta.test.ts 里单测。
  assert.deepEqual(envelope.features, { web_search: true });
});

// --------------------------------------------------------------------------- //
// Prefix detection: only a confirmed answer counts (U1)
// --------------------------------------------------------------------------- //

/** The prefix probes of one run, in order, as pathnames. */
function probedPaths(h: Harness): string[] {
  return h.upstream.calls
    .filter((call) => call.includes("/models"))
    .map((call) => new URL(call.split(" ")[1]).pathname);
}

test("a 500 on the modern prefix is not trusted, so the legacy prefix wins", async () => {
  // "Anything but a 404" accepted this: the modern prefix answers a temporary 5xx, the
  // probe caches it as working, and every later request is sent to a route that may not
  // exist. Only a readable model list may confirm a prefix.
  //
  // "不是 404 就算对"会接受它：现代前缀回一个临时 5xx，探测把它缓存成可用，此后每个
  // 请求都发到一个可能不存在的路由。只有可读的模型列表才能确认前缀。
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://prefix-500.test",
    modelsStatus: { "/api/v1/models": 500 },
  });

  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal((payload.data as unknown[]).length, 2);

  const probes = probedPaths(h);
  assert.equal(probes[0], "/api/v1/models", "the modern prefix is probed first");
  // The confirmed prefix is then reused for the real request (no third probe).
  assert.deepEqual(probes.slice(1), ["/api/models", "/api/models"]);
});

test("the SPA's 200 + HTML page is not a model list, so the legacy prefix wins", async () => {
  // The exact trap the old 404-driven rule fell into: an unknown route under the modern
  // prefix is served by the SPA, so it answers 200 with an HTML page instead of 404.
  //
  // 旧的"基于 404"规则正好踩中的陷阱：现代前缀下的未知路由会落到 SPA 上，于是回
  // 200 + 一页 HTML，而不是 404。
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://prefix-html.test",
    modelsHtmlPaths: ["/api/v1/models"],
  });

  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal((payload.data as unknown[]).length, 2);
  assert.deepEqual(probedPaths(h), [
    "/api/v1/models", // probed, HTML, not confirmed
    "/api/models", // probed, a real list, confirmed
    "/api/models", // the real request, now on the confirmed prefix
  ]);
});

test("when no candidate can be confirmed the list still fails as a structured error", async () => {
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://prefix-unknown.test",
    modelsHtmlPaths: ["/api/v1/models", "/api/models"],
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  let response: Response;
  try {
    response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  } finally {
    console.warn = originalWarn;
  }

  // The fallback is NOT a success: the caller gets the real error from the actual
  // request, and the operator gets one warning naming the upstream.
  //
  // 兜底**不是**成功：调用方从真正的那次请求拿到真实错误，运维拿到一条点名上游的警告。
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "upstream_error");
  assert.ok(
    warnings.some((line) => line.includes("upstream prefix not confirmed")),
    `expected a warn log, got: ${warnings.join(" | ")}`,
  );
});

test("a transport failure is not remembered, so the next request probes again", async () => {
  // Remembering the fallback after a transient outage would freeze a legacy deployment
  // onto the wrong prefix for the isolate's whole lifetime: the probe never runs again,
  // so `/api` would never be discovered once the upstream came back.
  //
  // 瞬时故障后记住兜底值，会让旧版部署在整个 isolate 生命周期内都锁在错误的前缀上：
  // 探测再也不会运行，上游恢复后 `/api` 永远不会被发现。
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://prefix-retry.test",
    modelsTimeout: true,
  });
  for (let call = 1; call <= 2; call += 1) {
    const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
    assert.equal(response.status, 502, `call ${call}`);
  }
  const modernCalls = h.upstream.calls.filter((call) => call.endsWith("/api/v1/models"));
  // One probe plus the real request per call: the prefix was probed again on call 2.
  // 每次调用一次探测加一次真实请求：第 2 次调用又探了一遍前缀。
  assert.equal(modernCalls.length, 4);
});

test("an unconfirmable-but-answering upstream is NOT remembered either (every call re-probes)", async () => {
  // A transient 5xx (or a SPA answering 200 + HTML) can leave even the correct
  // candidate unconfirmed for a few seconds; remembering the fallback then would pin
  // the isolate to the wrong prefix until eviction -- a legacy deployment whose `/api`
  // hiccuped once would never discover its real answer again. Only a CONFIRMED prefix
  // is remembered, so the probe re-runs until some candidate confirms.
  //
  // 一次瞬时 5xx（或 SPA 的 200 + HTML）会让哪怕正确的候选在几秒内无法确认；此时记住
  // 兜底值会把 isolate 锁死在错误前缀上直到被驱逐——旧版部署的 `/api` 打一个嗝，就永远
  // 再也发现不了真正的答案。**只有被确认的前缀才会被记住**，因此探测会反复运行，直到
  // 某个候选被确认。
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://prefix-sticky.test",
    modelsHtmlPaths: ["/api/v1/models", "/api/models"],
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    assert.equal((await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil))).status, 502);
    const afterFirst = h.upstream.calls.length;
    assert.equal((await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil))).status, 502);
    // The second call probed BOTH candidates again (2 probes + 1 real request), instead
    // of walking straight into a remembered fallback.
    //
    // 第二次调用把两个候选又各探了一遍（2 次探测 + 1 次真实请求），而不是直接走进被
    // 记住的兜底前缀。
    assert.equal(h.upstream.calls.length, afterFirst + 3);
  } finally {
    console.warn = originalWarn;
  }
  // One warning per call: the misbehaving upstream is named every time nothing confirms.
  // 每次调用一条警告：上游每次都无法确认时都被点名。
  assert.equal(warnings.filter((line) => line.includes("upstream prefix not confirmed")).length, 2);
});

test("a /v1-prefixed path without a slash answers 404 without touching the upstream", async () => {
  // `startsWith("/v1")` used to let `/v1models` into the proxy, where the passthrough
  // built `.../api/v1models` -- a route that does not exist, often answered by the
  // SPA's "200 + HTML" page. The entry route matches exactly now, and the proxy
  // duplicates that check for callers that skip index.ts.
  //
  // `startsWith("/v1")` 此前会放行 `/v1models`，透传随后拼出 `.../api/v1models`
  // ——一个不存在的路由，常被 SPA 以 "200 + 一页 HTML" 应答。入口路由现在做精确
  // 匹配，代理层也为绕过 index.ts 的调用方复制了这一检查。
  const h = await makeHarness({ settings: DEFAULT_SETTINGS, baseUrl: "https://slashless.test" });
  const response = await handleV1Request(h.env, requestFor("/v1models"), ctx(h.waitUntil));
  assert.equal(response.status, 404);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "not_found");
  // Not one upstream request left the Worker.
  // 没有任何上游请求离开 Worker。
  assert.equal(h.upstream.calls.length, 0);
});

// --------------------------------------------------------------------------- //
// `model` validation (U2)
// --------------------------------------------------------------------------- //

test("a non-string or blank model is rejected before anything is forwarded", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS, baseUrl: "https://model-type.test" });
  for (const bad of [0, true, [], {}, "", "   ", null]) {
    const response = await handleV1Request(
      h.env,
      requestFor("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: bad, messages: [{ role: "user", content: "hi" }] }),
      }),
      ctx(h.waitUntil),
    );
    assert.equal(response.status, 400, `model=${JSON.stringify(bad)}`);
    const body = (await response.json()) as { error: { code: string; param: string } };
    assert.equal(body.error.code, "invalid_type", `model=${JSON.stringify(bad)}`);
    assert.equal(body.error.param, "model");
  }
  // Embeddings applies the same rule (and reports a missing `input` separately).
  const embeddings = await handleV1Request(
    h.env,
    requestFor("/v1/embeddings", { method: "POST", body: JSON.stringify({ model: 7, input: "x" }) }),
    ctx(h.waitUntil),
  );
  assert.equal(embeddings.status, 400);
  assert.equal(((await embeddings.json()) as { error: { code: string } }).error.code, "invalid_type");
  const noInput = await handleV1Request(
    h.env,
    requestFor("/v1/embeddings", { method: "POST", body: JSON.stringify({ model: "m" }) }),
    ctx(h.waitUntil),
  );
  assert.equal(noInput.status, 400);
  assert.equal(
    ((await noInput.json()) as { error: { param: string } }).error.param,
    "input",
  );

  // Not one chat/completions or embeddings request left the Worker.
  // 没有任何 chat/completions 或 embeddings 请求离开 Worker。
  assert.equal(
    h.upstream.calls.some((call) => call.includes("/chat/completions") || call.includes("/embeddings")),
    false,
  );
});

test("a valid model string is still forwarded", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS, baseUrl: "https://model-valid.test" });
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "Shared-1", messages: [{ role: "user", content: "hi" }] }),
    }),
    ctx(h.waitUntil),
  );
  // The fake upstream rejects the completion itself; what matters is that it was
  // reached (and not with an `invalid_type` wrapper).
  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "upstream_error",
  );
  assert.ok(h.upstream.calls.some((call) => call.includes("/chat/completions")));
});

// --------------------------------------------------------------------------- //
// Upstream plumbing: KV failures, timeouts, forwarded headers (R2/R5/D2)
// --------------------------------------------------------------------------- //

test("a KV failure on the auth path still answers an OpenAI error body", async () => {
  // The read used to throw straight through `handleV1Request` into the Worker entry
  // point, which answers a bare 500 body an OpenAI client cannot parse.
  //
  // 这次读取此前会穿过 `handleV1Request` 直接抛到 Worker 入口，返回 OpenAI 客户端无法
  // 解析的裸 500 响应体。
  const h = await makeHarness({ settings: DEFAULT_SETTINGS, baseUrl: "https://kv-fail.test" });
  h.kv.failOn.add("apikey:");
  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: { code: string; type: string } };
  assert.equal(body.error.code, "internal");
  assert.equal(body.error.type, "server_error");
});

test("upstream fetches carry a timeout signal, and a timeout maps to 502", async () => {
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://timeout.test",
    modelsTimeout: true,
  });
  const response = await handleV1Request(h.env, requestFor("/v1/models"), ctx(h.waitUntil));
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "upstream_unavailable");
  // Every attempt carried a signal, which is what bounds a hung upstream. The first
  // probe throwing already ends prefix detection (the other candidate shares the same
  // host, so it would fail identically), hence two attempts rather than three.
  //
  // 每一次尝试都带上了 signal，这正是"挂死的上游"被限住的原因。首次探测就抛错即结束
  // 前缀判定（另一个候选共用同一主机，必然同样失败），因此是两次而不是三次。
  assert.ok(h.upstream.signals.length >= 2);
  assert.ok(h.upstream.signals.every(Boolean));
});

test("the forwarded request keeps client headers but never accept-encoding or the client key", async () => {
  const h = await makeHarness({ settings: DEFAULT_SETTINGS, baseUrl: "https://headers.test" });
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/chat/completions", {
      method: "POST",
      headers: { "accept-encoding": "gzip, br", "x-trace": "abc" },
      body: JSON.stringify({
        model: "Shared-1",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    }),
    ctx(h.waitUntil),
  );
  assert.equal(response.status, 400);

  const chatCall = h.upstream.calls.findIndex((call) => call.includes("/chat/completions"));
  assert.ok(chatCall >= 0);
  const sent = h.upstream.headers[chatCall];
  // No compression is ever requested, so an upstream body can always be read as text.
  // 从不索取压缩，因此上游响应体总能当文本读取。
  assert.equal("accept-encoding" in sent, false);
  assert.equal(sent["x-trace"], "abc");
  // The session credential replaces whatever the client sent.
  // 会话凭证覆盖客户端自带的鉴权。
  assert.equal(sent.authorization, "Bearer upstream-token");
  assert.ok(h.upstream.signals[chatCall]);
});

// --------------------------------------------------------------------------- //
// passthrough: generic headers and an untouched body (A2/N1)
// 透传：通用请求头与原样 body（A2/N1）
// --------------------------------------------------------------------------- //

test("the passthrough keeps the client's Content-Type and streams the body untouched", async () => {
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://passthrough-headers.test",
  });
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/files/upload", {
      method: "POST",
      body: "BINARY-PAYLOAD-0x00FF",
      headers: {
        "content-type": "multipart/form-data; boundary=xyz",
        accept: "application/octet-stream",
      },
    }),
    ctx(h.waitUntil),
  );
  // The passthrough relays whatever the upstream answered (the stub's 404).
  // 透传原样回传上游的答复（stub 的 404）。
  assert.equal(response.status, 404);

  // Last upstream call = the forwarded upload (the first was the prefix probe).
  // 最后一次上游调用 = 转发的上传（第一次是前缀探测）。
  const sent = h.upstream.headers.at(-1) as Record<string, string>;
  // Session credentials still ride along, but the client's own content
  // negotiation is preserved instead of being pinned to application/json —
  // the old JSON pin broke every multipart upload and non-JSON download.
  //
  // 会话凭证仍随行，但客户端自己的内容协商被保留，而不是被钉成 application/json
  // ——旧的 JSON 钉死破坏了一切 multipart 上传与非 JSON 下载。
  assert.equal(sent.authorization, "Bearer upstream-token");
  assert.equal(sent["content-type"], "multipart/form-data; boundary=xyz");
  assert.equal(sent.accept, "application/octet-stream");

  // The body arrives intact: streamed through, never round-tripped through
  // `request.text()`, which mangled binary payloads.
  //
  // body 完整到达：流式直通，绝不经过会破坏二进制负载的 `request.text()` 往返。
  assert.equal(h.upstream.bodies.at(-1), "BINARY-PAYLOAD-0x00FF");
});

test("JSON endpoints still pin the JSON content negotiation", async () => {
  const h = await makeHarness({
    settings: DEFAULT_SETTINGS,
    baseUrl: "https://json-headers.test",
  });
  await handleV1Request(
    h.env,
    requestFor("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "Shared-1", messages: [{ role: "user", content: "hi" }] }),
    }),
    ctx(h.waitUntil),
  );
  const sent = h.upstream.headers.at(-1) as Record<string, string>;
  assert.equal(sent["content-type"], "application/json");
  assert.equal(sent.accept, "application/json");
});
