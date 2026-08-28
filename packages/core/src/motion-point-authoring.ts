import {
  MAX_POINT_SAMPLES_PER_LAYER,
  type MotionPoint,
  type MotionPointSamplePosition,
} from "./motion-points";
import { inspectMotionTrailBudget } from "./motion-trail-validation";
import type { MotionDocument, MotionLayer, MotionTrail } from "./types";
import {
  assertIndex,
  assertOperationInput,
  assertRange,
  assertValidPointPayload,
  changedPointPaths,
  changedWholePointOrderingPaths,
  clonePointTrail,
  moveArrayEntry,
  normalizeBasePoint,
  normalizeSamplePositions,
  readablePointState,
  replacePointLayer,
} from "./motion-point-authoring-support";

/** A point range inspector never returns an unbounded point-cloud payload. */
export const MAX_POINT_INSPECTION_POINTS = 256;
/** This matches the point-cloud contract; inspectors never synthesize samples. */
export const MAX_POINT_INSPECTION_SAMPLES = MAX_POINT_SAMPLES_PER_LAYER;

export interface TimelinePointUpsert {
  layerId: string;
  /** Existing stable point index, or an insertion index when `insert` is true. */
  index: number;
  /** Set this explicitly to insert an identity rather than replacing one. */
  insert?: boolean;
  point: MotionPoint;
  /** One static-sample position per existing authored sample, in sample order. */
  samplePositions?: MotionPointSamplePosition[];
}

export interface TimelinePointMove {
  layerId: string;
  /** Existing stable point index to relocate in the ordered point identity list. */
  fromIndex: number;
  /** Destination index after removing `fromIndex`; all sample positions move with it. */
  toIndex: number;
}

export interface TimelinePointDelete {
  layerId: string;
  index: number;
}

export interface TimelinePointRangeDelete {
  layerId: string;
  /** Inclusive first stable point index. */
  startIndex: number;
  /** Exclusive endpoint, so `[startIndex, endIndexExclusive)` is removed. */
  endIndexExclusive: number;
}

export interface TimelinePointAuthoringResult {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "inserted" | "replaced" | "moved" | "deleted";
  changedPaths: string[];
  /** The point's post-operation stable index, where one exists. */
  index?: number;
  /** Exact half-open interval when a batch delete owns the mutation. */
  range?: { startIndex: number; endIndexExclusive: number };
}

export interface TimelinePointRangeInspect {
  layerId: string;
  /** Inclusive first stable point index. */
  startIndex: number;
  /** Exclusive endpoint. The result contains exactly this range. */
  endIndexExclusive: number;
}

export interface TimelinePointRangeInspection {
  layerId: string;
  startIndex: number;
  endIndexExclusive: number;
  /** Immutable copies of the authored base points in stable index order. */
  points: MotionPoint[];
  /** Immutable authored sample slices in source order; no interpolated state is returned. */
  samples: Array<{ atMs: number; positions: MotionPointSamplePosition[] }>;
  declaredTrail: MotionTrail | null;
  trailBudget: ReturnType<typeof inspectMotionTrailBudget>;
}

export interface TimelinePointTrajectoryInspect {
  layerId: string;
  /** Existing stable point index. */
  index: number;
}

export interface TimelinePointTrajectoryInspection {
  layerId: string;
  index: number;
  /** Immutable base point; point colors are intentionally static in motion@1. */
  point: MotionPoint;
  /** Authored position samples only, in exact source order. */
  samples: Array<{ atMs: number; position: MotionPointSamplePosition }>;
  /** There is no stored particle/point history beyond the declared authored samples. */
  history: "not_retained";
  declaredTrail: MotionTrail | null;
}

/**
 * Replaces one existing index by default. A caller must opt into `insert: true`
 * before the stable order changes, and must then supply every matching sample
 * position so point/sample identity cannot drift.
 */
export function upsertMotionPoint(motion: MotionDocument, input: TimelinePointUpsert): TimelinePointAuthoringResult {
  const exact = assertOperationInput(input, ["layerId", "index", "insert", "point", "samplePositions"], "Point upsert") as unknown as TimelinePointUpsert;
  if (Object.hasOwn(exact, "insert") && typeof exact.insert !== "boolean") throw new Error("Point upsert insert must be a boolean when supplied.");
  const state = readablePointState(motion, exact.layerId, true);
  const insert = exact.insert === true;
  assertIndex(exact.index, 0, insert ? state.points.length : state.points.length - 1, "Point index");
  const point = normalizeBasePoint(exact.point, "Point");
  const samplePositions = normalizeSamplePositions(exact.samplePositions, state.samples.length);
  if (state.samples.length === 0 && samplePositions !== undefined) {
    throw new Error("samplePositions is allowed only when the points layer has authored samples.");
  }
  if (insert && state.samples.length > 0 && samplePositions === undefined) {
    throw new Error("Inserting a point into a sampled points layer requires one samplePositions entry per authored sample.");
  }

  const nextCloud = structuredClone(state.cloud);
  if (insert) {
    nextCloud.points.splice(exact.index, 0, point);
    nextCloud.samples?.forEach((sample, sampleIndex) => sample.positions.splice(exact.index, 0, samplePositions![sampleIndex]));
  } else {
    nextCloud.points[exact.index] = point;
    if (samplePositions) nextCloud.samples?.forEach((sample, sampleIndex) => { sample.positions[exact.index] = samplePositions[sampleIndex]; });
  }
  const next = replacePointLayer(motion, state.layerIndex, nextCloud);
  assertValidPointPayload(next.motion);
  return {
    ...next,
    action: insert ? "inserted" : "replaced",
    index: exact.index,
    changedPaths: changedPointPaths(state.layer.id, exact.index, state.samples.length, insert || samplePositions !== undefined),
  };
}

/** Reorders an existing index and every parallel sample position as one atomic identity move. */
export function moveMotionPoint(motion: MotionDocument, input: TimelinePointMove): TimelinePointAuthoringResult {
  const exact = assertOperationInput(input, ["layerId", "fromIndex", "toIndex"], "Point move") as unknown as TimelinePointMove;
  const state = readablePointState(motion, exact.layerId, true);
  assertIndex(exact.fromIndex, 0, state.points.length - 1, "fromIndex");
  assertIndex(exact.toIndex, 0, state.points.length - 1, "toIndex");
  if (exact.fromIndex === exact.toIndex) throw new Error("Point move did not change the stable point order.");

  const nextCloud = structuredClone(state.cloud);
  moveArrayEntry(nextCloud.points, exact.fromIndex, exact.toIndex);
  nextCloud.samples?.forEach((sample) => moveArrayEntry(sample.positions, exact.fromIndex, exact.toIndex));
  const next = replacePointLayer(motion, state.layerIndex, nextCloud);
  assertValidPointPayload(next.motion);
  return {
    ...next,
    action: "moved",
    index: exact.toIndex,
    changedPaths: changedWholePointOrderingPaths(state.layer.id, state.samples.length),
  };
}

/** Deletes one stable point identity and its matching position from every authored sample. */
export function deleteMotionPoint(motion: MotionDocument, input: TimelinePointDelete): TimelinePointAuthoringResult {
  const exact = assertOperationInput(input, ["layerId", "index"], "Point delete") as unknown as TimelinePointDelete;
  return deleteMotionPointRange(motion, {
    layerId: exact.layerId,
    startIndex: exact.index,
    endIndexExclusive: exact.index + 1,
  });
}

/**
 * Deletes the exact half-open interval `[startIndex, endIndexExclusive)` from
 * base points and every authored sample. At least one point must remain.
 */
export function deleteMotionPointRange(motion: MotionDocument, input: TimelinePointRangeDelete): TimelinePointAuthoringResult {
  const exact = assertOperationInput(input, ["layerId", "startIndex", "endIndexExclusive"], "Point delete range") as unknown as TimelinePointRangeDelete;
  const state = readablePointState(motion, exact.layerId, true);
  assertRange(exact.startIndex, exact.endIndexExclusive, state.points.length, "Point delete range");
  if (exact.endIndexExclusive - exact.startIndex >= state.points.length) {
    throw new Error("Point delete range must leave at least one base point.");
  }

  const nextCloud = structuredClone(state.cloud);
  const count = exact.endIndexExclusive - exact.startIndex;
  nextCloud.points.splice(exact.startIndex, count);
  nextCloud.samples?.forEach((sample) => sample.positions.splice(exact.startIndex, count));
  const next = replacePointLayer(motion, state.layerIndex, nextCloud);
  assertValidPointPayload(next.motion);
  return {
    ...next,
    action: "deleted",
    range: { startIndex: exact.startIndex, endIndexExclusive: exact.endIndexExclusive },
    changedPaths: changedWholePointOrderingPaths(state.layer.id, state.samples.length),
  };
}

/**
 * Reads a bounded authored range. This is intentionally not an evaluator: it
 * returns no interpolated positions, unbounded cloud dump, or invented history.
 */
export function inspectMotionPointRange(motion: MotionDocument, input: TimelinePointRangeInspect): TimelinePointRangeInspection {
  const exact = assertOperationInput(input, ["layerId", "startIndex", "endIndexExclusive"], "Point inspection range") as unknown as TimelinePointRangeInspect;
  const state = readablePointState(motion, exact.layerId, false);
  assertRange(exact.startIndex, exact.endIndexExclusive, state.points.length, "Point inspection range");
  if (exact.endIndexExclusive - exact.startIndex > MAX_POINT_INSPECTION_POINTS) {
    throw new Error(`Point inspection range must contain at most ${MAX_POINT_INSPECTION_POINTS} points.`);
  }
  if (state.samples.length > MAX_POINT_INSPECTION_SAMPLES) {
    throw new Error(`Point inspection cannot return more than ${MAX_POINT_INSPECTION_SAMPLES} authored samples.`);
  }
  return {
    layerId: state.layer.id,
    startIndex: exact.startIndex,
    endIndexExclusive: exact.endIndexExclusive,
    points: structuredClone(state.points.slice(exact.startIndex, exact.endIndexExclusive)),
    samples: state.samples.map((sample) => ({
      atMs: sample.atMs,
      positions: structuredClone(sample.positions.slice(exact.startIndex, exact.endIndexExclusive)),
    })),
    declaredTrail: clonePointTrail(state.layer),
    trailBudget: inspectMotionTrailBudget([state.layer]),
  };
}

/** Reads the exact authored path of one index, never a reconstructed trail-history path. */
export function inspectMotionPointTrajectory(motion: MotionDocument, input: TimelinePointTrajectoryInspect): TimelinePointTrajectoryInspection {
  const exact = assertOperationInput(input, ["layerId", "index"], "Point trajectory inspection") as unknown as TimelinePointTrajectoryInspect;
  const state = readablePointState(motion, exact.layerId, false);
  assertIndex(exact.index, 0, state.points.length - 1, "Point index");
  if (state.samples.length > MAX_POINT_INSPECTION_SAMPLES) {
    throw new Error(`Point trajectory inspection cannot return more than ${MAX_POINT_INSPECTION_SAMPLES} authored samples.`);
  }
  return {
    layerId: state.layer.id,
    index: exact.index,
    point: structuredClone(state.points[exact.index]),
    samples: state.samples.map((sample) => ({ atMs: sample.atMs, position: structuredClone(sample.positions[exact.index]) })),
    history: "not_retained",
    declaredTrail: clonePointTrail(state.layer),
  };
}
