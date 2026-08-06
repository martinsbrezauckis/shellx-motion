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
  runCanvasToCutConnector,
  runScriptToCutConnector,
  runSourceToCutConnector,
  runTemplateToCutConnector
} from "@shellx-motion/connectors";
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { readFfmpegExportPreset, type FfmpegRunner, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import { dirname, join } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, positiveIntegerArg, positiveNumberArg, recordArg, scalarRecordArg, stringArg, stringArrayArg } from "./args.js";
import { dispatchBrowserWorkflowCommand, type BrowserWorkflowServices } from "./integration-browser-workflow.js";

export interface IntegrationDomainServices extends BrowserWorkflowServices {
  ffmpegRunner?: FfmpegRunner;
  receiptsRoot?: string;
  readReceipt?: (path: string) => Promise<OperationReceipt | null>;
  readJson?: (path: string) => Promise<unknown>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
  writeJson?: (path: string, value: unknown) => Promise<void>;
}
export async function dispatchIntegrationCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: IntegrationDomainServices = {}
): Promise<MotionDebugResult | null> {
  const browserWorkflowResult = await dispatchBrowserWorkflowCommand(command, args, services);
  if (browserWorkflowResult) return browserWorkflowResult;
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
    const sourceRoot = stringArg(args, "sourceRoot") ?? (canvasSelectionPath ? dirname(canvasSelectionPath) : undefined);
    const createdAt = stringArg(args, "createdAt") ?? undefined;
    const createdBy = stringArg(args, "createdBy") ?? undefined;
    const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
    if (!canvasSelectionPath && !selectionInline) return invalidArgs("motion.canvas.package requires canvasSelectionPath or selection.");
    if (!packageDir) return invalidArgs("motion.canvas.package requires packageDir.");
    if (canvasSelectionPath && !services.readJson) return capabilityUnavailable("Canvas selection file reading is unavailable.");
    if (!services.writeJson) return capabilityUnavailable("Canvas package receipt persistence is unavailable.");
    if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Host receipt persistence is unavailable.");
    try {
      const selection = selectionInline ?? await services.readJson!(canvasSelectionPath!);
      const inputPath = selectionInline ? "inline-canvas-selection.json" : canvasSelectionPath!;
      const canvasExport = convertCanvasFrameToMotionPackage(selection, {
        ...(selectedFrameId ? { selectedFrameId } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(createdBy ? { createdBy } : {}),
        inputPath
      });
      const written = await writeCanvasMotionPackage(canvasExport, { packageDir, ...(sourceRoot ? { sourceRoot } : {}) });
      const receipt = enrichCanvasPackageReceipt(canvasExport.receipt, written);
      await services.writeJson(written.receiptPath, receipt);
      const hostReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
      const warnings = written.missingAssetRefs.map((assetRef) => `Canvas asset was not copied into package: ${assetRef}`);
      return {
        ok: true,
        receiptId: receipt.id,
        visibleState: {
          panel: "receipts",
          operation: "canvas.package",
          packageId: canvasExport.manifest.id,
          packageDir: written.packageDir,
          resourceCatalogPath: written.resourceCatalogPath,
          ...(hostReceiptPath ? { hostReceiptPath } : {})
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
          ...(hostReceiptPath ? { hostReceiptPath } : {})
        },
        warnings
      };
    } catch (error) {
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
    if (!services.readReceipt) return capabilityUnavailable("Connector receipt verification is unavailable.");
    try {
      const result = await runCanvasMp4Export({
        canvasSelectionPath,
        outDir,
        preset,
        dryRunRender: dryRunRender ?? false,
        ...(services.ffmpegRunner ? { ffmpegRunner: services.ffmpegRunner } : {})
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
    if (!services.readReceipt) return capabilityUnavailable("Canvas bridge receipt verification is unavailable.");
    try {
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
      return {
        ok: false,
        error: { code: "canvas_bridge_export_failed", message: error instanceof Error ? error.message : String(error) },
        warnings: []
      };
    }
  }

  if (command === "motion.connector.canvas_to_cut") {
    const canvasSelectionPath = stringArg(args, "canvasSelectionPath");
    const outDir = stringArg(args, "outDir");
    const modeArg = stringArg(args, "cutImportMode");
    const dryRunRender = booleanArg(args, "dryRunRender");
    const createdAt = stringArg(args, "createdAt") ?? undefined;
    if (!canvasSelectionPath) return invalidArgs("motion.connector.canvas_to_cut requires canvasSelectionPath.");
    if (!outDir) return invalidArgs("motion.connector.canvas_to_cut requires outDir.");
    const cutImportMode = modeArg ? readCutImportModeRequest(modeArg) : undefined;
    if (modeArg && !cutImportMode) return invalidArgs(`Unsupported Cut import mode: ${modeArg}.`);
    if (!services.readReceipt) return capabilityUnavailable("Connector receipt verification is unavailable.");
    try {
      const result = await runCanvasToCutConnector({
        canvasSelectionPath,
        outDir,
        ...(cutImportMode ? { cutImportMode } : {}),
        dryRunRender: dryRunRender ?? false,
        ...(createdAt ? { now: () => createdAt } : {}),
        ...(services.ffmpegRunner ? { ffmpegRunner: services.ffmpegRunner } : {})
      });
      return await connectorResult(command, result, services, {
        panel: "receipts",
        operation: "connector.canvas_to_cut",
        ok: result.ok,
        cutPlanPath: result.cutPlanPath,
        receiptPath: result.receiptPath
      });
    } catch (error) {
      return connectorException(error);
    }
  }

  if (command === "motion.connector.source_to_cut") {
    const sourcePath = stringArg(args, "sourcePath");
    const outDir = stringArg(args, "outDir");
    const modeArg = stringArg(args, "cutImportMode");
    const dryRunRender = booleanArg(args, "dryRunRender");
    const maxFrames = positiveIntegerArg(args, "maxFrames");
    const frameDurationMs = positiveIntegerArg(args, "frameDurationMs");
    const width = positiveIntegerArg(args, "width");
    const height = positiveIntegerArg(args, "height");
    const fps = positiveIntegerArg(args, "fps");
    const createdAt = stringArg(args, "createdAt") ?? undefined;
    if (!sourcePath) return invalidArgs("motion.connector.source_to_cut requires sourcePath.");
    if (!outDir) return invalidArgs("motion.connector.source_to_cut requires outDir.");
    for (const [label, value] of [["maxFrames", maxFrames], ["frameDurationMs", frameDurationMs], ["width", width], ["height", height], ["fps", fps]] as const) {
      if (value === false) return invalidArgs(`${label} must be a positive integer.`);
    }
    const maxFramesValue = typeof maxFrames === "number" ? maxFrames : null;
    const frameDurationMsValue = typeof frameDurationMs === "number" ? frameDurationMs : null;
    const widthValue = typeof width === "number" ? width : null;
    const heightValue = typeof height === "number" ? height : null;
    const fpsValue = typeof fps === "number" ? fps : null;
    const cutImportMode = modeArg ? readCutImportModeRequest(modeArg) : undefined;
    if (modeArg && !cutImportMode) return invalidArgs(`Unsupported Cut import mode: ${modeArg}.`);
    if (!services.readReceipt) return capabilityUnavailable("Connector receipt verification is unavailable.");
    try {
      const result = await runSourceToCutConnector({
        sourcePath,
        outDir,
        ...(maxFramesValue !== null ? { maxFrames: maxFramesValue } : {}),
        ...(frameDurationMsValue !== null ? { frameDurationMs: frameDurationMsValue } : {}),
        ...(widthValue !== null ? { width: widthValue } : {}),
        ...(heightValue !== null ? { height: heightValue } : {}),
        ...(fpsValue !== null ? { fps: fpsValue } : {}),
        ...(cutImportMode ? { cutImportMode } : {}),
        dryRunRender: dryRunRender ?? false,
        ...(createdAt ? { now: () => createdAt } : {}),
        ...(services.ffmpegRunner ? { ffmpegRunner: services.ffmpegRunner } : {})
      });
      return await connectorResult(command, result, services, {
        panel: "receipts",
        operation: "connector.source_to_cut",
        ok: result.ok,
        sourcePath,
        scriptPath: result.storyboard.scriptPath,
        packageDir: result.packageDir,
        ...(result.preview.outputPath ? { previewFramePath: result.preview.outputPath } : {}),
        ...(result.render.outputPath ? { renderedMediaPath: result.render.outputPath } : {}),
        cutPlanPath: result.cutPlanPath,
        receiptPath: result.receiptPath
      });
    } catch (error) {
      return connectorException(error);
    }
  }

  if (command === "motion.connector.template_to_cut") {
    const packageRoot = stringArg(args, "packageRoot");
    const outDir = stringArg(args, "outDir");
    const values = scalarRecordArg(args, "values");
    const modeArg = stringArg(args, "cutImportMode");
    const dryRunRender = booleanArg(args, "dryRunRender");
    if (!packageRoot) return invalidArgs("motion.connector.template_to_cut requires packageRoot.");
    if (!outDir) return invalidArgs("motion.connector.template_to_cut requires outDir.");
    if (!values) return invalidArgs("motion.connector.template_to_cut requires values.");
    const cutImportMode = modeArg ? readCutImportModeRequest(modeArg) : undefined;
    if (modeArg && !cutImportMode) return invalidArgs(`Unsupported Cut import mode: ${modeArg}.`);
    if (!services.readReceipt) return capabilityUnavailable("Connector receipt verification is unavailable.");
    try {
      const result = await runTemplateToCutConnector({
        packageRoot,
        outDir,
        values,
        previewLane: "auto",
        ...(cutImportMode ? { cutImportMode } : {}),
        dryRunRender: dryRunRender ?? false,
        ...(services.ffmpegRunner ? { ffmpegRunner: services.ffmpegRunner } : {})
      });
      return await connectorResult(command, result, services, {
        panel: "receipts",
        operation: "connector.template_to_cut",
        ok: result.ok,
        cutPlanPath: result.cutPlanPath,
        receiptPath: result.receiptPath
      });
    } catch (error) {
      return connectorException(error);
    }
  }

  if (command === "motion.connector.script_to_cut" || command === "motion.connector.cut_generate_to_cut") {
    const receiptOperation = command === "motion.connector.cut_generate_to_cut" ? "connector.cut_generate_to_cut" : "connector.script_to_cut";
    const scriptPathArg = stringArg(args, "scriptPath");
    const scriptInline = recordArg(args, "script") ?? recordArg(args, "storyboard");
    const outDir = stringArg(args, "outDir");
    const modeArg = stringArg(args, "cutImportMode");
    const dryRunRender = booleanArg(args, "dryRunRender");
    const createdAt = stringArg(args, "createdAt") ?? undefined;
    if (!scriptPathArg && !scriptInline) return invalidArgs(`${command} requires scriptPath or script.`);
    if (!outDir) return invalidArgs(`${command} requires outDir.`);
    const cutImportMode = modeArg ? readCutImportModeRequest(modeArg) : undefined;
    if (modeArg && !cutImportMode) return invalidArgs(`Unsupported Cut import mode: ${modeArg}.`);
    if (!services.readReceipt) return capabilityUnavailable("Connector receipt verification is unavailable.");
    if (scriptInline && !services.writeJson) return capabilityUnavailable("Inline script persistence is unavailable.");
    try {
      const scriptPath = scriptPathArg ?? join(outDir, "scripted-video.json");
      if (scriptInline) await services.writeJson!(scriptPath, scriptInline);
      const result = await runScriptToCutConnector({
        scriptPath,
        outDir,
        ...(cutImportMode ? { cutImportMode } : {}),
        dryRunRender: dryRunRender ?? false,
        receiptOperation,
        ...(createdAt ? { now: () => createdAt } : {}),
        ...(services.ffmpegRunner ? { ffmpegRunner: services.ffmpegRunner } : {})
      });
      return await connectorResult(command, result, services, {
        panel: "receipts",
        operation: receiptOperation,
        ok: result.ok,
        scriptPath,
        packageDir: result.packageDir,
        ...(result.preview.outputPath ? { previewFramePath: result.preview.outputPath } : {}),
        ...(result.render.outputPath ? { renderedMediaPath: result.render.outputPath } : {}),
        cutPlanPath: result.cutPlanPath,
        receiptPath: result.receiptPath
      }, { scriptPath });
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

async function connectorResult(
  command: MotionDebugCommand,
  result: { ok: boolean; receiptPath: string; warnings: string[] },
  services: IntegrationDomainServices,
  visibleState: Record<string, unknown>,
  extraResult: Record<string, unknown> = {}
): Promise<MotionDebugResult> {
  const receipt = await services.readReceipt!(result.receiptPath);
  const hostReceiptPath = services.receiptsRoot && receipt
    ? await persistReceipt(services, services.receiptsRoot, receipt)
    : undefined;
  const publicResult = { ...result, ...extraResult, ...(hostReceiptPath ? { hostReceiptPath } : {}) };
  const publicVisibleState = { ...visibleState, ...(hostReceiptPath ? { hostReceiptPath } : {}) };
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: "connector_failed",
        message: `${command} returned a failed connector receipt.`,
        detail: { receiptPath: result.receiptPath }
      },
      ...(receipt ? { receiptId: receipt.id } : {}),
      visibleState: publicVisibleState,
      result: publicResult,
      warnings: result.warnings
    };
  }
  return {
    ok: true,
    ...(receipt ? { receiptId: receipt.id } : {}),
    visibleState: publicVisibleState,
    result: publicResult,
    warnings: result.warnings
  };
}

function connectorException(error: unknown): MotionDebugResult {
  return {
    ok: false,
    error: { code: "connector_failed", message: error instanceof Error ? error.message : String(error) },
    warnings: []
  };
}

async function persistReceipt(services: IntegrationDomainServices, root: string, receipt: OperationReceipt): Promise<string> {
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

function enrichCanvasPackageReceipt(receipt: OperationReceipt, paths: {
  packageDir: string;
  manifestPath: string;
  motionPath: string;
  resourceCatalogPath: string;
  assetRefs: string[];
  copiedAssetRefs: string[];
  missingAssetRefs: string[];
}): OperationReceipt {
  const output = typeof receipt.output === "object" && receipt.output !== null && !Array.isArray(receipt.output)
    ? { ...receipt.output }
    : {};
  return {
    ...receipt,
    output: { ...output, ...paths },
    warnings: [
      ...receipt.warnings,
      ...paths.missingAssetRefs.map((assetRef) => `Canvas asset was not copied into package: ${assetRef}`)
    ]
  };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message }, warnings: [] };
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
    optionalInputs: ["cutImportMode", "dryRunRender", "createdAt"],
    outputArtifacts: ["motion_package", "rendered_media", "cut_plan", "connector_receipt"],
    receipts: ["connector_receipt", "render_receipt", "cut_plan"],
    render: { required: "conditional", dryRunSupported: true, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264", "webm-vp9", "png-sequence"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media", "live_overlay", "editable_lowering"]
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
    id: "source_to_cut",
    command: "motion.connector.source_to_cut",
    label: "Imported source Markdown to Cut",
    sourceProduct: "imported-source",
    targetProduct: "shellx-cut",
    outputKind: "cut-import-plan",
    requiredInputs: ["sourcePath", "outDir"],
    optionalInputs: ["maxFrames", "frameDurationMs", "width", "height", "fps", "cutImportMode", "dryRunRender", "createdAt"],
    outputArtifacts: ["source_markdown", "storyboard", "motion_package", "rendered_media", "cut_plan", "source_to_cut_receipt"],
    receipts: ["source_to_cut_receipt", "source_storyboard_receipt", "render_receipt", "quality_receipt", "cut_plan"],
    render: { required: true, dryRunSupported: true, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264", "webm-vp9"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media"]
    },
    qualityGate: { supported: true, defaultEnabled: true },
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
    optionalInputs: ["cutImportMode", "dryRunRender"],
    outputArtifacts: ["motion_package", "rendered_media", "cut_plan", "connector_receipt"],
    receipts: ["connector_receipt", "template_apply_receipt", "render_receipt", "cut_plan"],
    render: { required: "conditional", dryRunSupported: true, defaultFrameLane: "browser", producesRenderedMedia: true, presets: ["mp4-h264", "webm-vp9", "png-sequence"] },
    cutHandoff: {
      supported: true,
      importModes: ["rendered_media", "editable_lowering"]
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
