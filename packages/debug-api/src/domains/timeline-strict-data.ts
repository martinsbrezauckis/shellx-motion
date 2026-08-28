/** Descriptor-first bounded JSON-data clone for hostile Debug transport arguments. */
export type StrictDataParseResult<T> = { ok: true; value: T } | { ok: false; problem: string };

const MAX_STRICT_DATA_DEPTH = 32;
const MAX_STRICT_DATA_ARRAY_ITEMS = 512;
const MAX_STRICT_DATA_OBJECT_FIELDS = 512;

/** Refuses accessors, symbols, cycles, sparse arrays, and reflective proxy traps without invoking a getter. */
export function readStrictDataRecord(value: unknown, label: string): StrictDataParseResult<Record<string, unknown>> {
  try {
    const result = cloneData(value, label, new WeakSet<object>(), 0);
    if (!result.ok) return result;
    if (Array.isArray(result.value) || typeof result.value !== "object" || result.value === null) return fail(`${label} must be a plain data object.`);
    return ok(result.value);
  } catch {
    return fail(`${label} must be plain JSON data.`);
  }
}

/**
 * Reads a small, closed command envelope while deliberately leaving named
 * values for their domain reader. The field-count check happens immediately
 * after `ownKeys`: a hostile envelope therefore cannot make us request one
 * descriptor per supplied key before its command-specific cap is enforced.
 */
export function readStrictDataRecordEnvelope(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  opaqueKeys: readonly string[] = [],
): StrictDataParseResult<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${label} must be a plain data object.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail(`${label} must be a plain data object.`);

    // Do not move this below descriptor reads. `ownKeys` can describe an
    // arbitrarily large Proxy target, while this command has an exact small
    // closed vocabulary.
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowedKeys.length) return fail(`${label} exceeds the ${allowedKeys.length}-field command allowance.`);

    const allowed = new Set(allowedKeys);
    const opaque = new Set(opaqueKeys);
    const stringKeys: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") return fail(`${label} must not contain symbol keys.`);
      if (!allowed.has(key)) return fail(`Unknown argument: ${key}.`);
      stringKeys.push(key);
    }

    const result = Object.create(null) as Record<string, unknown>;
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return fail(`${label}.${key} must be an enumerable data field.`);
      if (opaque.has(key)) {
        Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
        continue;
      }
      const nested = cloneData(descriptor.value, `${label}.${key}`, new WeakSet<object>(), 1);
      if (!nested.ok) return nested;
      Object.defineProperty(result, key, { value: nested.value, enumerable: true, configurable: true, writable: true });
    }
    return ok(result);
  } catch {
    return fail(`${label} must be plain JSON data.`);
  }
}

type StrictData = null | boolean | number | string | StrictDataArray | StrictDataRecord;
interface StrictDataArray extends Array<StrictData> {}
interface StrictDataRecord { [key: string]: StrictData; }

function cloneData(value: unknown, label: string, ancestors: WeakSet<object>, depth: number): StrictDataParseResult<StrictData> {
  if (depth > MAX_STRICT_DATA_DEPTH) return fail(`${label} exceeds the ${MAX_STRICT_DATA_DEPTH}-level data depth limit.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return ok(value);
  if (typeof value === "number") return Number.isFinite(value) ? ok(value) : fail(`${label} must be finite.`);
  if (Array.isArray(value)) return cloneArray(value, label, ancestors, depth);
  if (typeof value === "object") return cloneRecord(value, label, ancestors, depth);
  return fail(`${label} must be JSON data.`);
}

function cloneRecord(value: object, label: string, ancestors: WeakSet<object>, depth: number): StrictDataParseResult<StrictDataRecord> {
  if (ancestors.has(value)) return fail(`${label} must not contain cycles.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(`${label} must be a plain data object.`);
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    // Cap immediately after the one bounded reflection operation. A hostile Proxy can report an
    // enormous key set; never allocate or walk a mirror of it before the product field limit.
    if (keys.length > MAX_STRICT_DATA_OBJECT_FIELDS) return fail(`${label} exceeds the ${MAX_STRICT_DATA_OBJECT_FIELDS}-field data limit.`);
    const stringKeys: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") return fail(`${label} must not contain symbol keys.`);
      stringKeys.push(key);
    }
    const clone: StrictDataRecord = Object.create(null) as StrictDataRecord;
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable) return fail(`${label}.${key} must be an enumerable data field.`);
      if (!("value" in descriptor)) return fail(`${label}.${key} must be a data property.`);
      const nested = cloneData(descriptor.value, `${label}.${key}`, ancestors, depth + 1);
      if (!nested.ok) return nested;
      Object.defineProperty(clone, key, { value: nested.value, enumerable: true, configurable: true, writable: true });
    }
    return ok(clone);
  } finally {
    ancestors.delete(value);
  }
}

function cloneArray(value: unknown[], label: string, ancestors: WeakSet<object>, depth: number): StrictDataParseResult<StrictDataArray> {
  if (ancestors.has(value)) return fail(`${label} must not contain cycles.`);
  ancestors.add(value);
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_STRICT_DATA_ARRAY_ITEMS) return fail(`${label} exceeds the ${MAX_STRICT_DATA_ARRAY_ITEMS}-item data limit.`);
    const keys = Reflect.ownKeys(value);
    const stringKeys: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") return fail(`${label} must not contain symbol keys.`);
      stringKeys.push(key);
    }
    if (stringKeys.length !== length + 1 || stringKeys.some((key) => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
      return fail(`${label} must be a dense data array without extension fields.`);
    }
    const clone: StrictDataArray = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return fail(`${label}[${index}] must be a data value.`);
      const nested = cloneData(descriptor.value, `${label}[${index}]`, ancestors, depth + 1);
      if (!nested.ok) return nested;
      clone.push(nested.value);
    }
    return ok(clone);
  } finally {
    ancestors.delete(value);
  }
}

function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
