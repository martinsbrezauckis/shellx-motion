/**
 * Argument and receipt contracts for the debug commands that already carried metadata
 * before the argument-contract sweep.
 *
 * Role: moved verbatim out of index.ts so the contract data is importable without pulling in
 * the dispatcher. That lets domains/agent.ts enrich actions.guide with argument contracts
 * without an import cycle through index.ts.
 *
 * Dependencies: command-registry.ts types only. Primary caller: command-metadata.ts.
 */
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";

/**
 * Template discovery arguments — the roots to search, the delivery target to score against, and the
 * capability filters.
 *
 * `motion.template.catalog` and `motion.template.plan` run the SAME argument parser
 * (`domains/authoring-template-read.ts#catalogRoots/catalogTarget/catalogFilters`), so they accept
 * exactly this set. They are declared once because a property present on one and missing on the
 * other is not a documentation slip: `additionalProperties: false` turns it into a rejected call.
 *
 * The `target*` names are the handler's declared synonyms, checked second in each `??` chain.
 */
const TEMPLATE_SELECTION: Record<string, MotionDebugArgPropertySchema> = {
  templateRoot: { type: "string", aliases: ["templatesRoot", "root"], description: "Directory containing one or more Motion packages with template sidecars." },
  packageRoot: { type: "string", description: "Single Motion package root to inspect." },
  packageRoots: { type: "array", description: "Explicit Motion package roots to inspect." },
  targetHost: { type: "string", aliases: ["host"], description: "Optional host target such as shellx-cut or shellx-canvas for compatibility scoring." },
  targetLane: { type: "string", aliases: ["lane"], description: "Optional renderer lane target such as browser, native, or ffmpeg." },
  aspectRatio: { type: "string", aliases: ["targetAspectRatio"], description: "Optional output aspect ratio such as 16:9 or 9:16; derived from width and height when omitted." },
  durationMs: { type: "number", aliases: ["targetDurationMs"], description: "Optional target duration in milliseconds for template bounds scoring." },
  width: { type: "number", aliases: ["targetWidth"], description: "Optional target output width for template bounds scoring." },
  height: { type: "number", aliases: ["targetHeight"], description: "Optional target output height for template bounds scoring." },
  targetCommercialUse: { type: "boolean", aliases: ["commercialUse"], description: "Keep only templates whose licence permits commercial use." },
  renderCost: { type: "string", enum: ["low", "medium", "high"], description: "Keep only templates in this render-cost band." },
  outputType: { type: "string", description: "Keep only templates that produce this output type." },
  requiresMedia: { type: "boolean", description: "Keep only templates that do (true) or do not (false) require caller-supplied media." },
  requiresAudio: { type: "boolean", description: "Keep only templates that do (true) or do not (false) require caller-supplied audio." },
  designFamily: { type: "string", description: "Keep only templates in this design family." }
};

export const CORE_COMMAND_METADATA = {
  "motion.capabilities.match": {
    argsSchema: {
      type: "object",
      properties: {
        packageRoot: { type: "string", description: "Optional Motion package root to match against renderer capability cards." },
        output: { type: "string", description: "Requested output such as png-frame, mp4-h264, mp4-hevc, webm-av1, webm-vp9, gif, cut-plan, or motion-package." },
        target: { type: "string", description: "Requested workflow target such as preview, final, batch, cut, canvas, or handoff." },
        needsAlpha: { type: "boolean", description: "Whether the selected lane must preserve alpha." },
        needsAudio: { type: "boolean", description: "Whether the selected lane must handle audio." },
        needsSubtitles: { type: "boolean", description: "Whether the selected lane must handle subtitles or captions." },
        preferLane: { type: "string", description: "Optional preferred lane used as a tie breaker." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "capabilities.match", mode: "reads", required: false }
    ]
  },
  "motion.capabilities.panel": {
    argsSchema: {
      type: "object",
      properties: {
        packageRoot: { type: "string", description: "Optional Motion package root to summarize against renderer capability cards." },
        output: { type: "string", description: "Requested output such as png-frame, mp4-h264, mp4-hevc, webm-av1, webm-vp9, gif, cut-plan, or motion-package." },
        target: { type: "string", description: "Requested workflow target such as preview, final, batch, cut, canvas, or handoff." },
        needsAlpha: { type: "boolean", description: "Whether the selected lane must preserve alpha." },
        needsAudio: { type: "boolean", description: "Whether the selected lane must handle audio." },
        needsSubtitles: { type: "boolean", description: "Whether the selected lane must handle subtitles or captions." },
        preferLane: { type: "string", description: "Optional preferred lane used as a tie breaker." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "capabilities.panel", mode: "reads", required: false }
    ]
  },
  "motion.quality.panel": {
    argsSchema: {
      type: "object",
      required: ["qualityManifestPath"],
      properties: {
        qualityManifestPath: { type: "string", description: "Quality manifest JSON path to inspect." },
        manifestPath: { type: "string", description: "Alias for qualityManifestPath." },
        inputPath: { type: "string", description: "Optional final media path used to seed quality-check follow-up commands." },
        packageRoot: { type: "string", description: "Optional Motion package root for package and render follow-up metadata." },
        preset: { type: "string", enumRef: "exportPreset", description: "Optional export preset used for render/export follow-up commands." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "quality.panel", mode: "reads", required: false }
    ]
  },
  "motion.timeline.keyframes.panel": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to inspect for timeline keyframes." },
        layerId: { type: "string", aliases: ["layer"], description: "Optional layer id filter." },
        target: { type: "string", enumRef: "keyframeTarget", description: "Optional keyframe target filter." },
        includeEmpty: { type: "boolean", description: "Include layers that have no matching keyframes." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "timeline.keyframes.panel", mode: "reads", required: false }
    ]
  },
  "motion.timeline.transitions.panel": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to inspect for layer transitions." },
        layerId: { type: "string", aliases: ["layer"], description: "Optional layer id filter." },
        edge: { type: "string", enum: ["in", "out"], description: "Optional transition edge filter." },
        includeEmpty: { type: "boolean", description: "Include layers that have no matching transitions." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "timeline.transitions.panel", mode: "reads", required: false }
    ]
  },
  "motion.timeline.easing.panel": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to inspect for easing curve usage." },
        sampleCount: { type: "number", minimum: 2, maximum: 512, description: "Number of normalized t/value samples to include per easing curve. Capped because the panel samples every easing row, so the cost is rowCount * sampleCount." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "timeline.easing.panel", mode: "reads", required: false }
    ]
  },
  "motion.audio.panel": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to inspect for resolved audio mix inputs." },
        preset: { type: "string", enumRef: "exportPreset", description: "Optional export preset used to report audio compatibility warnings." },
        exportPreset: { type: "string", description: "Alias for preset." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "audio.panel", mode: "reads", required: false }
    ]
  },
  "motion.media.panel": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to inspect for image, video, audio, and web media layer readiness." },
        preset: { type: "string", enumRef: "exportPreset", description: "Optional export preset used to report media/audio compatibility warnings." },
        exportPreset: { type: "string", description: "Alias for preset." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "media.panel", mode: "reads", required: false }
    ]
  },
  "motion.connector.panel": {
    argsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "connector.panel", mode: "reads", required: false }
    ]
  },
  "motion.agent.panel": {
    argsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "agent.panel", mode: "reads", required: false }
    ]
  },
  "motion.agent.revision.plan": {
    argsSchema: {
      type: "object",
      required: ["packageId"],
      properties: {
        packageId: { type: "string", description: "Motion package id the revision plan applies to." },
        templateId: { type: "string", description: "Optional template id the revision plan applies to." },
        sourceJobId: { type: "string", description: "Optional prompt/agent job id that produced the package or render." },
        planId: { type: "string", description: "Optional deterministic revision plan id." },
        createdAt: { type: "string", description: "Optional deterministic ISO timestamp for the revision plan." },
        receiptsRoot: { type: "string", description: "Receipts root used to resolve quality receipt ids." },
        qualityReceiptId: { type: "string", description: "Quality receipt id to include as critique evidence." },
        qualityReceiptIds: { type: "array", description: "Quality receipt ids to include as critique evidence." },
        qualityReceiptPath: { type: "string", description: "Path to a quality receipt JSON file." },
        qualityReceiptPaths: { type: "array", description: "Paths to quality receipt JSON files." },
        qualityReceipt: { type: "object", description: "Inline shellx-motion receipt@1 quality-check receipt." },
        qualityReceipts: { type: "array", description: "Inline shellx-motion receipt@1 quality-check receipts." },
        contactSheet: { type: "object", description: "Inline contact-sheet critique evidence with status and notes." },
        contactSheetPath: { type: "string", aliases: ["contactSheetFile"], description: "Path to a contact-sheet critique JSON file." },
        planPath: { type: "string", description: "Optional output path for the written revision plan JSON." },
        outputPath: { type: "string", description: "Alias for planPath." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "quality.check", mode: "reads", required: false },
      { operation: "agent.revision.plan", mode: "emits", required: false }
    ]
  },
  "motion.storyboard.panel": {
    argsSchema: {
      type: "object",
      properties: {
        scriptPath: { type: "string", description: "Path to a shellx-motion scripted-video JSON document." },
        storyboardPath: { type: "string", description: "Alias for scriptPath when called from storyboard workflows." },
        path: { type: "string", description: "Alias for scriptPath." },
        script: { type: "object", description: "Inline shellx-motion scripted-video document." },
        storyboard: { type: "object", description: "Alias for script when called from Cut Generate or prompt storyboard workflows." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "storyboard.panel", mode: "reads", required: false }
    ]
  },
  "motion.storyboard.graph": {
    argsSchema: {
      type: "object",
      properties: {
        scriptPath: { type: "string", description: "Path to a shellx-motion scripted-video JSON document." },
        storyboardPath: { type: "string", description: "Alias for scriptPath when called from storyboard workflows." },
        path: { type: "string", description: "Alias for scriptPath." },
        script: { type: "object", description: "Inline shellx-motion scripted-video document." },
        storyboard: { type: "object", description: "Alias for script when called from Cut Generate or prompt storyboard workflows." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "storyboard.graph", mode: "reads", required: false }
    ]
  },
  "motion.export.plan": {
    argsSchema: {
      type: "object",
      properties: {
        packageRoot: { type: "string", description: "Optional Motion package root to inspect before choosing an export preset." },
        target: { type: "string", description: "Requested delivery target such as Cut, Canvas MP4, transparent overlay, thumbnail, or batch frames." },
        preset: { type: "string", enumRef: "exportPreset", description: "Optional explicit export preset. If omitted Motion chooses a preset from target and feature needs." },
        outputPath: { type: "string", aliases: ["out"], description: "Optional final output path to include in follow-up render arguments." },
        qualityManifestPath: { type: "string", aliases: ["manifestPath"], description: "Optional quality manifest path to include in render and quality-check follow-ups." },
        receiptsRoot: { type: "string", description: "Optional receipts root containing platform verification evidence." },
        requiredHosts: { type: "array", description: "Required host ids for platform verification status." },
        needsAlpha: { type: "boolean", description: "Whether the export must preserve transparency." },
        needsAudio: { type: "boolean", description: "Whether the export must preserve audio." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "export.plan", mode: "reads", required: false },
      { operation: "platform.verification", mode: "reads", required: false },
      { operation: "platform.verification.aggregate", mode: "reads", required: false }
    ]
  },
  "motion.preview.frame": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to preview." },
        atMs: { type: "number", minimum: 0, description: "Frame timestamp in milliseconds." },
        outDir: { type: "string", description: "Directory for generated preview artifacts." },
        outputPath: { type: "string", description: "Explicit preview frame output path." },
        createdAt: { type: "string", description: "Deterministic ISO timestamp for emitted preview receipts." },
        workflowPath: { type: "string", description: "Optional deterministic browser workflow JSON path." },
        workflow: { type: "object", description: "Optional inline deterministic browser workflow, used instead of workflowPath." }
      },
      additionalProperties: true
    },
    expectedReceipts: [
      { operation: "preview.frame", mode: "emits", required: true, artifactRoles: ["preview_frame"] }
    ]
  },
  "motion.browser.workflow.capture": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to capture through the deterministic browser lane." },
        outDir: { type: "string", description: "Directory for captured frame, trace, catalog, and receipt artifacts." },
        outputPath: { type: "string", description: "Explicit browser-captured frame output path." },
        atMs: { type: "number", minimum: 0, description: "Frame timestamp in milliseconds." },
        workflow: { type: "object", description: "Inline shellx-motion/browser-workflow@1 replay plan." },
        workflowPath: { type: "string", description: "Path to a shellx-motion/browser-workflow@1 replay plan." },
        catalogPath: { type: "string", description: "Optional browser workflow catalog path for drift evidence." },
        workflowCatalogPath: { type: "string", description: "Alias for catalogPath." },
        recordingManifestPath: { type: "string", description: "Optional path for a sampled deterministic browser recording manifest." },
        recordingFramesDir: { type: "string", description: "Optional directory for sampled browser recording frames." },
        recordingSampleCount: { type: "number", minimum: 1, maximum: 240, description: "Number of deterministic frame samples to include in the recording manifest. Capped because each sample is a browser render written to disk." },
        failOnDrift: { type: "boolean", description: "Return an error when catalog drift is detected." }
      },
      additionalProperties: true
    },
    expectedReceipts: [
      { operation: "browser.workflow.capture", mode: "emits", required: true, artifactRoles: ["preview_frame", "preview_receipt"] },
      { operation: "browser.workflow.capture", mode: "emits", required: false, artifactRoles: ["browser_workflow_trace", "browser_workflow_catalog", "browser_recording_manifest"] }
    ]
  },
  "motion.render.queue": {
    argsSchema: {
      type: "object",
      properties: {
        receiptsRoot: { type: "string", description: "Host receipts root to inspect for render jobs." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "render.final", mode: "reads", required: false },
      { operation: "render.cancel", mode: "reads", required: false },
      { operation: "render.retry", mode: "reads", required: false }
    ]
  },
  "motion.prompt.queue": {
    argsSchema: {
      type: "object",
      properties: {
        receiptsRoot: { type: "string", description: "Host receipts root to inspect for prompt and local-agent jobs." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "prompt.run", mode: "reads", required: false },
      { operation: "agent.prompt", mode: "reads", required: false },
      { operation: "prompt.cancel", mode: "reads", required: false },
      { operation: "prompt.retry", mode: "reads", required: false }
    ]
  },
  "motion.prompt.cancel": {
    argsSchema: {
      type: "object",
      required: ["receiptsRoot", "receiptId"],
      properties: {
        receiptsRoot: { type: "string", description: "Host receipts root containing the target prompt job receipt." },
        receiptId: { type: "string", aliases: ["id"], description: "Queued or running prompt job receipt id to cancel." },
        reason: { type: "string", description: "Optional cancellation reason for receipt evidence." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "prompt.run", mode: "reads", required: true },
      { operation: "prompt.cancel", mode: "emits", required: true, artifactRoles: ["target_receipt"] }
    ]
  },
  "motion.prompt.retry": {
    argsSchema: {
      type: "object",
      required: ["receiptsRoot", "receiptId"],
      properties: {
        receiptsRoot: { type: "string", description: "Host receipts root containing the source prompt job receipt." },
        receiptId: { type: "string", aliases: ["id"], description: "Failed or cancelled prompt job receipt id to retry." },
        reason: { type: "string", description: "Optional retry reason for receipt evidence." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "prompt.run", mode: "reads", required: true },
      { operation: "prompt.retry", mode: "emits", required: true, artifactRoles: ["source_receipt"] }
    ]
  },
  "motion.review.html.bundle": {
    argsSchema: {
      type: "object",
      required: ["outDir"],
      properties: {
        packageRoot: { type: "string", description: "Optional Motion package root for package summary metadata." },
        outDir: { type: "string", description: "Trusted empty output directory for the portable review HTML bundle." },
        receiptsRoot: { type: "string", description: "Host receipts root to collect render, batch, quality, and connector evidence." },
        title: { type: "string", description: "Optional review title shown in the generated HTML." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "render.final", mode: "reads", required: false },
      { operation: "render.batch", mode: "reads", required: false },
      { operation: "quality.check", mode: "reads", required: false },
      { operation: "review.html.bundle", mode: "emits", required: true, artifactRoles: ["review_html_bundle", "review_html_bundle_receipt"] }
    ]
  },
  "motion.source.import": {
    argsSchema: {
      type: "object",
      required: ["url", "outDir"],
      properties: {
        url: { type: "string", description: "Public http(s) source URL to preserve as source identity." },
        outDir: { type: "string", description: "Trusted empty output directory for the imported Markdown source." },
        receiptsRoot: { type: "string", description: "Optional host receipts root for source-import receipt copies." },
        markdown: { type: "string", description: "Optional pre-fetched Markdown content. When omitted, the debug API fetches the URL." },
        title: { type: "string", description: "Optional source title." },
        kind: { type: "string", description: "Optional source kind: article, repo, or text." },
        maxChars: { type: "number", minimum: 1, description: "Maximum Markdown body characters kept before truncation." },
        createdBy: { type: "string", description: "Optional actor recorded in receipt output." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "source.import", mode: "emits", required: true, artifactRoles: ["source_markdown", "source_import_receipt"] }
    ]
  },
  "motion.source.to_scripted_video": {
    argsSchema: {
      type: "object",
      required: ["sourcePath", "outDir"],
      properties: {
        sourcePath: { type: "string", aliases: ["source", "sourceMarkdownPath"], description: "Imported source.md path from motion.source.import." },
        outDir: { type: "string", description: "Trusted empty output directory for scripted-video JSON and receipt evidence." },
        receiptsRoot: { type: "string", description: "Optional host receipts root for source-storyboard receipt copies." },
        maxFrames: { type: "number", minimum: 1, description: "Maximum storyboard frames to emit." },
        frameDurationMs: { type: "number", minimum: 500, description: "Duration for each generated storyboard frame." },
        width: { type: "number", minimum: 16, description: "Scripted-video output width." },
        height: { type: "number", minimum: 16, description: "Scripted-video output height." },
        fps: { type: "number", minimum: 1, description: "Scripted-video frame rate." },
        createdBy: { type: "string", description: "Optional actor recorded in receipt output." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "source.to_scripted_video", mode: "emits", required: true, artifactRoles: ["scripted_video", "source_storyboard_receipt"] }
    ]
  },
  "motion.html.snippet.export": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to export." },
        outDir: { type: "string", description: "Trusted empty output directory for the standalone HTML snippet." },
        createdAt: { type: "string", description: "Optional deterministic receipt timestamp." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "html.snippet.export", mode: "emits", required: true, artifactRoles: ["html_snippet", "html_snippet_receipt"] }
    ]
  },
  "motion.html.snippet.import": {
    argsSchema: {
      type: "object",
      required: ["htmlPath", "packageDir"],
      properties: {
        htmlPath: { type: "string", description: "Trusted ShellX/HyperFrames-style HTML snippet path to import." },
        packageDir: { type: "string", description: "Trusted empty output package directory." },
        createdAt: { type: "string", description: "Optional deterministic receipt timestamp." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "html.snippet.import", mode: "emits", required: true, artifactRoles: ["motion_package", "html_snippet_import_receipt"] }
    ]
  },
  "motion.otio.export": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outPath"],
      properties: {
        packageRoot: { type: "string", description: "Motion package root to export." },
        outPath: { type: "string", description: "Trusted output .otio timeline path." },
        createdAt: { type: "string", description: "Optional deterministic receipt timestamp." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "otio.export", mode: "emits", required: true, artifactRoles: ["otio_timeline", "otio_export_receipt"] }
    ]
  },
  "motion.otio.import": {
    argsSchema: {
      type: "object",
      required: ["otioPath", "packageDir"],
      properties: {
        otioPath: { type: "string", description: "OpenTimelineIO .otio timeline path to import." },
        packageDir: { type: "string", description: "Trusted output Motion package directory." },
        createdAt: { type: "string", description: "Optional deterministic receipt timestamp." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "otio.import", mode: "emits", required: true, artifactRoles: ["motion_package", "otio_import_receipt"] }
    ]
  },
  "motion.package.extract": {
    argsSchema: {
      type: "object",
      required: ["archivePath", "packageRoot"],
      properties: {
        archivePath: { type: "string", aliases: ["inPath", "archive"], description: "Portable .shellxmotion archive to extract." },
        packageRoot: { type: "string", aliases: ["outDir", "out"], description: "Trusted output Motion package directory." },
        receiptPath: { type: "string", description: "Optional package archive extraction receipt path." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "package.archive.extract", mode: "emits", required: true, artifactRoles: ["motion_package", "motion_package_archive", "package_archive_extract_receipt"] }
    ]
  },
  "motion.template.catalog": {
    argsSchema: {
      type: "object",
      properties: TEMPLATE_SELECTION,
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "template.catalog", mode: "reads", required: false }
    ]
  },
  "motion.template.plan": {
    argsSchema: {
      type: "object",
      required: ["request"],
      properties: {
        request: { type: "string", description: "Prompt or user intent to match against available templates." },
        prompt: { type: "string", description: "Alias for request." },
        values: { type: "object", description: "Optional draft template param values keyed by param id; used to classify provided, defaulted, and missing inputs before mutation." },
        ...TEMPLATE_SELECTION
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "template.plan", mode: "reads", required: false }
    ]
  },
  "motion.template.apply": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "values"],
      properties: {
        packageRoot: { type: "string", description: "Template Motion package root." },
        outDir: { type: "string", aliases: ["packageDir"], description: "Output package directory for applied template values." },
        receiptsRoot: { type: "string", description: "Optional host receipts root for a copied receipt." },
        values: { type: "object", description: "Template param values keyed by param id." },
        createdBy: { type: "string", description: "Agent or host actor label for receipt provenance." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "template.apply", mode: "emits", required: true, artifactRoles: ["motion_package", "template_apply_receipt"] }
    ]
  },
  "motion.support.bundle": {
    argsSchema: {
      type: "object",
      required: ["outDir"],
      properties: {
        packageRoot: { type: "string", description: "Optional Motion package root to include in diagnostics." },
        outDir: { type: "string", description: "Trusted empty output directory for the support bundle." },
        receiptsRoot: { type: "string", description: "Optional host receipts root to summarize." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "support.bundle", mode: "emits", required: true, artifactRoles: ["support_bundle", "support_receipt"] }
    ]
  },
  "motion.platform.verification.panel": {
    argsSchema: {
      type: "object",
      properties: {
        receiptsRoot: { type: "string", description: "Host receipts root containing platform verification receipts." },
        requiredHosts: { type: "array", description: "Optional required host ids to compare against collected receipts." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "platform.verification", mode: "reads", required: false },
      { operation: "platform.verification.aggregate", mode: "reads", required: false }
    ]
  },
  "motion.connector.canvas_to_mp4": {
    argsSchema: {
      type: "object",
      required: ["canvasSelectionPath", "outDir"],
      properties: {
        canvasSelectionPath: { type: "string", description: "Canvas frame-selection JSON exported by Canvas or motion.canvas.bridge_export." },
        outDir: { type: "string", description: "Trusted output directory for the Motion package, render artifacts, and connector receipt." },
        preset: { type: "string", enumRef: "exportPreset", default: "mp4-h264", description: "Export preset for the rendered output." },
        dryRunRender: { type: "boolean", description: "Plan the render without encoding media." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "connector.canvas_to_mp4", mode: "emits", required: true, artifactRoles: ["motion_package", "resource_catalog", "rendered_media", "render_receipt", "connector_receipt"] }
    ]
  },
  "motion.connector.canvas_to_cut": {
    argsSchema: {
      type: "object",
      required: ["canvasSelectionPath", "outDir"],
      properties: {
        canvasSelectionPath: { type: "string", description: "Canvas frame-selection JSON exported by Canvas or motion.canvas.bridge_export." },
        outDir: { type: "string", description: "Trusted output directory for package, render, Cut import plan, and connector receipt artifacts." },
        cutImportMode: { type: "string", description: "Cut import mode, such as rendered_media or editable_lowering." },
        dryRunRender: { type: "boolean", description: "Plan required renders without encoding media." },
        createdAt: { type: "string", description: "Deterministic ISO timestamp for connector receipts and package provenance." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "connector.canvas_to_cut", mode: "emits", required: true, artifactRoles: ["canvas_selection", "motion_package", "preview_frame", "preview_receipt", "render_receipt", "cut_plan", "connector_receipt"] },
      { operation: "connector.canvas_to_cut", mode: "emits", required: false, artifactRoles: ["rendered_media"] }
    ]
  },
  "motion.connector.script_to_cut": {
    argsSchema: {
      type: "object",
      required: ["outDir"],
      properties: {
        scriptPath: { type: "string", description: "Path to a shellx-motion scripted-video JSON document." },
        script: { type: "object", description: "Inline shellx-motion scripted-video document." },
        storyboard: { type: "object", description: "Alias for script when called from Cut Generate workflows." },
        outDir: { type: "string", description: "Trusted output directory for package, preview, render, Cut import plan, and connector receipt artifacts." },
        cutImportMode: { type: "string", description: "Cut import mode, such as rendered_media or editable_lowering." },
        dryRunRender: { type: "boolean", description: "Plan required renders without encoding media." },
        createdAt: { type: "string", description: "Deterministic ISO timestamp for connector receipts and package provenance." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "connector.script_to_cut", mode: "emits", required: true, artifactRoles: ["scripted_video", "motion_package", "preview_frame", "preview_receipt", "render_receipt", "cut_plan", "connector_receipt"] },
      { operation: "connector.script_to_cut", mode: "emits", required: false, artifactRoles: ["rendered_media"] }
    ]
  },
  "motion.connector.source_to_cut": {
    argsSchema: {
      type: "object",
      required: ["sourcePath", "outDir"],
      properties: {
        sourcePath: { type: "string", description: "Path to imported source Markdown from motion.source.import or an equivalent trusted source document." },
        outDir: { type: "string", description: "Trusted output directory for storyboard, package, preview, render, Cut import plan, and connector receipt artifacts." },
        maxFrames: { type: "number", description: "Maximum review-required storyboard frames to derive from the source." },
        frameDurationMs: { type: "number", description: "Duration for each generated storyboard frame." },
        width: { type: "number", description: "Storyboard and Motion package width." },
        height: { type: "number", description: "Storyboard and Motion package height." },
        fps: { type: "number", description: "Storyboard and Motion package frame rate." },
        cutImportMode: { type: "string", description: "Cut import mode, such as rendered_media or editable_lowering." },
        dryRunRender: { type: "boolean", description: "Plan required renders without encoding media." },
        createdAt: { type: "string", description: "Deterministic ISO timestamp for connector receipts and package provenance." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "connector.source_to_cut", mode: "emits", required: true, artifactRoles: ["source_markdown", "scripted_video", "source_storyboard_receipt", "motion_package", "preview_frame", "preview_receipt", "render_receipt", "cut_plan", "source_to_cut_receipt"] },
      { operation: "connector.source_to_cut", mode: "emits", required: false, artifactRoles: ["source_import_receipt", "rendered_media"] }
    ]
  },
  "motion.connector.cut_generate_to_cut": {
    argsSchema: {
      type: "object",
      required: ["outDir"],
      properties: {
        scriptPath: { type: "string", description: "Path to a Cut Generate scripted-video JSON document." },
        script: { type: "object", description: "Inline scripted-video document emitted by Cut Generate." },
        storyboard: { type: "object", description: "Alias for script when called from storyboard prompts." },
        outDir: { type: "string", description: "Trusted output directory for package, preview, render, Cut import plan, and connector receipt artifacts." },
        cutImportMode: { type: "string", description: "Cut import mode, such as rendered_media or editable_lowering." },
        dryRunRender: { type: "boolean", description: "Plan required renders without encoding media." },
        createdAt: { type: "string", description: "Deterministic ISO timestamp for connector receipts and package provenance." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "connector.cut_generate_to_cut", mode: "emits", required: true, artifactRoles: ["scripted_video", "motion_package", "preview_frame", "preview_receipt", "render_receipt", "cut_plan", "connector_receipt"] },
      { operation: "connector.cut_generate_to_cut", mode: "emits", required: false, artifactRoles: ["rendered_media"] }
    ]
  },
  "motion.connector.template_to_cut": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "values"],
      properties: {
        packageRoot: { type: "string", description: "Template Motion package root to apply before generating the Cut import plan." },
        outDir: { type: "string", description: "Trusted output directory for applied package, preview, render, Cut import plan, and connector receipt artifacts." },
        values: { type: "object", description: "Template param values keyed by param id." },
        cutImportMode: { type: "string", description: "Cut import mode, such as rendered_media or editable_lowering." },
        dryRunRender: { type: "boolean", description: "Plan required renders without encoding media." }
      },
      additionalProperties: false
    },
    expectedReceipts: [
      { operation: "connector.template_to_cut", mode: "emits", required: true, artifactRoles: ["template_source", "motion_package", "template_apply_receipt", "preview_frame", "preview_receipt", "render_receipt", "cut_plan", "connector_receipt"] },
      { operation: "connector.template_to_cut", mode: "emits", required: false, artifactRoles: ["rendered_media"] }
    ]
  },
  "motion.canvas.bridge_export": {
    argsSchema: {
      type: "object",
      required: ["canvasRoot", "outPath"],
      properties: {
        canvasRoot: { type: "string", description: "Trusted shellx-canvas checkout root containing app/server/motion-package.mjs." },
        outPath: { type: "string", description: "Frame-selection JSON path to write." },
        path: { type: "string", description: "Alias for outPath." },
        target: { type: "string", description: "Bridge export target label for Canvas provenance." },
        projectName: { type: "string", description: "Project name to request from the Canvas bridge." },
        frameName: { type: "string", description: "Frame name to request from the Canvas bridge." },
        selectedIds: { type: "array", description: "Optional selected Canvas node ids to export." },
        generatedAt: { type: "string", description: "Deterministic ISO timestamp for the bridge selection and receipt." },
        durationMs: { type: "number", minimum: 1, description: "Default duration for the generated frame selection." },
        fps: { type: "number", minimum: 1, description: "Default frame rate for the generated frame selection." }
      },
      additionalProperties: true
    },
    expectedReceipts: [
      { operation: "canvas.bridge_export", mode: "emits", required: true, artifactRoles: ["canvas_bridge", "canvas_frame_selection", "connector_receipt"] }
    ]
  }
} satisfies MotionDebugCommandMetadata;
