/**
 * JSON shape helpers shared by the parser modules.
 *
 * Three modules used to carry their own copy of `isPlainObject` (modelProbe.ts,
 * modelCatalog.ts, probeStore.ts). They all mean the same thing by it -- "an object
 * we may index by key, unlike null, an array or a primitive" -- and a divergence
 * between the copies would silently change what each parser accepts, so it lives
 * here once.
 *
 * JSON 形状辅助函数，供各解析模块共用。
 *
 * 三个模块（modelProbe.ts、modelCatalog.ts、probeStore.ts）此前各自带一份
 * `isPlainObject`。它们的含义完全相同——"可以按键取值的对象，而不是 null、数组或原始值"
 * ——而几份副本一旦出现差异，就会静默改变各解析器接受的输入，因此这里只保留一份。
 */

/**
 * Whether a value is a JSON object (not null, not an array).
 *
 * 判断一个值是否为 JSON 对象（既不是 null，也不是数组）。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
