/**
 * Unit tests for intervals.ts -- the shared granularity steps used by the API-key
 * `last_used` write throttle.
 *
 * The finest step matters operationally, not cosmetically: the KV free plan allows
 * 1,000 writes per day, so a step and a key count together decide whether the
 * throttle can blow the quota. `600` (every 10 minutes) was removed for exactly that
 * reason -- at 144 writes per key per day, seven keys exhaust the whole daily budget.
 * The last test below pins that reasoning down so a finer step cannot come back in
 * without someone redoing the arithmetic.
 *
 * intervals.ts 纯逻辑的单元测试——API Key `last_used` 写入节流共用的档位。
 *
 * 最细的档位有运维意义，不只是界面问题：KV 免费层每天只允许 1,000 次写入，因此
 * "档位 × Key 数"共同决定节流会不会撑爆配额。删除 `600`（每十分钟）正是这个原因——
 * 它每个 Key 每天写 144 次，七个 Key 就会吃光整天的写入预算。最后一条测试把这个
 * 推理钉住，避免更细的档位被无声地加回来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_INTERVAL, INTERVAL_OPTIONS, isIntervalOption } from "../src/intervals.ts";

test("the offered steps stop at 30 minutes, plus the off switch", () => {
  assert.deepEqual([...INTERVAL_OPTIONS], [86_400, 43_200, 21_600, 10_800, 3_600, 1_800, 0]);
  assert.equal(isIntervalOption(600), false, "the 10-minute step must be gone");
});

test("the steps are listed coarsest first, and the default is one of them", () => {
  assert.deepEqual([...INTERVAL_OPTIONS], [...INTERVAL_OPTIONS].sort((a, b) => b - a));
  assert.equal(isIntervalOption(DEFAULT_INTERVAL), true);
});

test("only offered steps are accepted", () => {
  assert.equal(isIntervalOption(1_800), true);
  assert.equal(isIntervalOption(300), false);
  // 0 is the shared "feature off" step: every consumer interprets it as "do
  // nothing", so it is offered rather than rejected.
  //
  // 0 是共享的"关闭功能"档位：所有使用方都把它解释为"什么都不做"，因此它是可选
  // 档位而不是被拒绝的值。
  assert.equal(isIntervalOption(0), true);
  assert.equal(isIntervalOption(-1_800), false);
  assert.equal(isIntervalOption(Number.NaN), false);
});

test("the finest step still leaves room for a realistic number of keys", () => {
  // KV free plan: 1,000 writes per day. Every offered step must be able to serve a
  // plausible key fleet before that ceiling is reached.
  //
  // KV 免费层：每天 1,000 次写入。每个可选档位都必须能支撑一个合理的 Key 数量。
  const maxKeys = (seconds: number): number => 1_000 / (86_400 / seconds);

  assert.ok(maxKeys(86_400) >= 1_000, "daily must tolerate any fleet");
  assert.ok(maxKeys(43_200) >= 500, "12h must tolerate a large fleet");
  assert.ok(maxKeys(21_600) >= 200, "6h must tolerate a large fleet");
  assert.ok(maxKeys(1_800) >= 20, "30m is the floor and must tolerate ~20 keys");
});
