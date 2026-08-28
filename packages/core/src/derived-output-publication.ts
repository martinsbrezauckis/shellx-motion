/**
 * Private staging and no-clobber publication for final render outputs.
 *
 * A lexical output path is never publication authority. The parent topology is pinned by
 * dev/inode, each private stage keeps its creation identity, and an explicitly forced destination
 * keeps the exact leaf identity observed at acquisition. Revalidation happens before every
 * destructive or path-following operation. Node has no portable descriptor-relative rename/link
 * API, so this closes cross-principal ancestor substitution through POSIX parent admission and
 * never rolls back a public name; a changed observation after the final link or rename is typed possibly-committed evidence.
 */
import { link, rename, rm, unlink } from "node:fs/promises";
import { assertOutputDirectoryIdentity, assertOutputLeafIdentity, OutputPathTopology, OutputPathTopologyError, type OutputPathIdentity, type OutputPathLeafIdentity } from "./output-path-topology";
import { removeExactPrivateDirectory, stableRegularFile, verifyDirectoryAt, type PrivateFileAnchor } from "./derived-output-publication-private";
import { DerivedOutputPrivateMaterialization } from "./derived-output-private-materialization";
import {
  DerivedOutputPublicationError,
  type DerivedDirectoryPublicationEvidence,
  type DerivedFilePublicationEvidence,
  type DerivedOutputKind,
  type DerivedOutputPublicationErrorCode,
  type DerivedOutputPublicationInput
} from "./derived-output-publication-types";
import { publicationError, unsafeParentError } from "./derived-output-publication-admission";
import { rememberCoreDerivedOutputPublication } from "./derived-output-publication-authority";
import { prepareDerivedOutputPublication } from "./derived-output-publication-acquire";
import { PublicationCommitUncertainError } from "./publication-commit-uncertainty";
import { DerivedOutputEmptyDirectory } from "./derived-output-empty-directory";
import { removeForcedFileDestination } from "./derived-output-forced-file";

export {
  DerivedOutputPublicationError,
  type DerivedDirectoryPublicationEvidence,
  type DerivedFilePublicationEvidence,
  type DerivedOutputKind,
  type DerivedOutputPublicationErrorCode,
  type DerivedOutputPublicationInput
} from "./derived-output-publication-types";

/** A single final-output reservation with an identity-bound private producer stage. */
export class DerivedOutputPublication {
  #finished = false;
  #forcedDestinationRemoved = false;
  #emptyDirectory: DerivedOutputEmptyDirectory;
  #privateMaterialization: DerivedOutputPrivateMaterialization;

  private constructor(
    readonly outputPath: string,
    readonly rootPath: string,
    readonly stagingPath: string,
    readonly kind: DerivedOutputKind,
    private readonly force: boolean,
    replaceEmptyDirectory: boolean,
    private readonly topology: OutputPathTopology,
    private readonly lockPath: string,
    private readonly lockIdentity: OutputPathIdentity,
    private readonly stageIdentity: OutputPathIdentity,
    private readonly stageLinkCount: number | undefined,
    private readonly stageAnchor: PrivateFileAnchor | undefined,
    private destinationIdentity: OutputPathLeafIdentity,
    private readonly destinationAnchor: PrivateFileAnchor | undefined
  ) {
    this.#emptyDirectory = new DerivedOutputEmptyDirectory(replaceEmptyDirectory, outputPath, lockPath);
    this.#privateMaterialization = new DerivedOutputPrivateMaterialization({
      stagingPath,
      lockPath,
      stageIdentity,
      stageLinkCount,
      assertCurrent: async () => {
        await this.assertTopology();
        await this.assertStageIdentity();
      },
      verifyFile: async () => await this.verifyFile()
    });
  }

  static async acquire(input: DerivedOutputPublicationInput): Promise<DerivedOutputPublication> {
    const prepared = await prepareDerivedOutputPublication(input);
    const publication = new DerivedOutputPublication(
      prepared.outputPath, prepared.rootPath, prepared.stagingPath, prepared.kind, prepared.force, prepared.replaceEmptyDirectory,
      prepared.topology, prepared.lockPath, prepared.lockIdentity, prepared.stageIdentity, prepared.stageLinkCount,
      prepared.stageAnchor, prepared.destinationIdentity, prepared.destinationAnchor
    );
    rememberCoreDerivedOutputPublication(publication);
    return publication;
  }

  async verifyFile(): Promise<DerivedFilePublicationEvidence> {
    this.assertKind("file");
    await this.assertTopology();
    const facts = await stableRegularFile(this.stagingPath, "Final output staging file", this.stageIdentity);
    await this.assertTopology();
    return { sha256: facts.sha256, byteLength: facts.size };
  }

  async verifyDirectory(expectedEntries: readonly string[]): Promise<DerivedDirectoryPublicationEvidence> {
    this.assertKind("directory");
    await this.assertTopology();
    const evidence = await verifyDirectoryAt(this.stagingPath, expectedEntries, this.stageIdentity, "Final image-sequence staging");
    await this.assertTopology();
    return evidence;
  }

  async writePrivateFile(bytes: Buffer, options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> {
    this.assertKind("file");
    return await this.#privateMaterialization.writeFile(bytes, options);
  }

  /** Read the identity-bound private stage while its Core-created anchor link is retained. */
  async readPrivateFile(options: { label: string; maxBytes: number }): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> {
    this.assertKind("file");
    return await this.#privateMaterialization.readFile(options);
  }

  async createPrivateCompanionDirectory(purpose: "browser-capture-html"): Promise<string> {
    this.assertKind("file");
    return await this.#privateMaterialization.createCompanionDirectory(purpose);
  }

  async writePrivateCompanionFile(path: string, bytes: Buffer, options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> {
    this.assertKind("file");
    return await this.#privateMaterialization.writeCompanionFile(path, bytes, options);
  }

  async publishFile(expected: DerivedFilePublicationEvidence, options: { retainReservation?: boolean } = {}): Promise<void> {
    this.assertKind("file");
    const actual = await this.verifyFile();
    if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output staging bytes changed after readback verification.", this.stagingPath);
    }
    const verified = Object.freeze({ sha256: actual.sha256, byteLength: actual.byteLength });
    let publicationAttempted = false;
    try {
      await this.assertTopology();
      await this.assertStageIdentity();
      const forced = await removeForcedFileDestination(this.force, this.outputPath, {
        assertTopology: async () => await this.assertTopology(),
        assertDestinationIdentity: async () => await this.assertDestinationIdentity()
      });
      if (forced) { this.destinationIdentity = forced.destinationIdentity; this.#forcedDestinationRemoved = forced.removed; }
      await this.assertTopology();
      await this.assertStageIdentity();
      await this.assertDestinationIdentity();
      publicationAttempted = true;
      await link(this.stagingPath, this.outputPath);
      await this.assertTopology();
      const [stage, output] = await Promise.all([
        stableRegularFile(this.stagingPath, "Final output staging file", this.stageIdentity),
        stableRegularFile(this.outputPath, "Published final output", this.stageIdentity)
      ]);
      if (stage.size !== output.size || output.sha256 !== verified.sha256) {
        throw new Error("published output bytes did not match verified staging");
      }
      if (!options.retainReservation) await this.abort();
    } catch (error) {
      // A public name is never rolled back: another writer may have replaced it after publication.
      await this.abort().catch(() => undefined);
      if (publicationAttempted) {
        throw new PublicationCommitUncertainError({ publicPath: this.outputPath, kind: "file", expectedIdentity: this.stageIdentity, expected: verified }, error);
      }
      if (this.#forcedDestinationRemoved) {
        throw new DerivedOutputPublicationError("derived_output_publish_failed", "Final output publication failed after explicit force removed the previous output; no new output was observed committed.", this.outputPath);
      }
      if (error instanceof DerivedOutputPublicationError) throw error;
      if (error instanceof OutputPathTopologyError) throw unsafeParentError(this.outputPath, error);
      throw publicationError("derived_output_publish_failed", this.outputPath, error);
    }
  }
  /**
   * Re-read a retained public file through the private-stage identity.  Paired publishers use
   * this after publishing a receipt first: a path match alone is not evidence that the public
   * receipt still names the bytes this transaction staged.
   */
  async verifyPublishedFile(expected: DerivedFilePublicationEvidence): Promise<DerivedFilePublicationEvidence> {
    this.assertKind("file");
    await this.assertTopology();
    await this.assertStageIdentity();
    const published = await stableRegularFile(this.outputPath, "Published final output", this.stageIdentity);
    await this.assertTopology();
    if (published.sha256 !== expected.sha256 || published.size !== expected.byteLength) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Published final output no longer matches the verified staging bytes.", this.outputPath);
    }
    return { sha256: published.sha256, byteLength: published.size };
  }
  /**
   * Withdraw an already-linked file only while this reservation still proves it is our exact
   * staging inode and bytes.  This is deliberately unavailable for directories: paired CLI
   * publication uses it solely to remove a receipt when cancellation occurs before output
   * publication.  A substituted or retargeted public name is preserved.
   */
  async revokePublishedFile(expected: DerivedFilePublicationEvidence): Promise<void> {
    this.assertKind("file");
    await this.verifyPublishedFile(expected);
    try {
      await this.assertTopology();
      await this.assertStageIdentity();
      await unlink(this.outputPath);
    } catch (error) {
      if (error instanceof DerivedOutputPublicationError) throw error;
      if (error instanceof OutputPathTopologyError) throw unsafeParentError(this.outputPath, error);
      throw publicationError("derived_output_publish_failed", this.outputPath, error);
    }
    await this.abort();
  }

  async publishDirectory(expected: DerivedDirectoryPublicationEvidence, expectedEntries: readonly string[]): Promise<void> {
    this.assertKind("directory");
    const actual = await this.verifyDirectory(expectedEntries);
    if (actual.sha256 !== expected.sha256 || actual.entryCount !== expected.entryCount) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final directory staging changed after readback verification.", this.stagingPath);
    }
    const entries = [...expectedEntries].sort();
    const verified = Object.freeze({ sha256: actual.sha256, entryCount: actual.entryCount, entries: Object.freeze(entries) });
    let publicationAttempted = false;
    try {
      await this.assertTopology();
      await this.assertStageIdentity();
      await this.#emptyDirectory.claim(this.destinationIdentity, this.emptyDirectoryGuards());
      await this.assertTopology();
      await this.assertStageIdentity();
      await this.assertDestinationIdentity();
      publicationAttempted = true;
      await rename(this.stagingPath, this.outputPath);
      await this.assertTopology();
      const published = await verifyDirectoryAt(this.outputPath, expectedEntries, this.stageIdentity, "Published image sequence");
      if (published.sha256 !== verified.sha256 || published.entryCount !== verified.entryCount) {
        throw new Error("published directory identity did not match verified staging");
      }
      await this.#emptyDirectory.cleanup(async () => await this.assertTopology()).catch(() => undefined);
      await this.release().catch(() => undefined);
    } catch (error) {
      // A public directory name is never recursively removed after a failed readback.
      if (!publicationAttempted) await this.#emptyDirectory.restore(this.emptyDirectoryGuards()).catch(() => undefined);
      await this.abort().catch(() => undefined);
      if (publicationAttempted) {
        throw new PublicationCommitUncertainError({ publicPath: this.outputPath, kind: "directory", expectedIdentity: this.stageIdentity, expected: verified }, error);
      }
      if (error instanceof DerivedOutputPublicationError) throw error;
      if (error instanceof OutputPathTopologyError) throw unsafeParentError(this.outputPath, error);
      throw publicationError("derived_output_publish_failed", this.outputPath, error);
    }
  }

  /** Remove only the exact private stage, then release the exact private reservation. */
  async abort(): Promise<void> {
    if (this.#finished) return;
    try {
      await this.assertTopology();
      if (this.kind === "file") {
        await this.#privateMaterialization.removeCompanionDirectory();
        await this.assertStageIdentity();
        await unlink(this.stagingPath);
        await this.removePrivateFileAnchor(this.stageAnchor);
        await this.removePrivateFileAnchor(this.destinationAnchor);
      } else {
        await this.assertStageIdentity();
        await rm(this.stagingPath, { recursive: true, force: true });
      }
    } catch {
      // Identity loss is a preservation condition, not a cleanup reason.
    } finally {
      await this.release().catch(() => undefined);
    }
  }

  private emptyDirectoryGuards() {
    return {
      assertTopology: async () => await this.assertTopology(),
      assertDestinationIdentity: async () => await this.assertDestinationIdentity(),
      markDestinationMissing: () => { this.destinationIdentity = { kind: "missing" }; },
      markDestinationRestored: (identity: OutputPathIdentity) => { this.destinationIdentity = { kind: "directory", ...identity }; }
    };
  }

  private async assertTopology(): Promise<void> {
    try {
      await this.topology.assertCurrent();
    } catch (error) {
      throw unsafeParentError(this.outputPath, error);
    }
  }

  private async assertStageIdentity(): Promise<void> {
    try {
      await this.assertLockIdentity();
      if (this.kind === "file") {
        await this.assertPrivateFileAnchor(this.stageAnchor, "Final output staging identity anchor");
        await stableRegularFile(this.stagingPath, "Final output staging file", this.stageIdentity);
      } else {
        await assertOutputDirectoryIdentity(this.stagingPath, this.stageIdentity, "Final image-sequence staging", { private: true });
      }
    } catch (error) {
      if (error instanceof OutputPathTopologyError) {
        throw new DerivedOutputPublicationError("derived_output_stage_invalid", error.message, this.stagingPath);
      }
      throw error;
    }
  }

  private async assertDestinationIdentity(): Promise<OutputPathLeafIdentity> {
    try {
      await this.assertLockIdentity();
      await this.assertPrivateFileAnchor(this.destinationAnchor, "Forced final output identity anchor");
      return await assertOutputLeafIdentity(this.outputPath, this.destinationIdentity, "Final output destination");
    } catch (error) {
      if (error instanceof OutputPathTopologyError) {
        throw new DerivedOutputPublicationError("derived_output_exists", error.message, this.outputPath);
      }
      throw error;
    }
  }

  private assertKind(kind: DerivedOutputKind): void {
    if (this.kind !== kind) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `Final publication is ${this.kind}-shaped, not ${kind}-shaped.`, this.outputPath);
  }

  private async release(): Promise<void> {
    if (this.#finished) return;
    await removeExactPrivateDirectory(this.topology, this.lockPath, this.lockIdentity);
    this.#finished = true;
  }

  private async assertLockIdentity(): Promise<void> {
    try {
      await assertOutputDirectoryIdentity(this.lockPath, this.lockIdentity, "Final output reservation", { private: true });
    } catch (error) {
      throw unsafeParentError(this.outputPath, error);
    }
  }

  private async assertPrivateFileAnchor(anchor: PrivateFileAnchor | undefined, label: string): Promise<void> {
    if (!anchor) return;
    await stableRegularFile(anchor.path, label, anchor.identity);
  }

  private async removePrivateFileAnchor(anchor: PrivateFileAnchor | undefined): Promise<void> {
    if (!anchor) return;
    await this.assertPrivateFileAnchor(anchor, "Final output private identity anchor");
    await unlink(anchor.path);
  }
}

export async function acquireDerivedOutputPublication(input: DerivedOutputPublicationInput): Promise<DerivedOutputPublication> {
  return await DerivedOutputPublication.acquire(input);
}
