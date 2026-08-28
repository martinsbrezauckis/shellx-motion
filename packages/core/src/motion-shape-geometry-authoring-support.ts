import {
  MAX_MOTION_SHAPE_GEOMETRY_POINTS,
  MOTION_SHAPE_GEOMETRY_SCHEMA,
  resolveMotionShapeGeometry,
  validateMotionShapeGeometryLayers,
  type MotionShapeGeometryKind,
  type ResolvedMotionShapeGeometry,
} from "./motion-shape-geometry";
import type { MotionDocument, MotionLayer, MotionShapeGeometry, MotionShapeGeometryPoint } from "./types";

export interface ShapeLayerState {
  layerIndex: number;
  layer: MotionLayer;
}

export interface V1ShapeGeometryState extends ShapeLayerState {
  geometry: MotionShapeGeometry;
  resolved: ResolvedMotionShapeGeometry;
}

export function readShapeLayerState(motion: MotionDocument, layerId: string, requireEditable: boolean): ShapeLayerState {
  if (typeof layerId !== "string" || layerId.length === 0) throw new Error("Shape geometry layerId must be a non-empty string.");
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = motion.layers[layerIndex];
  if (layer.type !== "shape") throw new Error(`Motion layer ${layerId} is not a shape layer.`);
  if (requireEditable && layer.locked) throw new Error(`Cannot edit locked layer: ${layerId}.`);
  const lockedTrack = requireEditable
    ? (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id)))
    : undefined;
  if (lockedTrack) throw new Error(`Cannot edit shape geometry on locked track: ${lockedTrack.id}.`);
  return { layerIndex, layer };
}

export function readResolvedShapeGeometry(state: ShapeLayerState): ResolvedMotionShapeGeometry {
  const resolved = resolveMotionShapeGeometry(state.layer);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.geometry;
}

export function readV1ShapeGeometryState(motion: MotionDocument, layerId: string, requireEditable: boolean): V1ShapeGeometryState {
  const state = readShapeLayerState(motion, layerId, requireEditable);
  const resolved = readResolvedShapeGeometry(state);
  if (resolved.source !== "v1" || !state.layer.geometry) {
    throw new Error(`Shape layer ${layerId} has legacy path geometry; use migrateLegacy before typed v1 geometry edits.`);
  }
  return { ...state, geometry: state.layer.geometry, resolved };
}

export function assertOperationInput(value: unknown, allowed: readonly string[], label: string): void {
  rejectUnknownKeys(plainDataRecord(value, label), allowed, label);
}

export function assertExactGeometry(value: unknown): asserts value is MotionShapeGeometry {
  assertPlainData(value, "Shape geometry");
  const probe: MotionLayer = { id: "geometry-input", type: "shape", startMs: 0, durationMs: 1, geometry: value as MotionShapeGeometry };
  const resolved = resolveMotionShapeGeometry(probe);
  if (!resolved.ok || resolved.geometry.source !== "v1") throw new Error(resolved.ok ? "Shape geometry must use a v1 record." : resolved.message);
}

export function cloneExactGeometry(value: MotionShapeGeometry): MotionShapeGeometry {
  return structuredClone(value);
}

export function exactGeometryPoint(value: unknown, label: string): MotionShapeGeometryPoint {
  const point = plainDataRecord(value, label);
  rejectUnknownKeys(point, ["x", "y"], label);
  if (!Object.hasOwn(point, "x") || !Object.hasOwn(point, "y")) throw new Error(`${label} requires x and y.`);
  if (typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y)) {
    throw new Error(`${label} x and y must be finite numbers.`);
  }
  return { x: point.x, y: point.y };
}

export function assertIndex(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  }
}

export function assertRange(startIndex: unknown, endIndexExclusive: unknown, pointCount: number, label: string): void {
  assertIndex(startIndex, 0, pointCount - 1, `${label} startIndex`);
  if (!Number.isInteger(endIndexExclusive) || typeof endIndexExclusive !== "number" || endIndexExclusive <= startIndex || endIndexExclusive > pointCount) {
    throw new Error(`${label} must be a non-empty half-open interval [startIndex, endIndexExclusive) within 0..${pointCount}.`);
  }
}

export function pointLimits(kind: MotionShapeGeometryKind): { minimum: number; maximum: number } {
  if (kind === "line") return { minimum: 2, maximum: 2 };
  if (kind === "polyline") return { minimum: 2, maximum: MAX_MOTION_SHAPE_GEOMETRY_POINTS };
  if (kind === "polygon") return { minimum: 3, maximum: MAX_MOTION_SHAPE_GEOMETRY_POINTS };
  throw new Error(`Shape ${kind} does not own an editable point list.`);
}

export function replaceShapeLayer(motion: MotionDocument, layerIndex: number, layer: MotionLayer): MotionDocument {
  return {
    ...motion,
    layers: motion.layers.map((candidate, index) => index === layerIndex ? layer : structuredClone(candidate)),
  };
}

/** Final authority after every mutation: exact resolver plus Core semantic/style validation. */
export function assertFinalV1ShapeGeometry(layer: MotionLayer): ResolvedMotionShapeGeometry {
  const issues: Array<{ path: string; message: string }> = [];
  validateMotionShapeGeometryLayers([layer], issues);
  if (issues.length > 0) throw new Error(`Shape geometry mutation is invalid: ${issues[0].message}`);
  const resolved = resolveMotionShapeGeometry(layer);
  if (!resolved.ok) throw new Error(resolved.message);
  if (resolved.geometry.source !== "v1") throw new Error("Shape geometry mutation must produce a v1 geometry record.");
  return resolved.geometry;
}

export function sameResolvedContour(left: ResolvedMotionShapeGeometry, right: ResolvedMotionShapeGeometry): boolean {
  return left.closed === right.closed
    && left.viewBox.x === right.viewBox.x
    && left.viewBox.y === right.viewBox.y
    && left.viewBox.width === right.viewBox.width
    && left.viewBox.height === right.viewBox.height
    && left.vertices.length === right.vertices.length
    && left.vertices.every((vertex, index) => vertex.x === right.vertices[index]?.x && vertex.y === right.vertices[index]?.y);
}

export function legacyPathGeometryRecord(layer: MotionLayer, resolved: ResolvedMotionShapeGeometry): MotionShapeGeometry {
  if (resolved.source !== "legacy" || (layer.shape !== "path" && layer.shape !== "freeform") || typeof layer["x-path"] !== "string") {
    throw new Error(`Shape layer ${layer.id} does not have migratable legacy path geometry.`);
  }
  return {
    schema: MOTION_SHAPE_GEOMETRY_SCHEMA,
    kind: "path",
    viewBox: structuredClone(resolved.viewBox),
    data: layer["x-path"],
  };
}

export function cloneResolvedGeometry(value: ResolvedMotionShapeGeometry): ResolvedMotionShapeGeometry {
  return structuredClone(value);
}

function assertPlainData(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainData(item, `${label}[${index}]`));
    return;
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  plainDataRecord(value, label);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) assertPlainData(nested, `${label}.${key}`);
}

function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object.`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new Error(`${label} must contain data properties only.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} does not support ${key}.`);
}
