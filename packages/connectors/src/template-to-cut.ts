import { dirname, join, relative, resolve, sep } from "node:path";
import { attachRenderedMediaToCutPlan, placeRenderedMediaInCutPlan, planCutImport, type CutRenderedMediaPlacement } from "@shellx-motion/adapters-cut";
import {
  applyTemplateValues,
  escalateReceiptStatusForWarnings,
  hashBuffer,
  loadedPackageInputHashes,
  loadMotionPackageFromAdmittedFiles,
  readBoundedStableFile,
  type MotionPackage,
  type OperationReceipt,
  type TemplateChangedBinding,
  type TemplateValue,
} from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { connectorArtifactOperationHash, finalizeConnectorArtifactHandle } from "./artifact-handle";
import { throwIfConnectorAborted } from "./connector-cancellation";
import { createPrivateConnectorDelivery } from "./connector-delivery";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode";
import {
  renderConnectorStreamingArtifact
} from "./streaming-final";
import {
  admitBoundedPackageTree,
  publishAdmittedPackageTree,
  replaceAdmittedPackageFile,
  type AdmittedPackageTreeEvidence
} from "./bounded-package-copy";
import {
  assertBrowserPreviewPackageTreeDigest,
  assertBrowserStreamingPackageTreeDigest,
  assertClosedDeliveryPackageDirectories,
  assertNoPrivateDeliveryPath,
  assertP2AClosedTreeCapacity,
  assertP2APathlessExecutionInput,
  assertTemplateAcceptedDeliveryCandidate,
  bindPackageTreeDigestToCutPlan,
  bindPackageTreeDigestToReceipt,
  captureReceiptBoundDeliveryLeaf,
  removeKnownEmptyPrivateDirectory,
  remapPrivateDeliveryPaths,
  setReceiptOutputPath,
  TEMPLATE_CLOSED_DELIVERY_MAX_MEDIA_BYTES,
  templateDeliveryExpectedInventory,
  writeDeliveryJson
} from "./template-to-cut-delivery";

export interface TemplateToCutConnectorInput {
  packageRoot: string;
  values: Record<string, TemplateValue>;
  outDir: string;
  cutPlacement?: CutRenderedMediaPlacement;
  /** Coordinator-owned cancellation for this private P2A delivery. */
  signal?: AbortSignal;
}

/** Private compatibility fence for untyped callers. It is deliberately not exported. */
interface TemplateToCutRejectedLegacyOptions {
  force?: unknown;
  previewLane?: unknown;
  renderLane?: unknown;
  frameLane?: unknown;
  dryRunRender?: unknown;
  cutImportMode?: unknown;
}

export interface TemplateToCutConnectorResult {
  ok: true;
  packageDir: string;
  template: {
    changedParams: string[];
    changedBindings: TemplateChangedBinding[];
    receiptPath: string;
  };
  preview: { ok: true; lane: "browser"; atMs: number; failureFatal: false; receiptPath: string; outputPath: string };
  render: {
    ok: true;
    required: true;
    dryRun: false;
    lane: "ffmpeg";
    frameLane: "browser";
    receiptPath: string;
    outputPath: string;
  };
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  receiptPath: string;
  warnings: string[];
}

export async function runTemplateToCutConnector(input: TemplateToCutConnectorInput): Promise<TemplateToCutConnectorResult> {
  throwIfConnectorAborted(input.signal, "before Template-to-Cut admission");
  const legacy = input as TemplateToCutConnectorInput & TemplateToCutRejectedLegacyOptions;
  if (legacy.force !== undefined) {
    throw new Error("Template-to-Cut accepted delivery does not support force; choose an absent or empty output directory.");
  }
  if (legacy.dryRunRender !== undefined) {
    throw new Error("Template-to-Cut accepted delivery requires a real browser-to-ffmpeg media render; dry-run does not create an accepted P2A delivery.");
  }
  if (legacy.cutImportMode !== undefined && legacy.cutImportMode !== "rendered_media") {
    throw new Error("Template-to-Cut P2A accepted delivery supports only cutImportMode rendered_media.");
  }
  if (legacy.previewLane !== undefined && legacy.previewLane !== "browser") {
    throw new Error("Template-to-Cut accepted delivery is browser-preview-only in P2A; native preview has no immutable admitted-package fulfillment yet.");
  }
  if (legacy.renderLane !== undefined && legacy.renderLane !== "ffmpeg") {
    throw new Error(`Unsupported connector render lane: ${String(legacy.renderLane)}`);
  }
  if (legacy.frameLane !== undefined && legacy.frameLane !== "browser") {
    throw new Error("Template-to-Cut accepted delivery currently supports only the browser final lane; GPU provenance is not yet closed for P2A.");
  }
  const createdAt = new Date().toISOString();
  const frameLane: "browser" = "browser";
  if (process.platform !== "linux") {
    throw new Error("Template-to-Cut accepted delivery is Linux-only until a descriptor/DACL-equivalent exact-tree publication capability is available on this host.");
  }

  const sourcePackageRoot = resolve(input.packageRoot);
  const outDir = resolve(input.outDir);
  const packageDir = join(outDir, "package");
  const receiptDir = join(outDir, "receipts");
  const templateApplyReceiptPath = join(packageDir, "receipts", "template-apply.receipt.json");
  const renderReceiptPath = join(receiptDir, "ffmpeg-render.receipt.json");
  const artifactHandlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
  const cutPlanPath = join(outDir, "cut-import-plan.json");
  const connectorReceiptPath = join(outDir, "connector-run.receipt.json");

  const admittedSource = await admitBoundedPackageTree(sourcePackageRoot, { label: "Template-to-Cut interchange" });
  throwIfConnectorAborted(input.signal, "after Template-to-Cut source admission");
  const sourcePackage = loadMotionPackageFromAdmittedFiles(packageDir, admittedSource.files);
  const applied = applyTemplateValues(sourcePackage, input.values);
  if (!applied.ok) {
    const message = applied.errors.map((error) => `${error.paramId || "(package)"}: ${error.message}`).join("; ");
    throw new Error(`Template apply failed: ${message}`);
  }
  const admittedPackage = replaceAdmittedPackageFile(
    admittedSource,
    sourcePackage.manifest.motion,
    Buffer.from(`${JSON.stringify(applied.motion, null, 2)}\n`, "utf8")
  );
  assertClosedDeliveryPackageDirectories(admittedPackage);
  assertP2AClosedTreeCapacity(admittedPackage);
  // The logical root is the eventual public package directory. Core retains all execution bytes
  // behind its private snapshot capability; no accepted execution path reads this pathname.
  const pkg = loadMotionPackageFromAdmittedFiles(packageDir, admittedPackage.files);
  const immutablePackageTreeSha256 = loadedPackageInputHashes(pkg)?.["admitted-package-tree"];
  if (immutablePackageTreeSha256 !== admittedPackage.evidence.sha256) {
    throw new Error("Template-to-Cut admitted execution snapshot does not match the published package-tree identity.");
  }
  assertP2APathlessExecutionInput(pkg);
  const baseCutImport = planCutImport(pkg, cutTargetCapabilitiesForMode({
    targetId: "shellx-cut",
    mode: "rendered_media"
  }));
  const plannedCutImport = input.cutPlacement
    ? placeRenderedMediaInCutPlan(baseCutImport, input.cutPlacement)
    : baseCutImport;
  bindPackageTreeDigestToCutPlan(plannedCutImport, immutablePackageTreeSha256);
  if (!plannedCutImport.ok || plannedCutImport.mode !== "rendered_media") {
    throw new Error("Template-to-Cut P2A accepted delivery requires a valid rendered-media Browser-to-Cut plan.");
  }
  const renderRequired = true;
  assertP2AClosedTreeCapacity(admittedPackage, true);
  const previewLane: "browser" = "browser";
  const previewAtMs = pkg.template?.metadata?.qualityTargets?.representativeFramesMs[0] ?? 0;
  const delivery = await createPrivateConnectorDelivery(outDir);
  const stagedPackageDir = delivery.stagePath(packageDir);
  const stagedTemplateApplyReceiptPath = delivery.stagePath(templateApplyReceiptPath);
  const stagedRenderReceiptPath = delivery.stagePath(renderReceiptPath);
  const stagedArtifactHandlePath = delivery.stagePath(artifactHandlePath);
  const stagedCutPlanPath = delivery.stagePath(cutPlanPath);
  const stagedConnectorReceiptPath = delivery.stagePath(connectorReceiptPath);

  try {
    // Every durable connector member is produced below the one private Core stage. Public paths
    // are used inside receipts and plans from the start, so the final tree has no stage locator to
    // scrub after rename.
    await publishAdmittedPackageTree(admittedPackage, stagedPackageDir);
    throwIfConnectorAborted(input.signal, "after Template-to-Cut package staging");
    const templateReceipt = createTemplateApplyReceipt({
      packageId: sourcePackage.manifest.id,
      sourcePackage,
      values: input.values,
      packageDir,
      receiptPath: templateApplyReceiptPath,
      changedParams: applied.changedParams,
      changedBindings: applied.changedBindings,
      warnings: applied.warnings,
      createdAt
    });
    await writeDeliveryJson(delivery, stagedTemplateApplyReceiptPath, templateReceipt, true);
    throwIfConnectorAborted(input.signal, "after Template-to-Cut template application");

    const previewPath = join(outDir, "preview", `${previewLane}-${previewAtMs}.png`);
    const stagedPreviewPath = delivery.stagePath(previewPath);
    const previewReceiptPath = join(receiptDir, `${previewLane}-preview.receipt.json`);
    const stagedPreviewReceiptPath = delivery.stagePath(previewReceiptPath);

    // The public Browser still-frame API has no AbortSignal parameter. Check immediately on
    // both sides so a completed preview cannot advance a cancelled P2A transaction.
    throwIfConnectorAborted(input.signal, "before Template-to-Cut browser preview");
    const preview = await renderTemplateBrowserPreview({ pkg, previewPath: stagedPreviewPath, atMs: previewAtMs, createdAt });
    throwIfConnectorAborted(input.signal, "after Template-to-Cut browser preview");
    if (!preview.ok) {
      await removeKnownEmptyPrivateDirectory(dirname(stagedPreviewPath), "preview failure");
      throw new Error("Template-to-Cut accepted delivery requires a successful immutable browser preview.");
    }
    assertBrowserPreviewPackageTreeDigest(preview.receipt, immutablePackageTreeSha256);
    const previewReceipt = remapPrivateDeliveryPaths(preview.receipt, delivery);
    bindPackageTreeDigestToReceipt(previewReceipt, immutablePackageTreeSha256);
    await writeDeliveryJson(delivery, stagedPreviewReceiptPath, previewReceipt, true);
    const previewEvidence = await captureReceiptBoundDeliveryLeaf({
      delivery,
      publicPath: previewPath,
      receipt: previewReceipt,
      label: "Template-to-Cut preview frame"
    });

    const renderOutputPath = join(outDir, "render", `${pkg.manifest.id}.mp4`);
    const stagedRenderOutputPath = delivery.stagePath(renderOutputPath);
    const operationHash = connectorArtifactOperationHash({ packageId: pkg.manifest.id, motionId: pkg.motion.id, preset: "mp4-h264", plan: plannedCutImport });
    throwIfConnectorAborted(input.signal, "before Template-to-Cut final rendering");
    const renderResult = await renderConnectorStreamingArtifact({
      pkg,
      outputPath: stagedRenderOutputPath,
      frameLane,
      signal: input.signal,
      now: () => createdAt
    });
    throwIfConnectorAborted(input.signal, "after Template-to-Cut final rendering");
    if (renderResult.frameLane !== "browser") {
      throw new Error("Template-to-Cut P2A accepted delivery requires Browser frames for its Browser-to-FFmpeg final render.");
    }
    if (renderResult.receipt.status === "failed") {
      await removeKnownEmptyPrivateDirectory(dirname(stagedRenderOutputPath), "render failure");
      throw new Error("Template-to-Cut accepted delivery requires a successful immutable browser final render.");
    }
    assertBrowserStreamingPackageTreeDigest(renderResult.receipt, immutablePackageTreeSha256);
    const renderReceipt = remapPrivateDeliveryPaths(renderResult.receipt, delivery);
    renderReceipt.inputHashes = { ...renderReceipt.inputHashes, operation: operationHash };
    bindPackageTreeDigestToReceipt(renderReceipt, immutablePackageTreeSha256);
    if (renderReceipt.status !== "failed") {
      // H must verify this one receipt against both the private stage and the post-rename root.
      // A root-relative locator is canonical in that verification domain; the result and F retain
      // their established public render path separately.
      setReceiptOutputPath(renderReceipt, relative(outDir, renderOutputPath).split(sep).join("/"));
    }
    const renderOk = renderReceipt.status !== "failed";
    await writeDeliveryJson(delivery, stagedRenderReceiptPath, renderReceipt, true);
    // P2A commits through Core's exact-tree ceiling. Refuse this route before it constructs a
    // successful F candidate when an encoded media leaf cannot be represented by that contract.
    const admittedRenderedMedia = renderOk
      ? await readBoundedStableFile(stagedRenderOutputPath, {
          label: "Template-to-Cut accepted rendered media",
          maxBytes: TEMPLATE_CLOSED_DELIVERY_MAX_MEDIA_BYTES,
          withinRoot: delivery.stagingRoot,
          requireSingleLink: true
        })
      : undefined;
    let cutPlan = plannedCutImport;

    const warnings = remapPrivateDeliveryPaths(
      [...applied.warnings, ...preview.warnings, ...renderReceipt.warnings, ...cutPlan.receipt.warnings],
      delivery
    );
    const previewFailureFatal = false;
    const artifacts = templateToCutArtifacts({
      packageDir,
      templateApplyReceiptPath,
      previewPath,
      previewOk: preview.ok,
      previewReceiptPath,
      renderRequired,
      renderDryRun: false,
      renderOk,
      renderOutputPath,
      renderReceiptPath,
      cutPlanPath,
      connectorReceiptPath,
      artifactHandlePath: renderOk ? artifactHandlePath : undefined
    });
    // F is a private staged candidate. It has no accepted/public authority until Core publishes
    // the exact complete root after H and C have been assembled and cross-checked.
    const connectorReceipt = createConnectorReceipt({
      packageId: pkg.manifest.id,
      createdAt,
      sourcePackage,
      admittedSource: admittedSource.evidence,
      admittedPackage: admittedPackage.evidence,
      values: input.values,
      packageDir,
      changedParams: applied.changedParams,
      changedBindings: applied.changedBindings,
      templateApplyReceiptPath,
      previewOk: preview.ok,
      previewFailureFatal,
      previewLane,
      previewAtMs,
      previewReceiptPath,
      renderOk,
      renderReceiptPath,
      renderRequired,
      renderDryRun: false,
      renderFrameLane: renderResult.frameLane,
      renderOutputPath,
      cutOk: cutPlan.ok,
      cutMode: cutPlan.mode,
      cutPlanPath,
      artifacts,
      warnings,
      operationHash
    });
    bindPackageTreeDigestToReceipt(connectorReceipt, immutablePackageTreeSha256);
    await writeDeliveryJson(delivery, stagedConnectorReceiptPath, connectorReceipt, true);
    throwIfConnectorAborted(input.signal, "before Template-to-Cut artifact finalization");

    let finalizedArtifact: Awaited<ReturnType<typeof finalizeConnectorArtifactHandle>> | undefined;
    if (renderOk) {
      const finalized = await finalizeConnectorArtifactHandle({
        root: delivery.stagingRoot,
        descriptorPath: stagedArtifactHandlePath,
        artifactPath: stagedRenderOutputPath,
        renderReceiptPath: stagedRenderReceiptPath,
        connectorReceiptPath: stagedConnectorReceiptPath,
        pkg,
        operationHash,
        preset: "mp4-h264",
        mediaType: "video/mp4",
        createdAt,
        maxBytes: TEMPLATE_CLOSED_DELIVERY_MAX_MEDIA_BYTES
      });
      if (finalized.handle.sha256 !== admittedRenderedMedia?.sha256 || finalized.handle.byteLength !== admittedRenderedMedia.byteLength) {
        throw new Error("Template-to-Cut artifact handle no longer matches the bounded rendered-media admission.");
      }
      finalizedArtifact = finalized;
      cutPlan = attachRenderedMediaToCutPlan(plannedCutImport, { dryRun: false, handle: finalized.reference });
      bindPackageTreeDigestToCutPlan(cutPlan, immutablePackageTreeSha256);
      if (!cutPlan.ok || cutPlan.mode !== "rendered_media") {
        throw new Error("Template-to-Cut P2A accepted delivery requires an attached valid rendered-media Browser-to-Cut plan.");
      }
    }
    throwIfConnectorAborted(input.signal, "after Template-to-Cut artifact finalization");
    await writeDeliveryJson(delivery, stagedCutPlanPath, cutPlan, true);

    await assertTemplateAcceptedDeliveryCandidate({
      delivery,
      sourcePackageRoot,
      artifacts,
      connectorReceipt,
      stagedConnectorReceiptPath,
      renderReceipt,
      stagedRenderReceiptPath,
      cutPlan,
      finalizedArtifact,
      stagedArtifactHandlePath,
      stagedRenderOutputPath,
      immutablePackageTreeSha256,
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      operationHash
    });
    const expectedInventory = await templateDeliveryExpectedInventory({
      delivery,
      admittedPackage,
      templateApplyReceiptPath,
      templateReceipt,
      previewReceiptPath,
      previewReceipt,
      previewEvidence,
      renderReceiptPath,
      renderReceipt,
      artifact: finalizedArtifact,
      cutPlanPath,
      cutPlan,
      connectorReceiptPath,
      connectorReceipt
    });
    throwIfConnectorAborted(input.signal, "after Template-to-Cut validation and before delivery commit");
    const result: TemplateToCutConnectorResult = {
      ok: true,
      packageDir,
      template: {
        changedParams: applied.changedParams,
        changedBindings: applied.changedBindings,
        receiptPath: templateApplyReceiptPath
      },
      preview: {
        ok: true,
        lane: previewLane,
        atMs: previewAtMs,
        failureFatal: previewFailureFatal,
        receiptPath: previewReceiptPath,
        outputPath: previewPath
      },
      render: {
        ok: true,
        required: true,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: renderResult.frameLane,
        receiptPath: renderReceiptPath,
        outputPath: renderOutputPath
      },
      cutPlanPath,
      artifacts,
      receiptPath: connectorReceiptPath,
      warnings
    };
    // All output objects have to be final before the one public rename.  No fallible validation
    // occurs after `commit`: Core alone owns the typed post-rename uncertainty boundary.
    assertNoPrivateDeliveryPath({ result, templateReceipt, previewReceipt, renderReceipt, connectorReceipt, cutPlan }, delivery);
    throwIfConnectorAborted(input.signal, "before Template-to-Cut delivery commit");
    await delivery.commit(expectedInventory);
    return result;
  } catch (error) {
    await delivery.abort();
    throw error;
  }
}

async function renderTemplateBrowserPreview(input: {
  pkg: MotionPackage;
  previewPath: string;
  atMs: number;
  createdAt: string;
}): Promise<{
  ok: boolean;
  frame: { path: string };
  receipt: OperationReceipt;
  warnings: string[];
}> {
  try {
    const result = await renderMotionBrowserFrame(input.pkg, {
      outDir: dirname(input.previewPath),
      outputPath: input.previewPath,
      atMs: input.atMs,
      now: () => input.createdAt
    });
    return {
      ok: true,
      frame: { path: result.output.path },
      receipt: result.receipt,
      warnings: result.receipt.warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      frame: { path: input.previewPath },
      receipt: {
        schema: "shellx-motion/receipt@1",
        id: `browser-preview-failed-${hashBuffer(Buffer.from(`${input.pkg.manifest.id}:${input.atMs}:${message}`)).slice(0, 16)}`,
        operation: "preview.frame",
        status: "failed",
        packageId: input.pkg.manifest.id,
        inputHashes: { motion: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")) },
        createdAt: input.createdAt,
        lane: "browser",
        output: { path: input.previewPath, atMs: input.atMs, error: message },
        warnings: [message]
      },
      warnings: [message]
    };
  }
}

function createTemplateApplyReceipt(input: {
  packageId: string;
  sourcePackage: MotionPackage;
  values: Record<string, TemplateValue>;
  packageDir: string;
  receiptPath: string;
  changedParams: string[];
  changedBindings: TemplateChangedBinding[];
  warnings: string[];
  createdAt: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `template-apply-${hashBuffer(Buffer.from(`${input.packageId}:${JSON.stringify(input.changedBindings)}`, "utf8")).slice(0, 16)}`,
    operation: "template.apply",
    // The connector's copy of the CLI's template-apply receipt, and it has to answer the same way:
    // a binding the engine declined to apply is an ignored declaration, not a pass.
    status: escalateReceiptStatusForWarnings("passed", input.warnings),
    packageId: input.packageId,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.motion), "utf8")),
      template: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.template ?? null), "utf8")),
      updates: hashBuffer(Buffer.from(JSON.stringify(input.values), "utf8"))
    },
    createdAt: input.createdAt,
    lane: "template",
    output: {
      packageDir: input.packageDir,
      changedParams: input.changedParams,
      changedBindings: input.changedBindings
    },
    artifacts: [
      { role: "motion_package", path: input.packageDir, status: "available", primary: true },
      { role: "template_apply_receipt", path: input.receiptPath, status: "available", mediaType: "application/json" }
    ],
    warnings: input.warnings
  };
}

function templateToCutArtifacts(input: {
  packageDir: string;
  templateApplyReceiptPath: string;
  previewPath: string;
  previewOk: boolean;
  previewReceiptPath: string;
  renderRequired: boolean;
  renderDryRun: boolean;
  renderOk: boolean;
  renderOutputPath: string;
  renderReceiptPath: string;
  cutPlanPath: string;
  connectorReceiptPath: string;
  artifactHandlePath?: string;
}): ConnectorArtifact[] {
  const artifacts: ConnectorArtifact[] = [
    { role: "motion_package", path: input.packageDir, status: "available" },
    { role: "template_apply_receipt", path: input.templateApplyReceiptPath, status: "available", mediaType: "application/json" },
    { role: "preview_frame", path: input.previewPath, status: input.previewOk ? "available" : "planned", mediaType: "image/png" },
    { role: "preview_receipt", path: input.previewReceiptPath, status: "available" },
    { role: "render_receipt", path: input.renderReceiptPath, status: "available" },
    { role: "cut_plan", path: input.cutPlanPath, status: "available", primary: !input.renderRequired },
    { role: "connector_receipt", path: input.connectorReceiptPath, status: "available" }
  ];
  if (input.renderRequired) {
    artifacts.splice(5, 0, {
      role: "rendered_media",
      path: input.renderOutputPath,
      status: !input.renderOk ? "failed" : input.renderDryRun ? "planned" : "available",
      mediaType: "video/mp4",
      primary: true
    });
  }
  if (input.artifactHandlePath) {
    artifacts.push({ role: "artifact_handle", path: input.artifactHandlePath, status: "available", mediaType: "application/vnd.shellx-motion.artifact-handle+json" });
  }
  return artifacts;
}

function createConnectorReceipt(input: {
  packageId: string;
  createdAt: string;
  sourcePackage: MotionPackage;
  admittedSource: AdmittedPackageTreeEvidence;
  admittedPackage: AdmittedPackageTreeEvidence;
  values: Record<string, TemplateValue>;
  packageDir: string;
  changedParams: string[];
  changedBindings: TemplateChangedBinding[];
  templateApplyReceiptPath: string;
  previewOk: boolean;
  previewFailureFatal: boolean;
  previewLane: "browser";
  previewAtMs: number;
  previewReceiptPath: string;
  renderOk: boolean;
  renderReceiptPath: string;
  renderRequired: boolean;
  renderDryRun: boolean;
  renderFrameLane: "browser";
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
    id: `connector-template-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.template_to_cut",
    status: connectorReceiptStatus({ failed: input.previewFailureFatal || !input.cutOk || !input.renderOk, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: {
      motion: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.motion), "utf8")),
      template: hashBuffer(Buffer.from(JSON.stringify(input.sourcePackage.template ?? null), "utf8")),
      updates: hashBuffer(Buffer.from(JSON.stringify(input.values), "utf8")),
      templateSourceTree: input.admittedSource.sha256,
      templatePublishedTree: input.admittedPackage.sha256,
      "admitted-package-tree": input.admittedPackage.sha256,
      operation: input.operationHash
    },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      artifacts: input.artifacts,
      template: {
        sourceTree: input.admittedSource,
        publishedTree: input.admittedPackage,
        changedParams: input.changedParams,
        changedBindings: input.changedBindings,
        receiptPath: input.templateApplyReceiptPath
      },
      packageDir: input.packageDir,
      preview: { ok: input.previewOk, lane: input.previewLane, atMs: input.previewAtMs, failureFatal: input.previewFailureFatal, receiptPath: input.previewReceiptPath },
      render: {
        ok: input.renderOk,
        required: input.renderRequired,
        dryRun: input.renderRequired ? input.renderDryRun : true,
        lane: "ffmpeg",
        frameLane: input.renderFrameLane,
        receiptPath: input.renderReceiptPath,
        ...(input.renderOutputPath ? { outputPath: input.renderOutputPath } : {}),
      },
      cut: { ok: input.cutOk, mode: input.cutMode, planPath: input.cutPlanPath }
    },
    warnings: input.warnings
  };
}
