/** Private B1c forward-only publication from a preflighted signed intent. */
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { readCreativeReviewJournal } from "./checkpoint-storyboard-creative-review-journal.js";
import { createCompletion, createMember } from "./checkpoint-storyboard-creative-review-journal-records.js";
import { MAX_BINDING_BYTES, MAX_BINDINGS_PER_LINEAGE, type CreativeReviewJournal, type CreativeReviewMember, type CreativeReviewMemberHead, type StoredBinding } from "./checkpoint-storyboard-creative-review-types.js";
import { lineageCreativeReviewsDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { replaceSignedFile, writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { CheckpointStoryboardRecordStoreError, sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

export type CreativeReviewFaultPoint = "after-intent" | "after-member" | "after-head" | "after-final";

export async function advanceCreativeReviewPublication(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, candidate: StoredBinding, journal: CreativeReviewJournal, fault: (point: Exclude<CreativeReviewFaultPoint, "after-intent">) => Promise<void>): Promise<StoredBinding> {
  const pending = journal.pending;
  if (!pending || pending.intent.binding.id !== candidate.id || pending.intent.binding.sha256 !== candidate.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review publication cannot advance without its exact signed intent.");
  const directory = await lineageCreativeReviewsDirectory(facts, root.id);
  let member = pending.member;
  if (!member) {
    const ordinal = journal.members.length + 1;
    if (ordinal > MAX_BINDINGS_PER_LINEAGE) throw storeError("lineage_limit_exceeded", "Checkpoint storyboard creative-review lineage reached its bounded association limit.");
    member = createMember(root, candidate, ordinal, journal.members.at(-1));
    await writeExclusiveSignedFile(join(directory.path, `${ordinal}.json`), member, facts, MAX_BINDING_BYTES);
    await fault("after-member");
  }
  let head = pending.head;
  const headMatchesMember = (phase: CreativeReviewMemberHead["phase"]) => !!head && head.ordinal === member!.ordinal && head.member.id === member!.id && head.member.sha256 === member!.sha256 && head.phase === phase;
  if (!headMatchesMember("preparing") && !headMatchesMember("complete")) {
    await replaceCreativeReviewHead(facts, directory.path, root, member, "preparing");
    head = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member-head@1" as const, root, ordinal: member.ordinal, member: Object.freeze({ id: member.id, sha256: member.sha256 }), phase: "preparing" as const });
    await fault("after-head");
  }
  if (!pending.binding) {
    await writeExclusiveSignedFile(join(directory.path, `${candidate.identity.id}.creative-review.json`), candidate, facts, MAX_BINDING_BYTES);
    await fault("after-final");
  }
  if (!headMatchesMember("complete")) await replaceCreativeReviewHead(facts, directory.path, root, member, "complete");
  const completion = createCompletion(root, candidate, member);
  try {
    await writeExclusiveSignedFile(join(directory.path, `${candidate.identity.id}.creative-review.complete.json`), completion, facts, MAX_BINDING_BYTES);
  } catch (error) {
    if (!(error instanceof CheckpointStoryboardRecordStoreError) || error.code !== "record_identity_conflict") throw error;
  }
  const reopened = await readCreativeReviewJournal(facts, root);
  const binding = reopened.bindings.find((value) => sameIdentity(value.identity, candidate.identity));
  if (reopened.pending || !binding || canonicalJson(binding) !== canonicalJson(candidate)) throw storeError("record_commit_uncertain", "Checkpoint storyboard creative-review publication could not reopen its exact completed roster.");
  return binding;
}

async function replaceCreativeReviewHead(facts: AuthorityFacts, directory: string, root: CheckpointStoryboardRecordIdentity, member: CreativeReviewMember, phase: CreativeReviewMemberHead["phase"]): Promise<void> {
  await replaceSignedFile(join(directory, "head.json"), Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member-head@1" as const, root, ordinal: member.ordinal, member: Object.freeze({ id: member.id, sha256: member.sha256 }), phase }), facts, MAX_BINDING_BYTES);
}
