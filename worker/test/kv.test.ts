/**
 * KV read-tolerance tests.
 *
 * Cloudflare's `type: "json"` read THROWS on a malformed value, so a hand-edited,
 * truncated or foreign entry used to take the request down with it (an unparseable
 * `session` made every `/v1/*` request fail). Every parsed read now goes through
 * `readKvJson`, which degrades an unparseable value to "absent" -- but, deliberately,
 * still propagates a FAILING read: reporting a KV outage as "invalid API key" would
 * send the operator looking in the wrong place.
 *
 * KV 读取容错测试。
 *
 * Cloudflare 的 `type: "json"` 读取在值损坏时会**抛出**，因此一条被手改过、被截断或来自
 * 外部的条目会把请求一起带走（一个解析不了的 `session` 会让每个 `/v1/*` 请求都失败）。
 * 现在所有需要解析的读取都走 `readKvJson`，它把解析不了的值退化为"不存在"——但刻意保留
 * **读取失败**的抛出：把 KV 故障报成"API Key 无效"会让运维去错误的地方排查。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deleteSession,
  getApiKeyMeta,
  getPasswordHash,
  getSession,
  readKvJson,
  setSession,
} from "../src/kv.ts";
import { readProbeSettings } from "../src/probeSettings.ts";
import type { Env } from "../src/types.ts";

/**
 * A KV namespace that behaves like Cloudflare's: raw strings in, and a `"json"` read
 * that THROWS on a malformed value (which is why it is never used any more).
 */
class RawKV {
  private readonly store = new Map<string, string>();
  /** Key prefixes whose reads FAIL, to model an unreachable namespace. */
  readonly failOn = new Set<string>();

  raw(key: string, value: string): void {
    this.store.set(key, value);
  }

  async get(key: string, type?: unknown): Promise<unknown> {
    for (const prefix of this.failOn) {
      if (key.startsWith(prefix)) throw new Error(`KV unavailable for ${prefix}`);
    }
    const value = this.store.get(key);
    if (value === undefined) return null;
    if (type === "json") return JSON.parse(value); // throws on a malformed value
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(): { env: Env; kv: RawKV } {
  const kv = new RawKV();
  return { env: { KV: kv as unknown as KVNamespace } as unknown as Env, kv };
}

test("a malformed value reads as absent instead of throwing", async () => {
  const { env, kv } = makeEnv();
  assert.equal(await readKvJson(env.KV, "missing"), null);
  kv.raw("broken", "{ not json");
  assert.equal(await readKvJson(env.KV, "broken"), null);
  kv.raw("empty", "");
  assert.equal(await readKvJson(env.KV, "empty"), null);
  kv.raw("good", '{"a":1}');
  assert.deepEqual(await readKvJson(env.KV, "good"), { a: 1 });
});

test("a corrupt session reads as 'not imported' instead of failing every request", async () => {
  const { env, kv } = makeEnv();
  // `deleteSession` first: the instance cache would otherwise serve a session another
  // test set.
  //
  // 先 `deleteSession`：否则实例缓存会返回别的用例设置过的 session。
  await deleteSession(env);
  kv.raw("session", "{ truncated");
  assert.equal(await getSession(env), null);

  // A valid one still round-trips (through the 60s instance cache as well).
  // 合法值照常往返（并进入 60 秒实例缓存）。
  await setSession(env, {
    authorization: "Bearer t",
    cookie: "",
    user_agent: "ua",
    captured_at: 1,
    base_url: "https://kv.test",
  });
  assert.equal((await getSession(env))?.base_url, "https://kv.test");

  // And corrupting it again is visible immediately, because the cache is refreshed by
  // the same public API the console uses.
  // 再次改坏后立刻可见，因为缓存由控制台使用的同一个公开 API 刷新。
  await deleteSession(env);
  kv.raw("session", "null");
  assert.equal(await getSession(env), null);
});

test("other parsed keys degrade the same way", async () => {
  const { env, kv } = makeEnv();
  kv.raw("apikey:sk-broken", "not json");
  assert.equal(await getApiKeyMeta(env, "sk-broken"), null);
  kv.raw("admin:password_hash", "[1,2,");
  assert.equal(await getPasswordHash(env), null);
});

test("a FAILING read still propagates (it is not the same as a missing key)", async () => {
  const { env, kv } = makeEnv();
  kv.failOn.add("session");
  await assert.rejects(() => getSession(env), /KV unavailable/);
});

test("corrupt probe settings fall back to the defaults", async () => {
  const { env, kv } = makeEnv();
  kv.raw("settings:probe", "{ half-written");
  const settings = await readProbeSettings(env, { useCache: false });
  assert.equal(settings.enabled, true);
  assert.equal(settings.timeout, 30);
  assert.equal(settings.wait, 5);
  assert.equal(settings.budget, 40);
  assert.equal(settings.exposeInstanceMeta, true);

  // A partially valid payload keeps what it can and clamps the rest.
  // 部分合法的负载保住能用的字段，其余夹紧到边界内。
  kv.raw("settings:probe", JSON.stringify({ enabled: false, timeout: 999, budget: "x" }));
  const partial = await readProbeSettings(env, { useCache: false });
  assert.equal(partial.enabled, false);
  assert.equal(partial.timeout, 120);
  assert.equal(partial.budget, 40);
});
