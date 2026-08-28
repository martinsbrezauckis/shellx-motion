/**
 * Declarative argument contracts for the surface, render-lifecycle, workspace, agent,
 * template, and Canvas-package commands that had no published argument schema.
 *
 * Role: close the discovery gap for the non-timeline half of the registry. Sources are
 * `domains/surface*.ts`, `domains/render*.ts`, `domains/workspace*.ts`, `domains/agent*.ts`,
 * `domains/authoring*.ts`, and `domains/integration.ts`.
 *
 * Dependencies: `command-metadata-shared.ts` fragments; enum values by `enumRef`.
 * Primary caller: `command-metadata.ts`.
 */
import { canvasFixtureContract } from "@shellx-motion/adapters-canvas";
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT, PACKAGE_ROOT, readReceipt, RECEIPTS_ROOT } from "./command-metadata-shared.js";

const LINUX_STABLE_RECEIPT_ROOT = "Trusted host receipt root. Identity-stable receipt reads and receipt-derived controls currently require Linux; macOS and Windows return capability_unavailable before reading or writing receipt state.";

/** Selection targets accepted by motion.select and motion.highlight; at least one is required. */
const SELECTION = {
  layerId: { type: "string" as const, aliases: ["layer"], description: "Layer to select. One selection target is required." },
  trackId: { type: "string" as const, aliases: ["track"], description: "Track to select." },
  markerId: { type: "string" as const, aliases: ["marker"], description: "Marker to select." },
  sceneId: { type: "string" as const, aliases: ["scene"], description: "Scene to select." },
  targetId: { type: "string" as const, aliases: ["id"], description: "Generic surface target to select." },
  durationMs: { type: "number" as const, minimum: 0, description: "How long the highlight stays visible, in milliseconds." },
  packageId: { type: "string" as const, description: "Optional package id recorded in the visible state." },
  motionId: { type: "string" as const, description: "Optional motion id recorded in the visible state." }
};

/** Job-control arguments shared by render cancel and retry. */
const JOB_CONTROL = {
  receiptsRoot: { type: "string" as const, description: LINUX_STABLE_RECEIPT_ROOT },
  receiptId: { type: "string" as const, aliases: ["id"], description: "Receipt id of the job to act on." },
  reason: { type: "string" as const, description: "Optional human-readable reason recorded in the control receipt." }
};

/** Pixel and audio thresholds accepted by motion.quality.check. */
const QUALITY_THRESHOLDS = {
  expectWidth: { type: "number" as const, description: "Required output width in pixels." },
  expectHeight: { type: "number" as const, description: "Required output height in pixels." },
  expectAudio: { type: "boolean" as const, default: false, description: "Fail when the media carries no audio stream." },
  maxAudioPeakDb: { type: "number" as const, description: "Maximum sample peak in dBFS." },
  minAudioLoudnessLufs: { type: "number" as const, description: "Minimum integrated loudness in LUFS." },
  maxAudioLoudnessLufs: { type: "number" as const, description: "Maximum integrated loudness in LUFS; must be at or above minAudioLoudnessLufs." },
  maxAudioTruePeakDbtp: { type: "number" as const, description: "Maximum true peak in dBTP." },
  maxAudioLoudnessRangeLu: { type: "number" as const, minimum: 0, description: "Maximum loudness range in LU." },
  minBrightPixels: { type: "number" as const, minimum: 0, description: "Minimum count of non-black pixels in the sampled frame." },
  minEdgePixels: { type: "number" as const, minimum: 0, description: "Minimum count of edge pixels in the sampled frame." },
  minTransparentPixels: { type: "number" as const, minimum: 0, description: "Minimum count of transparent pixels." },
  minNonTransparentPixels: { type: "number" as const, minimum: 0, description: "Minimum count of opaque pixels." },
  maxChangedPixels: { type: "number" as const, minimum: 0, description: "Maximum pixels allowed to differ from baselinePath." },
  maxMeanDiff: { type: "number" as const, minimum: 0, description: "Maximum mean per-pixel difference from baselinePath." },
  minPsnrDb: { type: "number" as const, description: "Minimum PSNR against baselinePath, in dB." },
  minSsim: { type: "number" as const, description: "Minimum SSIM against baselinePath, between 0 and 1." }
};

/**
 * The whole Canvas frame-selection contract, stated on the argument that carries it.
 *
 * Written out rather than summarized because this string is the only place an agent can read the
 * document shape before making a call: the tool surface publishes argument descriptions, and the
 * alternative was discovering the six required fields one rejected call at a time. The layer-kind
 * sentence is the correction for the mistake that motivated it — `kind: "rect"` used to package and
 * validate cleanly and then be refused by every render lane.
 *
 * The machine-readable form of the same contract (schema ids, required fields per level, the
 * card-derived layer kinds, and a minimal example) is `canvasFixtureContract()` from
 * `@shellx-motion/adapters-canvas`, and it is returned on every structural rejection.
 */
const CANVAS_SELECTION_DESCRIPTION = buildCanvasSelectionDescription();

function buildCanvasSelectionDescription(): string {
  const contract = canvasFixtureContract();
  const required = contract.requiredFields;
  return [
    "Inline Canvas frame-selection document, in place of canvasSelectionPath.",
    `Accepted schema ids: ${contract.schemas.join(", ")} (the canonical shellx-motion id additionally requires`,
    "integration and identity blocks).",
    `Required fields — fixture: ${required.fixture.join(", ")}; project: ${required.project.join(", ")};`,
    `brand: ${required.brand.join(", ")}; each frame: ${required.frame.join(", ")};`,
    `each layer: ${required.layer.join(", ")}.`,
    `Accepted layer kinds: ${contract.layerKinds.join(", ")}.`,
    contract.shapeNote,
    `Minimal working example: ${JSON.stringify(contract.example)}.`,
    "A rejected document returns every problem at once in result.problems, and this same contract in result.contract."
  ].join(" ");
}

export const SURFACE_COMMAND_METADATA = {
  "motion.state": {
    argsSchema: argsSchema([], {
      packageRoot: { type: "string", description: "Optional Motion package root to summarize." },
      receiptsRoot: { type: "string", description: `Optional ${LINUX_STABLE_RECEIPT_ROOT.toLowerCase()} Package-only state remains portable when it is omitted.` }
    }),
    expectedReceipts: readReceipt("state")
  },
  "motion.open": {
    argsSchema: argsSchema([], {
      panel: { type: "string", default: "preview", description: "Surface panel to focus, such as preview, timeline, assets, or receipts." }
    })
  },
  "motion.select": { argsSchema: argsSchema([], { ...SELECTION }) },
  "motion.highlight": { argsSchema: argsSchema([], { ...SELECTION }) },
  "motion.assets.panel": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("assets.panel")
  },
  "motion.brand.panel": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("brand.panel")
  },
  "motion.export.presets": { argsSchema: argsSchema([], {}) },
  "motion.export.panel": {
    argsSchema: argsSchema([], {
      receiptsRoot: { type: "string", description: `Optional ${LINUX_STABLE_RECEIPT_ROOT.toLowerCase()} Export presets remain portable when receipt coverage is omitted.` },
      requiredHosts: { type: "array", description: "Host ids that must be verified, as a string array." }
    }),
    expectedReceipts: readReceipt("export.panel")
  },
  "motion.preview.panel": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("preview.panel")
  },
  "motion.preview.playhead": {
    argsSchema: argsSchema(["packageRoot"], {
      ...PACKAGE_ROOT,
      outDir: { type: "string", description: "Directory for the rendered frame; a scratch directory when omitted." },
      outputPath: { type: "string", description: "Explicit output file path for the rendered frame." },
      receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
      createdAt: { type: "string", description: "Deterministic ISO timestamp for the emitted receipt." }
    }),
    expectedReceipts: [{ operation: "preview.playhead", mode: "emits", required: true, artifactRoles: ["preview_frame"] }]
  },
  "motion.preview.strip": {
    argsSchema: argsSchema(["packageRoot"], {
      ...PACKAGE_ROOT,
      outDir: { type: "string", description: "Directory for the rendered strip frames; a scratch directory when omitted." },
      receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
      frameCount: { type: "number", minimum: 1, aliases: ["frames"], description: "Number of frames to sample; must be a positive integer of 60 or less." },
      startMs: { type: "number", minimum: 0, description: "First sampled time in milliseconds; must be within the motion duration." },
      endMs: { type: "number", minimum: 0, description: "Last sampled time in milliseconds; must be at or after startMs and within the motion duration." },
      createdAt: { type: "string", description: "Deterministic ISO timestamp for the emitted receipt." }
    }),
    expectedReceipts: [{ operation: "preview.strip", mode: "emits", required: true, artifactRoles: ["preview_frame"] }]
  },
  "motion.render.status": {
    argsSchema: argsSchema([], { receiptsRoot: { type: "string", description: LINUX_STABLE_RECEIPT_ROOT } }),
    expectedReceipts: readReceipt("render.status")
  },
  "motion.render.cancel": {
    argsSchema: argsSchema(["receiptsRoot", "receiptId"], { ...JOB_CONTROL }),
    expectedReceipts: [{ operation: "render.cancel", mode: "emits", required: true, artifactRoles: ["render_control_receipt"] }]
  },
  "motion.render.retry": {
    argsSchema: argsSchema(["receiptsRoot", "receiptId"], { ...JOB_CONTROL }),
    expectedReceipts: [{ operation: "render.retry", mode: "emits", required: true, artifactRoles: ["render_control_receipt"] }]
  },
  "motion.quality.check": {
    argsSchema: argsSchema(["inputPath"], {
      inputPath: { type: "string", description: "Rendered media file to check." },
      manifestPath: { type: "string", aliases: ["qualityManifestPath"], description: "Optional quality manifest supplying the thresholds." },
      framePath: { type: "string", description: "Optional pre-extracted frame to analyse instead of sampling inputPath." },
      baselinePath: { type: "string", description: "Optional baseline image for the pixel-difference checks." },
      outDir: { type: "string", description: "Directory for extracted frames and diffs; a scratch directory when omitted." },
      receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
      packageId: { type: "string", default: "quality-check", description: "Package id recorded in the emitted receipt." },
      atMs: { type: "number", minimum: 0, default: 0, description: "Time to sample the frame from, in milliseconds." },
      ...QUALITY_THRESHOLDS
    }),
    expectedReceipts: [{ operation: "quality.check", mode: "emits", required: true, artifactRoles: ["quality_receipt"] }]
  },
  "motion.packages.browse": {
    argsSchema: argsSchema([], {
      root: { type: "string", description: "Directory to scan for Motion packages. One of root, packageRoot, or packageRoots is required." },
      packageRoot: { type: "string", description: "Single Motion package root to include." },
      packageRoots: { type: "array", description: "Motion package roots to include, as a string array." },
      packagesRoot: { type: "string", description: "Alternate name for root." },
      packageBrowserRoot: { type: "string", description: "Alternate name for root." }
    }),
    expectedReceipts: readReceipt("packages.browse")
  },
  "motion.receipts.list": {
    argsSchema: argsSchema(["receiptsRoot"], { ...RECEIPTS_ROOT, receiptsRoot: { type: "string", description: LINUX_STABLE_RECEIPT_ROOT } }),
    expectedReceipts: readReceipt("receipts.list")
  },
  "motion.receipts.panel": {
    argsSchema: argsSchema(["receiptsRoot"], {
      ...RECEIPTS_ROOT,
      receiptsRoot: { type: "string", description: LINUX_STABLE_RECEIPT_ROOT },
      limit: { type: "number", minimum: 0, description: "Maximum receipts to return; must be a non-negative integer." }
    }),
    expectedReceipts: readReceipt("receipts.panel")
  },
  "motion.receipts.read": {
    argsSchema: argsSchema([], {
      receiptsRoot: { type: "string", description: `${LINUX_STABLE_RECEIPT_ROOT} Required with receiptId, and required to bound receiptPath.` },
      receiptPath: { type: "string", aliases: ["path"], description: "Receipt file path; must resolve inside receiptsRoot." },
      receiptId: { type: "string", aliases: ["id"], description: "Receipt id to look up inside receiptsRoot." }
    }),
    expectedReceipts: readReceipt("receipts.read")
  },
  "motion.package.archive": {
    argsSchema: argsSchema(["packageRoot", "archivePath"], {
      ...PACKAGE_ROOT,
      archivePath: { type: "string", aliases: ["outPath", "out"], description: "Destination path for the portable .shellxmotion archive." },
      receiptPath: { type: "string", description: "Optional explicit path for the emitted archive receipt." }
    }),
    expectedReceipts: [{ operation: "package.archive", mode: "emits", required: true, artifactRoles: ["package_archive"] }]
  },
  "motion.package.patch": {
    argsSchema: argsSchema(["packageRoot", "outDir", "patch"], {
      ...PACKAGE_EDIT,
      patch: {
        type: "array",
        aliases: ["operations"],
        description: "JSON-Patch style operations applied to the Motion document, each { op, path, value? } with a leading-slash pointer path."
      }
    }),
    expectedReceipts: [{ operation: "package.patch", mode: "emits", required: true, artifactRoles: ["motion_package", "package_diff"] }]
  },
  "motion.package.asset.import": {
    argsSchema: argsSchema(["packageRoot", "outDir", "assetPath"], {
      ...PACKAGE_EDIT,
      assetPath: { type: "string", aliases: ["source", "inputPath"], description: "Host-approved external regular file to copy into the new package revision. The engine refuses sources over 64 MiB before allocating file bytes; request arguments cannot widen that ceiling." },
      assetRef: { type: "string", description: "Optional portable target under assets/. Defaults to assets/ plus the source filename; an existing file is never replaced." },
      createdBy: { type: "string", description: "Optional author identity recorded in the package-local import receipt." },
      createdAt: { type: "string", description: "Optional deterministic ISO timestamp for the package-local import receipt." }
    }),
    expectedReceipts: [{ operation: "package.asset.import", mode: "emits", required: true, artifactRoles: ["motion_package", "package_asset", "package_asset_import_receipt"] }]
  },
  "motion.actions.find": {
    argsSchema: argsSchema(["request"], { request: { type: "string", description: "Action id or natural-language request to match against the action catalog." } })
  },
  "motion.actions.guide": {
    argsSchema: argsSchema(["request"], { request: { type: "string", description: "Action id or natural-language request. The plan returns each step's call with its argument contract." } })
  },
  "motion.actions.plan": {
    argsSchema: argsSchema(["request"], { request: { type: "string", description: "Action id or natural-language request to plan a command sequence for." } })
  },
  "motion.actions.panel": { argsSchema: argsSchema([], {}) },
  "motion.agent.health": { argsSchema: argsSchema([], {}) },
  "motion.agent.snapshot": {
    argsSchema: argsSchema([], {
      packageRoot: { type: "string", maxLength: 4096, description: "Optional Motion package root. Caller paths must be inside host-approved snapshot package roots and contain no symlink traversal." },
      receiptsRoot: { type: "string", maxLength: 4096, description: "Optional receipt root. Caller paths must be inside a trusted host receipts root." },
      request: { type: "string", maxLength: 256, description: "Optional compact action find/guide/plan selector, at most 256 Unicode scalars. It is not echoed in the snapshot. Job facts are complete only when the host supplies an authenticated owner principal; otherwise jobs are empty and inexact with a warning." }
    })
  },
  "motion.agent.transcript": {
    argsSchema: argsSchema(["receiptsRoot"], {
      ...RECEIPTS_ROOT,
      receiptsRoot: { type: "string", description: LINUX_STABLE_RECEIPT_ROOT },
      receiptId: { type: "string", aliases: ["id"], description: "Prompt receipt id whose transcript should be read." },
      receiptPath: { type: "string", aliases: ["path"], description: "Prompt receipt path; must resolve inside receiptsRoot." },
      limit: { type: "number", minimum: 0, description: "Maximum transcript entries to return; must be a non-negative integer." }
    }),
    expectedReceipts: readReceipt("agent.transcript")
  },
  "motion.prompt.run": {
    argsSchema: argsSchema(["request"], {
      request: { type: "string", aliases: ["prompt"], description: "Natural-language instruction handed to the host-injected local agent runtime. The command returns capability_unavailable when the host has not injected one." },
      packageId: { type: "string", default: "unknown", description: "Package id recorded in the prompt receipt." },
      agentId: { type: "string", description: "Agent adapter to run; the default adapter when omitted." },
      cwd: { type: "string", description: "Working directory for the agent; must be inside a trusted prompt working root." },
      receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror for the prompt receipt." },
      executeAgentCommands: {
        type: "boolean",
        default: false,
        description: "Execute the debug commands the agent proposes. Without this the run only records proposals and changes nothing."
      },
      retainRawRequest: { type: "boolean", default: false, description: "Keep the raw prompt text in the receipt; requires rawRequestDeleteAfter, rawRequestPurpose, and Linux's stable receipt purge capability. Unsupported hosts refuse before writing a prompt receipt." },
      rawRequestDeleteAfter: { type: "string", description: "ISO timestamp after which Linux stable receipt reads redact the raw prompt and rewrite the stored receipt without it. Copies made before the deadline are not reached." },
      rawRequestPurpose: { type: "string", enum: ["user_requested_replay", "debugging"], description: "Declared purpose for retaining the raw prompt." }
    }),
    expectedReceipts: [{ operation: "prompt.run", mode: "emits", required: true, artifactRoles: ["prompt_receipt"] }]
  },
  "motion.script.compile": {
    argsSchema: argsSchema(["packageDir"], {
      scriptPath: { type: "string", description: "Scripted-video JSON path. Required unless script is given inline." },
      script: { type: "object", description: "Inline scripted-video document, in place of scriptPath." },
      packageDir: { type: "string", description: "Linux-only empty or absent host-approved output directory. Motion commits the complete compiled package and its final receipt once through descriptor-relative exact closed-tree publication; macOS and Windows refuse before creating output state." },
      receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror. It runs only after the complete package commits; a mirror failure is returned as a warning." },
      createdAt: { type: "string", description: "Deterministic ISO timestamp for the emitted receipt." }
    }),
    expectedReceipts: [{ operation: "script.compile", mode: "emits", required: true, artifactRoles: ["motion_package"] }]
  },
  "motion.package.script.author": {
    argsSchema: argsSchema(["packageRoot", "outDir", "html", "layer"], {
      packageRoot: { type: "string", description: "Data-only source Motion package inside a host-approved authoring input root. It is never modified in place." },
      outDir: { type: "string", description: "Empty or absent output directory inside a host-approved authoring output root, outside packageRoot." },
      html: { type: "string", maxLength: 262144, description: "Inline local HTML entry bytes. Only classic inline scripts are admitted; dynamic code construction, src/module/inert scripts, workers, frames, event handlers, javascript: URLs, and secondary composition are refused before authority minting. Motion injects a hash-based CSP that blocks eval and unlisted executable code." },
      layer: {
        type: "object",
        required: ["id", "type", "startMs", "durationMs"],
        properties: {
          id: { type: "string", maxLength: 128, description: "Safe local layer id; it also determines scripts/agent/<id>.html." },
          type: { type: "string", enum: ["web", "html", "canvas"], description: "Active browser layer kind." },
          startMs: { type: "number", minimum: 0, description: "Layer start time in milliseconds." },
          durationMs: { type: "number", exclusiveMinimum: 0, description: "Positive layer duration in milliseconds." },
          name: { type: "string", maxLength: 256, description: "Optional display name." },
          opacity: { type: "number", description: "Optional layer opacity." },
          visible: { type: "boolean", description: "Optional layer visibility." }
        },
        additionalProperties: false,
        description: "The command owns source and allowedOrigins: callers cannot provide paths, URLs, external origins, or package claims."
      }
    }),
    expectedReceipts: [{ operation: "package.script.author", mode: "emits", required: true }]
  },
  "motion.template.panel": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("template.panel")
  },
  "motion.template.controls": {
    argsSchema: argsSchema(["packageRoot"], { ...PACKAGE_ROOT }),
    expectedReceipts: readReceipt("template.controls")
  },
  "motion.template.media.replace": {
    argsSchema: argsSchema(["packageRoot", "outDir", "paramId", "assetPath"], {
      ...PACKAGE_EDIT,
      paramId: { type: "string", description: "Template media parameter to rebind." },
      assetPath: { type: "string", description: "Host-approved regular file inside a configured authoring input root; copied with retained identity and a 64 MiB ceiling." },
      assetRef: { type: "string", description: "Package-relative asset reference to write; assets/<basename> when omitted." }
    }),
    expectedReceipts: editReceipt("template.media.replace")
  },
  "motion.canvas.package": {
    argsSchema: argsSchema(["packageDir"], {
      canvasSelectionPath: { type: "string", description: "Canvas frame-selection JSON path. Required unless selection is given inline." },
      selection: { type: "object", aliases: ["canvasSelection"], description: CANVAS_SELECTION_DESCRIPTION },
      packageDir: { type: "string", aliases: ["outDir"], description: "Linux-only empty or absent output directory for the generated Motion package. Exact closed-tree publication is unavailable on macOS and Windows, which refuse before creating output state." },
      selectedFrameId: { type: "string", description: "Frame to package when the selection carries several." },
      sourceRoot: { type: "string", description: "Host-approved root used to resolve declared assets. Required for inline selections that declare assets; file-backed selections derive their selection parent when omitted." },
      receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
      createdAt: { type: "string", description: "Deterministic ISO timestamp for the emitted receipt." },
      createdBy: { type: "string", description: "Optional attribution recorded in the emitted receipt." }
    }),
    expectedReceipts: [{ operation: "export.final", mode: "emits", required: true, artifactRoles: ["motion_package", "canvas_frame_selection"] }]
  }
} satisfies MotionDebugCommandMetadata;
