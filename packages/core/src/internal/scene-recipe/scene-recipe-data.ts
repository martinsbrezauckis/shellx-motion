const MAX_DEPTH = 12;
const MAX_NODES = 16_384;
const MAX_ARRAY_ENTRIES = 4_096;
const MAX_RECORD_FIELDS = 24;
const MAX_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Detaches bounded JSON data through own descriptors without invoking getters. */
export function snapshotSceneRecipeData(value: unknown): unknown {
  return snapshot(value, { active: new WeakSet<object>(), nodes: 0, bytes: 0 }, 0);
}

function snapshot(value: unknown, state: State, depth: number): unknown {
  if (value === null) { charge(state, 4); return value; }
  if (typeof value === "boolean") { charge(state, 5); return value; }
  if (typeof value === "number") { charge(state, 24); return value; }
  if (typeof value === "string") { charge(state, Buffer.byteLength(value, "utf8") + 2); return value; }
  if (typeof value !== "object") throw new Error("Scene recipe data must contain only JSON values.");
  if (depth > MAX_DEPTH) throw new Error(`Scene recipe exceeds the ${MAX_DEPTH}-level depth limit.`);
  if (state.active.has(value)) throw new Error("Scene recipe data must not contain cycles.");
  let isArray: boolean;
  try { isArray = Array.isArray(value); } catch { throw new Error("Scene recipe data reflection failed."); }
  const length = isArray ? arrayLength(value) : undefined;
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); } catch { throw new Error("Scene recipe data reflection failed."); }
  const fieldLimit = isArray ? MAX_ARRAY_ENTRIES + 1 : MAX_RECORD_FIELDS;
  if (keys.length > fieldLimit) throw new Error(`Scene recipe data exceeds its ${fieldLimit}-field ${isArray ? "array" : "record"} limit.`);
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("Scene recipe data must not contain symbol fields.");
    charge(state, Buffer.byteLength(key, "utf8") + 3);
  }
  if (isArray && (keys.length !== length! + 1 || !keys.includes("length"))) throw new Error(`Scene recipe arrays must be dense and contain at most ${MAX_ARRAY_ENTRIES} entries.`);
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("Scene recipe data reflection failed."); }
  if (prototype !== (isArray ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("Scene recipe data must use only plain objects and arrays.");
  if (state.nodes >= MAX_NODES) throw new Error(`Scene recipe exceeds the ${MAX_NODES}-node limit.`);
  state.nodes += 1; charge(state, 8); state.active.add(value);
  try { return isArray ? snapshotArray(value, length!, state, depth) : snapshotRecord(value, keys, state, depth); }
  finally { state.active.delete(value); }
}

interface State { active: WeakSet<object>; nodes: number; bytes: number }

function charge(state: State, amount: number): void {
  state.bytes += amount;
  if (state.bytes > MAX_BYTES) throw new Error(`Scene recipe exceeds the ${MAX_BYTES}-byte input limit.`);
}

function descriptor(value: object, key: PropertyKey): PropertyDescriptor {
  try { const result = Object.getOwnPropertyDescriptor(value, key); if (!result) throw new Error("missing"); return result; }
  catch { throw new Error("Scene recipe data reflection failed."); }
}

function arrayLength(value: object): number {
  const result = descriptor(value, "length");
  if (!("value" in result) || result.enumerable || !Number.isSafeInteger(result.value) || result.value < 0 || result.value > MAX_ARRAY_ENTRIES) throw new Error(`Scene recipe arrays must be dense and contain at most ${MAX_ARRAY_ENTRIES} entries.`);
  return result.value;
}

function snapshotRecord(value: object, keys: readonly PropertyKey[], state: State, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptor(value, key);
    if (!("value" in field) || !field.enumerable) throw new Error(`Scene recipe data.${String(key)} must be an enumerable data field.`);
    Object.defineProperty(result, key, { value: snapshot(field.value, state, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function snapshotArray(value: object, length: number, state: State, depth: number): unknown[] {
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const field = descriptor(value, String(index));
    if (!("value" in field) || !field.enumerable) throw new Error(`Scene recipe data.${index} must be an enumerable data field.`);
    Object.defineProperty(result, index, { value: snapshot(field.value, state, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const record = value as Record<string, unknown>, allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  const missing = required.find((key) => !Object.hasOwn(record, key));
  if (missing) throw new Error(`${label} requires ${missing}.`);
  return record;
}

export function exactArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}..${maximum} entries.`);
  return value;
}

export function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe stable id.`);
  return value;
}

export function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be finite and in ${minimum}..${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}

export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be a safe integer in ${minimum}..${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}

export function safeUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 3_600_000_000) throw new Error(`${label} must be a safe integer microsecond in 0..3600000000.`);
  return Object.is(value, -0) ? 0 : value;
}

export function rgb(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^#[a-fA-F0-9]{6}$/.test(value)) throw new Error(`${label} must be #RRGGBB.`);
  return value.toLowerCase();
}

export function vec3(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number, number] {
  const entries = exactArray(value, label, 3, 3);
  return freeze(entries.map((entry, index) => finite(entry, `${label}[${index}]`, minimum, maximum))) as unknown as readonly [number, number, number];
}

export function vec2(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number] {
  const entries = exactArray(value, label, 2, 2);
  return freeze(entries.map((entry, index) => finite(entry, `${label}[${index}]`, minimum, maximum))) as unknown as readonly [number, number];
}

export function strictIds(values: readonly string[], label: string): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) throw new Error(`${label} must be strict code-unit ascending and unique.`);
}

export function uniqueIds(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

export function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
