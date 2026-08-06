/**
 * Argument contracts for the two host-level render commands.
 *
 * Split out of `command-metadata-core.ts` when declaring `jobId` pushed that module past its size
 * budget. These two are also the only commands the job surface treats as a HOST job — one render is
 * one observable job, whatever governed work it performs underneath — so keeping their contracts
 * together matches how they are actually dispatched.
 *
 * Dependencies: `command-registry.ts` (types only). Primary caller: `command-metadata.ts`.
 */
import type { MotionDebugCommandMetadata } from "./command-registry.js";

export const RENDER_COMMAND_METADATA: MotionDebugCommandMetadata = {
  "motion.render.final": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outputPath"],
      properties: {
        jobId: { type: "string", description: "Name this job so a host can query it with motion.job.get while the render runs. Omitted, Motion mints one and returns it as jobId on the result. 1..128 chars of letters, digits, dot, underscore, colon or hyphen." },
        packageRoot: { type: "string", description: "Motion package root to render." },
        outputPath: { type: "string", description: "Final media, still-frame, or image-sequence output path." },
        preset: { type: "string", enumRef: "exportPreset", default: "mp4-h264", description: "Export preset for the rendered output." },
        frameLane: { type: "string", enum: ["browser"], default: "browser", description: "Frame rasterizer lane. The Debug API accepts only browser. The CLI's separate --lane flag selects the delivery lane (native | ffmpeg) and does not accept browser; its --frame-lane flag is this argument." },
        atMs: { type: "number", minimum: 0, description: "Timestamp in milliseconds for still-frame presets." },
        framesDir: { type: "string", description: "Optional trusted scratch directory for FFmpeg frame extraction." },
        minUniqueFrameHashes: { type: "number", minimum: 1, description: "Minimum unique rendered frame hashes for motion-quality gating." },
        workflowPath: { type: "string", description: "Optional deterministic browser workflow JSON path to replay before capture." },
        workflow: { type: "object", description: "Optional inline deterministic browser workflow, used instead of workflowPath." },
        qualityManifestPath: { type: "string", description: "Optional shellx-motion/quality-manifest@1 path to gate final output quality." },
        manifestPath: { type: "string", description: "Alias for qualityManifestPath." },
        receiptsRoot: { type: "string", description: "Host receipts root for render and optional quality-check receipts." },
        dryRun: { type: "boolean", description: "Plan the render without writing media." }
      },
      additionalProperties: true
    },
    expectedReceipts: [
      { operation: "render.final", mode: "emits", required: true, artifactRoles: ["rendered_media", "render_receipt"] },
      { operation: "quality.check", mode: "emits", required: false, artifactRoles: ["quality_receipt"] }
    ]
  },
  "motion.render.batch": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir"],
      properties: {
        jobId: { type: "string", description: "Name this job so a host can query it with motion.job.get while the render runs. Omitted, Motion mints one and returns it as jobId on the result. 1..128 chars of letters, digits, dot, underscore, colon or hyphen." },
        packageRoot: { type: "string", description: "Motion package root containing manifest, motion, assets, and optional data rows." },
        outDir: { type: "string", description: "Directory for expanded row packages, render outputs, and batch receipts." },
        rowsPath: { type: "string", description: "Optional external CSV or JSON data rows file." },
        rowId: { type: "string", description: "Single data row ID to render; normalized the same way as Motion data rows." },
        rowIds: { type: "array", description: "Subset of data row IDs to render; preserves source row order." },
        preset: { type: "string", enumRef: "exportPreset", default: "mp4-h264", description: "Export preset for the rendered output." },
        minUniqueFrameHashes: { type: "number", minimum: 1, description: "Minimum unique rendered frame hashes for motion-quality gating." },
        qualityManifestPath: { type: "string", description: "Optional shellx-motion/quality-manifest@1 path to gate each row output." },
        manifestPath: { type: "string", description: "Alias for qualityManifestPath." },
        workflow: { type: "object", description: "Inline shellx-motion/browser-workflow@1 replay plan for each rendered row." },
        workflowPath: { type: "string", description: "Optional deterministic browser workflow JSON path to replay for each rendered row." },
        dryRun: { type: "boolean", description: "Plan expanded row packages and receipts without rendering media." },
        resume: { type: "boolean", description: "Reuse completed row outputs when idempotency evidence still matches." }
      },
      additionalProperties: true
    },
    expectedReceipts: [
      { operation: "render.batch", mode: "emits", required: true, artifactRoles: ["batch_receipt"] },
      { operation: "render.batch.row", mode: "emits", required: true, artifactRoles: ["row_package", "planned_output"] },
      { operation: "render.final", mode: "emits", required: false, artifactRoles: ["rendered_media", "render_receipt"] },
      { operation: "quality.check", mode: "emits", required: false, artifactRoles: ["quality_receipt"] }
    ]
  }
};
