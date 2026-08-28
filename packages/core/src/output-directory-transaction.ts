/**
 * Identity-bound publication for a caller-selected directory deliverable.
 *
 * A review bundle is a small tree, but it is still an output transaction: a rejected or changing
 * input must not leave a half-built public directory, and a check of the output parent is useful
 * only if that same route is retained until the final rename. The staged tree excludes unrelated
 * writers; an existing destination is supported only when it is empty and authority-safe for
 * child publication. Motion-created POSIX stages additionally remain mode 0700.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  assertOutputDirectoryIdentity,
  assertOutputLeafIdentity,
  captureOutputDirectoryIdentity,
  captureOutputLeaf,
  OutputPathTopology,
  OutputPathTopologyError,
  type OutputPathIdentity,
  type OutputPathLeafIdentity
} from "./output-path-topology";
import {
  assertExactDirectoryInventorySnapshotAt,
  captureExactDirectoryInventorySnapshotAt,
  captureDirectoryInventoryAt,
  isClosedDirectoryInventoryAmbiguity,
  type ExactDirectoryInventoryEntry,
  type ExactDirectoryInventorySnapshot
} from "./derived-output-publication-private";
import {
  PublicationCommitUncertainError,
  type PublicationCommitUncertainEvidence
} from "./publication-commit-uncertainty";
import { assertClosedDirectoryInventoryAvailable } from "./closed-directory-inventory-observe";

export class OutputDirectoryTransactionError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = "OutputDirectoryTransactionError";
    Object.setPrototypeOf(this, OutputDirectoryTransactionError.prototype);
  }
}

export interface OutputDirectoryTransactionOptions {
  /** A caller-selected destination that must not already exist, even when it is empty. */
  requireAbsent?: boolean;
  /** Refuse before admission or staging unless exact descriptor-relative tree proof is available. */
  requireClosedTree?: boolean;
}

/** Content-addressed relative leaves a caller requires the private stage to contain at final commit. */
export type OutputDirectoryTransactionExpectedInventory = readonly ExactDirectoryInventoryEntry[];

/** A private stage whose completed tree can be atomically published at `outputPath`. */
export class OutputDirectoryTransaction {
  private readonly backupPath: string;
  private backupIdentity: OutputPathIdentity | undefined;
  private committed = false;
  private publicationAttempted = false;
  private commitEvidence: PublicationCommitUncertainEvidence | undefined;
  /** Retain only a stage whose root or nested descriptor topology became ambiguous. */
  private closedInventoryCleanupUnsafe = false;
  private stageClosedInventory: ExactDirectoryInventorySnapshot | undefined;

  private constructor(
    readonly outputPath: string,
    readonly stagingPath: string,
    private readonly topology: OutputPathTopology,
    private readonly initialLeaf: OutputPathLeafIdentity,
    private readonly stageIdentity: OutputPathIdentity,
    private readonly existingOutputIdentity: OutputPathIdentity | undefined
  ) {
    this.backupPath = join(topology.parentPath, `.${safeToken(basename(outputPath))}.shellx-motion-previous-${randomUUID()}`);
  }

  static async create(path: string, options: OutputDirectoryTransactionOptions = {}): Promise<OutputDirectoryTransaction> {
    const outputPath = resolve(path);
    if (options.requireClosedTree) {
      try {
        assertClosedDirectoryInventoryAvailable(outputPath, "Output directory staging");
      } catch (error) {
        throw transactionError(error, outputPath);
      }
    }
    let topology: OutputPathTopology;
    try {
      topology = await OutputPathTopology.acquire(outputPath);
    } catch (error) {
      throw transactionError(error, outputPath);
    }

    try {
      const initialLeaf = await captureOutputLeaf(outputPath);
      let existingOutputIdentity: OutputPathIdentity | undefined;
      if (initialLeaf.kind === "directory") {
        if (options.requireAbsent) {
          throw new OutputDirectoryTransactionError("Output directory already exists; this operation requires a new destination.", outputPath);
        }
        existingOutputIdentity = await captureOutputDirectoryIdentity(outputPath, "Output directory", { requiresChildWrite: true });
        if ((await readdir(outputPath)).length !== 0) {
          throw new OutputDirectoryTransactionError("Output directory is not empty; choose an absent or empty destination before collection.", outputPath);
        }
      } else if (initialLeaf.kind !== "missing") {
        throw new OutputDirectoryTransactionError("Output path already exists and is not a directory.", outputPath);
      }

      await topology.assertCurrent();
      await assertOutputLeafIdentity(outputPath, initialLeaf, "Output directory");
      if (existingOutputIdentity) {
        await assertOutputDirectoryIdentity(outputPath, existingOutputIdentity, "Output directory", { requiresChildWrite: true });
      }

      const stagingPath = await mkdtemp(join(topology.parentPath, `.${safeToken(basename(outputPath))}.shellx-motion-stage-`));
      await chmod(stagingPath, 0o700);
      const stageIdentity = await captureOutputDirectoryIdentity(stagingPath, "Output directory staging", { private: true });
      const transaction = new OutputDirectoryTransaction(outputPath, stagingPath, topology, initialLeaf, stageIdentity, existingOutputIdentity);
      await transaction.assertCurrent();
      return transaction;
    } catch (error) {
      throw transactionError(error, outputPath);
    }
  }

  /** Refuse work when the admitted public destination or private stage was replaced. */
  async assertCurrent(): Promise<void> {
    try {
      await this.topology.assertCurrent();
      await assertOutputLeafIdentity(this.outputPath, this.initialLeaf, "Output directory");
      if (this.existingOutputIdentity) {
        await assertOutputDirectoryIdentity(this.outputPath, this.existingOutputIdentity, "Output directory", { requiresChildWrite: true });
      }
      await assertOutputDirectoryIdentity(this.stagingPath, this.stageIdentity, "Output directory staging", { private: true });
    } catch (error) {
      throw transactionError(error, this.outputPath);
    }
  }

  /**
   * Publish the completed private stage, preserving an existing empty destination on failures
   * before the final rename is attempted. Once that rename has been attempted, an error is
   * explicitly possibly-committed and no pathname-based rollback or cleanup is attempted.
   */
  async commit(expectedInventory?: OutputDirectoryTransactionExpectedInventory): Promise<void> {
    if (this.committed) throw new OutputDirectoryTransactionError("Output directory transaction was already committed.", this.outputPath);
    await this.assertCurrent();
    try {
      if (this.existingOutputIdentity) {
        if ((await readdir(this.outputPath)).length !== 0) {
          throw new OutputDirectoryTransactionError("Output directory changed while it was being prepared.", this.outputPath);
        }
        await rename(this.outputPath, this.backupPath);
        this.backupIdentity = await captureOutputDirectoryIdentity(this.backupPath, "Previous output directory", { requiresChildWrite: true });
      }
      await this.assertTopologyAndStage();
      await assertOutputLeafIdentity(this.outputPath, { kind: "missing" }, "Output directory");
      // This is deliberately the final staged-tree observation before rename. A caller that
      // supplied a closed hash inventory gets a fresh no-follow bounded read of every leaf here;
      // the generic transaction preserves its existing complete-inventory capture behavior.
      const closedInventory = expectedInventory !== undefined
        ? await captureExactDirectoryInventorySnapshotAt(this.stagingPath, expectedInventory, this.stageIdentity, "Output directory staging")
        : undefined;
      this.stageClosedInventory = closedInventory;
      const inventory = closedInventory
        ? closedInventory.evidence
        : await captureDirectoryInventoryAt(this.stagingPath, this.stageIdentity, "Output directory staging");
      const commitExpected = closedInventory
        ? { sha256: closedInventory.evidence.sha256, entryCount: closedInventory.evidence.entryCount, entries: closedInventory.evidence.entries, inventory: closedInventory.evidence.inventory }
        : inventory;
      const commitEvidence: PublicationCommitUncertainEvidence = {
        publicPath: this.outputPath,
        kind: "directory",
        expectedIdentity: this.stageIdentity,
        expected: commitExpected
      };
      this.commitEvidence = commitEvidence;
      if (closedInventory) {
        await assertExactDirectoryInventorySnapshotAt(this.stagingPath, closedInventory.evidence.inventory, this.stageIdentity, closedInventory, "Output directory staging");
      }
      this.publicationAttempted = true;
      await rename(this.stagingPath, this.outputPath);
      if (closedInventory) {
        // Rename is irreversible. Re-open the public tree through the same bounded no-follow
        // inventory and pinned nested identities before declaring success; any drift is uncertain.
        await assertExactDirectoryInventorySnapshotAt(this.outputPath, closedInventory.evidence.inventory, this.stageIdentity, closedInventory, "Published output directory");
      }
      await assertOutputDirectoryIdentity(this.outputPath, this.stageIdentity, "Output directory", { private: true });
      this.committed = true;
    } catch (error) {
      if (this.publicationAttempted) {
        if (!this.commitEvidence) {
          throw new OutputDirectoryTransactionError("Output directory publication was attempted without retained verification evidence.", this.outputPath);
        }
        throw new PublicationCommitUncertainError(this.commitEvidence, error);
      }
      if (isClosedDirectoryInventoryAmbiguity(error)) this.closedInventoryCleanupUnsafe = true;
      await this.restorePreviousOutput();
      throw transactionError(error, this.outputPath);
    }

    // This is an empty private directory we moved only after retaining its identity.  A cleanup
    // miss is intentionally non-fatal: the published bundle is complete, while deleting an object
    // whose identity no longer matches would be worse than leaving one private reservation behind.
    await this.removePreviousOutput().catch(() => undefined);
  }

  /** Remove only the exact private stage; topology or identity loss preserves it for recovery. */
  async abort(): Promise<void> {
    if (this.committed || this.publicationAttempted || this.closedInventoryCleanupUnsafe) return;
    try {
      await this.assertCurrent();
      await rm(this.stagingPath, { recursive: true, force: true });
    } catch {
      // Preserve unknown staging rather than recursively deleting by a changed pathname.
    }
  }

  /** Revalidate the published tree before a dependent receipt is made visible. */
  async assertPublishedCurrent(): Promise<void> {
    if (!this.committed) {
      throw new OutputDirectoryTransactionError("Output directory transaction has not been committed.", this.outputPath);
    }
    const evidence = this.commitEvidence;
    if (!evidence) {
      throw new OutputDirectoryTransactionError("Committed output directory is missing its verified publication evidence.", this.outputPath);
    }
    try {
      await this.topology.assertCurrent();
      await assertOutputDirectoryIdentity(this.outputPath, this.stageIdentity, "Published output directory", { private: true });
      const closedInventory = this.stageClosedInventory;
      if (closedInventory) {
        await assertExactDirectoryInventorySnapshotAt(this.outputPath, closedInventory.evidence.inventory, this.stageIdentity, closedInventory, "Published output directory");
      }
    } catch (error) {
      throw new PublicationCommitUncertainError(evidence, error);
    }
  }

  private async assertTopologyAndStage(): Promise<void> {
    try {
      await this.topology.assertCurrent();
      await assertOutputDirectoryIdentity(this.stagingPath, this.stageIdentity, "Output directory staging", { private: true });
    } catch (error) {
      throw transactionError(error, this.outputPath);
    }
  }

  private async restorePreviousOutput(): Promise<void> {
    if (!this.backupIdentity) return;
    try {
      await this.topology.assertCurrent();
      await assertOutputLeafIdentity(this.outputPath, { kind: "missing" }, "Output directory");
      await assertOutputDirectoryIdentity(this.backupPath, this.backupIdentity, "Previous output directory", { requiresChildWrite: true });
      await rename(this.backupPath, this.outputPath);
      this.backupIdentity = undefined;
    } catch {
      // The caller receives the failed publication and the known previous output is preserved at
      // its private reservation rather than overwritten or recursively removed.
    }
  }

  private async removePreviousOutput(): Promise<void> {
    if (!this.backupIdentity) return;
    await this.topology.assertCurrent();
    await assertOutputDirectoryIdentity(this.backupPath, this.backupIdentity, "Previous output directory", { requiresChildWrite: true });
    await rmdir(this.backupPath);
    this.backupIdentity = undefined;
  }
}

function transactionError(error: unknown, path: string): OutputDirectoryTransactionError {
  if (error instanceof OutputDirectoryTransactionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OutputPathTopologyError) {
    return new OutputDirectoryTransactionError(`Output directory topology is unsafe: ${message}`, error.path);
  }
  return new OutputDirectoryTransactionError(message, path);
}

function safeToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "output";
}
