/**
 * Contract tests for the `/v1/*` catch-all passthrough: the allowlist and the path
 * normalization that runs in front of it.
 *
 * The property under test is the one the upstream fix exists to establish (H1): the
 * value that is CHECKED against the allowlist and the value that is FORWARDED are the
 * same string, and it never carries a parent segment -- so the next decoder's
 * dot-segment removal cannot resolve it to a route the allowlist withholds.
 *
 * `/v1/*` 兜底透传的契约测试：白名单，以及它前面的路径归一化。
 *
 * 被测的性质正是上游那处修复要确立的性质（H1）：送进白名单**判定**的值与真正被**转发**
 * 的值是同一个字符串，且它永远不含父段——因此下一个解码者的点段移除无法把它解析成白名单
 * 本要挡住的路由。
 *
 * Contract anchors (docs/UPSTREAM-CONTRACTS.zh-CN.md):
 *   #15 透传路径归一化与白名单  upstream/config.py:87-132, upstream/config.py:457-487,
 *                              upstream/app.py:1245-1265
 *   #1  H1 用例组（等价于本文件的中段）  upstream/tests/test_units.py:2385-2434
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { handleV1Request } from "../src/proxy.ts";
import {
  isPassthroughAllowed,
  normalizePassthroughPath,
  targetStaysWithinAllowlist,
} from "../src/passthrough.ts";
import { putApiKey, setSession } from "../src/kv.ts";
import type { Env } from "../src/types.ts";

// --------------------------------------------------------------------------- //
// Unit: normalization and the allowlist
// 单元：归一化与白名单
// --------------------------------------------------------------------------- //

test("contract with upstream/config.py:87-132 — a parent segment is refused in every spelling", () => {
  // The literal form never reaches here through the URL parser (it folds dot segments
  // before this module sees the path), but the function is the LAST line of defence, so
  // it must refuse it on its own rather than rely on the caller.
  //
  // 字面形式经 URL 解析器后到不了这里（解析器在看到本模块之前就折叠了点段），但本函数是
  // **最后**一道防线，因此必须自己拒绝它，而不是指望调用方。
  const refused = [
    "images/../../api/config",
    "images/..%2f..%2fapi/config",
    "/images/..%2F..%2Fapi/config",
    "images/%2e%2e/%2e%2e/api/config",
    "images/%252e%252e%252fapi/config",
    "images/x%2f%2e%2e%2fapi/config",
    "images\\..\\api",
    "images/\x0ax",
    "images/./../x",
  ];
  for (const value of refused) {
    assert.equal(normalizePassthroughPath(value), null, `should be refused: ${value}`);
  }
});

test("contract with upstream/config.py:87-132 — empty and '.' segments fold away", () => {
  assert.equal(normalizePassthroughPath("/images//./x/"), "/images/x");
  // The RAW spelling of the segment survives: `%2f` is not a separator for the URL
  // parser, and the decode loop has already proven that decoding it stays inside the
  // allowlist subtree. Forwarding the raw form is what keeps "checked" == "forwarded".
  //
  // 段的**原始**写法保留下来：`%2f` 对 URL 解析器不是分隔符，而解码循环已经证明解开它
  // 仍落在白名单子树内。转发原始形式正是"判定值 == 转发值"的来源。
  assert.equal(normalizePassthroughPath("/images/a%2fb"), "/images/a%2fb");
});

test("contract with upstream/config.py:457-487 — the allowlist is exact-or-subtree, deny by default", () => {
  assert.equal(isPassthroughAllowed("/images"), true);
  assert.equal(isPassthroughAllowed("/images/x/y"), true);
  assert.equal(isPassthroughAllowed("/audio"), true);
  assert.equal(isPassthroughAllowed("/files/x"), true);
  // Near misses and the upstream's business/admin routes.
  // 近似命中，以及上游的业务/管理路由。
  assert.equal(isPassthroughAllowed("/imagesx"), false);
  assert.equal(isPassthroughAllowed("/"), false);
  assert.equal(isPassthroughAllowed("/users"), false);
  assert.equal(isPassthroughAllowed("/auths"), false);
});

test("contract with upstream/app.py:1245-1265 — the RESOLVED target must still be inside the allowlist", () => {
  const base = "https://upstream.test";
  assert.equal(targetStaysWithinAllowlist("/api/v1", `${base}/api/v1/images/x`), true);
  // The subpath was allowlisted as written, but the resolved path leaves the `images`
  // subtree: this is the answer the second lock exists to give.
  //
  // 子路径"按原样"确实在白名单内，但解析后的路径离开了 `images` 子树：这正是第二把锁要
  // 给出的答案。
  assert.equal(
    targetStaysWithinAllowlist("/api/v1", `${base}/api/v1/images/x/../../users`),
    false,
  );
  assert.equal(targetStaysWithinAllowlist("/api/v1", `${base}/api/v1/users`), false);
  assert.equal(targetStaysWithinAllowlist("/api/v1", "not a url"), false);
});

// --------------------------------------------------------------------------- //
// Integration: through the /v1 entry point
// 集成：经由 /v1 入口
// --------------------------------------------------------------------------- //

const BASE_URL = "https://upstream.test";
const API_KEY = "sk-passthrough-test";

const REAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

class FakeKV {
  private readonly store = new Map<string, string>();

  async get(key: string, type?: unknown): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === "json") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface Harness {
  env: Env;
  /** Every URL the proxy dialled, in order. */
  calls: string[];
  waitUntil: Promise<unknown>[];
}

async function makeHarness(): Promise<Harness> {
  const kv = new FakeKV();
  const waitUntil: Promise<unknown>[] = [];
  const env = { KV: kv as unknown as KVNamespace } as unknown as Env;
  await putApiKey(env, API_KEY, { name: "test", prefix: API_KEY, created_at: 0, last_used: 0 });
  // Through `setSession` rather than a raw KV seed: `getSession` is served from a
  // module-level 60-second instance cache that another file in this process may own,
  // and only this API refreshes it.
  //
  // 走 `setSession` 而不是直接写 KV：`getSession` 由模块级 60 秒实例缓存提供，本进程里
  // 另一个文件可能正持有它，而只有这个 API 会刷新它。
  await setSession(env, {
    authorization: "Bearer upstream-token",
    cookie: "",
    user_agent: "test-agent",
    captured_at: 0,
    base_url: BASE_URL,
  });

  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.includes("/models")) {
      return Response.json({ object: "list", data: [{ id: "Shared-1" }] });
    }
    return new Response("media-bytes", {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  }) as typeof fetch;

  return { env, calls, waitUntil };
}

const ctx = (waitUntil: Promise<unknown>[]): ExecutionContext =>
  ({ waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise) }) as unknown as ExecutionContext;

function requestFor(path: string): Request {
  return new Request(`https://worker.test${path}`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
}

test("a traversal path is refused BEFORE any upstream request is made", async () => {
  const h = await makeHarness();
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/images/..%2f..%2fapi/config"),
    ctx(h.waitUntil),
  );

  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "endpoint_not_allowed");
  // The whole point: the refusal costs no upstream request, so the route the allowlist
  // exists to withhold was never dialled.
  //
  // 关键所在：拒绝不花费任何上游请求，因此白名单本要挡住的那条路由从未被拨出。
  assert.deepEqual(h.calls, []);
});

test("a literal parent segment never reaches the passthrough at all", async () => {
  const h = await makeHarness();
  // The URL parser folds this one before any of our code runs, so the entry guard sees
  // a path that no longer starts with `/v1/` and answers the OpenAI-style 404.
  //
  // 这一条在我们的任何代码运行之前就被 URL 解析器折叠了，因此入口守卫看到的路径已不再
  // 以 `/v1/` 开头，于是回 OpenAI 风格的 404。
  const response = await handleV1Request(
    h.env,
    requestFor("/v1/images/../../api/config"),
    ctx(h.waitUntil),
  );

  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "not_found");
  assert.deepEqual(h.calls, []);
});

test("an allowlisted media subpath still forwards, normalized", async () => {
  const h = await makeHarness();
  const response = await handleV1Request(
    h.env,
    // Empty and "." segments fold away; the forwarded path is the normalized one.
    // 空段与 "." 段被折叠；转发的是归一化后的路径。
    requestFor("/v1/images//./logo.png/content"),
    ctx(h.waitUntil),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "media-bytes");
  assert.ok(
    h.calls.some((url) => url.endsWith("/api/v1/images/logo.png/content")),
    `expected the folded path upstream, got ${JSON.stringify(h.calls)}`,
  );
});
