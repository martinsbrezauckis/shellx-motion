import { convertScriptedFramesToMotionPackage, type writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import type { importHtmlSnippetToMotionPackage, writeHtmlSnippetExport } from "@shellx-motion/adapters-html";
import type { exportMotionPackageToOtio, importOtioTimelineToMotionPackage } from "@shellx-motion/adapters-otio";
import { applyReceiptActor, isPublicationCommitUncertain, type OperationReceipt, type PublicationCommitUncertainError, type ReceiptActor } from "@shellx-motion/core";
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
import { dispatchAgentScriptAuthoringCommand, type AgentScriptAuthoringServices } from "./authoring-agent-script.js";
import { dispatchCutoutRigAuthoringCommand, type CutoutRigAuthoringServices } from "./authoring-cutout-rig.js";
import {
  acquireConfiguredAuthoringInputFileDirectoryAuthority, assertConfiguredAuthoringInputFile,
  assertConfiguredAuthoringInputRoot, assertConfiguredAuthoringOutputFile,
  assertConfiguredAuthoringOutputRoot,
  configuredAuthoringInputRoot,
} from "./authoring-root-policy.js";

export interface AuthoringDomainServices
  extends SourceAuthoringServices,
    TemplateReadServices,
    TemplateMutationServices,
    TrackingAuthoringServices,
    KeyingAuthoringServices,
    CompositingGraphAuthoringServices,
    ProceduralAuthoringServices,
    CutoutRigAuthoringServices,
    GltfAuthoringServices,
    LottieAuthoringServices,
    AgentScriptAuthoringServices {
  receiptsRoot?: string;
  /** Observed transport actor committed with the Script receipt before any mirror observes it. */
  receiptActor?: ReceiptActor;
  /** The configured root is supplied for stable no-follow reads; implementations must not widen it. */
  readJson?: (path: string, withinRoot?: string) => Promise<unknown>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
  scriptedPackageWriter?: typeof writeScriptedMotionPackage;
  htmlSnippetExporter?: typeof writeHtmlSnippetExport;
  htmlSnippetImporter?: typeof importHtmlSnippetToMotionPackage;
  callerSteeredFilesystemAuthority?: boolean; // Only arguments crossing an external caller boundary.
  otioExporter?: typeof exportMotionPackageToOtio;
  otioImporter?: typeof importOtioTimelineToMotionPackage;
}

export async function dispatchAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AuthoringDomainServices = {}
): Promise<MotionDebugResult | null> {
  const cutoutRigResult = await dispatchCutoutRigAuthoringCommand(command, args, services);
  if (cutoutRigResult) return cutoutRigResult;
  const gltfResult = await dispatchGltfAuthoringCommand(command, args, services);
  if (gltfResult) return gltfResult;
  const lottieResult = await dispatchLottieAuthoringCommand(command, args, services);
  if (lottieResult) return lottieResult;
  const agentScriptResult = await dispatchAgentScriptAuthoringCommand(command, args, services);
  if (agentScriptResult) return agentScriptResult;
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
  if (!hasConfiguredAuthoringRoots(services)) return authoringRootsUnavailable("Script compilation");

  try {
    const approvedInputRoot = scriptPath
      ? configuredAuthoringInputRoot(scriptPath, services.authoringInputRoots, "Script compile source")
      : undefined;
    if (scriptPath) await assertConfiguredAuthoringInputFile(scriptPath, services.authoringInputRoots, "Script compile source");
    const script = scriptInline ?? await services.readJson!(scriptPath!, approvedInputRoot);
    const inputPath = scriptInline ? "inline-scripted-video.json" : scriptPath!;
    const scriptedExport = convertScriptedFramesToMotionPackage(script, {
      ...(createdAt ? { createdAt } : {}),
      inputPath
    });
    await assertConfiguredAuthoringOutputRoot(packageDir, services.authoringOutputRoots, "Script compile package output");
    const written = await services.scriptedPackageWriter({
      ...scriptedExport,
      receipt: applyReceiptActor(scriptedExport.receipt, services.receiptActor)
    }, { packageDir });
    // The package's exact final receipt is committed before this observer is called. A mirror
    // failure therefore warns about host observation; it must never rewrite committed success.
    const hostReceipt = receiptsRoot ? await mirrorScriptCompileReceipt(services, receiptsRoot, written.receipt) : undefined;
    const warnings = [...written.receipt.warnings, ...(hostReceipt?.warning ? [hostReceipt.warning] : [])];
    return {
      ok: true,
      receiptId: written.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "script.compile",
        packageId: scriptedExport.manifest.id,
        packageDir: written.packageDir,
        ...(hostReceipt?.path ? { hostReceiptPath: hostReceipt.path } : {})
      },
      result: {
        ok: true,
        packageId: scriptedExport.manifest.id,
        motionId: scriptedExport.motion.id,
        packageDir: written.packageDir,
        manifestPath: written.manifestPath,
        motionPath: written.motionPath,
        receiptPath: written.receiptPath,
        ...(hostReceipt?.path ? { hostReceiptPath: hostReceipt.path } : {}),
        ...(hostReceipt?.warning ? { hostReceipt: { status: "mirror_failed", message: hostReceipt.warning } } : {}),
        manifest: scriptedExport.manifest,
        motion: scriptedExport.motion,
        receipt: written.receipt
      },
      warnings
    };
  } catch (error) {
    if (isPublicationCommitUncertain(error)) return scriptCompileCommitUncertain(error);
    return {
      ok: false,
      error: { code: "script_compile_failed", message: error instanceof Error ? error.message : String(error) },
      warnings: []
    };
  }
}

async function mirrorScriptCompileReceipt(
  services: AuthoringDomainServices,
  root: string,
  receipt: OperationReceipt
): Promise<{ path?: string; warning?: string }> {
  try {
    if (!services.writeReceipt) throw new Error("Receipt persistence capability is unavailable.");
    return { path: await services.writeReceipt(root, receipt) };
  } catch (error) {
    return { warning: `Script package committed, but host receipt mirror failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function scriptCompileCommitUncertain(error: PublicationCommitUncertainError): MotionDebugResult {
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

async function exportHtmlSnippet(args: unknown, services: AuthoringDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir");
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.html.snippet.export requires packageRoot.");
  if (!outDir) return invalidArgs("motion.html.snippet.export requires outDir.");
  if (!services.htmlSnippetExporter) return capabilityUnavailable("HTML snippet export is unavailable.");
  if (!hasConfiguredAuthoringRoots(services)) return authoringRootsUnavailable("HTML snippet export");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, "HTML snippet package input");
    await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots, "HTML snippet export output");
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
  if (!hasConfiguredAuthoringRoots(services)) return authoringRootsUnavailable("HTML snippet import");
  try {
    const sourceRootAuthority = services.callerSteeredFilesystemAuthority ? await acquireConfiguredAuthoringInputFileDirectoryAuthority(htmlPath, services.authoringInputRoots, "HTML snippet source") : undefined;
    if (!sourceRootAuthority) await assertConfiguredAuthoringInputFile(htmlPath, services.authoringInputRoots, "HTML snippet source");
    await assertConfiguredAuthoringOutputRoot(packageDir, services.authoringOutputRoots, "HTML snippet package output");
    const result = await services.htmlSnippetImporter({ htmlPath, packageDir, ...(sourceRootAuthority ? { sourceRootAuthority } : {}), ...(createdAt ? { createdAt } : {}) });
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
  if (!hasConfiguredAuthoringRoots(services)) return authoringRootsUnavailable("OTIO export");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, "OTIO package input");
    await assertConfiguredAuthoringOutputFile(outPath, services.authoringOutputRoots, "OTIO export output");
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
  if (!hasConfiguredAuthoringRoots(services)) return authoringRootsUnavailable("OTIO import");
  try {
    await assertConfiguredAuthoringInputFile(otioPath, services.authoringInputRoots, "OTIO source");
    await assertConfiguredAuthoringOutputRoot(packageDir, services.authoringOutputRoots, "OTIO package output");
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

function hasConfiguredAuthoringRoots(services: AuthoringDomainServices): boolean {
  return Boolean(services.authoringInputRoots?.length && services.authoringOutputRoots?.length);
}

function authoringRootsUnavailable(operation: string): MotionDebugResult {
  return capabilityUnavailable(`${operation} requires host-approved input and output roots.`);
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  if (isPublicationCommitUncertain(error)) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        detail: { possiblyCommitted: true, publicPaths: [error.evidence.publicPath], expected: error.evidence }
      },
      result: { possiblyCommitted: true, publicPaths: [error.evidence.publicPath], expected: error.evidence },
      warnings: []
    };
  }
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
