/** Assemble redacted support evidence behind narrow workspace I/O ports. */
import { ACTIONS } from "@shellx-motion/actions";
import {
  hashBuffer,
  hashPackageFile,
  inspectMotionTimeline,
  isPublicationCommitUncertain,
  OutputDirectoryTransaction,
  readBoundedStableFile,
  resolvePackageAsset,
  writeVerifiedBoundedFile,
  type MotionPackage,
  type OperationReceipt,
  type OutputDirectoryTransactionExpectedInventory,
  type ReceiptArtifact
} from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEBUG_COMMANDS, type MotionDebugCommand, type MotionDebugResult } from "../command-registry.js";
import { corePublicationUncertainty } from "../publication-uncertainty.js";
import { stringArg } from "./args.js";
import { projectShareableValue, shareablePlatformReceiptSummary, shareableSupportReceiptSummary } from "./workspace-support-shareable.js";
import type { WorkspacePlatformReceiptEntry, WorkspaceReceiptEntry } from "./workspace-types.js";

export interface WorkspaceSupportServices {
  receiptsRoot?: string;
  scratchRoot?: string;
  /** Host-owned runtime fact. Command arguments cannot select the publication platform. */
  runtimePlatform?: NodeJS.Platform;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  listReceiptEntries?: (receiptsRoot: string) => Promise<WorkspaceReceiptEntry[]>;
  summarizeReceipt?: (entry: WorkspaceReceiptEntry) => Record<string, unknown>;
  listPlatformReceiptEntries?: (receiptsRoot: string) => Promise<WorkspacePlatformReceiptEntry[]>;
  summarizePlatformReceipt?: (entry: WorkspacePlatformReceiptEntry) => Record<string, unknown>;
}

export async function dispatchWorkspaceSupportCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: WorkspaceSupportServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.support.bundle") return null;
  const outDir = stringArg(args, "outDir");
  const packageRoot = stringArg(args, "packageRoot") ?? undefined;
  const requestedReceiptsRoot = stringArg(args, "receiptsRoot");
  const receiptsRoot = requestedReceiptsRoot ?? services.receiptsRoot;
  if (!outDir) return invalidArgs("motion.support.bundle requires outDir.");
  if (!services.scratchRoot) return invalidArgs("motion.support.bundle requires a trusted debug scratch root.");
  if (!services.isPathInsideTrustedRoot) {
    return capabilityUnavailable("Support bundle filesystem capabilities are unavailable.");
  }
  if (packageRoot && (!services.packageLoader || !services.isUnsafePackageOutputDirectory)) {
    return capabilityUnavailable("Support bundle package inspection is unavailable.");
  }
  if (requestedReceiptsRoot) {
    if (!services.receiptsRoot) return capabilityUnavailable("Support bundle receipt inspection requires a host-configured receipt authority.");
    if (!await services.isPathInsideTrustedRoot(services.receiptsRoot, requestedReceiptsRoot)) {
      return invalidArgs("motion.support.bundle receiptsRoot must be inside the configured host receipt authority.");
    }
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
    if (await outputPathExists(bundleDir)) {
      return invalidArgs("motion.support.bundle outDir must be absent before bundle collection.");
    }
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
        compatibility: projectShareableValue(pkg.manifest.compatibility),
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
    const bundlePath = join(bundleDir, SUPPORT_BUNDLE_FILES[0]);
    const receiptPath = join(bundleDir, SUPPORT_BUNDLE_FILES[1]);
    const bundle = projectShareableValue({
      schema: "shellx-motion/support-bundle@1",
      createdAt: new Date().toISOString(),
      package: packageSummary,
      receipts: {
        receiptCount: receiptEntries.length,
        receipts: receiptEntries.map((entry) => shareableSupportReceiptSummary(services.summarizeReceipt!(entry)))
      },
      ...(platformReceiptEntries.length > 0 ? {
        platformVerification: {
          receiptCount: platformReceiptEntries.length,
          receipts: platformReceiptEntries.map((entry) => shareablePlatformReceiptSummary(services.summarizePlatformReceipt!(entry)))
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
      redactions: { envValues: "omitted", hostPaths: "omitted", diagnosticPaths: "redacted" }
    });
    const bundleBytes = jsonBytes(bundle);
    const bundleSha256 = hashBuffer(bundleBytes);
    const artifacts: ReceiptArtifact[] = [
      { role: "support_bundle", path: SUPPORT_BUNDLE_FILES[0], status: "available", mediaType: "application/json", primary: true },
      { role: "support_receipt", path: SUPPORT_BUNDLE_FILES[1], status: "available", mediaType: "application/json" }
    ];
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `support-bundle-${pkg?.manifest.id ?? "workspace"}-${hashBuffer(jsonBytes({ inputHashes, receiptCount: receiptEntries.length, platformReceiptCount: platformReceiptEntries.length, commands: DEBUG_COMMANDS, bundleSha256 })).slice(0, 16)}`,
      operation: "support.bundle",
      status: "passed",
      packageId: pkg?.manifest.id ?? "workspace",
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output: {
        bundle: { file: SUPPORT_BUNDLE_FILES[0], sha256: bundleSha256, byteLength: bundleBytes.byteLength },
        receipt: { file: SUPPORT_BUNDLE_FILES[1] },
        bundleSha256,
        bundleByteLength: bundleBytes.byteLength,
        packageId: pkg?.manifest.id ?? "workspace",
        receiptCount: receiptEntries.length,
        platformReceiptCount: platformReceiptEntries.length,
        debugCommandCount: DEBUG_COMMANDS.length,
        redactions: { envValues: "omitted", hostPaths: "omitted", diagnosticPaths: "redacted" }
      },
      artifacts,
      warnings: []
    };
    await publishSupportBundle({
      bundleDir,
      scratchRoot: services.scratchRoot,
      runtimePlatform: services.runtimePlatform ?? process.platform,
      bundleBytes,
      receiptBytes: jsonBytes(receipt)
    });
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
    return supportBundleFailure(error);
  }
}

const SUPPORT_BUNDLE_FILES = ["support-bundle.json", "support-bundle.receipt.json"] as const;

interface SupportBundlePublicationInput {
  bundleDir: string;
  scratchRoot: string;
  runtimePlatform: NodeJS.Platform;
  bundleBytes: Buffer;
  receiptBytes: Buffer;
}

/**
 * Keep the platform-specific admission in one small boundary. POSIX retains the opaque trusted
 * workspace anchor. Windows has already completed host trusted-root admission above and must
 * enter Core's OutputPathTopology transaction directly so its DACL validation is not bypassed by
 * a POSIX-only anchor.
 */
async function publishSupportBundle(input: SupportBundlePublicationInput): Promise<void> {
  const publish = async () => {
    const transaction = await OutputDirectoryTransaction.create(input.bundleDir, { requireAbsent: true, requireClosedTree: true });
    try {
      const expectedInventory = await stageSupportBundle(transaction, input.bundleBytes, input.receiptBytes);
      await transaction.commit(expectedInventory);
      await transaction.assertPublishedCurrent();
    } catch (error) {
      await transaction.abort();
      throw error;
    }
  };
  if (input.runtimePlatform === "win32") {
    await publish();
    return;
  }
  // `scratchRoot` is nominated by the host, never by command arguments. Retaining this opaque
  // POSIX authority keeps the output's same-filesystem parent route in one publication admission.
  const scratchAuthority = await createTrustedWorkspaceAnchor(resolve(input.scratchRoot));
  await withTrustedWorkspaceAnchor(scratchAuthority, publish);
}

/** Write exactly the self-contained bundle and receipt before the sole public-directory rename. */
async function stageSupportBundle(
  transaction: OutputDirectoryTransaction,
  bundleBytes: Buffer,
  receiptBytes: Buffer
): Promise<OutputDirectoryTransactionExpectedInventory> {
  const staged = new Map<string, Buffer>([
    [SUPPORT_BUNDLE_FILES[0], bundleBytes],
    [SUPPORT_BUNDLE_FILES[1], receiptBytes]
  ]);
  for (const [name, bytes] of staged) {
    await writeVerifiedBoundedFile(join(transaction.stagingPath, name), bytes, {
      label: "Support bundle staging entry",
      maxBytes: bytes.byteLength,
      withinRoot: transaction.stagingPath,
      expectedSha256: hashBuffer(bytes)
    });
  }
  await transaction.assertCurrent();
  const entries = await readdir(transaction.stagingPath, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== SUPPORT_BUNDLE_FILES.length || names.some((name, index) => name !== SUPPORT_BUNDLE_FILES[index])) {
    throw new Error("Support bundle staging inventory must contain exactly the bundle and its receipt.");
  }
  const expectedInventory: Array<{ path: string; sha256: string; byteLength: number }> = [];
  for (const [name, bytes] of staged) {
    const verified = await readBoundedStableFile(join(transaction.stagingPath, name), {
      label: "Support bundle staging entry",
      maxBytes: bytes.byteLength,
      withinRoot: transaction.stagingPath,
      requireSingleLink: true,
      captureIdentity: true
    });
    if (verified.byteLength !== bytes.byteLength || verified.sha256 !== hashBuffer(bytes)) {
      throw new Error("Support bundle staging file bytes did not match the assembled payload.");
    }
    expectedInventory.push({ path: name, sha256: verified.sha256, byteLength: verified.byteLength });
  }
  const finalNames = (await readdir(transaction.stagingPath, { withFileTypes: true })).map((entry) => entry.name).sort();
  if (finalNames.length !== SUPPORT_BUNDLE_FILES.length || finalNames.some((name, index) => name !== SUPPORT_BUNDLE_FILES[index])) {
    throw new Error("Support bundle staging inventory changed while its files were verified.");
  }
  await transaction.assertCurrent();
  return expectedInventory;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** A user-visible preflight only; the transaction independently retains absence until commit. */
async function outputPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function supportBundleFailure(error: unknown): MotionDebugResult {
  if (isPublicationCommitUncertain(error)) {
    const uncertainty = corePublicationUncertainty(error)!;
    return {
      ok: false,
      error: { code: error.code, message: error.message, detail: uncertainty },
      result: uncertainty,
      warnings: []
    };
  }
  return {
    ok: false,
    error: { code: "support_bundle_failed", message: error instanceof Error ? error.message : String(error) },
    warnings: []
  };
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
