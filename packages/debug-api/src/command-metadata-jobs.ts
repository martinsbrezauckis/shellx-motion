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
  "motion.connector.catalog": {
    argsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.connector.submit": {
    argsSchema: {
      type: "object",
      required: ["capabilityId", "descriptorRevision", "descriptorFingerprint", "requestSchemaId", "request"],
      properties: {
        jobId: { type: "string", maxLength: 128, description: "Optional stable job handle. Motion mints one when omitted." },
        capabilityId: { type: "string", maxLength: 128, description: "Exact capability id selected from the current Motion capability catalog." },
        descriptorRevision: { type: "number", minimum: 1, description: "Exact descriptor revision observed during discovery." },
        descriptorFingerprint: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$", description: "Exact descriptor fingerprint observed during discovery." },
        requestSchemaId: { type: "string", maxLength: 192, description: "Exact request schema id advertised by the selected descriptor." },
        request: { type: "object", maxProperties: 16, additionalProperties: true, description: "Closed descriptor-defined request. Filesystem paths and URLs are refused; reference fields contain only host-issued opaque handles." }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
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
        packageRoot: { type: "string", description: "Motion package root to check for structural validity." },
        receiptsRoot: { type: "string", description: "Optional governed host receipt destination, outside packageRoot. Caller paths are fenced to host-approved roots." }
      },
      additionalProperties: false
    },
    expectedReceipts: [{ operation: "package.validate", mode: "emits", required: false }]
  },
  "motion.platform.requirements": {
    argsSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["preview.frame", "render.final", "quality.check"],
          description: "Scope the answer to the operation you are about to attempt, so a tool you do not need cannot report you as unready. The response also reports source-only GPU launch policy; it never opens Chromium or WebGPU. Omit to ask about the whole machine."
        }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.platform.gpu.probe": {
    argsSchema: {
      type: "object",
      required: ["confirm"],
      properties: {
        confirm: {
          type: "boolean",
          description: "Required explicit acknowledgement. Set true only to open one pre-contained Chromium WebGPU session and perform its bounded 4-by-4 frame/readback hardware proof."
        }
      },
      additionalProperties: false
    },
    expectedReceipts: [{ operation: "gpu.hardware.probe", mode: "emits", required: true }]
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
  },
  "motion.job.events": {
    argsSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "Job whose durable coordinator events to read." },
        after: { type: "number", minimum: 0, description: "Return events strictly after this sequence number; omit for the retained event log." }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.job.submit": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outputPath"],
      properties: {
        jobId: { type: "string", maxLength: 128, description: "Optional stable 1..128-character job handle. Motion mints one when omitted." },
        packageRoot: { type: "string", description: "Existing Motion package to render." },
        outputPath: { type: "string", description: "Final local output path, subject to the host's normal render policy." },
        preset: { type: "string", description: "Final-video FFmpeg export preset; defaults to mp4-h264. Still and image-sequence presets use motion.render.final instead." },
        frameLane: { type: "string", enum: ["browser", "native", "gpu"], default: "browser", description: "Rasterizer for the coordinator-cancellable final render. GPU is strict raw-RGBA FFmpeg final video, direct or durably segmented: no materialization, workflow, exact-source quality, reuse, or cache path." },
        segmented: {
          type: "object",
          required: ["segmentFrames"],
          additionalProperties: false,
          properties: {
            segmentFrames: { type: "number", minimum: 1, maximum: 2147483647, description: "Closed resumable-final segment size in whole frames." },
            resume: { type: "boolean", default: false, description: "Reuse only verified local lossless segment checkpoints derived from the final output path." }
          },
          description: "Optional closed durable segmented-final selector. It cannot be combined with streaming workflow or quality-manifest selectors."
        },
        receiptsRoot: { type: "string", description: "Optional host-governed receipt root." },
      },
      additionalProperties: false
    },
    expectedReceipts: [{ operation: "render.final", mode: "emits", required: false }]
  },
  "motion.job.cancel": {
    argsSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "Active job to stop." },
        reason: { type: "string", maxLength: 512, description: "Optional operator explanation recorded with the terminal cancellation." }
      },
      additionalProperties: false
    },
    expectedReceipts: []
  },
  "motion.job.retry": {
    argsSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "Retryable failed source job." },
        newJobId: { type: "string", maxLength: 128, description: "Optional distinct handle for the new linked run." }
      },
      additionalProperties: false
    },
    expectedReceipts: [{ operation: "render.final", mode: "emits", required: false }]
  }
};
