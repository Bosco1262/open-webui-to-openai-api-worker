/**
 * Prefix-confirmation tests: what counts as "this upstream prefix is correct".
 *
 * Three call sites (the proxy's `detectPrefix`, the admin connectivity test and the
 * coordinator's `resolvePrefix`) used to answer "anything but a 404", which accepts the
 * SPA's 200 + HTML page and every temporary 5xx. These tests pin the shared rule and,
 * just as importantly, that it is shared: the constants live in one module.
 *
 * 前缀确认测试："这个上游前缀是对的"到底由什么决定。
 *
 * 三个调用方（代理的 `detectPrefix`、管理端连通性测试、协调者的 `resolvePrefix`）此前都
 * 按"不是 404 就算对"来回答，而这会接受 SPA 的 200 + HTML 与任何临时 5xx。下面的用例钉住
 * 这条共用规则——以及同样重要的"它确实是共用的"：常量只存在于一个模块里。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionIsUsable } from "../src/session.ts";
import { AUTH_FAILURE_CODES, PREFIX_CANDIDATES, confirmUpstreamPrefix } from "../src/upstream.ts";
import type { PrefixProbeAnswer } from "../src/upstream.ts";

const MODEL_LIST: PrefixProbeAnswer = {
  status: 200,
  contentType: "application/json",
  text: JSON.stringify({ object: "list", data: [{ id: "a" }] }),
};

const HTML_PAGE: PrefixProbeAnswer = {
  status: 200,
  contentType: "text/html",
  text: "<!doctype html><html><body>SPA</body></html>",
};

function status(code: number): PrefixProbeAnswer {
  return { status: code, contentType: "application/json", text: `{"detail":${code}}` };
}

/** A probe driven by a table, recording the prefixes it was asked about in order. */
function probeFrom(table: Record<string, PrefixProbeAnswer | Error>): {
  probe: (prefix: string) => Promise<PrefixProbeAnswer>;
  probed: string[];
} {
  const probed: string[] = [];
  return {
    probed,
    probe: async (prefix: string): Promise<PrefixProbeAnswer> => {
      probed.push(prefix);
      const answer = table[prefix];
      if (!answer) return status(404);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("the candidates and the auth-failure codes have one definition", () => {
  // Every caller imports these instead of inlining its own copy -- three copies is how
  // the "not a 404" bug survived in the first place.
  //
  // 所有调用方都导入它们，而不是各写一份——三份副本正是"不是 404"这个 bug 能活下来的
  // 原因。
  assert.deepEqual([...PREFIX_CANDIDATES], ["/api/v1", "/api"]);
  assert.deepEqual([...AUTH_FAILURE_CODES], [401, 403]);
});

test("the first candidate that really is a model list wins", async () => {
  const { probe, probed } = probeFrom({ "/api/v1": HTML_PAGE, "/api": MODEL_LIST });
  const confirmed = await confirmUpstreamPrefix(PREFIX_CANDIDATES, probe);
  assert.deepEqual(confirmed, { prefix: "/api", status: 200, authFailure: false });
  assert.deepEqual(probed, ["/api/v1", "/api"]);
});

test("a 5xx is not a confirmation, and neither is a 404", async () => {
  const { probe, probed } = probeFrom({ "/api/v1": status(500), "/api": status(404) });
  assert.equal(await confirmUpstreamPrefix(PREFIX_CANDIDATES, probe), null);
  assert.deepEqual(probed, ["/api/v1", "/api"]);
});

test("dead credentials confirm the ROUTE but are flagged as an auth failure", async () => {
  const { probe, probed } = probeFrom({ "/api/v1": status(401) });
  const confirmed = await confirmUpstreamPrefix(PREFIX_CANDIDATES, probe);
  assert.deepEqual(confirmed, { prefix: "/api/v1", status: 401, authFailure: true });
  // Nothing more to learn: the route exists, the session is dead.
  // 没有更多可查的：路由存在，会话已死。
  assert.deepEqual(probed, ["/api/v1"]);
});

test("a 403 is an auth failure too, and the search stops there", async () => {
  const { probe, probed } = probeFrom({ "/api/v1": status(403), "/api": MODEL_LIST });
  const confirmed = await confirmUpstreamPrefix(PREFIX_CANDIDATES, probe);
  assert.equal(confirmed?.authFailure, true);
  assert.deepEqual(probed, ["/api/v1"]);
});

test("a transport failure propagates so callers can tell it apart from 'not confirmed'", async () => {
  // The proxy answers a network error differently from "no prefix worked", and the
  // admin test reports it as a connectivity problem -- neither is possible if this is
  // swallowed into a null.
  //
  // 代理对网络错误的答复与"没有前缀可用"不同，管理端测试把它报成连通性故障——若在这里
  // 被吞成 null，两者都不可能。
  const { probe } = probeFrom({ "/api/v1": new Error("connection refused") });
  await assert.rejects(() => confirmUpstreamPrefix(PREFIX_CANDIDATES, probe), /connection refused/);
});

// --------------------------------------------------------------------------- //
// Session usability (one definition, shared by proxy / admin / coordinator)
// --------------------------------------------------------------------------- //

test("a session needs credentials: a blank or missing pair is unusable", () => {
  const base = { user_agent: "", captured_at: 0, base_url: "https://x.test" };
  assert.equal(sessionIsUsable({ ...base, authorization: "Bearer t", cookie: "" }), true);
  assert.equal(sessionIsUsable({ ...base, authorization: "", cookie: "token=abc" }), true);
  assert.equal(sessionIsUsable({ ...base, authorization: "   ", cookie: "\t" }), false);
  assert.equal(sessionIsUsable({ ...base, authorization: "", cookie: "" }), false);
});
