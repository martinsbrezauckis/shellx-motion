/**
 * Argument contracts for the host-level render commands.
 *
 * Split out of `command-metadata-core.ts` when declaring `jobId` pushed that module past its size
 * budget. `motion.render.final` and `motion.render.batch` are the only commands the job surface
 * treats as HOST jobs; `motion.render.cache.plan` is a non-mutating observation of final-render
 * reuse, so keeping the adjacent contracts together matches their render-domain dispatch.
 *
 * Dependencies: `command-registry.ts` (types only). Primary caller: `command-metadata.ts`.
 */
import { MAX_BATCH_QUALITY_ROWS } from "@shellx-motion/core";
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { MAX_RENDER_CACHE_PLAN_AT_MS } from "./domains/render-cache-plan-input.js";

export const RENDER_COMMAND_METADATA: MotionDebugCommandMetadata = {
  "motion.render.cache.plan": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outputPath"],
      properties: {
        packageRoot: { type: "string", maxLength: 4_096, description: "Motion package root whose bounded current bytes contribute to the v2 reuse identity. The value is never echoed." },
        outputPath: { type: "string", maxLength: 4_096, description: "Requested file output path used only to derive v2 root-relative identity. No output, descriptor, or path is returned." },
        preset: { type: "string", enumRef: "exportPreset", maxLength: 64, default: "mp4-h264", description: "File-producing export preset to inspect for exact v2 attested reuse." },
        frameLane: { type: "string", enum: ["browser", "native"], maxLength: 64, default: "browser", description: "Frame rasterizer lane included in the exact v2 render identity. GPU post-render identity is completed-render evidence only; it does not authorize cache planning or attested reuse." },
        atMs: { type: "number", minimum: 0, maximum: MAX_RENDER_CACHE_PLAN_AT_MS, description: "Timestamp in milliseconds for a still-frame identity." },
        minUniqueFrameHashes: { type: "number", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Optional final-video quality identity threshold." },
        workflowPath: { type: "string", maxLength: 4_096, description: "Optional trusted shellx-motion/browser-workflow@1 file. Inline workflow is intentionally outside this compact plan surface." },
        qualityManifestPath: { type: "string", maxLength: 4_096, description: "Optional trusted shellx-motion/quality-manifest@1 file and its bounded baseline closure." },
      },
      additionalProperties: false,
    },
  },
  "motion.render.final": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outputPath"],
      properties: {
        jobId: { type: "string", description: "Name this job so a host can query it with motion.job.get while the render runs. Omitted, Motion mints one and returns it as jobId on the result. 1..128 chars of letters, digits, dot, underscore, colon or hyphen." },
        packageRoot: { type: "string", description: "Motion package root to render." },
        outputPath: { type: "string", description: "Final media, still-frame, or image-sequence output path." },
        preset: { type: "string", enumRef: "exportPreset", default: "mp4-h264", description: "Export preset for the rendered output." },
        frameLane: { type: "string", enum: ["browser", "native", "gpu"], default: "browser", description: "Frame rasterizer lane. native uses the bounded native capability and refuses unsupported layers or non-deliverable text instead of falling back. gpu uses the strict WebGPU raw-RGBA producer for direct or durable-segmented FFmpeg final-video delivery; unsupported content or an unavailable GPU refuses without browser/native fallback. Browser is the production typography authority only for generated MotionIR text backed by manifest-declared font bytes; HTML/web/canvas typography is unverified and a maxFontFallbacks attestation refuses it. The CLI's separate --lane flag selects the delivery lane (native | ffmpeg)." },
        atMs: { type: "number", minimum: 0, description: "Timestamp in milliseconds for still-frame presets." },
        framesDir: { type: "string", description: "Optional trusted scratch directory used only for materialized final-video frames; it does not request retention." },
        keepFrames: { type: "boolean", description: "Explicitly retain materialized final-video FFmpeg frame PNGs. File-video exports stream directly to FFmpeg by default; a framesDir alone does not request retention." },
        segmented: {
          type: "object",
          required: ["segmentFrames"],
          additionalProperties: false,
          properties: {
            segmentFrames: { type: "number", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Canonical frames per durable FFV1 checkpoint. The checkpoint store is derived from outputPath and is never caller-addressable." },
            resume: { type: "boolean", default: false, description: "Resume only verified checkpoints from the derived store after an interrupted prior segmented render. Motion never breaks a retained lock automatically." }
          },
          description: "Opt into cancellable durable segmented final delivery. It is incompatible with framesDir, keepFrames, browser workflows, exact-source quality manifests, and reuseAttested."
        },
        minUniqueFrameHashes: { type: "number", minimum: 1, description: "Minimum unique rendered frame hashes for motion-quality gating." },
        workflowPath: { type: "string", description: "Optional deterministic browser workflow JSON path to replay before capture." },
        workflow: { type: "object", description: "Optional inline deterministic browser workflow, used instead of workflowPath." },
        qualityManifestPath: { type: "string", description: "Optional shellx-motion/quality-manifest@1 path to gate final output quality." },
        manifestPath: { type: "string", description: "Alias for qualityManifestPath." },
        receiptsRoot: { type: "string", description: "Host receipts root for render and optional quality-check receipts." },
        dryRun: { type: "boolean", description: "Plan the render without writing media." },
        reuseAttested: { type: "boolean", default: false, description: "Opt in to reusing only a v2 content-bound, receipt-attested file artifact at this exact output path. It performs no fresh browser or FFmpeg run on a verified hit, writes a fresh render.reuse receipt, and refuses dryRun, png-sequence, and keepFrames. No cache root, key, descriptor path, or receipt selector is caller-controlled." }
      },
      additionalProperties: true
    },
    expectedReceipts: [
      { operation: "render.final", mode: "emits", required: true, artifactRoles: ["rendered_media", "render_receipt"] },
      { operation: "render.reuse", mode: "emits", required: false, artifactRoles: ["rendered_media"] },
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
        rowId: { type: "string", maxLength: 256, description: "Single data row ID to render; normalized the same way as Motion data rows." },
        rowIds: { type: "array", maxItems: MAX_BATCH_QUALITY_ROWS, items: { type: "string", maxLength: 256 }, description: "Subset of at most 256 data row IDs to render; preserves source row order." },
        preset: { type: "string", enumRef: "exportPreset", default: "mp4-h264", description: "Export preset for the rendered output." },
        frameLane: { type: "string", enum: ["browser", "native", "gpu"], default: "browser", description: "Frame rasterizer for every row. GPU rows are fresh-only strict streamed FFmpeg video: absent host capability, GIF/still/sequence output, resume/cache, retained frames, or browser workflows refuse before queueing." },
        keepFrames: { type: "boolean", description: "Pass explicit final-video FFmpeg frame retention to every batch row; batch plans containing a non-video preset are refused. File-video rows stream directly to FFmpeg by default." },
        minUniqueFrameHashes: { type: "number", minimum: 1, description: "Minimum unique rendered frame hashes for motion-quality gating." },
        qualityManifestPath: { type: "string", description: "Optional shellx-motion/quality-manifest@1 path to gate each row output." },
        manifestPath: { type: "string", description: "Alias for qualityManifestPath." },
        workflow: { type: "object", description: "Inline shellx-motion/browser-workflow@1 replay plan for each rendered row." },
        workflowPath: { type: "string", description: "Optional deterministic browser workflow JSON path to replay for each rendered row." },
        dryRun: { type: "boolean", description: "Plan expanded row packages and receipts without rendering media." },
        resume: { type: "boolean", description: "Reuse completed row outputs only when idempotency and retained authenticated caller ownership match; resume without a host caller principal fails before output writes." }
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
