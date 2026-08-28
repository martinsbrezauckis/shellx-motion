/**
 * Receipt-first paired publication for CLI delivery artifacts.
 *
 * Two independently named files cannot be made one filesystem-atomic commit.  The honest
 * ordering is therefore receipt first, output last: a crash can leave a receipt that names a
 * missing artifact, which `verifyPairedReceiptOutput` rejects, but it cannot leave a delivered
 * output without its already-durable matching receipt.  The final output commit is the last I/O
 * operation on the success path.  This helper intentionally does not promise physical two-path
 * atomicity.
 */
import { copyFile, lstat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  acquireDerivedOutputPublication,
  isPublicationCommitUncertain,
  type DerivedFilePublicationEvidence,
  type DerivedOutputPublication,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import { PairedOutputReceiptCommitUncertainError } from "./paired-output-receipt-commit-uncertainty.js";
import {
  assertPairedReceiptAcceptance,
  markPairedOutputReceipt,
  verifyPairedReceiptOutput
} from "@shellx-motion/core/internal/paired-output-receipt-verification";
import {
  assertPrivateSecondarySource,
  assertReceiptBindsOutput,
  bindSecondaryArtifacts,
  normalizeReceiptArtifacts,
  rebindReceiptOutput,
  type BoundSecondaryArtifact
} from "./paired-output-receipt-binding";
import {
  type PairedOutputArtifactSpec,
  type PairedOutputReceiptPublicationOptions,
  type PairedSecondaryArtifactInput
} from "./paired-output-receipt-publication-types.js";
import { releaseRetainedPairedPrivateReservations } from "./paired-output-receipt-retained-cleanup.js";

export { assertPairedReceiptAcceptance, verifyPairedReceiptOutput } from "@shellx-motion/core/internal/paired-output-receipt-verification";

/**
 * The final link/rename may have succeeded before a post-publication identity recheck failed.
 * Callers must surface this as a delivery-uncertain result instead of reporting ordinary failure.
 */
export { PairedOutputReceiptCommitUncertainError } from "./paired-output-receipt-commit-uncertainty.js";
export type { PairedOutputReceiptPublicationOptions, PairedSecondaryArtifactInput } from "./paired-output-receipt-publication-types.js";
type StagedSecondaryArtifact = BoundSecondaryArtifact & { publication: DerivedOutputPublication };

/**
 * Owns both no-clobber reservations.  Renderers receive `outputPublication` and write only to
 * its same-filesystem private stage; the caller then supplies the complete final-path receipt.
 */
export class PairedOutputReceiptPublication {
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly outputPublication: DerivedOutputPublication;
  readonly #receiptPublication: DerivedOutputPublication;
  readonly #outputArtifact: PairedOutputArtifactSpec;
  readonly #receiptArtifact: PairedOutputArtifactSpec;
  readonly #faults: NonNullable<PairedOutputReceiptPublicationOptions["faults"]>;
  readonly #writeReceiptStage: (path: string, contents: string) => Promise<void>;
  readonly #copySecondaryStage: (source: string, destination: string) => Promise<void>;
  readonly #inspectSecondaryStage: (path: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  #outputEvidence: DerivedFilePublicationEvidence | undefined;
  #receiptEvidence: DerivedFilePublicationEvidence | undefined;
  #secondaryArtifacts: StagedSecondaryArtifact[] = [];
  #publishedSecondaryArtifacts: StagedSecondaryArtifact[] = [];
  #receiptPublished = false;
  /**
   * A secondary `publishFile` can link its public name before its identity recheck throws.
   * Unlike a verified secondary, that name is no longer safe for this transaction to revoke.
   */
  #secondaryPublicationUncertain = false;
  #receiptPublicationAttempted = false;
  #uncertainSecondaryPaths: string[] = [];
  #outputPublicationAttempted = false;
  #outputPublicationCompleted = false;
  #finished = false;
  #acquirePublication: (input: { outputPath: string; kind: "file"; force: boolean }) => Promise<DerivedOutputPublication>;

  private constructor(input: {
    options: PairedOutputReceiptPublicationOptions;
    outputPublication: DerivedOutputPublication;
    receiptPublication: DerivedOutputPublication;
  }) {
    this.outputPath = resolve(input.options.outputPath);
    this.receiptPath = resolve(input.options.receiptPath);
    this.outputPublication = input.outputPublication;
    this.#receiptPublication = input.receiptPublication;
    this.#outputArtifact = input.options.outputArtifact;
    this.#receiptArtifact = input.options.receiptArtifact;
    this.#faults = input.options.faults ?? {};
    this.#writeReceiptStage = input.options.testHooks?.writeReceiptStage ?? writeFile;
    this.#copySecondaryStage = input.options.testHooks?.copySecondaryStage ?? copyFile;
    this.#inspectSecondaryStage = input.options.testHooks?.inspectSecondaryStage ?? lstat;
    this.#acquirePublication = input.options.testHooks?.acquirePublication ?? acquireDerivedOutputPublication;
  }

  static async acquire(options: PairedOutputReceiptPublicationOptions): Promise<PairedOutputReceiptPublication> {
    const outputPath = resolve(options.outputPath);
    const receiptPath = resolve(options.receiptPath);
    if (outputPath === receiptPath) throw new Error("Paired output and receipt destinations must be distinct.");
    if (dirname(outputPath) !== dirname(receiptPath)) throw new Error("Paired output and receipt must share one governed parent directory.");
    const acquire = options.testHooks?.acquirePublication ?? acquireDerivedOutputPublication;
    const outputPublication = await acquire({ outputPath, kind: "file", force: options.forceOutput === true });
    try {
      const receiptPublication = await acquire({ outputPath: receiptPath, kind: "file", force: options.forceReceipt === true });
      return new PairedOutputReceiptPublication({ options, outputPublication, receiptPublication });
    } catch (error) {
      await outputPublication.abort();
      throw error;
    }
  }

  /**
   * Stage an additional renderer evidence file under its own no-clobber reservation. It remains
   * private until after the matching receipt has been durably published, and before the primary
   * output's final commit. This is intentionally a narrow receipt-bound extension rather than a
   * general multi-file transaction: independent path names cannot be made atomically visible.
   */
  async stageSecondaryArtifact(input: PairedSecondaryArtifactInput): Promise<ReceiptArtifact> {
    this.assertOpen();
    const outputPath = resolve(input.outputPath);
    if (outputPath === this.outputPath || outputPath === this.receiptPath
      || dirname(outputPath) !== dirname(this.outputPath)
      || this.#secondaryArtifacts.some((secondary) => secondary.publication.outputPath === outputPath)) {
      throw new Error("Paired secondary artifact destination must be distinct from every paired publication name.");
    }
    const acquire = this.#acquirePublication;
    let publication: DerivedOutputPublication | undefined;
    try {
      assertPrivateSecondarySource(input.stagedPath, this.outputPublication.stagingPath);
      const sourceFacts = await this.#inspectSecondaryStage(resolve(input.stagedPath));
      if (!sourceFacts.isFile() || sourceFacts.isSymbolicLink()) {
        throw new Error("Paired secondary artifact must be a regular non-symlink private stage file.");
      }
      publication = await acquire({ outputPath, kind: "file", force: false });
      await this.#copySecondaryStage(resolve(input.stagedPath), publication.stagingPath);
      const evidence = await publication.verifyFile();
      const artifact: ReceiptArtifact = {
        role: input.artifact.role,
        path: outputPath,
        status: "available",
        ...(input.artifact.mediaType ? { mediaType: input.artifact.mediaType } : {}),
        ...(input.artifact.primary === undefined ? {} : { primary: input.artifact.primary })
      };
      this.#secondaryArtifacts.push({ publication, evidence, artifact, inputHashKey: input.inputHashKey });
      return artifact;
    } catch (error) {
      await publication?.abort().catch(() => undefined);
      await this.abortPrivate().catch(() => undefined);
      this.#finished = true;
      throw error;
    }
  }

  /**
   * Bind and stage the receipt only after the renderer's private output was read back.  The
   * receipt's public path/hash and both self-describing artifacts are checked before its own
   * no-clobber publication can begin.
   */
  async stageReceipt(receipt: OperationReceipt): Promise<void> {
    this.assertOpen();
    try {
      this.#outputEvidence = await this.outputPublication.verifyFile();
      await this.#faults.afterReceiptPreflight?.();
      rebindReceiptOutput(receipt, this.outputPublication.stagingPath, this.outputPath, this.#outputEvidence);
      markPairedOutputReceipt(receipt, this.receiptPath);
      bindSecondaryArtifacts(receipt, this.#secondaryArtifacts);
      normalizeReceiptArtifacts(receipt, this.outputPublication.stagingPath, this.outputPath, this.receiptPath, this.#outputArtifact, this.#receiptArtifact);
      assertReceiptBindsOutput(receipt, this.outputPath, this.#outputEvidence);
      await this.#writeReceiptStage(this.#receiptPublication.stagingPath, `${JSON.stringify(receipt, null, 2)}\n`);
      this.#receiptEvidence = await this.#receiptPublication.verifyFile();
      await this.#faults.afterReceiptStaged?.();
    } catch (error) {
      await this.abortPrivate().catch(() => undefined);
      this.#finished = true;
      throw error;
    }
  }

  /**
   * Publish the receipt first and the artifact last.  Once output publication is attempted, the
   * receipt is retained even on an error because the underlying no-clobber primitive can have
   * linked the public output before a post-link identity recheck fails.
   */
  async commit(options: { cancelled?: () => boolean } = {}): Promise<void> {
    this.assertOpen();
    if (!this.#outputEvidence || !this.#receiptEvidence) throw new Error("Paired receipt must be staged before publication.");
    if (options.cancelled?.()) {
      await this.abortPrivate().catch(() => undefined);
      this.#finished = true;
      throw new Error("Preview or render was cancelled before receipt publication.");
    }
    try {
      await this.#faults.beforeReceiptCommit?.();
      this.#receiptPublicationAttempted = true;
      await this.#receiptPublication.publishFile(this.#receiptEvidence, { retainReservation: true });
      this.#receiptPublished = true;
      await this.#receiptPublication.verifyPublishedFile(this.#receiptEvidence);
      await this.#faults.afterReceiptCommitted?.();
      if (options.cancelled?.()) {
        await this.revokeReceiptBeforeOutput();
        throw new Error("Preview or render was cancelled before output publication.");
      }
      for (const secondary of this.#secondaryArtifacts) {
        try {
          await secondary.publication.publishFile(secondary.evidence, { retainReservation: true });
        } catch (error) {
          // Core's typed uncertainty is the authority that its link may have happened. An
          // ordinary `publishFile` refusal is pre-link, so all transaction-owned evidence can
          // still be revoked by the outer cleanup path.
          if (isPublicationCommitUncertain(error)) {
            this.#secondaryPublicationUncertain = true;
            this.#uncertainSecondaryPaths.push(secondary.publication.outputPath);
          }
          throw error;
        }
        try {
          await secondary.publication.verifyPublishedFile(secondary.evidence);
          this.#publishedSecondaryArtifacts.push(secondary);
        } catch (error) {
          // `publishFile` completed, so the secondary name was public even if its later
          // identity check cannot establish that it remains ours. Preserve it for reconciliation.
          this.#secondaryPublicationUncertain = true;
          this.#uncertainSecondaryPaths.push(secondary.publication.outputPath);
          throw error;
        }
      }
      await this.#faults.beforeOutputCommit?.();
      if (options.cancelled?.()) {
        await this.revokePublishedEvidenceBeforeOutput();
        throw new Error("Preview or render was cancelled before output publication.");
      }
      this.#outputPublicationAttempted = true;
      // This is intentionally the final production I/O on the successful path.
      await this.outputPublication.publishFile(this.#outputEvidence);
      this.#outputPublicationCompleted = true;
      await this.#faults.afterOutputCommitAttempt?.();
      await releaseRetainedPairedPrivateReservations(this.#receiptPublication, this.#secondaryArtifacts);
      this.#finished = true;
    } catch (error) {
      const outputPublicationKnownAbsent = this.#outputPublicationAttempted
        && !this.#outputPublicationCompleted
        && !isPublicationCommitUncertain(error);
      if (outputPublicationKnownAbsent) {
        await this.revokePublishedEvidenceBeforeOutput().catch(() => undefined);
        await Promise.allSettled([
          this.outputPublication.abort(),
          this.#receiptPublication.abort(),
          ...this.#secondaryArtifacts.map(async (secondary) => await secondary.publication.abort())
        ]);
      } else if (!this.#outputPublicationAttempted && !this.#secondaryPublicationUncertain) {
        // Before a primary link attempt, a non-uncertain failure leaves only transaction-proven
        // public evidence. Remove every such secondary, then its receipt.
        await this.revokePublishedEvidenceBeforeOutput().catch(() => undefined);
        await Promise.allSettled([
          this.outputPublication.abort(),
          this.#receiptPublication.abort(),
          ...this.#secondaryArtifacts.map(async (secondary) => await secondary.publication.abort())
        ]);
      }
      // After an output publication attempt, preserving the durable receipt is the only safe
      // choice: the output may already be linked, and a failed post-link recheck is not authority
      // to delete either public name.
      else await Promise.allSettled([
        this.outputPublication.abort(),
        this.#receiptPublication.abort(),
        ...this.#secondaryArtifacts.map(async (secondary) => await secondary.publication.abort())
      ]);
      this.#finished = true;
      if (isPublicationCommitUncertain(error)) {
        const phase = this.#outputPublicationAttempted
          ? "output"
          : this.#secondaryPublicationUncertain
            ? "secondary"
            : this.#receiptPublicationAttempted
              ? "receipt"
              : "output";
        throw new PairedOutputReceiptCommitUncertainError({
          outputPath: this.outputPath,
          receiptPath: this.receiptPath,
          phase,
          publicPaths: [error.evidence.publicPath],
          expectedPublications: [error.evidence],
          cause: error
        });
      }
      if (this.#outputPublicationCompleted || this.#secondaryPublicationUncertain) {
        throw new PairedOutputReceiptCommitUncertainError({
          outputPath: this.outputPath,
          receiptPath: this.receiptPath,
          phase: this.#outputPublicationCompleted ? "output" : "secondary",
          publicPaths: this.#outputPublicationCompleted ? [this.outputPath] : this.#uncertainSecondaryPaths,
          cause: error
        });
      }
      throw error;
    }
  }

  /** Cancel/failure cleanup before a public receipt exists. */
  async abort(): Promise<void> {
    if (this.#finished) return;
    try {
      await this.abortPrivate();
    } finally {
      this.#finished = true;
    }
  }

  private async revokeReceiptBeforeOutput(): Promise<void> {
    if (!this.#receiptPublished || !this.#receiptEvidence) return;
    await this.#receiptPublication.revokePublishedFile(this.#receiptEvidence);
    this.#receiptPublished = false;
  }

  /** Remove only evidence this transaction still proves it owns, then its matching receipt. */
  private async revokePublishedEvidenceBeforeOutput(): Promise<void> {
    for (const secondary of [...this.#publishedSecondaryArtifacts].reverse()) {
      await secondary.publication.revokePublishedFile(secondary.evidence);
    }
    this.#publishedSecondaryArtifacts = [];
    await this.revokeReceiptBeforeOutput();
  }

  private async abortPrivate(): Promise<void> {
    let revocationError: unknown;
    if (this.#receiptPublished) {
      try {
        await this.revokeReceiptBeforeOutput();
      } catch (error) {
        revocationError = error;
      }
    }
    await Promise.allSettled([
      this.outputPublication.abort(),
      this.#receiptPublication.abort(),
      ...this.#secondaryArtifacts.map(async (secondary) => await secondary.publication.abort())
    ]);
    if (revocationError) throw revocationError;
  }

  private assertOpen(): void {
    if (this.#finished) throw new Error("Paired output/receipt publication is already finished.");
  }
}
