import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { admitCanvasMotionPackage, convertCanvasFrameToMotionPackage, writeCanvasMotionPackage } from "@shellx-motion/adapters-canvas";
import { attachRenderedMediaToCutPlan, planCutImport } from "@shellx-motion/adapters-cut";
import {
  BoundedResourceBudget,
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  hashBuffer,
  loadMotionPackage,
  readBudgetedStableFile,
  type AttestedArtifactHandleReference,
  type OperationReceipt,
  type ShellXIntegrationNegotiation
} from "@shellx-motion/core";
import { assertClosedDirectoryInventoryAvailable } from "@shellx-motion/core/internal/closed-directory-inventory";
import {
  readFfmpegExportPreset,
  resolveExportPreset,
  type FfmpegExportPreset,
  type FfmpegRunner
} from "@shellx-motion/renderer-ffmpeg";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { connectorArtifactOperationHash, finalizeConnectorArtifactHandle } from "./artifact-handle";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode";
import { assertConnectorOutputOwnership } from "./output-ownership";
import {
  createStreamingDryRunRenderReceipt,
  assertConnectorGpuFinalPreset,
  connectorGpuFinalReceiptBinding,
  resolveConnectorFinalFrameLane,
  type ConnectorRequestedFinalFrameLane,
  renderConnectorStreamingArtifact,
  type ConnectorStreamingFinalRenderer
} from "./streaming-final";

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
  /** Strict final-video producer. `gpu` never substitutes browser rendering. */
  frameLane?: ConnectorRequestedFinalFrameLane;
  dryRunRender?: boolean;
  /** High-level streamed-final seam for tests; this is not the legacy FFmpeg command runner. */
  streamingRenderer?: ConnectorStreamingFinalRenderer;
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
    frameLane?: ConnectorRequestedFinalFrameLane;
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
  const outDir = resolve(input.outDir);
  assertClosedDirectoryInventoryAvailable(outDir, "Canvas-to-MP4 package publication");
  const dryRunRender = input.dryRunRender ?? true;
  const preset = normalizeCanvasMp4Preset(input.preset);
  const frameLane = resolveConnectorFinalFrameLane(input.frameLane);
  assertConnectorGpuFinalPreset(frameLane, preset);
  const createdAt = input.now?.() ?? new Date().toISOString();
  const packageDir = join(outDir, "package");
  const receiptDir = join(outDir, "receipts");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
  const exportReceiptPath = join(outDir, "canvas-mp4-export.receipt.json");
  const cutPlanPath = join(outDir, "cut-import-plan.json");
  const canvasSelectionPath = resolve(input.canvasSelectionPath);
  const interchangeBudget = new BoundedResourceBudget(DEFAULT_HOST_INTERCHANGE_LIMITS, "Canvas-to-MP4 interchange");
  const canvasSelectionSource = await readBudgetedStableFile(canvasSelectionPath, {
    label: "Canvas selection input",
    budget: interchangeBudget,
    withinRoot: dirname(canvasSelectionPath)
  });
  const canvasSelectionBytes = canvasSelectionSource.bytes;
  const canvasSelection: unknown = JSON.parse(canvasSelectionBytes.toString("utf8"));

  // Negotiate the untrusted connector envelope before creating output state.
  // Unsupported peers therefore fail without partial package/receipt folders.
  const canvasExport = convertCanvasFrameToMotionPackage(canvasSelection, {
    createdAt,
    inputPath: canvasSelectionPath
  });
  const canvasAdmission = await admitCanvasMotionPackage(canvasExport, {
    sourceRoot: dirname(canvasSelectionPath),
    budget: interchangeBudget
  });
  // the output-ownership invariant: no guard ran here, so a caller's `<out>/package` was overwritten with ok:true.
  await assertConnectorOutputOwnership({
    packageDir,
    ownedDirs: [receiptDir, join(outDir, "render"), join(outDir, "artifacts")],
    ownedFiles: [cutPlanPath, exportReceiptPath],
    force: input.force === true
  });
  const writtenPackage = await writeCanvasMotionPackage(canvasExport, {
    packageDir,
    sourceRoot: dirname(canvasSelectionPath),
    budget: interchangeBudget,
    admission: canvasAdmission
  });

  const pkg = await loadMotionPackage(packageDir);
  const renderOutputPath = join(outDir, "render", `${pkg.manifest.id}.${extensionForPreset(preset)}`);
  const operationHash = connectorArtifactOperationHash({
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    preset,
    plan: { operation: "connector.canvas_to_mp4", canvasSelection: hashBuffer(canvasSelectionBytes) }
  });
  const renderResult = dryRunRender
    ? {
        frameLane,
        receipt: createStreamingDryRunRenderReceipt({
          pkg,
          createdAt,
          outputPath: renderOutputPath,
          preset,
          frameLane,
          quality: { minUniqueFrameHashes: 2 }
        })
      }
    : await renderConnectorStreamingArtifact({
        pkg,
        outputPath: renderOutputPath,
        preset,
        frameLane,
        quality: { minUniqueFrameHashes: 2 },
        streamingRenderer: input.streamingRenderer,
        runner: input.ffmpegRunner,
        now: () => createdAt
      });

  renderResult.receipt.inputHashes = { ...renderResult.receipt.inputHashes, operation: operationHash };
  await writeJson(renderReceiptPath, renderResult.receipt, true);
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
    renderGpu: connectorGpuFinalReceiptBinding({ frameLane, dryRun: dryRunRender, receipt: renderResult.receipt }),
    renderReceiptPath,
    renderOutputPath,
    artifacts,
    warnings,
    operationHash
  });
  await writeJson(exportReceiptPath, exportReceipt, true);
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
    await writeJson(cutPlanPath, cutPlan, true);
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

function createCanvasMp4ExportReceipt(input: {
  packageId: string;
  createdAt: string;
  inputHash: string;
  packageDir: string;
  resourceCatalogPath: string;
  renderDryRun: boolean;
  renderOk: boolean;
  renderPreset: CanvasMp4ExportPreset;
  renderFrameLane?: ConnectorRequestedFinalFrameLane;
  renderGpu?: ReturnType<typeof connectorGpuFinalReceiptBinding>;
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
        outputPath: input.renderOutputPath,
        ...(input.renderGpu ? input.renderGpu : {})
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

async function writeJson(path: string, value: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
