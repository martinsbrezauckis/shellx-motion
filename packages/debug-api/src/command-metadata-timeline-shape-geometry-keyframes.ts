/** Public Debug contract source for exact-time persisted shape geometry snapshots. */
import { MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US } from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, LAYER_ID, MOTION_EASING, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";
import { TIMELINE_SHAPE_GEOMETRY_VALUE_SCHEMA } from "./command-metadata-timeline-shape-geometry.js";

const HOST_PACKAGE_EDIT = {
  packageRoot: {
    ...PACKAGE_EDIT.packageRoot,
    description: "Source Motion package root; never modified in place. Any host receipt mirror is configured by the trusted Debug host; callers must not supply receiptsRoot.",
  },
  outDir: PACKAGE_EDIT.outDir,
  createdBy: PACKAGE_EDIT.createdBy,
};
const EXACT_US = { type: "number" as const, minimum: 0, maximum: MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US, description: "Exact safe-integer physical microsecond timestamp; no milliseconds or floating-point bridge is accepted." };
const EASING: MotionDebugArgPropertySchema = MOTION_EASING;
const SNAPSHOT: MotionDebugArgPropertySchema = {
  type: "object", required: ["atUs", "geometry"], additionalProperties: false,
  properties: { atUs: EXACT_US, geometry: TIMELINE_SHAPE_GEOMETRY_VALUE_SCHEMA, easing: EASING },
  description: "One complete fixed-topology shape geometry snapshot. It replaces only an equal exact atUs; partial geometry patches and generic keyframe targets are refused.",
};
function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(["packageRoot", "outDir", "layerId", ...required], { ...HOST_PACKAGE_EDIT, ...LAYER_ID, ...properties }), expectedReceipts: editReceipt(operation) };
}

export const TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMAND_METADATA = {
  "motion.timeline.shape.geometry-keyframes.inspect": { argsSchema: argsSchema(["packageRoot", "layerId"], { ...PACKAGE_ROOT, ...LAYER_ID }) },
  "motion.timeline.shape.geometry-keyframes.upsert": mutation("timeline.shape.geometry-keyframes.upsert", ["snapshot"], { snapshot: SNAPSHOT }),
  "motion.timeline.shape.geometry-keyframes.delete": mutation("timeline.shape.geometry-keyframes.delete", ["atUs"], { atUs: EXACT_US }),
  "motion.timeline.shape.geometry-keyframes.move": mutation("timeline.shape.geometry-keyframes.move", ["fromAtUs", "toAtUs"], { fromAtUs: EXACT_US, toAtUs: EXACT_US }),
} satisfies MotionDebugCommandMetadata;
