import { convertScriptedFramesToMotionPackage, type writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import type { importHtmlSnippetToMotionPackage, writeHtmlSnippetExport } from "@shellx-motion/adapters-html";
import type { exportMotionPackageToOtio, importOtioTimelineToMotionPackage } from "@shellx-motion/adapters-otio";
import type { OperationReceipt } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { recordArg, stringArg } from "./args.js";
import { dispatchSourceAuthoringCommand, type SourceAuthoringServices } from "./authoring-source.js";
import { dispatchKeyingAuthoringCommand, type KeyingAuthoringServices } from "./authoring-keying.js";
import { dispatchCompositingGraphAuthoringCommand, type CompositingGraphAuthoringServices } from "./authoring-compositing-graph.js";
import { dispatchProceduralAuthoringCommand, type ProceduralAuthoringServices } from "./authoring-procedural.js";
import { dispatchTemplateReadCommand, type TemplateReadServices } from "./authoring-template-read.js";
import { dispatchTemplateMutationCommand, type TemplateMutationServices } from "./authoring-template-mutations.js";
import { dispatchTrackingAuthoringCommand, type TrackingAuthoringServices } from "./authoring-tracking.js";
import { dispatchGltfAuthoringCommand, type GltfAuthoringServices } from "./authoring-gltf.js";
import { dispatchLottieAuthoringCommand, type LottieAuthoringServices } from "./authoring-lottie.js";

export interface AuthoringDomainServices
  extends SourceAuthoringServices,
    TemplateReadServices,
    TemplateMutationServices,
    TrackingAuthoringServices,
    KeyingAuthoringServices,
    CompositingGraphAuthoringServices,
    ProceduralAuthoringServices,
    GltfAuthoringServices,
    LottieAuthoringServices {
  receiptsRoot?: string;
  readJson?: (path: string) => Promise<unknown>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
  scriptedPackageWriter?: typeof writeScriptedMotionPackage;
  htmlSnippetExporter?: typeof writeHtmlSnippetExport;
  htmlSnippetImporter?: typeof importHtmlSnippetToMotionPackage;
  otioExporter?: typeof exportMotionPackageToOtio;
  otioImporter?: typeof importOtioTimelineToMotionPackage;
}

export async function dispatchAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AuthoringDomainServices = {}
): Promise<MotionDebugResult | null> {
  const gltfResult = await dispatchGltfAuthoringCommand(command, args, services);
  if (gltfResult) return gltfResult;
  const lottieResult = await dispatchLottieAuthoringCommand(command, args, services);
  if (lottieResult) return lottieResult;
  const proceduralResult = await dispatchProceduralAuthoringCommand(command, args, services);
  if (proceduralResult) return proceduralResult;
  const compositingResult = await dispatchCompositingGraphAuthoringCommand(command, args, services);
  if (compositingResult) return compositingResult;
  const keyingResult = await dispatchKeyingAuthoringCommand(command, args, services);
  if (keyingResult) return keyingResult;
  const trackingResult = await dispatchTrackingAuthoringCommand(command, args, services);
  if (trackingResult) return trackingResult;
  const sourceResult = await dispatchSourceAuthoringCommand(command, args, services);
  if (sourceResult) return sourceResult;
  const templateReadResult = await dispatchTemplateReadCommand(command, args, services);
  if (templateReadResult) return templateReadResult;
  const templateMutationResult = await dispatchTemplateMutationCommand(command, args, services);
  if (templateMutationResult) return templateMutationResult;
  if (command === "motion.html.snippet.export") return exportHtmlSnippet(args, services);
  if (command === "motion.html.snippet.import") return importHtmlSnippet(args, services);
  if (command === "motion.otio.export") return exportOtio(args, services);
  if (command === "motion.otio.import") return importOtio(args, services);
  if (command !== "motion.script.compile") return null;

  const scriptPath = stringArg(args, "scriptPath");
  const scriptInline = recordArg(args, "script");
  const packageDir = stringArg(args, "packageDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!scriptPath && !scriptInline) return invalidArgs("motion.script.compile requires scriptPath or script.");
  if (!packageDir) return invalidArgs("motion.script.compile requires packageDir.");
  if (scriptPath && !services.readJson) return capabilityUnavailable("Scripted-video JSON reading is unavailable.");
  if (!services.scriptedPackageWriter) return capabilityUnavailable("Scripted Motion package writing is unavailable.");
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Script compile receipt persistence is unavailable.");

  try {
    const script = scriptInline ?? await services.readJson!(scriptPath!);
    const inputPath = scriptInline ? "inline-scripted-video.json" : scriptPath!;
    const scriptedExport = convertScriptedFramesToMotionPackage(script, {
      ...(createdAt ? { createdAt } : {}),
      inputPath
    });
    const written = await services.scriptedPackageWriter(scriptedExport, { packageDir });
    const hostReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, scriptedExport.receipt) : undefined;
    return {
      ok: true,
      receiptId: scriptedExport.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "script.compile",
        packageId: scriptedExport.manifest.id,
        packageDir: written.packageDir
      },
      result: {
        ok: true,
        packageId: scriptedExport.manifest.id,
        motionId: scriptedExport.motion.id,
        packageDir: written.packageDir,
        manifestPath: written.manifestPath,
        motionPath: written.motionPath,
        receiptPath: written.receiptPath,
        ...(hostReceiptPath ? { hostReceiptPath } : {}),
        manifest: scriptedExport.manifest,
        motion: scriptedExport.motion,
        receipt: scriptedExport.receipt
      },
      warnings: scriptedExport.receipt.warnings
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: "script_compile_failed", message: error instanceof Error ? error.message : String(error) },
      warnings: []
    };
  }
}

async function exportHtmlSnippet(args: unknown, services: AuthoringDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir");
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.html.snippet.export requires packageRoot.");
  if (!outDir) return invalidArgs("motion.html.snippet.export requires outDir.");
  if (!services.htmlSnippetExporter) return capabilityUnavailable("HTML snippet export is unavailable.");
  try {
    const result = await services.htmlSnippetExporter({ packageRoot, outDir, ...(createdAt ? { createdAt } : {}) });
    return {
      ok: true,
      receiptId: result.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "html.snippet.export",
        packageId: result.packageId,
        htmlPath: result.htmlPath,
        receiptPath: result.receiptPath,
        exportedLayerCount: result.exportedLayerCount,
        unsupportedFeatureCount: result.unsupportedFeatureCount
      },
      result,
      warnings: result.warnings
    };
  } catch (error) {
    return commandFailure("html_snippet_export_failed", error);
  }
}

async function importHtmlSnippet(args: unknown, services: AuthoringDomainServices): Promise<MotionDebugResult> {
  const htmlPath = stringArg(args, "htmlPath");
  const packageDir = stringArg(args, "packageDir");
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!htmlPath) return invalidArgs("motion.html.snippet.import requires htmlPath.");
  if (!packageDir) return invalidArgs("motion.html.snippet.import requires packageDir.");
  if (!services.htmlSnippetImporter) return capabilityUnavailable("HTML snippet import is unavailable.");
  try {
    const result = await services.htmlSnippetImporter({ htmlPath, packageDir, ...(createdAt ? { createdAt } : {}) });
    return {
      ok: true,
      receiptId: result.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "html.snippet.import",
        packageId: result.packageId,
        packageRoot: result.packageDir,
        motionPath: result.motionPath,
        receiptPath: result.receiptPath,
        layerCount: result.layerCount,
        warningCount: result.warningCount,
        stagedAssetCount: result.stagedAssetCount
      },
      result,
      warnings: result.warnings
    };
  } catch (error) {
    return commandFailure("html_snippet_import_failed", error);
  }
}

async function exportOtio(args: unknown, services: AuthoringDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outPath = stringArg(args, "outPath");
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.otio.export requires packageRoot.");
  if (!outPath) return invalidArgs("motion.otio.export requires outPath.");
  if (!services.otioExporter) return capabilityUnavailable("OTIO export is unavailable.");
  try {
    const result = await services.otioExporter({ packageRoot, outPath, ...(createdAt ? { createdAt } : {}) });
    return {
      ok: true,
      receiptId: result.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "otio.export",
        packageId: result.packageId,
        otioPath: result.otioPath,
        receiptPath: result.receiptPath,
        trackCount: result.trackCount,
        clipCount: result.clipCount,
        gapCount: result.gapCount,
        warningCount: result.warningCount
      },
      result,
      warnings: result.warnings
    };
  } catch (error) {
    return commandFailure("otio_export_failed", error);
  }
}

async function importOtio(args: unknown, services: AuthoringDomainServices): Promise<MotionDebugResult> {
  const otioPath = stringArg(args, "otioPath");
  const packageDir = stringArg(args, "packageDir");
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!otioPath) return invalidArgs("motion.otio.import requires otioPath.");
  if (!packageDir) return invalidArgs("motion.otio.import requires packageDir.");
  if (!services.otioImporter) return capabilityUnavailable("OTIO import is unavailable.");
  try {
    const result = await services.otioImporter({ otioPath, packageDir, ...(createdAt ? { createdAt } : {}) });
    return {
      ok: true,
      receiptId: result.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "otio.import",
        packageId: result.packageId,
        packageRoot: result.packageDir,
        motionPath: result.motionPath,
        receiptPath: result.receiptPath,
        layerCount: result.layerCount,
        warningCount: result.warningCount
      },
      result,
      warnings: result.warnings
    };
  } catch (error) {
    return commandFailure("otio_import_failed", error);
  }
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." },
    warnings: []
  };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
