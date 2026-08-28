/** Closed argument and receipt contracts for fixed-topology gradient stop-color snapshots. */
import {
  MAX_MOTION_GRADIENT_COLOR_KEYFRAMES,
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES,
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT,
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US,
  MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema } from "./command-registry.js";
import { argsSchema, editReceipt, LAYER_ID, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir", "layerId"];
const AT_US = { type: "number" as const, minimum: 0, maximum: MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US, description: "Exact non-negative safe-integer microsecond timestamp; Core rejects fractional values." };
const COLOR: MotionDebugArgPropertySchema = { type: "string", maxLength: MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES, description: "Supported static Motion color string; Core canonicalizes interpolation." };
const EASING: MotionDebugArgPropertySchema = {
  type: ["string", "object"],
  oneOf: [
    { type: "string", description: "Named or functional Motion easing." },
    { type: "object", required: ["type", "stiffness", "damping"], additionalProperties: false, properties: {
      type: { type: "string", enum: ["spring"], description: "Closed spring easing type." },
      stiffness: { type: "number", exclusiveMinimum: 0, maximum: 100_000, description: "Finite positive spring stiffness." },
      damping: { type: "number", exclusiveMinimum: 0, maximum: 100_000, description: "Finite positive spring damping." },
      mass: { type: "number", exclusiveMinimum: 0, maximum: 100_000, description: "Optional finite positive spring mass." },
      initialVelocity: { type: "number", minimum: -100_000, maximum: 100_000, description: "Optional finite initial velocity." },
    } },
  ],
  description: "Optional exact segment easing; the Core timeline is the one evaluator authority.",
};
const SNAPSHOT: MotionDebugArgPropertySchema = {
  type: "object", required: ["atUs", "colors"], additionalProperties: false,
  properties: {
    atUs: AT_US,
    colors: { type: "array", minItems: 1, maxItems: MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT, items: COLOR, description: "Complete colors in immutable existing stop order; Core requires the current exact stop count." },
    easing: EASING,
  },
  description: `Exact color snapshot for ${MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA}; each gradient holds 1..${MAX_MOTION_GRADIENT_COLOR_KEYFRAMES} ordered snapshots.`,
};

export const TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMAND_METADATA = {
  "motion.timeline.gradient.color-keyframes.inspect": { argsSchema: argsSchema(["packageRoot", "layerId"], { ...PACKAGE_ROOT, ...LAYER_ID }) },
  "motion.timeline.gradient.color-keyframes.upsert": mutation("timeline.gradient.color-keyframes.upsert", ["snapshot"], { snapshot: SNAPSHOT }),
  "motion.timeline.gradient.color-keyframes.delete": mutation("timeline.gradient.color-keyframes.delete", ["atUs"], { atUs: AT_US }),
  "motion.timeline.gradient.color-keyframes.move": mutation("timeline.gradient.color-keyframes.move", ["fromAtUs", "toAtUs"], { fromAtUs: AT_US, toAtUs: AT_US }),
} satisfies Record<string, GradientColorKeyframeCommandMetadata>;

interface GradientColorKeyframeCommandMetadata {
  argsSchema: ReturnType<typeof argsSchema>;
  expectedReceipts?: ReturnType<typeof editReceipt>;
}
function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(EDIT.concat(required), { ...PACKAGE_EDIT, ...LAYER_ID, ...properties }), expectedReceipts: editReceipt(operation) };
}
