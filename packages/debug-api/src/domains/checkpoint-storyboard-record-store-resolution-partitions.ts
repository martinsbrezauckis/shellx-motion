/** Late C6C resolver partitions stay independent from the legacy B1-B4 store surface. */
import { readLineageMembers } from "./checkpoint-storyboard-materialization-bindings.js";
import { readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import {
  assertGeometryMorphResolutionJournalCompleteForLineage,
  assertLineageHasNoPreparingOrBoundGeometryMorphResolutions,
  assertNoGeometryMorphResolutionEvidence,
  initializeGeometryMorphStateHead,
  readGeometryMorphResolutionState,
} from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import {
  assertLifecycleResolutionJournalCompleteForLineage,
  assertLineageHasNoPreparingOrBoundLifecycleResolutions,
  assertNoLifecycleResolutionEvidence,
  initializeLifecycleStateHead,
  readLifecycleResolutionState,
} from "./checkpoint-storyboard-lifecycle-resolution-journal.js";
import {
  assertLineageHasNoPreparingOrBoundRetainedTraceResolutions,
  assertNoRetainedTraceResolutionEvidence,
  assertRetainedTraceResolutionJournalCompleteForLineage,
  initializeRetainedTraceStateHead,
  readRetainedTraceResolutionState,
} from "./checkpoint-storyboard-retained-trace-resolution-journal.js";
import {
  storeError,
  type AuthorityFacts,
  type CheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordProfile,
  type CheckpointStoryboardStoredRecord,
  type StoredRecordFile,
} from "./checkpoint-storyboard-record-store-types.js";

type StoredProfileRecord = Pick<CheckpointStoryboardStoredRecord, "admission"> | StoredRecordFile;
export type LateResolutionMemberIds = Readonly<{ lifecycle: ReadonlySet<string>; geometryMorph: ReadonlySet<string>; retainedTrace: ReadonlySet<string> }>;

/** The store reopens an exact sealed profile; no resolver can infer a profile from loose content. */
export function readStoredRecordProfile(record: StoredProfileRecord): CheckpointStoryboardRecordProfile {
  const profile = record.admission.profile;
  if (profile === undefined) return "c6b1-scalar-spatial@1";
  if (profile === "c6b2-behavior@1" || profile === "c6b3-relation@1" || profile === "c6b4-relation-action@1" || profile === "c6b5-lifecycle@1" || profile === "c6b6-geometry-morph@1" || profile === "c6b7-retained-trace@1") return profile;
  throw storeError("store_integrity_failed", "Checkpoint storyboard stored record has an invalid sealed profile partition.");
}

/** Only the matching late partition may mint its signed unbound state head. */
export async function initializeLateResolutionStateHeads(facts: AuthorityFacts, record: StoredProfileRecord, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  const profile = readStoredRecordProfile(record);
  if (profile === "c6b5-lifecycle@1") await initializeLifecycleStateHead(facts, identity, root);
  if (profile === "c6b6-geometry-morph@1") await initializeGeometryMorphStateHead(facts, identity, root);
  if (profile === "c6b7-retained-trace@1") await initializeRetainedTraceStateHead(facts, identity, root);
}

export async function readLifecycleResolutionBindingStateForRecord(facts: AuthorityFacts, record: StoredProfileRecord, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity) {
  if (readStoredRecordProfile(record) === "c6b5-lifecycle@1") return await readLifecycleResolutionState(facts, identity, root, { requireHead: true });
  await assertNoLifecycleResolutionEvidence(facts, identity);
  return Object.freeze({ state: "unbound" as const, active: 0 as const });
}

export async function readGeometryMorphResolutionBindingStateForRecord(facts: AuthorityFacts, record: StoredProfileRecord, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity) {
  if (readStoredRecordProfile(record) === "c6b6-geometry-morph@1") return await readGeometryMorphResolutionState(facts, identity, root, { requireHead: true });
  await assertNoGeometryMorphResolutionEvidence(facts, identity);
  return Object.freeze({ state: "unbound" as const, active: 0 as const });
}

export async function readRetainedTraceResolutionBindingStateForRecord(facts: AuthorityFacts, record: StoredProfileRecord, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity) {
  if (readStoredRecordProfile(record) === "c6b7-retained-trace@1") return await readRetainedTraceResolutionState(facts, identity, root, { requireHead: true });
  await assertNoRetainedTraceResolutionEvidence(facts, identity);
  return Object.freeze({ state: "unbound" as const, active: 0 as const });
}

export async function lateResolutionMemberIds(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<LateResolutionMemberIds> {
  const lifecycle = new Set<string>(), geometryMorph = new Set<string>(), retainedTrace = new Set<string>();
  for (const member of await readLineageMembers(facts, root)) {
    const profile = readStoredRecordProfile(await readStoredRecordUnlocked(facts, member.identity));
    if (profile === "c6b5-lifecycle@1") lifecycle.add(member.identity.id);
    if (profile === "c6b6-geometry-morph@1") geometryMorph.add(member.identity.id);
    if (profile === "c6b7-retained-trace@1") retainedTrace.add(member.identity.id);
  }
  return Object.freeze({ lifecycle, geometryMorph, retainedTrace });
}

export async function assertLateResolutionMembersAreQuiescent(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, members: LateResolutionMemberIds): Promise<void> {
  await assertLineageHasNoPreparingOrBoundLifecycleResolutions(facts, root, new Set(members.lifecycle));
  await assertLineageHasNoPreparingOrBoundGeometryMorphResolutions(facts, root, new Set(members.geometryMorph));
  await assertLineageHasNoPreparingOrBoundRetainedTraceResolutions(facts, root, new Set(members.retainedTrace));
}

/** Both private namespaces are complete archive/removal evidence, even for older profiles. */
export async function assertLateResolutionJournalsComplete(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, members: LateResolutionMemberIds): Promise<void> {
  await assertLifecycleResolutionJournalCompleteForLineage(facts, root, new Set(members.lifecycle));
  await assertGeometryMorphResolutionJournalCompleteForLineage(facts, root, new Set(members.geometryMorph));
  await assertRetainedTraceResolutionJournalCompleteForLineage(facts, root, new Set(members.retainedTrace));
}
