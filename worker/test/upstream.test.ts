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
 *
 * The same module owns the other half of that rule: when a remembered prefix must be
 * forgotten (`shouldForgetPrefixAfterModels`). A 401/403 answers "the route is here,
 * the session is dead", so it must NOT count as "the prefix is wrong".
 *
 * 同一模块也承载这条规则的另一半：已记忆的前缀何时必须被遗忘
 * （`shouldForgetPrefixAfterModels`）。401/403 的答复是"路由在、会话死"，因此绝不能算作
 * "前缀错了"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionIsUsable } from "../src/session.ts";
import {
  AUTH_FAILURE_CODES,
  PREFIX_CANDIDATES,
  confirmUpstreamPrefix,
  shouldForgetPrefixAfterModels,
} from "../src/upstream.ts";
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
// When a /models answer makes the remembered prefix wrong
// /models 的答复在什么情况下说明"已记忆的前缀是错的"
// --------------------------------------------------------------------------- //

test("only an answer that says 'not here' forgets the remembered prefix", () => {
  const modelList = { object: "list", data: [{ id: "a" }] };

  // The route answered -- keep what we know.
  // 路由应答了——保留已知信息。
  assert.equal(shouldForgetPrefixAfterModels(200, modelList), false);
  assert.equal(shouldForgetPrefixAfterModels(200, { items: [] }), false, "an empty list is still a list");

  // THE regression this pins: 401/403 means the route EXISTS and the session is dead.
  // Forgetting the prefix here made every later round re-run the whole candidate sweep
  // (1-2 extra subrequests each time) just to re-learn it -- the proxy's `detectPrefix`
  // keeps its cached prefix on exactly this answer.
  //
  // 这里钉住的回归：401/403 意味着路由**存在**、会话已死。此前在这里遗忘前缀，会让此后
  // 每一轮都要重跑完整候选探测（每次多 1-2 个子请求）只为重新得知这件事——而代理侧的
  // `detectPrefix` 正是在这同一种答复上保留缓存前缀。
  assert.equal(shouldForgetPrefixAfterModels(401, null), false);
  assert.equal(shouldForgetPrefixAfterModels(403, null), false);

  // The SPA's "200 + HTML" page: this prefix does not serve /models.
  // SPA 的 "200 + HTML"：这个前缀不提供 /models。
  assert.equal(shouldForgetPrefixAfterModels(200, null), true, "unreadable body");
  assert.equal(shouldForgetPrefixAfterModels(200, { detail: "Not Found" }), true, "someone else's 200");

  // No route as far as we can tell -- re-derive from scratch next round.
  // 可判断的范围内"路由不存在"——下一轮从头重新推导。
  assert.equal(shouldForgetPrefixAfterModels(404, null), true);
  assert.equal(shouldForgetPrefixAfterModels(500, null), true);
  assert.equal(shouldForgetPrefixAfterModels(503, null), true);
  assert.equal(shouldForgetPrefixAfterModels(0, null), true, "a filtered/opaque answer proves nothing");
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
