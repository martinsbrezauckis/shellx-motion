/** B7 arbitrary-time review binding over exact storyboard, recipe, package, frame, and receipt evidence. */
import { createHash } from "node:crypto";
import { canonicalJson } from "@shellx-motion/core";
import { reopenCheckpointStoryboardRetainedTraceMaterializationOutput } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-output-private.js";
import { reopenCheckpointStoryboardRetainedTracePreviewByHandles, assertCheckpointStoryboardRetainedTraceReviewPreviewEvidence } from "./checkpoint-storyboard-retained-trace-preview-review.js";
import { checkpointStoryboardRetainedTraceResolutionOutputHandle, withCheckpointStoryboardRetainedTraceResolutionOutputAuthority } from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { readRetainedTraceBinding, readRetainedTraceResolutionState } from "./checkpoint-storyboard-retained-trace-resolution-journal.js";
import { checkedAuthority, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRetainedTraceReviewView } from "./checkpoint-storyboard-record-store-types.js";
import { resolveCheckpointStoryboardRetainedTraceReviewHandle, withCheckpointStoryboardRetainedTraceReviewAuthority, type CheckpointStoryboardRetainedTraceReviewAuthority } from "./checkpoint-storyboard-retained-trace-review-authority.js";
import {
  createRetainedTraceReviewBinding,
  createRetainedTraceReviewCompletion,
  createRetainedTraceReviewIntent,
  MAX_RETAINED_TRACE_REVIEWS_PER_LINEAGE,
  publishRetainedTraceReviewBinding,
  publishRetainedTraceReviewCompletion,
  publishRetainedTraceReviewIntent,
  readRetainedTraceReviewJournal,
  type RetainedTraceReviewBinding,
} from "./checkpoint-storyboard-retained-trace-review-journal.js";

type FaultPoint = "after-intent" | "after-binding" | "after-completion";
type FaultHooks = Partial<Record<FaultPoint, () => void | Promise<void>>>;
const hooks = new WeakMap<CheckpointStoryboardRetainedTraceReviewAuthority, FaultHooks>();

export type CheckpointStoryboardRetainedTraceReviewInput = Readonly<{ preview: Readonly<{ previewHandle: string; receiptHandle: string }>; reviewHandle: string }>;
export type CheckpointStoryboardRetainedTraceReviewResult = Readonly<{ review: CheckpointStoryboardRetainedTraceReviewView; replayed: boolean }>;

/** Test-only interruption seam; no command metadata exposes it. */
export function setCheckpointStoryboardRetainedTraceReviewFaultHooksForTest(authority: CheckpointStoryboardRetainedTraceReviewAuthority, value: FaultHooks | undefined): void { if (value) hooks.set(authority, Object.freeze({ ...value })); else hooks.delete(authority); }

export async function bindCheckpointStoryboardRetainedTraceReview(authority: CheckpointStoryboardRetainedTraceReviewAuthority, identity: CheckpointStoryboardRecordIdentity, input: CheckpointStoryboardRetainedTraceReviewInput): Promise<CheckpointStoryboardRetainedTraceReviewResult> {
  return await withCheckpointStoryboardRetainedTraceReviewAuthority(authority, async (configured) => {
    const store = checkedAuthority(configured.store), root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity);
      if (record.admission.profile !== "c6b7-retained-trace@1") throw storeError("materialization_profile_refused", "Checkpoint storyboard retained-trace review accepts only the sealed B7 profile.");
      if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard retained-trace review requires a nonarchived lineage.");
      if (record.target.state !== "active") throw storeError("record_tombstoned", "Checkpoint storyboard retained-trace review requires an active record.");
      const journal = await readRetainedTraceReviewJournal(store, root);
      const preview = await reopenCheckpointStoryboardRetainedTracePreviewByHandles(store, root, input.preview.previewHandle, input.preview.receiptHandle);
      if (!sameIdentity(preview.state.identity, identity) || !preview.state.receipt || !preview.state.png) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review preview does not bind this exact record and complete evidence pair.");
      const hostReview = resolveCheckpointStoryboardRetainedTraceReviewHandle(configured, input.reviewHandle);
      if (!sameIdentity(hostReview.record.identity, identity) || !sameIdentity(hostReview.record.root, root) || hostReview.preview.previewHandle !== input.preview.previewHandle || hostReview.preview.receiptHandle !== input.preview.receiptHandle) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review handle is not bound to this exact record, root, and preview pair.");
      const state = await readRetainedTraceResolutionState(store, identity, root, { requireHead: true });
      const resolution = await readRetainedTraceBinding(store, identity);
      if (!resolution || (state.state !== "bound" && state.state !== "detached") || state.bindingId !== resolution.id || !sameIdentity(resolution.identity, identity) || !sameIdentity(resolution.root, root) || preview.state.binding.id !== resolution.id || preview.state.binding.sha256 !== resolution.sha256) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review cannot reopen the exact B7 resolution bound to its preview.");
      const existingForFrame = journal.bindings.find((binding) => binding.frame.stateId === preview.state.id);
      const pendingForFrame = journal.pending?.intent.stateId === preview.state.id;
      if (state.state === "detached" && !existingForFrame && !pendingForFrame) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review cannot create a new association after B7 detachment.");
      await verifyInstalledOutput(configured.resolution, identity, resolution);
      const recipe = record.storyboard.recipes[0];
      if (record.storyboard.recipes.length !== 1 || !recipe || resolution.plan.storyboardId !== record.storyboard.id || resolution.plan.storyboardSha256 !== record.storyboard.sha256 || resolution.plan.storyboardRevision !== record.storyboard.revision) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review cannot derive one exact storyboard and recipe identity.");
      const candidate = createRetainedTraceReviewBinding({
        identity, root,
        storyboard: Object.freeze({ id: record.storyboard.id, sha256: record.storyboard.sha256, revision: record.storyboard.revision }),
        recipe: Object.freeze({ id: recipe.id, sha256: recipe.sha256, revision: recipe.revision, recipeId: recipe.recipeId }),
        resolution: Object.freeze({ bindingId: resolution.id, bindingSha256: resolution.sha256, outputHandle: resolution.outputHandle, receiptFingerprint: resolution.receiptFingerprint, planFingerprint: resolution.plan.planFingerprint, profileFingerprint: resolution.plan.profileFingerprint, tracePlanFingerprint: resolution.plan.tracePlanFingerprint, scheduleSha256: resolution.plan.scheduleSha256 }),
        materialization: Object.freeze({ package: resolution.output.reopened.package, sidecar: Object.freeze({ path: "analysis/checkpoint-storyboard/parametric-trace.plan.json" as const, rawSha256: resolution.sidecar.rawSha256, canonicalSha256: resolution.sidecar.canonicalSha256, byteLength: resolution.sidecar.byteLength }) }),
        frame: Object.freeze({ stateId: preview.state.id, atUs: preview.state.atUs, receipt: preview.state.receipt, png: preview.state.png, runtimeEvidence: preview.state.runtimeEvidence, previewHandleDigest: hash(input.preview) }),
        review: Object.freeze({ decision: hostReview.decision, reviewer: hostReview.reviewer, authenticationDigest: hostReview.authenticationDigest, handleDigest: hostReview.handleDigest }),
      });
      if (existingForFrame && !journal.pending) {
        if (canonicalJson(existingForFrame) !== canonicalJson(candidate)) throw storeError("retained_trace_review_binding_conflict", "Checkpoint storyboard retained-trace preview already has a different immutable review association.");
        return Object.freeze({ review: publicView(existingForFrame), replayed: true });
      }
      const recovering = !!journal.pending;
      let intent = journal.pending?.intent;
      if (journal.pending) {
        if (journal.pending.intent.stateId !== candidate.frame.stateId || journal.pending.intent.binding.id !== candidate.id || journal.pending.intent.binding.sha256 !== candidate.sha256 || (journal.pending.binding && canonicalJson(journal.pending.binding) !== canonicalJson(candidate))) throw storeError("retained_trace_review_binding_conflict", "Checkpoint storyboard retained-trace review publication is reserved for a different exact association.");
      } else {
        if (journal.bindings.length >= MAX_RETAINED_TRACE_REVIEWS_PER_LINEAGE) throw storeError("lineage_limit_exceeded", "Checkpoint storyboard retained-trace review lineage reached its bounded association limit.");
        intent = createRetainedTraceReviewIntent(root, candidate);
        await publishRetainedTraceReviewIntent(store, root, intent); await fault(authority, "after-intent");
      }
      if (!intent) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review intent was not retained.");
      if (!journal.pending?.binding) { await publishRetainedTraceReviewBinding(store, root, candidate); await fault(authority, "after-binding"); }
      await publishRetainedTraceReviewCompletion(store, root, createRetainedTraceReviewCompletion(intent, candidate)); await fault(authority, "after-completion");
      const reopened = await readRetainedTraceReviewJournal(store, root), completed = reopened.bindings.find((binding) => binding.frame.stateId === candidate.frame.stateId);
      if (reopened.pending || !completed || canonicalJson(completed) !== canonicalJson(candidate)) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review association did not reopen exactly after publication.");
      return Object.freeze({ review: publicView(completed), replayed: recovering });
    });
  });
}

export async function assertLineageRetainedTraceReviewJournalIsComplete(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<readonly RetainedTraceReviewBinding[]> {
  const journal = await readRetainedTraceReviewJournal(facts, root);
  if (journal.pending) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review journal has an unresolved exact publication.");
  for (const binding of journal.bindings) {
    const record = await readStoredRecordUnlocked(facts, binding.identity), recipe = record.storyboard.recipes[0], resolution = await readRetainedTraceBinding(facts, binding.identity);
    if (record.admission.profile !== "c6b7-retained-trace@1" || !sameIdentity(record.lineage.root, root) || !recipe || record.storyboard.recipes.length !== 1 || record.storyboard.id !== binding.storyboard.id || record.storyboard.sha256 !== binding.storyboard.sha256 || record.storyboard.revision !== binding.storyboard.revision || recipe.id !== binding.recipe.id || recipe.sha256 !== binding.recipe.sha256 || recipe.revision !== binding.recipe.revision || recipe.recipeId !== binding.recipe.recipeId || !resolution || !sameResolution(binding, resolution)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review cannot reopen its exact storyboard, recipe, and B7 materialization binding.");
    await assertCheckpointStoryboardRetainedTraceReviewPreviewEvidence(facts, root, { stateId: binding.frame.stateId, identity: binding.identity, binding: { id: binding.resolution.bindingId, sha256: binding.resolution.bindingSha256 }, atUs: binding.frame.atUs, runtimeEvidence: binding.frame.runtimeEvidence, previewHandleDigest: binding.frame.previewHandleDigest, receipt: binding.frame.receipt, png: binding.frame.png });
  }
  return journal.bindings;
}

function sameResolution(review: RetainedTraceReviewBinding, resolution: NonNullable<Awaited<ReturnType<typeof readRetainedTraceBinding>>>): boolean { return review.resolution.bindingId === resolution.id && review.resolution.bindingSha256 === resolution.sha256 && review.resolution.outputHandle === resolution.outputHandle && review.resolution.receiptFingerprint === resolution.receiptFingerprint && review.resolution.planFingerprint === resolution.plan.planFingerprint && review.resolution.profileFingerprint === resolution.plan.profileFingerprint && review.resolution.tracePlanFingerprint === resolution.plan.tracePlanFingerprint && review.resolution.scheduleSha256 === resolution.plan.scheduleSha256 && canonicalJson(review.materialization.package) === canonicalJson(resolution.output.reopened.package) && canonicalJson(review.materialization.sidecar) === canonicalJson(resolution.sidecar); }
async function verifyInstalledOutput(authority: Parameters<typeof checkpointStoryboardRetainedTraceResolutionOutputHandle>[0], identity: CheckpointStoryboardRecordIdentity, resolution: NonNullable<Awaited<ReturnType<typeof readRetainedTraceBinding>>>): Promise<void> { try { await withCheckpointStoryboardRetainedTraceResolutionOutputAuthority(authority, async (host) => { const output = await reopenCheckpointStoryboardRetainedTraceMaterializationOutput(host); if (checkpointStoryboardRetainedTraceResolutionOutputHandle(authority, identity) !== resolution.outputHandle || canonicalJson(output) !== canonicalJson(resolution.output.expected) || canonicalJson(output) !== canonicalJson(resolution.output.reopened)) throw new Error("materialized identity changed"); }); } catch (error) { if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error; throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review cannot reopen its exact materialized package."); } }
function publicView(binding: RetainedTraceReviewBinding): CheckpointStoryboardRetainedTraceReviewView { return Object.freeze({ associationId: binding.id, outcome: binding.review.decision.outcome, scope: Object.freeze({ atUs: binding.frame.atUs }), preview: Object.freeze({ width: binding.frame.png.width, height: binding.frame.png.height, runtimeEvidence: binding.frame.runtimeEvidence }), evidence: Object.freeze({ evidenceClass: binding.frame.runtimeEvidence === "host-gpu" ? "host-gpu-review-association" as const : "source-test-review-association" as const, storyboardSha256: binding.storyboard.sha256, recipeSha256: binding.recipe.sha256, packageInventorySha256: binding.materialization.package.inventory.sha256, previewReceiptSha256: binding.frame.receipt.sha256, pngSha256: binding.frame.png.sha256, hostGpu: false as const, humanReview: false as const, pixels: false as const, quality: false as const, finalMedia: false as const }) }); }
async function fault(authority: CheckpointStoryboardRetainedTraceReviewAuthority, point: FaultPoint): Promise<void> { await hooks.get(authority)?.[point]?.(); }
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
