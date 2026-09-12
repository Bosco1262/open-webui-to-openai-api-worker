/**
 * Probe store tests: the upstream-compatible JSON cache format (including the
 * version gate that makes an older cache re-probe instead of being trusted) and the
 * Durable Object SQLite store's mapping, chunking and migration.
 *
 * The SQL fake below validates this module's own logic -- statement dispatch,
 * chunking, JSON mapping -- and deliberately does not pretend to be SQLite; the real
 * engine is exercised end to end by `wrangler dev` in the acceptance run.
 *
 * 探测存储测试：与上游一致的 JSON 缓存格式（含"旧版本缓存重探而不信任"的版本闸门），
 * 以及 Durable Object SQLite 存储的映射、分片与迁移。
 *
 * 下面的 SQL 假实现只验证本模块自身的逻辑——语句分发、分片、JSON 映射——并不假装
 * 自己是 SQLite；真实引擎由验收阶段的 `wrangler dev` 端到端覆盖。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createModelProbe, ModelProbeCache } from "../src/modelProbe.ts";
import {
  MemoryProbeStore,
  SQL_MAX_BIND_PARAMETERS,
  SqliteProbeStore,
  parseProbeCacheFile,
  serializeProbeCacheFile,
} from "../src/probeStore.ts";
import type { SqlCursorLike, SqlStorageLike } from "../src/probeStore.ts";
import type { ModelProbe } from "../src/types.ts";

function probeWith(fingerprint: string, status: ModelProbe["status"] = "ok"): ModelProbe {
  return { ...createModelProbe(fingerprint, 12.5), status };
}

// --------------------------------------------------------------------------- //
// JSON cache file
// JSON 缓存文件
// --------------------------------------------------------------------------- //

test("the cache file round-trips through the upstream shape", () => {
  const entries: Array<[string, ModelProbe]> = [
    ["a", { ...probeWith("fp-a"), supported_efforts: ["none", "low"], efforts_verified: true }],
  ];
  const text = serializeProbeCacheFile(entries);
  assert.deepEqual(JSON.parse(text).version, 2);
  const parsed = parseProbeCacheFile(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0][0], "a");
  assert.deepEqual(parsed[0][1].supported_efforts, ["none", "low"]);
  assert.equal(parsed[0][1].efforts_verified, true);
});

test("a version-1 cache is ignored wholesale so every model is re-probed", () => {
  const old = JSON.stringify({ version: 1, models: { a: { supported_efforts: ["none"] } } });
  assert.deepEqual(parseProbeCacheFile(old), []);

  const cache = new ModelProbeCache();
  cache.load(parseProbeCacheFile(old));
  assert.equal(cache.size, 0);
  assert.deepEqual(cache.syncWithModels([["a", "fp"]]), ["a"]);
});

test("corrupt and unusable cache files degrade to an empty cache", () => {
  assert.deepEqual(parseProbeCacheFile("{ not json"), []);
  assert.deepEqual(parseProbeCacheFile("null"), []);
  assert.deepEqual(parseProbeCacheFile(JSON.stringify({ version: 2, models: [] })), []);
  assert.deepEqual(parseProbeCacheFile({ version: 2, models: { a: "nope" } }), []);
});

// --------------------------------------------------------------------------- //
// Memory store
// --------------------------------------------------------------------------- //

test("the memory store applies upserts and deletes", () => {
  const store = new MemoryProbeStore([["a", probeWith("fp-a")]]);
  assert.equal(store.loadAll().length, 1);
  store.apply({ upserts: [["b", probeWith("fp-b")]], deletes: ["a"] });
  const ids = store.loadAll().map(([id]) => id).sort();
  assert.deepEqual(ids, ["b"]);
});

// --------------------------------------------------------------------------- //
// Durable Object SQLite store
// --------------------------------------------------------------------------- //

/** A tiny in-memory stand-in for `ctx.storage.sql`, dispatching on the exact
 *  statements SqliteProbeStore issues. */
class FakeSql implements SqlStorageLike {
  readonly models = new Map<string, string>();
  readonly meta = new Map<string, string>();
  /** Statements seen, for assertions. */
  readonly statements: string[] = [];

  exec(query: string, ...bindings: unknown[]): SqlCursorLike {
    this.statements.push(query);
    const sql = query.replace(/\s+/g, " ").trim();
    if (sql.startsWith("CREATE TABLE")) return rows([]);
    if (sql.startsWith("SELECT value FROM meta")) {
      const key = bindings.length > 0 ? String(bindings[0]) : "version";
      const value = this.meta.get(key);
      return rows(value === undefined ? [] : [{ value }]);
    }
    if (sql === "DELETE FROM models") {
      this.models.clear();
      return rows([]);
    }
    if (sql.startsWith("INSERT INTO meta")) {
      this.meta.set(String(bindings[0]), String(bindings[1]));
      return rows([]);
    }
    if (sql === "SELECT id, data FROM models") {
      return rows([...this.models.entries()].map(([id, data]) => ({ id, data })));
    }
    if (sql.startsWith("SELECT id, data FROM models WHERE id IN (")) {
      const wanted = new Set(bindings.map((value) => String(value)));
      return rows(
        [...this.models.entries()]
          .filter(([id]) => wanted.has(id))
          .map(([id, data]) => ({ id, data })),
      );
    }
    if (sql === "SELECT COUNT(*) AS n FROM models") return rows([{ n: this.models.size }]);
    if (sql.startsWith("INSERT INTO models")) {
      this.models.set(String(bindings[0]), String(bindings[1]));
      return rows([]);
    }
    if (sql.startsWith("DELETE FROM models WHERE id =")) {
      this.models.delete(String(bindings[0]));
      return rows([]);
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

function rows(values: Array<Record<string, unknown>>): SqlCursorLike {
  return { toArray: () => values };
}

test("the sqlite store creates its schema, records its version and round-trips entries", () => {
  const sql = new FakeSql();
  const store = new SqliteProbeStore(sql);
  store.migrate();
  assert.equal(sql.meta.get("version"), "2");
  assert.equal(store.count(), 0);

  store.apply({
    upserts: [
      ["a", { ...probeWith("fp-a"), supported_efforts: ["none", "low"], capabilities: { vision: true } }],
      ["b", probeWith("fp-b", "unprobeable")],
    ],
    deletes: [],
  });
  assert.equal(store.count(), 2);

  const loaded = new Map(store.loadAll());
  assert.deepEqual(loaded.get("a")?.supported_efforts, ["none", "low"]);
  assert.deepEqual(loaded.get("a")?.capabilities, { vision: true });
  assert.equal(loaded.get("b")?.status, "unprobeable");

  store.apply({ upserts: [], deletes: ["a"] });
  assert.deepEqual(
    store.loadAll().map(([id]) => id),
    ["b"],
  );
});

test("an older-version store is wiped so every model is re-probed", () => {
  const sql = new FakeSql();
  sql.models.set("a", JSON.stringify({ fingerprint: "fp-a", status: "ok" }));
  sql.meta.set("version", "1");
  const store = new SqliteProbeStore(sql);
  store.migrate();
  assert.equal(sql.meta.get("version"), "2");
  assert.equal(store.count(), 0);
});

test("lookups are chunked to stay under the bound-parameter limit", () => {
  const sql = new FakeSql();
  const store = new SqliteProbeStore(sql);
  store.migrate();
  const ids = Array.from({ length: SQL_MAX_BIND_PARAMETERS + 7 }, (_, index) => `m${index}`);
  store.apply({ upserts: ids.map((id) => [id, probeWith(`fp-${id}`)]), deletes: [] });

  const found = store.getMany([...ids, "missing"]);
  assert.equal(found.size, ids.length);
  assert.ok(found.has(`m${SQL_MAX_BIND_PARAMETERS + 6}`));
  assert.equal(found.has("missing"), false);
  // Two statements: one full chunk plus the remainder.
  const lookups = sql.statements.filter((query) => query.includes("WHERE id IN"));
  assert.equal(lookups.length, 2);
});
