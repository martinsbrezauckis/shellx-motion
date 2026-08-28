import { canonicalJson } from "./canonical-json";
import {
  MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES,
  MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US,
  MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA,
  evaluateMotionShapeGeometryKeyframes,
  readMotionShapeGeometryKeyframe,
  type MotionShapeGeometryKeyframeEvaluation,
} from "./motion-shape-geometry-keyframes";
import {
  assertFinalV1ShapeGeometry,
  assertOperationInput,
  readV1ShapeGeometryState,
  replaceShapeLayer,
} from "./motion-shape-geometry-authoring-support";
import { validateMotionShapeGeometryKeyframesForGeometry } from "./motion-shape-geometry";
import type { MotionDocument, MotionLayer, MotionShapeGeometryKeyframe, MotionShapeGeometryKeyframes } from "./types";

export interface MotionShapeGeometryKeyframesInspectInput { layerId: string; }
export interface MotionShapeGeometryKeyframesUpsertInput { layerId: string; snapshot: MotionShapeGeometryKeyframe; }
export interface MotionShapeGeometryKeyframesDeleteInput { layerId: string; atUs: number; }
export interface MotionShapeGeometryKeyframesMoveInput { layerId: string; fromAtUs: number; toAtUs: number; }

export interface MotionShapeGeometryKeyframesInspection {
  layerId: string;
  geometryKeyframes: MotionShapeGeometryKeyframes | null;
  evaluation: MotionShapeGeometryKeyframeEvaluation | null;
}

export interface MotionShapeGeometryKeyframesMutation {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "inserted" | "replaced" | "deleted" | "moved";
  changedPaths: readonly string[];
  index: number;
  previousIndex?: number;
  evaluation: MotionShapeGeometryKeyframeEvaluation;
}

/** Reads the persisted typed record without treating legacy shape strings as animatable geometry. */
export function inspectMotionShapeGeometryKeyframes(
  motion: MotionDocument,
  input: MotionShapeGeometryKeyframesInspectInput,
): MotionShapeGeometryKeyframesInspection {
  assertOperationInput(input, ["layerId"], "Shape geometry keyframe inspection");
  const state = readV1ShapeGeometryState(motion, input.layerId, false);
  const keyframes = existingKeyframes(state.layer, state.geometry);
  if (!keyframes) return { layerId: state.layer.id, geometryKeyframes: null, evaluation: null };
  return {
    layerId: state.layer.id,
    geometryKeyframes: cloneKeyframes(keyframes),
    evaluation: evaluateGeometry(state.layer, keyframes, 0),
  };
}

/** Inserts or replaces one complete exact-time geometry snapshot. */
export function upsertMotionShapeGeometryKeyframe(
  motion: MotionDocument,
  input: MotionShapeGeometryKeyframesUpsertInput,
): MotionShapeGeometryKeyframesMutation {
  assertOperationInput(input, ["layerId", "snapshot"], "Shape geometry keyframe upsert");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  const snapshot = readMotionShapeGeometryKeyframe(input.snapshot);
  const existing = existingKeyframes(state.layer, state.geometry);
  const previous = existing?.keyframes ?? [];
  const matched = previous.findIndex((entry) => entry.atUs === snapshot.atUs);
  if (matched >= 0 && canonicalJson(previous[matched]) === canonicalJson(snapshot)) {
    throw new Error("Shape geometry keyframe upsert did not change the snapshot.");
  }
  if (matched < 0 && previous.length >= MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES) {
    throw new Error(`Shape geometry keyframes cannot exceed ${MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES} snapshots.`);
  }
  const entries = matched >= 0
    ? previous.map((entry, index) => index === matched ? copyKeyframe(snapshot) : copyKeyframe(entry))
    : [...previous.map(copyKeyframe), copyKeyframe(snapshot)];
  entries.sort((left, right) => left.atUs - right.atUs);
  const keyframes = record(entries);
  const index = entries.findIndex((entry) => entry.atUs === snapshot.atUs);
  const evaluation = evaluateGeometry(state.layer, keyframes, snapshot.atUs);
  return commit(
    motion,
    state.layerIndex,
    state.layer,
    keyframes,
    matched >= 0 ? "replaced" : "inserted",
    index,
    evaluation,
    matched >= 0
      ? [`/layers/${state.layer.id}/geometryKeyframes/keyframes/${index}`]
      : [`/layers/${state.layer.id}/geometryKeyframes/keyframes`],
  );
}

/** Deletes one snapshot while retaining the non-empty persisted record invariant. */
export function deleteMotionShapeGeometryKeyframe(
  motion: MotionDocument,
  input: MotionShapeGeometryKeyframesDeleteInput,
): MotionShapeGeometryKeyframesMutation {
  assertOperationInput(input, ["layerId", "atUs"], "Shape geometry keyframe delete");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  const atUs = exactUs(input.atUs, "Shape geometry keyframe delete atUs");
  const current = existingKeyframes(state.layer, state.geometry);
  if (!current) throw new Error("Shape geometry keyframes are absent.");
  const index = current.keyframes.findIndex((entry) => entry.atUs === atUs);
  if (index < 0) throw new Error(`Shape geometry keyframe atUs ${atUs} was not found.`);
  if (current.keyframes.length <= 1) throw new Error("Shape geometry keyframe delete must retain at least one snapshot.");
  const keyframes = record(current.keyframes.filter((_entry, currentIndex) => currentIndex !== index).map(copyKeyframe));
  const evaluation = evaluateGeometry(state.layer, keyframes, atUs);
  return commit(
    motion,
    state.layerIndex,
    state.layer,
    keyframes,
    "deleted",
    index,
    evaluation,
    [`/layers/${state.layer.id}/geometryKeyframes/keyframes/${index}`],
  );
}

/** Moves one snapshot to a new unique exact microsecond while preserving its complete geometry. */
export function moveMotionShapeGeometryKeyframe(
  motion: MotionDocument,
  input: MotionShapeGeometryKeyframesMoveInput,
): MotionShapeGeometryKeyframesMutation {
  assertOperationInput(input, ["layerId", "fromAtUs", "toAtUs"], "Shape geometry keyframe move");
  const state = readV1ShapeGeometryState(motion, input.layerId, true);
  const fromAtUs = exactUs(input.fromAtUs, "Shape geometry keyframe move fromAtUs");
  const toAtUs = exactUs(input.toAtUs, "Shape geometry keyframe move toAtUs");
  if (fromAtUs === toAtUs) throw new Error("Shape geometry keyframe move did not change the timestamp.");
  const current = existingKeyframes(state.layer, state.geometry);
  if (!current) throw new Error("Shape geometry keyframes are absent.");
  const previousIndex = current.keyframes.findIndex((entry) => entry.atUs === fromAtUs);
  if (previousIndex < 0) throw new Error(`Shape geometry keyframe atUs ${fromAtUs} was not found.`);
  if (current.keyframes.some((entry) => entry.atUs === toAtUs)) throw new Error(`Shape geometry keyframe atUs ${toAtUs} already exists.`);
  const entries = current.keyframes.map((entry, index) => copyKeyframe(index === previousIndex ? { ...entry, atUs: toAtUs } : entry));
  entries.sort((left, right) => left.atUs - right.atUs);
  const keyframes = record(entries);
  const index = entries.findIndex((entry) => entry.atUs === toAtUs);
  const evaluation = evaluateGeometry(state.layer, keyframes, toAtUs);
  return commit(
    motion,
    state.layerIndex,
    state.layer,
    keyframes,
    "moved",
    index,
    evaluation,
    [`/layers/${state.layer.id}/geometryKeyframes/keyframes`],
    previousIndex,
  );
}

function existingKeyframes(layer: MotionLayer, geometry: MotionLayer["geometry"]): MotionShapeGeometryKeyframes | null {
  const value = layer.geometryKeyframes;
  if (value === undefined) return null;
  const problem = validateMotionShapeGeometryKeyframesForGeometry(value, geometry);
  if (problem) throw new Error(`Shape geometry keyframes are invalid: ${problem}`);
  return value;
}

function evaluateGeometry(
  layer: MotionLayer,
  keyframes: MotionShapeGeometryKeyframes,
  atUs: number,
): MotionShapeGeometryKeyframeEvaluation {
  const problem = validateMotionShapeGeometryKeyframesForGeometry(keyframes, layer.geometry);
  if (problem) throw new Error(`Shape geometry keyframe mutation is invalid: ${problem}`);
  const result = evaluateMotionShapeGeometryKeyframes({ schema: keyframes.schema, atUs, keyframes: keyframes.keyframes });
  if (!result.ok) throw new Error(`Shape geometry keyframe mutation is invalid: ${result.message}`);
  return result.evaluation;
}

function commit(
  motion: MotionDocument,
  layerIndex: number,
  layer: MotionLayer,
  keyframes: MotionShapeGeometryKeyframes,
  action: MotionShapeGeometryKeyframesMutation["action"],
  index: number,
  evaluation: MotionShapeGeometryKeyframeEvaluation,
  changedPaths: readonly string[],
  previousIndex?: number,
): MotionShapeGeometryKeyframesMutation {
  const nextLayer: MotionLayer = { ...structuredClone(layer), geometryKeyframes: cloneKeyframes(keyframes) };
  assertFinalV1ShapeGeometry(nextLayer);
  return {
    motion: replaceShapeLayer(motion, layerIndex, nextLayer),
    layerId: nextLayer.id,
    layer: nextLayer,
    action,
    changedPaths,
    index,
    ...(previousIndex === undefined ? {} : { previousIndex }),
    evaluation,
  };
}

function record(keyframes: readonly MotionShapeGeometryKeyframe[]): MotionShapeGeometryKeyframes {
  return { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: keyframes.map(copyKeyframe) };
}

function cloneKeyframes(value: MotionShapeGeometryKeyframes): MotionShapeGeometryKeyframes {
  return record(value.keyframes);
}

function copyKeyframe(value: MotionShapeGeometryKeyframe): MotionShapeGeometryKeyframe {
  return {
    atUs: value.atUs,
    geometry: structuredClone(value.geometry),
    ...(value.easing === undefined ? {} : { easing: typeof value.easing === "string" ? value.easing : { ...value.easing } }),
  };
}

function exactUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US) {
    throw new Error(`${label} must be a safe integer microsecond within the declared bound.`);
  }
  return value;
}
