import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { MAX_SCENE_3D_LAYERS, MAX_SCENE_3D_MESH_INDICES_TOTAL } from "./scene-3d";
import { validateScene3DLayers } from "./scene-3d-validate";
import {
  MAX_MOTION_SCENE3D_ANIMATION_SOURCE_BYTES,
  type MotionScene3DAnimationDescriptor,
  type MotionScene3DAnimationSource,
  type MotionScene3DAnimationSourceLayer,
} from "./motion-scene3d-animation-types";
import { readMotionScene3DAnimationDescriptor } from "./motion-scene3d-animation-read";
import type { MotionScene3D } from "./types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SOURCE_DEPTH = 8;
const MAX_SOURCE_RECORD_FIELDS = 12;
const MAX_SOURCE_KEYS = 100_000;

export interface MotionScene3DAnimationRequest {
  animation: MotionScene3DAnimationDescriptor;
  /** Untouched until descriptor counts and work have been admitted. */
  sourceValue: unknown;
}

export interface ReadMotionScene3DAnimationSource {
  source: MotionScene3DAnimationSource;
  sourceSha256: string;
  objectCount: number;
}

/** Reads the animation descriptor before requesting any nested source-scene property. */
export function readMotionScene3DAnimationRequest(value: unknown): MotionScene3DAnimationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value) || prototypeOf(value, "Scene3d animation request") !== Object.prototype) throw new Error("Scene3d animation request must be a plain object.");
  const keys = ownKeys(value, "Scene3d animation request");
  if (keys.length !== 2 || !keys.includes("animation") || !keys.includes("source") || keys.some((key) => typeof key !== "string")) throw new Error("Scene3d animation request requires exactly animation and source.");
  const animation = dataField(value, "animation", "Scene3d animation request");
  const parsed = readMotionScene3DAnimationDescriptor(animation);
  return Object.freeze({ animation: parsed, sourceValue: dataField(value, "source", "Scene3d animation request") });
}

/** Detaches only existing `scene3d` layer authority, then reuses the canonical scene validator. */
export function readMotionScene3DAnimationSource(value: unknown): ReadMotionScene3DAnimationSource {
  const root = exactRecord(value, ["layers"], "Scene3d animation source", 1);
  const entries = denseArray(root.layers, "Scene3d animation source.layers", MAX_SCENE_3D_LAYERS);
  if (entries.length === 0) throw new Error(`Scene3d animation source.layers must contain 1..${MAX_SCENE_3D_LAYERS} existing scene3d layers.`);
  const state = { active: new WeakSet<object>(), keys: 0, bytes: 0 };
  chargeRecordSyntax(state, ["layers"]); chargeArraySyntax(state, entries.length);
  const layers = entries.map((entry, index) => readLayer(entry, index, state));
  const ids = new Set<string>();
  for (const layer of layers) {
    if (ids.has(layer.id)) throw new Error(`Scene3d animation source layer ${layer.id} must be unique.`);
    ids.add(layer.id);
  }
  const errors: Array<{ path: string; message: string }> = [];
  validateScene3DLayers(layers, errors);
  if (errors.length > 0) throw new Error(`Scene3d animation source is invalid at ${errors[0]!.path}: ${errors[0]!.message}`);
  for (const layer of layers) rejectLegacyTransformDrivers(layer);
  const source = deepFreeze({ layers });
  const sourceBytes = Buffer.byteLength(canonicalJson(source), "utf8");
  if (sourceBytes > MAX_MOTION_SCENE3D_ANIMATION_SOURCE_BYTES) throw new Error(`Scene3d animation source exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_SOURCE_BYTES}-byte input limit.`);
  return Object.freeze({ source, sourceSha256: canonicalJsonSha256(source), objectCount: layers.reduce((total, layer) => total + layer.scene3d.objects.length, 0) });
}

function readLayer(value: unknown, index: number, state: { active: WeakSet<object>; keys: number; bytes: number }): MotionScene3DAnimationSourceLayer {
  const label = `Scene3d animation source.layers[${index}]`, record = exactRecord(value, ["id", "type", "scene3d"], label, 3);
  if (typeof record.id !== "string" || !SAFE_ID.test(record.id)) throw new Error(`${label}.id must be a safe 1..64 character id.`);
  if (record.type !== "scene3d") throw new Error(`${label}.type must equal scene3d.`);
  chargeRecordSyntax(state, ["id", "type", "scene3d"]); chargeScalar(state, record.id); chargeScalar(state, record.type);
  const scene3d = snapshot(record.scene3d, state, 0);
  return Object.freeze({ id: record.id, type: "scene3d", scene3d: scene3d as MotionScene3D });
}

function rejectLegacyTransformDrivers(layer: MotionScene3DAnimationSourceLayer): void {
  if (Object.hasOwn(layer.scene3d.camera, "orbitDegPerSecond")) throw new Error(`Scene3d animation source layer ${layer.id} uses legacy camera.orbitDegPerSecond; sampled camera tracks require sole transform authority.`);
  const spinning = layer.scene3d.objects.find((object) => Object.hasOwn(object, "spinDegPerSecond"));
  if (spinning) throw new Error(`Scene3d animation source object ${layer.id}/${spinning.id} uses legacy spinDegPerSecond; sampled object tracks require sole transform authority.`);
}

function snapshot(value: unknown, state: { active: WeakSet<object>; keys: number; bytes: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean") { chargeScalar(state, value); return value; }
  if (typeof value === "number") { const normalized = Object.is(value, -0) ? 0 : value; chargeScalar(state, normalized); return normalized; }
  if (typeof value === "string") { chargeScalar(state, value); return value; }
  if (typeof value !== "object" || depth > MAX_SOURCE_DEPTH) throw new Error("Scene3d animation source must contain bounded JSON data.");
  if (state.active.has(value)) throw new Error("Scene3d animation source must not contain cycles.");
  const array = Array.isArray(value), length = array ? arrayLength(value, "Scene3d animation source", MAX_SCENE_3D_MESH_INDICES_TOTAL) : null;
  if (prototypeOf(value, "Scene3d animation source") !== (array ? Array.prototype : Object.prototype)) throw new Error("Scene3d animation source must contain plain data objects and arrays.");
  const keys = ownKeys(value, "Scene3d animation source");
  if (keys.some((key) => typeof key !== "string") || keys.length > (array ? length! + 1 : MAX_SOURCE_RECORD_FIELDS)) throw new Error("Scene3d animation source exceeds its bounded data fields.");
  if (array && (keys.length !== length! + 1 || !keys.includes("length"))) throw new Error("Scene3d animation source arrays must be dense.");
  if (array) chargeArraySyntax(state, length!);
  else chargeRecordSyntax(state, keys as string[]);
  state.keys += keys.length; if (state.keys > MAX_SOURCE_KEYS) throw new Error("Scene3d animation source exceeds its aggregate field limit.");
  state.active.add(value);
  try {
    if (array) {
      const copy: unknown[] = [];
      for (let index = 0; index < length!; index += 1) copy.push(snapshot(dataField(value, String(index), "Scene3d animation source"), state, depth + 1));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys as string[]) Object.defineProperty(copy, key, { value: snapshot(dataField(value, key, "Scene3d animation source"), state, depth + 1), enumerable: true, configurable: true, writable: true });
    return copy;
  } finally { state.active.delete(value); }
}

function exactRecord(value: unknown, required: readonly string[], label: string, maximum: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || prototypeOf(value, label) !== Object.prototype) throw new Error(`${label} must be a plain object.`);
  const keys = ownKeys(value, label);
  if (keys.length > maximum || keys.some((key) => typeof key !== "string")) throw new Error(`${label} exceeds the ${maximum}-field data limit.`);
  for (const key of keys as string[]) if (!required.includes(key)) throw new Error(`${label} has unknown field '${key}'.`);
  for (const key of required) if (!keys.includes(key)) throw new Error(`${label} requires ${key}.`);
  const copy: Record<string, unknown> = {};
  for (const key of required) Object.defineProperty(copy, key, { value: dataField(value, key, label), enumerable: true, configurable: true, writable: true });
  return copy;
}

function denseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || prototypeOf(value, label) !== Array.prototype) throw new Error(`${label} must be an array.`);
  const length = arrayLength(value, label, maximum), keys = ownKeys(value, label);
  if (keys.length !== length + 1 || !keys.includes("length") || keys.some((key) => typeof key !== "string")) throw new Error(`${label} must be a dense data array.`);
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) { if (!keys.includes(String(index))) throw new Error(`${label} must be dense.`); copy.push(dataField(value, String(index), label)); }
  return copy;
}

function arrayLength(value: unknown, label: string, maximum: number): number {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const descriptor = descriptorOf(value, "length", label), length = "value" in descriptor ? descriptor.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error(`${label} must contain at most ${maximum} entries.`);
  return length;
}

function checkBytes(state: { bytes: number }): void { if (state.bytes > MAX_MOTION_SCENE3D_ANIMATION_SOURCE_BYTES) throw new Error(`Scene3d animation source exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_SOURCE_BYTES}-byte input limit.`); }
function chargeScalar(state: { bytes: number }, value: null | boolean | number | string): void { state.bytes += Buffer.byteLength(JSON.stringify(value), "utf8"); checkBytes(state); }
function chargeRecordSyntax(state: { bytes: number }, keys: readonly string[]): void { state.bytes += 2 + Math.max(0, keys.length - 1); for (const key of keys) state.bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1; checkBytes(state); }
function chargeArraySyntax(state: { bytes: number }, length: number): void { state.bytes += 2 + Math.max(0, length - 1); checkBytes(state); }
function dataField(value: object, key: PropertyKey, label: string): unknown { const descriptor = descriptorOf(value, key, label); if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${String(key)} must be an enumerable data field.`); return descriptor.value; }
function ownKeys(value: object, label: string): PropertyKey[] { try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} data reflection failed.`); } }
function descriptorOf(value: object, key: PropertyKey, label: string): PropertyDescriptor { try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) throw new Error("missing"); return descriptor; } catch { throw new Error(`${label} data reflection failed.`); } }
function prototypeOf(value: object, label: string): object | null { try { return Object.getPrototypeOf(value); } catch { throw new Error(`${label} data reflection failed.`); } }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); if (!Object.isFrozen(value)) Object.freeze(value); } return value; }
