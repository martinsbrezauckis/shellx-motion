import {
  canvasFixtureContract,
  CanvasFixtureError,
  convertCanvasFrameToMotionPackage,
  writeCanvasMotionPackage
} from "@shellx-motion/adapters-canvas";
import {
  runCanvasBridgeFrameSelectionExport,
  runCanvasMp4Export,
  readCutImportModeRequest,
  runCutGenerateToCutConnector,
  runTemplateToCutConnector
} from "@shellx-motion/connectors";
import { applyReceiptActor, hashBuffer, isPublicationCommitUncertain, motionCapabilityCatalog, type OperationReceipt, type PublicationCommitUncertainError } from "@shellx-motion/core";
import { readFfmpegExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import { dirname, join } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, positiveNumberArg, recordArg, scalarRecordArg, stringArg, stringArrayArg } from "./args.js";
import { dispatchBrowserWorkflowCommand } from "./integration-browser-workflow.js";
import {
  AuthoringRootPolicyError,
  assertConfiguredAuthoringInputFile,
  assertConfiguredAuthoringInputRoot,
  assertConfiguredAuthoringOutputFile,
  assertConfiguredAuthoringOutputRoot,
  configuredAuthoringInputRoot
} from "./authoring-root-policy.js";
import { connectorStreamingServices, type IntegrationDomainServices as IntegrationServices } from "./integration-services.js";
import { connectorException, connectorResult } from "./integration-connector-observer.js";
import { dispatchP2bConnectorCommand } from "./integration-p2b-connector.js";

export async function dispatchIntegrationCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: IntegrationServices = {}
): Promise<MotionDebugResult | null> {
  if (command === "motion.connector.catalog") {
    const catalog = motionCapabilityCatalog();
    return {
      ok: true,
      visibleState: {
        panel: "connector",
        operation: "connector.catalog",
        catalogSchema: catalog.schema,
        catalogFingerprint: catalog.fingerprint,
        descriptorCount: catalog.descriptors.length
      },
      result: { ok: true, catalog },
      warnings: []
    };
  }
  if (command === "motion.connector.submit") {
    if (!services.submitCoordinatedConnector) return capabilityUnavailable("Persistent generic connector submission is unavailable on this host.");
    return await services.submitCoordinatedConnector(args);
  }
  const browserWorkflowResult = await dispatchBrowserWorkflowCommand(command, args, services);
  if (browserWorkflowResult) return browserWorkflowResult;
  const p2bConnectorResult = await dispatchP2bConnectorCommand(command, args, services);
  if (p2bConnectorResult) return p2bConnectorResult;
  if (command === "motion.connector.panel") {
    const panel = buildConnectorPanel();
    const receiptId = `connector-panel-${hashBuffer(Buffer.from(JSON.stringify(panel), "utf8")).slice(0, 16)}`;
    return {
      ok: true,
      receiptId,
      visibleState: {
        panel: "connector",
        operation: "connector.panel",
        connectorCount: panel.counts.connectors,
        canvasConnectorCount: panel.counts.canvasConnectors,
        cutConnectorCount: panel.counts.cutConnectors,
        independentExportCount: panel.counts.independentExports,
        renderedMediaCount: panel.counts.renderedMedia,
        qualityGateCount: panel.counts.qualityGated,
        warningCount: panel.warnings.length
      },
      result: { ok: true, ...panel },
      warnings: panel.warnings
    };
  }
  if (command === "motion.canvas.package") {
    const canvasSelectionPath = stringArg(args, "canvasSelectionPath");
    const selectionInline = recordArg(args, "selection") ?? recordArg(args, "canvasSelection");
    const packageDir = stringArg(args, "packageDir") ?? stringArg(args, "outDir");
    const selectedFrameId = stringArg(args, "selectedFrameId") ?? undefined;
    const explicitSourceRoot = stringArg(args, "sourceRoot") ?? undefined;
    const createdAt = stringArg(args, "createdAt") ?? undefined; const createdBy = stringArg(args, "createdBy") ?? undefined;
    const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
    if (!canvasSelectionPath && !selectionInline) return invalidArgs("motion.canvas.package requires canvasSelectionPath or selection.");
    if (!packageDir) return invalidArgs("motion.canvas.package requires packageDir.");
    if (!services.authoringOutputRoots?.length) return capabilityUnavailable("Canvas package requires a configured host-approved authoring output root.");
    if (canvasSelectionPath && !services.readJson) return capabilityUnavailable("Canvas selection file reading is unavailable.");
    if (canvasSelectionPath && !services.authoringInputRoots?.length) return capabilityUnavailable("Canvas selection requires configured host-approved authoring input roots.");
    try {
      await assertConfiguredAuthoringOutputRoot(packageDir, services.authoringOutputRoots, "Canvas package output");
      let canvasSelectionRoot: string | undefined;
      if (canvasSelectionPath) {
        await assertConfiguredAuthoringInputFile(canvasSelectionPath, services.authoringInputRoots, "Canvas selection source");
        canvasSelectionRoot = configuredAuthoringInputRoot(canvasSelectionPath, services.authoringInputRoots, "Canvas selection source");
      }
      const selection = selectionInline ?? await services.readJson!(canvasSelectionPath!, canvasSelectionRoot);
      const inputPath = selectionInline ? "inline-canvas-selection.json" : canvasSelectionPath!;
      const canvasExport = convertCanvasFrameToMotionPackage(selection, {
        ...(selectedFrameId ? { selectedFrameId } : {}), ...(createdAt ? { createdAt } : {}),
        ...(createdBy ? { createdBy } : {}),
        inputPath
      });
      const sourceRoot = explicitSourceRoot ?? (canvasSelectionPath ? dirname(canvasSelectionPath) : undefined);
      if (canvasExport.manifest.assets.length > 0) {
        if (selectionInline && !explicitSourceRoot) return invalidArgs("Inline Canvas selections with declared assets require an explicit sourceRoot.");
        if (!services.authoringInputRoots?.length) return capabilityUnavailable("Canvas assets require configured host-approved authoring input roots.");
        if (!sourceRoot) return invalidArgs("Canvas package assets require an explicit sourceRoot.");
        await assertConfiguredAuthoringInputRoot(sourceRoot, services.authoringInputRoots, "Canvas asset source");
      }
      const preparedReceipt = applyReceiptActor(canvasExport.receipt, services.receiptActor);
      const written = await writeCanvasMotionPackage(canvasExport, { packageDir, ...(sourceRoot ? { sourceRoot } : {}), receipt: preparedReceipt });
      const receipt = written.receipt;
      const hostReceipt = receiptsRoot ? await mirrorCanvasPackageReceipt(services, receiptsRoot, receipt) : undefined;
      const warnings = [...(hostReceipt?.warning ? [hostReceipt.warning] : [])];
      return {
        ok: true,
        receiptId: receipt.id,
        visibleState: {
          panel: "receipts",
          operation: "canvas.package",
          packageId: canvasExport.manifest.id,
          packageDir: written.packageDir,
          resourceCatalogPath: written.resourceCatalogPath,
          ...(hostReceipt?.path ? { hostReceiptPath: hostReceipt.path } : {})
        },
        result: {
          ok: true,
          packageId: canvasExport.manifest.id,
          motionId: canvasExport.motion.id,
          selectedFrameId: canvasExport.manifest.selectedFrameId,
          packageDir: written.packageDir,
          manifestPath: written.manifestPath,
          motionPath: written.motionPath,
          receiptPath: written.receiptPath,
          resourceCatalogPath: written.resourceCatalogPath,
          assetRefs: written.assetRefs,
          copiedAssetRefs: written.copiedAssetRefs,
          missingAssetRefs: written.missingAssetRefs,
          assetEvidence: written.assetEvidence,
          ...(hostReceipt?.path ? { hostReceiptPath: hostReceipt.path } : {}),
          ...(hostReceipt?.warning ? { hostReceipt: { status: "mirror_failed", message: hostReceipt.warning } } : {})
        },
        warnings
      };
    } catch (error) {
      if (error instanceof AuthoringRootPolicyError) return invalidArgs(error.message);
      if (isPublicationCommitUncertain(error)) return canvasPackageCommitUncertain(error);
      return canvasPackageFailure(error);
    }
  }
  if (command === "motion.connector.canvas_to_mp4") {
    const canvasSelectionPath = stringArg(args, "canvasSelectionPath");
    const outDir = stringArg(args, "outDir");
    const dryRunRender = booleanArg(args, "dryRunRender");
    const presetValue = stringArg(args, "preset") ?? "mp4-h264";
    if (!canvasSelectionPath) return invalidArgs("motion.connector.canvas_to_mp4 requires canvasSelectionPath.");
    if (!outDir) return invalidArgs("motion.connector.canvas_to_mp4 requires outDir.");
    const preset = readFfmpegExportPreset(presetValue);
    if (!preset) return invalidArgs(`Unsupported export preset: ${presetValue}.`);
    if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
      return capabilityUnavailable("Canvas-to-MP4 requires configured host-approved authoring input and output roots.");
    }
    if (!services.readReceipt) return capabilityUnavailable("Connector receipt verification is unavailable.");
    try {
      await assertConfiguredAuthoringInputFile(canvasSelectionPath, services.authoringInputRoots, "Canvas-to-MP4 canvas selection");
      await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots, "Canvas-to-MP4 output");
      const result = await runCanvasMp4Export({
        canvasSelectionPath,
        outDir,
        preset,
        dryRunRender: dryRunRender ?? false,
        ...connectorStreamingServices(services)
      });
      return await connectorResult(command, result, services, {
        panel: "receipts",
        operation: "connector.canvas_to_mp4",
        ok: result.ok,
        renderPath: result.render.outputPath,
        receiptPath: result.receiptPath
      });
    } catch (error) {
      return connectorException(error);
    }
  }

  if (command === "motion.canvas.bridge_export") {
    const canvasRoot = stringArg(args, "canvasRoot");
    const outPath = stringArg(args, "outPath") ?? stringArg(args, "path");
    const target = stringArg(args, "target") ?? undefined;
    const projectName = stringArg(args, "projectName") ?? undefined;
    const frameName = stringArg(args, "frameName") ?? undefined;
    const selectedIds = stringArrayArg(args, "selectedIds") ?? undefined;
    const generatedAt = stringArg(args, "generatedAt") ?? undefined;
    const durationMs = positiveNumberArg(args, "durationMs");
    const fps = positiveNumberArg(args, "fps");
    if (!canvasRoot) return invalidArgs("motion.canvas.bridge_export requires canvasRoot.");
    if (!outPath) return invalidArgs("motion.canvas.bridge_export requires outPath.");
    if (durationMs === false) return invalidArgs("motion.canvas.bridge_export durationMs must be a positive number.");
    if (fps === false) return invalidArgs("motion.canvas.bridge_export fps must be a positive number.");
    if (!services.authoringOutputRoots?.length) {
      return capabilityUnavailable("Canvas bridge export requires a configured host-approved authoring output root.");
    }
    if (!services.readReceipt) return capabilityUnavailable("Canvas bridge receipt verification is unavailable.");
    try {
      await assertConfiguredAuthoringOutputFile(outPath, services.authoringOutputRoots, "Canvas bridge export output");
      const result = await runCanvasBridgeFrameSelectionExport({
        canvasRoot,
        outPath,
        ...(target ? { target } : {}),
        ...(projectName ? { projectName } : {}),
        ...(frameName ? { frameName } : {}),
        ...(selectedIds ? { selectedIds } : {}),
        ...(generatedAt ? { generatedAt } : {}),
        ...(typeof durationMs === "number" ? { durationMs } : {}),
        ...(typeof fps === "number" ? { fps } : {})
      });
      if (!result.ok) return { ok: false, error: result.error, warnings: [] };
      const receipt = await services.readReceipt(result.receiptPath);
      const hostReceiptPath = services.receiptsRoot && receipt
        ? await persistReceipt(services, services.receiptsRoot, receipt)
        : undefined;
      return {
        ok: true,
        ...(receipt ? { receiptId: receipt.id } : {}),
        visibleState: {
          panel: "receipts",
          operation: "canvas.bridge_export",
          ok: true,
          path: result.path,
          receiptPath: result.receiptPath,
          ...(hostReceiptPath ? { hostReceiptPath } : {})
        },
        result: { ...result, ...(hostReceiptPath ? { hostReceiptPath } : {}) },
        warnings: []
      };
    } catch (error) {
      if (error instanceof AuthoringRootPolicyError) return invalidArgs(error.message);
      return {
        ok: false,
        error: { code: "canvas_bridge_export_failed", message: error instanceof Error ? error.message : String(error) },
        warnings: []
      };
    }
  }

  if (command === "motion.connector.template_to_cut") {
    const packageRoot = stringArg(args, "packageRoot");
    const outDir = stringArg(args, "outDir");
    const values = scalarRecordArg(args, "values");
    const modeArg = stringArg(args, "cutImportMode");
    if (!packageRoot) return invalidArgs("motion.connector.template_to_cut requires packageRoot.");
    if (!outDir) return invalidArgs("motion.connector.template_to_cut requires outDir.");
    if (!values) return invalidArgs("motion.connector.template_to_cut requires values.");
    if (modeArg !== undefined && modeArg !== "rendered_media") return invalidArgs("motion.connector.template_to_cut accepts only cutImportMode rendered_media in P2A.");
    if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
      return capabilityUnavailable("Template-to-Cut requires configured host-approved authoring input and output roots.");
    }
    if (!services.readReceipt) return capabilityUnavailable("Connector receipt verification is unavailable.");
    try {
      await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, "Template-to-Cut packageRoot");
      await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots, "Template-to-Cut output");
      const result = await runTemplateToCutConnector({
        packageRoot,
        outDir,
        values
      });
      return await connectorResult(command, result, services, {
        panel: "receipts",
        operation: "connector.template_to_cut",
        ok: result.ok,
        cutPlanPath: result.cutPlanPath,
        receiptPath: result.receiptPath
      }, {}, { atomic: true });
    } catch (error) {
      return connectorException(error);
    }
  }

  if (command === "motion.connector.cut_generate_to_cut") {
    const scriptPathArg = stringArg(args, "scriptPath");
    const inlineScript = recordArg(args, "script");
    const storyboard = recordArg(args, "storyboard");
    const outDir = stringArg(args, "outDir");
    const modeArg = stringArg(args, "cutImportMode");
    const dryRunRender = booleanArg(args, "dryRunRender");
    const createdAt = stringArg(args, "createdAt") ?? undefined;
    if (inputSourceCount(scriptPathArg, inlineScript, storyboard) !== 1) return invalidArgs("motion.connector.cut_generate_to_cut requires exactly one input source: scriptPath, script, or storyboard.");
    if (!outDir) return invalidArgs("motion.connector.cut_generate_to_cut requires outDir.");
    const cutImportMode = modeArg ? readCutImportModeRequest(modeArg) : undefined;
    if (modeArg && !cutImportMode) return invalidArgs(`Unsupported Cut import mode: ${modeArg}.`);
    if (!services.authoringOutputRoots?.length) {
      return capabilityUnavailable("Cut Generate-to-Cut requires a configured host-approved authoring output root.");
    }
    if (scriptPathArg && !services.authoringInputRoots?.length) {
      return capabilityUnavailable("Cut Generate-to-Cut scriptPath requires a configured host-approved authoring input root.");
    }
    try {
      await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots, "Cut Generate-to-Cut output");
      if (scriptPathArg) {
        await assertConfiguredAuthoringInputFile(scriptPathArg, services.authoringInputRoots, "Cut Generate-to-Cut scriptPath");
      }
      const scriptInline = inlineScript ?? storyboard;
      const result = await runCutGenerateToCutConnector({
        ...(scriptPathArg ? { scriptPath: scriptPathArg } : { script: scriptInline! }),
        outDir,
        ...(cutImportMode ? { cutImportMode } : {}),
        dryRunRender: dryRunRender ?? false,
        ...(createdAt ? { now: () => createdAt } : {}),
        ...connectorStreamingServices(services)
      });
      return await connectorResult(command, result, services, {
        panel: "receipts",
        operation: "connector.cut_generate_to_cut",
        ok: result.ok,
        ...(scriptPathArg ? { scriptPath: scriptPathArg } : { scriptInput: "inline" }),
        packageDir: result.packageDir,
        ...(result.preview.outputPath ? { previewFramePath: result.preview.outputPath } : {}),
        ...(result.render.outputPath ? { renderedMediaPath: result.render.outputPath } : {}),
        cutPlanPath: result.cutPlanPath,
        receiptPath: result.receiptPath
      }, scriptPathArg ? { scriptPath: scriptPathArg } : { scriptInput: "inline" });
    } catch (error) {
      return connectorException(error);
    }
  }

  // motion.cut.map_import / motion.cut.apply_import were REMOVED in 0.1.0.
  //
  // They ran `cargo run --manifest-path <cutRoot>/app/Cargo.toml -p server --bin cutd` -- Motion
  // compiling ShellX Cut from a caller-supplied checkout and invoking it. That inverts the one rule
  // this engine is built on: Motion is always the CALLEE. Cut, Design Studio, an agent or a human
  // calls Motion to render; Motion hands back artifacts and receipts and does not reach outward.
  //
  // An unvalidated `cutRoot` is an execution boundary: `cargo build` executes
  // build.rs and every proc-macro in the crate graph, so `write_local` -- a FILE-WRITE tier -- became
  // code execution. A trusted-root fence was drafted and discarded: guarding a capability that should
  // not exist is worse than deleting it.
  //
  // Producing a Cut import plan is unchanged and is the supported path.
  return null;
}

async function persistReceipt(
  services: IntegrationServices,
  root: string,
  receipt: OperationReceipt
): Promise<string> {
  if (!services.writeReceipt) throw new Error("Receipt persistence capability is unavailable");
  return services.writeReceipt(root, receipt);
}

/**
 * Turn a rejected Canvas import into one answer an agent can act on without guessing.
 *
 * A structural rejection carries EVERY problem the parser found (`result.problems`, each with the
 * path, the requirement it failed, and the exact correction where one exists) plus the accepted
 * contract itself — schema ids, required fields per level, the layer kinds a render lane can
 * consume, and a minimal example that converts. Before this, the command answered with one field
 * per call and published no contract, so learning the document shape took thirteen round trips.
 *
 * Non-structural failures (a missing selected frame, a bad integration envelope) keep the plain
 * message; there is nothing to enumerate and the contract would be noise.
 *
 * @param error whatever `convertCanvasFrameToMotionPackage` or the package writer threw.
 */
function canvasPackageFailure(error: unknown): MotionDebugResult {
  if (!(error instanceof CanvasFixtureError)) {
    return {
      ok: false,
      error: { code: "canvas_package_failed", message: error instanceof Error ? error.message : String(error) },
      warnings: []
    };
  }
  const contract = canvasFixtureContract();
  return {
    ok: false,
    error: {
      code: "canvas_fixture_invalid",
      message: error.message,
      suggestedAction: "Fix every entry in result.problems; result.contract holds the accepted schema ids, "
        + "required fields, layer kinds, and a minimal working example."
    },
    result: { valid: false, problemCount: error.problems.length, problems: error.problems, contract },
    warnings: []
  };
}

async function mirrorCanvasPackageReceipt(
  services: IntegrationServices,
  root: string,
  receipt: OperationReceipt
): Promise<{ path?: string; warning?: string }> {
  try {
    if (!services.writeReceipt) throw new Error("Receipt persistence capability is unavailable.");
    return { path: await services.writeReceipt(root, receipt) };
  } catch (error) {
    return { warning: `Canvas package committed, but host receipt mirror failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function canvasPackageCommitUncertain(error: PublicationCommitUncertainError): MotionDebugResult {
  const evidence = error.evidence;
  const detail = {
    possiblyCommitted: true,
    packageDir: evidence.publicPath,
    publicPaths: [evidence.publicPath],
    expectedClosedTree: evidence.expected,
    expectedPublications: [evidence]
  };
  return {
    ok: false,
    error: { code: "publication_commit_uncertain", message: error.message, detail },
    result: detail,
    warnings: []
  };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message }, warnings: [] };
}

function inputSourceCount(scriptPath: string | null, script: Record<string, unknown> | null, storyboard: Record<string, unknown> | null): number {
  return Number(Boolean(scriptPath)) + Number(Boolean(script)) + Number(Boolean(storyboard));
}

type ConnectorPanelCommand =
  | "motion.connector.canvas_to_mp4"
  | "motion.connector.canvas_to_cut"
  | "motion.connector.script_to_cut"
  | "motion.connector.source_to_cut"
  | "motion.connector.cut_generate_to_cut"
  | "motion.connector.template_to_cut";

interface ConnectorPanelRender {
  required: boolean | "conditional";
  dryRunSupported: boolean;
  defaultFrameLane: "browser";
  producesRenderedMedia: boolean;
  presets: MotionExportPreset[];
}

interface ConnectorPanelCutHandoff {
  supported: boolean;
  importModes?: Array<"rendered_media" | "live_overlay" | "editable_lowering">;
}

interface ConnectorPanelQualityGate {
  supported: boolean;
  defaultEnabled: boolean;
}

interface ConnectorPanelCard {
  id: "canvas_to_mp4" | "canvas_to_cut" | "script_to_cut" | "source_to_cut" | "cut_generate_to_cut" | "template_to_cut";
  command: ConnectorPanelCommand;
  label: string;
  sourceProduct: "shellx-canvas" | "shellx-cut" | "shellx-motion" | "scripted-video" | "imported-source";
  targetProduct: "shellx-canvas" | "shellx-cut";
  outputKind: "mp4" | "cut-import-plan";
  requiredInputs: string[];
  optionalInputs: string[];
  inputConstraint?: string;
  outputArtifacts: string[];
  receipts: string[];
  render: ConnectorPanelRender;
  cutHandoff: ConnectorPanelCutHandoff;
  qualityGate: ConnectorPanelQualityGate;
  surfaces: string[];
  templateDriven: boolean;
  requiresSourceImport: boolean;
}

interface ConnectorPanelSuggestedAction {
  id: "canvasMp4" | "canvasCut" | "scriptCut" | "sourceCut" | "cutGenerateCut" | "templateCut";
  command: ConnectorPanelCommand;
  requiredArgs: string[];
}

interface ConnectorPanel {
  counts: {
    connectors: number;
    canvasConnectors: number;
    cutConnectors: number;
    independentExports: number;
    renderedMedia: number;
    qualityGated: number;
    requiresSourceImport: number;
    templateDriven: number;
  };
  cards: ConnectorPanelCard[];
  suggestedActions: ConnectorPanelSuggestedAction[];
  warnings: string[];
}

const CONNECTOR_PANEL_CARDS: ConnectorPanelCard[] = [
  {
    id: "canvas_to_mp4",
    command: "motion.connector.canvas_to_mp4",
    label: "Canvas independent MP4 export",
    sourceProduct: "shellx-canvas",
    targetProduct: "shellx-canvas",
    outputKind: "mp4",
    requiredInputs: ["canvasSelectionPath", "outDir"],
    optionalInputs: ["preset", "dryRunRender"],
    outputArtifacts: ["motion_package", "rendered_media", "resource_catalog", "connector_receipt"],
    receipts: ["connector_receipt", "render_receipt", "quality_receipt"],
    render: { required: true, dryRunSupported: true, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264", "webm-vp9", "gif"] },
    cutHandoff: { supported: false },
    qualityGate: { supported: false, defaultEnabled: false },
    surfaces: ["shellx-canvas", "shellx-motion"],
    templateDriven: false,
    requiresSourceImport: false
  },
  {
    id: "canvas_to_cut",
    command: "motion.connector.canvas_to_cut",
    label: "Canvas frame to Cut timeline",
    sourceProduct: "shellx-canvas",
    targetProduct: "shellx-cut",
    outputKind: "cut-import-plan",
    requiredInputs: ["canvasSelectionPath", "outDir"],
    optionalInputs: ["cutImportMode"],
    outputArtifacts: ["motion_package", "preview_frame", "rendered_media", "artifact_handle", "cut_plan", "connector_receipt"],
    receipts: ["connector_receipt", "preview_receipt", "render_receipt", "cut_plan"],
    render: { required: true, dryRunSupported: false, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media"]
    },
    qualityGate: { supported: false, defaultEnabled: false },
    surfaces: ["shellx-canvas", "shellx-cut", "shellx-motion"],
    templateDriven: false,
    requiresSourceImport: false
  },
  {
    id: "script_to_cut",
    command: "motion.connector.script_to_cut",
    label: "Scripted-video JSON to Cut",
    sourceProduct: "scripted-video",
    targetProduct: "shellx-cut",
    outputKind: "cut-import-plan",
    requiredInputs: ["outDir"],
    optionalInputs: ["scriptPath", "script", "storyboard", "cutImportMode", "startMs", "durationMs", "track"],
    inputConstraint: "Exactly one of scriptPath, script, or storyboard is required.",
    outputArtifacts: ["motion_package", "preview_frame", "rendered_media", "artifact_handle", "cut_plan", "connector_receipt"],
    receipts: ["connector_receipt", "preview_receipt", "render_receipt", "cut_plan"],
    render: { required: true, dryRunSupported: false, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media"]
    },
    qualityGate: { supported: false, defaultEnabled: false },
    surfaces: ["shellx-cut", "shellx-motion"],
    templateDriven: false,
    requiresSourceImport: false
  },
  {
    id: "source_to_cut",
    command: "motion.connector.source_to_cut",
    label: "Imported source Markdown to Cut",
    sourceProduct: "imported-source",
    targetProduct: "shellx-cut",
    outputKind: "cut-import-plan",
    requiredInputs: ["sourcePath", "outDir"],
    optionalInputs: ["maxFrames", "frameDurationMs", "width", "height", "fps", "cutImportMode"],
    outputArtifacts: ["storyboard", "motion_package", "preview_frame", "rendered_media", "artifact_handle", "cut_plan", "source_to_cut_receipt"],
    receipts: ["source_to_cut_receipt", "source_storyboard_receipt", "preview_receipt", "render_receipt", "cut_plan"],
    render: { required: true, dryRunSupported: false, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media"]
    },
    qualityGate: { supported: false, defaultEnabled: false },
    surfaces: ["shellx-cut", "shellx-motion"],
    templateDriven: false,
    requiresSourceImport: true
  },
  {
    id: "cut_generate_to_cut",
    command: "motion.connector.cut_generate_to_cut",
    label: "Cut Generate scripted video to Cut",
    sourceProduct: "shellx-cut",
    targetProduct: "shellx-cut",
    outputKind: "cut-import-plan",
    requiredInputs: ["scriptPath", "outDir"],
    optionalInputs: ["script", "storyboard", "cutImportMode", "dryRunRender", "createdAt"],
    outputArtifacts: ["scripted_video", "motion_package", "rendered_media", "cut_plan", "connector_receipt"],
    receipts: ["connector_receipt", "render_receipt", "quality_receipt", "cut_plan"],
    render: { required: true, dryRunSupported: true, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264", "webm-vp9"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media"]
    },
    qualityGate: { supported: true, defaultEnabled: true },
    surfaces: ["shellx-cut", "shellx-motion"],
    templateDriven: false,
    requiresSourceImport: false
  },
  {
    id: "template_to_cut",
    command: "motion.connector.template_to_cut",
    label: "TemplateIR package to Cut",
    sourceProduct: "shellx-motion",
    targetProduct: "shellx-cut",
    outputKind: "cut-import-plan",
    requiredInputs: ["packageRoot", "outDir", "values"],
    optionalInputs: ["cutImportMode"],
    outputArtifacts: ["motion_package", "preview_frame", "preview_receipt", "rendered_media", "artifact_handle", "render_receipt", "cut_plan", "connector_receipt"],
    receipts: ["connector_receipt", "template_apply_receipt", "preview_receipt", "render_receipt", "cut_plan"],
    render: { required: true, dryRunSupported: false, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media"]
    },
    qualityGate: { supported: false, defaultEnabled: false },
    surfaces: ["shellx-cut", "shellx-motion"],
    templateDriven: true,
    requiresSourceImport: false
  }
];

function buildConnectorPanel(): ConnectorPanel {
  const cards = CONNECTOR_PANEL_CARDS.map((card) => ({
    ...card,
    requiredInputs: [...card.requiredInputs],
    optionalInputs: [...card.optionalInputs],
    ...(card.inputConstraint ? { inputConstraint: card.inputConstraint } : {}),
    outputArtifacts: [...card.outputArtifacts],
    receipts: [...card.receipts],
    render: { ...card.render, presets: [...card.render.presets] },
    cutHandoff: { ...card.cutHandoff, ...(card.cutHandoff.importModes ? { importModes: [...card.cutHandoff.importModes] } : {}) },
    qualityGate: { ...card.qualityGate },
    surfaces: [...card.surfaces]
  }));
  return {
    counts: {
      connectors: cards.length,
      canvasConnectors: cards.filter((card) => card.sourceProduct === "shellx-canvas").length,
      cutConnectors: cards.filter((card) => card.targetProduct === "shellx-cut").length,
      independentExports: cards.filter((card) => card.outputKind === "mp4").length,
      renderedMedia: cards.filter((card) => card.render.producesRenderedMedia).length,
      qualityGated: cards.filter((card) => card.qualityGate.supported).length,
      requiresSourceImport: cards.filter((card) => card.requiresSourceImport).length,
      templateDriven: cards.filter((card) => card.templateDriven).length
    },
    cards,
    suggestedActions: cards.map((card): ConnectorPanelSuggestedAction => {
      if (card.id === "canvas_to_mp4") return { id: "canvasMp4", command: card.command, requiredArgs: [...card.requiredInputs] };
      if (card.id === "canvas_to_cut") return { id: "canvasCut", command: card.command, requiredArgs: [...card.requiredInputs] };
      if (card.id === "script_to_cut") return { id: "scriptCut", command: card.command, requiredArgs: [...card.requiredInputs] };
      if (card.id === "source_to_cut") return { id: "sourceCut", command: card.command, requiredArgs: [...card.requiredInputs] };
      if (card.id === "cut_generate_to_cut") return { id: "cutGenerateCut", command: card.command, requiredArgs: [...card.requiredInputs] };
      return { id: "templateCut", command: card.command, requiredArgs: [...card.requiredInputs] };
    }),
    warnings: []
  };
}
