/** Published argument and receipt contract for bounded cutout-rig baking. */
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";

const MUTATION: Record<string, MotionDebugArgPropertySchema> = {
  packageRoot: { type: "string", description: "Source Motion package containing the static PNG image layer." },
  outDir: { type: "string", description: "Absent or empty copy-on-write output package directory." },
  sourceLayerId: { type: "string", description: "Visible, unlocked static image layer to replace with flat cutout layers." },
  rig: {
    type: "object",
    description: "Strict shellx-motion/cutout-rig@1 JSON: 1..16 nodes, each with one output layerId, optional parentId, explicit stackIndex, PNG-pixel crop/origin, 1..32 bounded poses, and sampleEveryFrames 1..16.",
  },
  receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
  createdBy: { type: "string", description: "Optional author identity recorded in output facts." },
};

export const CUTOUT_RIG_COMMAND_METADATA = {
  "motion.timeline.cutout.rig.bake": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "sourceLayerId", "rig"],
      properties: MUTATION,
      additionalProperties: false,
    },
    expectedReceipts: [{
      operation: "timeline.cutout.rig.bake",
      mode: "emits",
      required: true,
      artifactRoles: ["motion_package", "cutout_rig_bake_receipt"],
    }],
  },
} satisfies MotionDebugCommandMetadata;
