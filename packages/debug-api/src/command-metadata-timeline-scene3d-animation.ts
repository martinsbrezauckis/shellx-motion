/** Public Debug contract source for closed exact-time persisted scene3d animation authoring. */
import { MAX_MOTION_SCENE3D_ANIMATION_TIME_US } from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, MOTION_EASING, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const ID: MotionDebugArgPropertySchema = { type: "string", maxLength: 64, description: "Safe stable identifier; Core requires `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`." };
const EXACT_US: MotionDebugArgPropertySchema = { type: "number", minimum: 0, maximum: MAX_MOTION_SCENE3D_ANIMATION_TIME_US, description: "Exact safe-integer physical microsecond timestamp; milliseconds and floating-point time are refused." };
const EASING: MotionDebugArgPropertySchema = MOTION_EASING;
const COLOR: MotionDebugArgPropertySchema = { type: "string", description: "Opaque #RRGGBB scene color; Core canonicalizes it." };
const VECTOR: MotionDebugArgPropertySchema = { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Exactly three finite numbers; Core applies the locator-specific scene3d bounds." };
const VALUE: MotionDebugArgPropertySchema = { type: ["number", "string", "array"], description: "Locator-typed number, vec3, or #RRGGBB color. Generic paths and untyped JSON values are not accepted." };
const LOCATOR: MotionDebugArgPropertySchema = { type: "object", oneOf: [
  { type: "object", required: ["layerId", "scope", "property"], additionalProperties: false, properties: { layerId: ID, scope: { type: "string", enum: ["camera"] }, property: { type: "string", enum: ["position", "target", "fovDeg"] } } },
  { type: "object", required: ["layerId", "scope", "property"], additionalProperties: false, properties: { layerId: ID, scope: { type: "string", enum: ["lighting"] }, property: { type: "string", enum: ["ambient", "direction", "intensity", "color"] } } },
  { type: "object", required: ["layerId", "scope", "objectId", "property"], additionalProperties: false, properties: { layerId: ID, scope: { type: "string", enum: ["object"] }, objectId: ID, property: { type: "string", enum: ["position", "rotationDeg", "scale", "emissive", "color"] } } },
  { type: "object", required: ["layerId", "scope", "property"], additionalProperties: false, properties: { layerId: ID, scope: { type: "string", enum: ["background"] }, property: { type: "string", enum: ["color"] } } },
] };
const KEYFRAME: MotionDebugArgPropertySchema = { type: "object", required: ["atUs", "value"], additionalProperties: false, properties: { atUs: EXACT_US, value: VALUE, easing: EASING }, description: "One complete exact-time typed keyframe. Core resolves value kind/bounds from the stored track locator." };
const TRACK: MotionDebugArgPropertySchema = { type: "object", required: ["id", "locator", "keyframes"], additionalProperties: false, properties: {
  id: ID, locator: LOCATOR, keyframes: { type: "array", minItems: 1, maxItems: 64, items: KEYFRAME },
}, description: "One complete closed scene3d track. Its id can replace only the same immutable locator; a second track for that locator is refused." };
const HOST_PACKAGE_EDIT = {
  packageRoot: { ...PACKAGE_EDIT.packageRoot, description: "Source Motion package root; never modified in place. Host receipt mirrors are configured by the trusted Debug host, never by a caller field." },
  outDir: PACKAGE_EDIT.outDir,
  createdBy: PACKAGE_EDIT.createdBy,
};

function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(["packageRoot", "outDir", ...required], { ...HOST_PACKAGE_EDIT, ...properties }), expectedReceipts: editReceipt(operation) };
}

export const TIMELINE_SCENE3D_ANIMATION_COMMAND_METADATA = {
  "motion.timeline.scene3d-animation.inspect": { argsSchema: argsSchema(["packageRoot"], PACKAGE_ROOT) },
  "motion.timeline.scene3d-animation.track.upsert": mutation("timeline.scene3d-animation.track.upsert", ["track"], { track: TRACK }),
  "motion.timeline.scene3d-animation.track.remove": mutation("timeline.scene3d-animation.track.remove", ["trackId"], { trackId: ID }),
  "motion.timeline.scene3d-animation.keyframe.upsert": mutation("timeline.scene3d-animation.keyframe.upsert", ["trackId", "keyframe"], { trackId: ID, keyframe: KEYFRAME }),
  "motion.timeline.scene3d-animation.keyframe.delete": mutation("timeline.scene3d-animation.keyframe.delete", ["trackId", "atUs"], { trackId: ID, atUs: EXACT_US }),
  "motion.timeline.scene3d-animation.keyframe.move": mutation("timeline.scene3d-animation.keyframe.move", ["trackId", "fromAtUs", "toAtUs"], { trackId: ID, fromAtUs: EXACT_US, toAtUs: EXACT_US }),
} satisfies MotionDebugCommandMetadata;
