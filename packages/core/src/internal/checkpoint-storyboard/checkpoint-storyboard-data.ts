import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "../../canonical-json";
import {
  MAX_CHECKPOINT_STORYBOARD_OBJECTS, MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES,
} from "./checkpoint-storyboard-types";

const MAX_DEPTH = 12;
const MAX_NODES = 2_048;
const MAX_RECORD_FIELDS = 24;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Copies descriptor data through bounded own descriptors before semantic validation can invoke getters. */
export function snapshotCheckpointStoryboardData(value: unknown): unknown {
  return snapshot(value, { active: new WeakSet<object>(), nodes: 0, bytes: 0 }, 0);
}

function snapshot(value: unknown, state: { active: WeakSet<object>; nodes: number; bytes: number }, depth: number): unknown {
  if (value === null) { charge(state, 4); return value; }
  if (typeof value === "boolean") { charge(state, 5); return value; }
  if (typeof value === "number") { charge(state, 24); return value; }
  if (typeof value === "string") {
    charge(state, Buffer.byteLength(value, "utf8") + 2);
    return value;
  }
  if (typeof value !== "object") throw new Error("Checkpoint storyboard data must contain only JSON values.");
  if (depth > MAX_DEPTH) throw new Error(`Checkpoint storyboard exceeds the ${MAX_DEPTH}-level depth limit.`);
  if (state.active.has(value)) throw new Error("Checkpoint storyboard data must not contain cycles.");
  let array: boolean;
  try { array = Array.isArray(value); } catch { throw new Error("Checkpoint storyboard data reflection failed."); }
  const declaredLength = array ? readArrayLengthBeforeKeys(value) : undefined;
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); } catch { throw new Error("Checkpoint storyboard data reflection failed."); }
  const limit = array ? MAX_CHECKPOINT_STORYBOARD_OBJECTS + 1 : MAX_RECORD_FIELDS;
  if (keys.length > limit) throw new Error(`Checkpoint storyboard data exceeds its ${limit}-field ${array ? "array" : "record"} limit.`);
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("Checkpoint storyboard data must not contain symbol fields.");
    charge(state, Buffer.byteLength(key, "utf8") + 3);
  }
  if (array && (keys.length !== declaredLength! + 1 || !keys.includes("length"))) throw new Error(`Checkpoint storyboard arrays must be dense and contain at most ${MAX_CHECKPOINT_STORYBOARD_OBJECTS} entries.`);
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("Checkpoint storyboard data reflection failed."); }
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("Checkpoint storyboard data must use only plain objects and arrays.");
  if (state.nodes >= MAX_NODES) throw new Error(`Checkpoint storyboard exceeds the ${MAX_NODES}-node limit.`);
  state.nodes += 1; charge(state, 8); state.active.add(value);
  try { return array ? snapshotArray(value, keys, state, depth) : snapshotRecord(value, keys, state, depth); }
  finally { state.active.delete(value); }
}

function readArrayLengthBeforeKeys(value: object): number {
  const length = descriptorOf(value, "length");
  if (!("value" in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_CHECKPOINT_STORYBOARD_OBJECTS) throw new Error(`Checkpoint storyboard arrays must be dense and contain at most ${MAX_CHECKPOINT_STORYBOARD_OBJECTS} entries.`);
  return length.value;
}

function charge(state: { bytes: number }, amount: number): void {
  state.bytes += amount;
  if (state.bytes > MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES) throw new Error(`Checkpoint storyboard exceeds the ${MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES}-byte storage limit.`);
}

function descriptorOf(value: object, key: PropertyKey): PropertyDescriptor {
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) throw new Error("missing"); return descriptor; }
  catch { throw new Error("Checkpoint storyboard data reflection failed."); }
}
function snapshotRecord(value: object, keys: readonly PropertyKey[], state: Parameters<typeof snapshot>[1], depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Checkpoint storyboard data.${String(key)} must be an enumerable data field.`);
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, state, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function snapshotArray(value: object, keys: readonly PropertyKey[], state: Parameters<typeof snapshot>[1], depth: number): unknown[] {
  const length = descriptorOf(value, "length");
  if (!("value" in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_CHECKPOINT_STORYBOARD_OBJECTS || keys.length !== length.value + 1 || !keys.includes("length")) throw new Error(`Checkpoint storyboard arrays must be dense and contain at most ${MAX_CHECKPOINT_STORYBOARD_OBJECTS} entries.`);
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const key = String(index); if (!keys.includes(key)) throw new Error("Checkpoint storyboard arrays must be dense and contain no extension fields.");
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Checkpoint storyboard data.${key} must be an enumerable data field.`);
    Object.defineProperty(result, index, { value: snapshot(descriptor.value, state, depth + 1), enumerable: true, writable: true, configurable: true });
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
export function exactArray(value: unknown, label: string, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}..${maximum} entries.`);
  return value;
}
export function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe stable id.`);
  return value;
}
export function safeUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`);
  return value;
}
export function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase sha256 hash.`);
  return value;
}
export function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be finite and in ${minimum}..${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}
export function strictIds(values: readonly string[], label: string): void {
  if (values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1]!, value) >= 0)) throw new Error(`${label} must be strict code-unit ascending and unique.`);
}
export function sealed(prefix: string, payload: Record<string, unknown>): { id: string; sha256: string } {
  const hash = canonicalJsonSha256(payload); return { id: `${prefix}_${hash.slice(0, 32)}`, sha256: hash };
}
export function assertSealed(prefix: string, record: Record<string, unknown>, payload: Record<string, unknown>): void {
  const expected = sealed(prefix, payload);
  if (record.id !== expected.id || record.sha256 !== expected.sha256) throw new Error(`${prefix} canonical id or sha256 is stale.`);
}
export function storageBytes(value: unknown): number { return Buffer.byteLength(canonicalJson(value), "utf8"); }
export function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
