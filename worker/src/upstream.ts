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

import { looksLikeModelList } from "./modelCatalog.ts";

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
