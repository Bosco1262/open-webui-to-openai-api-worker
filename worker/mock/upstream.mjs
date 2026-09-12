/**
 * Mock Open WebUI upstream: enough of the real thing to rehearse the probe end to
 * end without touching a real deployment.
 *
 * It reproduces the three behaviours the probe has to survive:
 *
 *   1. TWO validation layers -- the outer pydantic literal enumerates a superset,
 *      while the model's own parser (Harmony / Qwen) rejects a subset of it with a
 *      different wording. Every fixture below mirrors a model from a real
 *      deployment, including the levels it really rejects.
 *   2. The route layout: the API lives under `/api/v1`, the instance config lives
 *      under the LEGACY `/api` prefix only, and `/api/v1/config` answers 200 with an
 *      HTML page (the trap that makes a 404-driven prefix fallback useless).
 *   3. `info.meta.capabilities` is a deployment-wide template that one model
 *      deviates from -- it says nothing about any single model.
 *
 * Two opt-in modes exist for rehearsing "the status code alone proves nothing":
 * `legacyOnly` serves the API under `/api` and answers `/api/v1/models` with **500**,
 * and any client that asks for gzip gets a gzipped model list (the Worker never asks,
 * which is exactly what keeps upstream bodies inspectable as text).
 *
 * Run it standalone (`node mock/upstream.mjs [port] [--legacy]`) while `wrangler dev`
 * serves the worker, or import `startMockUpstream()` from a test.
 *
 * 模拟 Open WebUI 上游：足以在没有真实部署的情况下把探测整套彩排一遍。
 *
 * 它复刻了探测必须扛住的三种行为：
 *
 *   1. **两层校验**——外层 pydantic 枚举的是超集，而模型自带解析器（Harmony / Qwen）
 *      会以另一种措辞拒绝其中一部分。下面每个 fixture 都对应真实部署里的一个模型，
 *      包括它真正拒绝的挡位。
 *   2. 路由布局：API 在 `/api/v1` 下，实例配置**只在旧前缀 `/api`** 下，而
 *      `/api/v1/config` 会回 200 + 一页 HTML（正是让"基于 404 的前缀回退"失效的陷阱）。
 *   3. `info.meta.capabilities` 是部署级模板、且有一个模型与它不一致——它对任何单个
 *      模型都不构成事实。
 *
 * 另有两个可选模式用于彩排"只看状态码什么都证明不了"：`legacyOnly` 把 API 放到 `/api`
 * 下、并让 `/api/v1/models` 回 **500**；而任何索取 gzip 的客户端都会收到 gzip 压缩的
 * 模型列表（Worker 从不索取——这正是上游响应体始终可当文本检查的原因）。
 *
 * 可独立运行（`node mock/upstream.mjs [port] [--legacy]`，配合 `wrangler dev`），也可在
 * 测试里 `import { startMockUpstream }`。
 */

import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

/** The prefix the API lives under in the normal mode. */
const MODERN_PREFIX = "/api/v1";
/** The legacy prefix: the instance config always lives here, and `legacyOnly` moves the
 *  whole API here too. */
const LEGACY_PREFIX = "/api";

const ENGINE_BUILD = "vllm-0.28.1rc1-mock";

/** Every deployment-wide capability template entry, except where a model deviates. */
const TEMPLATE = { vision: true, builtin_tools: true, usage: true };

/**
 * The rehearsal cast, mirroring the real deployment used by the upstream project:
 *
 *   Qwen3.8-27B            advertises 7 levels, accepts 4, names its own default
 *   gpt-oss-120b           Harmony; thinking cannot be turned off (no "none")
 *   DeepSeek-V4-Flash-0731 text only, despite the template claiming vision
 *   gemma-4-31B-it         no tool-call parser: tools are rejected
 *   GLM-OCR                no tool-call parser either
 *   legacy-no-effort       ignores reasoning_effort entirely (unprobeable)
 */
export const FIXTURES = {
  "Qwen3.8-27B": {
    literal: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    accepted: ["none", "low", "medium", "xhigh"],
    style: "qwen",
    default: "xhigh",
    tools: true,
    vision: true,
    reasoningByDefault: true,
  },
  "gpt-oss-120b": {
    literal: ["low", "medium", "high", "xhigh", "max"],
    accepted: ["low", "medium", "high"],
    style: "harmony",
    tools: true,
    vision: false,
    reasoningByDefault: true,
  },
  "DeepSeek-V4-Flash-0731": {
    literal: ["none", "low", "medium", "high"],
    accepted: ["none", "low", "medium"],
    style: "harmony",
    tools: true,
    vision: false,
    reasoningByDefault: false,
  },
  "gemma-4-31B-it": {
    literal: ["none", "low", "medium"],
    accepted: ["none", "low"],
    style: "harmony",
    tools: false,
    vision: true,
    reasoningByDefault: false,
  },
  "GLM-OCR": {
    literal: ["none", "low"],
    accepted: ["none"],
    style: "harmony",
    tools: false,
    vision: true,
    reasoningByDefault: false,
  },
  "legacy-no-effort": {
    literal: [],
    accepted: [],
    ignoresEffortField: true,
    tools: true,
    vision: true,
    reasoningByDefault: true,
  },
};

const PROBED_PARAMETERS = [
  "tools",
  "tool_choice",
  "response_format",
  "logprobs",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "parallel_tool_calls",
];

function literalError(efforts) {
  const quoted =
    efforts
      .slice(0, -1)
      .map((effort) => `'${effort}'`)
      .join(", ") + ` or '${efforts[efforts.length - 1]}'`;
  return {
    detail:
      "1 validation error:\n" +
      "  {'type': 'literal_error', 'loc': ('body', 'reasoning_effort'), " +
      `'msg': "Input should be ${quoted}", 'input': '__probe__', ` +
      `'ctx': {'expected': "${quoted}"}}`,
  };
}

function secondLayerError(fixture, value) {
  if (fixture.style === "qwen") {
    const rest = fixture.accepted.filter((level) => level !== fixture.default);
    const tail =
      rest.length > 1 ? `${rest.slice(0, -1).join(", ")}, and ${rest[rest.length - 1]}` : rest.join("");
    const named = fixture.default ? `${fixture.default} (default), ${tail}` : tail;
    return { detail: `Unexpected reasoning effort ${value}. Supported types are ${named}.` };
  }
  return {
    detail:
      `reasoning_effort='${value}' is not supported by Harmony. ` +
      `Supported values are: ${fixture.accepted.join(", ")}.`,
  };
}

function completion(fixture) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    system_fingerprint: ENGINE_BUILD,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: fixture.reasoningByDefault
          ? { role: "assistant", content: null, reasoning: "We need to answer briefly." }
          : { role: "assistant", content: "Pong", reasoning: null },
      },
    ],
  };
}

/**
 * One model card, as Open WebUI hands it to the proxy.
 *
 * `created` is the ENGINE's clock, which real vLLM rebuilds on every response -- it
 * must never enter the fingerprint. `info.updated_at` is Open WebUI's own record of
 * when the model changed; it stays put. Keeping those two straight is exactly what
 * lets a warm cache hit, and getting them backwards would make EVERY fetch look like
 * an engine swap.
 *
 * 一张模型卡，即 Open WebUI 交给代理的样子。
 *
 * `created` 是**引擎**的时钟，真实 vLLM 每次响应都会重建它——它绝不能进入指纹。
 * `info.updated_at` 是 Open WebUI 自己记录的模型更新时间，保持不动。把这两者区分
 * 清楚，正是"热缓存能命中"的关键；弄反了会让每一次拉取都看起来像换了引擎。
 */
function modelCard(id, created) {
  const fixture = FIXTURES[id];
  const capabilities = { ...TEMPLATE, vision: fixture.vision };
  // One model in the deployment does not report `usage` at all, which keeps it out
  // of the shared template -- exactly the real-world wrinkle the template exists for.
  //
  // 部署里有一个模型压根不上报 `usage`，于是它进不了共享模板——这正是模板存在的意义。
  if (id !== "legacy-no-effort") capabilities.usage = true;
  else delete capabilities.usage;
  return {
    id,
    created,
    max_model_len: 262144,
    owned_by: "open-webui",
    openai: { root: `/models/${id}`, owned_by: "vllm", max_model_len: 262144 },
    info: {
      base_model_id: `org/${id}`,
      updated_at: 1789036467,
      name: `${id} (friendly)`,
      meta: { description: `Mock ${id}`, capabilities },
    },
  };
}

/** Answer one chat-completions request the way a real engine would. */
function answerChat(modelId, payload) {
  const fixture = FIXTURES[modelId];
  if (!fixture) return { status: 404, body: { detail: `The model '${modelId}' does not exist` } };

  const effort = payload.reasoning_effort;
  if (effort === "__probe__") {
    if (fixture.ignoresEffortField) return { status: 200, body: completion(fixture) };
    return { status: 400, body: literalError(fixture.literal) };
  }
  if (typeof effort === "string") {
    if (fixture.accepted.includes(effort)) return { status: 200, body: completion(fixture) };
    return { status: 400, body: secondLayerError(fixture, effort) };
  }

  if (PROBED_PARAMETERS.some((parameter) => parameter in payload)) {
    // An engine built without a tool-call parser rejects whichever of the two it sees
    // first, regardless of whether the request is otherwise valid.
    //
    // 没有 tool-call parser 的引擎会拒绝它先看到的那个，哪怕请求其它部分完全合法。
    if (fixture.tools === false && ("tools" in payload || "tool_choice" in payload)) {
      return {
        status: 400,
        body: {
          detail:
            '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
        },
      };
    }
    if (fixture.rejectsResponseFormat && "response_format" in payload) {
      return {
        status: 400,
        body: {
          detail:
            "1 validation error:\n  {'type': 'extra_forbidden', 'loc': ('body', 'response_format')}",
        },
      };
    }
    return { status: 200, body: completion(fixture) };
  }

  if (Array.isArray(payload.messages?.[0]?.content)) {
    if (fixture.vision) return { status: 200, body: completion(fixture) };
    return {
      status: 400,
      body: { detail: `"${modelId}" is not a multimodal model` },
    };
  }

  return { status: 200, body: completion(fixture) };
}

/**
 * Start the mock. Returns its URL, a request log and a closer; `port: 0` picks a free
 * port, which is what a test wants.
 *
 * `legacyOnly: true` moves the whole API under `/api` and answers `/api/v1/models` with
 * 500, which is the deployment shape that made the old "anything but a 404" prefix
 * probing cache the wrong prefix.
 *
 * 启动 mock。返回 URL、请求日志与关闭函数；`port: 0` 会选一个空闲端口（测试用这个）。
 *
 * `legacyOnly: true` 把整个 API 挪到 `/api` 下、并让 `/api/v1/models` 回 500——正是这种
 * 部署形态让旧的"不是 404 就算对"的前缀探测缓存了错误的前缀。
 */
export async function startMockUpstream({ port = 0, host = "127.0.0.1", legacyOnly = false } = {}) {
  /** Every request, as "METHOD /path". */
  const log = [];
  /** The engine's clock: bumped on every model-list fetch, like real vLLM does. */
  /** 引擎时钟：像真实 vLLM 一样在每次拉取模型列表时前进。 */
  let servedAt = 1789036467;
  const apiPrefix = legacyOnly ? LEGACY_PREFIX : MODERN_PREFIX;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    log.push(`${request.method} ${url.pathname}`);

    const send = (status, body, contentType = "application/json") => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      response.writeHead(status, { "content-type": contentType });
      response.end(text);
    };

    /** The model list. Gzipped when (and only when) the client asked for it -- the
     *  Worker strips `accept-encoding`, so this only fires for a direct client. */
    const sendModels = () => {
      if (!request.headers.authorization) return send(401, { detail: "Unauthorized" });
      // Real vLLM rebuilds each card per response and stamps the CURRENT time on the
      // top-level `created` -- which the fingerprint deliberately ignores. Letting it
      // drift is what proves the fingerprint really is independent of it.
      //
      // 真实 vLLM 每次响应都重建卡片，并把**当前时间**打在顶层 `created` 上——指纹
      // 刻意忽略该字段。让它前进，正是"指纹确实与它无关"的证明。
      servedAt += 3;
      const payload = {
        object: "list",
        data: Object.keys(FIXTURES).map((id) => modelCard(id, servedAt)),
      };
      const wantsGzip = /\bgzip\b/i.test(String(request.headers["accept-encoding"] ?? ""));
      if (!wantsGzip) return send(200, payload);
      const compressed = gzipSync(JSON.stringify(payload));
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      return response.end(compressed);
    };

    if (url.pathname === `${LEGACY_PREFIX}/config` && request.method === "GET") {
      return send(200, {
        name: "Mock Open WebUI",
        version: "0.9.2",
        features: { enable_signup: false, web_search: true, auth: true },
      });
    }
    // The trap: an unknown route under the modern prefix is served by the SPA, so it
    // answers 200 with HTML instead of 404.
    //
    // 陷阱：现代前缀下的未知路由会落到 SPA 上，于是回 200 + HTML 而不是 404。
    if (url.pathname === `${MODERN_PREFIX}/config` && request.method === "GET") {
      return send(200, "<!doctype html><html><body>SPA</body></html>", "text/html");
    }
    if (url.pathname === `${MODERN_PREFIX}/models` && request.method === "GET") {
      // A broken (or not-yet-ready) modern prefix: the status code is not 404, so the
      // old "anything but a 404" rule would have trusted it.
      //
      // 现代前缀坏了（或尚未就绪）：状态码不是 404，因此旧的"不是 404 就算对"的规则会
      // 直接信任它。
      if (legacyOnly) return send(500, { detail: "Internal Server Error" });
      return sendModels();
    }
    if (url.pathname === `${LEGACY_PREFIX}/models` && request.method === "GET") {
      // In the normal mode this must 404 so prefix detection is really exercised; in
      // `legacyOnly` it is the real endpoint.
      //
      // 常态下这里必须 404，前缀探测才是真的被走到；`legacyOnly` 下它就是真端点。
      if (!legacyOnly) return send(404, { detail: "Not Found" });
      return sendModels();
    }
    if (url.pathname === `${apiPrefix}/chat/completions` && request.method === "POST") {
      if (!request.headers.authorization) return send(401, { detail: "Unauthorized" });
      let payload = {};
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          payload = {};
        }
        const answer = answerChat(payload.model, payload);
        send(answer.status, answer.body);
      });
      return undefined;
    }
    return send(404, { detail: "Not Found" });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    log,
    /** Requests since the last reset, for "cache hit = 0 requests" style assertions. */
    countRequests: () => log.length,
    resetLog: () => {
      log.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Standalone: `node mock/upstream.mjs 8799 [--legacy]`
// 独立运行：`node mock/upstream.mjs 8799 [--legacy]`
if (process.argv[1] && process.argv[1].endsWith("upstream.mjs")) {
  const port = Number(process.argv[2] ?? 8799);
  const legacyOnly = process.argv.includes("--legacy");
  const mock = await startMockUpstream({ port, legacyOnly });
  console.log(
    `mock Open WebUI listening on ${mock.url} (${Object.keys(FIXTURES).length} models${
      legacyOnly ? ", legacy-only: /api/v1/models answers 500" : ""
    })`,
  );
}
