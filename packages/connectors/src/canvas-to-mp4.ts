import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { convertCanvasFrameToMotionPackage, writeCanvasMotionPackage } from "@shellx-motion/adapters-canvas";
import { attachRenderedMediaToCutPlan, planCutImport } from "@shellx-motion/adapters-cut";
import {
  assertOutputDirGuard,
  hashBuffer,
  loadMotionPackage,
  prepareFramesDir,
  type AttestedArtifactHandleReference,
  type MotionPackage,
  type OperationReceipt,
  type ShellXIntegrationNegotiation
} from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import {
  buildEncodeImageSequenceCommand,
  encodeImageSequenceWithPolicy,
  readFfmpegExportPreset,
  resolveExportPreset,
  type FfmpegExportPreset,
  type FfmpegCommand,
  type FfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { connectorArtifactOperationHash, connectorArtifactStagingPath, finalizeConnectorArtifactHandle, publishConnectorArtifact } from "./artifact-handle";
import { packageAudioEncodeInput } from "./package-audio";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode";
import { assertConnectorOutputOwnership } from "./output-ownership";

export type CanvasMp4ExportPreset = FfmpegExportPreset;

export interface CanvasMp4ExportInput {
  canvasSelectionPath: string;
  outDir: string;
  /**
   * Overwrite the directories this export owns under a non-empty `--out`. Off by default:
   * `outDir` is caller-supplied, so a `package/` or `frames/` there is not Motion's to delete.
   */
  force?: boolean;
  preset?: string;
  dryRunRender?: boolean;
  ffmpegRunner?: FfmpegRunner;
  now?: () => string;
}

export interface CanvasMp4ExportResult {
  ok: boolean;
  packageDir: string;
  resourceCatalogPath: string;
  render: {
    ok: boolean;
    dryRun: boolean;
    lane: "ffmpeg";
    frameLane?: "browser";
    preset: CanvasMp4ExportPreset;
    receiptPath: string;
    outputPath: string;
  };
  artifacts: ConnectorArtifact[];
  artifactHandle?: {
    path: string;
    reference: AttestedArtifactHandleReference;
  };
  receiptPath: string;
  cutPlanPath?: string;
  warnings: string[];
  integration: ShellXIntegrationNegotiation | {
    schema: "shellx-motion/integration-compatibility-adapter@1";
    ok: true;
    adapter: "shellx-canvas/frame-selection@1";
    payloadSchema: "shellx-canvas/frame-selection@1";
  };
}

export async function runCanvasMp4Export(input: CanvasMp4ExportInput): Promise<CanvasMp4ExportResult> {
  const dryRunRender = input.dryRunRender ?? true;
  const preset = normalizeCanvasMp4Preset(input.preset);
  const createdAt = input.now?.() ?? new Date().toISOString();
  const outDir = resolve(input.outDir);
  const packageDir = join(outDir, "package");
  const receiptDir = join(outDir, "receipts");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
  const exportReceiptPath = join(outDir, "canvas-mp4-export.receipt.json");
  const cutPlanPath = join(outDir, "cut-import-plan.json");
  const canvasSelectionPath = resolve(input.canvasSelectionPath);
  const canvasSelectionBytes = await readFile(canvasSelectionPath);
  const canvasSelection: unknown = JSON.parse(canvasSelectionBytes.toString("utf8"));

  // Negotiate the untrusted connector envelope before creating output state.
  // Unsupported peers therefore fail without partial package/receipt folders.
  const canvasExport = convertCanvasFrameToMotionPackage(canvasSelection, {
    createdAt,
    inputPath: canvasSelectionPath
  });
  // the output-ownership invariant: no guard ran here, so a caller's `<out>/package` was overwritten with ok:true.
  await assertConnectorOutputOwnership({
    packageDir,
    ownedDirs: [receiptDir, join(outDir, "render"), join(outDir, "artifacts")],
    ownedFiles: [cutPlanPath, exportReceiptPath],
    force: input.force === true
  });
  await mkdir(receiptDir, { recursive: true });
  const writtenPackage = await writeCanvasMotionPackage(canvasExport, {
    packageDir,
    sourceRoot: dirname(canvasSelectionPath)
  });

  const pkg = await loadMotionPackage(packageDir);
  const renderOutputPath = join(outDir, "render", `${pkg.manifest.id}.${extensionForPreset(preset)}`);
  const framesDir = join(outDir, "frames", pkg.manifest.id);
  const operationHash = connectorArtifactOperationHash({
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    preset,
    plan: { operation: "connector.canvas_to_mp4", canvasSelection: hashBuffer(canvasSelectionBytes) }
  });
  const renderResult = dryRunRender
    ? {
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
        packageId: pkg.manifest.id,
        durationMs: pkg.motion.durationMs,
        fps: pkg.motion.fps,
        width: pkg.motion.width,
        height: pkg.motion.height,
        framesDir,
        outputPath: renderOutputPath,
        preset,
        createdAt,
        force: input.force === true,
        runner: input.ffmpegRunner
      });

  renderResult.receipt.inputHashes = { ...renderResult.receipt.inputHashes, operation: operationHash };
  await writeJson(renderReceiptPath, renderResult.receipt);
  const renderOk = renderResult.receipt.status !== "failed";
  const warnings = [
    ...writtenPackage.missingAssetRefs.map((assetRef) => `Canvas asset was not copied into package: ${assetRef}`),
    ...renderResult.receipt.warnings
  ];
  const artifacts = canvasMp4Artifacts({
    packageDir,
    resourceCatalogPath: writtenPackage.resourceCatalogPath,
    renderReceiptPath,
    renderOutputPath,
    preset,
    connectorReceiptPath: exportReceiptPath,
    renderDryRun: dryRunRender,
    renderOk,
    artifactHandlePath: !dryRunRender && renderOk ? artifactHandlePath : undefined,
    cutPlanPath: !dryRunRender && renderOk ? cutPlanPath : undefined
  });
  const exportReceipt = createCanvasMp4ExportReceipt({
    packageId: pkg.manifest.id,
    createdAt,
    inputHash: hashBuffer(canvasSelectionBytes),
    packageDir,
    resourceCatalogPath: writtenPackage.resourceCatalogPath,
    renderDryRun: dryRunRender,
    renderOk,
    renderPreset: preset,
    renderFrameLane: renderResult.frameLane,
    renderReceiptPath,
    renderOutputPath,
    artifacts,
    warnings,
    operationHash
  });
  await writeJson(exportReceiptPath, exportReceipt);
  const artifactHandle = !dryRunRender && renderOk
    ? await finalizeConnectorArtifactHandle({
      root: outDir,
      descriptorPath: artifactHandlePath,
      artifactPath: renderOutputPath,
      renderReceiptPath,
      connectorReceiptPath: exportReceiptPath,
      pkg,
      operationHash,
      preset,
      mediaType: mediaTypeForPreset(preset),
      createdAt
    })
    : undefined;
  if (artifactHandle) {
    const cutPlan = attachRenderedMediaToCutPlan(
      planCutImport(pkg, cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: "rendered_media" })),
      { dryRun: false, handle: artifactHandle.reference }
    );
    await writeJson(cutPlanPath, cutPlan);
  }

  return {
    ok: renderOk,
    packageDir,
    resourceCatalogPath: writtenPackage.resourceCatalogPath,
    render: {
      ok: renderOk,
      dryRun: dryRunRender,
      lane: "ffmpeg",
      frameLane: renderResult.frameLane,
      preset,
      receiptPath: renderReceiptPath,
      outputPath: renderOutputPath
    },
    artifacts,
    ...(artifactHandle ? {
      artifactHandle: {
        path: artifactHandle.path,
        reference: artifactHandle.reference
      }
    } : {}),
    receiptPath: exportReceiptPath,
    ...(artifactHandle ? { cutPlanPath } : {}),
    warnings,
    integration: canvasExport.integration
  };
}

function canvasMp4Artifacts(input: {
  packageDir: string;
  resourceCatalogPath: string;
  renderReceiptPath: string;
  renderOutputPath: string;
  preset: CanvasMp4ExportPreset;
  connectorReceiptPath: string;
  renderDryRun: boolean;
  renderOk: boolean;
  artifactHandlePath?: string;
  cutPlanPath?: string;
}): ConnectorArtifact[] {
  const artifacts: ConnectorArtifact[] = [
    { role: "motion_package", path: input.packageDir, status: "available" },
    { role: "resource_catalog", path: input.resourceCatalogPath, status: "available" },
    { role: "rendered_media", path: input.renderOutputPath, status: !input.renderOk ? "failed" : input.renderDryRun ? "planned" : "available", mediaType: mediaTypeForPreset(input.preset), primary: true },
    { role: "render_receipt", path: input.renderReceiptPath, status: "available" },
    { role: "connector_receipt", path: input.connectorReceiptPath, status: "available" }
  ];
  if (input.artifactHandlePath) {
    artifacts.push({ role: "artifact_handle", path: input.artifactHandlePath, status: "available", mediaType: "application/vnd.shellx-motion.artifact-handle+json" });
  }
  if (input.cutPlanPath) {
    artifacts.push({ role: "cut_import_plan", path: input.cutPlanPath, status: "planned", mediaType: "application/vnd.shellx-motion.cut-import-plan+json" });
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
  preset: CanvasMp4ExportPreset;
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

async function renderRealFfmpegArtifact(input: {
  pkg: MotionPackage;
  packageId: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  framesDir: string;
  /** Overwrite a frames directory holding files Motion did not write. */
  force?: boolean;
  outputPath: string;
  preset: CanvasMp4ExportPreset;
  createdAt: string;
  runner?: FfmpegRunner;
}): Promise<{ receipt: OperationReceipt; frameLane: "browser" }> {
  // the directory ownership invariant: this was a bare `rm(framesDir, { recursive: true, force: true })` while all three sibling
  // connectors called the guard — `<out>/frames/<packageId>` sits under a caller-supplied `--out`,
  // and a caller's files there were destroyed by a run that reported ok:true.
  assertOutputDirGuard(await prepareFramesDir(input.framesDir, { force: input.force === true, callerSupplied: true }));
  await mkdir(input.framesDir, { recursive: true });
  await mkdir(dirname(input.outputPath), { recursive: true });
  const frameCount = frameCountFor(input.durationMs, input.fps);
  for (let index = 0; index < frameCount; index += 1) {
    await renderMotionBrowserFrame(input.pkg, {
      outDir: input.framesDir,
      outputPath: join(input.framesDir, frameFileName(index)),
      atMs: frameTimestampMs(index, input.fps, input.durationMs),
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
        preset: input.preset,
        command: encoded.command,
        error: encoded.error
      }),
      frameLane: "browser"
    };
  }
  await publishConnectorArtifact(stagingOutputPath, input.outputPath);
  encoded.receipt.output = {
    ...(readRecord(encoded.receipt.output) ?? {}),
    path: input.outputPath,
    frameLane: "browser"
  };
  encoded.receipt.artifacts = encoded.receipt.artifacts?.map((artifact) => artifact.role === "rendered_media"
    ? { ...artifact, path: input.outputPath }
    : artifact);
  return { receipt: encoded.receipt, frameLane: "browser" };
}

function createFailedRenderReceipt(input: {
  packageId: string;
  motionHash: string;
  createdAt: string;
  outputPath: string;
  preset: CanvasMp4ExportPreset;
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
      frameLane: "browser",
      preset: input.preset,
      command: input.command,
      error: input.error
    },
    warnings: [input.error.message]
  };
}

function createCanvasMp4ExportReceipt(input: {
  packageId: string;
  createdAt: string;
  inputHash: string;
  packageDir: string;
  resourceCatalogPath: string;
  renderDryRun: boolean;
  renderOk: boolean;
  renderPreset: CanvasMp4ExportPreset;
  renderFrameLane?: "browser";
  renderReceiptPath: string;
  renderOutputPath: string;
  artifacts: ConnectorArtifact[];
  warnings: string[];
  operationHash: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `connector-canvas-mp4-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.canvas_to_mp4",
    status: connectorReceiptStatus({ failed: !input.renderOk, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: { canvasSelection: input.inputHash, operation: input.operationHash },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      packageDir: input.packageDir,
      resourceCatalogPath: input.resourceCatalogPath,
      artifacts: input.artifacts,
      render: {
        ok: input.renderOk,
        dryRun: input.renderDryRun,
        lane: "ffmpeg",
        frameLane: input.renderFrameLane,
        preset: input.renderPreset,
        receiptPath: input.renderReceiptPath,
        outputPath: input.renderOutputPath
      }
    },
    warnings: input.warnings
  };
}

function normalizeCanvasMp4Preset(value: string | undefined): CanvasMp4ExportPreset {
  if (!value) return "mp4-h264";
  const preset = readFfmpegExportPreset(value);
  if (preset) return preset;
  throw new Error(`Unsupported export preset: ${value}.`);
}

function extensionForPreset(preset: CanvasMp4ExportPreset): string {
  return resolveExportPreset(preset).container;
}

function mediaTypeForPreset(preset: CanvasMp4ExportPreset): string {
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
