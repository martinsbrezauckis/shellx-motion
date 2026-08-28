import { dirname, join, relative, resolve, sep } from "node:path";
import { admitCanvasMotionPackage, convertCanvasFrameToMotionPackage, writeCanvasMotionPackage } from "@shellx-motion/adapters-canvas";
import { attachRenderedMediaToCutPlan, planCutImport } from "@shellx-motion/adapters-cut";
import { BoundedResourceBudget, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, hashBuffer, loadedPackageInputHashes, loadMotionPackageFromAdmittedFiles, readBudgetedStableFile, type OperationReceipt } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { connectorArtifactOperationHash, finalizeConnectorArtifactHandle } from "./artifact-handle";
import { throwIfConnectorAborted } from "./connector-cancellation";
import { createPrivateConnectorDelivery } from "./connector-delivery";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode";
import {
  admitGeneratedP2BPackage, assertNoP2BPrivateDeliveryPath,
  assertP2BBrowserPreviewPackageTreeDigest, assertP2BBrowserStreamingPackageTreeDigest, assertP2BClosedTreeCapacity,
  assertP2BExternalInput, assertP2BLinuxBeforeInput, assertP2BNoExternalPath, assertP2BPathlessExecutionInput,
  assertP2BPackageDataLocators,
  bindP2BPackageTreeDigest, bindP2BPackageTreeDigestToCutPlan, captureP2BDeliveryLeaf,
  captureP2BReceiptBoundDeliveryLeaf, publishP2BAdmittedPackage,
  remapP2BPrivateDeliveryPaths, writeP2BDeliveryJson, P2B_MAX_MEDIA_BYTES
} from "./p2b-connector-delivery";
import { assertP2BAcceptedDeliveryCandidate, p2bDeliveryExpectedInventory } from "./p2b-delivery-validation";
import { renderConnectorStreamingArtifact } from "./streaming-final";

/** P2B public input: Canvas selection evidence and a new or empty delivery root. */
export interface CanvasToCutConnectorInput {
  canvasSelectionPath: string;
  outDir: string;
  /**
   * Host-internal authority for the resolved selection. A named/local caller owns a trusted
   * selection bundle; a generic opaque reference grants only the selected file itself.
   * This is deliberately not a connector request field.
   */
  canvasSelectionAuthority?: "trusted-local-bundle" | "opaque-file";
  /** Coordinator-owned cancellation for this private P2B delivery. */
  signal?: AbortSignal;
  /** Explicit compatibility spelling; only real rendered media is accepted. */
  cutImportMode?: "rendered_media";
}

export interface CanvasToCutConnectorResult {
  ok: true;
  status: "passed" | "warning";
  packageDir: string;
  preview: { ok: true; lane: "browser"; failureFatal: false; receiptPath: string; outputPath: string };
  render: { ok: true; required: true; dryRun: false; lane: "ffmpeg"; frameLane: "browser"; preset: "mp4-h264"; receiptPath: string; outputPath: string };
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  receiptPath: string;
  warnings: string[];
}

/** Internal continuation state; it contains admitted selection bytes, never a host request field. */
export interface PreparedCanvasToCutSelection {
  canvasSelectionPath: string;
  createdAt: string;
  signal?: AbortSignal;
  interchangeBudget: BoundedResourceBudget;
  selectionSource: Awaited<ReturnType<typeof readBudgetedStableFile>>;
  canvasExport: ReturnType<typeof convertCanvasFrameToMotionPackage>;
  admittedAssets: Awaited<ReturnType<typeof admitCanvasMotionPackage>>;
}

/** A generic opaque selection may not expand its authority to selection-file siblings. */
export class CanvasToCutConnectorAuthorityError extends Error {
  readonly code = "connector_reference_refused";

  constructor(message: string) {
    super(message);
    this.name = "CanvasToCutConnectorAuthorityError";
  }
}

export async function runCanvasToCutConnector(input: CanvasToCutConnectorInput): Promise<CanvasToCutConnectorResult> {
  const prepared = await prepareCanvasToCutConnectorSelection(input);
  return await runPreparedCanvasToCutConnector(prepared, input.outDir);
}

/**
 * Read and convert only the selected Canvas file before a generic host resolves any output.
 * Opaque-file authority intentionally stops before asset admission because assets are siblings.
 */
export async function prepareCanvasToCutConnectorSelection(
  input: Pick<CanvasToCutConnectorInput, "canvasSelectionPath" | "canvasSelectionAuthority" | "signal" | "cutImportMode">
): Promise<PreparedCanvasToCutSelection> {
  throwIfConnectorAborted(input.signal, "before Canvas-to-Cut admission");
  assertP2BLinuxBeforeInput();
  assertP2BCanvasLegacyFields(input);
  const canvasSelectionPath = resolve(input.canvasSelectionPath);
  const interchangeBudget = new BoundedResourceBudget(DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, "Canvas-to-Cut P2B interchange");
  const selectionSource = await readBudgetedStableFile(canvasSelectionPath, { label: "Canvas selection input", budget: interchangeBudget, withinRoot: dirname(canvasSelectionPath) });
  throwIfConnectorAborted(input.signal, "after Canvas-to-Cut input admission");
  let canvasSelection: unknown;
  try { canvasSelection = JSON.parse(selectionSource.bytes.toString("utf8")); }
  catch (error) { throw new Error(`Canvas selection input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const createdAt = new Date().toISOString();
  const canvasExport = convertCanvasFrameToMotionPackage(canvasSelection, { createdAt, inputPath: "input/canvas-selection.json" });
  if (canvasSelectionAuthority(input) === "opaque-file" && canvasExport.manifest.assets.length > 0) {
    throw new CanvasToCutConnectorAuthorityError("Canvas-to-Cut generic opaque input authorizes only the selected asset-free Canvas file; asset-bearing selections require trusted local bundle authority.");
  }
  const admittedAssets = await admitCanvasMotionPackage(canvasExport, { sourceRoot: dirname(canvasSelectionPath), budget: interchangeBudget });
  throwIfConnectorAborted(input.signal, "after Canvas-to-Cut asset admission");
  if (admittedAssets.missingAssetRefs.length > 0) throw new Error(`Canvas-to-Cut P2B accepted delivery refuses missing Canvas assets: ${admittedAssets.missingAssetRefs.join(", ")}.`);
  return { canvasSelectionPath, createdAt, signal: input.signal, interchangeBudget, selectionSource, canvasExport, admittedAssets };
}

/** Continue a selection already admitted under the host-internal authority policy. */
export async function runPreparedCanvasToCutConnector(
  prepared: PreparedCanvasToCutSelection,
  outputPath: string
): Promise<CanvasToCutConnectorResult> {
  const { canvasSelectionPath, createdAt, signal, interchangeBudget, selectionSource, canvasExport, admittedAssets } = prepared;
  const outDir = resolve(outputPath);
  assertP2BExternalInput(outDir, canvasSelectionPath, "Canvas selection input");
  const delivery = await createPrivateConnectorDelivery(outDir);
  try {
    const packageDir = join(outDir, "package"), receiptDir = join(outDir, "receipts");
    const previewPath = join(outDir, "preview", "browser-0.png"), previewReceiptPath = join(receiptDir, "browser-preview.receipt.json");
    const renderOutputPath = join(outDir, "render", "canvas.mp4"), renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
    const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json"), cutPlanPath = join(outDir, "cut-import-plan.json"), connectorReceiptPath = join(outDir, "connector-run.receipt.json");
    const admittedPackage = await admitGeneratedP2BPackage({
      delivery, label: "Canvas-to-Cut generated package",
      writeGeneratedPackage: async (path) => { await writeCanvasMotionPackage(canvasExport, { packageDir: path, budget: interchangeBudget, admission: admittedAssets }); }
    });
    throwIfConnectorAborted(signal, "after Canvas-to-Cut package materialization");
    assertP2BClosedTreeCapacity(admittedPackage, 7);
    const pkg = loadMotionPackageFromAdmittedFiles(packageDir, admittedPackage.files);
    const immutablePackageTreeSha256 = loadedPackageInputHashes(pkg)?.["admitted-package-tree"];
    if (immutablePackageTreeSha256 !== admittedPackage.evidence.sha256) throw new Error("Canvas-to-Cut admitted execution snapshot does not match the published package-tree identity.");
    assertP2BPathlessExecutionInput(pkg, "Canvas-to-Cut");
    assertP2BPackageDataLocators(pkg, admittedPackage.files, "Canvas-to-Cut");
    const plannedCutImport = planCutImport(pkg, cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: "rendered_media" }));
    bindP2BPackageTreeDigestToCutPlan(plannedCutImport, immutablePackageTreeSha256);
    if (!plannedCutImport.ok || plannedCutImport.mode !== "rendered_media") throw new Error("Canvas-to-Cut P2B accepted delivery requires a valid rendered-media Browser-to-Cut plan.");
    const operationHash = connectorArtifactOperationHash({ packageId: pkg.manifest.id, motionId: pkg.motion.id, preset: "mp4-h264", plan: plannedCutImport });
    const stagedPackageDir = delivery.stagePath(packageDir), stagedPreviewPath = delivery.stagePath(previewPath), stagedPreviewReceiptPath = delivery.stagePath(previewReceiptPath);
    const stagedRenderOutputPath = delivery.stagePath(renderOutputPath), stagedRenderReceiptPath = delivery.stagePath(renderReceiptPath), stagedArtifactHandlePath = delivery.stagePath(artifactHandlePath);
    const stagedCutPlanPath = delivery.stagePath(cutPlanPath), stagedConnectorReceiptPath = delivery.stagePath(connectorReceiptPath);
    await publishP2BAdmittedPackage(admittedPackage, stagedPackageDir);
    throwIfConnectorAborted(signal, "after Canvas-to-Cut package staging");
    // The public Browser still-frame API has no AbortSignal parameter. Check immediately on
    // both sides so its completed output cannot advance a cancelled connector delivery.
    throwIfConnectorAborted(signal, "before Canvas-to-Cut browser preview");
    const preview = await renderMotionBrowserFrame(pkg, { outDir: dirname(stagedPreviewPath), outputPath: stagedPreviewPath, atMs: 0, now: () => createdAt });
    throwIfConnectorAborted(signal, "after Canvas-to-Cut browser preview");
    assertP2BBrowserPreviewPackageTreeDigest(preview.receipt, immutablePackageTreeSha256);
    const previewReceipt = remapP2BPrivateDeliveryPaths(preview.receipt, delivery);
    bindP2BPackageTreeDigest(previewReceipt, immutablePackageTreeSha256, "Canvas-to-Cut preview receipt");
    await writeP2BDeliveryJson(delivery, stagedPreviewReceiptPath, previewReceipt, true);
    const previewEvidence = await captureP2BReceiptBoundDeliveryLeaf({ delivery, publicPath: previewPath, receipt: previewReceipt, label: "Canvas-to-Cut preview frame" });
    throwIfConnectorAborted(signal, "before Canvas-to-Cut final rendering");
    const renderResult = await renderConnectorStreamingArtifact({ pkg, outputPath: stagedRenderOutputPath, preset: "mp4-h264", frameLane: "browser", signal, now: () => createdAt });
    throwIfConnectorAborted(signal, "after Canvas-to-Cut final rendering");
    if (renderResult.frameLane !== "browser" || renderResult.receipt.status === "failed") throw new Error("Canvas-to-Cut P2B accepted delivery requires a successful Browser-frame-to-FFmpeg H.264 MP4 final render.");
    assertP2BBrowserStreamingPackageTreeDigest(renderResult.receipt, immutablePackageTreeSha256);
    const renderReceipt = remapP2BPrivateDeliveryPaths(renderResult.receipt, delivery);
    renderReceipt.inputHashes = { ...renderReceipt.inputHashes, operation: operationHash };
    bindP2BPackageTreeDigest(renderReceipt, immutablePackageTreeSha256, "Canvas-to-Cut render receipt");
    setP2BRenderReceiptOutputPath(renderReceipt, relative(outDir, renderOutputPath).split(sep).join("/"));
    await writeP2BDeliveryJson(delivery, stagedRenderReceiptPath, renderReceipt, true);
    const renderedMedia = await captureP2BDeliveryLeaf({ delivery, publicPath: renderOutputPath, label: "Canvas-to-Cut rendered media" });
    const artifacts = canvasP2BArtifacts({ packageDir, previewPath, previewReceiptPath, renderOutputPath, renderReceiptPath, artifactHandlePath, cutPlanPath, connectorReceiptPath });
    const warnings = [...preview.receipt.warnings, ...renderReceipt.warnings, ...plannedCutImport.receipt.warnings];
    const connectorReceipt = createCanvasP2BReceipt({ packageId: pkg.manifest.id, createdAt, selectionSha256: selectionSource.sha256, selectionByteLength: selectionSource.byteLength, packageDir, previewPath, previewReceiptPath, renderOutputPath, renderReceiptPath, cutPlanPath, artifacts, warnings, operationHash });
    bindP2BPackageTreeDigest(connectorReceipt, immutablePackageTreeSha256, "Canvas-to-Cut connector receipt");
    await writeP2BDeliveryJson(delivery, stagedConnectorReceiptPath, connectorReceipt, true);
    throwIfConnectorAborted(signal, "before Canvas-to-Cut artifact finalization");
    const finalizedArtifact = await finalizeConnectorArtifactHandle({ root: delivery.stagingRoot, descriptorPath: stagedArtifactHandlePath, artifactPath: stagedRenderOutputPath, renderReceiptPath: stagedRenderReceiptPath, connectorReceiptPath: stagedConnectorReceiptPath, pkg, operationHash, preset: "mp4-h264", mediaType: "video/mp4", createdAt, maxBytes: P2B_MAX_MEDIA_BYTES });
    throwIfConnectorAborted(signal, "after Canvas-to-Cut artifact finalization");
    if (finalizedArtifact.handle.sha256 !== renderedMedia.sha256 || finalizedArtifact.handle.byteLength !== renderedMedia.byteLength) throw new Error("Canvas-to-Cut artifact handle no longer matches the bounded rendered-media admission.");
    const cutPlan = attachRenderedMediaToCutPlan(plannedCutImport, { dryRun: false, handle: finalizedArtifact.reference });
    bindP2BPackageTreeDigestToCutPlan(cutPlan, immutablePackageTreeSha256);
    if (!cutPlan.ok || cutPlan.mode !== "rendered_media") throw new Error("Canvas-to-Cut P2B accepted delivery requires an attached valid rendered-media Browser-to-Cut plan.");
    await writeP2BDeliveryJson(delivery, stagedCutPlanPath, cutPlan, true);
    await assertP2BAcceptedDeliveryCandidate({ delivery, artifacts, connectorReceipt, stagedConnectorReceiptPath, renderReceipt, stagedRenderReceiptPath, cutPlan, finalizedArtifact, stagedArtifactHandlePath, stagedRenderOutputPath, immutablePackageTreeSha256, packageId: pkg.manifest.id, motionId: pkg.motion.id, operationHash });
    const expectedInventory = await p2bDeliveryExpectedInventory({ delivery, admittedPackage, packageDir, previewReceiptPath, previewReceipt, previewEvidence, renderReceiptPath, renderReceipt, renderedMedia, artifact: finalizedArtifact, cutPlanPath, cutPlan, connectorReceiptPath, connectorReceipt });
    const result: CanvasToCutConnectorResult = {
      ok: true, status: connectorReceipt.status as "passed" | "warning", packageDir,
      preview: { ok: true, lane: "browser", failureFatal: false, receiptPath: previewReceiptPath, outputPath: previewPath },
      render: { ok: true, required: true, dryRun: false, lane: "ffmpeg", frameLane: "browser", preset: "mp4-h264", receiptPath: renderReceiptPath, outputPath: renderOutputPath },
      cutPlanPath, artifacts, receiptPath: connectorReceiptPath, warnings
    };
    assertNoP2BPrivateDeliveryPath({ result, connectorReceipt, renderReceipt, cutPlan }, delivery);
    assertP2BNoExternalPath({ result, connectorReceipt, renderReceipt, cutPlan }, [canvasSelectionPath], "Canvas-to-Cut accepted delivery");
    throwIfConnectorAborted(signal, "after Canvas-to-Cut validation and before delivery commit");
    await delivery.commit(expectedInventory);
    return result;
  } catch (error) {
    await delivery.abort();
    throw error;
  }
}

function assertP2BCanvasLegacyFields(input: Pick<CanvasToCutConnectorInput, "cutImportMode">): void {
  const legacy = input as Pick<CanvasToCutConnectorInput, "cutImportMode"> & Record<string, unknown>;
  if (legacy.cutImportMode !== undefined && legacy.cutImportMode !== "rendered_media") throw new Error("Canvas-to-Cut P2B accepted delivery refuses legacy cutImportMode other than rendered_media.");
  const rejected = ["force", "previewLane", "renderLane", "frameLane", "preset", "dryRunRender", "streamingRenderer", "ffmpegRunner", "now"].find((key) => legacy[key] !== undefined);
  if (rejected) throw new Error(`Canvas-to-Cut P2B accepted delivery does not support legacy ${rejected}; it always produces real Browser-preview and Browser-frame-to-FFmpeg H.264 rendered_media.`);
}

function canvasSelectionAuthority(input: Pick<CanvasToCutConnectorInput, "canvasSelectionAuthority">): NonNullable<CanvasToCutConnectorInput["canvasSelectionAuthority"]> {
  const authority = input.canvasSelectionAuthority ?? "trusted-local-bundle";
  if (authority === "trusted-local-bundle" || authority === "opaque-file") return authority;
  throw new Error("Canvas-to-Cut received an unknown host-internal selection authority policy.");
}

function canvasP2BArtifacts(input: { packageDir: string; previewPath: string; previewReceiptPath: string; renderOutputPath: string; renderReceiptPath: string; artifactHandlePath: string; cutPlanPath: string; connectorReceiptPath: string }): ConnectorArtifact[] {
  return [
    { role: "motion_package", path: input.packageDir, status: "available" },
    { role: "preview_frame", path: input.previewPath, status: "available", mediaType: "image/png" },
    { role: "preview_receipt", path: input.previewReceiptPath, status: "available" },
    { role: "rendered_media", path: input.renderOutputPath, status: "available", mediaType: "video/mp4", primary: true },
    { role: "render_receipt", path: input.renderReceiptPath, status: "available" },
    { role: "artifact_handle", path: input.artifactHandlePath, status: "available", mediaType: "application/vnd.shellx-motion.artifact-handle+json" },
    { role: "cut_plan", path: input.cutPlanPath, status: "available" },
    { role: "connector_receipt", path: input.connectorReceiptPath, status: "available" }
  ];
}

function createCanvasP2BReceipt(input: { packageId: string; createdAt: string; selectionSha256: string; selectionByteLength: number; packageDir: string; previewPath: string; previewReceiptPath: string; renderOutputPath: string; renderReceiptPath: string; cutPlanPath: string; artifacts: ConnectorArtifact[]; warnings: string[]; operationHash: string }): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: `connector-canvas-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.canvas_to_cut", status: connectorReceiptStatus({ failed: false, warnings: input.warnings }), packageId: input.packageId,
    inputHashes: { canvasSelection: input.selectionSha256, operation: input.operationHash }, createdAt: input.createdAt, lane: "connector",
    output: {
      artifacts: input.artifacts,
      inputEvidence: { kind: "canvas_selection", label: "canvas-selection.json", sha256: input.selectionSha256, byteLength: input.selectionByteLength },
      packageDir: input.packageDir,
      preview: { ok: true, lane: "browser", failureFatal: false, receiptPath: input.previewReceiptPath, outputPath: input.previewPath },
      render: { ok: true, required: true, dryRun: false, lane: "ffmpeg", frameLane: "browser", preset: "mp4-h264", receiptPath: input.renderReceiptPath, outputPath: input.renderOutputPath },
      cut: { ok: true, mode: "rendered_media", planPath: input.cutPlanPath }
    }, warnings: input.warnings
  };
}

function setP2BRenderReceiptOutputPath(receipt: OperationReceipt, path: string): void {
  if (!receipt.output || typeof receipt.output !== "object" || Array.isArray(receipt.output)) throw new Error("Canvas-to-Cut P2B render receipt has no mutable output record.");
  (receipt.output as Record<string, unknown>).path = path;
}
