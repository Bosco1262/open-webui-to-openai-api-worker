/**
 * Unit tests for instanceMeta.ts -- the pure half of the instance snapshot.
 *
 * The snapshot itself now lives in the coordinator's SQLite and /api/config is
 * fetched from there (in the background, from `waitUntil`). What is left in this
 * module is exactly what deserves pinning down: what counts as a usable /api/config
 * response, how a snapshot is parsed back out of storage, when it is stale, and what
 * may appear in the envelope.
 *
 * instanceMeta.ts 纯逻辑部分的单元测试——实例快照的纯逻辑那一半。
 *
 * 快照本身现在存放在协调者的 SQLite 中，/api/config 也从那里（在 `waitUntil` 里后台）
 * 拉取。本模块剩下的正是值得钉住的部分：什么样的 /api/config 答复算可用、如何从存储
 * 解析回快照、什么时候算过期、以及信封里可以出现什么。
 *
 * Run: node --test --test-isolation=none test/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INSTANCE_META_TTL_SECONDS,
  applyInstanceConfig,
  emptyInstanceMeta,
  instanceMetaToEnvelope,
  isInstanceMetaFresh,
  isInstanceMetaUsable,
  parseInstanceConfig,
  parseInstanceMeta,
  sameCapabilities,
} from "../src/instanceMeta.ts";

// --------------------------------------------------------------------------- //
// /api/config parsing (the SPA trap)
// --------------------------------------------------------------------------- //

test("a JSON object with status 200 is a usable /api/config response", () => {
  const parsed = parseInstanceConfig(200, "application/json", '{"name":"OWUI","version":"0.9.2"}');
  assert.deepEqual(parsed, { name: "OWUI", version: "0.9.2" });
});

test("a 200 carrying an HTML page is rejected (the SPA trap)", () => {
  // `/api/v1/config` is not a route: it falls through to the SPA, which answers 200
  // with an HTML page. Trusting the status code would overwrite a good snapshot with
  // garbage the moment the legacy prefix moved.
  //
  // `/api/v1/config` 不是路由：它会落到 SPA 上，由 SPA 回 200 + 一页 HTML。只信状态码
  // 会在旧前缀一旦变动时用好快照换回一堆垃圾。
  assert.equal(parseInstanceConfig(200, "text/html", "<!doctype html><html></html>"), null);
  assert.equal(parseInstanceConfig(200, "text/html; charset=utf-8", "<html>"), null);
  assert.equal(parseInstanceConfig(200, "application/json", "<not json>"), null);
});

test("every other failure mode degrades to null", () => {
  assert.equal(parseInstanceConfig(404, "application/json", '{"a":1}'), null);
  assert.equal(parseInstanceConfig(500, null, ""), null);
  assert.equal(parseInstanceConfig(200, "application/json", ""), null);
  assert.equal(parseInstanceConfig(200, "application/json", "   "), null);
  assert.equal(parseInstanceConfig(200, "application/json", "garbage"), null);
  assert.equal(parseInstanceConfig(200, "application/json", "[1,2,3]"), null);
  assert.equal(parseInstanceConfig(200, "application/json", "null"), null);
});

// --------------------------------------------------------------------------- //
// Storage round-trip
// --------------------------------------------------------------------------- //

test("a snapshot stored as a JSON string round-trips", () => {
  const stored =
    '{"name":"OWUI","version":"0.9.2","features":{"web_search":true},' +
    '"default_model_capabilities":{"builtin_tools":true},"fetched_at":123}';
  const meta = parseInstanceMeta(stored);
  assert.equal(meta.name, "OWUI");
  assert.equal(meta.version, "0.9.2");
  assert.deepEqual(meta.features, { web_search: true });
  assert.deepEqual(meta.default_model_capabilities, { builtin_tools: true });
  assert.equal(meta.fetched_at, 123);
});

test("corrupt and unusable stored values degrade to an empty snapshot", () => {
  for (const raw of ["{ not json", null, undefined, 42, "[]", '"str"']) {
    assert.deepEqual(parseInstanceMeta(raw), emptyInstanceMeta());
  }
  // Non-boolean template entries are dropped ...
  assert.deepEqual(parseInstanceMeta({ default_model_capabilities: { a: true, b: "yes" } })
    .default_model_capabilities, { a: true });
  // ... so a template with nothing left is omitted entirely rather than served empty.
  assert.equal(
    parseInstanceMeta({ default_model_capabilities: { a: 1 } }).default_model_capabilities,
    undefined,
  );
});

// --------------------------------------------------------------------------- //
// Freshness
// --------------------------------------------------------------------------- //

test("freshness follows the TTL, and a never-fetched snapshot is never fresh", () => {
  const meta = { ...emptyInstanceMeta(), fetched_at: 1_000 };
  assert.equal(isInstanceMetaFresh(meta, 1_000), true);
  assert.equal(isInstanceMetaFresh(meta, 1_000 + INSTANCE_META_TTL_SECONDS - 1), true);
  assert.equal(isInstanceMetaFresh(meta, 1_000 + INSTANCE_META_TTL_SECONDS), false);
  assert.equal(isInstanceMetaFresh(emptyInstanceMeta(), 9_999_999), false);
});

// --------------------------------------------------------------------------- //
// Merging a /api/config payload
// --------------------------------------------------------------------------- //

test("applying /api/config always stamps fetched_at, even when the read failed", () => {
  const previous = { ...emptyInstanceMeta(), name: "Old", fetched_at: 1 };

  // A failed read must still move the timestamp, or an unreachable instance would be
  // retried on every request instead of once per TTL.
  //
  // 失败的读取也必须推进时间戳，否则不可达的实例会被每请求重试，而不是每 TTL 一次。
  const failed = applyInstanceConfig(previous, null, 500);
  assert.equal(failed.fetched_at, 500);
  assert.equal(failed.name, "Old", "facts survive a failed refresh");
  assert.equal(isInstanceMetaFresh(failed, 500), true);

  const ok = applyInstanceConfig(previous, { name: "New", version: "1.0", features: { a: true } }, 600);
  assert.equal(ok.name, "New");
  assert.equal(ok.version, "1.0");
  assert.deepEqual(ok.features, { a: true });
  assert.equal(ok.fetched_at, 600);
});

test("empty or wrong-typed payload fields never erase known facts", () => {
  const previous = { ...emptyInstanceMeta(), name: "Old", version: "0.9", features: { keep: true } };
  const next = applyInstanceConfig(previous, { name: "", version: 42, features: "nope" }, 700);
  assert.equal(next.name, "Old");
  assert.equal(next.version, "0.9");
  assert.deepEqual(next.features, { keep: true });
});

// --------------------------------------------------------------------------- //
// Usability and the envelope
// --------------------------------------------------------------------------- //

test("usability and the envelope mention only what is actually known", () => {
  assert.equal(isInstanceMetaUsable(emptyInstanceMeta()), false);
  assert.equal(isInstanceMetaUsable({ ...emptyInstanceMeta(), name: "OWUI" }), true);
  assert.equal(
    isInstanceMetaUsable({ ...emptyInstanceMeta(), default_model_capabilities: { a: true } }),
    true,
  );
  assert.equal(isInstanceMetaUsable({ ...emptyInstanceMeta(), features: {} }), false);

  const full = {
    name: "OWUI",
    version: "0.9.2",
    features: { web_search: true },
    default_model_capabilities: { builtin_tools: true },
    fetched_at: 1,
  };
  assert.deepEqual(instanceMetaToEnvelope(full), {
    name: "OWUI",
    version: "0.9.2",
    features: { web_search: true },
    default_model_capabilities: { builtin_tools: true },
  });
  // Empty collections and missing strings stay out of the envelope entirely.
  // 空集合与缺失的字符串完全不进信封。
  assert.deepEqual(instanceMetaToEnvelope(emptyInstanceMeta()), {});
  assert.deepEqual(instanceMetaToEnvelope({ ...emptyInstanceMeta(), name: "N", features: {} }), {
    name: "N",
  });
});

// --------------------------------------------------------------------------- //
// Template comparison
// --------------------------------------------------------------------------- //

test("capability templates compare by entries, not by identity", () => {
  assert.equal(sameCapabilities(undefined, undefined), true);
  assert.equal(sameCapabilities(undefined, {}), true);
  assert.equal(sameCapabilities({ a: true }, { a: true }), true);
  assert.equal(sameCapabilities({ a: true }, { a: false }), false);
  assert.equal(sameCapabilities({ a: true }, { a: true, b: true }), false);
  assert.equal(sameCapabilities({ a: true, b: true }, { a: true }), false);
});
