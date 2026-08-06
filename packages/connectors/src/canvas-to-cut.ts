import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { convertCanvasFrameToMotionPackage, writeCanvasMotionPackage } from "@shellx-motion/adapters-canvas";
import { attachRenderedMediaToCutPlan, planCutImport } from "@shellx-motion/adapters-cut";
import {
  hashBuffer,
  loadMotionPackage,
  type MotionPackage,
  type OperationReceipt,
  assertOutputDirGuard,
  prepareFramesDir
} from "@shellx-motion/core";
import {
  buildEncodeImageSequenceCommand,
  encodeImageSequenceWithPolicy,
  readFfmpegExportPreset,
  resolveExportPreset,
  type FfmpegCommand,
  type FfmpegExportPreset,
  type FfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { renderNativePreviewFrame } from "@shellx-motion/renderer-native";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { connectorArtifactOperationHash, connectorArtifactStagingPath, finalizeConnectorArtifactHandle, publishConnectorArtifact } from "./artifact-handle";
import { cutTargetCapabilitiesForMode, type CutImportModeRequest } from "./cut-import-mode";
import { assertConnectorOutputOwnership } from "./output-ownership";
import { packageAudioEncodeInput } from "./package-audio";

export interface CanvasToCutConnectorInput {
  canvasSelectionPath: string;
  outDir: string;
  /**
   * Overwrite the directories this connector owns under a non-empty `--out`. Off by default:
   * `outDir` is caller-supplied, so a `package/` there is NOT evidence that Motion created it.
   */
  force?: boolean;
  previewLane?: "native";
  renderLane?: "ffmpeg";
  preset?: string;
  dryRunRender?: boolean;
  cutImportMode?: CutImportModeRequest;
  ffmpegRunner?: FfmpegRunner;
  now?: () => string;
}

export interface CanvasToCutConnectorResult {
  ok: boolean;
  status: OperationReceipt["status"];
  packageDir: string;
  preview: { ok: boolean; lane: "native"; failureFatal: boolean; receiptPath: string; outputPath: string | null };
  render: {
    ok: boolean;
    required: boolean;
    dryRun: boolean;
    lane: "ffmpeg";
    frameLane?: "native" | "browser";
    preset: FfmpegExportPreset;
    receiptPath: string;
    outputPath?: string;
  };
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  receiptPath: string;
  warnings: string[];
}

export async function runCanvasToCutConnector(input: CanvasToCutConnectorInput): Promise<CanvasToCutConnectorResult> {
  const previewLane = input.previewLane ?? "native";
  const renderLane = input.renderLane ?? "ffmpeg";
  const preset = normalizeCanvasToCutPreset(input.preset);
  const dryRunRender = input.dryRunRender ?? true;
  const createdAt = input.now?.() ?? new Date().toISOString();
  if (previewLane !== "native") {
    throw new Error(`Unsupported connector preview lane: ${previewLane}`);
  }
  if (renderLane !== "ffmpeg") {
    throw new Error(`Unsupported connector render lane: ${renderLane}`);
  }
  const outDir = resolve(input.outDir);
  const packageDir = join(outDir, "package");
  const receiptDir = join(outDir, "receipts");
  const previewPath = join(outDir, "preview", "native-0.png");
  const previewReceiptPath = join(receiptDir, "native-preview.receipt.json");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
  const cutPlanPath = join(outDir, "cut-import-plan.json");
  const connectorReceiptPath = join(outDir, "connector-run.receipt.json");
  const canvasSelectionPath = resolve(input.canvasSelectionPath);
  const canvasSelectionBytes = await readFile(canvasSelectionPath);
  const canvasSelection: unknown = JSON.parse(canvasSelectionBytes.toString("utf8"));

  // the output-ownership invariant: no guard ran here, so a caller's `<out>/package` was overwritten with ok:true.
  await assertConnectorOutputOwnership({
    packageDir,
    ownedDirs: [receiptDir, join(outDir, "preview"), join(outDir, "render"), join(outDir, "artifacts")],
    ownedFiles: [cutPlanPath, connectorReceiptPath],
    force: input.force === true
  });
  await mkdir(receiptDir, { recursive: true });
  await mkdir(join(outDir, "preview"), { recursive: true });

  const canvasExport = convertCanvasFrameToMotionPackage(canvasSelection, {
    createdAt,
    inputPath: canvasSelectionPath
  });
  const writtenPackage = await writeCanvasMotionPackage(canvasExport, {
    packageDir,
    sourceRoot: dirname(canvasSelectionPath)
  });

  const preview = await renderNativePreviewFrame({
    packageRoot: packageDir,
    outputPath: previewPath,
    outputRoots: [outDir],
    atMs: 0,
    now: () => createdAt
  });
  await writeJson(previewReceiptPath, preview.receipt);

  const pkg = await loadMotionPackage(packageDir);
  const renderOutputPath = join(outDir, "render", `${pkg.manifest.id}.${extensionForPreset(preset)}`);
  const framesDir = join(outDir, "frames", pkg.manifest.id);
  const requestedCutImportMode = input.cutImportMode ?? "auto";
  const cutImportMode = requestedCutImportMode === "auto" && writtenPackage.missingAssetRefs.length > 0
    ? "rendered_media"
    : requestedCutImportMode;
  const plannedCutImport = planCutImport(pkg, cutTargetCapabilitiesForMode({
    targetId: "shellx-cut",
    mode: cutImportMode
  }));
  const renderRequired = plannedCutImport.mode === "rendered_media";
  const operationHash = connectorArtifactOperationHash({ packageId: pkg.manifest.id, motionId: pkg.motion.id, preset, plan: plannedCutImport });
  const renderResult = !renderRequired
    ? {
        required: false,
        frameLane: undefined,
        receipt: createRenderNotRequiredReceipt({
          packageId: pkg.manifest.id,
          motionHash: hashBuffer(Buffer.from(JSON.stringify(pkg.motion), "utf8")),
          createdAt,
          mode: plannedCutImport.mode
        })
      }
    : dryRunRender
    ? {
        required: true,
        frameLane: undefined,
        receipt: createDryRunRenderReceipt({
          packageId: pkg.manifest.id,
          motionHash: hashBuffer(Buffer.from(JSON.stringify(pkg.motion), "utf8")),
          createdAt,
          framesDir,
          fps: pkg.motion.fps,
          durationMs: pkg.motion.durationMs,
          preset,
          outputPath: renderOutputPath
        })
      }
    : await renderRealFfmpegArtifact({
        pkg,
        packageDir,
        packageId: pkg.manifest.id,
        durationMs: pkg.motion.durationMs,
        fps: pkg.motion.fps,
        width: pkg.motion.width,
        height: pkg.motion.height,
        framesDir,
        outputPath: renderOutputPath,
        preset,
        createdAt,
        // the explicit-force invariant: declared and never set, so `--force` could not reach the frames guard it names.
        force: input.force === true,
        runner: input.ffmpegRunner
      });
  const renderReceipt = renderResult.receipt;
  renderReceipt.inputHashes = { ...renderReceipt.inputHashes, operation: operationHash };
  const renderOk = renderReceipt.status !== "failed";
  await writeJson(renderReceiptPath, renderReceipt);

  let cutPlan = renderRequired && dryRunRender
    ? attachRenderedMediaToCutPlan(plannedCutImport, {
      plannedPath: renderOutputPath,
      receiptPath: renderReceiptPath,
      dryRun: true
    })
    : plannedCutImport;

  const warnings = [
    ...preview.warnings,
    ...writtenPackage.missingAssetRefs.map((assetRef) => `Canvas asset was not copied into package: ${assetRef}`),
    ...renderReceipt.warnings,
    ...cutPlan.receipt.warnings
  ];
  const previewFailureFatal = renderRequired && dryRunRender && !preview.ok;
  const artifacts = canvasToCutArtifacts({
    canvasSelectionPath,
    packageDir,
    previewPath,
    previewOk: preview.ok,
    previewReceiptPath,
    renderRequired,
    renderDryRun: dryRunRender,
    renderOk,
    renderOutputPath,
    preset,
    renderReceiptPath,
    cutPlanPath,
    connectorReceiptPath,
    artifactHandlePath: renderRequired && !dryRunRender && renderOk ? artifactHandlePath : undefined
  });
  const connectorReceipt = createConnectorReceipt({
    packageId: pkg.manifest.id,
    createdAt,
    inputHash: hashBuffer(canvasSelectionBytes),
    packageDir,
    previewOk: preview.ok,
    previewFailureFatal,
    previewReceiptPath,
    renderOk,
    renderReceiptPath,
    renderRequired,
    renderDryRun: dryRunRender,
    renderFrameLane: renderResult.frameLane,
    renderPreset: preset,
    renderOutputPath: renderRequired ? renderOutputPath : undefined,
    cutOk: cutPlan.ok,
    cutMode: cutPlan.mode,
    cutPlanPath,
    artifacts,
    warnings,
    operationHash
  });
  await writeJson(connectorReceiptPath, connectorReceipt);

  if (renderRequired && !dryRunRender && renderOk) {
    const finalized = await finalizeConnectorArtifactHandle({
      root: outDir,
      descriptorPath: artifactHandlePath,
      artifactPath: renderOutputPath,
      renderReceiptPath,
      connectorReceiptPath,
      pkg,
      operationHash,
      preset,
      mediaType: mediaTypeForPreset(preset),
      createdAt
    });
    cutPlan = attachRenderedMediaToCutPlan(plannedCutImport, { dryRun: false, handle: finalized.reference });
  }
  await writeJson(cutPlanPath, cutPlan);

  return {
    ok: !previewFailureFatal && cutPlan.ok && renderOk,
    status: connectorReceipt.status,
    packageDir,
    preview: {
      ok: preview.ok,
      lane: "native",
      failureFatal: previewFailureFatal,
      receiptPath: previewReceiptPath,
      outputPath: preview.ok ? preview.frame.path : null
    },
    render: {
      ok: renderOk,
      required: renderRequired,
      dryRun: renderRequired ? dryRunRender : true,
      lane: "ffmpeg",
      frameLane: renderResult.frameLane,
      preset,
      receiptPath: renderReceiptPath,
      ...(renderRequired ? { outputPath: renderOutputPath } : {})
    },
    cutPlanPath,
    artifacts,
    receiptPath: connectorReceiptPath,
    warnings
  };
}

function canvasToCutArtifacts(input: {
  canvasSelectionPath: string;
  packageDir: string;
  previewPath: string;
  previewOk: boolean;
  previewReceiptPath: string;
  renderRequired: boolean;
  renderDryRun: boolean;
  renderOk: boolean;
  renderOutputPath: string;
  preset: FfmpegExportPreset;
  renderReceiptPath: string;
  cutPlanPath: string;
  connectorReceiptPath: string;
  artifactHandlePath?: string;
}): ConnectorArtifact[] {
  const artifacts: ConnectorArtifact[] = [
    { role: "canvas_selection", path: input.canvasSelectionPath, status: "available" },
    { role: "motion_package", path: input.packageDir, status: "available" },
    { role: "preview_frame", path: input.previewPath, status: input.previewOk ? "available" : "planned", mediaType: "image/png" },
    { role: "preview_receipt", path: input.previewReceiptPath, status: "available" },
    { role: "render_receipt", path: input.renderReceiptPath, status: "available" },
    { role: "cut_plan", path: input.cutPlanPath, status: "available", primary: !input.renderRequired },
    { role: "connector_receipt", path: input.connectorReceiptPath, status: "available" }
  ];
  if (input.renderRequired) {
    artifacts.splice(4, 0, {
      role: "rendered_media",
      path: input.renderOutputPath,
      status: !input.renderOk ? "failed" : input.renderDryRun ? "planned" : "available",
      mediaType: mediaTypeForPreset(input.preset),
      primary: true
    });
  }
  if (input.artifactHandlePath) {
    artifacts.push({ role: "artifact_handle", path: input.artifactHandlePath, status: "available", mediaType: "application/vnd.shellx-motion.artifact-handle+json" });
  }
  return artifacts;
}

function createDryRunRenderReceipt(input: {
  packageId: string;
  motionHash: string;
  createdAt: string;
  framesDir: string;
  fps: number;
  durationMs: number;
  preset: FfmpegExportPreset;
  outputPath: string;
}): OperationReceipt {
  const command = buildEncodeImageSequenceCommand({
    framesDir: input.framesDir,
    fps: input.fps,
    durationMs: input.durationMs,
    outputPath: input.outputPath,
    preset: input.preset,
    inputRoots: [input.framesDir],
    outputRoots: [dirname(input.outputPath)]
  });
  return {
    schema: "shellx-motion/receipt@1",
    id: `render-dry-run-${hashBuffer(Buffer.from(`${input.packageId}:${input.outputPath}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "not_run",
    packageId: input.packageId,
    inputHashes: { motion: input.motionHash },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      dryRun: true,
      preset: input.preset,
      command
    },
    warnings: []
  };
}

function createRenderNotRequiredReceipt(input: {
  packageId: string;
  motionHash: string;
  createdAt: string;
  mode: string | null;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `render-not-required-${hashBuffer(Buffer.from(`${input.packageId}:${input.mode ?? "none"}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "not_run",
    packageId: input.packageId,
    inputHashes: { motion: input.motionHash },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      required: false,
      reason: input.mode
        ? `Cut import mode ${input.mode} does not require rendered media.`
        : "Cut import planning found no applicable mode; rendered media was not run for the failed explicit handoff."
    },
    warnings: []
  };
}

async function renderRealFfmpegArtifact(input: {
  pkg: MotionPackage;
  packageDir: string;
  packageId: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  framesDir: string;
  /** Overwrite a frames directory holding files Motion did not write. */
  force?: boolean;
  outputPath: string;
  preset: FfmpegExportPreset;
  createdAt: string;
  runner?: FfmpegRunner;
}): Promise<{ receipt: OperationReceipt; frameLane: "native" | "browser" }> {
  // Wiping a frames directory is correct — a stale frame from a longer previous render would be
  // encoded into this one — but this one lives under a caller-supplied `--out`, so ownership is
  // proven from the CONTENT (only Motion's own PNG frames), never from the path's name.
  assertOutputDirGuard(await prepareFramesDir(input.framesDir, { force: input.force === true, callerSupplied: true }));
  await mkdir(input.framesDir, { recursive: true });
  await mkdir(dirname(input.outputPath), { recursive: true });
  const frameCount = frameCountFor(input.durationMs, input.fps);
  const frameLane = "browser";
  for (let index = 0; index < frameCount; index += 1) {
    const outputPath = join(input.framesDir, frameFileName(index));
    const atMs = frameTimestampMs(index, input.fps, input.durationMs);
    await renderMotionBrowserFrame(input.pkg, {
      outDir: input.framesDir,
      outputPath,
      atMs,
      now: () => input.createdAt
    });
  }

  const stagingOutputPath = connectorArtifactStagingPath(input.outputPath);
  // Final encode through the shared encode policy: hardware GPU encoding by default with a cached
  // per-host probe, honoring SHELLX_MOTION_FORCE_SOFTWARE_ENCODE; the same host selects the same encoder
  // as the CLI and debug-api render paths.
  const encoded = await encodeImageSequenceWithPolicy({
    packageId: input.packageId,
    framesDir: input.framesDir,
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    outputPath: stagingOutputPath,
    preset: input.preset,
    ...packageAudioEncodeInput(input.pkg),
    inputRoots: [input.framesDir, input.pkg.root],
    outputRoots: [dirname(input.outputPath)],
    quality: { minUniqueFrameHashes: 2 },
    runner: input.runner,
    now: () => input.createdAt
  });
  if (!encoded.ok) {
    await rm(stagingOutputPath, { force: true });
    return {
      receipt: createFailedRenderReceipt({
        packageId: input.packageId,
        motionHash: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")),
        createdAt: input.createdAt,
        outputPath: input.outputPath,
        frameLane,
        preset: input.preset,
        command: encoded.command,
        error: encoded.error
      }),
      frameLane
    };
  }
  await publishConnectorArtifact(stagingOutputPath, input.outputPath);
  encoded.receipt.output = {
    ...(readRecord(encoded.receipt.output) ?? {}),
    path: input.outputPath,
    frameLane
  };
  encoded.receipt.artifacts = encoded.receipt.artifacts?.map((artifact) => artifact.role === "rendered_media"
    ? { ...artifact, path: input.outputPath }
    : artifact);
  return { receipt: encoded.receipt, frameLane };
}

function createFailedRenderReceipt(input: {
  packageId: string;
  motionHash: string;
  createdAt: string;
  outputPath: string;
  frameLane: "native" | "browser";
  preset: FfmpegExportPreset;
  command: FfmpegCommand;
  error: { code: string; message: string };
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `ffmpeg-render-failed-${hashBuffer(Buffer.from(`${input.packageId}:${input.outputPath}:${input.error.code}:${input.error.message}`)).slice(0, 16)}`,
    operation: "render.final",
    status: "failed",
    packageId: input.packageId,
    inputHashes: { motion: input.motionHash },
    createdAt: input.createdAt,
    lane: "ffmpeg",
    output: {
      path: input.outputPath,
      frameLane: input.frameLane,
      preset: input.preset,
      command: input.command,
      error: input.error
    },
    warnings: [input.error.message]
  };
}

function createConnectorReceipt(input: {
  packageId: string;
  createdAt: string;
  inputHash: string;
  packageDir: string;
  previewOk: boolean;
  previewFailureFatal: boolean;
  previewReceiptPath: string;
  renderOk: boolean;
  renderReceiptPath: string;
  renderRequired: boolean;
  renderDryRun: boolean;
  renderFrameLane?: "native" | "browser";
  renderPreset: FfmpegExportPreset;
  renderOutputPath?: string;
  cutOk: boolean;
  cutMode: string | null;
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  warnings: string[];
  operationHash: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `connector-canvas-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.canvas_to_cut",
    status: connectorReceiptStatus({ failed: input.previewFailureFatal || !input.cutOk || !input.renderOk, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: { canvasSelection: input.inputHash, operation: input.operationHash },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      packageDir: input.packageDir,
      artifacts: input.artifacts,
      preview: { ok: input.previewOk, lane: "native", failureFatal: input.previewFailureFatal, receiptPath: input.previewReceiptPath },
      render: {
        ok: input.renderOk,
        required: input.renderRequired,
        dryRun: input.renderRequired ? input.renderDryRun : true,
        lane: "ffmpeg",
        frameLane: input.renderFrameLane,
        preset: input.renderPreset,
        receiptPath: input.renderReceiptPath,
        ...(input.renderOutputPath ? { outputPath: input.renderOutputPath } : {})
      },
      cut: { ok: input.cutOk, mode: input.cutMode, planPath: input.cutPlanPath }
    },
    warnings: input.warnings
  };
}

function normalizeCanvasToCutPreset(value: string | undefined): FfmpegExportPreset {
  if (!value) return "mp4-h264";
  const preset = readFfmpegExportPreset(value);
  if (preset) return preset;
  throw new Error(`Unsupported export preset: ${value}.`);
}

function extensionForPreset(preset: FfmpegExportPreset): string {
  return resolveExportPreset(preset).container;
}

function mediaTypeForPreset(preset: FfmpegExportPreset): string {
  const container = resolveExportPreset(preset).container;
  if (container === "gif") return "image/gif";
  if (container === "mov") return "video/quicktime";
  return `video/${container}`;
}

function frameCountFor(durationMs: number, fps: number): number {
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

function frameTimestampMs(index: number, fps: number, durationMs: number): number {
  return Math.min(durationMs - 1, Math.round((index / fps) * 1000));
}

function frameFileName(index: number): string {
  return `${String(index + 1).padStart(6, "0")}.png`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
