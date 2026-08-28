/** Closed argument and receipt contracts for indexed point-cloud authoring. */
import {
  MAX_POINT_COORDINATE,
  MAX_POINT_INSPECTION_POINTS,
  MAX_POINT_SAMPLES_PER_LAYER,
  MAX_POINT_SIZE,
  MAX_POINTS_PER_LAYER,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir", "layerId"];
const LAYER_ID = { type: "string" as const, description: "Target points-layer identifier; this surface uses layerId only." };
const INDEX = { type: "number" as const, minimum: 0, maximum: MAX_POINTS_PER_LAYER, description: "Stable zero-based point index; Core checks it against the current authored cloud." };
const RANGE_START = { ...INDEX, description: "Inclusive stable point index starting the half-open range." };
const RANGE_END = { ...INDEX, description: "Exclusive stable point index ending the half-open [startIndex, endIndexExclusive) range." };
const COORDINATE = { type: "number" as const, minimum: -MAX_POINT_COORDINATE, maximum: MAX_POINT_COORDINATE, description: "Finite viewport-space coordinate." };
const SIZE = { type: "number" as const, exclusiveMinimum: 0, maximum: MAX_POINT_SIZE, description: "Optional positive point size." };
const OPACITY = { type: "number" as const, minimum: 0, maximum: 1, description: "Optional point opacity." };
const BASE_POINT: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y"], additionalProperties: false,
  properties: {
    x: COORDINATE, y: COORDINATE,
    color: { type: "string", description: "Optional static supported Motion color; Core validates the closed color grammar." },
    size: SIZE, opacity: OPACITY,
  },
  description: "Exact base-point record. Point identity is its stable ordered index, not an invented id.",
};
const SAMPLE_POSITION: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y"], additionalProperties: false,
  properties: { x: COORDINATE, y: COORDINATE, size: SIZE, opacity: OPACITY },
  description: "Exact authored sample position; color remains static on its base point.",
};
const SAMPLE_POSITIONS: MotionDebugArgPropertySchema = {
  type: "array", items: SAMPLE_POSITION, maxItems: MAX_POINT_SAMPLES_PER_LAYER,
  description: "One position for every existing authored sample in source order. Required for sampled insertion; Core refuses any partial or misaligned vector.",
};

export const TIMELINE_POINT_COMMAND_METADATA = {
  "motion.timeline.points.range.inspect": {
    argsSchema: argsSchema(["packageRoot", "layerId", "startIndex", "endIndexExclusive"], {
      ...PACKAGE_ROOT, layerId: LAYER_ID, startIndex: RANGE_START, endIndexExclusive: { ...RANGE_END, description: `Exclusive point range endpoint; Core returns at most ${MAX_POINT_INSPECTION_POINTS} points.` },
    }),
  },
  "motion.timeline.points.trajectory.inspect": {
    argsSchema: argsSchema(["packageRoot", "layerId", "index"], { ...PACKAGE_ROOT, layerId: LAYER_ID, index: INDEX }),
  },
  "motion.timeline.points.point.upsert": mutation("timeline.points.point.upsert", ["index", "point"], {
    index: INDEX,
    insert: { type: "boolean", description: "Explicitly true to insert at index; omit or false to replace the existing stable identity." },
    point: BASE_POINT,
    samplePositions: SAMPLE_POSITIONS,
  }),
  "motion.timeline.points.point.move": mutation("timeline.points.point.move", ["fromIndex", "toIndex"], {
    fromIndex: { ...INDEX, description: "Existing stable point index to move." },
    toIndex: { ...INDEX, description: "Destination index after removing fromIndex; every sample position moves in lockstep." },
  }),
  "motion.timeline.points.point.delete": mutation("timeline.points.point.delete", ["index"], { index: INDEX }),
  "motion.timeline.points.point.range.delete": mutation("timeline.points.point.range.delete", ["startIndex", "endIndexExclusive"], {
    startIndex: RANGE_START, endIndexExclusive: RANGE_END,
  }),
} satisfies MotionDebugCommandMetadata;

function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return {
    argsSchema: argsSchema(EDIT.concat(required), { ...PACKAGE_EDIT, layerId: LAYER_ID, ...properties }),
    expectedReceipts: editReceipt(operation),
  };
}
