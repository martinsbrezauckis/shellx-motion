import { canonicalJson } from "./canonical-json";
import { evaluateMotionPathFollow } from "./motion-path-follow";
import {
  MAX_MOTION_BEHAVIOR_BINDING_BYTES,
  MAX_MOTION_BEHAVIOR_DURATION_US,
  MAX_MOTION_BEHAVIOR_STORE_BYTES,
  MOTION_BEHAVIORS_SCHEMA,
  type MotionBehavior,
  type MotionBehaviorStore,
  type MotionPathFollowBehavior,
  type MotionTransformBehavior,
} from "./motion-behavior-types";
import type { MotionShapeGeometry } from "./motion-shape-geometry-types";
import type { MotionEasing } from "./types";

const MAX_RECORD_KEYS = 12;
const MAX_TOTAL_KEYS = 640;
const MAX_NODES = 256;
const MAX_DEPTH = 5;

/** Descriptor-first bounded snapshot for public behavior storage and timing requests. */
export function snapshotMotionBehaviorData(value: unknown): unknown {
  return clone(value, { active: new WeakSet<object>(), nodes: 0, keys: 0, bytes: 0 }, 0);
}

/** Reads only the exact persistent behavior store; beat requests are intentionally absent here. */
export function readMotionBehaviorStore(value: unknown): MotionBehaviorStore {
  const snapshot = snapshotMotionBehaviorData(value);
  const record = exactRecord(snapshot, ["schema", "bindings"], [], "Motion behaviors");
  if (record.schema !== MOTION_BEHAVIORS_SCHEMA) throw new Error(`Motion behaviors schema must equal ${MOTION_BEHAVIORS_SCHEMA}.`);
  const entries = exactArray(record.bindings, "Motion behaviors bindings", 32);
  if (entries.length === 0) throw new Error("Motion behaviors bindings must contain 1..32 entries.");
  const bindings = entries.map((entry, index) => readBinding(entry, index));
  for (const binding of bindings) {
    if (Buffer.byteLength(canonicalJson(binding), "utf8") > MAX_MOTION_BEHAVIOR_BINDING_BYTES) {
      throw new Error(`Motion behavior ${binding.targetLayerId} exceeds the ${MAX_MOTION_BEHAVIOR_BINDING_BYTES}-byte binding limit.`);
    }
  }
  if (Buffer.byteLength(canonicalJson({ schema: MOTION_BEHAVIORS_SCHEMA, bindings }), "utf8") > MAX_MOTION_BEHAVIOR_STORE_BYTES) {
    throw new Error(`Motion behaviors exceed the ${MAX_MOTION_BEHAVIOR_STORE_BYTES}-byte store limit.`);
  }
  return { schema: MOTION_BEHAVIORS_SCHEMA, bindings };
}

function readBinding(value: unknown, index: number): MotionBehavior {
  const initial = dataRecord(value, `Motion behaviors bindings[${index}]`);
  const kind = initial.kind;
  if (kind === "path-follow") return readPathFollow(initial, index);
  if (kind === "transform") return readTransform(initial, index);
  throw new Error(`Motion behaviors bindings[${index}].kind must be path-follow or transform.`);
}

function readPathFollow(value: Record<string, unknown>, index: number): MotionPathFollowBehavior {
  const label = `Motion behaviors bindings[${index}]`;
  const record = exactRecord(value, ["targetLayerId", "enabled", "kind", "startUs", "durationUs", "geometry"], ["offsetUs", "direction", "orientToPath", "easing"], label);
  const common = readCommon(record, label);
  const result = evaluateMotionPathFollow({
    schema: "shellx-motion/path-follow@1", atUs: common.startUs, startUs: common.startUs, durationUs: common.durationUs,
    geometry: record.geometry, ...(Object.hasOwn(record, "offsetUs") ? { offsetUs: record.offsetUs } : {}),
    ...(Object.hasOwn(record, "direction") ? { direction: record.direction } : {}),
    ...(Object.hasOwn(record, "orientToPath") ? { orientToPath: record.orientToPath } : {}),
    ...(Object.hasOwn(record, "easing") ? { easing: record.easing } : {}),
  });
  if (!result.ok) throw new Error(`${label} path-follow ${result.message}`);
  return {
    ...common, kind: "path-follow", geometry: record.geometry as Extract<MotionShapeGeometry, { kind: "path" }>,
    ...(Object.hasOwn(record, "offsetUs") ? { offsetUs: record.offsetUs as number } : {}),
    ...(Object.hasOwn(record, "direction") ? { direction: record.direction as "forward" | "reverse" } : {}),
    ...(Object.hasOwn(record, "orientToPath") ? { orientToPath: record.orientToPath as boolean } : {}),
    ...(Object.hasOwn(record, "easing") ? { easing: record.easing as MotionEasing } : {}),
  };
}

function readTransform(value: Record<string, unknown>, index: number): MotionTransformBehavior {
  const label = `Motion behaviors bindings[${index}]`;
  const record = exactRecord(value, ["targetLayerId", "enabled", "kind", "startUs", "durationUs"], ["motion", "squash"], label);
  const common = readCommon(record, label);
  if (!Object.hasOwn(record, "motion") && !Object.hasOwn(record, "squash")) throw new Error(`${label} transform requires motion or squash.`);
  if (Object.hasOwn(record, "motion")) readTransformMotion(record.motion, `${label}.motion`);
  if (Object.hasOwn(record, "squash")) readSquash(record.squash, `${label}.squash`);
  return {
    ...common, kind: "transform",
    ...(Object.hasOwn(record, "motion") ? { motion: record.motion as MotionTransformBehavior["motion"] } : {}),
    ...(Object.hasOwn(record, "squash") ? { squash: record.squash as MotionTransformBehavior["squash"] } : {}),
  };
}

function readCommon(value: Record<string, unknown>, label: string): Pick<MotionBehavior, "targetLayerId" | "enabled" | "startUs" | "durationUs"> {
  if (typeof value.targetLayerId !== "string" || value.targetLayerId.length === 0) throw new Error(`${label}.targetLayerId must be a non-empty string.`);
  if (typeof value.enabled !== "boolean") throw new Error(`${label}.enabled must be boolean.`);
  const startUs = safeUs(value.startUs, `${label}.startUs`), durationUs = safeUs(value.durationUs, `${label}.durationUs`);
  if (durationUs === 0 || durationUs > MAX_MOTION_BEHAVIOR_DURATION_US) throw new Error(`${label}.durationUs must be in 1..${MAX_MOTION_BEHAVIOR_DURATION_US}.`);
  if (!Number.isSafeInteger(startUs + durationUs)) throw new Error(`${label} startUs plus durationUs exceeds safe integer microseconds.`);
  return { targetLayerId: value.targetLayerId, enabled: value.enabled, startUs, durationUs };
}

function readTransformMotion(value: unknown, label: string): void {
  const record = dataRecord(value, label);
  if (record.kind === "gravity") exactRecord(record, ["kind", "velocityX", "velocityY", "gravityY"], [], label);
  else if (record.kind === "bounce") exactRecord(record, ["kind", "floorY", "velocityY", "gravityY", "restitution"], [], label);
  else throw new Error(`${label}.kind must be gravity or bounce.`);
}

function readSquash(value: unknown, label: string): void {
  const record = exactRecord(value, ["kind", "axis", "amount"], [], label);
  if (record.kind !== "squash" || (record.axis !== "vertical" && record.axis !== "horizontal")) throw new Error(`${label} must be a vertical or horizontal squash.`);
}

function clone(value: unknown, state: { active: WeakSet<object>; nodes: number; keys: number; bytes: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_MOTION_BEHAVIOR_STORE_BYTES) throw new Error(`Motion behaviors exceed the ${MAX_MOTION_BEHAVIOR_STORE_BYTES}-byte store limit.`);
    return value;
  }
  if (typeof value !== "object") throw new Error("Motion behaviors must contain only JSON data.");
  if (depth > MAX_DEPTH) throw new Error("Motion behaviors exceed their nesting limit.");
  if (state.active.has(value)) throw new Error("Motion behaviors must not contain cycles.");
  let array: boolean, keys: readonly PropertyKey[];
  try { array = Array.isArray(value); keys = Reflect.ownKeys(value); } catch { throw new Error("Motion behaviors data reflection failed."); }
  const keyLimit = array ? 33 : MAX_RECORD_KEYS;
  if (keys.length > keyLimit) throw new Error(`Motion behaviors data exceeds the ${keyLimit}-field ${array ? "array" : "record"} limit.`);
  if (state.keys + keys.length > MAX_TOTAL_KEYS) throw new Error(`Motion behaviors data exceeds the ${MAX_TOTAL_KEYS}-field aggregate limit.`);
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("Motion behaviors data reflection failed."); }
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("Motion behaviors must contain only plain data objects and arrays.");
  if (keys.some((key) => typeof key !== "string")) throw new Error("Motion behaviors must not contain symbol fields.");
  if (state.nodes >= MAX_NODES) throw new Error(`Motion behaviors exceed the ${MAX_NODES}-node limit.`);
  state.active.add(value); state.nodes += 1; state.keys += keys.length;
  try { return array ? cloneArray(value, keys, state, depth) : cloneRecord(value, keys, state, depth); } finally { state.active.delete(value); }
}

function cloneRecord(value: object, keys: readonly PropertyKey[], state: Parameters<typeof clone>[1], depth: number): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Motion behaviors data.${String(key)} must be an enumerable data field.`);
    Object.defineProperty(snapshot, key, { value: clone(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return snapshot;
}

function cloneArray(value: object, keys: readonly PropertyKey[], state: Parameters<typeof clone>[1], depth: number): unknown[] {
  const length = descriptorOf(value, "length");
  if (!("value" in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 32 || keys.length !== length.value + 1 || !keys.includes("length")) throw new Error("Motion behaviors arrays must be dense and contain at most 32 entries.");
  const snapshot: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const key = String(index); if (!keys.includes(key)) throw new Error("Motion behaviors arrays must be dense and contain no extension fields.");
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Motion behaviors data.${key} must be an enumerable data field.`);
    Object.defineProperty(snapshot, index, { value: clone(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return snapshot;
}

function descriptorOf(value: object, key: PropertyKey): PropertyDescriptor {
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) throw new Error("missing"); return descriptor; }
  catch { throw new Error("Motion behaviors data reflection failed."); }
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const record = dataRecord(value, label), allowed = [...required, ...optional];
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const key of required) if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}.`);
  return record;
}
function exactArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a dense array with at most ${maximum} entries.`);
  return value;
}
function safeUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`);
  return value;
}
