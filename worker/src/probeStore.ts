/**
 * Persistence for the model probe cache.
 *
 * The authoritative copy lives in the ModelProbeCoordinator Durable Object, one
 * SQLite row per model, so that:
 *   - only the model that changed is written (the upstream Python project rewrites
 *     the whole JSON file), and
 *   - reads are strongly consistent (Workers KV is eventually consistent for up to
 *     ~60s across locations, which would make freshly probed models invisible).
 *
 * Two stores implement the same tiny interface: MemoryProbeStore (tests, and a
 * safe fallback) and SqliteProbeStore (the Durable Object). The JSON helpers
 * reproduce the upstream file format -- `{"version": 2, "models": {...}}` -- so a
 * cache can be exported/imported and, more importantly, so the version gate is
 * implemented once and tested: a file written by an older version is ignored
 * wholesale and every model is re-probed instead of being trusted.
 *
 * 模型探测缓存的持久化。
 *
 * 权威副本存放在 ModelProbeCoordinator Durable Object 中，每模型一行 SQLite，
 * 这样可以：
 *   - 只写入发生变化的模型（上游 Python 项目是重写整个 JSON 文件）；
 *   - 读取是强一致的（Workers KV 跨机房最长约 60 秒最终一致，会让刚探完的模型
 *     读不到）。
 *
 * 两个实现共用同一个极简接口：MemoryProbeStore（测试用，也是安全兜底）与
 * SqliteProbeStore（Durable Object 用）。JSON 辅助函数复刻上游文件格式
 * `{"version": 2, "models": {...}}`，以便导出/导入缓存；更重要的是让版本闸门
 * 只实现一次并可被测试：旧版本写入的文件整体忽略并全部重探，而不是信任它。
 */

import { isPlainObject } from "./json.ts";
import { CACHE_VERSION, modelProbeFromDict, modelProbeToDict } from "./modelProbe.ts";
import type { ModelProbe } from "./types.ts";

/** The pending store changes produced by cache mutations. */
/** 缓存变更产生的待落盘差异。 */
export interface ProbeStoreChanges {
  upserts: Array<[string, ModelProbe]>;
  deletes: string[];
}

/** What the probe round needs from a store. */
/** 探测轮次对存储的全部需求。 */
export interface ProbeStore {
  /** Every cached entry (an empty list when the store is empty or unusable). */
  /** 全部缓存条目（存储为空或不可用时空列表）。 */
  loadAll(): Array<[string, ModelProbe]>;
  /** Persist exactly the changed entries. */
  /** 只落盘发生变化的条目。 */
  apply(changes: ProbeStoreChanges): void;
}

// --------------------------------------------------------------------------- //
// In-memory store
// 内存存储
// --------------------------------------------------------------------------- //

/** A Map-backed store: used by tests and as a fallback when no SQLite backend is
 *  available, so the probe logic never depends on the storage layer. */
/** 基于 Map 的存储：测试使用，也可在没有 SQLite 后端时兜底，使探测逻辑永远不依赖存储层。 */
export class MemoryProbeStore implements ProbeStore {
  private readonly rows = new Map<string, ModelProbe>();

  constructor(initial: Iterable<readonly [string, ModelProbe]> = []) {
    for (const [id, probe] of initial) this.rows.set(id, modelProbeFromDict(modelProbeToDict(probe)));
  }

  loadAll(): Array<[string, ModelProbe]> {
    return [...this.rows.entries()].map(([id, probe]) => [
      id,
      modelProbeFromDict(modelProbeToDict(probe)),
    ]);
  }

  apply(changes: ProbeStoreChanges): void {
    for (const [id, probe] of changes.upserts) {
      this.rows.set(id, modelProbeFromDict(modelProbeToDict(probe)));
    }
    for (const id of changes.deletes) this.rows.delete(id);
  }

  /** Raw snapshot, for assertions in tests. */
  /** 原始快照，供测试断言使用。 */
  snapshot(): Map<string, ModelProbe> {
    return new Map(this.rows);
  }
}

// --------------------------------------------------------------------------- //
// Durable Object SQLite store
// Durable Object 的 SQLite 存储
// --------------------------------------------------------------------------- //

/** The subset of `ctx.storage.sql` this module uses. */
/** 本模块用到的 `ctx.storage.sql` 子集。 */
export interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

/**
 * One JSON payload per model. A single row per model keeps the write count at
 * "one row per model probed" and the mapping identical to `to_dict`/`from_dict`,
 * so the stored shape cannot drift from the served shape.
 *
 * 每模型一个 JSON 负载。每模型单行使写入次数恒为"探测一个模型写一行"，且映射与
 * `to_dict`/`from_dict` 完全一致，存储结构不会与对外结构脱节。
 */
export class SqliteProbeStore implements ProbeStore {
  private readonly sql: SqlStorageLike;

  constructor(sql: SqlStorageLike) {
    this.sql = sql;
  }

  /**
   * Create the schema and enforce the version gate: a store written by an older
   * cache version is wiped so every model is re-probed. Idempotent.
   *
   * 建表并执行版本闸门：旧版本写入的存储会被清空，从而全部重探。幂等。
   */
  migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // A MISSING version reads as unknown provenance (-1), NOT as the accidental
    // Number(null) === 0: rows whose shape cannot be shown to match the current
    // one are dropped -- the same rule `parseProbeCacheFile` applies to a file
    // whose version it cannot verify. `Number.isFinite` below is then the real
    // gate: rows present plus a version that is not a number, or any version
    // other than CACHE_VERSION, mean "wipe and re-probe".
    //
    // **缺失的**版本按"来历不明"（-1）处理，而不是巧合地依赖 Number(null) === 0：
    // 无法证明这些行的结构与当前匹配，因此清空——与 `parseProbeCacheFile` 对无法
    // 验证版本的文件所用的规则相同。下面的 `Number.isFinite` 才是真正的闸门：
    // 存在行且版本不是数字（或任何 !== CACHE_VERSION 的版本）意味着"清空重探"。
    const rawVersion = this.readMeta("version");
    const stored = rawVersion === null ? -1 : Number(rawVersion);
    if (stored !== CACHE_VERSION) {
      // Version 1 stored only effort lists and no fingerprint, so its entries
      // cannot be trusted to be complete; re-probe instead of migrating.
      //
      // 版本 1 只存了挡位列表、没有指纹，其条目无法保证完整；直接重探而不做迁移。
      if (Number.isFinite(stored)) this.sql.exec("DELETE FROM models");
      this.writeMeta("version", String(CACHE_VERSION));
    }
  }

  /** Read a bookkeeping value (cache version, resolved upstream prefix, ...). */
  /** 读取一个记账值（缓存版本、已确定的上游前缀等）。 */
  readMeta(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray() as Array<{
      value?: unknown;
    }>;
    if (rows.length === 0) return null;
    const value = rows[0].value;
    return value === undefined || value === null ? null : String(value);
  }

  /** Write a bookkeeping value. */
  /** 写入一个记账值。 */
  writeMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  loadAll(): Array<[string, ModelProbe]> {
    const rows = this.sql
      .exec("SELECT id, data FROM models")
      .toArray() as Array<{ id?: unknown; data?: unknown }>;
    const entries: Array<[string, ModelProbe]> = [];
    for (const row of rows) {
      if (typeof row.id !== "string") continue;
      entries.push([row.id, modelProbeFromDict(parseJson(row.data))]);
    }
    return entries;
  }

  apply(changes: ProbeStoreChanges): void {
    for (const [id, probe] of changes.upserts) {
      this.sql.exec(
        "INSERT INTO models (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        id,
        JSON.stringify(modelProbeToDict(probe)),
      );
    }
    for (const id of changes.deletes) {
      this.sql.exec("DELETE FROM models WHERE id = ?", id);
    }
  }

  count(): number {
    const rows = this.sql.exec("SELECT COUNT(*) AS n FROM models").toArray() as Array<{
      n?: unknown;
    }>;
    return rows.length > 0 ? Number(rows[0].n) || 0 : 0;
  }
}

// --------------------------------------------------------------------------- //
// JSON cache file (upstream-compatible format)
// JSON 缓存文件（与上游一致的格式）
// --------------------------------------------------------------------------- //

/** Serialize every entry into the upstream file shape. */
/** 把全部条目序列化成上游的文件结构。 */
export function serializeProbeCacheFile(entries: ReadonlyArray<readonly [string, ModelProbe]>): string {
  const models: Record<string, unknown> = {};
  for (const [id, probe] of entries) models[id] = modelProbeToDict(probe);
  return JSON.stringify({ version: CACHE_VERSION, models }, null, 2);
}

/**
 * Parse a cache file. A missing, corrupt or older-version file yields no entries
 * (a re-probe is annoying, not fatal), mirroring the upstream loader.
 *
 * 解析缓存文件。文件缺失、损坏或版本较旧时不返回任何条目（重探一遍很烦，但不致命），
 * 与上游加载器的行为一致。
 */
export function parseProbeCacheFile(raw: unknown): Array<[string, ModelProbe]> {
  let payload = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!isPlainObject(payload)) return [];
  if (Number(payload.version) !== CACHE_VERSION) return [];
  const models = payload.models;
  if (!isPlainObject(models)) return [];
  const entries: Array<[string, ModelProbe]> = [];
  for (const [id, entry] of Object.entries(models)) {
    if (!isPlainObject(entry)) continue;
    entries.push([id, modelProbeFromDict(entry)]);
  }
  return entries;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
