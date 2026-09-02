/**
 * Shared upstream-request helpers.
 *
 * sessionHeaders builds the headers used to authenticate against the
 * Open WebUI upstream from the captured session credentials.
 */

import type { StoredSession } from "./types";

/** Request headers to carry the Open WebUI credentials upstream. */
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
