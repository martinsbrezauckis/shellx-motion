import { hashBuffer, isPublicationCommitUncertain, type MotionPackage, type OperationReceipt, type RetainedDirectoryAuthority } from "@shellx-motion/core";
import { resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { nonNegativeIntegerArg, objectArg, stringArg, stringArrayArg } from "./args.js";
import { dispatchWorkspacePackagePatch, type WorkspacePackagePatchServices } from "./workspace-package-patch.js";
import { dispatchWorkspacePackageAssetImport, type WorkspacePackageAssetImportServices } from "./workspace-package-asset-import.js";
import { dispatchWorkspaceSupportCommand, type WorkspaceSupportServices } from "./workspace-support.js";
import { validateWorkspacePackage } from "./workspace-validation.js";
import type { WorkspaceReceiptEntry } from "./workspace-types.js";

export type { WorkspaceReceiptEntry } from "./workspace-types.js";

export interface WorkspacePackageBrowser {
  roots: string[];
  packageCount: number;
  templateCount: number;
  warnings: string[];
}

export interface WorkspaceDomainServices extends WorkspacePackagePatchServices, WorkspacePackageAssetImportServices, WorkspaceSupportServices {
  browsePackages?: (roots: string[]) => Promise<WorkspacePackageBrowser>;
  receiptsRoot?: string;
  listReceiptEntries?: (receiptsRoot: string) => Promise<WorkspaceReceiptEntry[]>;
  readReceiptEntryInsideRoot?: (receiptsRoot: string, receiptPath: string) => Promise<{
    insideRoot: boolean;
    entry: WorkspaceReceiptEntry | null;
  }>;
  summarizeReceipt?: (entry: WorkspaceReceiptEntry) => Record<string, unknown>;
  summarizeReceiptsPanel?: (entries: WorkspaceReceiptEntry[], limit: number) => Record<string, unknown>;
  archivePackage?: (input: { packageRoot: string; archivePath: string; receiptPath?: string }) => Promise<WorkspaceArchiveResult>;
  extractPackage?: (input: { archivePath: string; packageRoot: string; receiptPath?: string }) => Promise<WorkspaceExtractResult>;
  writeReviewBundle?: (input: { packageRoot?: string; receiptsRoot?: string; artifactRoots?: string[]; artifactRootAuthorities?: readonly RetainedDirectoryAuthority[]; outDir: string; title?: string }) => Promise<WorkspaceReviewBundleResult>;
  /**
   * Extra directories the HOST approved for review-bundle artifact copying. Never read from args:
   * see `artifactRoots` on MotionDebugContext for why a caller must not supply its own approvals.
   */
  artifactRoots?: string[];
  /** Startup-retained identities for long-lived host artifact roots. */
  artifactRootAuthorities?: readonly RetainedDirectoryAuthority[];
  /** Creates a new, valid, renderable package. The cold-start path an agent needs to begin at all. */
  createPackage?: (input: {
    packageRoot: string; name?: string; width?: number; height?: number;
    fps?: number; durationMs?: number; background?: string; empty?: boolean;
  }) => Promise<Record<string, unknown>>;
  /**
   * Loads the one package snapshot used for the complete `motion.package.validate` verdict and
   * its receipt. The domain deliberately does not pair it with a separate summary loader.
   *
   * The verdict is computed from this document itself, so a host cannot make an unrenderable
   * package pass by omitting a field from a separately supplied summary.
   */
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
}

interface WorkspaceArchiveResult {
  packageId: string;
  archivePath: string;
  receiptPath: string;
  fileCount: number;
  receipt: OperationReceipt;
}

interface WorkspaceExtractResult extends WorkspaceArchiveResult {
  packageRoot: string;
}

interface WorkspaceReviewBundleResult {
  packageId: string;
  htmlPath: string;
  receiptPath: string;
  receiptCount: number;
  copiedArtifactCount: number;
  /** Receipt-referenced artifacts left out because they resolved outside every approved root. */
  omittedArtifactCount: number;
  qualityGateCount: number;
  failedQualityGateCount: number;
  receipt: OperationReceipt;
}

export async function dispatchWorkspaceCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: WorkspaceDomainServices = {}
): Promise<MotionDebugResult | null> {
  const packageAssetImportResult = await dispatchWorkspacePackageAssetImport(command, args, services);
  if (packageAssetImportResult) return packageAssetImportResult;
  const packagePatchResult = await dispatchWorkspacePackagePatch(command, args, services);
  if (packagePatchResult) return packagePatchResult;
  const supportResult = await dispatchWorkspaceSupportCommand(command, args, services);
  if (supportResult) return supportResult;
  if (command === "motion.receipts.list") return listReceipts(args, services);
  if (command === "motion.receipts.panel") return receiptsPanel(args, services);
  if (command === "motion.receipts.read") return readReceipt(args, services);
  if (command === "motion.package.archive") return archivePackage(args, services);
  if (command === "motion.package.extract") return extractPackage(args, services);
  if (command === "motion.review.html.bundle") return reviewHtmlBundle(args, services);
  if (command === "motion.package.create") return await createPackageResult(args, services);
  if (command === "motion.package.validate") return validateWorkspacePackage(args, services);
  if (command !== "motion.packages.browse") return null;

  const record = objectArg(args);
  if (record && Object.hasOwn(record, "packageRoots") && !stringArrayArg(args, "packageRoots")) {
    return invalidArgs("motion.packages.browse packageRoots must be an array of strings.");
  }
  const roots = readPackageBrowserRoots(args);
  if (roots.length === 0) return invalidArgs("motion.packages.browse requires root, packageRoot, or packageRoots.");
  if (!services.browsePackages) return capabilityUnavailable("Motion package browsing is unavailable.");
  const browser = await services.browsePackages(roots);
  const receiptId = `packages-browse-${hashBuffer(Buffer.from(JSON.stringify(browser), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: {
      panel: "packages",
      operation: "packages.browse",
      rootCount: browser.roots.length,
      packageCount: browser.packageCount,
      warningCount: browser.warnings.length,
      templateCount: browser.templateCount
    },
    result: { ok: true, ...browser },
    warnings: browser.warnings
  };
}

async function archivePackage(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const archivePath = stringArg(args, "archivePath") ?? stringArg(args, "outPath") ?? stringArg(args, "out");
  const receiptPath = stringArg(args, "receiptPath") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.package.archive requires packageRoot.");
  if (!archivePath) return invalidArgs("motion.package.archive requires archivePath.");
  if (!services.archivePackage) return capabilityUnavailable("Motion package archive writing is unavailable.");
  try {
    const result = await services.archivePackage({ packageRoot, archivePath, ...(receiptPath ? { receiptPath } : {}) });
    return {
      ok: true,
      receiptId: result.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "package.archive",
        packageId: result.packageId,
        archivePath: result.archivePath,
        receiptPath: result.receiptPath,
        fileCount: result.fileCount
      },
      result,
      warnings: result.receipt.warnings
    };
  } catch (error) {
    return commandFailure("package_archive_failed", error);
  }
}

async function extractPackage(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  const archivePath = stringArg(args, "archivePath") ?? stringArg(args, "inPath") ?? stringArg(args, "archive");
  const packageRoot = stringArg(args, "packageRoot") ?? stringArg(args, "outDir") ?? stringArg(args, "out");
  const receiptPath = stringArg(args, "receiptPath") ?? undefined;
  if (!archivePath) return invalidArgs("motion.package.extract requires archivePath.");
  if (!packageRoot) return invalidArgs("motion.package.extract requires packageRoot.");
  if (!services.extractPackage) return capabilityUnavailable("Motion package archive extraction is unavailable.");
  try {
    const result = await services.extractPackage({ archivePath, packageRoot, ...(receiptPath ? { receiptPath } : {}) });
    return {
      ok: true,
      receiptId: result.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "package.archive.extract",
        packageId: result.packageId,
        archivePath: result.archivePath,
        packageRoot: result.packageRoot,
        receiptPath: result.receiptPath,
        fileCount: result.fileCount
      },
      result,
      warnings: result.receipt.warnings
    };
  } catch (error) {
    return commandFailure("package_extract_failed", error);
  }
}

async function reviewHtmlBundle(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot") ?? undefined;
  const outDir = stringArg(args, "outDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const title = stringArg(args, "title") ?? undefined;
  if (!outDir) return invalidArgs("motion.review.html.bundle requires outDir.");
  if (!services.writeReviewBundle) return capabilityUnavailable("Motion review bundle writing is unavailable.");
  try {
    const result = await services.writeReviewBundle({
      ...(packageRoot ? { packageRoot } : {}),
      ...(receiptsRoot ? { receiptsRoot } : {}),
      ...(services.artifactRoots && services.artifactRoots.length > 0 ? { artifactRoots: services.artifactRoots } : {}),
      ...(services.artifactRootAuthorities && services.artifactRootAuthorities.length > 0
        ? { artifactRootAuthorities: services.artifactRootAuthorities }
        : {}),
      outDir,
      ...(title ? { title } : {})
    });
    return {
      ok: true,
      receiptId: result.receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "review.html.bundle",
        packageId: result.packageId,
        htmlPath: result.htmlPath,
        receiptPath: result.receiptPath,
        receiptCount: result.receiptCount,
        copiedArtifactCount: result.copiedArtifactCount,
        // A bundle missing the renders it exists to show must say so where the caller is looking,
        // not only inside the result body.
        omittedArtifactCount: result.omittedArtifactCount,
        qualityGateCount: result.qualityGateCount,
        failedQualityGateCount: result.failedQualityGateCount
      },
      result,
      warnings: result.receipt.warnings
    };
  } catch (error) {
    return commandFailure("review_html_bundle_failed", error);
  }
}

async function listReceipts(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!receiptsRoot) return invalidArgs("motion.receipts.list requires receiptsRoot.");
  if (!services.listReceiptEntries || !services.summarizeReceipt) {
    return capabilityUnavailable("Motion receipt browsing is unavailable.");
  }
  const entries = await services.listReceiptEntries(receiptsRoot);
  const receipts = entries.map((entry) => services.summarizeReceipt!(entry));
  return {
    ok: true,
    visibleState: { panel: "receipts", receiptCount: receipts.length },
    result: { ok: true, receiptsRoot, receiptCount: receipts.length, receipts },
    warnings: []
  };
}

async function receiptsPanel(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const limit = nonNegativeIntegerArg(args, "limit");
  if (!receiptsRoot) return invalidArgs("motion.receipts.panel requires receiptsRoot.");
  if (limit === false) return invalidArgs("motion.receipts.panel limit must be a non-negative integer.");
  if (!services.listReceiptEntries || !services.summarizeReceiptsPanel) {
    return capabilityUnavailable("Motion receipt panel browsing is unavailable.");
  }
  const entries = await services.listReceiptEntries(receiptsRoot);
  const panel = services.summarizeReceiptsPanel(entries, limit ?? 10);
  return {
    ok: true,
    visibleState: {
      panel: "receipts",
      operation: "receipts.panel",
      receiptCount: numberField(panel, "receiptCount"),
      failedCount: numberField(panel, "failedCount"),
      warningCount: numberField(panel, "warningCount"),
      artifactCount: numberField(panel, "artifactCount")
    },
    result: { ok: true, receiptsRoot, ...panel },
    warnings: []
  };
}

async function readReceipt(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const receiptPath = stringArg(args, "receiptPath") ?? stringArg(args, "path");
  const receiptId = stringArg(args, "receiptId") ?? stringArg(args, "id");
  let entry: WorkspaceReceiptEntry | null = null;
  if (receiptPath) {
    if (!receiptsRoot) return invalidArgs("motion.receipts.read requires receiptsRoot when using receiptPath.");
    if (!services.readReceiptEntryInsideRoot) return capabilityUnavailable("Safe Motion receipt reading is unavailable.");
    const read = await services.readReceiptEntryInsideRoot(receiptsRoot, receiptPath);
    if (!read.insideRoot) return invalidArgs("motion.receipts.read receiptPath must be inside receiptsRoot.");
    entry = read.entry;
  } else if (receiptsRoot && receiptId) {
    if (!services.listReceiptEntries) return capabilityUnavailable("Motion receipt browsing is unavailable.");
    entry = (await services.listReceiptEntries(receiptsRoot)).find((candidate) => candidate.receipt.id === receiptId) ?? null;
  } else {
    return invalidArgs("motion.receipts.read requires receiptPath or receiptsRoot plus receiptId.");
  }
  if (!entry) {
    return {
      ok: false,
      error: {
        code: "receipt_not_found",
        message: receiptId ? `Receipt not found: ${receiptId}.` : `Receipt not found at path: ${receiptPath}.`
      },
      warnings: []
    };
  }
  return {
    ok: true,
    receiptId: entry.receipt.id,
    visibleState: {
      panel: "receipts",
      receiptId: entry.receipt.id,
      operation: entry.receipt.operation,
      status: entry.receipt.status
    },
    result: { ok: true, path: entry.path, receipt: entry.receipt },
    warnings: entry.receipt.warnings
  };
}

function numberField(record: Record<string, unknown>, key: string): number {
  return typeof record[key] === "number" ? record[key] : 0;
}

function readPackageBrowserRoots(args: unknown): string[] {
  const roots = [
    ...(stringArrayArg(args, "packageRoots") ?? []),
    stringArg(args, "packageRoot"),
    stringArg(args, "packagesRoot"),
    stringArg(args, "packageBrowserRoot"),
    stringArg(args, "root")
  ].filter((root): root is string => typeof root === "string" && root.length > 0);
  return [...new Set(roots.map((root) => resolve(root)))];
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


/**
 * Create a package from nothing.
 *
 * Reports `nextSteps` on success. A cold-start agent has just learned the command exists; telling it
 * what the second call should be is the difference between a usable entry point and a dead end —
 * the failure mode this command was added to fix was precisely "no idea where to begin".
 */
async function createPackageResult(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  if (!services.createPackage) return capabilityUnavailable("Motion package creation is unavailable on this host.");
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) {
    return invalidArgsWithAction(
      "motion.package.create requires packageRoot.",
      "Pass an empty or non-existent directory, for example { packageRoot: \"./my-piece\" }."
    );
  }
  const record = objectArg(args) ?? {};
  try {
    const created = await services.createPackage({
      packageRoot,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.width === "number" ? { width: record.width } : {}),
      ...(typeof record.height === "number" ? { height: record.height } : {}),
      ...(typeof record.fps === "number" ? { fps: record.fps } : {}),
      ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
      ...(typeof record.background === "string" ? { background: record.background } : {}),
      ...(typeof record.empty === "boolean" ? { empty: record.empty } : {})
    });
    return {
      ok: true,
      visibleState: { panel: "workspace", operation: "package.create", packageRoot },
      result: { ok: true, ...created },
      warnings: []
    };
  } catch (error) {
    if (isPublicationCommitUncertain(error)) return commandFailure("package_create_failed", error);
    // A non-empty directory and a bad dimension are both author mistakes with a clear fix, so the
    // message is surfaced verbatim rather than flattened into "package creation failed".
    return invalidArgsWithAction(
      error instanceof Error ? error.message : "Motion package could not be created.",
      "Choose an empty directory, or edit the existing package instead of creating one over it."
    );
  }
}

function invalidArgsWithAction(message: string, suggestedAction: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message, suggestedAction }, warnings: [] };
}
