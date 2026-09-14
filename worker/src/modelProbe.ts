/**
 * Model probe: what the upstream engine *really* accepts, established by asking
 * it instead of trusting metadata.
 *
 * Ported from the upstream Python project (commit ffef6e2: model_probe.py). Two
 * kinds of facts are discovered and cached together, because they come out of the
 * same minimal requests:
 *
 * 1. Reasoning efforts (`reasoning_effort`). Sending a sentinel value that cannot
 *    be a real level makes the engine's schema validation fail with a 400 whose
 *    text enumerates the accepted levels. That enumeration is only the OUTER
 *    schema though: the model's own reasoning parser (Harmony for gpt-oss, Qwen's
 *    own parser, ...) validates a second time and rejects a subset of it. Every
 *    candidate is therefore verified with a real one-token request, and only a 200
 *    counts as "supported". Real example: Qwen3.8-27B advertises
 *    none/minimal/low/medium/high/xhigh/max but rejects minimal, high and max.
 *
 * 2. Capabilities and request parameters (vision, function calling, structured
 *    outputs, ...). Here the engine is the only source of truth: Open WebUI's
 *    `info.meta.capabilities` is a deployment-wide default template that says
 *    nothing about any single model.
 *
 * This module is deliberately free of HTTP and of storage: it parses upstream
 * error text, builds the probe payloads, assembles the served facts, and owns the
 * in-memory cache (with change tracking). Sending the requests is the caller's job
 * (probeRound.ts), persisting the cache is the caller's job (probeStore.ts).
 *
 * 逐模型探测：通过"问引擎"而不是"信元数据"来确定上游真正接受什么。
 *
 * 从上游 Python 项目移植（提交 ffef6e2：model_probe.py）。两类事实一起获取并一起
 * 缓存，因为它们来自同一批最小请求：
 *
 * 1. 思考挡位（`reasoning_effort`）。发送一个绝不可能是真实挡位的哨兵值，会让引擎的
 *    schema 校验以 400 失败，错误文本里枚举了可接受的挡位。但那只是**外层** schema：
 *    模型自带的推理解析器（gpt-oss 的 Harmony、Qwen 自己的解析器等）还会校验第二次，
 *    并拒绝其中的一个子集。因此每个候选值都会再用一次真实的单 token 请求实证，
 *    只有 200 才算"支持"。真实例子：Qwen3.8-27B 广告了
 *    none/minimal/low/medium/high/xhigh/max，但实际拒绝 minimal、high 与 max。
 *
 * 2. 能力与请求参数（视觉、函数调用、结构化输出等）。这里引擎是唯一的事实来源：
 *    Open WebUI 的 `info.meta.capabilities` 是部署级默认模板，说明不了任何单个模型。
 *
 * 本模块刻意不碰 HTTP、也不碰存储：它只解析上游报错文本、构造探测载荷、组装对外
 * 事实，并持有带变更追踪的内存缓存。真正发请求是 probeRound.ts 的事，持久化是
 * probeStore.ts 的事。
 */

import { isPlainObject } from "./json.ts";
import type {
  ArchitectureInfo,
  ModelProbe,
  ModelProbeFields,
  ProbeStatus,
  ReasoningInfo,
} from "./types.ts";

// --------------------------------------------------------------------------- //
// Constants
// 常量
// --------------------------------------------------------------------------- //

/** Sentinel value that can never be a real effort level; the upstream's schema
 *  validation rejects it and names the accepted values in the error text. */
/** 哨兵值，绝不可能是真实挡位；上游的 schema 校验会拒绝它，并在错误文本里点名可接受的值。 */
export const PROBE_SENTINEL = "__probe__";

/** Canonical effort order, aligned with OpenRouter: from the largest effort down to
 *  fully off. Used to sort the emitted list and to run the fallback candidate sweep.
 *  Values unknown to this list (other upstreams may invent their own) still pass
 *  through, sorted last. */
/** 规范挡位顺序：对齐 OpenRouter——从最大思考到全关。用于输出排序与兜底候选遍历。不在该列表中的未知挡位照样透传，只是排在末尾。 */
export const EFFORT_ORDER: readonly string[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
];

const KNOWN_EFFORTS = new Set(EFFORT_ORDER);

/** Capability keys established by probing. Only the keys that were actually
 *  established are emitted, so a partial probe yields a partial object instead of
 *  a false "false" (the previous implementation echoed an upstream dict whose key
 *  set varied per model). */
/** 由探测确立的能力键。只输出确实被确立的键，因此部分成功的探测产出的是部分对象，而不是一个虚假的 false（旧实现透传上游字典，键集会随模型变化）。 */
const CAPABILITY_KEYS: readonly string[] = [
  "vision",
  "function_calling",
  "reasoning",
  "structured_outputs",
];

/** Request parameters verified by probing, named in OpenRouter's namespace. A 400
 *  is a definite "not supported"; a 200 only means "the engine did not reject it",
 *  which is what this list claims and no more. */
/** 通过探测验证的请求参数，采用 OpenRouter 的命名。400 是明确的"不支持"；200 只意味着"引擎没有拒绝该参数"——本列表声称的也仅此而已。 */
export const PROBED_PARAMETERS: readonly string[] = [
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

export const STATUS_OK: ProbeStatus = "ok";
export const STATUS_PARTIAL: ProbeStatus = "partial";
export const STATUS_UNPROBEABLE: ProbeStatus = "unprobeable";
const STATUS_FAILED: ProbeStatus = "failed";

/** Bumped whenever the stored shape changes; an older cache is ignored wholesale
 *  and every model is re-probed (a re-probe is annoying, not fatal). */
/** 存储结构变化时自增；旧版本缓存整体忽略并全部重探（重探一遍很烦，但不致命）。 */
export const CACHE_VERSION = 2;

/** Exponential backoff for retrying a model whose probe failed (or is
 *  incomplete). The bounds cap how often a broken model can be re-probed. */
/** 探测失败（或未完成）后重试的指数退避上下界，约束坏模型被重探的频率。 */
const BACKOFF_BASE_SECONDS = 60;
export const BACKOFF_MAX_SECONDS = 6 * 3600;

/** A 1x1 transparent PNG: the cheapest possible multimodal input, used to
 *  establish whether the engine accepts image content at all. */
/** 1x1 透明 PNG：最便宜的多模态输入，用来确定引擎是否接受图片内容。 */
const VISION_PROBE_IMAGE =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/8Fj4AAAAAElFTkSuQmCC";

// --------------------------------------------------------------------------- //
// Error-text parsing
// 报错文本解析
// --------------------------------------------------------------------------- //

// pydantic/vLLM style: "Input should be 'none', 'low', 'medium' or 'high'"
const INPUT_SHOULD_RE = /Input should be ((?:'[^']+'(?:\s*,\s*|\s+or\s+)?)+)/g;
// Harmony style: "Supported values are: high, medium, low."
// Qwen style:     "Supported types are xhigh (default), medium, and low."
const SUPPORTED_LIST_RE = /supported\s+(?:values|types)\s+(?:are|is)\s*:?\s*([^.\n]+)/gi;
// "(default)" marker, e.g. "Supported types are xhigh (default), medium, and low."
//
// Deliberately NOT global: this one is driven with `.exec()`, and a `g` flag makes
// `lastIndex` survive between calls -- the same text then parsed on one call and
// returned null on the next (measured: "xhigh", null, "xhigh"). The scanning patterns
// above use `matchAll`, which clones the regex, so they are unaffected.
//
// 刻意**不带** `g`：这个用 `.exec()` 驱动，带 `g` 会让 `lastIndex` 在调用之间残留——
// 同一段文本会一次解析成功、下一次返回 null（实测："xhigh"、null、"xhigh"）。上面那些
// 扫描用的正则走 `matchAll`，内部会克隆正则，因此不受影响。
const DEFAULT_MARKER_RE = /([A-Za-z0-9_-]+)\s*\(\s*default\s*\)/i;
// "the default is xhigh" / "default: xhigh"
const DEFAULT_PHRASE_RE = /default\s*(?:is|:)\s*'?([A-Za-z0-9_-]+)'?/i;
// A bare effort-looking token inside a comma/and separated list
const LIST_TOKEN_RE = /[A-Za-z][A-Za-z0-9_-]{1,15}/g;
// The error text must be about the reasoning effort; otherwise an "Input should
// be" clause belonging to a different field would be misparsed.
const EFFORT_TOPIC_RE = /reasoning[_ ]effort/i;

// pydantic loc tuples, e.g. "'loc': ('body', 'reasoning_effort')"
const LOC_RE = /'loc'\s*:\s*\(([^)]*)\)/;
const LOC_TOKEN_RE = /'([^']+)'|"([^"]+)"/g;

/** Keyword -> parameter name, for engines that do not return a pydantic loc
 *  (e.g. vLLM's tool-call-parser complaint). Compiled once into word-bounded
 *  regexes below: a bare substring match let ordinary English words inside an
 *  unrelated 400 body ("...cannot stop...") blame the `stop` parameter and
 *  cascade real parameters out of supported_parameters.
 *
 *  关键词 -> 参数名，用于不返回 pydantic loc 的引擎（例如 vLLM 关于
 *  tool-call-parser 的报错）。下方一次性编译成带词边界的正则：裸子串匹配会让
 *  无关 400 响应体里的普通英文单词（"…cannot stop…"）归因到 stop 参数，并把
 *  实际支持的参数级联剔除出 supported_parameters。 */
const PARAMETER_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ["tool_choice", "tool_choice"],
  ["tool choice", "tool_choice"],
  ["tool-call-parser", "tools"],
  ["tool_call_parser", "tools"],
  ["tools", "tools"],
  ["function", "tools"],
  ["json_schema", "response_format"],
  ["response_format", "response_format"],
  ["guided", "response_format"],
  ["structured", "response_format"],
  ["logprob", "logprobs"],
  ["temperature", "temperature"],
  ["top_p", "top_p"],
  ["stop", "stop"],
  ["seed", "seed"],
  ["parallel_tool_calls", "parallel_tool_calls"],
  ["reasoning", "reasoning_effort"],
];

/** Word-bounded keyword matchers, in the same priority order as the table above. */
/** 带词边界的关键词匹配器，与上表保持相同的优先级顺序。 */
const PARAMETER_KEYWORD_RES: ReadonlyArray<readonly [RegExp, string]> = PARAMETER_KEYWORDS.map(
  ([keyword, parameter]) => [new RegExp(`\\b${keyword}\\b`, "i"), parameter],
);

/** Whether a raw token is plausible as an effort level. */
/** 判断一个原始 token 是否可能是挡位值。 */
function looksLikeEffort(token: string): boolean {
  const lowered = token.trim().replace(/^['"]+|['"]+$/g, "").toLowerCase();
  if (!lowered) return false;
  return !["default", "and", "or", "the", "is", "are"].includes(lowered);
}

/**
 * Pull every plausible accepted effort level out of an upstream error.
 *
 * Three real-world phrasings are understood:
 *
 *     Input should be 'none', 'low', 'medium' or 'high'      (pydantic/vLLM)
 *     Supported values are: high, medium, low.               (Harmony / gpt-oss)
 *     Supported types are xhigh (default), medium, and low.  (Qwen)
 *
 * Guards: the text must mention the reasoning effort (otherwise a same-shaped
 * error about an unrelated enum slips through), and at least one extracted value
 * must be a known level.
 *
 * This enumeration is only the outer schema -- callers MUST verify each candidate
 * with a real request before advertising it. Returns [] when nothing could be
 * extracted; the caller then sweeps the full canonical list, so an unparseable
 * upstream stays usable (it costs requests, not correctness).
 *
 * 从上游报错里提取所有可能的可接受挡位。
 *
 * 理解三种真实措辞：
 *
 *     Input should be 'none', 'low', 'medium' or 'high'      （pydantic/vLLM）
 *     Supported values are: high, medium, low.               （Harmony / gpt-oss）
 *     Supported types are xhigh (default), medium, and low.  （Qwen）
 *
 * 两道防线：文本必须提到思考挡位（否则同构的无关枚举错误会漏进来），且提取值中
 * 至少有一个是已知挡位。
 *
 * 这个枚举只是外层 schema —— 调用方**必须**逐个用真实请求实证后才能对外声明。
 * 提取不到时返回 []；调用方随后会兜底遍历完整规范列表，因此即使上游换了措辞也
 * 仍然可用（只多花请求，不影响正确性）。
 */
export function extractEffortCandidates(errorText: string): string[] {
  if (!errorText || !EFFORT_TOPIC_RE.test(errorText)) return [];

  const found: string[] = [];

  for (const match of errorText.matchAll(INPUT_SHOULD_RE)) {
    for (const quoted of match[1].matchAll(/'([^']+)'/g)) found.push(quoted[1]);
  }

  for (const match of errorText.matchAll(SUPPORTED_LIST_RE)) {
    for (const token of match[1].matchAll(LIST_TOKEN_RE)) {
      if (looksLikeEffort(token[0])) found.push(token[0]);
    }
  }

  // The value that was rejected is itself informative when the engine also names
  // what it does accept, e.g. "reasoning_effort='max' is not supported by Harmony.
  // Supported values are: high, medium, low." -- here only the list matters, so
  // the rejected value is used solely to decide whether the text is on topic.
  //
  // 被拒绝的那个值本身也有信息量（当引擎同时给出可接受列表时）。上面那条 Harmony
  // 报错里真正有用的是列表，因此被拒绝的值只用于确认文本切题。
  if (found.length === 0) return [];

  const normalized: string[] = [];
  for (const raw of found) {
    const value = raw.trim().replace(/^['"]+|['"]+$/g, "").toLowerCase();
    if (!value || value === PROBE_SENTINEL) continue;
    if (!normalized.includes(value)) normalized.push(value);
  }

  if (!normalized.some((value) => KNOWN_EFFORTS.has(value))) return [];
  return sortEfforts(normalized);
}

/**
 * Pull the engine-declared default effort out of an upstream error, if it names
 * one ("xhigh (default)" / "the default is xhigh").
 *
 * The previous implementation guessed this ("medium" or the median of the accepted
 * list); the honest answer is null when the engine does not say.
 *
 * 从上游报错里提取引擎自己声明的默认挡位（如 "xhigh (default)" / "default is xhigh"）。
 *
 * 旧实现靠猜（"medium" 或可接受列表的中位数）；引擎没说时，诚实的答案是 null。
 */
export function extractDefaultEffort(errorText: string): string | null {
  // Same topical guard as extractEffortCandidates: the "default" markers below are
  // generic phrasing, so without the guard an unrelated enum error could be mined
  // for a default effort if a future call site reuses this parser.
  //
  // 与 extractEffortCandidates 相同的切题防线：下面的 "default" 标记是通用措辞，
  // 若未来调用方复用本解析器，没有这道防线就会从无关枚举的报错里挖出默认挡位。
  if (!errorText || !EFFORT_TOPIC_RE.test(errorText)) return null;
  for (const pattern of [DEFAULT_MARKER_RE, DEFAULT_PHRASE_RE]) {
    const match = pattern.exec(errorText);
    if (match) {
      const value = match[1].trim().replace(/^['"]+|['"]+$/g, "").toLowerCase();
      if (value && value !== PROBE_SENTINEL) return value;
    }
  }
  return null;
}

/**
 * Whether an upstream failure is about the reasoning effort -- used to decide
 * whether a live 400 should invalidate the cached effort list for that model.
 *
 * 上游的失败是否与思考挡位有关——用于判断一次线上 400 是否应当作废该模型的挡位缓存。
 */
export function looksLikeEffortError(errorText: string): boolean {
  return Boolean(errorText) && EFFORT_TOPIC_RE.test(errorText);
}

/**
 * Attribute an upstream 400 to the request parameter that caused it.
 *
 * Prefers the pydantic `loc` (exact), falls back to keyword matching, and returns
 * null when the error cannot be attributed -- the caller then claims nothing about
 * the parameters still under test instead of guessing.
 *
 * 把上游 400 归因到引发它的请求参数。
 *
 * 优先使用 pydantic 的 `loc`（精确），其次关键词匹配；无法归因时返回 null ——
 * 调用方随后对仍在测试的参数不做任何声明，而不是猜。
 */
export function parameterOfError(errorText: string): string | null {
  if (!errorText) return null;

  const locMatch = LOC_RE.exec(errorText);
  if (locMatch) {
    const tokens: string[] = [];
    for (const token of locMatch[1].matchAll(LOC_TOKEN_RE)) {
      tokens.push(token[1] || token[2]);
    }
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = tokens[index];
      if (PROBED_PARAMETERS.includes(token) || token === "reasoning_effort") return token;
    }
  }

  for (const [keywordRe, parameter] of PARAMETER_KEYWORD_RES) {
    if (keywordRe.test(errorText)) return parameter;
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Probe payloads
// 探测载荷
// --------------------------------------------------------------------------- //

/** A minimal completion request carrying one reasoning-effort value. max_tokens=1
 *  bounds the worst case where an upstream ignores the field and generates. */
/** 携带一个思考挡位值的最小补全请求。max_tokens=1 兜住最坏情况——上游完全忽略该字段并真的生成时，代价也只有 1 个 token。 */
export function effortPayload(modelId: string, effort: string): Record<string, unknown> {
  return {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
    reasoning_effort: effort,
  };
}

/** The same minimal request with `reasoning_effort` omitted, used to observe what
 *  the engine does by default (whether thinking is on). */
/** 同样的最小请求，但不带 `reasoning_effort`，用于观察引擎的默认行为（思考是否默认开启）。 */
export function baselinePayload(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  };
}

/** One request carrying every parameter still under test, so a single 200 clears
 *  them all and a single 400 can be attributed (then retried without the offender). */
/** 一个携带全部待测参数的请求：一次 200 就全部通过，一次 400 可被归因（剔除冒犯者后重试）。 */
export function parameterPayload(
  modelId: string,
  parameters: readonly string[],
): Record<string, unknown> {
  const payload = baselinePayload(modelId);
  for (const parameter of parameters) {
    switch (parameter) {
      case "tools":
        payload.tools = [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ];
        break;
      case "tool_choice":
        payload.tool_choice = "auto";
        break;
      case "response_format":
        payload.response_format = {
          type: "json_schema",
          json_schema: {
            name: "probe",
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
        };
        break;
      case "logprobs":
        payload.logprobs = true;
        payload.top_logprobs = 1;
        break;
      case "temperature":
        payload.temperature = 0.7;
        break;
      case "top_p":
        payload.top_p = 0.9;
        break;
      case "stop":
        payload.stop = ["\n\n"];
        break;
      case "seed":
        payload.seed = 42;
        break;
      case "parallel_tool_calls":
        payload.parallel_tool_calls = true;
        break;
      default:
        break;
    }
  }
  return payload;
}

/** The minimal request that asks the engine whether it accepts image content. */
/** 询问引擎是否接受图片内容的最小请求。 */
export function visionPayload(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "ping" },
          { type: "image_url", image_url: { url: VISION_PROBE_IMAGE } },
        ],
      },
    ],
    max_tokens: 1,
    stream: false,
  };
}

// --------------------------------------------------------------------------- //
// Fact assembly
// 事实组装
// --------------------------------------------------------------------------- //

/**
 * Read a chat-completion body and report whether the model produced thinking text.
 *
 * null means "cannot tell" (unparseable body, or a choice that carries neither
 * content nor reasoning), which callers must not turn into a claim.
 *
 * 读取补全响应体，判断模型是否产出了思考文本。
 *
 * null 表示"看不出来"（响应体无法解析，或该 choice 既没有 content 也没有
 * reasoning），调用方不得把它变成结论。
 */
export function responseHasReasoning(body: string): boolean | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isPlainObject(first)) return null;
  const message = first.message;
  if (!isPlainObject(message)) return null;
  const reasoning = message.reasoning ?? message.reasoning_content;
  const content = message.content;
  if (reasoning) return true;
  if (content) return false;
  return null;
}

/**
 * Read the engine build string out of a chat-completion body (diagnostics only).
 *
 * 从补全响应体里读出引擎构建串（仅供诊断）。
 */
export function engineBuild(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return "";
  }
  if (!isPlainObject(payload)) return "";
  const value = payload.system_fingerprint;
  return value ? String(value) : "";
}

/** Sort effort levels into canonical order (max -> none); unknown values keep
 *  their original relative order at the end. */
/** 把挡位按规范顺序（max -> none）排序；未知值按原相对顺序排在末尾。 */
export function sortEfforts(efforts: readonly string[]): string[] {
  const known = EFFORT_ORDER.filter((level) => efforts.includes(level));
  const seen = new Set(known);
  const unknown = efforts.filter((level) => !seen.has(level));
  return [...known, ...unknown];
}

/**
 * Assemble the per-model "reasoning" object served on /v1/models, in OpenRouter's
 * shape: supported_efforts / mandatory / default_effort / default_enabled.
 *
 * Unknown facts are omitted rather than guessed (OpenRouter does the same: some of
 * its models carry nothing but {"mandatory": false}).
 *
 * 组装 /v1/models 上每个模型的 "reasoning" 对象，采用 OpenRouter 的形状：
 * supported_efforts / mandatory / default_effort / default_enabled。
 *
 * 拿不准的事实一律省略而不是猜（OpenRouter 也是如此：它有些模型只带
 * {"mandatory": false}）。
 */
export function buildReasoningInfo(
  efforts: readonly string[],
  defaultEffort: string | null = null,
  defaultEnabled: boolean | null = null,
): ReasoningInfo | null {
  if (efforts.length === 0) return null;
  const info: ReasoningInfo = {
    supported_efforts: sortEfforts(efforts),
    mandatory: !efforts.includes("none"),
  };
  if (defaultEffort) info.default_effort = defaultEffort;
  if (defaultEnabled !== null && defaultEnabled !== undefined) {
    info.default_enabled = defaultEnabled;
  }
  return info;
}

/**
 * OpenRouter-shaped modality description derived from the vision probe. Only the
 * three keys we can actually establish are emitted; `tokenizer`/`instruct_type`
 * have no source here and are left out.
 *
 * 由视觉探测推导出的 OpenRouter 形状模态描述。只输出三个确实能确立的键；
 * `tokenizer`/`instruct_type` 在本项目里没有来源，故不输出。
 */
export function buildArchitecture(vision: boolean | null | undefined): ArchitectureInfo | null {
  if (vision === null || vision === undefined) return null;
  return {
    modality: vision ? "text+image->text" : "text->text",
    input_modalities: vision ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
  };
}

/**
 * Whether the model is reasoning-capable: the engine accepts at least one level
 * other than "off", or thinking was observed on a request without the field.
 *
 * Returns null when neither source is conclusive.
 *
 * 模型是否具备思考能力：引擎接受至少一个"非关闭"挡位，或在未携带该字段的请求里
 * 观察到了思考内容。两个来源都得不出结论时返回 null。
 */
export function deriveReasoningCapability(
  supportedEfforts: readonly string[] | null,
  defaultEnabled: boolean | null,
): boolean | null {
  if (supportedEfforts && supportedEfforts.length > 0) {
    return supportedEfforts.some((level) => level !== "none");
  }
  if (defaultEnabled !== null && defaultEnabled !== undefined) return defaultEnabled;
  return null;
}

// --------------------------------------------------------------------------- //
// Cache entry
// 缓存条目
// --------------------------------------------------------------------------- //

/** Whether anything presentable was ever established. */
/** 是否已确立任何可呈现的事实。 */
function probeHasFacts(probe: ModelProbe): boolean {
  return (
    probe.status === STATUS_OK ||
    probe.status === STATUS_PARTIAL ||
    probe.status === STATUS_UNPROBEABLE
  );
}

/** A fresh entry for one probe attempt. */
/** 一次探测尝试的全新条目。 */
export function createModelProbe(fingerprint: string, probedAt: number): ModelProbe {
  return {
    fingerprint,
    probed_at: probedAt,
    status: STATUS_FAILED,
    attempts: 0,
    retry_after: 0,
    last_error: "",
    supported_efforts: [],
    efforts_verified: false,
    default_effort: null,
    default_enabled: null,
    capabilities: {},
    supported_parameters: [],
    system_fingerprint: "",
  };
}

/** Serialize an entry for storage (SQLite row payload). Field set and order match
 *  the upstream Python `ModelProbe.to_dict`. */
/** 把条目序列化以供存储（SQLite 行负载）。字段集合与顺序与上游 Python 的 `ModelProbe.to_dict` 一致。 */
export function modelProbeToDict(probe: ModelProbe): Record<string, unknown> {
  return {
    fingerprint: probe.fingerprint,
    probed_at: probe.probed_at,
    status: probe.status,
    attempts: probe.attempts,
    retry_after: probe.retry_after,
    last_error: probe.last_error,
    supported_efforts: [...probe.supported_efforts],
    efforts_verified: probe.efforts_verified,
    default_effort: probe.default_effort,
    default_enabled: probe.default_enabled,
    capabilities: { ...probe.capabilities },
    supported_parameters: [...probe.supported_parameters],
    system_fingerprint: probe.system_fingerprint,
  };
}

/** Tolerant parse of a stored entry; anything unusable falls back to a default. */
/** 宽容地解析存储条目；无法使用的字段回落到默认值。 */
export function modelProbeFromDict(raw: unknown): ModelProbe {
  const source = isPlainObject(raw) ? raw : {};
  const capabilities: Record<string, boolean> = {};
  if (isPlainObject(source.capabilities)) {
    for (const [key, value] of Object.entries(source.capabilities)) {
      if (typeof value === "boolean") capabilities[key] = value;
    }
  }
  const defaultEnabled = source.default_enabled;
  return {
    fingerprint: stringOr(source.fingerprint, ""),
    probed_at: asFloat(source.probed_at),
    // A status we do not recognize is treated as "failed" so the entry gets
    // retried instead of being mistaken for a conclusive result.
    //
    // 无法识别的状态按 failed 处理，让该条目被重试，而不是被误当成结论。
    status: normalizeStatus(source.status),
    attempts: Math.trunc(asFloat(source.attempts)),
    retry_after: asFloat(source.retry_after),
    last_error: stringOr(source.last_error, ""),
    supported_efforts: stringArray(source.supported_efforts),
    efforts_verified: Boolean(source.efforts_verified),
    default_effort: source.default_effort ? String(source.default_effort) : null,
    default_enabled: typeof defaultEnabled === "boolean" ? defaultEnabled : null,
    capabilities,
    supported_parameters: stringArray(source.supported_parameters),
    system_fingerprint: stringOr(source.system_fingerprint, ""),
  };
}

/**
 * Exponential backoff for the Nth consecutive failure, capped.
 *
 * 第 N 次连续失败后的指数退避，带上限。
 */
export function backoffSeconds(attempts: number): number {
  if (attempts <= 1) return BACKOFF_BASE_SECONDS;
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** (attempts - 1), BACKOFF_MAX_SECONDS);
}

/** Unix epoch seconds with sub-second precision (matches Python's time.time()). */
/** Unix 秒级时间戳，带小数（与 Python 的 time.time() 一致）。 */
function nowSeconds(): number {
  return Date.now() / 1000;
}

// --------------------------------------------------------------------------- //
// Cache
// 缓存
// --------------------------------------------------------------------------- //

/** The pending store changes produced by cache mutations. */
/** 缓存变更产生的待落盘差异。 */
export interface ProbeCacheChanges {
  upserts: Array<[string, ModelProbe]>;
  deletes: string[];
}

/**
 * modelId -> ModelProbe, held in memory, with change tracking for the caller to
 * persist.
 *
 * The cache is the contract between "what we verified once" and "what /v1/models
 * advertises": a model is re-probed only when its engine fingerprint changes, when
 * a previous probe left it inconclusive and its backoff has expired, or when the
 * operator forces a refresh.
 *
 * modelId -> ModelProbe 的内存缓存，并追踪变更供调用方落盘。
 *
 * 缓存是"我们实证过一次的结论"与"/v1/models 对外声明"之间的契约：只有当引擎指纹
 * 变化、上次探测结论不完整且退避已过期、或运维强制刷新时，才会重探该模型。
 */
export class ModelProbeCache {
  private readonly entries = new Map<string, ModelProbe>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private loaded = false;

  /**
   * Populate the cache from stored rows (idempotent, mirroring the upstream
   * loader). A missing or older-version store simply starts empty.
   *
   * 从存储的行载入缓存（幂等，与上游加载器一致）。存储缺失或版本较旧时从空缓存开始。
   */
  load(rows: Iterable<readonly [string, ModelProbe]>): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const [id, probe] of rows) this.entries.set(id, probe);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The raw cached entry, without interpretation. */
  /** 原始缓存条目，不做解释。 */
  entry(modelId: string): ModelProbe | undefined {
    return this.entries.get(modelId);
  }

  /** Every cached (id, entry) pair, in insertion order. */
  /** 全部 (id, 条目) 对，按插入顺序。 */
  all(): Array<[string, ModelProbe]> {
    return [...this.entries.entries()];
  }

  /**
   * The model-level fields /v1/models should carry for this model: capabilities,
   * supported_parameters, reasoning and architecture -- each only when it was
   * actually established. null when nothing is known yet.
   *
   * /v1/models 应为本模型携带的模型级字段：capabilities、supported_parameters、
   * reasoning 与 architecture —— 各自只在确实确立后才出现。什么都还不知道时返回 null。
   */
  present(modelId: string): ModelProbeFields | null {
    const entry = this.entries.get(modelId);
    if (!entry || !probeHasFacts(entry)) return null;

    const presented: ModelProbeFields = {};
    const hasCapabilities = Object.keys(entry.capabilities).length > 0;

    if (hasCapabilities) {
      const capabilities: Record<string, boolean> = {};
      for (const key of CAPABILITY_KEYS) {
        if (key in entry.capabilities) capabilities[key] = Boolean(entry.capabilities[key]);
      }
      presented.capabilities = capabilities;
    }
    if (entry.supported_parameters.length > 0) {
      presented.supported_parameters = [...entry.supported_parameters];
    }

    const reasoning = buildReasoningInfo(
      entry.supported_efforts,
      entry.default_effort,
      entry.default_enabled,
    );
    if (reasoning) presented.reasoning = reasoning;

    if (hasCapabilities) {
      const architecture = buildArchitecture(entry.capabilities.vision);
      if (architecture) presented.architecture = architecture;
    }

    return Object.keys(presented).length > 0 ? presented : null;
  }

  /**
   * Whether this model should be (re-)probed right now.
   *
   * 该模型现在是否应当（重新）探测。
   */
  needsProbe(modelId: string, fingerprint: string, now: number = nowSeconds()): boolean {
    const entry = this.entries.get(modelId);
    if (!entry) return true;
    if (entry.fingerprint !== fingerprint) return true;
    if (entry.status === STATUS_FAILED || entry.status === STATUS_PARTIAL) {
      return now >= entry.retry_after;
    }
    // STATUS_OK / STATUS_UNPROBEABLE are conclusive: nothing more to learn until
    // the engine fingerprint changes.
    //
    // STATUS_OK / STATUS_UNPROBEABLE 已是结论：在引擎指纹变化前没有更多可学的。
    return false;
  }

  /** Store an entry verbatim. / 原样存入一个条目。 */
  replace(modelId: string, probe: ModelProbe): void {
    this.entries.set(modelId, probe);
    this.dirty.add(modelId);
    this.removed.delete(modelId);
  }

  /**
   * Store a completed probe attempt.
   *
   * A result that is still incomplete (`partial`) carries the failure streak over,
   * so a model whose probe can never be fully resolved backs off instead of being
   * re-probed on every request. A conclusive result resets the streak.
   *
   * 保存一次完成的探测尝试。
   *
   * 仍不完整（`partial`）的结果会继承失败计数，使"永远无法完全探清"的模型按退避
   * 重试，而不是每次请求都重探；结论性结果则清零计数。
   */
  recordResult(modelId: string, probe: ModelProbe, now: number = nowSeconds()): ModelProbe {
    const previous = this.entries.get(modelId);
    const sameEngine = previous !== undefined && previous.fingerprint === probe.fingerprint;
    if (probe.status === STATUS_PARTIAL) {
      probe.attempts = (sameEngine ? previous.attempts : 0) + 1;
      probe.retry_after = now + backoffSeconds(probe.attempts);
    } else {
      probe.attempts = 0;
      probe.retry_after = 0;
    }
    this.replace(modelId, probe);
    return probe;
  }

  /**
   * Record a failed attempt without discarding facts established earlier.
   *
   * The entry keeps its previous status/data when it had any, and always gets a
   * fresh backoff deadline so a broken model is not re-probed on every request.
   *
   * 记录一次失败尝试，但不丢弃此前已确立的事实。
   *
   * 若条目本来就有结论，则保留原状态/数据；无论如何都会写入新的退避截止时间，
   * 使坏模型不会被每次请求重探。
   */
  recordFailure(
    modelId: string,
    fingerprint: string,
    error: string,
    now: number = nowSeconds(),
  ): ModelProbe {
    const known = this.entries.get(modelId);
    let attempts = (known && known.fingerprint === fingerprint ? known.attempts : 0) + 1;
    let entry = known ?? createModelProbe(fingerprint, 0);
    if (entry.fingerprint !== fingerprint) {
      // The engine changed under us: previous facts are void.
      // 引擎在我们脚下换了：此前的事实作废。
      entry = createModelProbe(fingerprint, 0);
      attempts = 1;
    }
    entry.fingerprint = fingerprint;
    entry.attempts = attempts;
    entry.retry_after = now + backoffSeconds(attempts);
    entry.last_error = error.slice(0, 300);
    if (!probeHasFacts(entry)) entry.status = STATUS_FAILED;
    this.replace(modelId, entry);
    return entry;
  }

  /**
   * Remove one effort level from a cached list (a live 400 just disproved it) and
   * make the model eligible for a re-probe. Returns whether anything changed.
   *
   * 从缓存列表里移除某个挡位（线上 400 刚刚证伪了它），并让该模型可以被重探。
   * 返回是否有改动。
   */
  invalidateEffort(modelId: string, effort: string | null | undefined): boolean {
    const entry = this.entries.get(modelId);
    if (!entry || !effort) return false;
    if (!entry.supported_efforts.includes(effort)) return false;
    entry.supported_efforts = entry.supported_efforts.filter((value) => value !== effort);
    if (entry.default_effort === effort) {
      // The default cannot be a level the engine just rejected.
      // 默认值不可能是一个刚被引擎拒绝的挡位。
      entry.default_effort = null;
    }
    entry.status = STATUS_PARTIAL;
    entry.retry_after = 0;
    entry.last_error = `upstream rejected reasoning_effort='${effort}'`;
    this.dirty.add(modelId);
    return true;
  }

  /**
   * Reconcile the cache with the current model list and return the ids that still
   * need probing.
   *
   * `models` is a sequence of (modelId, engine fingerprint). Entries for models
   * that no longer exist upstream are dropped (a disappearing model frees its slot;
   * a re-added model is probed again because its entry was removed). With
   * force=true every current model is returned for a full re-probe.
   *
   * `prune` (default true) says whether `models` really IS the authoritative upstream
   * list. Only a caller holding the full list may drop what is missing from it: the
   * single-model read path passes exactly one ref, and pruning against that subset
   * would delete every other model's entry. The upstream Python project needs no such
   * switch only because its sole caller always has the complete list.
   *
   * 将缓存与当前模型列表对齐，返回仍需探测的模型 id。
   *
   * `models` 是 (模型 id, 引擎指纹) 序列。上游已不存在的模型条目会被清除（模型消失
   * 即释放槽位；重新上架的模型因条目已删会再次探测）。force=true 时返回全部当前
   * 模型做完整重探。
   *
   * `prune`（默认 true）表示 `models` 是否**确实**是权威的上游完整列表。只有持有完整
   * 列表的调用方才能删除其中缺失的条目：单模型读取路径只传一个 ref，按该子集裁剪会
   * 删掉其他所有模型的条目。上游 Python 项目不需要这个开关，仅仅因为它唯一的调用方
   * 永远持有完整列表。
   */
  syncWithModels(
    models: ReadonlyArray<readonly [string, string]>,
    options: { force?: boolean; now?: number; prune?: boolean } = {},
  ): string[] {
    // Upstreams can repeat an id across providers; probing it twice would spend a
    // whole extra budget for nothing, and `stats.total` would overstate the work.
    // Keep the FIRST fingerprint seen for an id, and use the same deduplicated set
    // for the reconciliation below.
    //
    // 上游可能在不同 provider 下重复同一个 id；探两遍会白白多花一整个模型的预算，
    // `stats.total` 也会虚高。同一 id 保留**首个**指纹，下面的对齐也用同一份去重结果。
    const seen = new Set<string>();
    const unique: Array<[string, string]> = [];
    for (const [modelId, fingerprint] of models) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      unique.push([modelId, fingerprint]);
    }

    if (options.prune !== false) {
      for (const modelId of [...this.entries.keys()]) {
        if (seen.has(modelId)) continue;
        this.entries.delete(modelId);
        this.removed.add(modelId);
        this.dirty.delete(modelId);
      }
    }
    // `force` short-circuits inside the filter instead of returning early: an early
    // return would bypass the deduplication above (the same bug the upstream project
    // removed).
    //
    // `force` 在 filter 里短路，而不是提前 return：提前返回会绕过上面的去重
    // （上游项目同样删掉了那个提前 return 分支）。
    const moment = options.now ?? nowSeconds();
    return unique
      .filter(
        ([modelId, fingerprint]) =>
          options.force === true || this.needsProbe(modelId, fingerprint, moment),
      )
      .map(([modelId]) => modelId);
  }

  /**
   * Take the accumulated changes (clearing them) so the caller can persist exactly
   * what changed -- one write per model, not one rewrite of everything.
   *
   * 取走累计的变更（并清空），使调用方只落盘真正变化的部分——每模型一次写入，
   * 而不是每次重写全部。
   */
  takeChanges(): ProbeCacheChanges {
    const upserts: Array<[string, ModelProbe]> = [];
    for (const modelId of this.dirty) {
      const entry = this.entries.get(modelId);
      if (entry) upserts.push([modelId, entry]);
    }
    const deletes = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    return { upserts, deletes };
  }
}

// --------------------------------------------------------------------------- //
// Small helpers
// 小工具
// --------------------------------------------------------------------------- //

function asFloat(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringOr(value: unknown, fallback: string): string {
  return value ? String(value) : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function normalizeStatus(value: unknown): ProbeStatus {
  if (
    value === "ok" ||
    value === "partial" ||
    value === "unprobeable" ||
    value === "failed"
  ) {
    return value;
  }
  return STATUS_FAILED;
}
