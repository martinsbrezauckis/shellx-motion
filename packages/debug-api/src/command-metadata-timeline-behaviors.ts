/** Closed Debug command contracts for document-root behaviors@1. */
import {
  MOTION_BEHAVIOR_MAX_COORDINATE,
  MOTION_BEHAVIOR_MAX_GRAVITY,
  MOTION_BEHAVIOR_MAX_RESTITUTION,
  MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MAX_VELOCITY,
  MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY,
  MOTION_BEHAVIOR_MIN_COORDINATE,
  MOTION_BEHAVIOR_MIN_GRAVITY,
  MOTION_BEHAVIOR_MIN_RESTITUTION,
  MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MIN_VELOCITY,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, MOTION_EASING, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const BEHAVIOR_PACKAGE_EDIT = {
  packageRoot: {
    ...PACKAGE_EDIT.packageRoot,
    description: "Source Motion package root; never modified in place. Any behavior receipt mirror is configured by the trusted Debug host; callers must not supply receiptsRoot.",
  },
  outDir: PACKAGE_EDIT.outDir,
  createdBy: PACKAGE_EDIT.createdBy,
};

const COMMON_BINDING: Record<string, MotionDebugArgPropertySchema> = {
  targetLayerId: { type: "string", description: "Existing root-owned shape target layer id." },
  enabled: { type: "boolean", description: "Disabled bindings remain validated and reserve transform authority." },
  startUs: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Safe-integer physical start time in microseconds." },
  durationUs: { type: "number", minimum: 1, maximum: 3_600_000_000, description: "Safe-integer physical duration in microseconds, capped at one hour." },
};
const VIEW_BOX: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y", "width", "height"], additionalProperties: false,
  properties: {
    x: { type: "number", description: "Finite local-coordinate viewBox x." }, y: { type: "number", description: "Finite local-coordinate viewBox y." },
    width: { type: "number", description: "Finite positive local-coordinate viewBox width; Core enforces bounds." }, height: { type: "number", description: "Finite positive local-coordinate viewBox height; Core enforces bounds." },
  },
};
const PATH_GEOMETRY: MotionDebugArgPropertySchema = {
  type: "object", required: ["schema", "kind", "viewBox", "data"], additionalProperties: false,
  properties: { schema: { type: "string", enum: ["shellx-motion/shape-geometry@1"], description: "Versioned authored geometry schema." }, kind: { type: "string", enum: ["path"], description: "Closed behavior path geometry kind." }, viewBox: VIEW_BOX, data: { type: "string", maxLength: 16384, description: "Closed v1 SVG path data; Core resolves and bounds its contour and arc length." } },
  description: "Closed authored path geometry used only by a path-follow binding.",
};
const TRANSFORM_MOTION: MotionDebugArgPropertySchema = {
  type: "object", oneOf: [
    { type: "object", required: ["kind", "velocityX", "velocityY", "gravityY"], additionalProperties: false, properties: { kind: { type: "string", enum: ["gravity"] }, velocityX: boundedNumberProperty(MOTION_BEHAVIOR_MIN_VELOCITY, MOTION_BEHAVIOR_MAX_VELOCITY, "Finite horizontal velocity."), velocityY: boundedNumberProperty(MOTION_BEHAVIOR_MIN_VELOCITY, MOTION_BEHAVIOR_MAX_VELOCITY, "Finite vertical velocity."), gravityY: boundedNumberProperty(MOTION_BEHAVIOR_MIN_GRAVITY, MOTION_BEHAVIOR_MAX_GRAVITY, "Finite downward acceleration.") } },
    { type: "object", required: ["kind", "floorY", "velocityY", "gravityY", "restitution"], additionalProperties: false, properties: { kind: { type: "string", enum: ["bounce"] }, floorY: boundedNumberProperty(MOTION_BEHAVIOR_MIN_COORDINATE, MOTION_BEHAVIOR_MAX_COORDINATE, "Finite bounce floor."), velocityY: boundedNumberProperty(MOTION_BEHAVIOR_MIN_VELOCITY, MOTION_BEHAVIOR_MAX_VELOCITY, "Finite initial vertical velocity."), gravityY: boundedNumberProperty(MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY, MOTION_BEHAVIOR_MAX_GRAVITY, "Finite positive downward acceleration."), restitution: boundedNumberProperty(MOTION_BEHAVIOR_MIN_RESTITUTION, MOTION_BEHAVIOR_MAX_RESTITUTION, "Finite bounce restitution.") } },
  ],
  description: "Closed analytic gravity or bounce motion; never code or a simulation program.",
};
const EASING: MotionDebugArgPropertySchema = MOTION_EASING;
const SQUASH: MotionDebugArgPropertySchema = {
  type: "object", required: ["kind", "axis", "amount"], additionalProperties: false,
  properties: { kind: { type: "string", enum: ["squash"] }, axis: { type: "string", enum: ["vertical", "horizontal"], description: "Closed squash axis." }, amount: boundedNumberProperty(MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT, MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT, "Finite squash amount.") },
};
const BINDING: MotionDebugArgPropertySchema = {
  type: "object", oneOf: [
    { type: "object", required: ["targetLayerId", "enabled", "kind", "startUs", "durationUs", "geometry"], additionalProperties: false, properties: { ...COMMON_BINDING, kind: { type: "string", enum: ["path-follow"] }, geometry: PATH_GEOMETRY, offsetUs: { type: "number", minimum: 0, maximum: 3_600_000_000, description: "Optional safe-integer offset in microseconds, strictly below durationUs by Core validation." }, direction: { type: "string", enum: ["forward", "reverse"], description: "Closed path-follow direction." }, orientToPath: { type: "boolean", description: "Whether rotation follows the resolved path tangent." }, easing: EASING } },
    transformBindingVariant(["motion"]),
    transformBindingVariant(["squash"]),
    transformBindingVariant(["motion", "squash"]),
  ],
  description: "One exact behavior binding. Core validates target ownership, transform conflicts, timing, path topology, work, and store budgets.",
};

export const TIMELINE_BEHAVIOR_COMMAND_METADATA = {
  "motion.timeline.behaviors.inspect": { argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }) },
  "motion.timeline.behaviors.upsert": mutation("timeline.behaviors.upsert", ["binding"], { binding: BINDING }),
  "motion.timeline.behaviors.remove": mutation("timeline.behaviors.remove", ["targetLayerId"], { targetLayerId: { type: "string", description: "Existing behavior target layer id to remove." } }),
} satisfies MotionDebugCommandMetadata;

function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(["packageRoot", "outDir", ...required], { ...BEHAVIOR_PACKAGE_EDIT, ...properties }), expectedReceipts: editReceipt(operation) };
}
function boundedNumberProperty(minimum: number, maximum: number, description: string): MotionDebugArgPropertySchema { return { type: "number", minimum, maximum, description }; }
function transformBindingVariant(required: string[]): MotionDebugArgPropertySchema {
  return {
    type: "object", required: ["targetLayerId", "enabled", "kind", "startUs", "durationUs", ...required], additionalProperties: false,
    properties: { ...COMMON_BINDING, kind: { type: "string", enum: ["transform"], description: "Closed analytic transform behavior kind." }, motion: TRANSFORM_MOTION, squash: SQUASH },
  };
}
