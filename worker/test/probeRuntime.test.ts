/**
 * Probe runtime decision tests.
 *
 * These cover the policy the Durable Object applies when nobody is watching: when to
 * wake up again. Both failure modes are silent -- never waking (models stay stale
 * until a client happens to ask) and waking in a loop (burning the free plan's
 * subrequest quota) -- so they are asserted explicitly here rather than discovered in
 * production.
 *
 * 探测运行时决策的测试。
 *
 * 覆盖 Durable Object 在没人盯着时执行的策略：什么时候再醒一次。两种失效模式都是
 * 静默的——再也不醒（模型一直停在旧结论，直到恰好有客户端来问）与循环唤醒（烧掉免费层
 * 的子请求配额）——因此在这里显式断言，而不是等线上发现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_FAIL_SUSPEND_THRESHOLD,
  applyProbeFailure,
  applyProbeSuccess,
  isProbeQueueStopped,
  newProbeHealth,
  probeHealthFromMeta,
  roundUnavailableCodeFor,
} from "../src/probeRuntime.ts";

import { createModelProbe } from "../src/modelProbe.ts";
import {
  WAKE_MAX_MS,
  WAKE_MIN_MS,
  canJoinRound,
  createTtlCache,
  heartbeatDue,
  heartbeatNextFromMeta,
  nextWakeAtSeconds,
  pendingRoundFromMeta,
  pendingRoundMeta,
  prefixCandidates,
  refsFromCards,
  retryWakeAtSeconds,
  retryWakeDelayMs,
} from "../src/probeRuntime.ts";
import type { ModelProbe } from "../src/types.ts";

function entry(id: string, patch: Partial<ModelProbe>): [string, ModelProbe] {
  return [id, { ...createModelProbe("fp-" + id, 0), ...patch }];
}

// --------------------------------------------------------------------------- //
// Wake-up policy
// 唤醒策略
// --------------------------------------------------------------------------- //

test("conclusive entries never schedule a wake-up", () => {
  const now = 1_000;
  const entries = [
    entry("ok", { status: "ok", retry_after: now + 5 }),
    entry("unprobeable", { status: "unprobeable", retry_after: now + 5 }),
  ];
  assert.equal(retryWakeAtSeconds(entries, now), null);
  assert.equal(retryWakeDelayMs(entries, now), null);
});

test("the earliest backoff deadline wins", () => {
  const now = 1_000;
  const entries = [
    entry("slow", { status: "failed", retry_after: now + 600 }),
    entry("soon", { status: "partial", retry_after: now + 60 }),
    entry("done", { status: "ok" }),
  ];
  assert.equal(retryWakeAtSeconds(entries, now), now + 60);
  assert.equal(retryWakeDelayMs(entries, now), 60_000);
});

test("an already-due retry still waits the minimum, never zero", () => {
  const now = 1_000;
  const entries = [entry("due", { status: "failed", retry_after: now - 5_000 })];
  assert.equal(retryWakeAtSeconds(entries, now), now + WAKE_MIN_MS / 1000);
  assert.equal(retryWakeDelayMs(entries, now), WAKE_MIN_MS);
  assert.ok(WAKE_MIN_MS >= 1_000, "a tight alarm loop would burn the subrequest quota");
});

test("a far-future deadline is clamped to the horizon", () => {
  const now = 1_000;
  // The backoff cap can never exceed the horizon, but a hand-edited store might.
  const entries = [entry("far", { status: "failed", retry_after: now + 30 * 86_400 })];
  assert.equal(retryWakeDelayMs(entries, now), WAKE_MAX_MS);
});

test("bounds are overridable for tests and for a future quota guard", () => {
  const now = 1_000;
  const entries = [entry("due", { status: "failed", retry_after: now })];
  assert.equal(retryWakeDelayMs(entries, now, { minMs: 3_000 }), 3_000);
  assert.equal(
    retryWakeDelayMs([entry("far", { status: "failed", retry_after: now + 10_000 })], now, {
      maxMs: 2_000,
    }),
    2_000,
  );
});

// --------------------------------------------------------------------------- //
// Heartbeat wake axis (the optional patrol)
// 心跳唤醒轴（可选巡检）
// --------------------------------------------------------------------------- //

test("the wake lands on whichever axis comes first", () => {
  const now = 1_000;
  // Both axes pending: the earlier one wins regardless of argument order.
  // 两条轴都有待办：无论参数顺序，较早者胜出。
  assert.equal(nextWakeAtSeconds(now + 600, now + 7_200), now + 600);
  assert.equal(nextWakeAtSeconds(now + 7_200, now + 600), now + 600);
  assert.equal(nextWakeAtSeconds(now + 600, now + 600), now + 600, "a tie is the same instant");
});

test("with the heartbeat off, the backoff wake is untouched", () => {
  const now = 1_000;
  // A null tick must behave exactly like the pre-heartbeat scheduler.
  // 刻度为 null 时必须与加入心跳之前的排程器行为完全一致。
  assert.equal(nextWakeAtSeconds(now + 600, null), now + 600);
  assert.equal(nextWakeAtSeconds(null, null), null);
});

test("a heartbeat-only wake arms at the tick, never earlier than the backoff", () => {
  const now = 1_000;
  assert.equal(nextWakeAtSeconds(null, now + 7_200), now + 7_200);
  // The patrol must not pull a backoff wake in ahead of the backoff itself.
  // 巡检绝不能把退避唤醒提前到退避本身之前。
  assert.equal(nextWakeAtSeconds(now + 600, now + 7_200), now + 600);
});

test("heartbeatDue fires only when a stored tick has arrived", () => {
  const now = 1_000;
  assert.equal(heartbeatDue(null, now), false, "no tick is never due");
  assert.equal(heartbeatDue(now - 1, now), true);
  assert.equal(heartbeatDue(now, now), true, "the tick instant itself counts as due");
  assert.equal(heartbeatDue(now + 1, now), false);
});

test("a missing or corrupt stored tick means 'no tick', not 'due now'", () => {
  for (const raw of [null, "", "  ", "not a number", "NaN"]) {
    assert.equal(heartbeatNextFromMeta(raw), null, `raw=${JSON.stringify(raw)}`);
  }
  // A parseable number is kept verbatim, INCLUDING one in the past: a passed tick is
  // exactly "the patrol is due", and degrading it would postpone it a whole interval.
  //
  // 能解析的数字原样保留，包括过去的时刻：已过去的刻度恰恰意味着"巡检到期"，
  // 把它退化掉会让巡检再推迟一个完整间隔。
  assert.equal(heartbeatNextFromMeta("1700000000"), 1_700_000_000);
  assert.equal(heartbeatNextFromMeta("0"), 0);
});

// --------------------------------------------------------------------------- //
// Round join compatibility
// 轮次加入的兼容性
// --------------------------------------------------------------------------- //

test("a caller joins only a round that is at least as thorough and covers its models", () => {
  const full: { force: boolean; only?: readonly string[] } = { force: false };
  const forcedFull = { force: true };

  // Same shape: joining is the whole point (one probe, not two).
  // 形态相同：加入正是目的（只需要一次探测）。
  assert.equal(canJoinRound(full, full), true);
  assert.equal(canJoinRound(forcedFull, forcedFull), true);
  // A forced re-probe must not join an unforced round: it would force nothing while
  // returning that round's statistics.
  // 强制重探不得加入非强制轮次：那样什么都没强制，却返回了那个轮次的统计。
  assert.equal(canJoinRound(full, forcedFull), false);
  // The other direction is fine (a stronger round already covers the weaker request).
  // 反方向没问题（更强的轮次本就覆盖更弱的请求）。
  assert.equal(canJoinRound(forcedFull, full), true);

  // Coverage: a request for the whole list may only join a whole-list round (a
  // subset round can never answer it) ...
  //
  // 覆盖范围：全量请求只能加入全量轮次（子集轮次永远答不了它）……
  assert.equal(canJoinRound({ force: false, only: ["a"] }, full), false);
  assert.equal(canJoinRound(full, { force: false, only: ["a"] }), true);
  // ... while a request for specific models may join a round that covers AT LEAST
  // those models, and must queue behind one that covers less (joining it would mean
  // waiting for a result that cannot contain the requested models -- the wasted wait
  // this comparison used to allow, because the subset test pointed the wrong way).
  //
  // ……而指定模型的请求可以加入**至少**覆盖这些模型的轮次，对覆盖更少的轮次则必须排队
  // （加入它等于等一个不可能包含所请求模型的结果——正是此前因方向写反而被放行的白等）。
  assert.equal(canJoinRound({ force: false, only: ["a", "b"] }, { force: false, only: ["a"] }), true);
  assert.equal(canJoinRound({ force: false, only: ["a"] }, { force: false, only: ["a", "b"] }), false);
  assert.equal(canJoinRound({ force: false, only: ["a"] }, { force: false, only: ["b"] }), false);
});

// --------------------------------------------------------------------------- //
// Probe health (state machine behind "probing is paused")
// 探测健康（"探测已暂停"背后的状态机）
// --------------------------------------------------------------------------- //

test("only permanent failures count toward suspension", () => {
  const now = 1_000;
  let health = newProbeHealth(now);

  // Two transient failures: the queue is degraded, nothing more.
  // 两次瞬时失败：队列只是 degraded，仅此而已。
  health = applyProbeFailure(health, "transient", "HTTP 503", now + 1);
  health = applyProbeFailure(health, "transient", "timeout", now + 2);
  assert.equal(health.state, "degraded");
  assert.equal(health.consecutive_permanent_failures, 0, "a flapping upstream must not creep toward suspension");
  assert.equal(health.last_error, "timeout");

  // Permanent ones count up and suspend at the threshold.
  // 永久类逐次累加，达到阈值即挂起。
  health = applyProbeFailure(health, "auth_rejected", "HTTP 401", now + 3);
  assert.equal(health.state, "auth_rejected");
  assert.equal(health.consecutive_permanent_failures, 1);
  assert.equal(isProbeQueueStopped(health), false);

  health = applyProbeFailure(health, "auth_rejected", "HTTP 403", now + 4);
  assert.equal(health.state, "auth_rejected");
  assert.equal(health.consecutive_permanent_failures, 2);
  assert.equal(isProbeQueueStopped(health), false);

  health = applyProbeFailure(health, "auth_rejected", "HTTP 401", now + 5);
  assert.equal(health.state, "suspended");
  assert.equal(health.consecutive_permanent_failures, 3);
  assert.equal(isProbeQueueStopped(health), true);
  assert.equal(health.since, now + 5, "the state's clock starts when it is entered");

  // The threshold is a constant the console is told about, not a magic number here.
  assert.equal(AUTH_FAIL_SUSPEND_THRESHOLD, 3);
});

test("a missing session stops the queue immediately, and a success clears the run", () => {
  const now = 2_000;
  let health = newProbeHealth(now);
  health = applyProbeFailure(health, "no_session", "no session", now + 1);
  assert.equal(health.state, "no_session");
  assert.equal(isProbeQueueStopped(health), true, "no session is permanent: there is nothing to retry with");

  // A successful round ends the run -- the credentials demonstrably work.
  // 一次成功轮次结束这段连续失败——凭证确实可用。
  health = applyProbeSuccess(health, false, now + 2);
  assert.equal(health.state, "ok");
  assert.equal(health.consecutive_permanent_failures, 0);
  assert.equal(health.last_success_at, now + 2);
  assert.equal(isProbeQueueStopped(health), false);

  // A round that ran but left models unresolved is degraded, not healthy.
  // 跑完但留下未探清模型的轮次是 degraded，不是健康。
  health = applyProbeSuccess(health, true, now + 3);
  assert.equal(health.state, "degraded");
  assert.equal(health.consecutive_permanent_failures, 0);
});

test("a corrupt health record degrades to a fresh one (never to 'suspended')", () => {
  const now = 3_000;
  const fresh = newProbeHealth(now);
  for (const raw of [null, "", "{ not json", "null", "[]", '"suspended"']) {
    const parsed = probeHealthFromMeta(raw, now);
    assert.deepEqual(parsed, fresh, `raw=${String(raw)}`);
  }
  // A readable record round-trips, unknown states included (they read as "ok").
  // 可读的记录照常往返，未知状态也一样（按 "ok" 读取）。
  const stored = probeHealthFromMeta(
    JSON.stringify({
      state: "suspended",
      since: 42,
      last_round_at: 41,
      last_success_at: null,
      consecutive_permanent_failures: 4,
      last_error: "HTTP 401",
    }),
    now,
  );
  assert.equal(stored.state, "suspended");
  assert.equal(stored.since, 42);
  assert.equal(stored.last_success_at, null);
  assert.equal(stored.consecutive_permanent_failures, 4);
  assert.equal(probeHealthFromMeta(JSON.stringify({ state: "wat" }), now).state, "ok");
});

test("the failure kind maps to the round code the admin API reports", () => {
  assert.equal(roundUnavailableCodeFor("no_session"), "session_missing");
  assert.equal(roundUnavailableCodeFor("auth_rejected"), "auth_rejected");
  assert.equal(roundUnavailableCodeFor("transient"), "models_failed");
});

// --------------------------------------------------------------------------- //
// Prefix order
// 前缀顺序
// --------------------------------------------------------------------------- //

test("a remembered prefix is tried first, exactly once", () => {
  const canonical = ["/api/v1", "/api"];
  assert.deepEqual(prefixCandidates("/api", canonical), ["/api", "/api/v1"]);
  assert.deepEqual(prefixCandidates("/api/v1", canonical), ["/api/v1", "/api"]);
  assert.deepEqual(prefixCandidates(null, canonical), canonical);
  // A remembered prefix that is no longer a candidate (config change, downgrade) must
  // not be tried at all.
  //
  // 已不再是候选的旧前缀（配置变更、降级）绝不能再去试。
  assert.deepEqual(prefixCandidates("/v2", canonical), canonical);
});

// --------------------------------------------------------------------------- //
// Card -> refs
// --------------------------------------------------------------------------- //

test("refs keep upstream order, skip id-less cards and carry the fingerprint", async () => {
  const cards = [
    { id: "b", openai: { root: "/models/b", owned_by: "vllm" }, info: { updated_at: 2 } },
    { nope: true },
    { id: "a", openai: { root: "/models/a", owned_by: "vllm" }, info: { updated_at: 1 } },
  ];
  const refs = await refsFromCards(cards);
  assert.deepEqual(
    refs.map(([id]) => id),
    ["b", "a"],
  );
  for (const [, fingerprint] of refs) assert.match(fingerprint, /^[0-9a-f]{16}$/);
  // Different engine identity, different fingerprint: this is what makes a swapped
  // engine re-probe even though the id never changed.
  //
  // 引擎标识不同则指纹不同：这正是"换了引擎、id 没变"也会重探的原因。
  assert.notEqual(refs[0][1], refs[1][1]);
  assert.deepEqual(await refsFromCards([]), []);
});

// --------------------------------------------------------------------------- //
// TTL cache (the coordinator's settings read)
// --------------------------------------------------------------------------- //

test("the TTL cache loads once per window and serves the rest from memory", async () => {
  let clock = 1_000;
  let loads = 0;
  const cached = createTtlCache(
    async () => {
      loads += 1;
      return `v${loads}`;
    },
    100,
    () => clock,
  );

  assert.equal(await cached(), "v1");
  assert.equal(loads, 1);

  clock += 99;
  assert.equal(await cached(), "v1");
  assert.equal(loads, 1, "a hit inside the window must not reload");

  clock += 1;
  assert.equal(await cached(), "v2");
  assert.equal(loads, 2, "the window expiring must reload");
});

test("concurrent callers share one in-flight load", async () => {
  let loads = 0;
  let release: (() => void) | null = null;
  const cached = createTtlCache(
    async () => {
      loads += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "value";
    },
    1_000,
    () => 0,
  );

  const first = cached();
  const second = cached();
  assert.equal(loads, 1, "the second call must join the first, not start another");
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ["value", "value"]);
  assert.equal(loads, 1);
});

test("a failing loader is never cached, so the next call retries", async () => {
  let loads = 0;
  let clock = 0;
  const cached = createTtlCache(
    async () => {
      loads += 1;
      if (loads === 1) throw new Error("transient");
      return "ok";
    },
    100,
    () => clock,
  );

  await assert.rejects(() => cached(), /transient/);
  clock += 1; // far inside the window: a cached failure would be served from here
  assert.equal(await cached(), "ok");
  assert.equal(loads, 2);
});

// --------------------------------------------------------------------------- //
// The request a truncated round hands to its alarm
// --------------------------------------------------------------------------- //

test("a forced whole-list round survives the round-trip through the meta table", () => {
  const request = { force: true } as const;
  const restored = pendingRoundFromMeta(pendingRoundMeta(request));
  assert.deepEqual(restored, { force: true, only: undefined });
  // Without the force flag the alarm's default selection skips every model that still
  // holds an `ok` conclusion -- exactly what the second half of a "probe now" is.
  //
  // 没有 force 标记时，alarm 的默认选择会跳过所有仍持有 `ok` 结论的模型——而它们正是
  // 「立即探测」后半程要处理的对象。
  assert.equal(restored?.force, true);
});

test("a single-model forced round keeps its model list", () => {
  const restored = pendingRoundFromMeta(
    pendingRoundMeta({ force: true, only: ["gpt-oss-120b"] }),
  );
  assert.deepEqual(restored, { force: true, only: ["gpt-oss-120b"] });
});

test("an ordinary request round-trips as non-forced", () => {
  assert.deepEqual(pendingRoundFromMeta(pendingRoundMeta({ force: false })), {
    force: false,
    only: undefined,
  });
});

test("a missing, empty or corrupt pending value means 'no pending round'", () => {
  // An unparseable value must degrade to the default alarm behaviour, never crash it.
  //
  // 解析不了的值必须退化为默认 alarm 行为，而绝不能让处理器崩溃。
  for (const raw of [null, "", "  ", "not json", "[]", "42", '"text"', "{}"]) {
    const restored = pendingRoundFromMeta(raw);
    if (raw === "{}") {
      assert.deepEqual(restored, { force: false, only: undefined });
    } else {
      assert.equal(restored, null, `raw=${JSON.stringify(raw)} must mean "nothing pending"`);
    }
  }
});

test("non-string ids in a hand-edited only-list are dropped, not trusted", () => {
  const restored = pendingRoundFromMeta('{"force":true,"only":["a",7,null,"b"]}');
  assert.deepEqual(restored, { force: true, only: ["a", "b"] });
  // An only-list that loses every id must fall back to the whole list rather than to an
  // empty selection, which would probe nothing at all.
  //
  // 若 only 列表里的 id 全部无效，必须回退为"整份列表"，而不是空选择——空选择一个模型
  // 都不会探。
  assert.deepEqual(pendingRoundFromMeta('{"force":true,"only":[7]}'), {
    force: true,
    only: undefined,
  });
});
