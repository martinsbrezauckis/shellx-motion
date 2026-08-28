/** Private P2B Script-to-Cut stage materializer; not exported by the connector barrel. */
import { writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { convertScriptedFramesToMotionPackage, writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import { attachRenderedMediaToCutPlan, placeRenderedMediaInCutPlan, planCutImport, type CutRenderedMediaPlacement } from "@shellx-motion/adapters-cut";
import { hashBuffer, loadedPackageInputHashes, loadMotionPackageFromAdmittedFiles, type OperationReceipt } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { connectorArtifactOperationHash, finalizeConnectorArtifactHandle } from "./artifact-handle";
import { throwIfConnectorAborted } from "./connector-cancellation";
import { createPrivateConnectorDelivery, type PrivateConnectorDelivery } from "./connector-delivery";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode";
import {
  admitGeneratedP2BPackage,
  assertNoP2BPrivateDeliveryPath,
  assertP2BBrowserPreviewPackageTreeDigest,
  assertP2BBrowserStreamingPackageTreeDigest,
  assertP2BClosedTreeCapacity,
  assertP2BNoExternalPath,
  assertP2BPathlessExecutionInput,
  assertP2BPackageDataLocators,
  bindP2BPackageTreeDigest,
  bindP2BPackageTreeDigestToCutPlan,
  captureP2BDeliveryLeaf,
  captureP2BReceiptBoundDeliveryLeaf,
  publishP2BAdmittedPackage,
  remapP2BPrivateDeliveryPaths,
  writeP2BDeliveryJson,
  P2B_MAX_MEDIA_BYTES
} from "./p2b-connector-delivery";
import { assertP2BAcceptedDeliveryCandidate, p2bDeliveryExpectedInventory } from "./p2b-delivery-validation";
import { renderConnectorStreamingArtifact } from "./streaming-final";
import type { ScriptToCutConnectorResult } from "./script-to-cut";

/** Creates all Script P2B stage content, but deliberately owns neither transaction nor commit. */
export async function materializeP2BScriptToCut(input: {
  delivery: PrivateConnectorDelivery;
  outDir: string;
  script: unknown;
  inputEvidence: { label: string; sha256: string; byteLength: number };
  /** Exact external authorities admitted before materialization; never publish their absolute paths. */
  externalInputPaths?: readonly string[];
  cutPlacement?: CutRenderedMediaPlacement;
  /** Parent-only stage leaves reserved before producers run (Source adds 3). */
  outerReservedLeaves?: number;
  /** Code-owned final root-relative package location; Source uses cut/package. */
  packageRootRelativePath?: string;
  createdAt?: string;
  /** Coordinator-owned cancellation passed from an admitted P2B connector. */
  signal?: AbortSignal;
}): Promise<{ result: ScriptToCutConnectorResult; expectedInventory: Awaited<ReturnType<typeof p2bDeliveryExpectedInventory>>; connectorReceipt: OperationReceipt }> {
  throwIfConnectorAborted(input.signal, "before Script-to-Cut package materialization");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const packageDir = join(input.outDir, "package");
  const receiptDir = join(input.outDir, "receipts");
  const previewPath = join(input.outDir, "preview", "browser-0.png");
  const previewReceiptPath = join(receiptDir, "browser-preview.receipt.json");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const renderOutputPath = join(input.outDir, "render", "scripted-video.mp4");
  const artifactHandlePath = join(input.outDir, "artifacts", "rendered-media.artifact.json");
  const cutPlanPath = join(input.outDir, "cut-import-plan.json");
  const connectorReceiptPath = join(input.outDir, "connector-run.receipt.json");
  const scriptedExport = convertScriptedFramesToMotionPackage(input.script, { createdAt, inputPath: "input/scripted-video.json" });
  const admittedPackage = await admitGeneratedP2BPackage({
    delivery: input.delivery,
    label: "Script-to-Cut generated package",
    writeGeneratedPackage: async (path) => { await writeScriptedMotionPackage(scriptedExport, { packageDir: path }); }
  });
  throwIfConnectorAborted(input.signal, "after Script-to-Cut package materialization");
  assertP2BClosedTreeCapacity(admittedPackage, 7 + (input.outerReservedLeaves ?? 0), input.packageRootRelativePath ?? "package");
  const pkg = loadMotionPackageFromAdmittedFiles(packageDir, admittedPackage.files);
  const immutablePackageTreeSha256 = loadedPackageInputHashes(pkg)?.["admitted-package-tree"];
  if (immutablePackageTreeSha256 !== admittedPackage.evidence.sha256) throw new Error("Script-to-Cut admitted execution snapshot does not match the published package-tree identity.");
  assertP2BPathlessExecutionInput(pkg, "Script-to-Cut");
  assertP2BPackageDataLocators(pkg, admittedPackage.files, "Script-to-Cut");
  let plannedCutImport = planCutImport(pkg, cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: "rendered_media" }));
  if (input.cutPlacement) plannedCutImport = placeRenderedMediaInCutPlan(plannedCutImport, input.cutPlacement);
  bindP2BPackageTreeDigestToCutPlan(plannedCutImport, immutablePackageTreeSha256);
  if (!plannedCutImport.ok || plannedCutImport.mode !== "rendered_media") throw new Error("Script-to-Cut P2B accepted delivery requires a valid rendered-media Browser-to-Cut plan.");
  const operationHash = connectorArtifactOperationHash({ packageId: pkg.manifest.id, motionId: pkg.motion.id, preset: "mp4-h264", plan: plannedCutImport });
  const stagedPackageDir = input.delivery.stagePath(packageDir);
  const stagedPreviewPath = input.delivery.stagePath(previewPath);
  const stagedPreviewReceiptPath = input.delivery.stagePath(previewReceiptPath);
  const stagedRenderOutputPath = input.delivery.stagePath(renderOutputPath);
  const stagedRenderReceiptPath = input.delivery.stagePath(renderReceiptPath);
  const stagedArtifactHandlePath = input.delivery.stagePath(artifactHandlePath);
  const stagedCutPlanPath = input.delivery.stagePath(cutPlanPath);
  const stagedConnectorReceiptPath = input.delivery.stagePath(connectorReceiptPath);
  await publishP2BAdmittedPackage(admittedPackage, stagedPackageDir);
  throwIfConnectorAborted(input.signal, "after Script-to-Cut package staging");
  // The public Browser still-frame API has no AbortSignal parameter. Check immediately on both
  // sides so its output cannot be carried onward after coordinator cancellation.
  throwIfConnectorAborted(input.signal, "before Script-to-Cut browser preview");
  const preview = await renderMotionBrowserFrame(pkg, { outDir: dirname(stagedPreviewPath), outputPath: stagedPreviewPath, atMs: 0, now: () => createdAt });
  throwIfConnectorAborted(input.signal, "after Script-to-Cut browser preview");
  assertP2BBrowserPreviewPackageTreeDigest(preview.receipt, immutablePackageTreeSha256);
  const previewReceipt = remapP2BPrivateDeliveryPaths(preview.receipt, input.delivery);
  bindP2BPackageTreeDigest(previewReceipt, immutablePackageTreeSha256, "Script-to-Cut preview receipt");
  await writeP2BDeliveryJson(input.delivery, stagedPreviewReceiptPath, previewReceipt, true);
  const previewEvidence = await captureP2BReceiptBoundDeliveryLeaf({ delivery: input.delivery, publicPath: previewPath, receipt: previewReceipt, label: "Script-to-Cut preview frame" });
  throwIfConnectorAborted(input.signal, "before Script-to-Cut final rendering");
  const renderResult = await renderConnectorStreamingArtifact({ pkg, outputPath: stagedRenderOutputPath, frameLane: "browser", signal: input.signal, now: () => createdAt });
  throwIfConnectorAborted(input.signal, "after Script-to-Cut final rendering");
  if (renderResult.frameLane !== "browser" || renderResult.receipt.status === "failed") throw new Error("Script-to-Cut P2B accepted delivery requires a successful Browser-frame-to-FFmpeg H.264 MP4 final render.");
  assertP2BBrowserStreamingPackageTreeDigest(renderResult.receipt, immutablePackageTreeSha256);
  const renderReceipt = remapP2BPrivateDeliveryPaths(renderResult.receipt, input.delivery);
  renderReceipt.inputHashes = { ...renderReceipt.inputHashes, operation: operationHash };
  bindP2BPackageTreeDigest(renderReceipt, immutablePackageTreeSha256, "Script-to-Cut render receipt");
  setP2BRenderReceiptOutputPath(renderReceipt, relative(input.delivery.publicRoot, renderOutputPath).split(sep).join("/"));
  await writeP2BDeliveryJson(input.delivery, stagedRenderReceiptPath, renderReceipt, true);
  const renderedMedia = await captureP2BDeliveryLeaf({ delivery: input.delivery, publicPath: renderOutputPath, label: "Script-to-Cut rendered media" });
  const artifacts = p2bScriptToCutArtifacts({ packageDir, previewPath, previewReceiptPath, renderOutputPath, renderReceiptPath, artifactHandlePath, cutPlanPath, connectorReceiptPath });
  const warnings = [...preview.receipt.warnings, ...renderReceipt.warnings, ...plannedCutImport.receipt.warnings];
  const connectorReceipt = createP2BScriptConnectorReceipt({ packageId: pkg.manifest.id, createdAt, inputEvidence: input.inputEvidence, packageDir, previewPath, previewReceiptPath, renderOutputPath, renderReceiptPath, cutPlanPath, artifacts, warnings, operationHash });
  bindP2BPackageTreeDigest(connectorReceipt, immutablePackageTreeSha256, "Script-to-Cut connector receipt");
  await writeP2BDeliveryJson(input.delivery, stagedConnectorReceiptPath, connectorReceipt, true);
  throwIfConnectorAborted(input.signal, "before Script-to-Cut artifact finalization");
  const finalizedArtifact = await finalizeConnectorArtifactHandle({ root: input.delivery.stagingRoot, descriptorPath: stagedArtifactHandlePath, artifactPath: stagedRenderOutputPath, renderReceiptPath: stagedRenderReceiptPath, connectorReceiptPath: stagedConnectorReceiptPath, pkg, operationHash, preset: "mp4-h264", mediaType: "video/mp4", createdAt, maxBytes: P2B_MAX_MEDIA_BYTES });
  throwIfConnectorAborted(input.signal, "after Script-to-Cut artifact finalization");
  if (finalizedArtifact.handle.sha256 !== renderedMedia.sha256 || finalizedArtifact.handle.byteLength !== renderedMedia.byteLength) throw new Error("Script-to-Cut artifact handle no longer matches the bounded rendered-media admission.");
  const cutPlan = attachRenderedMediaToCutPlan(plannedCutImport, { dryRun: false, handle: finalizedArtifact.reference });
  bindP2BPackageTreeDigestToCutPlan(cutPlan, immutablePackageTreeSha256);
  if (!cutPlan.ok || cutPlan.mode !== "rendered_media") throw new Error("Script-to-Cut P2B accepted delivery requires an attached valid rendered-media Browser-to-Cut plan.");
  await writeP2BDeliveryJson(input.delivery, stagedCutPlanPath, cutPlan, true);
  await assertP2BAcceptedDeliveryCandidate({ delivery: input.delivery, artifacts, connectorReceipt, stagedConnectorReceiptPath, renderReceipt, stagedRenderReceiptPath, cutPlan, finalizedArtifact, stagedArtifactHandlePath, stagedRenderOutputPath, immutablePackageTreeSha256, packageId: pkg.manifest.id, motionId: pkg.motion.id, operationHash });
  const expectedInventory = await p2bDeliveryExpectedInventory({ delivery: input.delivery, admittedPackage, packageDir, previewReceiptPath, previewReceipt, previewEvidence, renderReceiptPath, renderReceipt, renderedMedia, artifact: finalizedArtifact, cutPlanPath, cutPlan, connectorReceiptPath, connectorReceipt });
  throwIfConnectorAborted(input.signal, "after Script-to-Cut validation and before parent delivery commit");
  const result: ScriptToCutConnectorResult = {
    ok: true, packageDir,
    preview: { ok: true, lane: "browser", failureFatal: false, receiptPath: previewReceiptPath, outputPath: previewPath },
    render: { ok: true, required: true, dryRun: false, lane: "ffmpeg", frameLane: "browser", receiptPath: renderReceiptPath, outputPath: renderOutputPath },
    cutPlanPath, artifacts, receiptPath: connectorReceiptPath, warnings
  };
  assertNoP2BPrivateDeliveryPath(result, input.delivery);
  assertP2BNoExternalPath({ result, previewReceipt, connectorReceipt, renderReceipt, cutPlan }, input.externalInputPaths ?? [], "Script-to-Cut accepted delivery");
  return { result, expectedInventory, connectorReceipt };
}

function setP2BRenderReceiptOutputPath(receipt: OperationReceipt, path: string): void {
  if (!receipt.output || typeof receipt.output !== "object" || Array.isArray(receipt.output)) throw new Error("Script-to-Cut P2B render receipt has no mutable output record.");
  (receipt.output as Record<string, unknown>).path = path;
}

function p2bScriptToCutArtifacts(input: { packageDir: string; previewPath: string; previewReceiptPath: string; renderOutputPath: string; renderReceiptPath: string; artifactHandlePath: string; cutPlanPath: string; connectorReceiptPath: string }): ConnectorArtifact[] {
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

function createP2BScriptConnectorReceipt(input: { packageId: string; createdAt: string; inputEvidence: { label: string; sha256: string; byteLength: number }; packageDir: string; previewPath: string; previewReceiptPath: string; renderOutputPath: string; renderReceiptPath: string; cutPlanPath: string; artifacts: ConnectorArtifact[]; warnings: string[]; operationHash: string }): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `connector-script-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.script_to_cut",
    status: connectorReceiptStatus({ failed: false, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: { script: input.inputEvidence.sha256, operation: input.operationHash },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      artifacts: input.artifacts,
      inputEvidence: { kind: "scripted_video", label: input.inputEvidence.label, sha256: input.inputEvidence.sha256, byteLength: input.inputEvidence.byteLength },
      packageDir: input.packageDir,
      preview: { ok: true, lane: "browser", failureFatal: false, receiptPath: input.previewReceiptPath, outputPath: input.previewPath },
      render: { ok: true, required: true, dryRun: false, lane: "ffmpeg", frameLane: "browser", receiptPath: input.renderReceiptPath, outputPath: input.renderOutputPath },
      cut: { ok: true, mode: "rendered_media", planPath: input.cutPlanPath }
    },
    warnings: input.warnings
  };
}
