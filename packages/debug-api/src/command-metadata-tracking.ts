/** Declarative tracking command contracts kept out of the debug host entry point. */
import type { MotionDebugCommandMetadata } from "./command-registry.js";

export const TRACKING_COMMAND_METADATA = {
  "motion.analysis.tracking.request": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "analysisId", "assetId", "mode", "model", "reference", "settings"],
      properties: {
        packageRoot: { type: "string", description: "Source Motion package containing a manifest-declared video asset." },
        outDir: { type: "string", aliases: ["packageDir"], description: "Trusted empty output directory for the package copy and persisted lifecycle." },
        analysisId: { type: "string", description: "Stable safe identifier used for retries and the lifecycle artifact path." },
        assetId: { type: "string", description: "Motion video asset id to track." },
        mode: { type: "string", enum: ["point", "planar"], description: "Tracker kind: point follows a single feature, planar solves a surface." },
        model: { type: "string", enum: ["translation", "similarity", "homography"], description: "Motion model the solve fits; homography is required for planar corner-pin applies." },
        reference: { type: "object", description: "Reference time, bounds, and point coordinates in source pixels." },
        settings: { type: "object", description: "Bounded time range, direction, step, search, confidence, and deterministic solver settings." },
        receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
        createdAt: { type: "string", description: "Optional deterministic timestamp for tests and reproducible fixtures." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [
      { operation: "analysis.tracking.request", mode: "emits", required: true, artifactRoles: ["motion_package", "tracking_lifecycle", "tracking_receipt"] },
    ],
  },
  "motion.analysis.tracking.inspect": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "analysisId"],
      properties: {
        packageRoot: { type: "string", description: "Motion package containing the persisted tracking lifecycle." },
        analysisId: { type: "string", description: "Tracking lifecycle id to inspect." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [{ operation: "analysis.tracking.request", mode: "reads", required: true, artifactRoles: ["tracking_lifecycle"] }],
  },
  "motion.analysis.tracking.apply": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "analysisId", "layerId"],
      properties: {
        packageRoot: { type: "string", description: "Source Motion package containing a current persisted tracking lifecycle." },
        outDir: { type: "string", aliases: ["packageDir"], description: "Trusted empty output directory for the stabilized package copy." },
        analysisId: { type: "string", description: "Last-good tracking analysis to compile into ordinary transform keyframes." },
        layerId: { type: "string", description: "Target footage layer id." },
        segmentIndex: { type: "number", minimum: 0, description: "Required explicit confidence-qualified segment for a partial track." },
        includeLowConfidence: { type: "boolean", description: "Explicitly include low-confidence samples while preserving lost gaps." },
        receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [{ operation: "analysis.tracking.apply", mode: "emits", required: true, artifactRoles: ["motion_package", "tracking_lifecycle", "tracking_receipt"] }],
  },
  "motion.analysis.tracking.detach": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "layerId"],
      properties: {
        packageRoot: { type: "string", description: "Source Motion package with attached tracking stabilization." },
        outDir: { type: "string", aliases: ["packageDir"], description: "Trusted empty output directory for the detached package copy." },
        layerId: { type: "string", description: "Layer whose exact prior transform keyframes must be restored." },
        receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [{ operation: "analysis.tracking.detach", mode: "emits", required: true, artifactRoles: ["motion_package", "tracking_lifecycle", "tracking_receipt"] }],
  },
  "motion.analysis.tracking.verify": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "layerId"],
      properties: {
        packageRoot: { type: "string", description: "Motion package whose attachment, generated keyframes, and source identity are verified." },
        layerId: { type: "string", description: "Stabilized layer id." },
        analysisId: { type: "string", description: "Optional expected tracking analysis id." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [{ operation: "analysis.tracking.apply", mode: "reads", required: false, artifactRoles: ["tracking_lifecycle"] }],
  },
} as const satisfies MotionDebugCommandMetadata;
