import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { OutputPathTopology, OutputPathTopologyError, PublicationCommitUncertainError } from "@shellx-motion/core";
import { PackageEditTransactionError } from "./package-edit-transaction-error.js";
import { PackageEditClosedInventory, type PackageEditClosedInventoryMode } from "./package-edit-closed-inventory.js";

interface PathIdentity {
  dev: bigint;
  ino: bigint;
}

interface ProtectedDirectoryIdentity extends PathIdentity {
  ctimeNs: bigint;
  mtimeNs: bigint;
}

export type EmptyDirectoryClaim =
  | { exists: false }
  | ({ exists: true } & ProtectedDirectoryIdentity);

/**
 * Private same-filesystem workspace for one package-output swap.  The Core topology is admitted
 * before the reservation exists and retained through every mutating operation, so a package edit
 * cannot use a parent route that was only checked at transaction entry.  Rollback first moves our
 * exact installed directory into this private reservation; it never recursively removes an
 * unrelated replacement at outputRoot.
 */
export class PackageEditWorkspace {
  readonly outputRoot: string;
  readonly stageRoot: string;
  readonly stagedPackageRoot: string;
  readonly backupRoot: string;
  private readonly discardedInstallRoot: string;
  private readonly topology: OutputPathTopology;
  private readonly parent: PathIdentity & { path: string };
  private readonly stageIdentity: PathIdentity;
  private readonly closedInventoryMode: PackageEditClosedInventoryMode | undefined;
  private backupIdentity: ProtectedDirectoryIdentity | undefined;
  private closedInventory: PackageEditClosedInventory | undefined;
  private installedIdentity: ProtectedDirectoryIdentity | undefined;

  private constructor(outputRoot: string, topology: OutputPathTopology, parent: PathIdentity & { path: string }, stageRoot: string, stageIdentity: PathIdentity, closedInventoryMode: PackageEditClosedInventoryMode | undefined) {
    this.outputRoot = outputRoot;
    this.topology = topology;
    this.parent = parent;
    this.stageRoot = stageRoot;
    this.stageIdentity = stageIdentity;
    this.closedInventoryMode = closedInventoryMode;
    this.stagedPackageRoot = join(stageRoot, "package");
    this.backupRoot = join(stageRoot, "previous-output");
    this.discardedInstallRoot = join(stageRoot, "discarded-install");
  }

  static async create(outputRoot: string, kind: "new" | "edit", options: { closedInventory?: PackageEditClosedInventoryMode } = {}): Promise<PackageEditWorkspace> {
    const resolvedOutput = resolve(outputRoot);
    let topology: OutputPathTopology;
    try {
      topology = await OutputPathTopology.acquire(resolvedOutput);
    } catch (error) {
      throw unsafeOutputError(error);
    }
    const parent = { path: topology.parentPath, ...await captureDirectory(topology.parentPath, "Package edit output parent changed before staging.") };
    let stageRoot: string | undefined;
    try {
      stageRoot = await mkdtemp(join(parent.path, `.${safeToken(basename(resolvedOutput))}.shellx-${kind}-`));
      await chmod(stageRoot, 0o700);
      const stageIdentity = await captureDirectory(stageRoot, "Package edit staging reservation changed while it was being created.");
      if (stageIdentity.dev !== parent.dev || dirname(stageRoot) !== parent.path || await realpath(stageRoot) !== stageRoot) {
        throw new PackageEditTransactionError("output_changed", "Package edit staging reservation is not a private directory on the output filesystem.");
      }
      const workspace = new PackageEditWorkspace(resolvedOutput, topology, parent, stageRoot, stageIdentity, options.closedInventory);
      await workspace.assertReservation();
      return workspace;
    } catch (error) {
      // If parent identity moved before the reservation became fully captured, do not clean by
      // pathname: that path could now name an unrelated directory.  A verified workspace cleans
      // itself through cleanup(); an unverified one is intentionally left for operator recovery.
      throw error;
    }
  }

  async inspectOutput(): Promise<EmptyDirectoryClaim> {
    await this.assertReservation();
    try {
      const identity = await captureProtectedDirectory(this.outputRoot, "Package edit output must be an empty directory or absent.");
      if ((await readdir(this.outputRoot)).length !== 0) {
        throw new PackageEditTransactionError("output_not_empty", "Package edit output must be an empty directory or absent.");
      }
      return { exists: true, ...identity };
    } catch (error) {
      if (isMissingPathError(error)) return { exists: false };
      throw error;
    }
  }

  /** Move the observed empty output (or a private empty placeholder) into the reservation. */
  async claimOutput(initial: EmptyDirectoryClaim): Promise<void> {
    await this.assertReservation();
    if (initial.exists) {
      this.backupIdentity = await this.moveExact(this.outputRoot, initial, this.backupRoot, "Package edit output changed before it could be claimed.");
      if ((await readdir(this.backupRoot)).length !== 0) {
        throw new PackageEditTransactionError("output_changed", "Claimed package edit output was not the original empty directory.");
      }
      return;
    }

    try {
      await mkdir(this.outputRoot, { mode: 0o700 });
    } catch (error) {
      if (isExistingPathError(error)) {
        throw new PackageEditTransactionError("output_changed", "Package edit output appeared before commit.");
      }
      throw error;
    }
    const placeholder = await captureProtectedDirectory(this.outputRoot, "Exclusive package edit output claim changed before commit.");
    this.backupIdentity = await this.moveExact(this.outputRoot, placeholder, this.backupRoot, "Exclusive package edit output claim changed before commit.");
  }

  /**
   * Pin every staged leaf after the caller's final mutation.  The inventory is discovered from
   * the private tree itself, through Core's bounded Linux descriptor traversal; no caller can
   * supply names, hashes, a stage callback, or a path authority.
   */
  async pinCompleteStagedInventory(): Promise<void> {
    if (!this.closedInventoryMode) {
      throw new PackageEditTransactionError("closed_inventory_changed", "Package edit closed inventory was not explicitly enabled for this transaction.");
    }
    if (this.closedInventory) {
      throw new PackageEditTransactionError("closed_inventory_changed", "Package edit closed inventory was already finalized.");
    }
    await this.assertReservation();
    const staged = await captureProtectedDirectory(this.stagedPackageRoot, "Staged package changed before closed inventory pinning.");
    const inventory = new PackageEditClosedInventory(this.closedInventoryMode);
    await inventory.pin(this.stagedPackageRoot, staged);
    this.closedInventory = inventory;
  }

  /** Reassert the final staged inventory without exposing its leaves or the stage route. */
  async assertPinnedStagedInventoryCurrent(): Promise<void> {
    if (!this.closedInventory) {
      throw new PackageEditTransactionError("closed_inventory_changed", "Package edit closed inventory was not finalized.");
    }
    await this.assertReservation();
    const staged = await captureProtectedDirectory(this.stagedPackageRoot, "Staged package changed before closed inventory verification.");
    await this.assertPinnedStagedInventory(staged);
  }

  /** Install only the exact staged package captured in this output filesystem reservation. */
  async install(): Promise<ProtectedDirectoryIdentity> {
    await this.assertReservation();
    const staged = await captureProtectedDirectory(this.stagedPackageRoot, "Staged package changed before installation.");
    await this.assertPinnedStagedInventory(staged);
    if (staged.dev !== this.parent.dev || await pathExists(this.outputRoot)) {
      throw new PackageEditTransactionError("output_changed", "Package edit output changed before installation.");
    }
    let publicationAttempted = false;
    try {
      if (await pathExists(this.outputRoot)) {
        throw new PackageEditTransactionError("output_changed", "Staged package changed during installation.");
      }
      const current = await protectedIdentityOrUndefined(this.stagedPackageRoot);
      if (!current || !sameProtectedIdentity(current, staged)) {
        throw new PackageEditTransactionError("output_changed", "Staged package changed during installation.");
      }
      publicationAttempted = true;
      await rename(this.stagedPackageRoot, this.outputRoot);
      const installed = await protectedIdentityOrUndefined(this.outputRoot);
      if (!installed || !sameIdentity(installed, staged)) {
        throw new PackageEditTransactionError("output_changed", "Staged package changed during installation.");
      }
      await this.assertReservation();
      await this.assertPinnedInstalledInventory(installed);
      this.installedIdentity = installed;
      return installed;
    } catch (error) {
      if (publicationAttempted && this.closedInventory) {
        throw new PublicationCommitUncertainError({
          publicPath: this.outputRoot,
          kind: "directory",
          expectedIdentity: outputIdentity(staged),
          expected: this.closedInventory.publicationEvidence
        }, this.closedInventory.publicationUncertaintyCause(error));
      }
      throw error;
    }
  }

  postInstallObservationUncertain(cause: unknown): PublicationCommitUncertainError {
    if (!this.closedInventory || !this.installedIdentity) throw new PackageEditTransactionError("closed_inventory_changed", "Package edit cannot classify an uninstalled output as publication uncertainty.");
    return new PublicationCommitUncertainError({ publicPath: this.outputRoot, kind: "directory", expectedIdentity: outputIdentity(this.installedIdentity), expected: this.closedInventory.publicationEvidence }, this.closedInventory.publicationUncertaintyCause(cause));
  }

  /** Restore the exact old state without deleting an unrelated output replacement. */
  async rollback(installed: ProtectedDirectoryIdentity | undefined, initial: EmptyDirectoryClaim | undefined): Promise<void> {
    if (installed) await this.removeInstalledOnlyIfExact(installed);
    if (!this.backupIdentity || !initial) return;

    if (initial.exists) {
      if (await pathExists(this.outputRoot)) {
        throw new PackageEditTransactionError(
          "output_changed",
          `Package edit rollback was obstructed; the previous empty destination is preserved at ${this.backupRoot}.`
        );
      }
      await this.moveExact(this.backupRoot, this.backupIdentity, this.outputRoot, "Package edit rollback could not restore the original destination.");
      this.backupIdentity = undefined;
      return;
    }

    await this.removeReservationEntry(this.backupRoot, this.backupIdentity, "Package edit rollback reservation changed before cleanup.");
    this.backupIdentity = undefined;
  }

  async cleanup(): Promise<void> {
    if (this.closedInventory?.isCleanupUnsafe) return;
    await this.assertReservation();
    // The reservation is private and topology-bound.  Refuse to delete if either identity has
    // changed; retaining an orphaned private staging directory is safer than path-based cleanup.
    const stage = await captureDirectory(this.stageRoot, "Package edit staging reservation changed before cleanup.");
    if (!sameIdentity(stage, this.stageIdentity)) {
      throw new PackageEditTransactionError("output_changed", "Package edit staging reservation changed before cleanup.");
    }
    await rm(this.stageRoot, { recursive: true, force: true });
  }

  private async removeInstalledOnlyIfExact(installed: ProtectedDirectoryIdentity): Promise<void> {
    await this.assertReservation();
    const current = await protectedIdentityOrUndefined(this.outputRoot);
    if (!current || !sameProtectedIdentity(current, installed)) {
      throw new PackageEditTransactionError(
        "output_changed",
        `Package edit rollback did not remove a replacement output; the previous empty destination is preserved at ${this.backupRoot}.`
      );
    }
    const discarded = await this.moveExact(this.outputRoot, installed, this.discardedInstallRoot, "Package edit output changed during rollback.");
    await this.removeReservationEntry(this.discardedInstallRoot, discarded, "Installed package changed during rollback cleanup.");
  }

  private async moveExact(
    from: string,
    expected: ProtectedDirectoryIdentity,
    to: string,
    message: string
  ): Promise<ProtectedDirectoryIdentity> {
    await this.assertReservation();
    if (await pathExists(to)) throw new PackageEditTransactionError("output_changed", message);
    const current = await protectedIdentityOrUndefined(from);
    if (!current || !sameProtectedIdentity(current, expected)) throw new PackageEditTransactionError("output_changed", message);
    await rename(from, to);
    const moved = await protectedIdentityOrUndefined(to);
    if (!moved || !sameIdentity(moved, expected)) throw new PackageEditTransactionError("output_changed", message);
    await this.assertReservation();
    return moved;
  }

  private async removeReservationEntry(path: string, expected: ProtectedDirectoryIdentity, message: string): Promise<void> {
    await this.assertReservation();
    const current = await protectedIdentityOrUndefined(path);
    if (!current || !sameProtectedIdentity(current, expected)) throw new PackageEditTransactionError("output_changed", message);
    await rm(path, { recursive: true, force: true });
  }

  private async assertReservation(): Promise<void> {
    try {
      await this.topology.assertCurrent();
    } catch (error) {
      // A full-route topology change is an authority failure, not merely a later output leaf
      // race.  Keep that distinction for callers that surface unsafe parents to the operator.
      throw unsafeOutputError(error);
    }
    const parent = await captureDirectory(this.parent.path, "Package edit output parent changed during the transaction.");
    if (!sameIdentity(parent, this.parent)) {
      throw new PackageEditTransactionError("output_changed", "Package edit output parent changed during the transaction.");
    }
    const stage = await captureDirectory(this.stageRoot, "Package edit staging reservation changed during the transaction.");
    if (!sameIdentity(stage, this.stageIdentity) || stage.dev !== parent.dev || await realpath(this.stageRoot) !== this.stageRoot) {
      throw new PackageEditTransactionError("output_changed", "Package edit staging reservation changed during the transaction.");
    }
  }

  private async assertPinnedStagedInventory(staged: ProtectedDirectoryIdentity): Promise<void> {
    if (!this.closedInventory) return;
    await this.closedInventory.assertStage(this.stagedPackageRoot, staged);
  }

  private async assertPinnedInstalledInventory(installed: ProtectedDirectoryIdentity): Promise<void> {
    if (!this.closedInventory) return;
    await this.closedInventory.assertInstalled(this.outputRoot, installed);
  }
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameProtectedIdentity(left: ProtectedDirectoryIdentity, right: ProtectedDirectoryIdentity): boolean {
  return sameIdentity(left, right) && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

async function captureDirectory(path: string, message: string): Promise<PathIdentity> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PackageEditTransactionError("output_changed", message);
  }
  return { dev: entry.dev, ino: entry.ino };
}

async function captureProtectedDirectory(path: string, message: string): Promise<ProtectedDirectoryIdentity> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PackageEditTransactionError("output_changed", message);
  }
  return { dev: entry.dev, ino: entry.ino, ctimeNs: entry.ctimeNs, mtimeNs: entry.mtimeNs };
}

async function protectedIdentityOrUndefined(path: string): Promise<ProtectedDirectoryIdentity | undefined> {
  try {
    return await captureProtectedDirectory(path, "Package edit output changed during the transaction.");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await protectedIdentityOrUndefined(path)) !== undefined;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isExistingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function safeToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "package";
}

function outputIdentity(identity: PathIdentity): { dev: number; ino: number } { return { dev: Number(identity.dev), ino: Number(identity.ino) }; }

function unsafeOutputError(error: unknown, fallback: "unsafe_output" | "output_changed" = "unsafe_output"): PackageEditTransactionError { const message = error instanceof Error ? error.message : String(error); return error instanceof OutputPathTopologyError ? new PackageEditTransactionError(fallback, `Package edit output topology is unsafe: ${message}`) : new PackageEditTransactionError(fallback, message); }
