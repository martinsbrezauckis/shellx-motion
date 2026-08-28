/** Closed Debug contracts for generic document-root relations@1 authoring. */
import {
  MAX_MOTION_RELATION_COORDINATE,
  MAX_MOTION_RELATION_DURATION_US,
  MAX_MOTION_RELATION_ROTATION_DEGREES,
  MAX_MOTION_RELATION_SCALE,
  MIN_MOTION_RELATION_SCALE,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const RELATION_PACKAGE_EDIT = {
  packageRoot: {
    ...PACKAGE_EDIT.packageRoot,
    description: "Source Motion package root; never modified in place. Receipt mirroring is selected only by the trusted Debug host.",
  },
  outDir: PACKAGE_EDIT.outDir,
  createdBy: PACKAGE_EDIT.createdBy,
};
const SAFE_US = { type: "number" as const, minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Safe-integer physical microseconds; Core checks the document duration." };
const ID = { type: "string" as const, maxLength: 64, description: "Stable relation id." };
const ANCHOR: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y"], additionalProperties: false,
  properties: {
    x: bounded(-MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, "Resolved local pixel anchor x."),
    y: bounded(-MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, "Resolved local pixel anchor y."),
  },
};
const ENDPOINT: MotionDebugArgPropertySchema = {
  type: "object", required: ["layerId", "anchor"], additionalProperties: false,
  properties: { layerId: { type: "string", maxLength: 64, description: "Existing root-owned shape layer id." }, anchor: ANCHOR },
};
const OFFSET: MotionDebugArgPropertySchema = {
  type: "object", required: ["space", "x", "y", "rotationDeg", "scale"], additionalProperties: false,
  properties: {
    space: { type: "string", enum: ["source", "world"], description: "Whether translation/rotation offsets are source-relative or world-pixel values." },
    x: bounded(-MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, "Bounded x offset."),
    y: bounded(-MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_COORDINATE, "Bounded y offset."),
    rotationDeg: bounded(-MAX_MOTION_RELATION_ROTATION_DEGREES, MAX_MOTION_RELATION_ROTATION_DEGREES, "Bounded orientation offset in degrees."),
    scale: bounded(MIN_MOTION_RELATION_SCALE, MAX_MOTION_RELATION_SCALE, "Positive uniform scale offset."),
  },
};
const COMMON_BINDING: Record<string, MotionDebugArgPropertySchema> = {
  id: ID,
  enabled: { type: "boolean", description: "Disabled bindings remain validated and reserve their transform masks." },
  source: ENDPOINT,
  target: ENDPOINT,
  startUs: SAFE_US,
  durationUs: { type: "number", minimum: 1, maximum: MAX_MOTION_RELATION_DURATION_US, description: "Safe-integer duration in microseconds, capped at one hour." },
};
const BINDING: MotionDebugArgPropertySchema = {
  type: "object",
  oneOf: [
    {
      type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "mode", "offset"], additionalProperties: false,
      properties: { ...COMMON_BINDING, kind: { type: "string", enum: ["attach"] }, mode: { type: "string", enum: ["follow", "similarity"], description: "Translation-only follow or orientation-preserving uniform similarity attach." }, offset: OFFSET },
    },
    {
      type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "rotationOffsetDeg"], additionalProperties: false,
      properties: { ...COMMON_BINDING, kind: { type: "string", enum: ["aim"] }, rotationOffsetDeg: bounded(-MAX_MOTION_RELATION_ROTATION_DEGREES, MAX_MOTION_RELATION_ROTATION_DEGREES, "Rotation added after aim orientation.") },
    },
  ],
  description: "One exact attach/follow/similarity or aim binding. Core owns target authority, DAG, lock, time, and budget validation.",
};

export const TIMELINE_RELATION_COMMAND_METADATA = {
  "motion.timeline.relations.inspect": {
    argsSchema: argsSchema(["packageRoot"], {
      ...PACKAGE_ROOT,
      atUs: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Optional exact inspection playhead. This authoring bridge currently accepts whole-millisecond-representable microseconds only." },
    }),
  },
  "motion.timeline.relations.upsert": mutation("timeline.relations.upsert", ["binding"], { binding: BINDING }),
  "motion.timeline.relations.enabled.set": mutation("timeline.relations.enabled.set", ["id", "enabled"], { id: ID, enabled: { type: "boolean", description: "New persisted enable state; the mask remains reserved either way." } }),
  "motion.timeline.relations.remove": mutation("timeline.relations.remove", ["id"], { id: ID }),
  "motion.timeline.relations.detach": mutation("timeline.relations.detach", ["id"], { id: ID }),
  "motion.timeline.relations.bake": mutation("timeline.relations.bake", ["id", "sampleEveryUs"], {
    id: ID,
    sampleEveryUs: { type: "number", minimum: 1, maximum: MAX_MOTION_RELATION_DURATION_US, description: "Positive safe-integer interval in microseconds. Core requires a whole-millisecond multiple and an inclusive grid of at most 3,600 samples." },
  }),
} satisfies MotionDebugCommandMetadata;

function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(["packageRoot", "outDir", ...required], { ...RELATION_PACKAGE_EDIT, ...properties }), expectedReceipts: editReceipt(operation) };
}
function bounded(minimum: number, maximum: number, description: string): MotionDebugArgPropertySchema { return { type: "number", minimum, maximum, description }; }
