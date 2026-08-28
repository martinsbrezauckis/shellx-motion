/** C6C B1e private fixed-PNG quality receipt. It associates evidence; it never accepts final media. */
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, inspectPngBuffer } from "@shellx-motion/core";
import { checkedCheckpointStoryboardCreativeReviewAuthority, resolveCheckpointStoryboardCreativeReviewHandle } from "./checkpoint-storyboard-creative-review-authority.js";
import { assertLineageCreativeReviewJournalIsComplete } from "./checkpoint-storyboard-creative-review.js";
import { verifyCheckpointStoryboardStoredBindingUnlocked } from "./checkpoint-storyboard-materialization.js";
import { withCheckpointStoryboardMaterializationOutputAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { readMaterializationBinding, readMaterializationBindingState } from "./checkpoint-storyboard-materialization-bindings.js";
import { resolveCheckpointStoryboardEndpointWitnessHandle, withCheckpointStoryboardQualityReviewAuthority, type CheckpointStoryboardQualityReviewAuthority, type QualityReviewAuthorityFacts } from "./checkpoint-storyboard-quality-review-authority.js";
import { createQualityReviewIntent, readQualityReviewJournal } from "./checkpoint-storyboard-quality-review-journal.js";
import { reopenCheckpointStoryboardQualityPreviewByHandles, type ReopenedQualityPreview } from "./checkpoint-storyboard-quality-review-preview.js";
import { QUALITY_PROFILE, QUALITY_PROFILE_SHA256, type CheckpointStoryboardQualityReviewInput, type StoredQualityReview } from "./checkpoint-storyboard-quality-review-types.js";
import type { StoredBinding } from "./checkpoint-storyboard-creative-review-types.js";
import { checkedAuthority, lineageQualityReviewsDirectory, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { CheckpointStoryboardRecordStoreError, sameIdentity, storeError, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

type QualityFaultHooks = Readonly<{ afterIntent?: () => void | Promise<void> }>;
const qualityFaultHooks = new WeakMap<CheckpointStoryboardQualityReviewAuthority, QualityFaultHooks>();

/** Test-only interruption seam. A retained intent must recover only under the same exact candidate. */
export function setCheckpointStoryboardQualityReviewFaultHooksForTest(authority: CheckpointStoryboardQualityReviewAuthority, hooks: QualityFaultHooks | undefined): void {
  if (hooks) qualityFaultHooks.set(authority, hooks); else qualityFaultHooks.delete(authority);
}
export type CheckpointStoryboardQualityReviewResult = Readonly<{ qualityReceiptHandle: string; verdict: "passed" | "failed"; replayed: boolean; finalAcceptance: "unavailable" }>;

export async function reviewCheckpointStoryboardPreviewQuality(authority: CheckpointStoryboardQualityReviewAuthority, identity: CheckpointStoryboardRecordIdentity, input: CheckpointStoryboardQualityReviewInput): Promise<CheckpointStoryboardQualityReviewResult> {
  return await withCheckpointStoryboardQualityReviewAuthority(authority, async (configured) => {
    const store = checkedAuthority(configured.store), root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity);
      if (record.admission.profile !== undefined) throw storeError("materialization_profile_refused", "C6C B1e quality review refuses sealed non-B1 records before journal or output work.");
      if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard quality review can associate only a nonarchived record.");
      if (record.target.state !== "active") throw storeError("record_tombstoned", "Checkpoint storyboard quality review can associate only an active record.");
      const state = await readMaterializationBindingState(store, identity, root);
      if (state.state !== "bound" || state.active !== 1 || !state.bindingId) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review requires one active B1a binding.");
      const materialization = await readMaterializationBinding(store, identity);
      if (!materialization || materialization.id !== state.bindingId || !sameIdentity(materialization.root, root)) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review cannot reopen its exact active B1a binding.");
      try { await withCheckpointStoryboardMaterializationOutputAuthority(configured.materialization, async (current) => await verifyCheckpointStoryboardStoredBindingUnlocked({ sourcePackageRoot: current.sourcePackageRoot, outputPackageRoot: current.outputPackageRoot, packageWorkspaceRoot: current.packageWorkspaceRoot, packageWorkspaceAuthority: current.packageWorkspaceAuthority }, materialization)); }
      catch (error) { if (error instanceof CheckpointStoryboardRecordStoreError) throw error; throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review could not verify the exact active B1a/C6B output."); }
      const preview = await reopenCheckpointStoryboardQualityPreviewByHandles(store, root, input.preview.previewHandle, input.preview.receiptHandle);
      if (!sameIdentity(preview.state.identity, identity) || preview.state.binding.id !== materialization.id || preview.state.binding.sha256 !== materialization.sha256 || preview.snapshotSha256 !== materialization.output.reopened.nonReceiptInventory.sha256) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review preview does not bind the exact active B1a/C6B output inventory.");
      const b1cJournal = await assertLineageCreativeReviewJournalIsComplete(store, root);
      const b1c = b1cJournal.bindings.find((binding) => sameIdentity(binding.identity, identity));
      if (!b1c || b1c.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review@2" || !b1c.preview.samplingSha256 || !sameIdentity(b1c.root, root) || b1c.b1a.bindingId !== materialization.id || b1c.b1a.bindingSha256 !== materialization.sha256 || b1c.b1a.c6bReceiptFingerprint !== materialization.c6b1bReceiptFingerprint) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review requires one durable B1c v2 association for the exact B1a binding.");
      const review = input.review.kind === "interior"
        ? interiorAssociation(configured, identity, root, input, preview, b1c)
        : terminalAssociation(configured, identity, root, input, preview, b1c);
      const inspected = inspectPngBuffer(preview.png);
      const failure = !inspected.ok ? "invalid_png" as const : inspected.width !== preview.state.png?.width || inspected.height !== preview.state.png?.height ? "png_dimension_mismatch" as const : undefined;
      const candidate = createReceipt(identity, root, materialization, preview, b1c, review, failure);
      let journal = await readQualityReviewJournal(store, root);
      const existing = journal.receipts.find((receipt) => sameIdentity(receipt.identity, identity));
      let replayed = false;
      if (existing && !journal.pending) {
        if (canonicalJson(existing) !== canonicalJson(candidate)) throw storeError("quality_review_binding_conflict", "Checkpoint storyboard quality review already has a different immutable receipt association.");
        replayed = true;
      } else {
        if (journal.pending) {
          if (!sameIdentity(journal.pending.intent.identity, identity) || journal.pending.intent.receipt.id !== candidate.id || journal.pending.intent.receipt.sha256 !== candidate.sha256) throw storeError("quality_review_binding_conflict", "Checkpoint storyboard quality-review publication is reserved for a different immutable association.");
          replayed = true;
        } else {
          if (journal.receipts.length >= 128) throw storeError("lineage_limit_exceeded", "Checkpoint storyboard quality-review lineage reached its bounded receipt limit.");
          const directory = await lineageQualityReviewsDirectory(store, root.id);
          await writeExclusiveSignedFile(join(directory.path, `${identity.id}.quality-review.intent.json`), createQualityReviewIntent(root, candidate), store, 24 * 1024);
          await qualityFaultHooks.get(authority)?.afterIntent?.();
          journal = await readQualityReviewJournal(store, root);
        }
        const directory = await lineageQualityReviewsDirectory(store, root.id);
        await writeExclusiveSignedFile(join(directory.path, `${identity.id}.quality-review.json`), candidate, store, 24 * 1024);
        const reopened = await readQualityReviewJournal(store, root).then((value) => value.receipts.find((receipt) => sameIdentity(receipt.identity, identity)));
        if (!reopened || canonicalJson(reopened) !== canonicalJson(candidate)) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality-review receipt did not reopen exactly after private publication.");
      }
      return Object.freeze({ qualityReceiptHandle: qualityReceiptHandle(store.integrityKey, store.storeBinding, candidate), verdict: candidate.verdict, replayed, finalAcceptance: "unavailable" as const });
    });
  });
}

function interiorAssociation(configured: QualityReviewAuthorityFacts, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, input: CheckpointStoryboardQualityReviewInput, preview: ReopenedQualityPreview, b1c: StoredBinding): StoredQualityReview["review"] {
  if (input.review.kind !== "interior" || preview.state.sampling.mode !== "interior") throw storeError("quality_review_evidence_refused", "Checkpoint storyboard interior quality review requires exact B1b interior sampling.");
  const creative = resolveCheckpointStoryboardCreativeReviewHandle(checkedCheckpointStoryboardCreativeReviewAuthority(configured.creativeReview), input.review.creativeReviewHandle);
  if (!sameIdentity(creative.record.identity, identity) || !sameIdentity(creative.record.root, root) || creative.preview.previewHandle !== input.preview.previewHandle || creative.preview.receiptHandle !== input.preview.receiptHandle || b1c.host.handleDigest !== creative.authentication.handleDigest || !sameB1cPreview(b1c, preview)) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard interior quality review cannot reopen the exact durable B1c association.");
  return Object.freeze({ kind: "interior", creativeHandleDigest: creative.authentication.handleDigest });
}
function terminalAssociation(configured: QualityReviewAuthorityFacts, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, input: CheckpointStoryboardQualityReviewInput, preview: ReopenedQualityPreview, b1c: StoredBinding): StoredQualityReview["review"] {
  if (input.review.kind !== "terminal-endpoint" || preview.state.sampling.mode !== "terminal-boundary" || !preview.terminalBoundarySha256) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard terminal quality review requires exact B1b terminal-boundary sampling and evidence.");
  const witness = resolveCheckpointStoryboardEndpointWitnessHandle(configured, input.review.endpointWitnessHandle);
  const durationUs = preview.state.sampling.documentDurationMs * 1_000;
  const selectedEndUs = witness.creative.creative.selectedShot.startUs + witness.creative.creative.selectedShot.durationUs;
  if (!Number.isSafeInteger(durationUs) || !Number.isSafeInteger(selectedEndUs) || !sameIdentity(witness.record.identity, identity) || !sameIdentity(witness.record.root, root) || witness.terminalPreview.previewHandle !== input.preview.previewHandle || witness.terminalPreview.receiptHandle !== input.preview.receiptHandle || witness.endpoint.atUs !== durationUs || preview.state.target.resolvedAtMs !== preview.state.sampling.documentDurationMs || selectedEndUs !== witness.endpoint.atUs || b1c.host.handleDigest !== witness.creative.authentication.handleDigest) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard terminal quality review witness is not adjacent to the exact durable end-exclusive B1c association.");
  return Object.freeze({ kind: "terminal-endpoint", endpointWitnessDigest: witness.handleDigest, endpointAtUs: witness.endpoint.atUs, selectedShotEndUs: selectedEndUs, relation: "adjacent-end-exclusive", claims: Object.freeze({ visibleFinalState: false, heldLayerContent: false, humanPixelReview: false, finalMedia: false }) });
}
function sameB1cPreview(b1c: StoredBinding, preview: ReopenedQualityPreview): boolean {
  return b1c.preview.targetSha256 === createHash("sha256").update(canonicalJson(preview.state.target)).digest("hex") && b1c.preview.receiptSha256 === preview.state.receipt?.sha256 && b1c.preview.pngSha256 === preview.state.png?.sha256 && b1c.preview.snapshotSha256 === preview.snapshotSha256 && b1c.preview.samplingSha256 === preview.samplingSha256 && b1c.preview.width === preview.state.png?.width && b1c.preview.height === preview.state.png?.height && b1c.preview.runtimeEvidence === preview.state.runtimeEvidence;
}
function createReceipt(identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, materialization: NonNullable<Awaited<ReturnType<typeof readMaterializationBinding>>>, preview: ReopenedQualityPreview, b1c: StoredBinding, review: StoredQualityReview["review"], failure: StoredQualityReview["failure"]): StoredQualityReview {
  if (!preview.state.receipt || !preview.state.png) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review could not retain exact B1b receipt and PNG evidence.");
  const payload = {
    schema: "shellx-motion/private-checkpoint-storyboard-preview-quality-review@1" as const,
    identity, root,
    b1a: Object.freeze({ bindingId: materialization.id, bindingSha256: materialization.sha256, c6bReceiptFingerprint: materialization.c6b1bReceiptFingerprint }),
    preview: Object.freeze({ targetSha256: createHash("sha256").update(canonicalJson(preview.state.target)).digest("hex"), receiptSha256: preview.state.receipt.sha256, pngSha256: preview.state.png.sha256, snapshotSha256: preview.snapshotSha256, width: preview.state.png.width, height: preview.state.png.height, runtimeEvidence: preview.state.runtimeEvidence, sampling: Object.freeze({ ...preview.state.sampling }), ...(preview.terminalBoundarySha256 ? { terminalBoundarySha256: preview.terminalBoundarySha256 } : {}) }),
    b1c: Object.freeze({ bindingId: b1c.id, bindingSha256: b1c.sha256, hostHandleDigest: b1c.host.handleDigest, samplingSha256: b1c.preview.samplingSha256! }),
    review,
    profile: Object.freeze({ id: QUALITY_PROFILE, sha256: QUALITY_PROFILE_SHA256, checks: Object.freeze(["authenticated-png-pair", "decoded-png", "dimensions"] as const) }),
    verdict: failure ? "failed" as const : "passed" as const,
    ...(failure ? { failure } : {}),
    finalAcceptance: "unavailable" as const,
  };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return Object.freeze({ ...payload, id: `checkpoint_storyboard_preview_quality_review_${sha256.slice(0, 32)}`, sha256 });
}
function qualityReceiptHandle(key: Uint8Array, storeBinding: string, receipt: StoredQualityReview): string {
  return `checkpoint_storyboard_preview_quality_receipt_${createHmac("sha256", key).update("checkpoint-storyboard-preview-quality-review@1\0").update(storeBinding).update("\0").update(canonicalJson({ id: receipt.id, sha256: receipt.sha256 })).digest("hex").slice(0, 32)}`;
}
