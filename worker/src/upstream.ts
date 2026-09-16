/**
 * What "this upstream prefix is correct" means, and how the candidates are tried.
 *
 * Three call sites ask that question -- the proxy's `detectPrefix`, the admin
 * connectivity test and the coordinator's `resolvePrefix` -- and all three used to
 * answer "anything but a 404". That is wrong: an unknown route under the modern
 * prefix falls through to the SPA, which answers **200 with an HTML page**, and a
 * temporary 5xx says nothing about the route at all. Either answer would be cached as
 * "the prefix works" and every later request would be sent to a route that does not
 * exist.
 *
 * So the question is settled here, once: a prefix is confirmed when the response
 * either proves the route exists with dead credentials (401/403), or actually reads
 * as a model list (`looksLikeModelList`). Everything else -- HTML behind a 200, any
 * 5xx, an unreadable body -- is "not confirmed", and the loop moves on.
 *
 * 什么算"上游前缀确定是对的"，以及如何逐个尝试候选前缀。
 *
 * 有三个调用方要回答这个问题——代理的 `detectPrefix`、管理端连通性测试与协调者的
 * `resolvePrefix`——而它们此前都按"不是 404 就算对"来回答。这是错的：现代前缀下的未知
 * 路由会落到 SPA 上，由 SPA 回 **200 + 一页 HTML**；临时 5xx 则完全说明不了路由是否
 * 存在。两种答复都会被缓存成"该前缀可用"，此后每个请求都打到不存在的路由上。
 *
 * 因此这个问题在这里一次性解决：当响应要么以"凭证失效"证明路由存在（401/403），要么
 * 确实能读成模型列表（`looksLikeModelList`）时，该前缀才算确认。其余情况——200 背后是
 * HTML、任何 5xx、读不懂的响应体——都算"未确认"，循环继续。
 */

import { isModelListPayload, looksLikeModelList } from "./modelCatalog.ts";

/** Upstream prefixes in probe priority order (Open WebUI >= 0.6 vs legacy). */
/** 上游前缀探测优先级顺序（Open WebUI >= 0.6 与旧版本）。 */
export const PREFIX_CANDIDATES: readonly string[] = ["/api/v1", "/api"];

/** Upstream returning these means the credentials are dead -- but the route exists.
 *  Kept in one place so "what counts as a dead credential" has a single definition. */
/** 上游返回这些状态码说明凭证已失效——但路由是存在的。集中在一处，使"什么算凭证失效"
 *  只有一个定义。 */
export const AUTH_FAILURE_CODES: readonly number[] = [401, 403];

/** One candidate's answer, reduced to what the decision needs. */
/** 单个候选前缀的答复，收敛为判定所需的内容。 */
export interface PrefixProbeAnswer {
  status: number;
  /** Response `content-type`, used to reject the SPA's HTML page. */
  /** 响应的 `content-type`，用于排除 SPA 的 HTML 页面。 */
  contentType: string | null;
  /** Response body as text. */
  /** 以文本形式读取的响应体。 */
  text: string;
}

/** A confirmed prefix and why it was confirmed. */
/** 已确认的前缀，以及确认的原因。 */
export interface ConfirmedPrefix {
  prefix: string;
  status: number;
  /**
   * True when the confirmation is an authentication failure rather than a readable
   * model list: the route exists, but the credentials are dead. Callers must not
   * treat this as a working connection.
   *
   * 为 true 时表示确认来自"凭证失效"而非可读的模型列表：路由存在，但凭证已死。调用方
   * 不得把它当成连接可用。
   */
  authFailure: boolean;
}

/**
 * Try the candidate prefixes in order and return the first one that can be confirmed,
 * or null when none can.
 *
 * The probe callback issues the request and reads the body (each caller builds its own
 * headers and applies its own timeout); it may throw, and the exception propagates so
 * the caller can distinguish "could not connect" from "connected but not confirmed".
 *
 * 按顺序尝试候选前缀，返回第一个能被确认的前缀；一个都确认不了时返回 null。
 *
 * 探测回调负责发请求并读取响应体（各调用方自己构造请求头、自己施加超时）；它可以抛出，
 * 异常会向外传播，使调用方能区分"连不上"与"连上了但无法确认"。
 */
export async function confirmUpstreamPrefix(
  candidates: readonly string[],
  probe: (prefix: string) => Promise<PrefixProbeAnswer>,
): Promise<ConfirmedPrefix | null> {
  for (const prefix of candidates) {
    const answer = await probe(prefix);
    if (AUTH_FAILURE_CODES.includes(answer.status)) {
      return { prefix, status: answer.status, authFailure: true };
    }
    if (looksLikeModelList(answer.status, answer.contentType, answer.text)) {
      return { prefix, status: answer.status, authFailure: false };
    }
    // Not confirmed: a 200 carrying the SPA's HTML page, a 5xx, a body we cannot read.
    // The status code alone proves nothing, so keep looking.
    //
    // 未确认：200 但带的是 SPA 的 HTML 页面、5xx、或读不懂的响应体。只看状态码什么都
    // 证明不了，继续试下一个。
  }
  return null;
}

/**
 * Whether a `/models` answer is evidence that the REMEMBERED prefix must be forgotten.
 *
 * The rule is the same one `confirmUpstreamPrefix` applies, seen from the other side: an
 * answer is evidence about the ROUTE, and only "this route is not here" justifies
 * throwing away what we know.
 *
 *   - 401/403: the route exists and the credentials were rejected -- KEEP the prefix.
 *     Forgetting it here would send every later round through the whole candidate sweep
 *     (1-2 extra subrequests each time) to re-learn what this very answer already said.
 *     The proxy's `detectPrefix` keeps its cached prefix on exactly this answer.
 *   - 200: the route answered; forget only when the body is not a model list, i.e. the
 *     SPA's "200 + HTML" page -- that prefix does not serve `/models`.
 *   - anything else (404, 5xx, an unexpected status): no route as far as we can tell, so
 *     forget it and let the next round re-derive the prefix from scratch. The cost is
 *     1-2 subrequests per round while the upstream misbehaves; the benefit is that a
 *     routing change hiding behind a 5xx cannot pin the coordinator forever.
 *
 * 某个 `/models` 答复是否构成"必须遗忘已记忆前缀"的证据。
 *
 * 规则与 `confirmUpstreamPrefix` 是同一条，只是从另一侧看：答复是关于**路由**的证据，
 * 而只有"这条路由不在这里"才构成丢弃已知信息的理由。
 *
 *   - 401/403：路由存在、凭证被拒——**保留**前缀。在这里遗忘会让此后每一轮都跑完整轮
 *     候选探测（每次多 1-2 个子请求），只为重新得知这个答复本身已经说明的事。代理的
 *     `detectPrefix` 正是在这同一种答复上保留缓存前缀。
 *   - 200：路由应答了；只有响应体不是模型列表（即 SPA 的 "200 + 一页 HTML"）才遗忘——
 *     那个前缀不提供 `/models`。
 *   - 其余（404、5xx、意外状态）：可判断的范围内"路由不存在"，遗忘它，让下一轮从头重新
 *     推导前缀。上游异常期间每轮多花 1-2 个子请求；换来的是"藏在 5xx 背后的路由迁移"
 *     不会把协调者永久钉死。
 */
export function shouldForgetPrefixAfterModels(status: number, payload: unknown): boolean {
  if (AUTH_FAILURE_CODES.includes(status)) return false;
  if (status === 200) return !isModelListPayload(payload);
  return true;
}

// --------------------------------------------------------------------------- //
// Upstream base URL policy
// 上游根地址策略
// --------------------------------------------------------------------------- //

/** Why a candidate `base_url` was refused. Stable codes, for the UI's i18n layer. */
/** 候选 `base_url` 被拒绝的原因。稳定错误码，供 UI 的 i18n 层使用。 */
export type UpstreamUrlRejection = "not_a_url" | "https_required" | "forbidden_host";

/**
 * Whether a literal host is loopback: the documented mock-rehearsal case, and the
 * only place an `http://` upstream is allowed.
 *
 * 字面主机是否为回环地址：文档化的 mock 彩排场景，也是唯一允许 `http://` 上游的地方。
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  // "::ffff:127.0.0.1" — an IPv4-mapped loopback address.
  // "::ffff:127.0.0.1" —— IPv4 映射形式的回环地址。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return isLoopbackHost(mapped[1]);
  const v4 = parseIpv4(host);
  return v4 !== null && v4[0] === 127;
}

function parseIpv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1, 5).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

/**
 * Whether a literal host must never be dialled from here.
 *
 * The Worker is the one making the request, so a private, link-local or cloud
 * metadata address turns "the operator imported a session" into a request forgery
 * primitive aimed at whatever the Worker can reach. Cloudflare blocks much of this
 * at the platform level, but the check belongs here too: it is the only place that
 * also covers the literal-IP and odd-port forms the platform may still allow, and
 * it turns a mysterious timeout into a clear message at import time.
 *
 * 字面主机是否绝不允许从本处拨出。
 *
 * 发起请求的是 Worker，因此一个私网、链路本地或云元数据地址会把"运维导入了 session"
 * 变成一件指向"Worker 能触达的一切"的请求伪造工具。Cloudflare 在平台层已挡住大部分，
 * 但这道检查仍应在这里：只有这里能覆盖平台可能仍放行的"字面 IP + 异常端口"形式，并且
 * 它把一次莫名的超时变成导入时刻的明确提示。
 */
function isForbiddenLiteralHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Known metadata service names. (Their literal IPv4 counterparts are covered by the
  // link-local range below.)
  //
  // 已知的元数据服务主机名。（它们对应的字面 IPv4 由下面的链路本地网段覆盖。）
  if (host === "metadata.google.internal" || host === "metadata") return true;
  const v4 = parseIpv4(host);
  if (v4 !== null) {
    const [a, b] = v4;
    if (a === 0) return true; // "this network" / unroutable
    if (a === 10) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    return a >= 224; // multicast / reserved
  }
  if (!host.includes(":")) return false;
  // IPv6 literals: unique-local (fc00::/7), link-local (fe80::/10), unspecified (::),
  // and the metadata address fd00:ec2::254 — the last is covered by the ULA range.
  //
  // IPv6 字面量：唯一本地（fc00::/7）、链路本地（fe80::/10）、未指定（::），以及
  // 元数据地址 fd00:ec2::254——最后一个已被 ULA 网段覆盖。
  if (host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return isForbiddenLiteralHost(mapped[1]);
  return false;
}

/**
 * Validate a candidate upstream root URL.
 *
 * Policy (operator decision): HTTPS only, with a loopback exception so the documented
 * local mock rehearsal keeps working. An `http://` upstream would put the imported
 * JWT and cookies on the wire in cleartext — the single most direct way to lose the
 * account — and an automatic redirect would hand the same credentials to whatever host
 * the upstream (or a hijacked CDN in front of it) points at next.
 *
 * 校验候选上游根地址。
 *
 * 策略（运维决策）：仅 HTTPS，另设回环例外以保留文档化的本地 mock 彩排。`http://` 上游
 * 会把导入的 JWT 与 Cookie 以明文送上网线——这是丢掉账号最直接的一条路；而自动跟随重定向
 * 会把同样的凭证交给上游（或它前面被接管的 CDN）指向的下一个主机。
 */
export function checkUpstreamBaseUrl(raw: string): { ok: boolean; reason: UpstreamUrlRejection | null } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (!parsed.hostname) return { ok: false, reason: "not_a_url" };
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return { ok: false, reason: "https_required" };
  }
  // Loopback keeps its arbitrary port (the mock listens on 8799); everything else is
  // pinned to the standard web port.
  //
  // 回环地址保留任意端口（mock 监听在 8799）；其余一律钉在标准 Web 端口上。
  if (!loopback && parsed.port !== "" && parsed.port !== "443") {
    return { ok: false, reason: "forbidden_host" };
  }
  if (isForbiddenLiteralHost(parsed.hostname)) {
    return { ok: false, reason: "forbidden_host" };
  }
  return { ok: true, reason: null };
}
