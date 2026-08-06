/** Assemble redacted support evidence behind narrow workspace I/O ports. */
import { ACTIONS } from "@shellx-motion/actions";
import {
  hashBuffer,
  hashPackageFile,
  inspectMotionTimeline,
  resolvePackageAsset,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import { DEBUG_COMMANDS, type MotionDebugCommand, type MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";
import type { WorkspacePlatformReceiptEntry, WorkspaceReceiptEntry } from "./workspace-types.js";

export interface WorkspaceSupportServices {
  receiptsRoot?: string;
  scratchRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  ensureDirectory?: (path: string) => Promise<void>;
  listReceiptEntries?: (receiptsRoot: string) => Promise<WorkspaceReceiptEntry[]>;
  summarizeReceipt?: (entry: WorkspaceReceiptEntry) => Record<string, unknown>;
  listPlatformReceiptEntries?: (receiptsRoot: string) => Promise<WorkspacePlatformReceiptEntry[]>;
  summarizePlatformReceipt?: (entry: WorkspacePlatformReceiptEntry) => Record<string, unknown>;
  writeJson?: (path: string, value: unknown) => Promise<void>;
}

export async function dispatchWorkspaceSupportCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: WorkspaceSupportServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.support.bundle") return null;
  const outDir = stringArg(args, "outDir");
  const packageRoot = stringArg(args, "packageRoot") ?? undefined;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!outDir) return invalidArgs("motion.support.bundle requires outDir.");
  if (!services.scratchRoot) return invalidArgs("motion.support.bundle requires a trusted debug scratch root.");
  if (!services.isEmptyOrAbsentDirectory || !services.isPathInsideTrustedRoot || !services.ensureDirectory || !services.writeJson) {
    return capabilityUnavailable("Support bundle filesystem capabilities are unavailable.");
  }
  if (packageRoot && (!services.packageLoader || !services.isUnsafePackageOutputDirectory)) {
    return capabilityUnavailable("Support bundle package inspection is unavailable.");
  }
  if (receiptsRoot && (!services.listReceiptEntries || !services.summarizeReceipt || !services.listPlatformReceiptEntries || !services.summarizePlatformReceipt)) {
    return capabilityUnavailable("Support bundle receipt inspection is unavailable.");
  }

  try {
    const bundleDir = resolve(outDir);
    const pkg = packageRoot ? await services.packageLoader!(packageRoot) : null;
    if (pkg && await services.isUnsafePackageOutputDirectory!(pkg.root, bundleDir)) {
      return invalidArgs("motion.support.bundle outDir must be outside packageRoot.");
    }
    if (!await services.isPathInsideTrustedRoot(services.scratchRoot, bundleDir)) {
      return invalidArgs("motion.support.bundle outDir must be inside the trusted debug scratch root.");
    }
    if (!await services.isEmptyOrAbsentDirectory(bundleDir)) {
      return invalidArgs("motion.support.bundle outDir must be empty or absent before bundle collection.");
    }
    await services.ensureDirectory(bundleDir);
    const inputHashes: Record<string, string> = {};
    let packageSummary: Record<string, unknown> | undefined;
    if (pkg) {
      const manifestPath = resolvePackageAsset(pkg, "manifest.json");
      const motionPath = resolvePackageAsset(pkg, pkg.manifest.motion);
      inputHashes["manifest.json"] = await hashPackageFile(manifestPath);
      inputHashes[pkg.manifest.motion] = await hashPackageFile(motionPath);
      const timeline = inspectMotionTimeline(pkg.motion);
      packageSummary = {
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        motionId: pkg.motion.id,
        sourceApp: pkg.manifest.sourceApp,
        compatibility: pkg.manifest.compatibility,
        motion: {
          durationMs: pkg.motion.durationMs,
          fps: pkg.motion.fps,
          width: pkg.motion.width,
          height: pkg.motion.height
        },
        layerCount: pkg.motion.layers.length,
        assetCount: pkg.motion.assets.length,
        timeline: { trackCount: timeline.trackCount, sceneCount: timeline.sceneCount, markerCount: timeline.markerCount },
        inputHashes
      };
    }
    const receiptEntries = receiptsRoot ? await services.listReceiptEntries!(receiptsRoot) : [];
    const platformReceiptEntries = receiptsRoot ? await services.listPlatformReceiptEntries!(receiptsRoot) : [];
    const bundlePath = join(bundleDir, "support-bundle.json");
    const receiptPath = join(bundleDir, "support-bundle.receipt.json");
    const bundle = {
      schema: "shellx-motion/support-bundle@1",
      createdAt: new Date().toISOString(),
      package: packageSummary,
      receipts: {
        ...(receiptsRoot ? { receiptsRoot } : {}),
        receiptCount: receiptEntries.length,
        receipts: receiptEntries.map((entry) => services.summarizeReceipt!(entry))
      },
      ...(platformReceiptEntries.length > 0 ? {
        platformVerification: {
          receiptCount: platformReceiptEntries.length,
          receipts: platformReceiptEntries.map((entry) => services.summarizePlatformReceipt!(entry))
        }
      } : {}),
      debug: {
        commandCount: DEBUG_COMMANDS.length,
        commands: [...DEBUG_COMMANDS],
        actionCount: ACTIONS.length,
        actions: ACTIONS.map((action) => ({
          id: action.id,
          permission: action.permission,
          mutates: action.mutates,
          calls: action.calls,
          surfaces: action.surfaces
        }))
      },
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      redactions: { envValues: "omitted" }
    };
    const artifacts: ReceiptArtifact[] = [
      { role: "support_bundle", path: bundlePath, status: "available", mediaType: "application/json", primary: true },
      { role: "support_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `support-bundle-${pkg?.manifest.id ?? "workspace"}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, receiptsRoot, commands: DEBUG_COMMANDS }), "utf8")).slice(0, 16)}`,
      operation: "support.bundle",
      status: "passed",
      packageId: pkg?.manifest.id ?? "workspace",
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output: {
        bundlePath,
        receiptPath,
        packageId: pkg?.manifest.id ?? "workspace",
        receiptCount: receiptEntries.length,
        platformReceiptCount: platformReceiptEntries.length,
        debugCommandCount: DEBUG_COMMANDS.length,
        redactions: { envValues: "omitted" }
      },
      artifacts,
      warnings: []
    };
    await services.writeJson(bundlePath, bundle);
    await services.writeJson(receiptPath, receipt);
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "support.bundle",
        packageId: pkg?.manifest.id ?? "workspace",
        bundlePath,
        receiptPath,
        receiptCount: receiptEntries.length,
        platformReceiptCount: platformReceiptEntries.length
      },
      result: { ok: true, packageId: pkg?.manifest.id ?? "workspace", bundlePath, receiptPath, bundle, receipt },
      warnings: []
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: "support_bundle_failed", message: error instanceof Error ? error.message : String(error) },
      warnings: []
    };
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
