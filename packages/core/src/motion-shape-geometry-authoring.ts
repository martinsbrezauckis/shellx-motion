import type { MotionDocument, MotionLayer, MotionShapeGeometry, MotionShapeGeometryPoint } from "./types";
import { canonicalJson } from "./canonical-json";
import { readGpuSceneStrokeDash } from "./gpu-scene-stroke-dash";
import type {
  TimelineShapeGeometryArcUpdate,
  TimelineShapeGeometryInspection,
  TimelineShapeGeometryInspect,
  TimelineShapeGeometryMigrateLegacy,
  TimelineShapeGeometryMutationResult,
  TimelineShapeGeometryPathDataReplace,
  TimelineShapeGeometryPointInsert,
  TimelineShapeGeometryPointMove,
  TimelineShapeGeometryPointRangeDelete,
  TimelineShapeGeometryPointUpdate,
  TimelineShapeGeometryReplace,
} from "./motion-shape-geometry-authoring-types";
import {
  assertExactGeometry,
  assertFinalV1ShapeGeometry,
  assertIndex,
  assertOperationInput,
  assertRange,
  cloneExactGeometry,
  cloneResolvedGeometry,
  exactGeometryPoint,
  legacyPathGeometryRecord,
  pointLimits,
  readResolvedShapeGeometry,
  readShapeLayerState,
  readV1ShapeGeometryState,
  replaceShapeLayer,
  sameResolvedContour,
} from "./motion-shape-geometry-authoring-support";

export type {
  TimelineShapeGeometryArcUpdate,
  TimelineShapeGeometryInspection,
  TimelineShapeGeometryInspect,
  TimelineShapeGeometryMigrateLegacy,
  TimelineShapeGeometryMutationResult,
  TimelineShapeGeometryPathDataReplace,
  TimelineShapeGeometryPointInsert,
  TimelineShapeGeometryPointMove,
  TimelineShapeGeometryPointRangeDelete,
  TimelineShapeGeometryPointUpdate,
  TimelineShapeGeometryReplace,
} from "./motion-shape-geometry-authoring-types";

/** Reads the bounded canonical contour. Legacy path inspection is read-only and migration-explicit. */
export function inspectMotionShapeGeometry(motion: MotionDocument, input: TimelineShapeGeometryInspect): TimelineShapeGeometryInspection {
  assertOperationInput(input, ["layerId"], "Shape geometry inspection");
  const state = readShapeLayerState(motion, input.layerId, false);
  const resolved = readResolvedShapeGeometry(state);
  const dash = readGpuSceneStrokeDash(state.layer.style, `Shape ${state.layer.id}`);
  if (!dash.ok) throw new Error(dash.message);
  return {
    layerId: state.layer.id,
    source: resolved.source,
    geometry: state.layer.geometry ? structuredClone(state.layer.geometry) : null,
    strokeDash: dash.dash ? structuredClone(dash.dash) : null,
    resolved: cloneResolvedGeometry(resolved),
  };
}

/** Replaces one complete v1 record; it deliberately never merges arbitrary nested JSON. */
export function replaceMotionShapeGeometry(motion: MotionDocument, input: TimelineShapeGeometryReplace): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId", "geometry"], "Shape geometry replace");
  const state = readShapeLayerState(motion, input.layerId, true);
  refuseLegacyPathMutation(state.layer);
  assertExactGeometry(input.geometry);
  if (state.layer.geometry && canonicalJson(state.layer.geometry) === canonicalJson(input.geometry)) {
    throw new Error("Shape geometry replace did not change the geometry.");
  }
  assertFinalV1ShapeGeometry({ ...state.layer, geometry: input.geometry });
  const next = commitGeometry(motion, state.layerIndex, state.layer, cloneExactGeometry(input.geometry));
  return { ...next, action: "replaced", changedPaths: [`/layers/${state.layer.id}/geometry`] };
}

/** Replaces one existing point in an ordered line, polyline, or polygon contour. */
export function updateMotionShapeGeometryPoint(motion: MotionDocument, input: TimelineShapeGeometryPointUpdate): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId", "index", "point"], "Shape geometry point update");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  const geometry = pointGeometry(state.geometry);
  assertIndex(input.index, 0, geometry.points.length - 1, "Shape geometry point index");
  const point = exactGeometryPoint(input.point, "Shape geometry point");
  if (samePoint(geometry.points[input.index], point)) throw new Error("Shape geometry point update did not change the point.");
  const candidate = { ...geometry, points: geometry.points.map((value, index) => index === input.index ? point : { ...value }) } as MotionShapeGeometry;
  assertFinalV1ShapeGeometry({ ...state.layer, geometry: candidate });
  const next = commitGeometry(motion, state.layerIndex, state.layer, structuredClone(candidate));
  return { ...next, action: "updated", index: input.index, changedPaths: [`/layers/${state.layer.id}/geometry/points/${input.index}`] };
}

/** Inserts a new ordered point where the kind's declared point maximum permits it. */
export function insertMotionShapeGeometryPoint(motion: MotionDocument, input: TimelineShapeGeometryPointInsert): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId", "index", "point"], "Shape geometry point insert");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  const geometry = pointGeometry(state.geometry);
  const limits = pointLimits(geometry.kind);
  assertIndex(input.index, 0, geometry.points.length, "Shape geometry insertion index");
  if (geometry.points.length >= limits.maximum) throw new Error(`Shape ${geometry.kind} cannot exceed ${limits.maximum} points.`);
  const point = exactGeometryPoint(input.point, "Shape geometry point");
  const points = geometry.points.map((value) => ({ ...value }));
  points.splice(input.index, 0, point);
  const candidate = { ...geometry, points } as MotionShapeGeometry;
  assertFinalV1ShapeGeometry({ ...state.layer, geometry: candidate });
  const next = commitGeometry(motion, state.layerIndex, state.layer, structuredClone(candidate));
  return { ...next, action: "inserted", index: input.index, changedPaths: [`/layers/${state.layer.id}/geometry/points`] };
}

/** Reorders one stable point identity; coordinate movement itself is `updateMotionShapeGeometryPoint`. */
export function moveMotionShapeGeometryPoint(motion: MotionDocument, input: TimelineShapeGeometryPointMove): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId", "fromIndex", "toIndex"], "Shape geometry point move");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  const geometry = pointGeometry(state.geometry);
  assertIndex(input.fromIndex, 0, geometry.points.length - 1, "Shape geometry fromIndex");
  assertIndex(input.toIndex, 0, geometry.points.length - 1, "Shape geometry toIndex");
  if (input.fromIndex === input.toIndex) throw new Error("Shape geometry point move did not change the point order.");
  const points = geometry.points.map((value) => ({ ...value }));
  const [point] = points.splice(input.fromIndex, 1);
  points.splice(input.toIndex, 0, point);
  const candidate = { ...geometry, points } as MotionShapeGeometry;
  assertFinalV1ShapeGeometry({ ...state.layer, geometry: candidate });
  const next = commitGeometry(motion, state.layerIndex, state.layer, structuredClone(candidate));
  return { ...next, action: "moved", index: input.toIndex, changedPaths: [`/layers/${state.layer.id}/geometry/points`] };
}

/** Removes exactly `[startIndex, endIndexExclusive)`, retaining the kind's required minimum. */
export function deleteMotionShapeGeometryPointRange(motion: MotionDocument, input: TimelineShapeGeometryPointRangeDelete): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId", "startIndex", "endIndexExclusive"], "Shape geometry point delete range");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  const geometry = pointGeometry(state.geometry);
  assertRange(input.startIndex, input.endIndexExclusive, geometry.points.length, "Shape geometry point delete range");
  const limits = pointLimits(geometry.kind);
  if (geometry.points.length - (input.endIndexExclusive - input.startIndex) < limits.minimum) {
    throw new Error(`Shape ${geometry.kind} delete range must leave at least ${limits.minimum} points.`);
  }
  const points = geometry.points.map((value) => ({ ...value }));
  points.splice(input.startIndex, input.endIndexExclusive - input.startIndex);
  const candidate = { ...geometry, points } as MotionShapeGeometry;
  assertFinalV1ShapeGeometry({ ...state.layer, geometry: candidate });
  const next = commitGeometry(motion, state.layerIndex, state.layer, structuredClone(candidate));
  return {
    ...next,
    action: "deleted",
    range: { startIndex: input.startIndex, endIndexExclusive: input.endIndexExclusive },
    changedPaths: [`/layers/${state.layer.id}/geometry/points`],
  };
}

/** Applies bounded scalar edits to an arc or sector; a sector's inner radius is explicit. */
export function updateMotionShapeGeometryArc(motion: MotionDocument, input: TimelineShapeGeometryArcUpdate): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId", "center", "radius", "innerRadius", "startAngleDeg", "sweepAngleDeg"], "Shape geometry arc update");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  if (state.geometry.kind !== "arc" && state.geometry.kind !== "sector") throw new Error(`Shape ${state.geometry.kind} does not own arc/sector controls.`);
  const supplied = ["center", "radius", "innerRadius", "startAngleDeg", "sweepAngleDeg"].filter((key) => Object.hasOwn(input, key));
  if (supplied.length === 0) throw new Error("Shape geometry arc update requires at least one declared control.");
  if (state.geometry.kind === "arc" && Object.hasOwn(input, "innerRadius")) throw new Error("Shape arc does not support innerRadius.");
  const hasCenter = Object.hasOwn(input, "center");
  const hasRadius = Object.hasOwn(input, "radius");
  const hasInnerRadius = Object.hasOwn(input, "innerRadius");
  const hasStart = Object.hasOwn(input, "startAngleDeg");
  const hasSweep = Object.hasOwn(input, "sweepAngleDeg");
  const center = hasCenter ? exactGeometryPoint(input.center, "Shape geometry center") : state.geometry.center;
  const numeric = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
    return value;
  };
  const candidate = {
    ...state.geometry,
    ...(hasCenter ? { center } : {}),
    ...(hasRadius ? { radius: numeric(input.radius, "Shape geometry radius") } : {}),
    ...(hasStart ? { startAngleDeg: numeric(input.startAngleDeg, "Shape geometry startAngleDeg") } : {}),
    ...(hasSweep ? { sweepAngleDeg: numeric(input.sweepAngleDeg, "Shape geometry sweepAngleDeg") } : {}),
    ...(state.geometry.kind === "sector" && hasInnerRadius ? { innerRadius: numeric(input.innerRadius, "Shape geometry innerRadius") } : {}),
  } as MotionShapeGeometry;
  if (JSON.stringify(candidate) === JSON.stringify(state.geometry)) throw new Error("Shape geometry arc update did not change the geometry.");
  assertFinalV1ShapeGeometry({ ...state.layer, geometry: candidate });
  const next = commitGeometry(motion, state.layerIndex, state.layer, structuredClone(candidate));
  return { ...next, action: "updated", changedPaths: supplied.map((key) => `/layers/${state.layer.id}/geometry/${key}`) };
}

/** Replaces only the bounded source path string; no arbitrary SVG or legacy seam is admitted. */
export function replaceMotionShapeGeometryPathData(motion: MotionDocument, input: TimelineShapeGeometryPathDataReplace): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId", "data"], "Shape geometry path data replace");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  if (state.geometry.kind !== "path") throw new Error(`Shape ${state.geometry.kind} does not own path data.`);
  if (typeof input.data !== "string") throw new Error("Shape geometry path data must be a string.");
  if (input.data === state.geometry.data) throw new Error("Shape geometry path data replace did not change the data.");
  const candidate: MotionShapeGeometry = { ...state.geometry, data: input.data };
  assertFinalV1ShapeGeometry({ ...state.layer, geometry: candidate });
  const next = commitGeometry(motion, state.layerIndex, state.layer, structuredClone(candidate));
  return { ...next, action: "replaced", changedPaths: [`/layers/${state.layer.id}/geometry/data`] };
}

/** One-way legacy path/freeform migration with before/after canonical contour equivalence evidence. */
export function migrateLegacyMotionShapeGeometry(motion: MotionDocument, input: TimelineShapeGeometryMigrateLegacy): TimelineShapeGeometryMutationResult {
  assertOperationInput(input, ["layerId"], "Shape geometry migrateLegacy");
  const state = readShapeLayerState(motion, input.layerId, true);
  const before = readResolvedShapeGeometry(state);
  const geometry = legacyPathGeometryRecord(state.layer, before);
  const legacyShape = state.layer.shape;
  const nextLayer = structuredClone(state.layer);
  delete nextLayer.shape;
  delete nextLayer["x-path"];
  delete nextLayer["x-path-viewBox"];
  delete nextLayer["x-path-fillRule"];
  nextLayer.geometry = geometry;
  const after = assertFinalV1ShapeGeometry(nextLayer);
  if (!sameResolvedContour(before, after)) throw new Error(`Legacy path migration for ${state.layer.id} did not preserve the resolved contour.`);
  const nextMotion = replaceShapeLayer(motion, state.layerIndex, nextLayer);
  return {
    motion: nextMotion,
    layerId: nextLayer.id,
    layer: nextLayer,
    action: "migrated",
    changedPaths: [
      `/layers/${state.layer.id}/geometry`,
      `/layers/${state.layer.id}/shape`,
      `/layers/${state.layer.id}/x-path`,
      ...(Object.hasOwn(state.layer, "x-path-viewBox") ? [`/layers/${state.layer.id}/x-path-viewBox`] : []),
      ...(Object.hasOwn(state.layer, "x-path-fillRule") ? [`/layers/${state.layer.id}/x-path-fillRule`] : []),
    ],
    migration: {
      from: "legacy-path",
      legacyShape: legacyShape as "path" | "freeform",
      to: "path",
      resolvedContour: {
        viewBox: structuredClone(after.viewBox),
        closed: after.closed,
        vertices: structuredClone(after.vertices),
      },
    },
  };
}

function pointGeometry(geometry: MotionShapeGeometry): Extract<MotionShapeGeometry, { points: MotionShapeGeometryPoint[] }> {
  if (geometry.kind !== "line" && geometry.kind !== "polyline" && geometry.kind !== "polygon") {
    throw new Error(`Shape ${geometry.kind} does not own an editable point list.`);
  }
  return geometry as Extract<MotionShapeGeometry, { points: MotionShapeGeometryPoint[] }>;
}

function commitGeometry(
  motion: MotionDocument,
  layerIndex: number,
  layer: MotionLayer,
  geometry: MotionShapeGeometry,
): { motion: MotionDocument; layerId: string; layer: MotionLayer } {
  const nextLayer = { ...structuredClone(layer), geometry };
  assertFinalV1ShapeGeometry(nextLayer);
  return { motion: replaceShapeLayer(motion, layerIndex, nextLayer), layerId: nextLayer.id, layer: nextLayer };
}

function refuseLegacyPathMutation(layer: MotionLayer): void {
  if (layer.shape === "path" || layer.shape === "freeform" || layer["x-path"] !== undefined) {
    throw new Error(`Shape layer ${layer.id} has legacy path geometry; use migrateLegacy before typed v1 geometry edits.`);
  }
}

function samePoint(left: MotionShapeGeometryPoint, right: MotionShapeGeometryPoint): boolean {
  return left.x === right.x && left.y === right.y;
}
