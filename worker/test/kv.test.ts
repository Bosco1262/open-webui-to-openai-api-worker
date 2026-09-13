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
  getOrCreateSessionSecret,
  getPasswordHash,
  getSession,
  readKvJson,
  setSession,
} from "../src/kv.ts";
import { parseProbeSettingsInput, readProbeSettings } from "../src/probeSettings.ts";
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
  // The heartbeat is off by default, and its fallback is OFF rather than a step.
  // 心跳默认关闭，且其回退值是"关"而不是某个档位。
  assert.equal(settings.heartbeatInterval, 0);
});

test("a stored heartbeat interval is kept when it hits the shared table and switched off when not", async () => {
  const { env, kv } = makeEnv();
  // Every step of the shared table is a legal stored value.
  // 共享档位表的每一档都是合法的存储值。
  for (const seconds of [86_400, 43_200, 21_600, 10_800, 3_600, 1_800, 0]) {
    kv.raw("settings:probe", JSON.stringify({ heartbeatInterval: seconds }));
    assert.equal(
      (await readProbeSettings(env, { useCache: false })).heartbeatInterval,
      seconds,
      `heartbeatInterval=${String(seconds)} must be kept`,
    );
  }

  // Anything outside the table degrades to off: a mangled interval must never silently
  // become a patrol cadence nobody chose.
  //
  // 表外的值一律退化为关闭：被改坏的间隔绝不能悄悄变成没人选过的巡检节奏。
  for (const bad of [600, 5, -1, 1800.5, true]) {
    kv.raw("settings:probe", JSON.stringify({ heartbeatInterval: bad }));
    const loaded = await readProbeSettings(env, { useCache: false });
    assert.equal(loaded.heartbeatInterval, 0, `heartbeatInterval=${String(bad)} must mean off`);
  }
  // The numeric-string form is kept, mirroring how the loader coerces every knob.
  // 数字字符串形态会被保留，与加载器对所有旋钮的强转方式一致。
  kv.raw("settings:probe", JSON.stringify({ heartbeatInterval: "43200" }));
  assert.equal((await readProbeSettings(env, { useCache: false })).heartbeatInterval, 43_200);
});

test("the console write path strictly rejects a heartbeat outside the shared table", () => {
  const base = { enabled: true, expose_instance_meta: true, timeout: 30, wait: 5, budget: 40 };
  for (const seconds of [86_400, 43_200, 21_600, 10_800, 3_600, 1_800, 0]) {
    const parsed = parseProbeSettingsInput({ ...base, heartbeat_interval: seconds });
    assert.notEqual(parsed, null, `heartbeat_interval=${String(seconds)} is valid`);
    assert.equal(parsed?.heartbeatInterval, seconds);
  }
  for (const seconds of [600, 5, -1, 1800.5, "twelve", undefined]) {
    assert.equal(
      parseProbeSettingsInput({ ...base, heartbeat_interval: seconds }),
      null,
      `heartbeat_interval=${String(seconds)} must be rejected`,
    );
  }
  // `Number(null)` is 0, and 0 is the shared "off" step, so null reads as "off" -- the
  // same coercion the wait knob already accepts. A MISSING field, by contrast, is a
  // rejected write: the console always sends the round-tripped seconds.
  //
  // `Number(null)` 为 0，而 0 是共享的"关闭"档，因此 null 按"关闭"读取——与 wait
  // 旋钮早已接受的强转一致。而**缺失**字段按"拒绝写入"处理：控制台总会回传已载入的
  // 秒数。
  assert.equal(parseProbeSettingsInput({ ...base, heartbeat_interval: null })?.heartbeatInterval, 0);
  assert.equal(parseProbeSettingsInput(base), null);
});

test("a concurrent secret writer wins the race and is adopted", async () => {
  // Two isolates can hit the "no secret" branch together, and KV is
  // last-write-wins. The one that generated first must adopt the actual winner,
  // or tokens signed with its own value fail verification later -- an admin
  // signed out for no visible reason.
  //
  // 两个 isolate 可能同时走进"无 secret"分支，而 KV 是后写者胜。先生成的一方必须
  // 采用真正生效的值，否则用它自己那份签发的令牌之后会验签失败——管理员会莫名
  // 其妙地掉线。
  class RacyKV {
    private winner: string | null = null;
    async get(): Promise<string | null> {
      // First read: nothing stored. After the put below: the other isolate's value.
      // 第一次读：什么都没有。下面的 put 之后：另一个 isolate 的值。
      return this.winner;
    }
    async put(_key: string, value: string): Promise<void> {
      // Simulate the concurrent writer landing AFTER ours (last-write-wins).
      // 模拟并发写入者在我们之后落盘（后写者胜）。
      void value;
      this.winner = "the-other-isolates-secret";
    }
  }
  const env = { KV: new RacyKV() } as unknown as Env;
  assert.equal(await getOrCreateSessionSecret(env), "the-other-isolates-secret");
});
