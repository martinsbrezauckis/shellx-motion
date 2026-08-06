import { hashBuffer, loadSchema, unreadableKeyframesRefusal, unrenderablePackageRefusal, validateDocument, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { nonNegativeIntegerArg, objectArg, stringArg, stringArrayArg } from "./args.js";
import { dispatchWorkspacePackagePatch, type WorkspacePackagePatchServices } from "./workspace-package-patch.js";
import { dispatchWorkspaceSupportCommand, type WorkspaceSupportServices } from "./workspace-support.js";
import type { WorkspaceReceiptEntry } from "./workspace-types.js";

export type { WorkspaceReceiptEntry } from "./workspace-types.js";

export interface WorkspacePackageBrowser {
  roots: string[];
  packageCount: number;
  templateCount: number;
  warnings: string[];
}

export interface WorkspaceDomainServices extends WorkspacePackagePatchServices, WorkspaceSupportServices {
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
  writeReviewBundle?: (input: { packageRoot?: string; receiptsRoot?: string; artifactRoots?: string[]; outDir: string; title?: string }) => Promise<WorkspaceReviewBundleResult>;
  /**
   * Extra directories the HOST approved for review-bundle artifact copying. Never read from args:
   * see `artifactRoots` on MotionDebugContext for why a caller must not supply its own approvals.
   */
  artifactRoots?: string[];
  /** Creates a new, valid, renderable package. The cold-start path an agent needs to begin at all. */
  createPackage?: (input: {
    packageRoot: string; name?: string; width?: number; height?: number;
    fps?: number; durationMs?: number; background?: string; empty?: boolean;
  }) => Promise<Record<string, unknown>>;
  /** Structural check without rendering: the Debug API equivalent of the CLI's `validate`. */
  validatePackage?: (packageRoot: string) => Promise<Record<string, unknown>>;
  /**
   * Loads a package for the renderability half of `motion.package.validate`.
   *
   * Declared here rather than folded into `validatePackage`'s summary so the verdict is the
   * domain's, computed from the document itself: a host cannot make an unrenderable package pass by
   * omitting a field from the summary it returns.
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
  if (command === "motion.package.validate") return await validatePackageResult(args, services);
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
    // A non-empty directory and a bad dimension are both author mistakes with a clear fix, so the
    // message is surfaced verbatim rather than flattened into "package creation failed".
    return invalidArgsWithAction(
      error instanceof Error ? error.message : "Motion package could not be created.",
      "Choose an empty directory, or edit the existing package instead of creating one over it."
    );
  }
}

/**
 * Structured schema errors are capped in the answer so one malformed document cannot flood a
 * transport response. Matches the CLI's cap so both doors truncate at the same point.
 */
const MAX_REPORTED_SCHEMA_ERRORS = 50;

/**
 * Structural check without rendering.
 *
 * Rendering to find out whether a document is well-formed costs minutes and conflates two very
 * different failures — a malformed package and a package that renders badly.
 */
async function validatePackageResult(args: unknown, services: WorkspaceDomainServices): Promise<MotionDebugResult> {
  if (!services.validatePackage) return capabilityUnavailable("Motion package validation is unavailable on this host.");
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) {
    return invalidArgsWithAction("motion.package.validate requires packageRoot.", "Pass the directory holding manifest.json and motion.json.");
  }
  try {
    const summary = await services.validatePackage(packageRoot);
    // A package no lane can render is not a valid package. Answering `valid: true` and then failing
    // every preview and render is the worst answer this command can give: the caller is told the
    // document is sound and is left with nothing to act on when it will not draw. The verdict comes
    // from core's `unrenderablePackageRefusal`, which reads the renderer capability cards each
    // lane's own runtime gate is projected from — so this refusal and the lanes' refusal agree by
    // construction, not because two lists were kept in step by hand. The SDK's own `validate` calls
    // the same function, so the MCP and in-process surfaces cannot disagree about one directory.
    const motion = services.packageLoader ? (await services.packageLoader(packageRoot)).motion : null;
    const refusal = motion ? unrenderablePackageRefusal(motion) : null;
    if (refusal) {
      return {
        ok: false,
        error: {
          code: refusal.code,
          message: refusal.message,
          suggestedAction: refusal.suggestedAction
        },
        result: { valid: false, packageRoot, ...summary, unrenderableLayers: refusal.layers },
        warnings: []
      };
    }
    // A package whose keyframes the evaluator cannot read is not a valid package either, for exactly
    // the same reason: it renders "successfully" and animates nothing, and the author is told the
    // work landed. This is the defect that shipped a 15-second piece frozen for ~90% of its runtime
    // from 309 keyframes written as `{ t, v }` — every one of them dropped in silence while this
    // command answered `valid: true`. Same shared-check shape as the refusal above: the verdict is
    // core's `unreadableKeyframesRefusal`, built on the very predicate the timeline evaluator gates
    // on, so validate cannot pass what the evaluator will discard.
    const keyframeRefusal = motion ? unreadableKeyframesRefusal(motion) : null;
    if (keyframeRefusal) {
      return {
        ok: false,
        error: {
          code: keyframeRefusal.code,
          message: keyframeRefusal.message,
          suggestedAction: keyframeRefusal.suggestedAction
        },
        result: {
          valid: false,
          packageRoot,
          ...summary,
          unreadableKeyframeCount: keyframeRefusal.keyframeCount,
          totalKeyframeCount: keyframeRefusal.totalKeyframeCount,
          unreadableKeyframeTargetCount: keyframeRefusal.targetCount,
          unreadableKeyframes: keyframeRefusal.keyframes,
          unreadableKeyframesTruncated: keyframeRefusal.truncated
        },
        warnings: []
      };
    }
    // The schema verdict is the catch-all behind the two specialised refusals, not in front of them.
    //
    // Until this block existed, the command whose entire job is validation never ran the validator.
    // It loaded the package — `loadMotionPackage` reads shape, it does not validate — and returned
    // metadata, so `motion.package.validate` could answer `valid: true` for a document
    // `validateDocument` rejects outright.
    // Every MUTATION path in this package (workspace-package-patch, timeline-package-edit,
    // authoring-procedural) had always validated. Only this one did not, which converted
    // "unchecked" into "checked and sound" — the one lie an agent has no way to detect.
    //
    // LAST, deliberately. The intuitive ordering — schema first, because the specialised checks read
    // fields by name — was tried and is wrong: it makes the general checker SHADOW the specific one.
    // A package storing keyframes as `{ t, v }` fails the schema too, so schema-first replaces
    // "4 of 4 keyframes cannot be read by the timeline evaluator" plus the exact JSON pointers with
    // "Motion document does not satisfy shellx-motion/motion@1: 2 error(s)." That is a strictly
    // worse answer about the same defect: `unreadableKeyframesRefusal` EXISTS to diagnose malformed
    // keyframes, so it is the check that handles that case best. The schema's job is what the other
    // two do not cover — colours, ranges, enums, environment structure, timing — which is exactly
    // the Grok case, where the layers render fine and the keyframes read fine and only an
    // environment colour is wrong. Same reasoning is recorded in `packages/cli/src/package-refusals.ts`.
    //
    // Same `invalid_motion_document` code and same `schemaErrors` shape as
    // `packageValidationRefusal` in the CLI, so an agent gets ONE answer whichever door it knocks on.
    const schema = motion ? await validateDocument(await loadSchema("motion"), motion) : null;
    if (schema && !schema.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_motion_document",
          message: `Motion document does not satisfy shellx-motion/motion@1: ${schema.errors.length} error(s).`,
          suggestedAction: "Correct the paths listed in schemaErrors. Each path is a JSON pointer into motion.json."
        },
        result: {
          valid: false,
          packageRoot,
          ...summary,
          schemaErrorCount: schema.errors.length,
          schemaErrors: schema.errors.slice(0, MAX_REPORTED_SCHEMA_ERRORS),
          schemaErrorsTruncated: schema.errors.length > MAX_REPORTED_SCHEMA_ERRORS
        },
        warnings: []
      };
    }
    return {
      ok: true,
      visibleState: { panel: "workspace", operation: "package.validate", packageRoot },
      result: { ok: true, valid: true, packageRoot, ...summary },
      warnings: []
    };
  } catch (error) {
    // The loader's message names the offending field; that is the actionable part, so it is the
    // message rather than a detail buried under a generic one.
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : "Motion package is not valid.",
        suggestedAction: "Fix the named field in motion.json or manifest.json, then validate again."
      },
      result: { valid: false, packageRoot },
      warnings: []
    };
  }
}

function invalidArgsWithAction(message: string, suggestedAction: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message, suggestedAction }, warnings: [] };
}
