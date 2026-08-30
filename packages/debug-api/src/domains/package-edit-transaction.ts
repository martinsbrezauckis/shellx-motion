import {
  compileMotionDocumentCompositing,
  canonicalJsonSha256,
  hashBuffer,
  hashPackageFile,
  isPublicationCommitUncertain,
  loadMotionPackage,
  motionLayoutGapAnimationStorePresent,
  resolvePackageAsset,
  type StableFileIdentity,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import { chmod, cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PackageEditTransactionError } from "./package-edit-transaction-error.js";
import { copyVerifiedAsset } from "./package-edit-verified-asset-copy.js";
import { PackageEditWorkspace } from "./package-edit-transaction-workspace.js";
import type { PackageEditClosedInventoryMode } from "./package-edit-closed-inventory.js";
import { samePackageEditTreeIdentitySnapshot, samePackageEditTreeSnapshot, snapshotPackageEditTree } from "./package-edit-tree-snapshot.js";
import { assertConfiguredAuthoringPackageEditRoots } from "./authoring-root-policy.js";
import type { PreparedImmutableJsonPair } from "./timeline-layout-application-authority-store.js";

export { PackageEditTransactionError, type PackageEditTransactionErrorCode } from "./package-edit-transaction-error.js";

export interface PackageEditTransactionOptions<T, U = undefined> {
  sourceRoot: string;
  outputRoot: string;
  /** Operations that create a package receipt may require a never-before-existing destination. */
  requireAbsentOutput?: boolean;
  /**
   * Internal host COW opt-in: once `edit` resolves, pin the complete staged tree through Core's
   * descriptor-relative closed inventory before any public installation.  This accepts no caller
   * inventory, stage callback, or race hook; any later stage mutation is refused.
   */
  closedInventory?: PackageEditClosedInventoryMode;
  edit: (stagedRoot: string) => Promise<T>;
  validate?: (stagedRoot: string, editResult: T) => Promise<void>;
  /** Last non-mutating checkpoint before the output claim/irreversible package swap. */
  beforeCommit?: (stagedRoot: string, editResult: T) => Promise<void>;
  afterCommit?: (outputRoot: string, editResult: T) => Promise<U>;
  /** Private transaction outcome hook for host authority that survives an unsafe rollback. */
  onRollbackResult?: (result: "restored" | "unproven") => void;
  /**
   * Private admission token for the six C2 layout-gap lifecycle commands.  It is never derived
   * from a command argument: C2 carries its continuation proof separately in its host callback.
   */
  layoutGapAnimationContinuation?: LayoutGapAnimationContinuationAdmission;
}

const layoutGapAnimationContinuationAdmission: unique symbol = Symbol("layout-gap-animation-continuation-admission");

export interface LayoutGapAnimationContinuationAdmission {
  readonly [layoutGapAnimationContinuationAdmission]: "c2-host-authorized";
}

/** Internal-only transaction admission, imported only by the typed C2 authoring vertical. */
export const C2_LAYOUT_GAP_ANIMATION_CONTINUATION: LayoutGapAnimationContinuationAdmission = Object.freeze({
  [layoutGapAnimationContinuationAdmission]: "c2-host-authorized" as const,
});

export interface PackageEditTransactionResult<T, U> {
  outputRoot: string;
  editResult: T;
  afterCommitResult: U;
}

export interface NewPackageTransactionOptions<T, U = undefined> {
  outputRoot: string;
  build: (stagedRoot: string) => Promise<T>;
  validate?: (stagedRoot: string, buildResult: T) => Promise<void>;
  beforeCommit?: (stagedRoot: string, buildResult: T) => Promise<void>;
  afterCommit?: (outputRoot: string, buildResult: T) => Promise<U>;
}

export async function commitNewPackage<T, U = undefined>(
  options: NewPackageTransactionOptions<T, U>
): Promise<PackageEditTransactionResult<T, U>> {
  const workspace = await PackageEditWorkspace.create(options.outputRoot, "new");
  const outputRoot = workspace.outputRoot;
  let initialOutput: Awaited<ReturnType<typeof workspace.inspectOutput>> | undefined;
  let installedIdentity: Awaited<ReturnType<typeof workspace.install>> | undefined;
  let cleanupStage = true;
  try {
    initialOutput = await workspace.inspectOutput();
    await mkdir(workspace.stagedPackageRoot, { mode: 0o700 });
    const buildResult = await options.build(workspace.stagedPackageRoot);
    const stagedBuild = await snapshotPackageEditTree(workspace.stagedPackageRoot);
    if (options.validate) await options.validate(workspace.stagedPackageRoot, buildResult);
    const stagedValidated = await snapshotPackageEditTree(workspace.stagedPackageRoot);
    if (!samePackageEditTreeSnapshot(stagedBuild, stagedValidated)) {
      throw new PackageEditTransactionError("source_changed", "New package validation changed staged package bytes.");
    }
    if (options.beforeCommit) await options.beforeCommit(workspace.stagedPackageRoot, buildResult);
    const stagedBeforeCommit = await snapshotPackageEditTree(workspace.stagedPackageRoot);
    if (!samePackageEditTreeSnapshot(stagedBuild, stagedBeforeCommit)) {
      throw new PackageEditTransactionError("source_changed", "New package staging changed before output claim.");
    }

    await workspace.claimOutput(initialOutput);

    const stagedAtInstall = await snapshotPackageEditTree(workspace.stagedPackageRoot);
    if (!samePackageEditTreeSnapshot(stagedBuild, stagedAtInstall)) {
      throw new PackageEditTransactionError("source_changed", "New package staging changed during output claim.");
    }
    installedIdentity = await workspace.install();
    let afterCommitResult: U = undefined as U;
    if (options.afterCommit) afterCommitResult = await options.afterCommit(outputRoot, buildResult);
    return { outputRoot, editResult: buildResult, afterCommitResult };
  } catch (error) {
    try { await workspace.rollback(installedIdentity, initialOutput); } catch (rollbackError) {
      cleanupStage = false;
      throw rollbackError;
    }
    throw error;
  } finally {
    if (cleanupStage) await workspace.cleanup();
  }
}

export interface MotionDocumentEditOptions {
  sourcePackage: MotionPackage;
  outputRoot: string;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  patchedMotion: MotionDocument;
  patchedManifest?: MotionPackage["manifest"];
  stagedFiles?: Array<{
    sourcePath: string;
    targetAssetRef: string;
    expectedSha256: string;
    /** Present only for pre-admitted external imports; it pins COW to that exact source leaf. */
    sourceRoot?: string;
    expectedByteLength?: number;
    expectedIdentity?: StableFileIdentity;
  }>;
  validateStagedSource?: (stagedPackage: MotionPackage) => Promise<void>;
  /** Optional operation-specific proof over the fully staged output package before publication. */
  validateStagedPackage?: (stagedPackage: MotionPackage) => Promise<void>;
  receipt: OperationReceipt; receiptFileName: string;
  receiptsRoot?: string;
  writeHostReceipt?: (receiptsRoot: string, receipt: OperationReceipt) => Promise<string>;
  /** Layout-only hosts may atomically persist extra immutable authority state after install. */
  hostReceiptCommit?: (input: MotionDocumentHostReceiptCommit) => Promise<string>;
  /**
   * Shared static-layout/C2 pair lifecycle. Preparation is durable before COW installation;
   * finalization links the journal only after the installed output re-proves its expected lineage.
   */
  hostAuthorityPair?: MotionDocumentHostAuthorityPair;
  /** Internal C2-only admission passed through to the sole package COW boundary. */
  layoutGapAnimationContinuation?: LayoutGapAnimationContinuationAdmission;
}

export interface MotionDocumentHostReceiptCommit {
  receiptsRoot: string;
  packageRoot: string;
  manifestPath: string;
  motionPath: string;
  /** Canonical SHA-256 of the exact post-compositing Motion object persisted by the transaction. */
  persistedMotionSha256: string;
  receipt: OperationReceipt;
}

export interface MotionDocumentHostReceiptPreparation {
  receiptsRoot: string;
  stagedPackageRoot: string;
  expectedPackageRoot: string;
  manifestPath: string;
  motionPath: string;
  persistedMotionSha256: string;
  receipt: OperationReceipt;
}

export interface MotionDocumentHostAuthorityPair {
  prepare(input: MotionDocumentHostReceiptPreparation): Promise<PreparedImmutableJsonPair>;
  finalize(
    prepared: PreparedImmutableJsonPair,
    commit: MotionDocumentHostReceiptCommit,
  ): Promise<string>;
  abort(prepared: PreparedImmutableJsonPair): Promise<void>;
}

export interface MotionDocumentEditResult {
  packageRoot: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  hostReceiptPath?: string;
}

export async function commitMotionDocumentEdit(options: MotionDocumentEditOptions): Promise<MotionDocumentEditResult> {
  const packageRoot = resolve(options.outputRoot);
  // Match `commitPackageEdit`'s same-filesystem workspace route before authority preparation.
  // The outward result intentionally retains `packageRoot` for SDK spelling compatibility.
  const canonicalPackageRoot = await canonicalPathForSafety(packageRoot);
  await assertConfiguredAuthoringPackageEditRoots(
    options.sourcePackage.root,
    packageRoot,
    options.authoringInputRoots,
    options.authoringOutputRoots,
  );
  const manifestPath = join(packageRoot, "manifest.json");
  const motionPath = join(packageRoot, options.sourcePackage.manifest.motion);
  const receiptPath = join(packageRoot, "receipts", options.receiptFileName);
  // Every authoring family edits the preserved source layers. Recompile an attached graph at the
  // transaction boundary so timeline/keying/tracking/procedural edits cannot leave renderer-visible
  // generated layers stale while retaining apparently current compile metadata.
  const persistedMotion = compileMotionDocumentCompositing(options.patchedMotion);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(persistedMotion)) !== canonicalJsonSha256(persistedMotion)) {
    throw new PackageEditTransactionError("copy_mismatch", "Motion compositing compilation is not idempotent before package persistence.");
  }
  const persistedMotionSha256 = canonicalJsonSha256(persistedMotion);
  let preparedAuthority: PreparedImmutableJsonPair | undefined;
  let packageRollbackResult: "restored" | "unproven" | undefined;
  try {
    const transaction = await commitPackageEdit({
    sourceRoot: options.sourcePackage.root,
    outputRoot: packageRoot,
    ...(options.layoutGapAnimationContinuation === C2_LAYOUT_GAP_ANIMATION_CONTINUATION
      ? { layoutGapAnimationContinuation: C2_LAYOUT_GAP_ANIMATION_CONTINUATION }
      : {}),
    edit: async (stagedRoot) => {
      const stagedPkg = await loadMotionPackage(stagedRoot);
      assertParsedPackageIdentity(options.sourcePackage, stagedPkg);
      await assertReceiptInputHashes(options.receipt, stagedPkg); if (options.validateStagedSource) await options.validateStagedSource(stagedPkg);
      for (const file of options.stagedFiles ?? []) await copyVerifiedAsset(stagedRoot, file);
      if (options.patchedManifest) await writeJson(join(stagedRoot, "manifest.json"), options.patchedManifest);
      await writeJson(join(stagedRoot, stagedPkg.manifest.motion), persistedMotion);
      await writeJson(join(stagedRoot, "receipts", options.receiptFileName), options.receipt);
    },
    validate: async (stagedRoot) => {
      const stagedPkg = await loadMotionPackage(stagedRoot);
      if (jsonHash(stagedPkg.motion) !== jsonHash(persistedMotion)) {
        throw new PackageEditTransactionError("copy_mismatch", "Staged package edit did not preserve the validated Motion document.");
      }
      if (options.patchedManifest && jsonHash(stagedPkg.manifest) !== jsonHash(options.patchedManifest)) {
        throw new PackageEditTransactionError("copy_mismatch", "Staged package edit did not preserve the validated package manifest.");
      }
      if (options.validateStagedPackage) await options.validateStagedPackage(stagedPkg);
    },
    beforeCommit: async (stagedRoot) => {
      if (!options.hostAuthorityPair) return;
      if (!options.receiptsRoot) {
        throw new PackageEditTransactionError("copy_mismatch", "Layout authority preparation requires a host receipts root.");
      }
      preparedAuthority = await options.hostAuthorityPair.prepare({
        receiptsRoot: options.receiptsRoot,
        stagedPackageRoot: stagedRoot,
        expectedPackageRoot: canonicalPackageRoot,
        manifestPath: join(stagedRoot, "manifest.json"),
        motionPath: join(stagedRoot, options.sourcePackage.manifest.motion),
        persistedMotionSha256,
        receipt: options.receipt,
      });
    },
    afterCommit: async (outputRoot) => {
      if (!options.receiptsRoot) return undefined;
      const hostCommit = {
        receiptsRoot: options.receiptsRoot,
        packageRoot: outputRoot,
        manifestPath: join(outputRoot, "manifest.json"),
        motionPath: join(outputRoot, options.sourcePackage.manifest.motion),
        persistedMotionSha256,
        receipt: options.receipt,
      };
      if (options.hostAuthorityPair) {
        if (!preparedAuthority) throw new PackageEditTransactionError("copy_mismatch", "Layout authority pair was not prepared before output installation.");
        return await options.hostAuthorityPair.finalize(preparedAuthority, hostCommit);
      }
      if (options.hostReceiptCommit) return await options.hostReceiptCommit(hostCommit);
      return options.writeHostReceipt ? await options.writeHostReceipt(options.receiptsRoot, options.receipt) : undefined;
    },
    onRollbackResult: (result) => {
      packageRollbackResult = result;
    },
    });
    return {
      packageRoot,
      manifestPath,
      motionPath,
      receiptPath,
      ...(transaction.afterCommitResult ? { hostReceiptPath: transaction.afterCommitResult } : {})
    };
  } catch (error) {
    if (preparedAuthority && packageRollbackResult !== "unproven") {
      await options.hostAuthorityPair?.abort(preparedAuthority).catch(() => {});
    }
    throw error;
  }
}

export async function commitPackageEdit<T, U = undefined>(
  options: PackageEditTransactionOptions<T, U>
): Promise<PackageEditTransactionResult<T, U>> {
  const sourceRoot = resolve(options.sourceRoot);
  const requestedOutput = resolve(options.outputRoot);
  const [canonicalSource, canonicalOutput] = await Promise.all([
    realpath(sourceRoot),
    canonicalPathForSafety(requestedOutput)
  ]);
  if (isPathInsideOrEqual(canonicalSource, canonicalOutput) || isPathInsideOrEqual(canonicalOutput, canonicalSource)) {
    throw new PackageEditTransactionError("unsafe_output", "Package edit output must be outside the source package.");
  }

  // Refuse links and special leaves before any package document is opened. The second snapshot
  // closes the ordinary load race before output authority or staging is acquired; the transaction
  // repeats the same proof after its private copy and again before publication.
  const sourceBefore = await snapshotPackageEditTree(sourceRoot);

  // This is the sole package COW admission point.  A source with an active C2 root may only
  // advance through the typed C2 continuation vertical; every other writer would otherwise
  // publish a new package lineage while stranding C2's host-owned successor authority.
  const sourcePackage = await loadMotionPackage(sourceRoot);
  const sourceAfterLoad = await snapshotPackageEditTree(sourceRoot);
  if (!samePackageEditTreeSnapshot(sourceBefore, sourceAfterLoad)) {
    throw new PackageEditTransactionError("source_changed", "Source package changed while it was being admitted for editing.");
  }
  if (motionLayoutGapAnimationStorePresent(sourcePackage.motion)
    && options.layoutGapAnimationContinuation !== C2_LAYOUT_GAP_ANIMATION_CONTINUATION) {
    throw new PackageEditTransactionError("layout_gap_animation_active", "remove layout gap track first");
  }

  // This edit boundary has already resolved the caller spelling to its canonical destination for
  // the overlap check above.  Stage and publish through that canonical route so a trusted SDK
  // path alias cannot turn the retained topology into a lexical symlink traversal later on.
  // `commitMotionDocumentEdit` still returns its caller-facing spelling for SDK compatibility.
  const workspace = await PackageEditWorkspace.create(canonicalOutput, "edit", {
    closedInventory: options.closedInventory
  });
  const outputRoot = workspace.outputRoot;
  let initialOutput: Awaited<ReturnType<typeof workspace.inspectOutput>> | undefined;
  let installedIdentity: Awaited<ReturnType<typeof workspace.install>> | undefined;
  let cleanupStage = true;
  try {
    initialOutput = await workspace.inspectOutput();
    if (options.requireAbsentOutput && initialOutput.exists) {
      throw new PackageEditTransactionError("output_not_empty", "Package edit output must be absent for this operation.");
    }
    await cp(sourceRoot, workspace.stagedPackageRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
    // `cp` preserves the source root's mode.  Only the explicit descriptor-pinned mode needs a
    // private stage; legacy package edits retain their existing staging behavior unchanged.
    if (options.closedInventory) {
      await chmod(workspace.stagedPackageRoot, 0o700);
    }
    const stagedBefore = await snapshotPackageEditTree(workspace.stagedPackageRoot);
    if (!samePackageEditTreeSnapshot(sourceBefore, stagedBefore)) {
      throw new PackageEditTransactionError("copy_mismatch", "Staged package bytes do not match the source package snapshot.");
    }

    const editResult = await options.edit(workspace.stagedPackageRoot);
    if (options.closedInventory) {
      await workspace.pinCompleteStagedInventory();
    }
    const stagedAfterEdit = options.closedInventory
      ? undefined
      : await snapshotPackageEditTree(workspace.stagedPackageRoot);
    if (options.validate) await options.validate(workspace.stagedPackageRoot, editResult);
    const stagedAfterValidation = options.closedInventory
      ? undefined
      : await snapshotPackageEditTree(workspace.stagedPackageRoot);
    if (stagedAfterEdit && stagedAfterValidation && !samePackageEditTreeIdentitySnapshot(stagedAfterEdit, stagedAfterValidation)) {
      throw new PackageEditTransactionError("source_changed", "Package edit validation changed staged package bytes or identity.");
    }
    const sourceAfter = await snapshotPackageEditTree(sourceRoot);
    if (!samePackageEditTreeSnapshot(sourceBefore, sourceAfter)) {
      throw new PackageEditTransactionError("source_changed", "Source package changed while the edit transaction was running.");
    }

    // An opted-in pin is final only after validation and source stability have completed.  This
    // leaves no callable mutation capability after pinning: any later write is an exact-inventory
    // refusal before public output is claimed, then again immediately before the final rename.
    if (options.closedInventory) {
      await workspace.assertPinnedStagedInventoryCurrent();
    }

    // Claim a valid pre-existing empty destination before durable host authority preparation.
    // The workspace preserves it in its private reservation and rollback restores its exact
    // identity. A process crash after pair preparation now leaves the output absent (rather than
    // a false foreign empty directory), which v2 recovery can safely classify as no-install.
    await workspace.claimOutput(initialOutput);

    let stagedForPortableInstall = stagedAfterValidation;
    if (options.beforeCommit) {
      const sourceBeforeCommit = await snapshotPackageEditTree(sourceRoot);
      const stagedBeforeCommit = options.closedInventory
        ? undefined
        : await snapshotPackageEditTree(workspace.stagedPackageRoot);
      if (!samePackageEditTreeSnapshot(sourceBefore, sourceBeforeCommit)) {
        throw new PackageEditTransactionError("source_changed", "Source package changed before the package edit commit checkpoint.");
      }
      // `beforeCommit` is advisory and must never establish a new portable stage baseline.  In
      // particular, a same-UID writer cannot be allowed to replace the candidate after validation
      // but before this callback's first snapshot; every later observation is compared back to the
      // trusted post-validation snapshot.
      if (stagedForPortableInstall && stagedBeforeCommit && !samePackageEditTreeIdentitySnapshot(stagedForPortableInstall, stagedBeforeCommit)) {
        throw new PackageEditTransactionError("source_changed", "Package edit staged package changed after validation and before the commit checkpoint.");
      }
      await options.beforeCommit(workspace.stagedPackageRoot, editResult);
      const sourceAfterCommit = await snapshotPackageEditTree(sourceRoot);
      if (!samePackageEditTreeSnapshot(sourceBefore, sourceAfterCommit)) {
        throw new PackageEditTransactionError("source_changed", "Package edit commit checkpoint changed staged or source package bytes.");
      }
      if (options.closedInventory) {
        await workspace.assertPinnedStagedInventoryCurrent();
      } else {
        const stagedAfterCommit = await snapshotPackageEditTree(workspace.stagedPackageRoot);
        if (!samePackageEditTreeIdentitySnapshot(stagedForPortableInstall!, stagedAfterCommit)) {
          throw new PackageEditTransactionError("source_changed", "Package edit commit checkpoint changed staged or source package bytes.");
        }
      }
    }

    installedIdentity = await workspace.install(stagedForPortableInstall
      ? async () => {
        const stagedImmediatelyBeforeInstall = await snapshotPackageEditTree(workspace.stagedPackageRoot);
        if (!samePackageEditTreeIdentitySnapshot(stagedForPortableInstall!, stagedImmediatelyBeforeInstall)) {
          throw new PackageEditTransactionError("source_changed", "Package edit staged package changed after its final portable integrity recheck.");
        }
      }
      : undefined);
    let afterCommitResult: U = undefined as U;
    if (options.afterCommit) {
      try {
        afterCommitResult = await options.afterCommit(outputRoot, editResult);
      } catch (error) {
        if (options.closedInventory && !isPublicationCommitUncertain(error)) {
          throw workspace.postInstallObservationUncertain(error);
        }
        throw error;
      }
    }
    return { outputRoot, editResult, afterCommitResult };
  } catch (error) {
    if (isPublicationCommitUncertain(error)) {
      options.onRollbackResult?.("unproven");
      cleanupStage = false;
      throw error;
    }
    try {
      await workspace.rollback(installedIdentity, initialOutput);
      options.onRollbackResult?.("restored");
    } catch (rollbackError) {
      options.onRollbackResult?.("unproven");
      cleanupStage = false;
      throw rollbackError;
    }
    throw error;
  } finally {
    if (cleanupStage) await workspace.cleanup();
  }
}

/**
 * Internal CLI preflight for mutation commands that must parse the package before constructing
 * their transaction request. It intentionally exposes no snapshot or caller-supplied inventory.
 */
export async function assertPackageEditSourceTree(sourceRoot: string): Promise<void> {
  await snapshotPackageEditTree(resolve(sourceRoot));
}

export function assertParsedPackageIdentity(expected: MotionPackage, staged: MotionPackage): void {
  if (jsonHash({ manifest: expected.manifest, motion: expected.motion }) !== jsonHash({ manifest: staged.manifest, motion: staged.motion })) {
    throw new PackageEditTransactionError("source_changed", "Source package changed after the Motion edit was prepared.");
  }
}

export async function assertReceiptInputHashes(receipt: OperationReceipt, staged: MotionPackage): Promise<void> {
  const expectedManifestHash = receipt.inputHashes["manifest.json"];
  const expectedMotionHash = receipt.inputHashes[staged.manifest.motion];
  if (!expectedManifestHash || !expectedMotionHash) {
    throw new PackageEditTransactionError("copy_mismatch", "Motion edit receipt is missing manifest or motion input hashes.");
  }
  const [manifestHash, motionHash] = await Promise.all([
    hashPackageFile(resolvePackageAsset(staged, "manifest.json")),
    hashPackageFile(resolvePackageAsset(staged, staged.manifest.motion))
  ]);
  if (manifestHash !== expectedManifestHash || motionHash !== expectedMotionHash) {
    throw new PackageEditTransactionError("source_changed", "Source package bytes changed after Motion edit receipt hashing.");
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function jsonHash(value: unknown): string {
  return hashBuffer(Buffer.from(JSON.stringify(value), "utf8"));
}

async function canonicalPathForSafety(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent === resolved) return resolved;
    return join(await canonicalPathForSafety(parent), basename(resolved));
  }
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
