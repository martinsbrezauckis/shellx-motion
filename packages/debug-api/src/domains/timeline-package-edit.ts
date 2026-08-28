/** Shared capability-gated executor for atomic timeline package mutations. */
import {
  hashBuffer,
  hashPackageFile,
  isPublicationCommitUncertain,
  loadSchema,
  motionLayoutGapAnimationStorePresent,
  resolvePackageAsset,
  validateDocument,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";
import {
  assertConfiguredAuthoringInputRoot,
  assertConfiguredAuthoringOutputRoot
} from "./authoring-root-policy.js";
import {
  C2_LAYOUT_GAP_ANIMATION_CONTINUATION,
  commitMotionDocumentEdit,
  PackageEditTransactionError,
  type LayoutGapAnimationContinuationAdmission,
  type MotionDocumentHostAuthorityPair,
  type MotionDocumentHostReceiptCommit,
} from "./package-edit-transaction.js";

export interface TimelinePackageEditServices {
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export interface TimelineCommonEditArgs {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
}

export interface AtomicTimelineMutation<T extends { motion: MotionDocument }> extends TimelineCommonEditArgs {
  command: MotionDebugCommand;
  receiptPrefix: string;
  receiptFileName: string;
  invalidCode: string;
  failureCode: string;
  services: TimelinePackageEditServices;
  additionalInputHashes?: (pkg: MotionPackage) => Promise<Record<string, string>>;
  mutate: (pkg: MotionPackage) => T | Promise<T>;
  outputFacts: (mutation: T) => Record<string, unknown>;
  resultFacts: (mutation: T) => Record<string, unknown>;
  visibleFacts: (mutation: T) => Record<string, unknown>;
  /**
   * Internal, post-mutation diagnostics to preserve in the one outer receipt.
   * Omitted callers retain the historical passed/no-warning outcome.
   */
  receiptWarnings?: (mutation: T) => readonly string[];
  /** Layout-only deterministic receipt identity; omitted callers retain legacy receipt IDs. */
  receiptId?: (input: { pkg: MotionPackage; mutation: T; inputHashes: Record<string, string>; output: Record<string, unknown>; warnings: readonly string[] }) => string;
  /** Replaces generic host receipt persistence for a bounded mutation family. */
  hostReceiptCommit?: (input: { pkg: MotionPackage; mutation: T; receipt: OperationReceipt }) => (commit: MotionDocumentHostReceiptCommit) => Promise<string>;
  /** Static layout and C2 prepare durable authority before COW installation, then journal-finalize it. */
  hostAuthorityPair?: (input: { pkg: MotionPackage; mutation: T; receipt: OperationReceipt }) => MotionDocumentHostAuthorityPair;
  /** Internal marker: only C2’s typed lifecycle may continue a package with an active gap root. */
  layoutGapAnimationContinuation?: LayoutGapAnimationContinuationAdmission;
}

export async function commitAtomicTimelineMutation<T extends { motion: MotionDocument }>(
  input: AtomicTimelineMutation<T>
): Promise<MotionDebugResult> {
  const { services } = input;
  try {
    await assertConfiguredAuthoringInputRoot(
      input.packageRoot,
      services.authoringInputRoots,
      `${input.command} packageRoot`
    );
    const pkg = await services.packageLoader!(input.packageRoot);
    await assertConfiguredAuthoringInputRoot(
      pkg.root,
      services.authoringInputRoots,
      `${input.command} loaded package`
    );
    if (motionLayoutGapAnimationStorePresent(pkg.motion)
      && input.layoutGapAnimationContinuation !== C2_LAYOUT_GAP_ANIMATION_CONTINUATION) {
      throw new PackageEditTransactionError("layout_gap_animation_active", "remove layout gap track first");
    }
    const packageOutDir = resolve(input.outDir);
    await assertConfiguredAuthoringOutputRoot(
      packageOutDir,
      services.authoringOutputRoots,
      `${input.command} outDir`
    );
    if (await services.isUnsafePackageOutputDirectory!(pkg.root, packageOutDir)) {
      return invalidArgs(`${input.command} outDir must be outside packageRoot.`);
    }
    if (!await services.isEmptyOrAbsentDirectory!(packageOutDir)) {
      return invalidArgs(`${input.command} outDir must be empty or absent before package copy.`);
    }
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion))
    };
    if (input.additionalInputHashes) Object.assign(inputHashes, await input.additionalInputHashes(pkg));
    const mutation = await input.mutate(pkg);
    const validation = await validateDocument(await loadSchema("motion"), mutation.motion);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: input.invalidCode,
          message: "Patched Motion document failed validation.",
          suggestedAction: validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")
        },
        warnings: []
      };
    }
    const manifestPath = join(packageOutDir, "manifest.json");
    const motionPath = join(packageOutDir, pkg.manifest.motion);
    const receiptWarnings = input.receiptWarnings ? [...input.receiptWarnings(mutation)] : [];
    if (receiptWarnings.some((warning) => typeof warning !== "string" || !warning.trim())) {
      throw new Error("Atomic timeline mutation receipt warnings must be non-empty strings.");
    }
    const output = {
      packageDir: packageOutDir,
      manifestPath,
      motionPath,
      ...input.outputFacts(mutation),
      validation,
      ...(input.createdBy ? { createdBy: input.createdBy } : {})
    };
    const defaultReceiptId = `${input.receiptPrefix}-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output, warnings: receiptWarnings }), "utf8")).slice(0, 16)}`;
    const receiptId = input.receiptId?.({ pkg, mutation, inputHashes, output, warnings: receiptWarnings }) ?? defaultReceiptId;
    if (typeof receiptId !== "string" || !receiptId || receiptId.length > 128) {
      throw new Error("Atomic timeline mutation receipt id must be a 1..128-character string.");
    }
    const receiptPath = join(packageOutDir, "receipts", input.receiptFileName);
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: packageOutDir, status: "available", mediaType: "application/vnd.shellx-motion.package+directory", primary: true },
      { role: "timeline_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: receiptId,
      operation: input.command.replace("motion.", ""),
      status: receiptWarnings.length ? "warning" : "passed",
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      artifacts,
      warnings: receiptWarnings
    };
    // Revalidate immediately before the transaction creates or publishes any output. The earlier
    // check protects argument handling; this check closes a replacement between mutation work and
    // the package-copy sink.
    await assertConfiguredAuthoringInputRoot(
      pkg.root,
      services.authoringInputRoots,
      `${input.command} loaded package`
    );
    await assertConfiguredAuthoringOutputRoot(
      packageOutDir,
      services.authoringOutputRoots,
      `${input.command} outDir`
    );
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot: packageOutDir,
      authoringInputRoots: services.authoringInputRoots,
      authoringOutputRoots: services.authoringOutputRoots,
      patchedMotion: mutation.motion,
      receipt,
      receiptFileName: input.receiptFileName,
      ...(input.layoutGapAnimationContinuation === C2_LAYOUT_GAP_ANIMATION_CONTINUATION
        ? { layoutGapAnimationContinuation: C2_LAYOUT_GAP_ANIMATION_CONTINUATION }
        : {}),
      ...(input.hostReceiptCommit && input.receiptsRoot
        ? { receiptsRoot: input.receiptsRoot, hostReceiptCommit: input.hostReceiptCommit({ pkg, mutation, receipt }) }
        : input.hostAuthorityPair && input.receiptsRoot
          ? { receiptsRoot: input.receiptsRoot, hostAuthorityPair: input.hostAuthorityPair({ pkg, mutation, receipt }) }
        : input.receiptsRoot ? { receiptsRoot: input.receiptsRoot, writeHostReceipt: services.writeReceipt! } : {})
    });
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "timeline",
        operation: receipt.operation,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        packageDir: packageOutDir,
        ...input.visibleFacts(mutation),
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
      },
      result: {
        ok: true,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        packageDir: packageOutDir,
        manifestPath,
        motionPath,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
        ...input.resultFacts(mutation),
        validation,
        motion: mutation.motion,
        receipt
      },
      warnings: receiptWarnings
    };
  } catch (error) {
    return commandFailure(input.failureCode, error);
  }
}

export function readTimelineCommonEditArgs(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelinePackageEditServices
): TimelineCommonEditArgs | MotionDebugResult {
  return readTimelineCommonEditArgsWithReceiptRoot(command, args, services, stringArg(args, "receiptsRoot") ?? services.receiptsRoot);
}

/**
 * For command families whose public schemas deliberately omit receiptsRoot.
 * The receipt destination is chosen by the trusted host service, never data
 * supplied by the caller.
 */
export function readHostConfiguredTimelineCommonEditArgs(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelinePackageEditServices,
): TimelineCommonEditArgs | MotionDebugResult {
  return readTimelineCommonEditArgsWithReceiptRoot(command, args, services, services.receiptsRoot);
}

function readTimelineCommonEditArgsWithReceiptRoot(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelinePackageEditServices,
  receiptsRoot: string | undefined,
): TimelineCommonEditArgs | MotionDebugResult {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!outDir) return invalidArgs(`${command} requires outDir.`);
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return capabilityUnavailable("Atomic timeline package editing is unavailable.");
  }
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Timeline edit receipt persistence is unavailable.");
  return { packageRoot, outDir, ...(receiptsRoot ? { receiptsRoot } : {}), ...(createdBy ? { createdBy } : {}) };
}

export function isTimelineCommonEditResult(
  value: TimelineCommonEditArgs | MotionDebugResult
): value is MotionDebugResult {
  return "ok" in value;
}

export function timelineMutationFacts<T extends { motion: MotionDocument }>(mutation: T): Omit<T, "motion"> {
  const { motion: _motion, ...facts } = mutation;
  return facts;
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
