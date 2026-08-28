import { canonicalJson } from "./canonical-json";
import {
  MAX_MOTION_RELATION_BINDING_BYTES,
  MAX_MOTION_RELATION_BINDINGS,
  MAX_MOTION_RELATION_COORDINATE,
  MAX_MOTION_RELATION_DURATION_US,
  MAX_MOTION_RELATION_ROTATION_DEGREES,
  MAX_MOTION_RELATION_SCALE,
  MAX_MOTION_RELATION_STORE_BYTES,
  MIN_MOTION_RELATION_SCALE,
  MOTION_RELATIONS_SCHEMA,
  type MotionRelationAim,
  type MotionRelationAttach,
  type MotionRelationBinding,
  type MotionRelationEndpoint,
  type MotionRelationOffset,
  type MotionRelationStore,
} from "./motion-relation-types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_RECORD_KEYS = 12;
const MAX_TOTAL_KEYS = 640;
const MAX_NODES = 256;
const MAX_DEPTH = 5;

/** Descriptor-first, bounded snapshot. No getter is read before its own descriptor is accepted. */
export function snapshotMotionRelationData(value: unknown): unknown {
  return clone(value, { active: new WeakSet<object>(), nodes: 0, keys: 0, bytes: 0 }, 0);
}

/** Reads exactly the persisted private relation store; this function has no document ownership authority. */
export function readMotionRelationStore(value: unknown): MotionRelationStore {
  const snapshot = snapshotMotionRelationData(value);
  const record = exactRecord(snapshot, ["schema", "bindings"], [], "Motion relations");
  if (record.schema !== MOTION_RELATIONS_SCHEMA) throw new Error(`Motion relations schema must equal ${MOTION_RELATIONS_SCHEMA}.`);
  const entries = exactArray(record.bindings, "Motion relations bindings", MAX_MOTION_RELATION_BINDINGS);
  if (entries.length === 0) throw new Error(`Motion relations bindings must contain 1..${MAX_MOTION_RELATION_BINDINGS} entries.`);
  const bindings = entries.map((entry, index) => readBinding(entry, index));
  for (const binding of bindings) {
    if (Buffer.byteLength(canonicalJson(binding), "utf8") > MAX_MOTION_RELATION_BINDING_BYTES) {
      throw new Error(`Motion relation ${binding.id} exceeds the ${MAX_MOTION_RELATION_BINDING_BYTES}-byte binding limit.`);
    }
  }
  if (Buffer.byteLength(canonicalJson({ schema: MOTION_RELATIONS_SCHEMA, bindings }), "utf8") > MAX_MOTION_RELATION_STORE_BYTES) {
    throw new Error(`Motion relations exceed the ${MAX_MOTION_RELATION_STORE_BYTES}-byte store limit.`);
  }
  return { schema: MOTION_RELATIONS_SCHEMA, bindings };
}

function readBinding(value: unknown, index: number): MotionRelationBinding {
  const record = dataRecord(value, `Motion relations bindings[${index}]`);
  if (record.kind === "attach") return readAttach(record, index);
  if (record.kind === "aim") return readAim(record, index);
  throw new Error(`Motion relations bindings[${index}].kind must be attach or aim.`);
}

function readAttach(value: Record<string, unknown>, index: number): MotionRelationAttach {
  const label = `Motion relations bindings[${index}]`;
  const record = exactRecord(value, ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "mode", "offset"], [], label);
  const common = readCommon(record, label);
  if (record.mode !== "follow" && record.mode !== "similarity") throw new Error(`${label}.mode must be follow or similarity.`);
  const offset = readOffset(record.offset, `${label}.offset`);
  if (record.mode === "follow" && (offset.rotationDeg !== 0 || offset.scale !== 1)) {
    throw new Error(`${label} follow requires offset.rotationDeg 0 and offset.scale 1.`);
  }
  return { ...common, kind: "attach", mode: record.mode, offset };
}

function readAim(value: Record<string, unknown>, index: number): MotionRelationAim {
  const label = `Motion relations bindings[${index}]`;
  const record = exactRecord(value, ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "rotationOffsetDeg"], [], label);
  return { ...readCommon(record, label), kind: "aim", rotationOffsetDeg: boundedNumber(record.rotationOffsetDeg, -MAX_MOTION_RELATION_ROTATION_DEGREES, MAX_MOTION_RELATION_ROTATION_DEGREES, `${label}.rotationOffsetDeg`) };
}

function readCommon(value: Record<string, unknown>, label: string): Omit<MotionRelationAttach, "kind" | "mode" | "offset"> {
  if (typeof value.id !== "string" || !SAFE_ID.test(value.id)) throw new Error(`${label}.id must be a safe 1..64 character id.`);
  if (typeof value.enabled !== "boolean") throw new Error(`${label}.enabled must be boolean.`);
  const startUs = safeUs(value.startUs, `${label}.startUs`);
  const durationUs = safeUs(value.durationUs, `${label}.durationUs`);
  if (durationUs === 0 || durationUs > MAX_MOTION_RELATION_DURATION_US) throw new Error(`${label}.durationUs must be in 1..${MAX_MOTION_RELATION_DURATION_US}.`);
  if (!Number.isSafeInteger(startUs + durationUs)) throw new Error(`${label} startUs plus durationUs exceeds safe integer microseconds.`);
  return { id: value.id, enabled: value.enabled, source: readEndpoint(value.source, `${label}.source`), target: readEndpoint(value.target, `${label}.target`), startUs, durationUs };
}

function readEndpoint(value: unknown, label: string): MotionRelationEndpoint {
  const record = exactRecord(value, ["layerId", "anchor"], [], label);
  if (typeof record.layerId !== "string" || !SAFE_ID.test(record.layerId)) throw new Error(`${label}.layerId must be a safe 1..64 character id.`);
  const anchor = exactRecord(record.anchor, ["x", "y"], [], `${label}.anchor`);
  return {
    layerId: record.layerId,
    anchor: {
      x: boundedNumber(anchor.x, -MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, `${label}.anchor.x`),
      y: boundedNumber(anchor.y, -MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, `${label}.anchor.y`),
    },
  };
}

function readOffset(value: unknown, label: string): MotionRelationOffset {
  const record = exactRecord(value, ["space", "x", "y", "rotationDeg", "scale"], [], label);
  if (record.space !== "source" && record.space !== "world") throw new Error(`${label}.space must be source or world.`);
  return {
    space: record.space,
    x: boundedNumber(record.x, -MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, `${label}.x`),
    y: boundedNumber(record.y, -MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, `${label}.y`),
    rotationDeg: boundedNumber(record.rotationDeg, -MAX_MOTION_RELATION_ROTATION_DEGREES, MAX_MOTION_RELATION_ROTATION_DEGREES, `${label}.rotationDeg`),
    scale: boundedNumber(record.scale, MIN_MOTION_RELATION_SCALE, MAX_MOTION_RELATION_SCALE, `${label}.scale`),
  };
}

function clone(value: unknown, state: { active: WeakSet<object>; nodes: number; keys: number; bytes: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_MOTION_RELATION_STORE_BYTES) throw new Error(`Motion relations exceed the ${MAX_MOTION_RELATION_STORE_BYTES}-byte store limit.`);
    return value;
  }
  if (typeof value !== "object") throw new Error("Motion relations must contain only JSON data.");
  if (depth > MAX_DEPTH) throw new Error("Motion relations exceed their nesting limit.");
  if (state.active.has(value)) throw new Error("Motion relations must not contain cycles.");
  let array: boolean, keys: readonly PropertyKey[];
  try { array = Array.isArray(value); keys = Reflect.ownKeys(value); } catch { throw new Error("Motion relations data reflection failed."); }
  const keyLimit = array ? MAX_MOTION_RELATION_BINDINGS + 1 : MAX_RECORD_KEYS;
  if (keys.length > keyLimit) throw new Error(`Motion relations data exceeds the ${keyLimit}-field ${array ? "array" : "record"} limit.`);
  if (state.keys + keys.length > MAX_TOTAL_KEYS) throw new Error(`Motion relations data exceeds the ${MAX_TOTAL_KEYS}-field aggregate limit.`);
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("Motion relations data reflection failed."); }
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("Motion relations must contain only plain data objects and arrays.");
  if (keys.some((key) => typeof key !== "string")) throw new Error("Motion relations must not contain symbol fields.");
  if (state.nodes >= MAX_NODES) throw new Error(`Motion relations exceed the ${MAX_NODES}-node limit.`);
  state.active.add(value); state.nodes += 1; state.keys += keys.length;
  try { return array ? cloneArray(value, keys, state, depth) : cloneRecord(value, keys, state, depth); } finally { state.active.delete(value); }
}

function cloneRecord(value: object, keys: readonly PropertyKey[], state: Parameters<typeof clone>[1], depth: number): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Motion relations data.${String(key)} must be an enumerable data field.`);
    Object.defineProperty(snapshot, key, { value: clone(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return snapshot;
}

function cloneArray(value: object, keys: readonly PropertyKey[], state: Parameters<typeof clone>[1], depth: number): unknown[] {
  const length = descriptorOf(value, "length");
  if (!("value" in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_MOTION_RELATION_BINDINGS || keys.length !== length.value + 1 || !keys.includes("length")) throw new Error(`Motion relations arrays must be dense and contain at most ${MAX_MOTION_RELATION_BINDINGS} entries.`);
  const snapshot: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const key = String(index); if (!keys.includes(key)) throw new Error("Motion relations arrays must be dense and contain no extension fields.");
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Motion relations data.${key} must be an enumerable data field.`);
    Object.defineProperty(snapshot, index, { value: clone(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return snapshot;
}

function descriptorOf(value: object, key: PropertyKey): PropertyDescriptor {
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) throw new Error("missing"); return descriptor; }
  catch { throw new Error("Motion relations data reflection failed."); }
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
function boundedNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be a finite number in ${minimum}..${maximum}.`);
  return value;
}
