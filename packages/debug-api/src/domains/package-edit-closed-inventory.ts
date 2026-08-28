/** Internal exact-tree state retained by the PackageEditWorkspace COW boundary. */
import { createHash } from "node:crypto";
import {
  assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt,
  assertExactDirectoryInventorySnapshotAt,
  captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt,
  captureCompleteExactDirectoryInventorySnapshotAt,
  isClosedDirectoryInventoryAmbiguity,
  type CompleteDirectoryInventorySnapshot,
  type ExactDirectoryInventorySnapshot
} from "@shellx-motion/core/internal/closed-directory-inventory";
import { PackageEditTransactionError } from "./package-edit-transaction-error.js";

export type PackageEditClosedDirectoryIdentity = { dev: bigint; ino: bigint };
export type PackageEditClosedInventoryMode = "finalize-after-edit" | "finalize-after-edit-with-empty-directories";
const COMPLETE_TREE_REOPEN_REQUIRED_SHA256 = createHash("sha256").update("shellx-motion:complete-tree-reopen-required@1\n").digest("hex");

type PublicationEvidence = {
  readonly sha256: string;
  readonly entryCount: number;
  readonly entries: readonly string[];
  readonly inventory?: readonly Readonly<{ path: string; sha256: string; byteLength: number }>[];
};

type PinnedInventory =
  | { readonly mode: "finalize-after-edit"; readonly snapshot: ExactDirectoryInventorySnapshot }
  | { readonly mode: "finalize-after-edit-with-empty-directories"; readonly snapshot: CompleteDirectoryInventorySnapshot };

export class PackageEditClosedInventory {
  private snapshot: PinnedInventory | undefined;
  private cleanupUnsafe = false;

  constructor(private readonly mode: PackageEditClosedInventoryMode) {}

  get isCleanupUnsafe(): boolean { return this.cleanupUnsafe; }
  get publicationEvidence(): PublicationEvidence {
    if (!this.snapshot) throw new PackageEditTransactionError("closed_inventory_changed", "Package edit closed inventory was not finalized.");
    if (this.snapshot.mode === "finalize-after-edit") return this.snapshot.snapshot.evidence;
    const evidence = this.snapshot.snapshot.evidence;
    const inventory = Object.freeze(evidence.inventory.filter((entry): entry is { readonly path: string; readonly sha256: string; readonly byteLength: number } => !Object.hasOwn(entry, "kind")));
    // Generic publication evidence has a regular-file-only vocabulary.  If the private snapshot
    // contains empty-directory markers, publish a deliberately impossible empty-file sentinel:
    // its non-empty digest cannot reconcile as an empty regular-file inventory.  The domain's
    // output-only reopener remains the sole authority for the retained complete tree.
    if (evidence.entryCount !== inventory.length) {
      return Object.freeze({ sha256: COMPLETE_TREE_REOPEN_REQUIRED_SHA256, entryCount: 0, entries: Object.freeze([]) });
    }
    const digest = createHash("sha256");
    for (const entry of inventory) digest.update(`${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`);
    return Object.freeze({
      sha256: digest.digest("hex"),
      entryCount: inventory.length,
      entries: Object.freeze(inventory.map((entry) => entry.path)),
      inventory
    });
  }

  publicationUncertaintyCause(cause: unknown): unknown {
    const evidence = this.publicationEvidence;
    if (evidence.sha256 !== COMPLETE_TREE_REOPEN_REQUIRED_SHA256) return cause;
    return new Error("Complete-tree package output requires its domain-specific output-only reopen; generic reconciliation is unavailable.", { cause });
  }

  async pin(stageRoot: string, identity: PackageEditClosedDirectoryIdentity): Promise<void> {
    if (this.snapshot) throw new PackageEditTransactionError("closed_inventory_changed", "Package edit closed inventory was already finalized.");
    try {
      this.snapshot = this.mode === "finalize-after-edit"
        ? Object.freeze({ mode: "finalize-after-edit" as const, snapshot: await captureCompleteExactDirectoryInventorySnapshotAt(stageRoot, outputIdentity(identity), "Package edit staged package") })
        : Object.freeze({ mode: "finalize-after-edit-with-empty-directories" as const, snapshot: await captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stageRoot, outputIdentity(identity), "Package edit staged package") });
    } catch (error) {
      this.note(error);
      throw closedInventoryError("could not be finalized");
    }
  }

  async assertStage(stageRoot: string, identity: PackageEditClosedDirectoryIdentity): Promise<void> {
    await this.assert(stageRoot, identity, "Package edit staged package", "changed before installation");
  }

  async assertInstalled(outputRoot: string, identity: PackageEditClosedDirectoryIdentity): Promise<void> {
    await this.assert(outputRoot, identity, "Published package edit", "changed after installation");
  }

  private async assert(path: string, identity: PackageEditClosedDirectoryIdentity, label: string, phase: string): Promise<void> {
    if (!this.snapshot) throw new PackageEditTransactionError("closed_inventory_changed", "Package edit closed inventory was not finalized.");
    try {
      if (this.snapshot.mode === "finalize-after-edit") {
        await assertExactDirectoryInventorySnapshotAt(path, this.snapshot.snapshot.evidence.inventory, outputIdentity(identity), this.snapshot.snapshot, label);
      } else {
        await assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(path, this.snapshot.snapshot.evidence.inventory, outputIdentity(identity), this.snapshot.snapshot, label);
      }
    } catch (error) {
      this.note(error);
      throw closedInventoryError(phase);
    }
  }

  private note(error: unknown): void {
    if (isClosedDirectoryInventoryAmbiguity(error)) this.cleanupUnsafe = true;
  }
}

function outputIdentity(identity: PackageEditClosedDirectoryIdentity): { dev: number; ino: number } {
  return { dev: Number(identity.dev), ino: Number(identity.ino) };
}

function closedInventoryError(phase: string): PackageEditTransactionError {
  return new PackageEditTransactionError("closed_inventory_changed", `Package edit closed inventory ${phase}.`);
}
