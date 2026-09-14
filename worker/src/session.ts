/**
 * Shared upstream-request helpers.
 *
 * sessionHeaders builds the headers used to authenticate against the
 * Open WebUI upstream from the captured session credentials.
 *
 * This module is also the single home of the "how long may an upstream request take"
 * policy: every request this Worker sends upstream goes through `fetchUpstream`, so
 * a hung upstream can never pin a Worker request open indefinitely. The only
 * difference between the paths is which ceiling applies -- see the two constants
 * below.
 *
 * 上游请求公共辅助函数。
 *
 * sessionHeaders 根据捕获的会话凭证，构造用于向 Open WebUI 上游鉴权的请求头。
 *
 * 本模块同时是"一次上游请求最多等多久"这条策略的唯一归属地：本 Worker 发往上游的每个
 * 请求都经过 `fetchUpstream`，因此上游卡死时绝不会把 Worker 请求永久挂住。各路径的
 * 唯一区别是适用哪个上限——见下面两个常量。
 */

import type { StoredSession } from "./types.ts";

/**
 * Auth + identity headers shared by EVERY upstream call: the captured User-Agent
 * (impersonating the logged-in browser) plus the credentials. NO Accept or
 * Content-Type here — those are endpoint-specific, and pinning them on the
 * catch-all passthrough broke every non-JSON upload/download (the JSON
 * Content-Type overwrote the client's multipart; a `request.text()` round-trip
 * additionally mangled binary bodies — see buildUpstreamHeaders in proxy.ts).
 *
 * 所有上游调用共享的鉴权 + 身份头：捕获的 User-Agent（模拟登录浏览器）与凭证。
 * 这里**不含** Accept / Content-Type——它们是端点相关的；把它们钉在兜底透传上
 * 曾破坏一切非 JSON 的上传/下载（JSON Content-Type 覆盖了客户端的 multipart，
 * 经 request.text() 的往返还会破坏二进制 body——见 proxy.ts 的
 * buildUpstreamHeaders）。
 */
export function sessionAuthHeaders(session: StoredSession): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": session.user_agent || "open-webui-to-openai-api-worker",
  };
  if (session.authorization) headers.Authorization = session.authorization;
  if (session.cookie) headers.Cookie = session.cookie;
  return headers;
}

/** Auth headers plus JSON content negotiation, for the JSON-speaking endpoints. */
/** 鉴权头 + JSON 内容协商，供以 JSON 通信的端点使用。 */
export function sessionHeaders(session: StoredSession): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...sessionAuthHeaders(session),
  };
}

/**
 * A session is usable if it carries a non-empty Authorization or Cookie.
 *
 * Lives here rather than in each caller: the proxy, the admin API and the
 * coordinator all ask the same question of the same stored shape, and a diverging
 * copy would let one of them keep talking to a dead upstream.
 *
 * session 携带非空 Authorization 或 Cookie 即视为可用。
 *
 * 放在这里而不是各调用方：代理、管理 API 与协调者对同一种存储形状问的是同一个问题，
 * 而一份出现差异的副本会让其中一处继续对着无效凭证说话。
 */
export function sessionIsUsable(session: StoredSession): boolean {
  return Boolean(
    (session.authorization && session.authorization.trim()) ||
      (session.cookie && session.cookie.trim()),
  );
}

/**
 * Ceiling for an upstream request that must produce a body (ms).
 *
 * Generous on purpose: a non-streaming completion may legitimately take minutes, and
 * cutting it off early would turn a slow answer into an error. It exists only so that
 * an upstream which accepts the connection and then never answers cannot hold the
 * Worker request open forever.
 *
 * 需要产出响应体的上游请求的上限（毫秒）。
 *
 * 刻意给得宽松：非流式补全耗时数分钟是合理的，过早切断会把"慢"变成"错"。它存在的
 * 唯一目的，是让"接了连接却永不答复"的上游无法永久占住 Worker 请求。
 */
export const UPSTREAM_TIMEOUT_MS = 300_000;

/**
 * Ceiling for an upstream metadata request (ms): the model list and the prefix probes
 * that run in front of every proxy request and every round.
 *
 * Those answers are small and immediate, and the prefix probe runs once per proxy
 * request, so the generous body ceiling above would be the wrong trade here: an
 * unusable upstream should fail fast instead of hanging the whole request.
 *
 * 上游元信息请求的上限（毫秒）：模型列表，以及每个代理请求、每一轮探测之前都会跑的前缀探测。
 *
 * 这些答复又小又快，而前缀探测每个代理请求都会跑一次，因此上面那个宽松的"响应体上限"
 * 在这里是错误的取舍：不可用的上游应当快速失败，而不是把整个请求挂住。
 */
export const UPSTREAM_METADATA_TIMEOUT_MS = 15_000;

/** Whether the upstream call must be allowed to stream for an unbounded time. */
/** 该上游调用是否必须允许无限期地流式传输。 */
export interface UpstreamFetchOptions {
  /** Use the metadata ceiling instead of the body ceiling. */
  /** 使用元信息上限，而不是响应体上限。 */
  metadata?: boolean;
  /**
   * Whether the caller will stream the response body.
   *
   * A plain `AbortSignal.timeout` would abort the WHOLE stream at the deadline, so a
   * long answer would be cut off mid-sentence. For streaming calls only the wait for
   * the response HEADERS is bounded: the timer is cleared as soon as `fetch` resolves,
   * and the body is never aborted afterwards.
   *
   * 调用方是否会流式传输响应体。
   *
   * 直接用 `AbortSignal.timeout` 会在截止时刻中断**整个流**，长回答会被拦腰截断。对流式
   * 调用只限制"等待响应头"的时间：`fetch` 一返回就清除定时器，之后绝不再中断响应体。
   */
  stream?: boolean;
  /** Override the ceiling (tests use a short one). */
  /** 覆盖上限（测试用短值）。 */
  timeoutMs?: number;
}

/**
 * `fetch` towards the upstream with a bounded wait.
 *
 * Throws whatever `fetch` throws (including the abort error when the ceiling is
 * reached); callers already map that to their own error shape.
 *
 * Note on the non-streaming path: `AbortSignal.timeout` bounds the WHOLE exchange —
 * headers AND body reads. A response whose body is still arriving when the ceiling
 * hits is cut off mid-read. The body ceiling is deliberately generous (300s), but
 * this is a real cutoff, unlike the streaming path below which bounds only the
 * wait for the response headers.
 *
 * 带上限地向上游发起 `fetch`。
 *
 * `fetch` 抛什么就抛什么（包括到达上限时的中止错误）；各调用方已把它映射成自己的
 * 错误形状。
 *
 * 关于非流式路径的说明：`AbortSignal.timeout` 限定的是整个交换过程——响应头**与**
 * 响应体的读取。到达上限时仍在传输的响应体会被拦腰切断。响应体上限刻意给得宽松
 * （300 秒），但这是一次真实的切断，与下方只限定"等待响应头"的流式路径不同。
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit = {},
  options: UpstreamFetchOptions = {},
): Promise<Response> {
  const timeoutMs =
    options.timeoutMs ?? (options.metadata ? UPSTREAM_METADATA_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS);

  if (!options.stream) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  // Streaming: bound only the wait for the response headers, then hand the untouched
  // body to the caller.
  //
  // 流式：只限制等待响应头的时间，随后把未经触碰的响应体交给调用方。
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("upstream did not answer within the header timeout"));
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
