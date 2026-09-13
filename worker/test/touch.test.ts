/**
 * Usage-tracking throttle tests ("使用记录粒度").
 *
 * The off switch is the part worth pinning: interval 0 must mean "never write",
 * *including* the first use of a never-used key — "off" that still writes once is
 * not off. The window behaviour is time-dependent, so the tests stub `Date.now`
 * and restore it in a finally block (the suite shares one process).
 *
 * 使用记录节流的测试（"使用记录粒度"）。
 *
 * 值得钉住的是关闭开关：间隔为 0 必须意味着"一次都不写"，**连首次使用也不写**——
 * 还会写一次的"关"不是关。窗口行为依赖时间，因此测试替身 `Date.now` 并在 finally
 * 中恢复（测试套件共用一个进程）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setTouchInterval, touchApiKey } from "../src/touch.ts";
import type { ApiKeyMeta, Env } from "../src/types.ts";

/** The tiny slice of KV the throttle actually uses. Only key writes are counted:
 *  saving the interval setting itself is a configuration write, not usage data. */
/** 节流逻辑实际用到的最小 KV 切片。只统计 Key 写入：保存间隔设置属于配置写入，
 *  不是使用数据。 */
class MemoryKV {
  private readonly map = new Map<string, string>();
  writes = 0;

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    if (key.startsWith("apikey:")) this.writes += 1;
  }
}

function makeEnv(kv: MemoryKV): Env {
  return { KV: kv } as unknown as Env;
}

function meta(lastUsed = 0): ApiKeyMeta {
  return { name: "k", prefix: "sk-k", created_at: 1, last_used: lastUsed };
}

test("interval 0 switches the feature off: nothing is written, not even the first use", async () => {
  const kv = new MemoryKV();
  assert.equal(await setTouchInterval(makeEnv(kv), 0), true);
  // A never-used key would normally be recorded on its first call.
  // 从未使用的 Key 正常情况下会在首次调用时被记录。
  await touchApiKey(makeEnv(kv), "off-key", meta());
  await touchApiKey(makeEnv(kv), "off-key", meta(123));
  assert.equal(kv.writes, 0);
});

test("first use writes immediately; the window throttles rewrites until it passes", async () => {
  const kv = new MemoryKV();
  assert.equal(await setTouchInterval(makeEnv(kv), 3_600), true);
  const env = makeEnv(kv);
  const key = "throttled-key";
  const realNow = Date.now;
  try {
    let now = 1_700_000_000_000;
    Date.now = () => now;

    await touchApiKey(env, key, meta());
    assert.equal(kv.writes, 1, "a never-used key is recorded on its first call");

    await touchApiKey(env, key, meta(Math.floor(now / 1000)));
    assert.equal(kv.writes, 1, "a rewrite inside the window must be skipped");

    now += 3_600_000 + 1;
    await touchApiKey(env, key, meta(Math.floor((now - 3_600_001) / 1000)));
    assert.equal(kv.writes, 2, "the window passing must allow exactly one rewrite");
  } finally {
    Date.now = realNow;
  }
});

test("setTouchInterval rejects values outside the shared step table", async () => {
  const kv = new MemoryKV();
  assert.equal(await setTouchInterval(makeEnv(kv), 600), false, "the removed 10-minute step");
  assert.equal(await setTouchInterval(makeEnv(kv), -1), false);
  assert.equal(kv.writes, 0, "a rejected value must not touch KV");
});
