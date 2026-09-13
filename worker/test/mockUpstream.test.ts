/**
 * End-to-end rehearsal of the probe against a mock upstream over real HTTP.
 *
 * This is the part of the acceptance run that does not need a deployment: the real
 * `modelProbe`/`probeRound` code talks to a real socket, and the mock reproduces the
 * behaviours of the actual engine (two validation layers, a deployment-wide
 * capability template, the SPA answering 200 + HTML on the modern prefix).
 *
 * The five hard assertions the upstream project checks against its real deployment
 * are rehearsed here as well -- only the numbers come from the mock instead of a real
 * vLLM, so the plumbing is verified even before the first deploy.
 *
 * 对 mock 上游、走真实 HTTP 的探测端到端彩排。
 *
 * 这是验收里不需要部署的那一半：真实的 `modelProbe`/`probeRound` 代码对着真实 socket
 * 说话，而 mock 复刻了真实引擎的行为（两层校验、部署级能力模板、现代前缀上由 SPA 回
 * 200 + HTML）。
 *
 * 上游项目对真实部署核对的那 5 条硬断言也在这里彩排一遍——只是数字来自 mock 而不是
 * 真实 vLLM，因此**在首次部署之前**管线就已经被验证过了。
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";

import { startMockUpstream } from "../mock/upstream.mjs";
import { ModelProbeCache, buildReasoningInfo } from "../src/modelProbe.ts";
import { MemoryProbeStore } from "../src/probeStore.ts";
import { ProbeAuthExpired, ProbeBudgetExhausted, runProbeRound } from "../src/probeRound.ts";
import type { ProbeAnswer, ProbeTransport } from "../src/probeRound.ts";
import { extractModelList, modelFingerprint, modelIdOf, sharedDefaultCapabilities } from "../src/modelCatalog.ts";
import { fetchUpstream } from "../src/session.ts";
import { PREFIX_CANDIDATES, confirmUpstreamPrefix } from "../src/upstream.ts";
import type { ModelProbe } from "../src/types.ts";

/**
 * The pristine fetch, restored before every test in this file.
 *
 * This is the only suite that talks real HTTP (to the mock upstream); other files
 * stub `globalThis.fetch` and their stubs survive until the next file runs. Module
 * top-level code executes before any test, so the value captured here is the real
 * one; putting it back per test keeps this file independent of execution order.
 *
 * 原始的 fetch，本文件每个测试开始前恢复。
 *
 * 本文件是唯一走真实 HTTP 的套件（对着 mock 上游）；其他文件会替换
 * `globalThis.fetch` 且其 stub 会残留到下一个文件。模块顶层代码在任何测试之前执行，
 * 因此这里捕获的是真正的 fetch；逐测试恢复使本文件与执行顺序无关。
 */
const REAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** A transport that speaks real HTTP to the mock, with the round budget enforced. */
function httpTransport(baseUrl: string, budget: number, prefix = "/api/v1"): ProbeTransport {
  let used = 0;
  return {
    ask: async (_modelId: string, payload: Record<string, unknown>): Promise<ProbeAnswer> => {
      if (used >= budget) throw new ProbeBudgetExhausted();
      used += 1;
      const response = await fetch(`${baseUrl}${prefix}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer mock", "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new ProbeAuthExpired(String(response.status));
      }
      return { status: response.status, body };
    },
    now: () => Date.now() / 1000,
    budgetLeft: () => budget - used,
    budgetUsed: () => used,
  };
}

/** Read the model list the way the proxy does: raw cards in, refs out. */
async function refsFrom(
  baseUrl: string,
  prefix = "/api/v1",
): Promise<{ refs: Array<[string, string]>; raw: unknown[] }> {
  const response = await fetch(`${baseUrl}${prefix}/models`, { headers: { authorization: "Bearer mock" } });
  const payload = (await response.json()) as unknown;
  const raw = extractModelList(payload);
  const refs: Array<[string, string]> = [];
  for (const card of raw) {
    const id = modelIdOf(card);
    if (!id) continue;
    refs.push([id, await modelFingerprint(card, id)]);
  }
  return { refs, raw };
}

/** A raw HTTP GET, so the response bytes can be inspected before any decompression. */
function rawGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers as Record<string, unknown>,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on("error", reject);
  });
}

test("a full round over real HTTP reproduces every hard assertion made upstream", async () => {
  const mock = await startMockUpstream();
  try {
    const { refs, raw } = await refsFrom(mock.url);
    assert.equal(refs.length, 6);

    const cache = new ModelProbeCache();
    const store = new MemoryProbeStore();
    cache.load(store.loadAll());
    mock.resetLog();

    const stats = await runProbeRound({
      cache,
      store,
      models: refs,
      transport: httpTransport(mock.url, 200),
      now: Date.now() / 1000,
    });

    const probeOf = (id: string): ModelProbe => {
      const probe = store.snapshot().get(id);
      assert.ok(probe, `no probe stored for ${id}`);
      return probe;
    };

    // ---- Qwen3.8-27B: advertises seven levels, really accepts four -------------
    const qwen = probeOf("Qwen3.8-27B");
    assert.equal(qwen.status, "ok");
    // Largest effort first, the OpenRouter ordering.
    // 最大挡位在前，OpenRouter 的排列。
    assert.deepEqual(qwen.supported_efforts, ["xhigh", "medium", "low", "none"]);
    assert.equal(qwen.default_effort, "xhigh");
    assert.equal(qwen.efforts_verified, true);
    assert.deepEqual(qwen.capabilities, {
      vision: true,
      function_calling: true,
      structured_outputs: true,
      reasoning: true,
    });
    assert.equal(qwen.system_fingerprint, "vllm-0.28.1rc1-mock");

    // ---- gpt-oss-120b: Harmony, and thinking cannot be turned off --------------
    const gptOss = probeOf("gpt-oss-120b");
    assert.deepEqual(gptOss.supported_efforts, ["high", "medium", "low"]);
    assert.equal(gptOss.default_effort, null);
    assert.equal(buildReasoningInfo(gptOss.supported_efforts)?.mandatory, true);
    assert.equal(gptOss.capabilities.vision, false);

    // ---- DeepSeek-V4-Flash-0731: the template claims vision, the engine says no -
    const deepseek = probeOf("DeepSeek-V4-Flash-0731");
    assert.equal(deepseek.capabilities.vision, false);

    // ---- gemma-4-31B-it / GLM-OCR: no tool-call parser -------------------------
    for (const id of ["gemma-4-31B-it", "GLM-OCR"]) {
      const probe = probeOf(id);
      assert.equal(probe.capabilities.function_calling, false, `${id} should reject tools`);
      assert.equal(probe.supported_parameters.includes("tools"), false, `${id} still claims tools`);
      assert.equal(probe.supported_parameters.includes("tool_choice"), false);
    }

    // ---- an upstream that ignores the field is unprobeable, but still has facts -
    const legacy = probeOf("legacy-no-effort");
    assert.equal(legacy.status, "unprobeable");
    assert.deepEqual(legacy.supported_efforts, []);
    assert.equal(legacy.capabilities.vision, true);
    assert.equal(cache.present("legacy-no-effort")?.reasoning, undefined);

    // ---- no OWUI switch ever leaks into capabilities ---------------------------
    for (const [, probe] of store.snapshot()) {
      for (const key of ["web_search", "terminal", "builtin_tools", "usage"]) {
        assert.equal(key in probe.capabilities, false, `${key} leaked into capabilities`);
      }
    }

    // ---- request accounting ----------------------------------------------------
    const chatRequests = mock.log.filter((entry) => entry.includes("/chat/completions")).length;
    assert.equal(stats.budgetUsed, chatRequests);
    assert.equal(stats.ok, 5);
    assert.equal(stats.unprobeable, 1);
    // Qwen: sentinel + 7 verifications + params + vision + baseline.
    // gpt-oss: sentinel + 5 + params + vision + baseline.
    // legacy: sentinel + params + vision + baseline (no verification at all).
    assert.equal(mock.log.filter((entry) => entry !== "").length, chatRequests);
    assert.equal(stats.total, 6);

    // ---- the deployment-wide template is an instance fact, not a model fact -----
    const template = sharedDefaultCapabilities(raw);
    assert.ok(template);
    assert.equal(template.builtin_tools, true);
    // `vision` disagrees between models and `usage` is not reported by everyone, so
    // neither may enter the template.
    //
    // vision 在各模型间取值不一致、usage 也不是人人上报，两者都不得进入模板。
    assert.equal("vision" in template, false);
    assert.equal("usage" in template, false);
  } finally {
    await mock.close();
  }
});

test("a warm cache costs zero upstream requests", async () => {
  const mock = await startMockUpstream();
  try {
    const { refs } = await refsFrom(mock.url);
    const store = new MemoryProbeStore();
    const cache = new ModelProbeCache();
    cache.load(store.loadAll());

    await runProbeRound({
      cache,
      store,
      models: refs,
      transport: httpTransport(mock.url, 200),
      now: Date.now() / 1000,
    });
    const afterFirst = mock.log.filter((entry) => entry.includes("/chat/completions")).length;
    assert.ok(afterFirst > 0);

    // Same fingerprints: conclusive entries are not re-probed, so the second round
    // must not touch the upstream at all.
    //
    // 指纹不变：结论性条目不再重探，因此第二轮根本不该碰上游。
    mock.resetLog();
    const second = await runProbeRound({
      cache,
      store,
      models: refs,
      transport: httpTransport(mock.url, 200),
      now: Date.now() / 1000,
    });
    assert.equal(second.total, 0);
    assert.equal(second.budgetUsed, 0);
    assert.equal(mock.log.length, 0);
  } finally {
    await mock.close();
  }
});

test("a fresh model-list fetch still hits the warm cache (the engine clock drifts)", async () => {
  const mock = await startMockUpstream();
  try {
    const createdOf = (raw: unknown[]): unknown => (raw[0] as { created?: unknown } | undefined)?.created;

    const first = await refsFrom(mock.url);
    const store = new MemoryProbeStore();
    const cache = new ModelProbeCache();
    cache.load(store.loadAll());
    await runProbeRound({
      cache,
      store,
      models: first.refs,
      transport: httpTransport(mock.url, 200),
      now: Date.now() / 1000,
    });

    mock.resetLog();
    // A SECOND fetch, exactly what the next /v1/models request does. The engine's
    // clock (top-level `created`) has moved in the meantime and the fingerprint must
    // not care -- otherwise every fetch looks like an engine swap and the cache never
    // hits. The old mock bumped `info.updated_at` instead, which is precisely the
    // field the fingerprint DOES read, so it hid this path completely.
    //
    // **第二次**拉取，与下一次 /v1/models 请求完全一致。这期间引擎时钟（顶层
    // `created`）已经前进，而指纹必须不在意它——否则每次拉取都像换了引擎、缓存永不
    // 命中。旧 mock 递增的却是指纹**确实**会读的 `info.updated_at`，因此把这条路径
    // 完全掩盖了。
    const fresh = await refsFrom(mock.url);
    assert.deepEqual(
      fresh.refs,
      first.refs,
      "fingerprints must survive a fresh model-list fetch",
    );
    assert.equal(typeof createdOf(first.raw), "number");
    assert.notEqual(createdOf(fresh.raw), createdOf(first.raw), "the mock must move the engine clock");

    const second = await runProbeRound({
      cache,
      store,
      models: fresh.refs,
      transport: httpTransport(mock.url, 200),
      now: Date.now() / 1000,
    });
    assert.equal(second.total, 0);
    assert.equal(second.budgetUsed, 0);
    assert.equal(
      mock.log.filter((entry) => entry.includes("/chat/completions")).length,
      0,
      "a warm cache must not spend a single probe request",
    );
  } finally {
    await mock.close();
  }
});

test("the mock really does answer the modern prefix with 200 + HTML", async () => {
  const mock = await startMockUpstream();
  try {
    // The trap this project has to work around: an unknown route under `/api/v1` is
    // served by the SPA, so a 404-driven prefix fallback never finds `/api/config`.
    //
    // 本项目必须绕开的陷阱：`/api/v1` 下的未知路由会落到 SPA 上，因此基于 404 的前缀
    // 回退永远找不到 `/api/config`。
    const trap = await fetch(`${mock.url}/api/v1/config`);
    assert.equal(trap.status, 200);
    assert.match(String(trap.headers.get("content-type")), /text\/html/);

    const real = await fetch(`${mock.url}/api/config`);
    assert.equal(real.status, 200);
    const config = (await real.json()) as Record<string, unknown>;
    assert.equal(config.name, "Mock Open WebUI");
    assert.equal(typeof config.features, "object");

    // And the API lives under the modern prefix only.
    // 而 API 只在现代前缀下。
    assert.equal((await fetch(`${mock.url}/api/models`)).status, 404);
    assert.equal((await fetch(`${mock.url}/api/v1/models`)).status, 401);
  } finally {
    await mock.close();
  }
});

test("a broken modern prefix (500) does not get confirmed; the legacy prefix does", async () => {
  const mock = await startMockUpstream({ legacyOnly: true });
  try {
    // The deployment shape the old "anything but a 404" rule got wrong: the modern
    // prefix answers a 5xx, so the REAL API under `/api` was never found.
    //
    // 旧的"不是 404 就算对"弄错的部署形态：现代前缀回 5xx，于是 `/api` 下真正的 API
    // 永远找不到。
    assert.equal((await fetch(`${mock.url}/api/v1/models`)).status, 500);

    const confirmed = await confirmUpstreamPrefix(PREFIX_CANDIDATES, async (prefix) => {
      const response = await fetchUpstream(
        `${mock.url}${prefix}/models`,
        { headers: { authorization: "Bearer mock" } },
        { metadata: true },
      );
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        text: await response.text().catch(() => ""),
      };
    });
    assert.ok(confirmed, "the legacy prefix must be confirmed");
    assert.equal(confirmed.prefix, "/api");
    assert.equal(confirmed.authFailure, false);

    // And a full round runs happily through that legacy prefix.
    // 完整一轮也能愉快地在旧前缀上跑完。
    const { refs } = await refsFrom(mock.url, "/api");
    assert.equal(refs.length, 6);
    const cache = new ModelProbeCache();
    const store = new MemoryProbeStore();
    cache.load(store.loadAll());
    const stats = await runProbeRound({
      cache,
      store,
      models: refs,
      transport: httpTransport(mock.url, 200, "/api"),
      now: Date.now() / 1000,
    });
    assert.equal(stats.ok, 5);
    assert.equal(stats.unprobeable, 1);
    const qwen = store.snapshot().get("Qwen3.8-27B");
    assert.ok(qwen);
    assert.deepEqual(qwen.supported_efforts, ["xhigh", "medium", "low", "none"]);
  } finally {
    await mock.close();
  }
});

test("the mock compresses the model list only when the client asks for it", async () => {
  const mock = await startMockUpstream();
  try {
    // The Worker strips `accept-encoding`, so this only ever happens for a direct
    // client -- and it is exactly why the proxy strips it: an upstream-compressed body
    // can no longer be inspected as text.
    //
    // Worker 会剥掉 `accept-encoding`，因此这只会发生在直连客户端身上——这也正是代理要
    // 剥掉它的原因：上游压缩过的响应体不再能当文本检查。
    const compressed = await rawGet(`${mock.url}/api/v1/models`, {
      authorization: "Bearer mock",
      "accept-encoding": "gzip",
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(compressed.body[0], 0x1f);
    assert.equal(compressed.body[1], 0x8b);

    const plain = await rawGet(`${mock.url}/api/v1/models`, { authorization: "Bearer mock" });
    assert.equal(plain.headers["content-encoding"], undefined);
    const payload = JSON.parse(plain.body.toString("utf8")) as Record<string, unknown>;
    assert.equal(payload.object, "list");
    assert.equal((payload.data as unknown[]).length, 6);
  } finally {
    await mock.close();
  }
});
