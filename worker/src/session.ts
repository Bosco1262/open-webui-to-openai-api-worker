/**
 * Shared upstream-request helpers.
 *
 * sessionHeaders builds the headers used to authenticate against the
 * Open WebUI upstream from the captured session credentials.
 * 
 * 上游请求公共辅助函数。
 * 
 * sessionHeaders 根据捕获的会话凭证，构造用于向 Open WebUI 上游鉴权的请求头。
 */

import type { StoredSession } from "./types";

/** Request headers to carry the Open WebUI credentials upstream. */
/** 携带 Open WebUI 凭证发往上游的请求头。 */
export function sessionHeaders(session: StoredSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": session.user_agent || "open-webui-to-openai-api-worker",
  };
  if (session.authorization) headers.Authorization = session.authorization;
  if (session.cookie) headers.Cookie = session.cookie;
  return headers;
}
