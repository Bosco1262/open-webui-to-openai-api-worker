/**
 * Usage-tracking throttle tests ("使用记录粒度").
 *
 * Three things are pinned here:
 *
 *   1. the off switch: interval 0 must mean "never write", *including* the first use of
 *      a never-used key -- "off" that still writes once is not off;
 *   2. the window: first use is recorded immediately, then at most once per interval;
 *   3. the separation that makes revocation stick: usage is written under
 *      `usage:<id>` and NEVER touches the credential record, so a usage write racing a
 *      revoke cannot re-create the key that was just deleted.
 *
 * The window behaviour is time-dependent, so the tests stub `Date.now` and restore it
 * in a finally block (the suite shares one process).
 *
 * 使用记录节流的测试（"使用记录粒度"）。
 *
 * 这里钉住三件事：
 *
 *   1. 关闭开关：间隔为 0 必须意味着"一次都不写"，**连首次使用也不写**——还会写一次的
 *      "关"不是关；
 *   2. 窗口：首次使用立即记录，之后每个间隔至多一次；
 *   3. 让撤销真正生效的分离：使用记录写在 `usage:<id>` 下，**绝不**碰凭据记录，因此与
 *      "撤销"并发的使用写入无法把刚删除的 Key 重建出来。
 *
 * 窗口行为依赖时间，因此测试替身 `Date.now` 并在 finally 中恢复（测试套件共用一个进程）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deleteApiKeyUsage, readApiKeyUsage, setTouchInterval, touchApiKey } from "../src/touch.ts";
import type { Env } from "../src/types.ts";

/** The tiny slice of KV the throttle actually uses, with per-namespace write counts
 *  (saving the interval setting itself is configuration, not usage data). */
/** 节流逻辑实际用到的最小 KV 切片，按命名空间分别计数写入（保存间隔设置属于配置，
 *  不是使用数据）。 */
class MemoryKV {
  private readonly map = new Map<string, string>();
  writes = 0;
  /** Writes to `apikey:*` -- these must never happen from the usage path. */
  credentialWrites = 0;

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    if (key.startsWith("usage:")) this.writes += 1;
    if (key.startsWith("apikey:")) this.credentialWrites += 1;
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Seed a credential record, to prove the usage path leaves it alone. */
  seedCredential(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

function makeEnv(kv: MemoryKV): Env {
  return { KV: kv } as unknown as Env;
}

test("interval 0 switches the feature off: nothing is written, not even the first use", async () => {
  const kv = new MemoryKV();
  assert.equal(await setTouchInterval(makeEnv(kv), 0), true);
  // A never-used key would normally be recorded on its first call.
  // 从未使用的 Key 正常情况下会在首次调用时被记录。
  await touchApiKey(makeEnv(kv), "off-key");
  await touchApiKey(makeEnv(kv), "off-key");
  assert.equal(kv.writes, 0);
});

test("first use writes immediately; the window throttles rewrites until it passes", async () => {
  const kv = new MemoryKV();
  assert.equal(await setTouchInterval(makeEnv(kv), 3_600), true);
  const env = makeEnv(kv);
  const id = "throttled-key";
  const realNow = Date.now;
  try {
    let now = 1_700_000_000_000;
    Date.now = () => now;

    await touchApiKey(env, id);
    assert.equal(kv.writes, 1, "a never-used key is recorded on its first call");

    await touchApiKey(env, id);
    assert.equal(kv.writes, 1, "a rewrite inside the window must be skipped");

    now += 3_600_000 + 1;
    await touchApiKey(env, id);
    assert.equal(kv.writes, 2, "the window passing must allow exactly one rewrite");
  } finally {
    Date.now = realNow;
  }
});

test("usage lands in its own namespace and never rewrites the credential record", async () => {
  // The regression this pins: the old implementation rewrote `apikey:<key>` from
  // `waitUntil` to bump `last_used`. Racing a delete, that write RE-CREATED the key --
  // an indefinite undo of a revocation. Now the credential record is untouched, so
  // deleting it is final.
  //
  // 这里钉住的回归：旧实现会从 `waitUntil` 重写 `apikey:<key>` 来刷新 `last_used`。
  // 与"删除"并发时，那次写入会把 Key **重建**——撤销被无限期回滚。现在凭据记录不被
  // 触碰，因此删除是终局。
  const kv = new MemoryKV();
  assert.equal(await setTouchInterval(makeEnv(kv), 86_400), true);
  const env = makeEnv(kv);
  const id = "a".repeat(64);
  const credential = `apikey:${id}`;
  kv.seedCredential(credential, { name: "client", prefix: "sk-aaaa", created_at: 1, last_used: 0 });

  await touchApiKey(env, id);
  assert.equal(kv.credentialWrites, 0, "the credential record must not be written");
  assert.ok(kv.has(`usage:${id}`), "the usage record lives under its own key");
  assert.equal(await readApiKeyUsage(env, id), Math.floor(Date.now() / 1000));

  // Simulate the revocation: the credential record goes away, and a later usage write
  // (a straggler request, say) must not bring it back.
  // 模拟撤销：凭据记录消失，之后的一次使用写入（比如迟到的请求）绝不能把它带回来。
  await kv.delete(credential);
  await deleteApiKeyUsage(env, id);
  await touchApiKey(env, id);
  assert.equal(kv.has(credential), false, "a revoked key must stay revoked");
});

test("setTouchInterval rejects values outside the shared step table", async () => {
  const kv = new MemoryKV();
  assert.equal(await setTouchInterval(makeEnv(kv), 600), false, "the removed 10-minute step");
  assert.equal(await setTouchInterval(makeEnv(kv), -1), false);
  assert.equal(kv.writes, 0, "a rejected value must not touch KV");
});
