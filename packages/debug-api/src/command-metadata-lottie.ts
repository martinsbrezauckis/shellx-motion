/**
 * Argument contracts for the Lottie and dotLottie import commands.
 *
 * Kept alongside the scene3d import metadata and shaped identically: an agent that has learned
 * one Motion import verb should be able to guess the others.
 */
import type { MotionDebugCommandMetadata } from "./command-registry.js";

const SOURCE_PATH = { type: "string", description: "Host-approved local source path." } as const;
const OUT_DIR = { type: "string", description: "Host-approved empty or absent package output directory." } as const;
const CREATED_BY = { type: "string", description: "Optional author identity recorded in package provenance." } as const;
const CREATED_AT = { type: "string", description: "Optional deterministic ISO timestamp for receipts." } as const;

export const LOTTIE_COMMAND_METADATA = {
  "motion.lottie.import": {
    argsSchema: {
      type: "object",
      required: ["sourcePath", "outDir"],
      properties: {
        sourcePath: { ...SOURCE_PATH, description: "Host-approved local Lottie JSON source path." },
        outDir: OUT_DIR,
        createdBy: CREATED_BY,
        createdAt: CREATED_AT,
      },
      additionalProperties: false,
    },
    expectedReceipts: [{
      operation: "adapter.lower",
      mode: "emits",
      required: true,
      artifactRoles: ["motion_package", "adapter_lowering_receipt"],
    }],
  },
  "motion.dotlottie.import": {
    argsSchema: {
      type: "object",
      required: ["sourcePath", "outDir"],
      properties: {
        sourcePath: { ...SOURCE_PATH, description: "Host-approved local .lottie container path." },
        outDir: OUT_DIR,
        // A container may hold several animations and several themes. Naming neither is valid and
        // selects the container's own declared defaults.
        animationId: { type: "string", description: "Animation to select from the container. Defaults to the container's declared default." },
        themeId: { type: "string", description: "Theme to apply from the container. Defaults to no theme override." },
        createdBy: CREATED_BY,
        createdAt: CREATED_AT,
      },
      additionalProperties: false,
    },
    expectedReceipts: [{
      operation: "adapter.lower",
      mode: "emits",
      required: true,
      artifactRoles: ["motion_package", "adapter_lowering_receipt"],
    }],
  },
} satisfies MotionDebugCommandMetadata;
