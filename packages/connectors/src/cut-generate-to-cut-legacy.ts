/** Private implementation retained only for the pre-P2B Cut Generate compatibility façade. */
import { dirname, join } from "node:path";
import { convertScriptedFramesToMotionPackage, writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import { attachRenderedMediaToCutPlan, placeRenderedMediaInCutPlan, planCutImport } from "@shellx-motion/adapters-cut";
import { BoundedResourceBudget, DEFAULT_HOST_INTERCHANGE_LIMITS, hashBuffer, loadMotionPackage, readBudgetedStableFile } from "@shellx-motion/core";
import { assertClosedDirectoryInventoryAvailable } from "@shellx-motion/core/internal/closed-directory-inventory";
import { renderNativePreviewFrame } from "@shellx-motion/renderer-native";
import { connectorArtifactOperationHash, finalizeConnectorArtifactHandle } from "./artifact-handle";
import type { CutGenerateToCutConnectorInput, CutGenerateToCutConnectorResult } from "./cut-generate-to-cut";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode";
import { assertConnectorOutputOwnership } from "./output-ownership";
import { resolveConnectorPath } from "./path-utils";
import { createCutGenerateConnectorReceipt, createCutGenerateNotRequiredReceipt, cutGenerateArtifacts, cutGenerateNativeRenderable, legacyCutGenerateMotionHash, writeCutGenerateJson } from "./cut-generate-to-cut-legacy-support";
import { assertConnectorGpuFinalPreset, connectorGpuFinalReceiptBinding, createStreamingDryRunRenderReceipt, renderConnectorStreamingArtifact, resolveConnectorFinalFrameLane } from "./streaming-final";

export async function runCutGenerateToCutLegacy(input: CutGenerateToCutConnectorInput): Promise<CutGenerateToCutConnectorResult> {
  const outDir = resolveConnectorPath(input.outDir);
  assertClosedDirectoryInventoryAvailable(outDir, "Cut Generate-to-Cut package publication");
  const previewLane = input.previewLane ?? "native";
  const renderLane = input.renderLane ?? "ffmpeg";
  const frameLane = resolveConnectorFinalFrameLane(input.frameLane);
  assertConnectorGpuFinalPreset(frameLane, "mp4-h264");
  const dryRunRender = input.dryRunRender ?? true;
  const createdAt = input.now?.() ?? new Date().toISOString();
  if (previewLane !== "native") throw new Error(`Unsupported connector preview lane: ${previewLane}`);
  if (renderLane !== "ffmpeg") throw new Error(`Unsupported connector render lane: ${renderLane}`);
  const scriptInput = await readCutGenerateScriptInput(input);
  const packageDir = join(outDir, "package");
  const receiptDir = join(outDir, "receipts");
  const previewPath = join(outDir, "preview", "native-0.png");
  const previewReceiptPath = join(receiptDir, "native-preview.receipt.json");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
  const cutPlanPath = join(outDir, "cut-import-plan.json");
  const connectorReceiptPath = join(outDir, "connector-run.receipt.json");
  await assertConnectorOutputOwnership({
    packageDir,
    ownedDirs: [receiptDir, join(outDir, "preview"), join(outDir, "render"), join(outDir, "artifacts")],
    ownedFiles: [cutPlanPath, connectorReceiptPath],
    force: input.force === true
  });
  const scriptedExport = convertScriptedFramesToMotionPackage(scriptInput.script, { createdAt, inputPath: scriptInput.label });
  await writeScriptedMotionPackage(scriptedExport, { packageDir });
  const preview = await renderNativePreviewFrame({ packageRoot: packageDir, outputPath: previewPath, outputRoots: [outDir], atMs: 0, now: () => createdAt });
  await writeCutGenerateJson(previewReceiptPath, preview.receipt, true);
  const pkg = await loadMotionPackage(packageDir);
  const renderOutputPath = join(outDir, "render", `${pkg.manifest.id}.mp4`);
  const baseCutImport = planCutImport(pkg, cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: input.cutImportMode ?? "rendered_media" }));
  const plannedCutImport = input.cutPlacement ? placeRenderedMediaInCutPlan(baseCutImport, input.cutPlacement) : baseCutImport;
  const renderRequired = plannedCutImport.mode === "rendered_media";
  if (frameLane === "gpu" && !renderRequired) throw new Error("GPU connector frame lane requires a rendered_media Cut handoff; editable Cut lowering does not execute a GPU final render.");
  const operationHash = connectorArtifactOperationHash({ packageId: pkg.manifest.id, motionId: pkg.motion.id, preset: "mp4-h264", plan: plannedCutImport });
  if (frameLane === "browser" && renderRequired && !dryRunRender && !cutGenerateNativeRenderable(pkg)) throw new Error("Script-to-Cut connector can only render native scripted text, shape, and caption layers.");
  const quality = Math.ceil((pkg.motion.durationMs / 1_000) * pkg.motion.fps) > 1 ? { minUniqueFrameHashes: 2 } : undefined;
  const renderResult = !renderRequired
    ? { required: false, frameLane: undefined, receipt: createCutGenerateNotRequiredReceipt({ packageId: pkg.manifest.id, motionHash: legacyCutGenerateMotionHash(pkg.motion), createdAt, mode: plannedCutImport.mode }) }
    : dryRunRender
      ? { required: true, frameLane, receipt: createStreamingDryRunRenderReceipt({ pkg, createdAt, outputPath: renderOutputPath, frameLane, quality }) }
      : await renderConnectorStreamingArtifact({ pkg, outputPath: renderOutputPath, frameLane, quality, streamingRenderer: input.streamingRenderer, runner: input.ffmpegRunner, now: () => createdAt });
  const renderReceipt = renderResult.receipt;
  renderReceipt.inputHashes = { ...renderReceipt.inputHashes, operation: operationHash };
  const renderOk = renderReceipt.status !== "failed";
  await writeCutGenerateJson(renderReceiptPath, renderReceipt, true);
  let cutPlan = renderRequired && dryRunRender ? attachRenderedMediaToCutPlan(plannedCutImport, { plannedPath: renderOutputPath, receiptPath: renderReceiptPath, dryRun: true }) : plannedCutImport;
  const warnings = [...preview.warnings, ...renderReceipt.warnings, ...cutPlan.receipt.warnings];
  const previewFailureFatal = renderRequired && dryRunRender && !preview.ok;
  const artifacts = cutGenerateArtifacts({
    scriptPath: scriptInput.path, packageDir, previewPath, previewOk: preview.ok, previewReceiptPath, renderRequired, renderDryRun: dryRunRender, renderOk,
    renderOutputPath, renderReceiptPath, cutPlanPath, connectorReceiptPath, artifactHandlePath: renderRequired && !dryRunRender && renderOk ? artifactHandlePath : undefined
  });
  const connectorReceipt = createCutGenerateConnectorReceipt({
    packageId: pkg.manifest.id, createdAt, inputPath: scriptInput.label, inputHash: hashBuffer(scriptInput.bytes), packageDir, previewOk: preview.ok,
    previewFailureFatal, previewReceiptPath, renderOk, renderReceiptPath, renderRequired, renderDryRun: dryRunRender, renderFrameLane: renderResult.frameLane,
    renderGpu: connectorGpuFinalReceiptBinding({ frameLane: renderResult.frameLane, dryRun: dryRunRender, receipt: renderReceipt }), renderOutputPath: renderRequired ? renderOutputPath : undefined,
    cutOk: cutPlan.ok, cutMode: cutPlan.mode, cutPlanPath, artifacts, warnings, operationHash
  });
  await writeCutGenerateJson(connectorReceiptPath, connectorReceipt, true);
  if (renderRequired && !dryRunRender && renderOk) {
    const finalized = await finalizeConnectorArtifactHandle({ root: outDir, descriptorPath: artifactHandlePath, artifactPath: renderOutputPath, renderReceiptPath, connectorReceiptPath, pkg, operationHash, preset: "mp4-h264", mediaType: "video/mp4", createdAt });
    cutPlan = attachRenderedMediaToCutPlan(plannedCutImport, { dryRun: false, handle: finalized.reference });
  }
  await writeCutGenerateJson(cutPlanPath, cutPlan, true);
  return {
    ok: !previewFailureFatal && cutPlan.ok && renderOk,
    packageDir,
    preview: { ok: preview.ok, lane: "native", failureFatal: previewFailureFatal, receiptPath: previewReceiptPath, outputPath: preview.ok ? preview.frame.path : null },
    render: { ok: renderOk, required: renderRequired, dryRun: renderRequired ? dryRunRender : true, lane: "ffmpeg", frameLane: renderResult.frameLane, receiptPath: renderReceiptPath, ...(renderRequired ? { outputPath: renderOutputPath } : {}) },
    cutPlanPath, artifacts, receiptPath: connectorReceiptPath, warnings
  };
}

async function readCutGenerateScriptInput(input: CutGenerateToCutConnectorInput): Promise<{ path?: string; label: string; bytes: Buffer; script: unknown }> {
  const hasPath = typeof input.scriptPath === "string" && input.scriptPath.length > 0;
  const hasInline = input.script !== undefined;
  if (hasPath === hasInline) throw new Error("Script-to-Cut requires exactly one input source: scriptPath or inline script.");
  if (hasInline) {
    const bytes = Buffer.from(`${JSON.stringify(input.script)}\n`, "utf8");
    const budget = new BoundedResourceBudget(DEFAULT_HOST_INTERCHANGE_LIMITS, "Script-to-Cut interchange");
    budget.reserve("inline-scripted-video.json", bytes.byteLength);
    return { label: "inline-scripted-video.json", bytes, script: input.script };
  }
  const path = resolveConnectorPath(input.scriptPath!);
  const budget = new BoundedResourceBudget(DEFAULT_HOST_INTERCHANGE_LIMITS, "Script-to-Cut interchange");
  const source = await readBudgetedStableFile(path, { label: "Scripted-video input", budget, withinRoot: dirname(path) });
  try {
    return { path, label: path, bytes: source.bytes, script: JSON.parse(source.bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`Scripted-video input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
