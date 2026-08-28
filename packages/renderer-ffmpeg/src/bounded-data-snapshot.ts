const SNAPSHOT_REJECTED = Symbol("snapshot-rejected");
const SNAPSHOT_MAX_DEPTH = 32;
const SNAPSHOT_MAX_NODES = 4_096;
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * Copy untrusted receipt evidence through bounded own data descriptors only. Unsupported
 * prototypes, accessors, cycles, deep structures, and excessive node growth all refuse.
 */
export function readBoundedDataRecord(value: unknown): Record<string, unknown> | undefined {
  const snapshot = snapshotBoundedData(value);
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : undefined;
}

function snapshotBoundedData(value: unknown): unknown | typeof SNAPSHOT_REJECTED {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): unknown | typeof SNAPSHOT_REJECTED => {
    if (candidate === null || candidate === undefined || typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") return candidate;
    if (typeof candidate !== "object" || depth > SNAPSHOT_MAX_DEPTH || ++nodes > SNAPSHOT_MAX_NODES) return SNAPSHOT_REJECTED;
    try {
      if (active.has(candidate)) return SNAPSHOT_REJECTED;
      active.add(candidate);
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const prototype = Object.getPrototypeOf(candidate);
      if (Array.isArray(candidate)) return snapshotArray(descriptors, candidate, prototype, visit, depth);
      if (prototype !== Object.prototype && prototype !== null) return SNAPSHOT_REJECTED;
      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") return SNAPSHOT_REJECTED;
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return SNAPSHOT_REJECTED;
        const nested = visit(descriptor.value, depth + 1);
        if (nested === SNAPSHOT_REJECTED) return SNAPSHOT_REJECTED;
        Object.defineProperty(copy, key, { value: nested, enumerable: true, configurable: true, writable: true });
      }
      return copy;
    } catch {
      return SNAPSHOT_REJECTED;
    } finally {
      if (candidate && typeof candidate === "object") active.delete(candidate);
    }
  };
  return visit(value, 0);
}

function snapshotArray(
  descriptors: PropertyDescriptorMap,
  value: readonly unknown[],
  prototype: object | null,
  visit: (candidate: unknown, depth: number) => unknown | typeof SNAPSHOT_REJECTED,
  depth: number
): unknown[] | typeof SNAPSHOT_REJECTED {
  if (prototype !== Array.prototype) return SNAPSHOT_REJECTED;
  const length = descriptors.length;
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > SNAPSHOT_MAX_NODES) return SNAPSHOT_REJECTED;
  const copy: unknown[] = new Array(length.value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !ARRAY_INDEX.test(key)) return SNAPSHOT_REJECTED;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return SNAPSHOT_REJECTED;
    const nested = visit(descriptor.value, depth + 1);
    if (nested === SNAPSHOT_REJECTED) return SNAPSHOT_REJECTED;
    Object.defineProperty(copy, key, { value: nested, enumerable: true, configurable: true, writable: true });
  }
  return copy;
}
