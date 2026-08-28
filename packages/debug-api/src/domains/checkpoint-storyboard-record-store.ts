/** Public private-Debug facade for immutable C6C record lifecycle operations. */
import { opendir } from "node:fs/promises";
import { canonicalJson } from "@shellx-motion/core";
import { admitCheckpointStoryboardC6CRecordProfile, type CheckpointStoryboard } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { assertAuthorityLive, checkedAuthority, configureCheckpointStoryboardRecordStore, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { activeTarget, ensureLineage, hasTombstone, identityFor, prepareOperationEvidence, publishFinalArchive, publishFinalTarget, publishFinalTombstone, publishRecord, readImmutableRecordFromPrivateNameUnlocked, readImmutableRecordLineage, readImmutableRecordRoot, readOptionalRecordFile, readOptionalTargetFile, readStoredRecordFromPrivateNameUnlocked, readStoredRecordUnlocked, storedFile } from "./checkpoint-storyboard-record-store-state.js";
import { CheckpointStoryboardRecordStoreError, MAX_LINEAGE_ANCESTRY_DEPTH, sameIdentity, storeError, type ArchiveFile, type CheckpointStoryboardCreativeReviewView, type CheckpointStoryboardMaterializationBindingState, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordOperationEvidence, type CheckpointStoryboardRecordStoreAuthority, type CheckpointStoryboardStoredRecord, type StoredRecordFile, type TombstoneFile } from "./checkpoint-storyboard-record-store-types.js";
import { assertLineageMembershipExists, assertNoLegacyMaterializationEvidence, initializeMaterializationStateHead, preflightLineageMemberCapacity, publishLineageMember, readLineageMembers, readMaterializationBindingState, readMaterializationStateHead } from "./checkpoint-storyboard-materialization-bindings.js";
import { assertLineageHasNoUnsettledCheckpointStoryboardPreviews } from "./checkpoint-storyboard-preview-state.js";
import { assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews } from "./checkpoint-storyboard-retained-trace-preview-state.js";
import { assertLineageRetainedTraceReviewJournalIsComplete } from "./checkpoint-storyboard-retained-trace-review.js";
import { assertLineageCreativeReviewJournalIsComplete, inspectCheckpointStoryboardCreativeReview } from "./checkpoint-storyboard-creative-review.js";
import { assertLineageQualityReviewJournalIsComplete } from "./checkpoint-storyboard-quality-review-journal.js";
import { assertBehaviorResolutionJournalCompleteForLineage, assertLineageHasNoPreparingOrBoundBehaviorResolutions, assertNoBehaviorResolutionEvidence, initializeBehaviorStateHead, readBehaviorResolutionState } from "./checkpoint-storyboard-behavior-resolution-journal.js";
import { assertLineageHasNoPreparingOrBoundRelationResolutions, assertNoRelationResolutionEvidence, assertRelationResolutionJournalCompleteForLineage, initializeRelationStateHead, readRelationResolutionState } from "./checkpoint-storyboard-relation-resolution-journal.js";
import { assertLineageHasNoPreparingOrBoundRelationActionResolutions, assertNoRelationActionResolutionEvidence, assertRelationActionResolutionJournalCompleteForLineage, initializeRelationActionStateHead, readRelationActionResolutionState } from "./checkpoint-storyboard-relation-action-resolution-journal.js";
import { assertLateResolutionJournalsComplete, assertLateResolutionMembersAreQuiescent, initializeLateResolutionStateHeads, lateResolutionMemberIds, readGeometryMorphResolutionBindingStateForRecord, readLifecycleResolutionBindingStateForRecord, readRetainedTraceResolutionBindingStateForRecord, readStoredRecordProfile } from "./checkpoint-storyboard-record-store-resolution-partitions.js";

export { configureCheckpointStoryboardRecordStore, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost, CheckpointStoryboardRecordStoreError };
export { readCheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordOperationEvidence, type CheckpointStoryboardRecordStoreAuthority, type CheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store-types.js";

type StoredOperationResult = { readonly record: CheckpointStoryboardStoredRecord; readonly replayed: boolean; readonly evidence: CheckpointStoryboardRecordOperationEvidence; readonly materializationBinding: CheckpointStoryboardMaterializationBindingState };
export type CheckpointStoryboardStoredRecordView = { readonly record: CheckpointStoryboardStoredRecord; readonly materializationBinding: CheckpointStoryboardMaterializationBindingState };
export type CheckpointStoryboardStoredRecordAuditView = CheckpointStoryboardStoredRecordView & { readonly creativeReview?: CheckpointStoryboardCreativeReviewView };
const UUID_SUFFIX = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RECORD_STAGE_NAME = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const TARGET_STAGE_NAME = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:active|tombstone)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const BINDING_STAGE_NAME = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");

export async function createCheckpointStoryboardStoredRecord(authority: CheckpointStoryboardRecordStoreAuthority, storyboard: CheckpointStoryboard, parent?: CheckpointStoryboardRecordIdentity): Promise<StoredOperationResult> {
  const facts = checkedAuthority(authority);
  await assertAuthorityLive(facts);
  const admitted = admitCheckpointStoryboardC6CRecordProfile(storyboard);
  const identity = identityFor(admitted.storyboard);
  if (identity.revision > MAX_LINEAGE_ANCESTRY_DEPTH) throw storeError("lineage_limit_exceeded", `Checkpoint storyboard immutable lineage cannot exceed the ${MAX_LINEAGE_ANCESTRY_DEPTH}-member host reopening limit.`);
  const root = parent ? await readImmutableRecordRoot(facts, parent) : identity;
  return withLineageLock(facts, root.id, async () => {
    // Preserve byte-for-byte legacy B1 @1 admission. Every later sealed partition, including
    // B5 lifecycle, carries an explicit tag; profile omission remains strict B1 on replay.
    const candidate: StoredRecordFile = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record@1", storyboard: admitted.storyboard, lineage: Object.freeze({ root, ...(parent ? { parent } : {}) }), admission: Object.freeze({ staticProfileAdmitted: true as const, ...(admitted.profile === "c6b1-scalar-spatial@1" ? {} : { profile: admitted.profile }) }) });
    const operation = parent ? "timeline.checkpoint-storyboard.revise" : "timeline.checkpoint-storyboard.create";
    const existing = await readOptionalRecordFile(facts, identity);
    if (parent) {
      const reopenedParent = await reopenParent(facts, parent, root);
      if (profileOf(reopenedParent) !== profileOf(candidate)) throw storeError("record_identity_conflict", "Checkpoint storyboard revisions cannot cross the sealed C6 profile partition.");
    }
    if (existing) {
      if ((await readImmutableRecordLineage(facts, identity)).terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
      // Only the interrupted pre-target create window may recover its first state head. A final
      // target (including a tombstoned one) makes a missing head an integrity failure, never a
      // reason to erase materialization history by minting fresh `unbound` state.
      if (!(await readOptionalTargetFile(facts, identity))) {
        if (await hasTombstone(facts, identity)) throw storeError("record_identity_conflict", "Checkpoint storyboard immutable record is already retired at its exact target.");
        // This is the sole replay window permitted to create the initial signed roster/state:
        // immutable record bytes exist, but no final active/tombstone marker was published.
        await publishLineageMember(facts, root, identity, true);
        await initializeLegacyMaterializationStateHead(facts, candidate, identity, root);
        await initializeBehaviorResolutionStateHead(facts, candidate, identity, root);
        await initializeRelationResolutionStateHead(facts, candidate, identity, root);
        await initializeRelationActionResolutionStateHead(facts, candidate, identity, root);
        await initializeLateResolutionStateHeads(facts, candidate, identity, root);
      } else {
        await assertLineageMembershipExists(facts, root);
        await readLegacyMaterializationBindingState(facts, existing, identity, root);
        await readBehaviorResolutionBindingState(facts, existing, identity, root);
        await readRelationResolutionBindingState(facts, existing, identity, root);
        await readRelationActionResolutionBindingState(facts, existing, identity, root);
        await readLifecycleResolutionBindingStateForRecord(facts, existing, identity, root);
        await readGeometryMorphResolutionBindingStateForRecord(facts, existing, identity, root);
        await readRetainedTraceResolutionBindingStateForRecord(facts, existing, identity, root);
      }
      return replayExisting(facts, existing, candidate, operation);
    }
    // Only an identity with no immutable record may mint its initial open lineage member. Existing
    // records/parents must reopen their already-signed lineage, so missing journals fail closed.
    if (!parent) {
      const lineage = await ensureLineage(facts, root);
      if (lineage.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
    }
    // Refuse the 129th sibling before publishing an otherwise orphaned immutable record.
    await preflightLineageMemberCapacity(facts, root, identity);
    await publishRecord(facts, candidate);
    // Membership is durable before the pre-existing final active target marker.  A crash can
    // therefore be replayed or rejected honestly; it cannot leave an invisible sibling.
    await publishLineageMember(facts, root, identity);
    await initializeLegacyMaterializationStateHead(facts, candidate, identity, root);
    await initializeBehaviorResolutionStateHead(facts, candidate, identity, root);
    await initializeRelationResolutionStateHead(facts, candidate, identity, root);
    await initializeRelationActionResolutionStateHead(facts, candidate, identity, root);
    await initializeLateResolutionStateHeads(facts, candidate, identity, root);
    const evidence = await prepareOperationEvidence(facts, operation, candidate, "active", false);
    // This exact-target member is the immutable final marker, including its receipt evidence.
    await publishFinalTarget(facts, activeTarget(identity, evidence));
    const record = Object.freeze({ identity, storyboard: admitted.storyboard, lineage: candidate.lineage, target: Object.freeze({ state: "active" as const, activeMaterializationBindings: 0 as const }), archive: Object.freeze({ terminal: false }), admission: candidate.admission });
    return Object.freeze({ record, replayed: false, evidence, materializationBinding: await readLegacyMaterializationBindingState(facts, candidate, identity, root) });
  });
}
export async function inspectCheckpointStoryboardStoredRecord(authority: CheckpointStoryboardRecordStoreAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardStoredRecord> {
  const facts = checkedAuthority(authority);
  await assertAuthorityLive(facts);
  const root = await readImmutableRecordRoot(facts, identity);
  return withLineageLock(facts, root.id, async () => {
    await assertLineageMembershipExists(facts, root);
    return await readStoredRecordUnlocked(facts, identity);
  });
}
/** Lifecycle projection uses this atomic view so repair-capable state reads never run unlocked. */
export async function inspectCheckpointStoryboardStoredRecordView(authority: CheckpointStoryboardRecordStoreAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardStoredRecordView> {
  const facts = checkedAuthority(authority);
  await assertAuthorityLive(facts);
  const root = await readImmutableRecordRoot(facts, identity);
  return withLineageLock(facts, root.id, async () => {
    await assertLineageMembershipExists(facts, root);
    const record = await readStoredRecordUnlocked(facts, identity);
    return Object.freeze({ record, materializationBinding: await readLegacyMaterializationBindingState(facts, record, identity, root) });
  });
}
/** One locked B1/B1a/B1b/B1c/B1e snapshot for the lifecycle inspect command. */
export async function inspectCheckpointStoryboardStoredRecordAuditView(authority: CheckpointStoryboardRecordStoreAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardStoredRecordAuditView> {
  const facts = checkedAuthority(authority);
  await assertAuthorityLive(facts);
  const root = await readImmutableRecordRoot(facts, identity);
  return withLineageLock(facts, root.id, async () => {
    await assertLineageMembershipExists(facts, root);
    const record = await readStoredRecordUnlocked(facts, identity);
    const materializationBinding = await readLegacyMaterializationBindingState(facts, record, identity, root);
    // B2 has its own journal and never causes a synthetic B1 state head. Audit reopens it so
    // a malformed behavior-resolution residue cannot be hidden behind the lifecycle facade.
    await readBehaviorResolutionBindingState(facts, record, identity, root);
    await readRelationResolutionBindingState(facts, record, identity, root);
    await readRelationActionResolutionBindingState(facts, record, identity, root);
    await readLifecycleResolutionBindingStateForRecord(facts, record, identity, root);
    await readGeometryMorphResolutionBindingStateForRecord(facts, record, identity, root);
    await readRetainedTraceResolutionBindingStateForRecord(facts, record, identity, root);
    await assertLineageRetainedTraceReviewJournalIsComplete(facts, root);
    const creativeReview = await inspectCheckpointStoryboardCreativeReview(facts, root, record.identity);
    await assertLineageQualityReviewJournalIsComplete(facts, root);
    return Object.freeze({ record, materializationBinding, ...(creativeReview ? { creativeReview } : {}) });
  });
}
/** Catalog removal writes an immutable tombstone and keeps sealed audit bytes. */
export async function tombstoneCheckpointStoryboardStoredRecord(authority: CheckpointStoryboardRecordStoreAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<StoredOperationResult> {
  const facts = checkedAuthority(authority);
  await assertAuthorityLive(facts);
  const root = await readImmutableRecordRoot(facts, identity);
  return withLineageLock(facts, root.id, async () => {
    const record = await readStoredRecordUnlocked(facts, identity);
    if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
    const state = await readLegacyMaterializationBindingState(facts, record, record.identity, root);
    if (state.state === "preparing" || state.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove requires this exact record to be unbound or detached.");
    const behavior = await readBehaviorResolutionBindingState(facts, record, record.identity, root);
    if (behavior.state === "preparing" || behavior.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove requires this exact behavior-resolution record to be unbound or detached.");
    const relation = await readRelationResolutionBindingState(facts, record, record.identity, root);
    if (relation.state === "preparing" || relation.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove requires this exact relation-resolution record to be unbound or detached.");
    const action = await readRelationActionResolutionBindingState(facts, record, record.identity, root);
    if (action.state === "preparing" || action.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove requires this exact relation-action-resolution record to be unbound or detached.");
    const lifecycle = await readLifecycleResolutionBindingStateForRecord(facts, record, record.identity, root);
    if (lifecycle.state === "preparing" || lifecycle.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove requires this exact lifecycle-resolution record to be unbound or detached.");
    const geometryMorph = await readGeometryMorphResolutionBindingStateForRecord(facts, record, record.identity, root);
    if (geometryMorph.state === "preparing" || geometryMorph.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove requires this exact geometry-morph-resolution record to be unbound or detached.");
    const retainedTrace = await readRetainedTraceResolutionBindingStateForRecord(facts, record, record.identity, root);
    if (retainedTrace.state === "preparing" || retainedTrace.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove requires this exact retained-trace-resolution record to be unbound or detached.");
    await assertLateResolutionJournalsComplete(facts, root, await lateResolutionMemberIds(facts, root));
    await assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(facts, root);
    await assertLineageRetainedTraceReviewJournalIsComplete(facts, root);
    await assertLineageHasNoUnsettledCheckpointStoryboardPreviews(facts, root);
    // A review is retained historical evidence, not an active binding.  Removal may proceed only
    // after the complete root-scoped B1c roster proves there is no hidden, damaged, or unsettled
    // association to discard from later archive audit.
    await assertLineageCreativeReviewJournalIsComplete(facts, root);
    await assertLineageQualityReviewJournalIsComplete(facts, root);
    const evidence = await prepareOperationEvidence(facts, "timeline.checkpoint-storyboard.remove", storedFile(record), "tombstoned", false);
    if (record.target.state === "tombstoned") return Object.freeze({ record, evidence, replayed: true, materializationBinding: state });
    const event: TombstoneFile = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record-tombstone@1", identity, evidence });
    await publishFinalTombstone(facts, event);
    return Object.freeze({ record: Object.freeze({ ...record, target: Object.freeze({ state: "tombstoned" as const, activeMaterializationBindings: 0 as const }) }), evidence, replayed: false, materializationBinding: state });
  });
}
/** Archiving is terminal lineage state and requires B1's structurally-zero binding count. */
export async function archiveCheckpointStoryboardStoredLineage(authority: CheckpointStoryboardRecordStoreAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<StoredOperationResult> {
  const facts = checkedAuthority(authority);
  await assertAuthorityLive(facts);
  const root = await readImmutableRecordRoot(facts, identity);
  return withLineageLock(facts, root.id, async () => {
    const record = await readStoredRecordUnlocked(facts, identity);
    const members = await readLineageMembers(facts, root);
    const b2MemberIds = new Set<string>(), b3MemberIds = new Set<string>(), b4MemberIds = new Set<string>();
    for (const member of members) {
      let reopened: CheckpointStoryboardStoredRecord;
      try { reopened = await readStoredRecordUnlocked(facts, member.identity); }
      catch { throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership cannot reopen an immutable member record."); }
      if (profileOf(reopened) === "c6b2-behavior@1") b2MemberIds.add(member.identity.id);
      if (profileOf(reopened) === "c6b3-relation@1") b3MemberIds.add(member.identity.id);
      if (profileOf(reopened) === "c6b4-relation-action@1") b4MemberIds.add(member.identity.id);
    }
    await assertLineageHasNoLegacyPreparingOrBoundMembers(facts, root);
    await assertLineageHasNoPreparingOrBoundBehaviorResolutions(facts, root, b2MemberIds);
    await assertLineageHasNoPreparingOrBoundRelationResolutions(facts, root, b3MemberIds);
    await assertLineageHasNoPreparingOrBoundRelationActionResolutions(facts, root, b4MemberIds);
    const lateMembers = await lateResolutionMemberIds(facts, root);
    await assertLateResolutionMembersAreQuiescent(facts, root, lateMembers);
    await assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(facts, root);
    await assertLineageRetainedTraceReviewJournalIsComplete(facts, root);
    await assertLineageHasNoUnsettledCheckpointStoryboardPreviews(facts, root);
    await assertLineageCreativeReviewJournalIsComplete(facts, root);
    await assertLineageQualityReviewJournalIsComplete(facts, root);
    await assertBehaviorResolutionJournalCompleteForLineage(facts, root, b2MemberIds);
    await assertRelationResolutionJournalCompleteForLineage(facts, root, b3MemberIds);
    await assertRelationActionResolutionJournalCompleteForLineage(facts, root, b4MemberIds);
    await assertLateResolutionJournalsComplete(facts, root, lateMembers);
    await assertArchiveLineageRosterIsComplete(facts, root, members);
    for (const member of members) {
      let reopened: CheckpointStoryboardStoredRecord;
      try { reopened = await readStoredRecordUnlocked(facts, member.identity); }
      catch { throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership cannot reopen an immutable member record."); }
      if (!sameIdentity(reopened.identity, member.identity) || !sameIdentity(reopened.lineage.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership does not reopen its exact immutable record.");
    }
    const rootRecord = sameIdentity(record.identity, record.lineage.root) ? record : await readStoredRecordUnlocked(facts, record.lineage.root);
    const evidence = await prepareOperationEvidence(facts, "timeline.checkpoint-storyboard.archive", storedFile(rootRecord), rootRecord.target.state, true);
    const materializationBinding = await readLegacyMaterializationBindingState(facts, record, record.identity, root);
    if (record.archive.terminal) return Object.freeze({ record, evidence, replayed: true, materializationBinding });
    const event: ArchiveFile = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-lineage-archive@1", root: record.lineage.root, evidence });
    await publishFinalArchive(facts, event);
    return Object.freeze({ record: Object.freeze({ ...record, archive: Object.freeze({ terminal: true as const }) }), evidence, replayed: false, materializationBinding });
  });
}

/** Archive is destructive, so verify bounded roster completeness against every immutable record
 * and final target through streaming scans. A deleted tail cannot be hidden behind an old head. */
async function assertArchiveLineageRosterIsComplete(facts: ReturnType<typeof checkedAuthority>, root: CheckpointStoryboardRecordIdentity, members: readonly { readonly identity: CheckpointStoryboardRecordIdentity }[]): Promise<void> {
  const key = (identity: CheckpointStoryboardRecordIdentity) => `${identity.id}:${identity.sha256}:${identity.revision}`;
  const expected = new Set(members.map((member) => key(member.identity)));
  const found = new Set<string>();
  const records = await opendir(facts.records.path);
  try {
    for await (const entry of records) {
      if (entry.isFile() && RECORD_STAGE_NAME.test(entry.name)) continue;
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record directory contains an invalid entry.");
      const immutable = await readImmutableRecordFromPrivateNameUnlocked(facts, entry.name);
      if (!sameIdentity(immutable.file.lineage.root, root)) continue;
      const reopened = await readStoredRecordUnlocked(facts, immutable.identity);
      const identity = key(reopened.identity);
      if (found.size >= 128 || found.has(identity) || !expected.has(identity)) throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership is incomplete against immutable records.");
      found.add(identity);
    }
  } finally { await records.close().catch(() => undefined); }
  if (found.size !== expected.size || [...expected].some((identity) => !found.has(identity))) throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership is missing an immutable record.");

  const bindings = await opendir(facts.bindings.path);
  const validatedBindingIdentities = new Set<string>();
  try {
    for await (const entry of bindings) {
      if (entry.isFile() && BINDING_STAGE_NAME.test(entry.name)) continue;
      const match = entry.isFile() && /^(checkpoint_storyboard_[a-f0-9]{32})\.(?:state|intent|binding|cow-start|detach|abandon)\.json$/u.exec(entry.name);
      if (!match) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization journal directory contains an invalid entry.");
      // Every final materialization journal suffix requires its signed phase head. Read the head
      // first to filter independent roots, then fully validate every matching root journal.
      const stateHead = await readMaterializationStateHead(facts, match[1]!);
      if (!stateHead || stateHead.identity.id !== match[1]) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization journal has no matching signed state head.");
      if (!sameIdentity(stateHead.root, root)) continue;
      const identity = key(stateHead.identity);
      if (!expected.has(identity)) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization journal names an unlisted lineage member.");
      if (!validatedBindingIdentities.has(identity)) {
        const reopened = await readStoredRecordUnlocked(facts, stateHead.identity);
        await readLegacyMaterializationBindingState(facts, reopened, stateHead.identity, root);
        validatedBindingIdentities.add(identity);
      }
    }
  } finally { await bindings.close().catch(() => undefined); }

  const targets = await opendir(facts.targets.path);
  try {
    for await (const entry of targets) {
      if (entry.isFile() && TARGET_STAGE_NAME.test(entry.name)) continue;
      const match = entry.isFile() && /^(checkpoint_storyboard_[a-f0-9]{32})\.(?:active|tombstone)\.json$/u.exec(entry.name);
      if (!match) throw storeError("store_integrity_failed", "Checkpoint storyboard final target directory contains an invalid entry.");
      // Reopen the exact record named by every final target; this also validates its signed
      // active/tombstone evidence and prevents a retained orphan target from being ignored.
      await readStoredRecordFromPrivateNameUnlocked(facts, `${match[1]}.json`);
    }
  } finally { await targets.close().catch(() => undefined); }
}

async function reopenParent(facts: ReturnType<typeof checkedAuthority>, parent: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardStoredRecord> {
  const record = await readStoredRecordUnlocked(facts, parent);
  if (record.target.state === "tombstoned") throw storeError("record_tombstoned", "A tombstoned checkpoint storyboard record cannot be revised.");
  if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
  if (!sameIdentity(record.identity, parent) || !sameIdentity(record.lineage.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard parent identity or lineage changed while reopening.");
  return record;
}
async function replayExisting(facts: ReturnType<typeof checkedAuthority>, existing: StoredRecordFile, candidate: StoredRecordFile, operation: CheckpointStoryboardRecordOperationEvidence["operation"]): Promise<StoredOperationResult> {
  const replayCandidate = existing.admission.profile === undefined && profileOf(candidate) === "c6b1-scalar-spatial@1"
    ? Object.freeze({ ...candidate, admission: existing.admission }) : candidate;
  if (canonicalJson(existing) !== canonicalJson(replayCandidate)) throw storeError("record_identity_conflict", "Checkpoint storyboard record identity is already occupied by different immutable content.");
  const target = await readOptionalTargetFile(facts, identityFor(candidate.storyboard));
  if (!target) {
    if (await hasTombstone(facts, identityFor(candidate.storyboard))) throw storeError("record_identity_conflict", "Checkpoint storyboard immutable record is already retired at its exact target.");
    const evidence = await prepareOperationEvidence(facts, operation, existing, "active", false);
    await publishFinalTarget(facts, activeTarget(identityFor(candidate.storyboard), evidence));
    const record = await readStoredRecordUnlocked(facts, identityFor(candidate.storyboard));
    return Object.freeze({ record, replayed: true as const, evidence, materializationBinding: await readLegacyMaterializationBindingState(facts, record, record.identity, record.lineage.root) });
  }
  if (target.state !== "active") throw storeError("record_identity_conflict", "Checkpoint storyboard immutable record is already retired at its exact target.");
  const evidence = await prepareOperationEvidence(facts, operation, existing, "active", false);
  const record = await readStoredRecordUnlocked(facts, identityFor(candidate.storyboard));
  return Object.freeze({ record, replayed: true as const, evidence, materializationBinding: await readLegacyMaterializationBindingState(facts, record, record.identity, record.lineage.root) });
}

const profileOf = readStoredRecordProfile;
async function initializeLegacyMaterializationStateHead(facts: ReturnType<typeof checkedAuthority>, record: StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  if (profileOf(record) === "c6b1-scalar-spatial@1") await initializeMaterializationStateHead(facts, identity, root);
}
async function initializeBehaviorResolutionStateHead(facts: ReturnType<typeof checkedAuthority>, record: StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  if (profileOf(record) === "c6b2-behavior@1") await initializeBehaviorStateHead(facts, identity, root);
}
async function initializeRelationResolutionStateHead(facts: ReturnType<typeof checkedAuthority>, record: StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  if (profileOf(record) === "c6b3-relation@1") await initializeRelationStateHead(facts, identity, root);
}
async function initializeRelationActionResolutionStateHead(facts: ReturnType<typeof checkedAuthority>, record: StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  if (profileOf(record) === "c6b4-relation-action@1") await initializeRelationActionStateHead(facts, identity, root);
}
async function readLegacyMaterializationBindingState(facts: ReturnType<typeof checkedAuthority>, record: Pick<CheckpointStoryboardStoredRecord, "admission"> | StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardMaterializationBindingState> {
  if (profileOf(record) === "c6b1-scalar-spatial@1") return await readMaterializationBindingState(facts, identity, root);
  await assertNoLegacyMaterializationEvidence(facts, identity);
  return Object.freeze({ state: "unbound" as const, active: 0 as const });
}
async function readBehaviorResolutionBindingState(facts: ReturnType<typeof checkedAuthority>, record: Pick<CheckpointStoryboardStoredRecord, "admission"> | StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity) {
  if (profileOf(record) === "c6b2-behavior@1") return await readBehaviorResolutionState(facts, identity, root, { requireHead: true });
  await assertNoBehaviorResolutionEvidence(facts, identity);
  return Object.freeze({ state: "unbound" as const, active: 0 as const });
}
async function readRelationResolutionBindingState(facts: ReturnType<typeof checkedAuthority>, record: Pick<CheckpointStoryboardStoredRecord, "admission"> | StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity) {
  if (profileOf(record) === "c6b3-relation@1") return await readRelationResolutionState(facts, identity, root, { requireHead: true });
  await assertNoRelationResolutionEvidence(facts, identity);
  return Object.freeze({ state: "unbound" as const, active: 0 as const });
}
async function readRelationActionResolutionBindingState(facts: ReturnType<typeof checkedAuthority>, record: Pick<CheckpointStoryboardStoredRecord, "admission"> | StoredRecordFile, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity) {
  if (profileOf(record) === "c6b4-relation-action@1") return await readRelationActionResolutionState(facts, identity, root, { requireHead: true });
  await assertNoRelationActionResolutionEvidence(facts, identity);
  return Object.freeze({ state: "unbound" as const, active: 0 as const });
}
async function assertLineageHasNoLegacyPreparingOrBoundMembers(facts: ReturnType<typeof checkedAuthority>, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  for (const member of await readLineageMembers(facts, root)) {
    const record = await readStoredRecordUnlocked(facts, member.identity);
    const state = await readLegacyMaterializationBindingState(facts, record, member.identity, root);
    if (state.state === "preparing" || state.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard archive requires every legacy B1 binding to be unbound, abandoned, or detached.");
  }
}
