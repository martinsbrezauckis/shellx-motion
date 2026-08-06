/**
 * Argument contracts for the live job-query commands.
 *
 * Separate from `command-metadata-core.ts` because these describe a different subject: the core
 * module documents commands that act on a package, while these two answer "what is my work doing"
 * and are the surface a host such as ShellX Cut polls while a render is in flight.
 *
 * Dependencies: `command-registry.ts` (types only). Primary caller: `command-metadata.ts`, which
 * merges every metadata module into the one published contract.
 */
import { MOTION_DOCUMENT_LIMITS, supportedMotionColorAdvice } from "@shellx-motion/core";
import type { MotionDebugCommandMetadata } from "./command-registry.js";

/**
 * The bounds `createMotionPackage` enforces, quoted from core rather than restated.
 *
 * Written as an interpolation on purpose: the published contract an agent reads and the runtime that
 * refuses it have to move together. A hand-copied "1..7680" in a description survives a change to
 * the limit and then teaches every reader a number that is no longer true.
 */
const LIMITS = MOTION_DOCUMENT_LIMITS;

export const JOB_COMMAND_METADATA: MotionDebugCommandMetadata = {
  "motion.package.create": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Empty or non-existent directory to create the package in." },
        name: { type: "string", maxLength: 128, description: "Human-readable name, at most 128 characters; also seeds the readable half of the package and motion ids." },
        width: {
          type: "number",
          minimum: 1,
          maximum: LIMITS.maxDimension,
          default: 1920,
          description: `Frame width in pixels, 1 to ${LIMITS.maxDimension}. Width x height may not exceed ${LIMITS.maxFramePixels} pixels (7680x4320).`
        },
        height: {
          type: "number",
          minimum: 1,
          maximum: LIMITS.maxDimension,
          default: 1080,
          description: `Frame height in pixels, 1 to ${LIMITS.maxDimension}. Width x height may not exceed ${LIMITS.maxFramePixels} pixels (7680x4320).`
        },
        fps: {
          type: "number",
          minimum: LIMITS.minFps,
          maximum: LIMITS.maxFps,
          default: 30,
          description: `Frames per second, ${LIMITS.minFps} to ${LIMITS.maxFps}.`
        },
        durationMs: {
          type: "number",
          minimum: 1,
          maximum: LIMITS.maxDurationMs,
          default: 5000,
          description: `Total duration in milliseconds. Bounded with fps by the render budget: at most ${LIMITS.maxFrames} frames and ${LIMITS.maxPixelFrames} pixel-frames, so at 30 fps the longest package is ${(LIMITS.maxFrames * 1000) / 30}ms.`
        },
        background: { type: "string", description: `Document background. Must be a colour Motion renders: ${supportedMotionColorAdvice()}.` },
        empty: { type: "boolean", default: false, description: "Start with no layers. Off by default because a blank frame is indistinguishable from a failed render." }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.package.validate": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to check for structural validity." }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.platform.requirements": {
    argsSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["preview.frame", "render.final", "quality.check"],
          description: "Scope the answer to the operation you are about to attempt, so a tool you do not need cannot report you as unready. Omit to ask about the whole machine."
        }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.job.get": {
    argsSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "The job to read. Either the id returned by the render, or the id you supplied when starting it." },
        scope: {
          type: "string",
          enum: ["own", "all"],
          default: "own",
          description: "Whose jobs to read. \"all\" needs a host that granted cross-caller visibility and is refused otherwise."
        }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.job.list": {
    argsSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["own", "all"],
          default: "own",
          description: "Whose jobs to list. \"all\" needs a host that granted cross-caller visibility and is refused otherwise."
        },
        limit: { type: "number", minimum: 1, description: "Maximum jobs to return. Live work is listed first, then finished work newest first." }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  }
};
