import {
  MAX_MOTION_LAYOUT_DIMENSION,
  MOTION_LAYOUT_GAP_ANIMATION_EASINGS,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US,
  MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const ID: MotionDebugArgPropertySchema = { type: "string", maxLength: 64, description: "Safe stable identifier; Core requires `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`." };
const LAYOUT_ID: MotionDebugArgPropertySchema = { type: "string", maxLength: MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH, description: "Existing non-empty static layout identifier, bounded in UTF-16 code units by Core layout authority." };
const SHA: MotionDebugArgPropertySchema = { type: "string", maxLength: 64, description: "Exact lowercase application SHA-256 fingerprint." };
const US: MotionDebugArgPropertySchema = { type: "number", minimum: 0, maximum: MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US, description: "Exact safe-integer microsecond timestamp; milliseconds and floating point are refused." };
const EASING: MotionDebugArgPropertySchema = {
  type: "string",
  enum: [...MOTION_LAYOUT_GAP_ANIMATION_EASINGS],
  description: "Optional non-overshooting C2 easing for the following segment; object springs, bouncy presets, cubic curves, and generic step counts are refused.",
};
const KEYFRAME: MotionDebugArgPropertySchema = {
  type: "object",
  required: ["atUs", "value"],
  additionalProperties: false,
  properties: {
    atUs: US,
    value: { type: "number", minimum: 0, maximum: MAX_MOTION_LAYOUT_DIMENSION, description: "Gap in document layout units, bounded by the Core layout dimension maximum." },
    easing: EASING,
  },
  description: "One exact gap keyframe; terminal state holds and it never becomes a generic keyframe target.",
};
const TRACK: MotionDebugArgPropertySchema = { type: "object", required: ["id", "applicationId", "applicationFingerprint", "childLayerIds", "keyframes"], additionalProperties: false, properties: { id: ID, applicationId: LAYOUT_ID, applicationFingerprint: SHA, childLayerIds: { type: "array", minItems: 1, maxItems: 256, items: LAYOUT_ID }, keyframes: { type: "array", minItems: 1, maxItems: 64, items: KEYFRAME } }, description: "One application-bound row/column gap track. Generic paths and transform/timing targets are not accepted." };
const EDIT = { packageRoot: { ...PACKAGE_EDIT.packageRoot, description: "Source Motion package root; host-owned layout continuation authority and receipt mirrors are configured by the trusted Debug host." }, outDir: PACKAGE_EDIT.outDir, createdBy: PACKAGE_EDIT.createdBy };
const mutation = (operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) => ({ argsSchema: argsSchema(["packageRoot", "outDir", ...required], { ...EDIT, ...properties }), expectedReceipts: editReceipt(operation) });
export const TIMELINE_LAYOUT_GAP_ANIMATION_COMMAND_METADATA = {
  "motion.timeline.layout-gap-animation.inspect": { argsSchema: argsSchema(["packageRoot"], PACKAGE_ROOT) },
  "motion.timeline.layout-gap-animation.track.upsert": mutation("timeline.layout-gap-animation.track.upsert", ["track"], { track: TRACK }),
  "motion.timeline.layout-gap-animation.track.remove": mutation("timeline.layout-gap-animation.track.remove", ["trackId"], { trackId: ID }),
  "motion.timeline.layout-gap-animation.keyframe.upsert": mutation("timeline.layout-gap-animation.keyframe.upsert", ["trackId", "keyframe"], { trackId: ID, keyframe: KEYFRAME }),
  "motion.timeline.layout-gap-animation.keyframe.delete": mutation("timeline.layout-gap-animation.keyframe.delete", ["trackId", "atUs"], { trackId: ID, atUs: US }),
  "motion.timeline.layout-gap-animation.keyframe.move": mutation("timeline.layout-gap-animation.keyframe.move", ["trackId", "fromAtUs", "toAtUs"], { trackId: ID, fromAtUs: US, toAtUs: US }),
} satisfies MotionDebugCommandMetadata;
