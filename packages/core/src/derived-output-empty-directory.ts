import { readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertOutputDirectoryIdentity,
  assertOutputLeafIdentity,
  type OutputPathIdentity,
  type OutputPathLeafIdentity
} from "./output-path-topology";
import { DerivedOutputPublicationError } from "./derived-output-publication-types";

type EmptyDirectoryClaimGuards = {
  assertTopology(): Promise<void>;
  assertDestinationIdentity(): Promise<OutputPathLeafIdentity>;
  markDestinationMissing(): void;
  markDestinationRestored(identity: OutputPathIdentity): void;
};

/** Identity-bound transaction for replacing only an admitted empty directory placeholder. */
export class DerivedOutputEmptyDirectory {
  #backupIdentity: OutputPathIdentity | undefined;

  constructor(
    private readonly enabled: boolean,
    private readonly outputPath: string,
    private readonly lockPath: string
  ) {}

  /** Move the exact admitted empty destination behind the private lock before final rename. */
  async claim(destinationIdentity: OutputPathLeafIdentity, guards: EmptyDirectoryClaimGuards): Promise<void> {
    if (destinationIdentity.kind === "missing") return;
    if (!this.enabled || destinationIdentity.kind !== "directory") {
      throw new DerivedOutputPublicationError("derived_output_exists", "Final directory output destination changed after admission.", this.outputPath);
    }
    await guards.assertTopology();
    await guards.assertDestinationIdentity();
    if ((await readdir(this.outputPath)).length !== 0) {
      throw new DerivedOutputPublicationError("derived_output_exists", "Final directory output changed after it was admitted as empty.", this.outputPath);
    }
    await guards.assertTopology();
    await guards.assertDestinationIdentity();
    const backupPath = this.backupPath();
    await rename(this.outputPath, backupPath);
    this.#backupIdentity = { dev: destinationIdentity.dev, ino: destinationIdentity.ino };
    guards.markDestinationMissing();
    await assertOutputDirectoryIdentity(backupPath, destinationIdentity, "Previous empty final output", { requiresChildWrite: true });
  }

  /** Restore the caller's exact placeholder when publication never reached the final rename. */
  async restore(guards: EmptyDirectoryClaimGuards): Promise<void> {
    const backup = this.#backupIdentity;
    if (!backup) return;
    await guards.assertTopology();
    await assertOutputLeafIdentity(this.outputPath, { kind: "missing" }, "Final output destination");
    await assertOutputDirectoryIdentity(this.backupPath(), backup, "Previous empty final output", { requiresChildWrite: true });
    await rename(this.backupPath(), this.outputPath);
    guards.markDestinationRestored(backup);
    this.#backupIdentity = undefined;
  }

  /** Cleanup is post-admission bookkeeping and must never negate successful publication. */
  async cleanup(assertTopology: () => Promise<void>): Promise<void> {
    const backup = this.#backupIdentity;
    if (!backup) return;
    await assertTopology();
    await assertOutputDirectoryIdentity(this.backupPath(), backup, "Previous empty final output", { requiresChildWrite: true });
    await rmdir(this.backupPath());
    this.#backupIdentity = undefined;
  }

  private backupPath(): string {
    return join(this.lockPath, "previous-empty-output");
  }
}
