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
import { constants } from "node:fs";
import { link, open, rename, rm, unlink } from "node:fs/promises";
import { assertOutputDirectoryIdentity, assertOutputLeafIdentity, OutputPathTopology, OutputPathTopologyError, type OutputPathIdentity, type OutputPathLeafIdentity } from "./output-path-topology";
import { assertRegularFileIdentity, removeExactPrivateDirectory, stableRegularFile, verifyDirectoryAt, type PrivateFileAnchor } from "./derived-output-publication-private";
import { DerivedOutputPrivateMaterialization, type DerivedOutputPrivateChunkWriter } from "./derived-output-private-materialization";
import { DerivedOutputPublicationError, DerivedOutputPublicationPreLinkCancelledError, type DerivedDirectoryPublicationEvidence, type DerivedFilePublicationEvidence, type DerivedOutputKind, type DerivedOutputPublicationErrorCode, type DerivedOutputPublicationInput } from "./derived-output-publication-types";
import { publicationError, unsafeParentError } from "./derived-output-publication-admission";
import { rememberCoreDerivedOutputPublication } from "./derived-output-publication-authority";
import { prepareDerivedOutputPublication } from "./derived-output-publication-acquire";
import { PublicationCommitUncertainError } from "./publication-commit-uncertainty";
import { DerivedOutputEmptyDirectory } from "./derived-output-empty-directory";
import { removeForcedFileDestination } from "./derived-output-forced-file";
import { heldOutputDirectoryState } from "./output-path-held-directory-authority";
export {
  DerivedOutputPublicationError,
  type DerivedDirectoryPublicationEvidence,
  type DerivedFilePublicationEvidence,
  type DerivedOutputKind,
  type DerivedOutputPublicationErrorCode,
  type DerivedOutputPublicationInput
} from "./derived-output-publication-types";
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
    private readonly destinationAnchor: PrivateFileAnchor | undefined,
    private readonly heldDirectoryAuthority: unknown,
    private readonly privateFileMaximumBytes: number | undefined
  ) {
    this.#emptyDirectory = new DerivedOutputEmptyDirectory(replaceEmptyDirectory, outputPath, lockPath);
    this.#privateMaterialization = new DerivedOutputPrivateMaterialization({
      stagingPath,
      lockPath,
      stageIdentity,
      stageLinkCount,
      assertWriterCurrent: async () => {
        await this.assertTopology();
        await this.assertLockIdentity();
        await this.assertPrivateFileAnchor(this.stageAnchor, "Final output staging identity anchor");
      },
      assertCurrent: async () => {
        await this.assertTopology();
        await this.assertStageIdentity();
      }
    });
  }
  static async acquire(input: DerivedOutputPublicationInput): Promise<DerivedOutputPublication> {
    const prepared = await prepareDerivedOutputPublication(input);
    const publication = new DerivedOutputPublication(prepared.outputPath, prepared.rootPath, prepared.stagingPath, prepared.kind, prepared.force, prepared.replaceEmptyDirectory, prepared.topology, prepared.lockPath, prepared.lockIdentity, prepared.stageIdentity, prepared.stageLinkCount, prepared.stageAnchor, prepared.destinationIdentity, prepared.destinationAnchor, input.internalHeldDirectoryAuthority, input.internalPrivateFileMaxBytes);
    rememberCoreDerivedOutputPublication(publication);
    return publication;
  }
  async verifyFile(): Promise<DerivedFilePublicationEvidence> { this.assertKind("file"); await this.assertTopology(); const facts = await stableRegularFile(this.stagingPath, "Final output staging file", this.stageIdentity, this.privateFileMaximumBytes); await this.assertTopology(); return { sha256: facts.sha256, byteLength: facts.size }; }
  async verifyDirectory(expectedEntries: readonly string[]): Promise<DerivedDirectoryPublicationEvidence> { this.assertKind("directory"); await this.assertTopology(); const evidence = await verifyDirectoryAt(this.stagingPath, expectedEntries, this.stageIdentity, "Final image-sequence staging"); await this.assertTopology(); return evidence; }
  async writePrivateFile(bytes: Buffer, options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> { this.assertKind("file"); return await this.#privateMaterialization.writeFile(bytes, options); }
  async createPrivateFileChunkWriter(options: { label: string; maxBytes: number }): Promise<DerivedOutputPrivateChunkWriter> { this.assertKind("file"); return await this.#privateMaterialization.createChunkWriter(options); }
  async assertPrivateFileChunkWriterClosed(): Promise<void> { this.assertKind("file"); await this.#privateMaterialization.assertChunkWriterClosed(); }
  async abandonPrivateFileChunkWriter(): Promise<void> { this.assertKind("file"); await this.#privateMaterialization.abandonChunkWriter(); }
  /** Core-held streamed evidence is incrementally digested; V1 takes one final bounded full pass at link time. */
  async verifyIncrementalPrivateFile(options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> { this.assertKind("file"); return await this.#privateMaterialization.verifyIncrementalChunkWriterEvidence(options); }
  async readPrivateFile(options: { label: string; maxBytes: number }): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> { this.assertKind("file"); return await this.#privateMaterialization.readFile(options); }
  async verifyPrivateFile(options: { label: string; maxBytes: number; additionalLinks?: number }): Promise<DerivedFilePublicationEvidence> { this.assertKind("file"); return await this.#privateMaterialization.verifyBoundedFile(options); }
  async withVerifiedPrivateFile<T>(expected: DerivedFilePublicationEvidence, operation: (handle: import("node:fs/promises").FileHandle) => Promise<T>): Promise<T> { this.assertKind("file"); return await this.#privateMaterialization.withVerifiedFile(expected, operation); }
  async assertVerifiedPrivateFileIdentity(expected: DerivedFilePublicationEvidence, additionalLinks = 0): Promise<void> { this.assertKind("file"); await this.#privateMaterialization.assertVerifiedFileIdentity(expected, additionalLinks); }
  async syncPrivateFile(options: { label: string; maxBytes: number }): Promise<void> { this.assertKind("file"); await this.#privateMaterialization.syncBoundedFile(options); }
  async syncPublicationParent(): Promise<void> {
    this.assertKind("file");
    await this.assertTopology();
    const held = heldOutputDirectoryState(this.heldDirectoryAuthority);
    if (held) { await held.syncParent(); return; }
    const handle = await open(this.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { const facts = await handle.stat(); if (!facts.isDirectory() || facts.isSymbolicLink()) throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final publication parent is not a regular directory.", this.rootPath); await handle.sync(); await this.assertTopology(); } finally { await handle.close(); }
  }
  async createPrivateCompanionDirectory(purpose: "browser-capture-html"): Promise<string> { this.assertKind("file"); return await this.#privateMaterialization.createCompanionDirectory(purpose); }
  async writePrivateCompanionFile(path: string, bytes: Buffer, options: { label: string; maxBytes: number }): Promise<DerivedFilePublicationEvidence> { this.assertKind("file"); return await this.#privateMaterialization.writeCompanionFile(path, bytes, options); }
  async publishFile(expected: DerivedFilePublicationEvidence, options: { retainReservation?: boolean; onPublicLinkBoundary?: () => Promise<void> | void; reuseVerifiedPrivateEvidence?: boolean } = {}): Promise<void> {
    this.assertKind("file");
    const actual = options.reuseVerifiedPrivateEvidence
      ? await this.#privateMaterialization.withVerifiedFile(expected, async () => expected)
      : await this.verifyFile();
    if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output staging bytes changed after readback verification.", this.stagingPath);
    }
    const verified = Object.freeze({ sha256: actual.sha256, byteLength: actual.byteLength });
    let publicationAttempted = false;
    try {
      await this.assertTopology();
      await this.assertStageIdentity(options.reuseVerifiedPrivateEvidence ? verified : undefined);
      const forced = await removeForcedFileDestination(this.force, this.outputPath, {
        assertTopology: async () => await this.assertTopology(),
        assertDestinationIdentity: async () => await this.assertDestinationIdentity()
      });
      if (forced) { this.destinationIdentity = forced.destinationIdentity; this.#forcedDestinationRemoved = forced.removed; }
      await this.assertTopology();
      await this.assertStageIdentity(options.reuseVerifiedPrivateEvidence ? verified : undefined);
      await this.assertDestinationIdentity();
      // The boundary hook is deliberately last: V1 samples cancellation and its retained
      // same-parent evidence here, immediately before the no-clobber link(2) syscall.
      // Do not insert a further await/check between this hook and link().
      await options.onPublicLinkBoundary?.();
      publicationAttempted = true;
      await link(this.stagingPath, this.outputPath);
      await this.assertTopology();
      if (options.reuseVerifiedPrivateEvidence) await this.assertLinkedPublishedFileIdentity(verified);
      else {
        const [stage, output] = await Promise.all([stableRegularFile(this.stagingPath, "Final output staging file", this.stageIdentity, this.privateFileMaximumBytes), stableRegularFile(this.outputPath, "Published final output", this.stageIdentity, this.privateFileMaximumBytes)]);
        if (stage.size !== output.size || output.sha256 !== verified.sha256) throw new Error("published output bytes did not match verified staging");
      }
      if (!options.retainReservation) await this.abort();
    } catch (error) {
      // A public name is never rolled back: another writer may have replaced it after publication.
      await this.abort().catch(() => undefined);
      if (publicationAttempted) {
        throw new PublicationCommitUncertainError({ publicPath: this.outputPath, kind: "file", expectedIdentity: this.stageIdentity, expected: verified }, error);
      }
      if (error instanceof DerivedOutputPublicationPreLinkCancelledError) throw error;
      if (this.#forcedDestinationRemoved) {
        throw new DerivedOutputPublicationError("derived_output_publish_failed", "Final output publication failed after explicit force removed the previous output; no new output was observed committed.", this.outputPath);
      }
      if (error instanceof DerivedOutputPublicationError) throw error;
      if (error instanceof OutputPathTopologyError) throw unsafeParentError(this.outputPath, error);
      throw publicationError("derived_output_publish_failed", this.outputPath, error);
    }
  }
  /** Re-read retained public bytes through the private-stage identity. */
  async verifyPublishedFile(expected: DerivedFilePublicationEvidence): Promise<DerivedFilePublicationEvidence> {
    this.assertKind("file");
    await this.assertTopology();
    await this.assertStageIdentity();
    const published = await stableRegularFile(this.outputPath, "Published final output", this.stageIdentity, this.privateFileMaximumBytes);
    await this.assertTopology();
    if (published.sha256 !== expected.sha256 || published.size !== expected.byteLength) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Published final output no longer matches the verified staging bytes.", this.outputPath);
    }
    return { sha256: published.sha256, byteLength: published.size };
  }
  async captureRetainedPublishedFileIdentity(expected: DerivedFilePublicationEvidence): Promise<Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }>> {
    this.assertKind("file");
    await this.assertTopology(); await this.assertStageIdentity();
    const cached = await stableRegularFile(this.outputPath, "Published final output", this.stageIdentity, this.privateFileMaximumBytes);
    if (cached.sha256 !== expected.sha256 || cached.size !== expected.byteLength) throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Published final output no longer matches the verified staging bytes.", this.outputPath);
    const handle = await open(this.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const facts = publishedFileIdentity(await handle.stat());
      if (facts.nlink < 2 || facts.dev !== cached.dev || facts.ino !== cached.ino || facts.size !== cached.size || facts.mtimeMs !== cached.mtimeMs || facts.ctimeMs !== cached.ctimeMs || facts.nlink !== cached.nlink) throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Published final output changed after its bounded verification.", this.outputPath);
      await this.assertTopology(); return facts;
    } finally { await handle.close(); }
  }
  async captureRetainedPublishedFileIdentityWithoutHash(expected: DerivedFilePublicationEvidence, options: { afterCachedVerification?: () => Promise<void> | void } = {}): Promise<Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }>> {
    this.assertKind("file");
    return await this.assertLinkedPublishedFileIdentity(expected, options.afterCachedVerification);
  }
  async verifyPublishedFileIdentityWithoutHash(expected: DerivedFilePublicationEvidence): Promise<void> { this.assertKind("file"); await this.assertLinkedPublishedFileIdentity(expected); }
  /** Held receipt-first authority only: stage, private anchor, and public receipt are the exact three links before media may link. */
  async assertExclusiveRetainedPublishedFile(expected: DerivedFilePublicationEvidence): Promise<void> {
    this.assertKind("file"); const facts = await this.assertLinkedPublishedFileIdentity(expected);
    if (facts.nlink !== 3) throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Retained receipt lost its exclusive stage/anchor/public-link identity before media publication.", this.outputPath);
  }
  /** Withdraw only a still-proven stage inode; substitutions are preserved. */
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
        await this.assertLockIdentity();
        await assertRegularFileIdentity(this.stagingPath, "Final output staging file", this.stageIdentity);
        await this.assertPrivateFileAnchor(this.stageAnchor, "Final output staging identity anchor");
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
  private async assertStageIdentity(verified?: DerivedFilePublicationEvidence): Promise<void> {
    try {
      await this.assertLockIdentity();
      if (this.kind === "file") {
        await this.assertPrivateFileAnchor(this.stageAnchor, "Final output staging identity anchor");
        if (heldOutputDirectoryState(this.heldDirectoryAuthority) && verified) {
          await this.#privateMaterialization.assertVerifiedFileIdentity(verified);
        } else {
          await stableRegularFile(this.stagingPath, "Final output staging file", this.stageIdentity, this.privateFileMaximumBytes);
        }
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
  private async assertLinkedPublishedFileIdentity(expected: DerivedFilePublicationEvidence, afterCachedVerification?: () => Promise<void> | void): Promise<Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }>> {
    await this.assertTopology(); await this.assertLockIdentity(); await this.assertPrivateFileAnchor(this.stageAnchor, "Final output staging identity anchor");
    const cached = await this.#privateMaterialization.assertVerifiedFileIdentity(expected, 1);
    await afterCachedVerification?.();
    const handle = await open(this.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const output = await handle.stat();
      const facts = publishedFileIdentity(output);
      if (!output.isFile() || facts.dev !== cached.dev || facts.ino !== cached.ino || facts.size !== cached.byteLength || facts.mtimeMs !== cached.mtimeMs || facts.ctimeMs !== cached.ctimeMs || facts.nlink !== cached.nlink) throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Published final output changed after bounded verification.", this.outputPath);
      await this.assertTopology(); return facts;
    } finally { await handle.close(); }
  }
  private assertKind(kind: DerivedOutputKind): void {
    if (this.kind !== kind) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `Final publication is ${this.kind}-shaped, not ${kind}-shaped.`, this.outputPath);
  }
  private async release(): Promise<void> {
    if (this.#finished) return;
    await removeExactPrivateDirectory(this.topology, this.lockPath, this.lockIdentity, this.heldDirectoryAuthority);
    this.#finished = true;
  }
  private async assertLockIdentity(): Promise<void> {
    try {
      await assertOutputDirectoryIdentity(this.lockPath, this.lockIdentity, "Final output reservation", { private: true, heldDirectoryAuthority: this.heldDirectoryAuthority });
    } catch (error) {
      throw unsafeParentError(this.outputPath, error);
    }
  }
  private async assertPrivateFileAnchor(anchor: PrivateFileAnchor | undefined, label: string): Promise<void> {
    if (!anchor) return;
    await assertRegularFileIdentity(anchor.path, label, anchor.identity);
  }
  private async removePrivateFileAnchor(anchor: PrivateFileAnchor | undefined): Promise<void> {
    if (!anchor) return;
    await this.assertPrivateFileAnchor(anchor, "Final output private identity anchor");
    await unlink(anchor.path);
  }
}

function publishedFileIdentity(facts: import("node:fs").Stats): Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }> {
  return Object.freeze({ dev: Number(facts.dev), ino: Number(facts.ino), size: facts.size, mtimeMs: facts.mtimeMs, ctimeMs: facts.ctimeMs, nlink: facts.nlink });
}
export async function acquireDerivedOutputPublication(input: DerivedOutputPublicationInput): Promise<DerivedOutputPublication> {
  return await DerivedOutputPublication.acquire(input);
}
