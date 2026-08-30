import type { MotionDocument } from "./types";

const MAX_DEPTH = 32;
const MAX_NODES = 8_192;
const MAX_ARRAY_LENGTH = 4_096;
const MAX_UTF8_BYTES = 1_048_576;

export type LinearSrgbSdrFinalMotionAdmission =
  | Readonly<{ readonly ok: true; readonly motion: MotionDocument }>
  | Readonly<{ readonly ok: false; readonly message: string }>;

/**
 * Detaches the caller's Motion value before the strict route examines a field or fingerprints
 * it. Every field crosses through an own enumerable data descriptor; getters,
 * sparse arrays, exotic prototypes, reflection-failing proxies, cycles, and
 * oversized data fail closed. The returned tree is plain, deep-frozen JSON.
 */
export function admitLinearSrgbSdrFinalMotion(value: unknown): LinearSrgbSdrFinalMotionAdmission {
  try {
    const snapshot = materialize(value, { nodes: 0, utf8Bytes: 0, active: new WeakSet<object>() }, 0);
    if (!plainRecord(snapshot)) throw new Error("requires a plain Motion document");
    return Object.freeze({ ok: true, motion: snapshot as unknown as MotionDocument });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("linear-srgb-sdr final admission")
      ? error.message
      : "linear-srgb-sdr final admission refuses hostile or malformed Motion data.";
    return Object.freeze({ ok: false, message });
  }
}

interface SnapshotState { nodes: number; utf8Bytes: number; active: WeakSet<object>; }

function materialize(value: unknown, state: SnapshotState, depth: number): unknown {
  if (depth > MAX_DEPTH) fail(`exceeds the depth-${MAX_DEPTH} data limit.`);
  state.nodes += 1;
  if (state.nodes > MAX_NODES) fail(`exceeds the ${MAX_NODES}-node data limit.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return copyString(value, state);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("accepts finite JSON numbers only.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("accepts JSON data only.");
  if (state.active.has(value)) fail("refuses cyclic Motion data.");
  state.active.add(value);
  try {
    return Array.isArray(value) ? materializeArray(value, state, depth) : materializeRecord(value, state, depth);
  } finally {
    state.active.delete(value);
  }
}

function materializeArray(value: object, state: SnapshotState, depth: number): readonly unknown[] {
  if (prototype(value) !== Array.prototype) fail("accepts plain JSON arrays only.");
  const length = dataDescriptor(value, "length", "array length");
  if (length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ARRAY_LENGTH) fail("requires dense bounded data arrays.");
  const keys = ownKeys(value);
  if (keys.length !== length.value + 1 || !keys.includes("length")) fail("requires dense data arrays with no extra fields.");
  const snapshot: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) fail("requires dense data arrays.");
    const field = dataDescriptor(value, key, "array entry");
    if (!field.enumerable) fail("requires enumerable data array entries.");
    Object.defineProperty(snapshot, key, { value: materialize(field.value, state, depth + 1), enumerable: true, configurable: false, writable: false });
  }
  return Object.freeze(snapshot);
}

function materializeRecord(value: object, state: SnapshotState, depth: number): Readonly<Record<string, unknown>> {
  if (prototype(value) !== Object.prototype) fail("accepts plain JSON records only.");
  const keys = ownKeys(value);
  if (keys.length > MAX_NODES) fail(`exceeds the ${MAX_NODES}-field data limit.`);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") fail("accepts JSON string keys only.");
    copyString(key, state);
    const field = dataDescriptor(value, key, `field ${key}`);
    if (!field.enumerable) fail(`requires ${key} as an enumerable data field.`);
    Object.defineProperty(snapshot, key, { value: materialize(field.value, state, depth + 1), enumerable: true, configurable: false, writable: false });
  }
  return Object.freeze(snapshot);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function ownKeys(value: object): PropertyKey[] {
  try { return Reflect.ownKeys(value); }
  catch { fail("Motion data reflection failed."); }
}

function dataDescriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor & { value: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { fail(`${label} reflection failed.`); }
  if (!descriptor || !("value" in descriptor)) fail(`${label} must be an own data field.`);
  return descriptor as PropertyDescriptor & { value: unknown };
}

function prototype(value: object): object | null {
  try { return Object.getPrototypeOf(value); }
  catch { fail("Motion data reflection failed."); }
}

function copyString(value: string, state: SnapshotState): string {
  state.utf8Bytes += Buffer.byteLength(value, "utf8");
  if (state.utf8Bytes > MAX_UTF8_BYTES) fail(`exceeds the ${MAX_UTF8_BYTES}-byte string limit.`);
  return value;
}

function fail(message: string): never { throw new Error(`linear-srgb-sdr final admission ${message}`); }
