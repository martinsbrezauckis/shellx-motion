/** Private C6C B1c signed-record shapes shared by the binding, journal, and publication seams. */
import type { CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

export const BINDING_FILE = /^(checkpoint_storyboard_[a-f0-9]{32})\.creative-review\.json$/u;
export const INTENT_FILE = /^(checkpoint_storyboard_[a-f0-9]{32})\.creative-review\.intent\.json$/u;
export const COMPLETE_FILE = /^(checkpoint_storyboard_[a-f0-9]{32})\.creative-review\.complete\.json$/u;
export const MEMBER_FILE = /^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])\.json$/u;
export const MAX_BINDINGS_PER_LINEAGE = 128;
export const MAX_BINDING_BYTES = 32 * 1024;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const MEMBER_PREFIX = "checkpoint_storyboard_creative_review_member_";
export const INTENT_PREFIX = "checkpoint_storyboard_creative_review_intent_";
export const COMPLETE_PREFIX = "checkpoint_storyboard_creative_review_complete_";

export type CreativeIdentity = Readonly<{ id: string; sha256: string }>;
export type AuthenticatedActor = Readonly<{ kind: "human" | "policy"; id: string }>;
export type StoredBinding = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-creative-review@1" | "shellx-motion/private-checkpoint-storyboard-creative-review@2";
  id: string;
  sha256: string;
  identity: CheckpointStoryboardRecordIdentity;
  root: CheckpointStoryboardRecordIdentity;
  c6: Readonly<{ fingerprint: string }>;
  b1a: Readonly<{ bindingId: string; bindingSha256: string; c6bReceiptFingerprint: string }>;
  preview: Readonly<{ targetSha256: string; receiptSha256: string; pngSha256: string; snapshotSha256: string; samplingSha256?: string; width: number; height: number; runtimeEvidence: "host-browser" | "source-test" }>;
  creative: Readonly<{ brief: CreativeIdentity; shotPlan: CreativeIdentity; assetLedger: CreativeIdentity; run: CreativeIdentity; reviewDecision: CreativeIdentity }>;
  host: Readonly<{ shotPlanApprover: AuthenticatedActor; reviewDecisionReviewer: AuthenticatedActor; authenticationDigest: string; handleDigest: string }>;
  outcome: "accepted" | "changes_requested" | "rejected";
  derivedRunId: string;
  scope: Readonly<{ shotId: string; atMs: number }>;
}>;
export type CreativeReviewMember = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member@1";
  id: string;
  sha256: string;
  root: CheckpointStoryboardRecordIdentity;
  identity: CheckpointStoryboardRecordIdentity;
  ordinal: number;
  binding: Readonly<{ id: string; sha256: string }>;
  previous?: Readonly<{ id: string; sha256: string }>;
}>;
export type CreativeReviewMemberHead = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member-head@1";
  root: CheckpointStoryboardRecordIdentity;
  ordinal: number;
  member: Readonly<{ id: string; sha256: string }>;
  phase: "preparing" | "complete";
}>;
export type CreativeReviewIntent = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-creative-review-intent@1";
  id: string;
  sha256: string;
  root: CheckpointStoryboardRecordIdentity;
  identity: CheckpointStoryboardRecordIdentity;
  binding: Readonly<{ id: string; sha256: string }>;
}>;
export type CreativeReviewCompletion = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-creative-review-complete@1";
  id: string;
  sha256: string;
  root: CheckpointStoryboardRecordIdentity;
  identity: CheckpointStoryboardRecordIdentity;
  binding: Readonly<{ id: string; sha256: string }>;
  member: Readonly<{ id: string; sha256: string }>;
}>;
export type CreativeReviewJournal = Readonly<{
  bindings: readonly StoredBinding[];
  members: readonly CreativeReviewMember[];
  pending?: Readonly<{ intent: CreativeReviewIntent; member?: CreativeReviewMember; binding?: StoredBinding; head?: CreativeReviewMemberHead }>;
}>;
