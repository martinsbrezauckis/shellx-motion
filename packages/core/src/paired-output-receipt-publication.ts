/** Receipt-first pair: output never appears without a receipt; a crash may retain receipt-only evidence. */
import { copyFile, lstat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { acquireDerivedOutputPublication, type DerivedFilePublicationEvidence, type DerivedOutputPublication } from "./derived-output-publication";
import { DerivedOutputPublicationPreLinkCancelledError } from "./derived-output-publication-types";
import { assertPairedReceiptAcceptance, verifyPairedReceiptOutput } from "./paired-output-receipt-verification";
import { isPublicationCommitUncertain } from "./publication-commit-uncertainty";
import { assertPrivateSecondarySource, PairedOutputReceiptCancelledError, PairedOutputReceiptCommitUncertainError, pairedOutputReceiptDestinationError, releaseRetainedPairedPrivateReservations, type BoundSecondaryArtifact, type PairedOutputArtifactSpec, type PairedPublishedFileIdentity, type PairedPublishedPairIdentity, type PairedOutputReceiptPublicationOptions, type PairedSecondaryArtifactInput } from "./paired-output-receipt-publication-support";
import type { OperationReceipt, ReceiptArtifact } from "./types";
import { heldOutputDirectoryBindingPath, heldOutputDirectoryChildPath, heldOutputDirectoryState } from "./output-path-held-directory-authority";
import { captureExactHeldPair, retainReleasedHeldPairCapture } from "./paired-output-receipt-held-capture";
import { stagePairedSecondaryArtifact, type StagedSecondaryArtifact } from "./paired-output-receipt-secondary-stage";
import { stagePairedReceiptEvidence } from "./paired-output-receipt-stage-evidence";
import { recordStrictSdrCandidateFinalReceiptIfRegistered } from "./strict-sdr-candidate-held-pair-registry";
export { assertPairedReceiptAcceptance, verifyPairedReceiptOutput } from "./paired-output-receipt-verification";
export { assertPrivateSecondarySource, assertReceiptBindsOutput, bindSecondaryArtifacts, isPairedOutputReceiptDestinationError, normalizeReceiptArtifacts, pairedOutputReceiptDestinationError, pairedOutputReceiptDestinationErrorFields, PairedOutputReceiptCommitUncertainError, PairedOutputReceiptCancelledError, PairedOutputReceiptDestinationError, type PairedPublishedPairIdentity, rebindReceiptOutput, releaseRetainedPairedPrivateReservations } from "./paired-output-receipt-publication-support";
export type { BoundSecondaryArtifact, PairedArtifactSpec, PairedOutputArtifactSpec, PairedOutputReceiptArtifact, PairedOutputReceiptPublicationOptions, PairedSecondaryArtifactInput } from "./paired-output-receipt-publication-support";
export { withRetainedPairedPublishedPairCapture } from "./paired-output-receipt-held-capture";
export class PairedOutputReceiptPublication {
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly outputPublication: DerivedOutputPublication;
  readonly #receiptPublication: DerivedOutputPublication;
  readonly #outputArtifact: PairedOutputArtifactSpec;
  readonly #receiptArtifact: PairedOutputArtifactSpec;
  readonly #retainCommittedEvidenceOnFailure: boolean;
  readonly #receiptBindingOutputPath: string; readonly #receiptBindingReceiptPath: string;
  readonly #durablePublication: Readonly<{ outputMaxBytes: number; receiptMaxBytes: number }> | undefined;
  readonly #receiptSerialization: Readonly<{ serialize(receipt: OperationReceipt): string; maxBytes: number }> | undefined;
  readonly #onDurabilityStep: ((step: "output_private" | "receipt_private" | "receipt_parent" | "output_parent") => Promise<void> | void) | undefined;
  readonly #heldDirectoryAuthority: unknown;
  readonly #faults: NonNullable<PairedOutputReceiptPublicationOptions["faults"]>;
  readonly #writeReceiptStage: (path: string, contents: string) => Promise<void>;
  readonly #copySecondaryStage: (source: string, destination: string) => Promise<void>;
  readonly #inspectSecondaryStage: (path: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  #outputEvidence: DerivedFilePublicationEvidence | undefined;
  #receiptEvidence: DerivedFilePublicationEvidence | undefined;
  #secondaryArtifacts: StagedSecondaryArtifact[] = [];
  #publishedSecondaryArtifacts: StagedSecondaryArtifact[] = [];
  #receiptPublished = false;
  #secondaryPublicationUncertain = false;
  #receiptPublicationAttempted = false;
  #uncertainSecondaryPaths: string[] = [];
  #outputPublicationAttempted = false;
  #outputPublicationCompleted = false;
  #publishedPairIdentity: PairedPublishedPairIdentity | undefined;
  #finished = false;
  #acquirePublication: (input: { outputPath: string; kind: "file"; force: boolean }) => Promise<DerivedOutputPublication>;
  private constructor(input: { options: PairedOutputReceiptPublicationOptions; outputPublication: DerivedOutputPublication; receiptPublication: DerivedOutputPublication }) {
    this.outputPath = resolve(input.options.outputPath);
    this.receiptPath = resolve(input.options.receiptPath);
    this.outputPublication = input.outputPublication;
    this.#receiptPublication = input.receiptPublication;
    this.#outputArtifact = input.options.outputArtifact;
    this.#receiptArtifact = input.options.receiptArtifact;
    this.#retainCommittedEvidenceOnFailure = input.options.retainCommittedEvidenceOnFailure === true;
    this.#heldDirectoryAuthority = input.options.internalHeldDirectoryAuthority;
    const held = heldOutputDirectoryState(this.#heldDirectoryAuthority);
    if (held) {
      const outputName = basename(this.outputPath), receiptName = basename(this.receiptPath);
      if (this.outputPath !== heldOutputDirectoryChildPath(this.#heldDirectoryAuthority, outputName) || this.receiptPath !== heldOutputDirectoryChildPath(this.#heldDirectoryAuthority, receiptName)) throw new Error("Paired held-directory paths must be exact direct children of one retained authority.");
      this.#receiptBindingOutputPath = heldOutputDirectoryBindingPath(this.#heldDirectoryAuthority, outputName);
      this.#receiptBindingReceiptPath = heldOutputDirectoryBindingPath(this.#heldDirectoryAuthority, receiptName);
    } else { this.#receiptBindingOutputPath = resolve(input.options.outputPath); this.#receiptBindingReceiptPath = resolve(input.options.receiptPath); }
    if (dirname(this.#receiptBindingOutputPath) !== dirname(this.#receiptBindingReceiptPath)) throw new Error("Paired receipt binding paths must share one governed parent directory.");
    this.#durablePublication = input.options.durablePublication;
    this.#receiptSerialization = input.options.receiptSerialization;
    this.#onDurabilityStep = input.options.testHooks?.onDurabilityStep;
    if (this.#durablePublication && (!Number.isSafeInteger(this.#durablePublication.outputMaxBytes) || this.#durablePublication.outputMaxBytes < 2 || !Number.isSafeInteger(this.#durablePublication.receiptMaxBytes) || this.#durablePublication.receiptMaxBytes < 2)) throw new Error("Durable paired publication requires bounded output and receipt byte ceilings.");
    if (this.#receiptSerialization && (!Number.isSafeInteger(this.#receiptSerialization.maxBytes) || this.#receiptSerialization.maxBytes < 2)) throw new Error("Paired receipt serialization requires a bounded positive byte ceiling.");
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
    let outputPublication: DerivedOutputPublication;
    try { outputPublication = await acquire({ outputPath, kind: "file", force: options.forceOutput === true, internalHeldDirectoryAuthority: options.internalHeldDirectoryAuthority, internalPrivateFileMaxBytes: options.durablePublication?.outputMaxBytes }); } catch (error) { throw pairedOutputReceiptDestinationError("media_output", outputPath, receiptPath, error); }
    let receiptPublication: DerivedOutputPublication | undefined;
    try {
      receiptPublication = await acquire({ outputPath: receiptPath, kind: "file", force: options.forceReceipt === true, internalHeldDirectoryAuthority: options.internalHeldDirectoryAuthority, internalPrivateFileMaxBytes: options.durablePublication?.receiptMaxBytes });
      return new PairedOutputReceiptPublication({ options, outputPublication, receiptPublication });
    } catch (error) {
      await Promise.allSettled([outputPublication.abort(), receiptPublication?.abort()]);
      throw pairedOutputReceiptDestinationError("receipt_sidecar", outputPath, receiptPath, error);
    }
  }
  async stageSecondaryArtifact(input: PairedSecondaryArtifactInput): Promise<ReceiptArtifact> {
    this.assertOpen();
    try {
      const secondary = await stagePairedSecondaryArtifact(input, {
        outputPath: this.outputPath, receiptPath: this.receiptPath, primaryStagePath: this.outputPublication.stagingPath,
        existingPaths: this.#secondaryArtifacts.map((value) => value.publication.outputPath),
        inspect: this.#inspectSecondaryStage, acquire: this.#acquirePublication, copy: this.#copySecondaryStage
      });
      this.#secondaryArtifacts.push(secondary);
      return secondary.artifact;
    } catch (error) {
      await this.abortPrivate().catch(() => undefined);
      this.#finished = true;
      throw error;
    }
  }
  async stageReceipt(receipt: OperationReceipt, knownOutputEvidence?: DerivedFilePublicationEvidence): Promise<void> {
    this.assertOpen();
    try {
      await this.assertHeldCurrent();
      this.#outputEvidence = heldOutputDirectoryState(this.#heldDirectoryAuthority) && knownOutputEvidence
        ? await this.outputPublication.withVerifiedPrivateFile(knownOutputEvidence, async () => knownOutputEvidence)
        : heldOutputDirectoryState(this.#heldDirectoryAuthority)
          ? await this.outputPublication.verifyPrivateFile({ label: "Paired held private output", maxBytes: this.#durablePublication?.outputMaxBytes ?? Number.MAX_SAFE_INTEGER })
        : await this.outputPublication.verifyFile();
      await this.#faults.afterReceiptPreflight?.();
      this.#receiptEvidence = await stagePairedReceiptEvidence({
        receipt,
        outputEvidence: this.#outputEvidence!,
        paths: { stagedOutput: this.outputPublication.stagingPath, output: this.#receiptBindingOutputPath, receipt: this.#receiptBindingReceiptPath },
        artifacts: { output: this.#outputArtifact, receipt: this.#receiptArtifact, secondary: this.#secondaryArtifacts },
        publications: { receipt: this.#receiptPublication },
        storage: { heldDirectoryAuthority: this.#heldDirectoryAuthority, receiptMaxBytes: this.#durablePublication?.receiptMaxBytes, serialization: this.#receiptSerialization, writeStage: (path, contents) => this.#writeReceiptStage(path, contents) },
      });
      await this.#faults.afterReceiptStaged?.();
      recordStrictSdrCandidateFinalReceiptIfRegistered(this, this.#heldDirectoryAuthority, this.outputPublication, this.#outputEvidence!, this.#receiptEvidence!);
    } catch (error) {
      await this.abortPrivate().catch(() => undefined);
      this.#finished = true;
      throw error;
    }
  }
  get receiptPublicationAttempted(): boolean { return this.#receiptPublicationAttempted; }
  get receiptPublished(): boolean { return this.#receiptPublished; }
  get outputPublicationAttempted(): boolean { return this.#outputPublicationAttempted; }
  get outputPublicationCompleted(): boolean { return this.#outputPublicationCompleted; }
  async commit(options: { cancelled?: () => boolean } = {}): Promise<PairedPublishedPairIdentity | void> {
    this.assertOpen();
    if (!this.#outputEvidence || !this.#receiptEvidence) throw new Error("Paired receipt must be staged before publication.");
    if (this.cancelled(options)) {
      await this.abortPrivate().catch(() => undefined);
      this.#finished = true;
      throw new PairedOutputReceiptCancelledError("before_receipt");
    }
    try {
      if (this.#durablePublication) {
        await this.outputPublication.syncPrivateFile({ label: "Paired output private stage", maxBytes: this.#durablePublication.outputMaxBytes }); await this.#onDurabilityStep?.("output_private");
        await this.#receiptPublication.syncPrivateFile({ label: "Paired receipt private stage", maxBytes: this.#durablePublication.receiptMaxBytes }); await this.#onDurabilityStep?.("receipt_private");
      }
      await this.#faults.beforeReceiptCommit?.();
      // A side-effectful observer is sampled before internal revalidation; link consumes its latch.
      const receiptLinkCancelled = this.cancelled(options);
      try {
        await this.#receiptPublication.publishFile(this.#receiptEvidence, {
          retainReservation: true,
          reuseVerifiedPrivateEvidence: Boolean(this.#heldDirectoryAuthority),
          onPublicLinkBoundary: async () => {
            if (receiptLinkCancelled) throw new DerivedOutputPublicationPreLinkCancelledError();
            this.#receiptPublicationAttempted = true;
          }
        });
      } catch (error) {
        if (error instanceof DerivedOutputPublicationPreLinkCancelledError) throw new PairedOutputReceiptCancelledError("before_receipt");
        // Compatibility publishers can report post-link uncertainty without invoking the hook.
        if (isPublicationCommitUncertain(error)) this.#receiptPublicationAttempted = true;
        throw error;
      }
      if (this.#durablePublication) { await this.#receiptPublication.syncPublicationParent(); await this.#onDurabilityStep?.("receipt_parent"); }
      this.#receiptPublished = true;
      if (heldOutputDirectoryState(this.#heldDirectoryAuthority)) await this.#receiptPublication.verifyPublishedFileIdentityWithoutHash(this.#receiptEvidence);
      else await this.#receiptPublication.verifyPublishedFile(this.#receiptEvidence);
      await this.#faults.afterReceiptCommitted?.();
      if (this.cancelled(options)) {
        if (!this.#retainCommittedEvidenceOnFailure) await this.revokeReceiptBeforeOutput();
        throw new PairedOutputReceiptCancelledError("after_receipt");
      }
      for (const secondary of this.#secondaryArtifacts) {
        try {
          await secondary.publication.publishFile(secondary.evidence, { retainReservation: true });
        } catch (error) {
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
          this.#secondaryPublicationUncertain = true;
          this.#uncertainSecondaryPaths.push(secondary.publication.outputPath);
          throw error;
        }
      }
      await this.#faults.beforeOutputCommit?.();
      if (this.cancelled(options)) {
        if (!this.#retainCommittedEvidenceOnFailure) await this.revokePublishedEvidenceBeforeOutput();
        throw new PairedOutputReceiptCancelledError("after_receipt");
      }
      const held = heldOutputDirectoryState(this.#heldDirectoryAuthority);
      // The literal link hook receives only this local cancellation latch.
      const outputLinkCancelled = this.cancelled(options);
      if (held) {
        // Rehash media once after the hostile callback and retain fresh bounded receipt bytes.
        const finalOutputEvidence = await this.outputPublication.verifyPrivateFile({
          label: "Paired held output before public link",
          maxBytes: this.#durablePublication?.outputMaxBytes ?? Number.MAX_SAFE_INTEGER
        });
        if (finalOutputEvidence.sha256 !== this.#outputEvidence.sha256 || finalOutputEvidence.byteLength !== this.#outputEvidence.byteLength) {
          throw new Error("Paired held output changed after receipt binding and before its public link.");
        }
        this.#outputEvidence = finalOutputEvidence;
        const finalReceiptEvidence = await this.#receiptPublication.verifyPrivateFile({
          label: "Paired held receipt before media link",
          maxBytes: this.#durablePublication?.receiptMaxBytes ?? Number.MAX_SAFE_INTEGER,
          additionalLinks: 1
        });
        if (finalReceiptEvidence.sha256 !== this.#receiptEvidence.sha256 || finalReceiptEvidence.byteLength !== this.#receiptEvidence.byteLength) {
          throw new Error("Paired held receipt changed after its public binding and before media publication.");
        }
        this.#receiptEvidence = finalReceiptEvidence;
      }
      try {
        await this.outputPublication.publishFile(this.#outputEvidence, {
          retainReservation: Boolean(held),
          reuseVerifiedPrivateEvidence: Boolean(held),
          onPublicLinkBoundary: async () => {
            // In the held V1 lane this is the critical section: descriptor facts bind the exact
            // bounded media and receipt before the pure cancellation latch reaches link(2).
            if (held) {
              await this.outputPublication.assertVerifiedPrivateFileIdentity(this.#outputEvidence!);
              await this.#receiptPublication.assertExclusiveRetainedPublishedFile(this.#receiptEvidence!);
            }
            if (outputLinkCancelled) throw new DerivedOutputPublicationPreLinkCancelledError();
            this.#outputPublicationAttempted = true;
          }
        });
      } catch (error) {
        if (error instanceof DerivedOutputPublicationPreLinkCancelledError) throw new PairedOutputReceiptCancelledError("after_receipt");
        if (isPublicationCommitUncertain(error)) this.#outputPublicationAttempted = true;
        throw error;
      }
      // This is immediately after link() returns. Any following fsync/assert/observer fault is
      // committed-or-uncertain and the receipt stays retained.
      this.#outputPublicationCompleted = true;
      if (this.#durablePublication) { await this.outputPublication.syncPublicationParent(); await this.#onDurabilityStep?.("output_parent"); }
      await this.#faults.afterOutputCommitAttempt?.();
      if (held) {
        this.#publishedPairIdentity = Object.freeze({
          output: await this.outputPublication.captureRetainedPublishedFileIdentityWithoutHash(this.#outputEvidence, { afterCachedVerification: async () => await this.#faults.afterHeldCachedVerification?.("output") }),
          receipt: await this.#receiptPublication.captureRetainedPublishedFileIdentityWithoutHash(this.#receiptEvidence, { afterCachedVerification: async () => await this.#faults.afterHeldCachedVerification?.("receipt") })
        });
        const capture = await captureExactHeldPair(this.outputPath, this.receiptPath, this.#publishedPairIdentity);
        await Promise.allSettled([this.outputPublication.abort(), releaseRetainedPairedPrivateReservations(this.#receiptPublication, this.#secondaryArtifacts)]);
        this.#publishedPairIdentity = await retainReleasedHeldPairCapture(this.#publishedPairIdentity, capture, { output: this.#outputEvidence, receipt: this.#receiptEvidence }, this.#faults.afterHeldAnchorRelease);
      } else {
        await releaseRetainedPairedPrivateReservations(this.#receiptPublication, this.#secondaryArtifacts);
      }
      this.#finished = true;
      return held ? this.#publishedPairIdentity : undefined;
    } catch (error) {
      const outputPublicationKnownAbsent = this.#outputPublicationAttempted
        && !this.#outputPublicationCompleted
        && !isPublicationCommitUncertain(error);
      const retainCommittedEvidence = this.#retainCommittedEvidenceOnFailure && this.#receiptPublicationAttempted;
      if (!retainCommittedEvidence && !this.#outputPublicationCompleted && (outputPublicationKnownAbsent || (!this.#outputPublicationAttempted && !this.#secondaryPublicationUncertain && !isPublicationCommitUncertain(error)))) {
        await this.revokePublishedEvidenceBeforeOutput().catch(() => undefined);
        await Promise.allSettled([
          this.outputPublication.abort(),
          this.#receiptPublication.abort(),
          ...this.#secondaryArtifacts.map(async (secondary) => await secondary.publication.abort())
        ]);
      } else {
        await Promise.allSettled([
          this.outputPublication.abort(),
          this.#receiptPublication.abort(),
          ...this.#secondaryArtifacts.map(async (secondary) => await secondary.publication.abort())
        ]);
      }
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
  private cancelled(options: { cancelled?: () => boolean }): boolean { try { return options.cancelled?.() === true; } catch { return true; } }
  /** Cancel/failure cleanup before a public receipt exists. */
  async abort(): Promise<void> { if (this.#finished) return; try { await this.abortPrivate(); } finally { this.#finished = true; } }
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
  private assertOpen(): void { if (this.#finished) throw new Error("Paired output/receipt publication is already finished."); }
  private async assertHeldCurrent(): Promise<void> { await heldOutputDirectoryState(this.#heldDirectoryAuthority)?.assertCurrent(); }
}
