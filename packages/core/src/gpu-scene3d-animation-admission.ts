import { MAX_SCENE_3D_LAYERS } from "./scene-3d";
import type { MotionScene3DAnimationDescriptor } from "./motion-scene3d-animation-types";
import type { MotionDocument, MotionLayer } from "./types";

const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_NODES = 100_000;
const MAX_SNAPSHOT_ARRAY_LENGTH = 100_000;
const MAX_SNAPSHOT_UTF8_BYTES = 8 * 1024 * 1024;
const utf8 = new TextEncoder();

export interface StrictScene3dPreviewAdmission {
  motion: MotionDocument;
  animation: MotionScene3DAnimationDescriptor;
  layers: readonly MotionLayer[];
  targetLayerIds: readonly string[];
}

/**
 * Materializes the complete O6 document before a hash or compiler may touch it. The result is a
 * frozen JSON-data tree: every source field was admitted through an own data descriptor and no
 * source object survives the boundary. This deliberately rejects exotic/proxied-on-reflection
 * values instead of attempting a convenient but unsafe clone.
 */
export function admitStrictScene3dPreviewDocument(motion: MotionDocument): StrictScene3dPreviewAdmission {
  requireRootData(motion, "scene3dAnimation");
  requireRootData(motion, "assets");
  requireRootData(motion, "layers");
  const snapshot = materializeMotionDocument(motion);
  const animation = snapshot.scene3dAnimation;
  const assets = snapshot.assets;
  const layers = snapshot.layers;
  if (!animation) throw new Error("GPU scene3d animation preview requires scene3dAnimation as an enumerable data field.");
  if (!Array.isArray(assets) || !Array.isArray(layers)) throw new Error("GPU scene3d animation preview requires assets and layers as descriptor-safe arrays.");
  if (assets.length !== 0) throw new Error("GPU scene3d animation preview refuses declared package assets before renderer allocation.");
  if (layers.length > MAX_SCENE_3D_LAYERS) throw new Error(`GPU scene3d animation preview accepts at most ${MAX_SCENE_3D_LAYERS} root scene3d layers.`);
  const targetLayerIds = scope(layers);
  return Object.freeze({ motion: snapshot, animation, layers, targetLayerIds: Object.freeze(targetLayerIds) });
}

function materializeMotionDocument(motion: MotionDocument): MotionDocument {
  const snapshot = materialize(motion, { nodes: 0, bytes: 0, ancestors: new WeakSet<object>() }, 0);
  if (!isPlainRecord(snapshot)) throw new Error("GPU scene3d animation preview requires a plain Motion document with JSON data only.");
  return snapshot as unknown as MotionDocument;
}

interface SnapshotBudget {
  nodes: number;
  bytes: number;
  ancestors: WeakSet<object>;
}

function materialize(value: unknown, budget: SnapshotBudget, depth: number): unknown {
  if (depth > MAX_SNAPSHOT_DEPTH) throw new Error(`GPU scene3d animation preview JSON snapshot exceeds the depth-${MAX_SNAPSHOT_DEPTH} limit.`);
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_NODES) throw new Error(`GPU scene3d animation preview JSON snapshot exceeds the ${MAX_SNAPSHOT_NODES}-node limit.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return copyString(value, budget);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("GPU scene3d animation preview accepts finite JSON numbers only.");
    return value;
  }
  if (typeof value !== "object") throw new Error("GPU scene3d animation preview accepts JSON data only.");
  if (budget.ancestors.has(value)) throw new Error("GPU scene3d animation preview refuses cyclic document data.");
  budget.ancestors.add(value);
  try {
    return Array.isArray(value) ? materializeArray(value, budget, depth) : materializeRecord(value, budget, depth);
  } finally {
    budget.ancestors.delete(value);
  }
}

function materializeArray(value: object, budget: SnapshotBudget, depth: number): readonly unknown[] {
  if (!hasPlainArrayPrototype(value)) throw new Error("GPU scene3d animation preview accepts plain JSON arrays only.");
  const length = arrayLength(value);
  if (length > MAX_SNAPSHOT_ARRAY_LENGTH) throw new Error(`GPU scene3d animation preview JSON snapshot exceeds the ${MAX_SNAPSHOT_ARRAY_LENGTH}-entry array limit.`);
  const keys = allOwnKeys(value);
  if (keys.length > MAX_SNAPSHOT_ARRAY_LENGTH + 1) throw new Error(`GPU scene3d animation preview JSON snapshot exceeds the ${MAX_SNAPSHOT_ARRAY_LENGTH}-entry array limit.`);
  const snapshot: unknown[] = [];
  let entries = 0;
  for (const key of keys) {
    if (key === "length") {
      const descriptor = ownDescriptor(value, key, "array length");
      if (!descriptor || descriptor.enumerable || !("value" in descriptor) || descriptor.value !== length) throw new Error("GPU scene3d animation preview requires descriptor-safe arrays.");
      continue;
    }
    if (typeof key !== "string") throw new Error("GPU scene3d animation preview accepts JSON string keys only.");
    if (!arrayIndex(key, length)) throw new Error("GPU scene3d animation preview requires dense JSON data arrays with no extra properties.");
    const descriptor = ownDescriptor(value, key, "array entry");
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("GPU scene3d animation preview requires enumerable data array entries.");
    Object.defineProperty(snapshot, key, { value: materialize(descriptor.value, budget, depth + 1), enumerable: true, configurable: false, writable: false });
    entries += 1;
  }
  if (entries !== length) throw new Error("GPU scene3d animation preview requires dense JSON data arrays with no extra properties.");
  return Object.freeze(snapshot);
}

function materializeRecord(value: object, budget: SnapshotBudget, depth: number): Readonly<Record<string, unknown>> {
  if (!hasPlainPrototype(value)) throw new Error("GPU scene3d animation preview accepts plain JSON records only.");
  const keys = allOwnKeys(value);
  if (keys.length > MAX_SNAPSHOT_NODES) throw new Error(`GPU scene3d animation preview JSON snapshot exceeds the ${MAX_SNAPSHOT_NODES}-node limit.`);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("GPU scene3d animation preview accepts JSON string keys only.");
    copyString(key, budget);
    const descriptor = ownDescriptor(value, key, `field ${key}`);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error(`GPU scene3d animation preview requires ${key} as an enumerable data field.`);
    Object.defineProperty(snapshot, key, { value: materialize(descriptor.value, budget, depth + 1), enumerable: true, configurable: false, writable: false });
  }
  return Object.freeze(snapshot);
}

function scope(layers: readonly MotionLayer[]): string[] {
  if (layers.length === 0) throw new Error("GPU scene3d animation preview requires at least one visible root scene3d layer.");
  const ids: string[] = [];
  for (const layer of layers) {
    if (!isPlainRecord(layer)) throw new Error("GPU scene3d animation preview requires descriptor-safe root scene3d layers.");
    const type = layer.type;
    const id = layer.id;
    if (type !== "scene3d") throw new Error(`GPU scene3d animation preview refuses nested or companion layer ${String(id)} of type ${String(type)}.`);
    if (layer.visible === false) throw new Error(`GPU scene3d animation preview refuses hidden scene3d layer ${String(id)}; preview topology must be explicit.`);
    if (typeof id !== "string") throw new Error("GPU scene3d animation preview requires descriptor-safe scene3d layer ids.");
    ids.push(id);
  }
  return ids.sort();
}

function requireRootData(motion: MotionDocument, key: "scene3dAnimation" | "assets" | "layers"): void {
  const descriptor = ownDescriptor(motion, key, "document root");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
    const label = key === "scene3dAnimation" ? "GPU scene3d animation preview" : "GPU scene3d animation preview document";
    throw new Error(`${label} requires ${key} as an enumerable data field.`);
  }
}

function arrayLength(value: object): number {
  const descriptor = ownDescriptor(value, "length", "array length");
  if (!descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) throw new Error("GPU scene3d animation preview requires descriptor-safe arrays.");
  return descriptor.value;
}

function allOwnKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new Error("GPU scene3d animation preview document reflection failed.");
  }
}

function arrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function ownDescriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`GPU scene3d animation preview ${label} reflection failed.`);
  }
}

function hasPlainPrototype(value: object): boolean {
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    throw new Error("GPU scene3d animation preview document reflection failed.");
  }
}

function hasPlainArrayPrototype(value: object): boolean {
  try {
    return Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    throw new Error("GPU scene3d animation preview document reflection failed.");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function copyString(value: string, budget: SnapshotBudget): string {
  budget.bytes += utf8.encode(value).byteLength;
  if (budget.bytes > MAX_SNAPSHOT_UTF8_BYTES) throw new Error(`GPU scene3d animation preview JSON snapshot exceeds the ${MAX_SNAPSHOT_UTF8_BYTES}-byte limit.`);
  return value;
}
