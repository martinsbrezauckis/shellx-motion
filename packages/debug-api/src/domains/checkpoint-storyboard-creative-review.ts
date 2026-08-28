/** C6C B1c facade: bind, inspect, and lifecycle audit one private root-scoped review journal. */
import { canonicalJson } from "@shellx-motion/core";
import { join } from "node:path";
import {
  resolveCheckpointStoryboardCreativeReviewHandle,
  withCheckpointStoryboardCreativeReviewAuthority,
  type CheckpointStoryboardCreativeReviewAuthority,
} from "./checkpoint-storyboard-creative-review-authority.js";
import { createBinding, publicView } from "./checkpoint-storyboard-creative-review-binding.js";
import { readCreativeReviewJournal } from "./checkpoint-storyboard-creative-review-journal.js";
import { createIntent } from "./checkpoint-storyboard-creative-review-journal-records.js";
import { advanceCreativeReviewPublication, type CreativeReviewFaultPoint } from "./checkpoint-storyboard-creative-review-publication.js";
import { MAX_BINDING_BYTES, MAX_BINDINGS_PER_LINEAGE, type CreativeReviewJournal } from "./checkpoint-storyboard-creative-review-types.js";
import { verifyCheckpointStoryboardStoredBindingUnlocked } from "./checkpoint-storyboard-materialization.js";
import { withCheckpointStoryboardMaterializationOutputAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { readMaterializationBinding, readMaterializationBindingState } from "./checkpoint-storyboard-materialization-bindings.js";
import { assertCheckpointStoryboardCreativeReviewPreviewEvidence, reopenCheckpointStoryboardCompletePreviewByHandles } from "./checkpoint-storyboard-preview-creative-review.js";
import { checkedAuthority, lineageCreativeReviewsDirectory, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { CheckpointStoryboardRecordStoreError, sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardCreativeReviewView, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

type CreativeReviewFaultHooks = Partial<Record<CreativeReviewFaultPoint, () => void | Promise<void>>>;
const creativeReviewFaultHooks = new WeakMap<CheckpointStoryboardCreativeReviewAuthority, CreativeReviewFaultHooks>();

/** Test-only durable-publication interruption seam; production callers have no fault surface. */
export function setCheckpointStoryboardCreativeReviewFaultHooksForTest(authority: CheckpointStoryboardCreativeReviewAuthority, hooks: CreativeReviewFaultHooks | undefined): void {
  if (hooks) creativeReviewFaultHooks.set(authority, hooks);
  else creativeReviewFaultHooks.delete(authority);
}

export type CheckpointStoryboardCreativeReviewInput = Readonly<{
  preview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  creativeReviewHandle: string;
}>;

export async function bindCheckpointStoryboardCreativeReview(authority: CheckpointStoryboardCreativeReviewAuthority, identity: CheckpointStoryboardRecordIdentity, input: CheckpointStoryboardCreativeReviewInput): Promise<Readonly<{ binding: CheckpointStoryboardCreativeReviewView; replayed: boolean }>> {
  return await withCheckpointStoryboardCreativeReviewAuthority(authority, async (configured) => {
    const store = checkedAuthority(configured.store);
    const root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity);
      if (record.admission.profile !== undefined) throw storeError("materialization_profile_refused", "C6C B1c review refuses sealed non-B1 records before journal or output work.");
      if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard creative review can bind only a nonarchived record.");
      if (record.target.state !== "active") throw storeError("record_tombstoned", "Checkpoint storyboard creative review can bind only an active record.");
      let journal = await readCreativeReviewJournal(store, root);
      const materializationState = await readMaterializationBindingState(store, identity, root);
      const activeBinding = materializationState.state === "bound" && materializationState.active === 1;
      const detachedExactReplay = materializationState.state === "detached" && ((journal.pending && sameIdentity(journal.pending.intent.identity, identity)) || journal.bindings.some((binding) => sameIdentity(binding.identity, identity)));
      if ((!activeBinding && !detachedExactReplay) || !materializationState.bindingId) throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review requires one active B1a binding, except for one exact retained B1c replay after detach.");
      const materializationBinding = await readMaterializationBinding(store, identity);
      if (!materializationBinding || materializationBinding.id !== materializationState.bindingId || !sameIdentity(materializationBinding.root, root)) throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review cannot reopen its exact retained B1a binding.");
      try {
        await withCheckpointStoryboardMaterializationOutputAuthority(configured.materialization, async (current) => {
          await verifyCheckpointStoryboardStoredBindingUnlocked({ sourcePackageRoot: current.sourcePackageRoot, outputPackageRoot: current.outputPackageRoot, packageWorkspaceRoot: current.packageWorkspaceRoot, packageWorkspaceAuthority: current.packageWorkspaceAuthority }, materializationBinding);
        });
      } catch (error) {
        if (error instanceof CheckpointStoryboardRecordStoreError) throw error;
        throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review could not verify the exact active B1a/C6B output.");
      }
      const preview = await reopenCheckpointStoryboardCompletePreviewByHandles(store, root, input.preview.previewHandle, input.preview.receiptHandle);
      if (!sameIdentity(preview.state.identity, identity) || preview.state.binding.id !== materializationBinding.id || preview.state.binding.sha256 !== materializationBinding.sha256 || preview.snapshotSha256 !== materializationBinding.output.reopened.nonReceiptInventory.sha256) throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review preview does not bind the exact active B1a/C6B output inventory.");
      const hostReview = resolveCheckpointStoryboardCreativeReviewHandle(configured, input.creativeReviewHandle);
      if (!sameIdentity(hostReview.record.identity, identity) || !sameIdentity(hostReview.record.root, root) || hostReview.preview.previewHandle !== input.preview.previewHandle || hostReview.preview.receiptHandle !== input.preview.receiptHandle) throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative-review host handle is not bound to this exact C6 record/root and B1b handle pair.");
      const candidate = createBinding(identity, root, materializationBinding, preview, hostReview);
      const existing = journal.bindings.find((binding) => sameIdentity(binding.identity, identity));
      if (existing && !journal.pending) {
        if (canonicalJson(existing) !== canonicalJson(candidate)) throw storeError("creative_review_binding_conflict", "Checkpoint storyboard creative review already has a different immutable binding.");
        return Object.freeze({ binding: publicView(existing), replayed: true });
      }
      const recovering = !!journal.pending;
      if (journal.pending) {
        if (!sameIdentity(journal.pending.intent.identity, identity) || journal.pending.intent.binding.id !== candidate.id || journal.pending.intent.binding.sha256 !== candidate.sha256) throw storeError("creative_review_binding_conflict", "Checkpoint storyboard creative-review publication is reserved for a different immutable association.");
      } else {
        if (journal.members.length >= MAX_BINDINGS_PER_LINEAGE) throw storeError("lineage_limit_exceeded", "Checkpoint storyboard creative-review lineage reached its bounded association limit.");
        const directory = await lineageCreativeReviewsDirectory(store, root.id);
        await writeExclusiveSignedFile(join(directory.path, `${identity.id}.creative-review.intent.json`), createIntent(root, candidate), store, MAX_BINDING_BYTES);
        await creativeReviewFault(authority, "after-intent");
        journal = await readCreativeReviewJournal(store, root);
      }
      const reopened = await advanceCreativeReviewPublication(store, root, candidate, journal, async (point) => await creativeReviewFault(authority, point));
      if (!reopened || canonicalJson(reopened) !== canonicalJson(candidate)) throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative-review binding did not reopen exactly after publication.");
      return Object.freeze({ binding: publicView(reopened), replayed: recovering });
    });
  });
}

/** Historical projection only. It does not promote detached, tombstoned, or archived evidence. */
export async function inspectCheckpointStoryboardCreativeReview(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardCreativeReviewView | undefined> {
  const journal = await assertLineageCreativeReviewJournalIsComplete(facts, root);
  const binding = journal.bindings.find((candidate) => sameIdentity(candidate.identity, identity));
  return binding ? publicView(binding) : undefined;
}

/** Used before destructive lifecycle transitions. It neither creates a journal nor repairs it. */
export async function assertLineageCreativeReviewJournalIsComplete(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<CreativeReviewJournal> {
  const journal = await readCreativeReviewJournal(facts, root);
  if (journal.pending) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review roster has an unresolved exact publication and cannot be inspected or destructively transitioned.");
  for (const binding of journal.bindings) {
    let record;
    try { record = await readStoredRecordUnlocked(facts, binding.identity); }
    catch { throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review roster cannot reopen its exact immutable record."); }
    if (!sameIdentity(record.lineage.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review association escaped its root lineage.");
    const materialization = await readMaterializationBinding(facts, binding.identity);
    if (!materialization || !sameIdentity(materialization.root, root) || materialization.id !== binding.b1a.bindingId || materialization.sha256 !== binding.b1a.bindingSha256 || materialization.c6b1bReceiptFingerprint !== binding.b1a.c6bReceiptFingerprint) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review association cannot reopen its exact B1a binding.");
    await assertCheckpointStoryboardCreativeReviewPreviewEvidence(facts, root, { identity: binding.identity, binding: Object.freeze({ id: binding.b1a.bindingId, sha256: binding.b1a.bindingSha256 }), targetSha256: binding.preview.targetSha256, receiptSha256: binding.preview.receiptSha256, pngSha256: binding.preview.pngSha256, snapshotSha256: binding.preview.snapshotSha256, bindingSchema: binding.schema, ...(binding.preview.samplingSha256 ? { samplingSha256: binding.preview.samplingSha256 } : {}), width: binding.preview.width, height: binding.preview.height, runtimeEvidence: binding.preview.runtimeEvidence });
  }
  return journal;
}

async function creativeReviewFault(authority: CheckpointStoryboardCreativeReviewAuthority, point: CreativeReviewFaultPoint): Promise<void> {
  await creativeReviewFaultHooks.get(authority)?.[point]?.();
}
