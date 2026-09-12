/**
 * Model catalog: the pure half of /v1/models handling, shared by the proxy (which
 * serves the list) and the Durable Object (which needs the same fingerprints when
 * it probes on its own alarm).
 *
 * Ported from the upstream Python project (commit ffef6e2: app.py `normalize_model`,
 * `_raw_model_capabilities`, `_shared_default_capabilities`, `_model_fingerprint`,
 * `extract_model_list`).
 *
 * Two things are deliberately NOT built here: `capabilities`, `architecture`,
 * `supported_parameters` and `reasoning`. Those are established by probing the
 * engine and merged in afterwards, because the upstream's own capability dictionary
 * is a deployment-wide default template rather than a fact about the model.
 *
 * 模型目录：/v1/models 处理中纯逻辑的那一半，由代理（对外输出列表）与 Durable
 * Object（自行按 alarm 探测时需要同样的指纹）共用。
 *
 * 从上游 Python 项目移植（提交 ffef6e2：app.py 的 `normalize_model`、
 * `_raw_model_capabilities`、`_shared_default_capabilities`、`_model_fingerprint`、
 * `extract_model_list`）。
 *
 * 有两类字段刻意**不在这里**构造：`capabilities`、`architecture`、
 * `supported_parameters`、`reasoning`。它们由探测引擎确立后再合并进来，因为上游
 * 自带的能力字典是部署级默认模板，而不是关于该模型的事实。
 */

import { isPlainObject } from "./json.ts";

/** Quantization tokens recognizable in model ids: NVFP4, FP8, FP16, INT8, GPTQ, AWQ, ...
 *  Kept in sync with the pre-probe behaviour of this project. */
/** 模型名中可识别的量化标识：NVFP4、FP8、FP16、INT8、GPTQ、AWQ 等，与探测功能加入前的行为保持一致。 */
const QUANT_PATTERN =
  /\b(NVFP4|FP4|FP8|FP16|INT8|INT4|GPTQ(?:-?[0-9]+BIT)?|AWQ|GGUF|Q[0-9](?:_[A-Z0-9]+)*)\b/i;

/** Upstream versions return inconsistent shapes: {"data": [...]} / {"items": [...]} / a bare list. */
/** 上游不同版本返回结构不一致：{"data": [...]} / {"items": [...]} / 裸列表。 */
export function extractModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isPlainObject(payload)) {
    for (const key of ["data", "items", "models"]) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/**
 * Whether a payload is a model-list shape we recognize, EVEN WHEN IT IS EMPTY.
 *
 * Needed to tell "the upstream really reports no models" from "we could not read the
 * response at all" (an HTML page the SPA served, an unexpected shape). The latter
 * must never be treated as an authoritative empty list: reconciling the probe cache
 * against it would drop every model and force a full re-probe.
 *
 * 判断一个负载是否是我们认得的模型列表形状——**即使是空的**。
 *
 * 用于区分"上游确实没有模型"与"我们完全读不懂这个响应"（SPA 给的 HTML、意外的形状）。
 * 后者绝不能被当成权威空列表：按它对齐探测缓存会删掉每一个模型并触发全量重探。
 */
export function isModelListPayload(payload: unknown): boolean {
  if (Array.isArray(payload)) return true;
  if (!isPlainObject(payload)) return false;
  return ["data", "items", "models"].some((key) => Array.isArray(payload[key]));
}

/**
 * Whether an HTTP response looks like a real Open WebUI model list.
 *
 * The status code alone proves nothing: an unknown route under the modern prefix is
 * served by the SPA, which answers 200 with an HTML page, and a temporary 5xx says
 * nothing about the route either. Both were treated as "the prefix is right" by the
 * old 404-driven probing, which then cached the wrong prefix and sent every later
 * request into a route that does not exist. This is the check that tells the two
 * apart, and it is used by prefix probing (proxy and coordinator) and by the admin
 * connectivity test.
 *
 * The caller hands over the body it already read, because a `Response` body can only
 * be consumed once and those callers must keep the text for their own error paths.
 *
 * 判断一个 HTTP 响应是否看起来像真实的 Open WebUI 模型列表。
 *
 * 只看状态码什么都证明不了：现代前缀下的未知路由会落到 SPA 上，由 SPA 回 200 + 一页
 * HTML；临时 5xx 同样说明不了路由是否存在。旧的"基于 404"的探测把两种情况都当成
 * "前缀是对的"，于是缓存了错误的前缀，此后每个请求都发进不存在的路由。本函数正是用来
 * 区分这两者的，被前缀探测（代理与协调者）和管理端连通性测试共用。
 *
 * 由调用方交入它已经读出的响应体：`Response` 的 body 只能消费一次，而这些调用方还要
 * 把该文本用于自己的错误路径。
 */
export function looksLikeModelList(
  status: number,
  contentType: string | null,
  text: string,
): boolean {
  if (status < 200 || status >= 300) return false;
  if ((contentType ?? "").toLowerCase().includes("html")) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return isModelListPayload(payload);
}

/** The id-like field a raw model object carries, if any. */
/** 原始模型对象携带的 id 类字段（若有）。 */
export function modelIdOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!isPlainObject(raw)) return null;
  const value = raw.id ?? raw.name ?? raw.model;
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** The capability dictionary one upstream model object carries, boolean entries only. */
/** 单个上游模型对象携带的能力字典，只保留布尔项。 */
export function rawModelCapabilities(raw: unknown): Record<string, boolean> {
  if (!isPlainObject(raw)) return {};
  const info = isPlainObject(raw.info) ? raw.info : {};
  const meta = isPlainObject(info.meta) ? info.meta : {};
  const capabilities = meta.capabilities;
  if (!isPlainObject(capabilities)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * The capability keys every reporting upstream model agrees on -- that shared part
 * is Open WebUI's "default model metadata" template, merged into each model.
 *
 * Keys the models disagree about (or that only some of them report) are left out; a
 * model's own value for those is published as a deviation under that model's
 * `x_open_webui`. Reporting the template once, as an instance-level fact, is honest;
 * repeating it inside each model's `capabilities` would claim something about the
 * model that is not true -- the same template was also handed to the model that
 * answers an image with "is not a multimodal model".
 *
 * 上游每个上报能力的模型都一致同意的那些键——这部分共同值就是 Open WebUI 合并进每个
 * 模型的"默认模型元数据"模板。
 *
 * 各模型不一致（或只有部分模型上报）的键不纳入模板；某个模型对这些键自己的取值，
 * 作为"偏离"放在该模型的 `x_open_webui` 里。把模板作为实例级事实输出一次是诚实的；
 * 重复放进每个模型的 `capabilities` 则是在声称模型具备它并不具备的能力。
 */
export function sharedDefaultCapabilities(
  rawModels: readonly unknown[],
): Record<string, boolean> | null {
  const reported = rawModels
    .map((raw) => rawModelCapabilities(raw))
    .filter((capabilities) => Object.keys(capabilities).length > 0);
  if (reported.length === 0) return null;

  const template: Record<string, boolean> = {};
  for (const key of Object.keys(reported[0])) {
    // A key qualifies only when every reporting model carries it with the same
    // value; a model that omits it disqualifies the key.
    //
    // 只有当每个上报模型都携带该键且取值一致时，该键才进入模板；有模型没上报就不算。
    const values = reported.map((capabilities) => capabilities[key]);
    const first = values[0];
    if (first !== undefined && values.every((value) => value === first)) {
      template[key] = first;
    }
  }
  return Object.keys(template).length > 0 ? template : null;
}

/**
 * A cheap identity for "the engine serving this model", derived purely from the
 * model list so checking it costs no request.
 *
 * Deliberately excludes the top-level `created`: vLLM rebuilds its model card for
 * every response and stamps it with the current time, so it changes on every fetch
 * (verified upstream: 1789036467 then 1789036470 three seconds later) -- including
 * it would mean the cache never hits.
 *
 * The JSON is assembled with Python's `json.dumps(..., sort_keys=True)` separators
 * so that a model yields the same fingerprint in this project and in the Python
 * one; integral numbers are emitted without a trailing ".0", which is the only
 * divergence (and only for float-typed upstream fields).
 *
 * 仅从模型列表推导出的"服务该模型的引擎"廉价标识，检查它不需要任何请求。
 *
 * 刻意排除顶层 `created`：vLLM 每次响应都会重建模型卡并打上当前时间，因此它每次
 * 拉取都会变（上游实测：1789036467，三秒后 1789036470）——放进去会导致缓存永不命中。
 *
 * JSON 采用 Python `json.dumps(..., sort_keys=True)` 的分隔符拼装，使同一模型在本
 * 项目与 Python 项目中得到相同的指纹；整数不带 ".0" 输出，这是唯一的差异（且只影响
 * 上游把该字段发成浮点数的情况）。
 */
export async function modelFingerprint(raw: unknown, modelId: string): Promise<string> {
  if (!isPlainObject(raw)) return "";
  const info = isPlainObject(raw.info) ? raw.info : {};
  const engine = isPlainObject(raw.openai) ? raw.openai : {};
  const identity: Record<string, unknown> = {
    id: modelId,
    root: engine.root || raw.root || "",
    // `??`, not `||`: 0 is a legal boundary value, and `||` would drop it -- which
    // would make this fingerprint differ from the Python one, and a drifting
    // fingerprint looks exactly like "the engine was swapped" (a full re-probe).
    //
    // 用 `??` 而不是 `||`：0 是合法边界值，`||` 会把它丢掉——这会让指纹与 Python 侧
    // 不一致，而指纹漂移在行为上等同于"引擎被换掉了"（触发全量重探）。
    max_model_len: raw.max_model_len ?? engine.max_model_len ?? null,
    owned_by: engine.owned_by || raw.owned_by || "",
    base_model_id: info.base_model_id ?? null,
    updated_at: info.updated_at ?? null,
  };
  const encoded = pythonStyleJson(identity);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Collapse an upstream model object into the OpenAI model structure.
 *
 * Standard fields stay intact; a whitelist of safe, useful extras is preserved when
 * present: name, description, max_model_len (kept for compatibility) plus
 * max_context_length and context_length, quantization (parsed from the model id),
 * and `x_open_webui.capabilities` carrying the model's DEVIATIONS from the shared
 * template. Private upstream fields (user_id, access_grants, permission, urlIdx,
 * ...) are never exposed.
 *
 * 把上游的模型对象收敛成 OpenAI 的 model 结构。
 *
 * 标准字段原样保留，另有一份白名单在存在时透出安全且有用的扩展字段：name、
 * description、max_model_len（兼容保留）+ max_context_length/context_length、
 * quantization（从模型名解析）、以及 `x_open_webui.capabilities`（该模型相对共享
 * 模板的**偏离**）。上游私有字段（user_id、access_grants、permission、urlIdx 等）
 * 一律不透出。
 */
export function normalizeModel(
  raw: unknown,
  sharedCapabilities?: Record<string, boolean> | null,
): Record<string, unknown> | null {
  if (typeof raw === "string") {
    return { id: raw, object: "model", created: 0, owned_by: "openai" };
  }
  if (!isPlainObject(raw)) return null;

  const modelId = raw.id ?? raw.name ?? raw.model;
  if (modelId === null || modelId === undefined || modelId === "") return null;

  const info = isPlainObject(raw.info) ? raw.info : {};
  const meta = isPlainObject(info.meta) ? info.meta : {};
  const engine = isPlainObject(raw.openai) ? raw.openai : {};

  // info.created_at is the model's real creation time; the "created" on the OpenAI
  // layer is the serving engine's start time, not the model's.
  //
  // info.created_at 才是模型真实创建时间；OpenAI 层的 created 是推理引擎的启动
  // 时间，并非模型本身的。
  const rawCreated = info.created_at ?? raw.created ?? raw.created_at;
  const createdNumber = Math.trunc(Number(rawCreated));
  const created = Number.isFinite(createdNumber) ? createdNumber : 0;

  // Prefer the inner engine attribution (e.g. "vllm") over the OpenAI-layer default.
  // 优先取内层引擎归属（如 "vllm"），而非 OpenAI 层的默认值。
  const ownedBy = engine.owned_by || raw.owned_by || "openai";

  const model: Record<string, unknown> = {
    id: String(modelId),
    object: "model",
    created,
    owned_by: String(ownedBy),
  };

  // Human-readable name. Upstream keeps it separate from the id (workspace models
  // use a uuid as id and a friendly name here), and every mainstream provider that
  // publishes a list of models publishes one too.
  //
  // 人类可读的名称。上游把它与 id 分开保存（workspace 模型用 uuid 作 id，友好名放在
  // 这里），而所有会输出模型列表的主流供应商也都会输出这个字段。
  const name = raw.name || info.name;
  if (name) model.name = String(name);

  // Generic-template field names; max_model_len stays as a compatibility alias.
  // `??` keeps a legal 0 (the empty-string guard below still skips blanks).
  //
  // 通用模板字段名；max_model_len 作为兼容别名保留。
  // 用 `??` 保留合法的 0（下面的空串判断依然会跳过空白值）。
  const rawLength = raw.max_model_len ?? engine.max_model_len;
  const contextLength = Math.trunc(Number(rawLength));
  if (rawLength !== null && rawLength !== undefined && rawLength !== "" && Number.isFinite(contextLength)) {
    model.max_model_len = contextLength;
    model.max_context_length = contextLength;
    model.context_length = contextLength;
  }

  // Quantization is not a dedicated upstream field; parse it from the model id
  // (e.g. "GLM-5.2-NVFP4" -> "NVFP4"). Omitted when nothing matches.
  //
  // 量化信息不是上游的独立字段，从模型名解析（如 "GLM-5.2-NVFP4" -> "NVFP4"）。
  // 匹配不到时不输出该字段。
  const quantMatch = QUANT_PATTERN.exec(String(modelId));
  if (quantMatch) model.quantization = quantMatch[1].toUpperCase();

  const description = meta.description;
  if (description) model.description = String(description);

  const ownCapabilities = rawModelCapabilities(raw);
  const template = sharedCapabilities ?? {};
  const deviation: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(ownCapabilities)) {
    if (template[key] !== value) deviation[key] = value;
  }
  if (Object.keys(deviation).length > 0) {
    // Open WebUI hands the deployment-wide template to every model, so a model that
    // deviates from it is worth keeping -- but under the instance namespace, never
    // inside `capabilities`, which holds probed facts only.
    //
    // Open WebUI 把同一份部署级模板发给每个模型，因此偏离模板的模型值得保留——但放在
    // 实例命名空间下，绝不放进只承载实证事实的 `capabilities`。
    model.x_open_webui = { capabilities: deviation };
  }

  return model;
}

// --------------------------------------------------------------------------- //
// Helpers
// 小工具
// --------------------------------------------------------------------------- //

/** JSON with Python's default separators and sorted keys, so hashes line up. */
/** 使用 Python 默认分隔符并按 key 排序的 JSON，使哈希结果对齐。 */
function pythonStyleJson(record: Record<string, unknown>): string {
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${formatValue(record[key])}`);
  return `{${parts.join(", ")}}`;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  // Python's `default=str` renders anything else as its string form.
  return JSON.stringify(String(value));
}
