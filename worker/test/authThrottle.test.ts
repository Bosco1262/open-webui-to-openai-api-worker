/**
 * Contract tests for the `/v1/*` brute-force interlock: repeated bad proxy keys from
 * one client address are answered 429 (+ Retry-After) instead of another 401.
 *
 * Two properties matter and both are pinned here:
 *   - the throttled thing is the FAILING attempt, so a client that presents a VALID key
 *     is never answered 429 -- even from an address that is already at the limit -- and
 *     that success clears the address's streak (the upstream project's own test asserts
 *     exactly this);
 *   - the counter is per address, so one address cannot lock another out.
 *
 * `/v1/*` 爆破联锁的契约测试：同一客户端地址反复用错 Key 时，回 429（带 Retry-After）
 * 而不是又一个 401。
 *
 * 两条性质重要，且都在此钉住：
 *   - 被节流的是**失败的那次尝试**，因此持**有效** Key 的调用方永远不会拿到 429——哪怕它
 *     来自已达上限的地址——而那一次成功会清零该地址的计数（上游项目自己的用例就断言了这
 *     一点）；
 *   - 计数按地址隔离，一个地址无法锁死另一个。
 *
 * Contract anchors (docs/UPSTREAM-CONTRACTS.zh-CN.md):
 *   #16 爆破联锁  upstream/app.py:454-524（`_auth_failures` / `_record_auth_failure` /
 *                 `_clear_auth_failures`），默认值见 upstream/config.py:389-390
 *   等价用例：upstream/tests/test_units.py:2565-2611
 *
 * The failure map is module-level and the suite runs with `--test-isolation=none` (every
 * file in one process), so each case below uses its OWN client address. That keeps the
 * cases independent without widening the module's API with a test-only reset -- which
 * would be the only reason to export one.
 *
 * 失败记录是模块级的，而测试套件以 `--test-isolation=none` 运行（所有文件同进程），因此
 * 下面每个用例都用**自己**的客户端地址。这既保证用例相互独立，又不必为测试新增重置接口
 * ——那会是把该接口导出的唯一理由。
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { handleV1Request } from "../src/proxy.ts";
import { putApiKey, setSession } from "../src/kv.ts";
import type { Env } from "../src/types.ts";

const BASE_URL = "https://upstream.test";
const API_KEY = "sk-throttle-test";
const WRONG_KEY = "sk-wrong";

// The upstream interlock's defaults, asserted here as behaviour rather than read from the
// module: the point of the test is the sequence a client sees.
//
// 上游联锁的默认值，这里以"行为"而非"读取模块常量"的方式来断言：用例关心的是客户端看到
// 的序列。
const LIMIT = 10;

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
  waitUntil: Promise<unknown>[];
}

async function makeHarness(): Promise<Harness> {
  const kv = new FakeKV();
  const waitUntil: Promise<unknown>[] = [];
  const env = {
    KV: kv as unknown as KVNamespace,
    // The valid-key case reaches /v1/models, where the coordinator is asked for probe
    // fields. A stub keeps that path quiet; it is not what this file is about.
    //
    // 有效 Key 的那个用例会走到 /v1/models，那里会向协调者索取探测字段。给一个替身让这条
    // 路径保持安静；它不是本文件的关注点。
    PROBE: {
      getByName: () => ({ present: async () => ({ fields: {}, instanceMeta: null }) }),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;
  await putApiKey(env, API_KEY, { name: "test", prefix: API_KEY, created_at: 0, last_used: 0 });
  // Through `setSession` rather than a raw KV seed: `getSession` is served from a
  // module-level 60-second instance cache that another file in this process may own, and
  // only this API refreshes it.
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

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/models")) {
      return Response.json({ object: "list", data: [{ id: "Shared-1" }] });
    }
    return new Response("media-bytes", { status: 200 });
  }) as typeof fetch;

  return { env, waitUntil };
}

const ctx = (waitUntil: Promise<unknown>[]): ExecutionContext =>
  ({ waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise) }) as unknown as ExecutionContext;

/** A request from `ip`; an omitted `ip` means the header is absent entirely. */
/** 来自 `ip` 的请求；不传 `ip` 即表示完全不带该请求头。 */
function requestFor(key: string, ip?: string): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  // Cloudflare sets this on every request that reaches a Worker; it is the only header
  // trusted as a client identity (see auth.ts's `clientIP`).
  //
  // Cloudflare 对每一个到达 Worker 的请求都会设置它；它是唯一被信任的客户端身份来源
  // （见 auth.ts 的 `clientIP`）。
  if (ip !== undefined) headers["CF-Connecting-IP"] = ip;
  return new Request("https://worker.test/v1/models", { headers });
}

test("contract with upstream/app.py:483-516 — the attempt after the limit answers 429 with Retry-After", async () => {
  const h = await makeHarness();
  const ip = "203.0.113.9";

  const statuses: number[] = [];
  let last: Response = new Response(null);
  for (let attempt = 0; attempt < LIMIT + 1; attempt += 1) {
    last = await handleV1Request(h.env, requestFor(WRONG_KEY, ip), ctx(h.waitUntil));
    statuses.push(last.status);
  }

  assert.deepEqual(statuses, [...Array(LIMIT).fill(401), 429]);

  const throttled = last;
  const retryAfter = Number(throttled.headers.get("retry-after"));
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 61,
    `expected a whole-second Retry-After within the window, got ${throttled.headers.get("retry-after")}`,
  );
  const body = (await throttled.json()) as { error: { code: string } };
  assert.equal(body.error.code, "too_many_requests");

  // A different address is not affected by another address's streak.
  // 其它地址不受别的地址的计数牵连。
  const other = await handleV1Request(h.env, requestFor(WRONG_KEY, "203.0.113.10"), ctx(h.waitUntil));
  assert.equal(other.status, 401);
});

test("contract with upstream/app.py:446-450 — a valid key still works while throttled, and clears the streak", async () => {
  const h = await makeHarness();
  const ip = "198.51.100.7";

  for (let attempt = 0; attempt < LIMIT; attempt += 1) {
    const response = await handleV1Request(h.env, requestFor(WRONG_KEY, ip), ctx(h.waitUntil));
    assert.equal(response.status, 401);
  }

  // The address is AT the limit. Verification runs before the limiter (as upstream's
  // `require_proxy_key` does), so this must NOT be a 429 -- and it must succeed.
  //
  // 该地址正在上限上。鉴权在限速器之前执行（与上游的 `require_proxy_key` 一致），因此这里
  // **不能**是 429——而且它必须成功。
  const valid = await handleV1Request(h.env, requestFor(API_KEY, ip), ctx(h.waitUntil));
  assert.equal(valid.status, 200);

  // And the success cleared the streak: the next bad key is a plain 401 again rather
  // than the 429 the address had just earned.
  //
  // 而且这次成功清零了计数：下一个错误 Key 又回到干净的 401，而不是该地址刚刚挣到的 429。
  const after = await handleV1Request(h.env, requestFor(WRONG_KEY, ip), ctx(h.waitUntil));
  assert.equal(after.status, 401);
});

test("a request without CF-Connecting-IP is never throttled", async () => {
  const h = await makeHarness();
  // Every address-less caller would otherwise share one bucket and lock each other out
  // (see `authThrottleRecord`); locally there is no client identity to key on at all.
  //
  // 否则这些没有地址的调用方会共用一个桶、互相锁死（见 `authThrottleRecord`）；在本地环境
  // 里根本没有可作键的客户端身份。
  for (let attempt = 0; attempt < LIMIT + 2; attempt += 1) {
    const response = await handleV1Request(h.env, requestFor(WRONG_KEY), ctx(h.waitUntil));
    assert.equal(response.status, 401);
  }
});
