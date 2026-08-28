/** Shared private types and strict value helpers for the C6C host store. */
import type { CheckpointStoryboard } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import type { TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";

export const STORE_DIRECTORY = ".shellx-motion-c6c-record-store";
/**
 * Every C6C-owned leaf lives under the same host-private store.  Preview evidence is
 * deliberately separate from records, bindings, and materialized packages: it is
 * renderer evidence, not new storyboard or C6B authority.
 */
export const STORE_CHILDREN = ["records", "targets", "lineages", "locks", "receipts", "bindings", "members", "previews", "creative-reviews", "quality-reviews", "behavior-resolutions", "relation-resolutions", "relation-action-resolutions", "lifecycle-resolutions", "geometry-morph-resolutions", "retained-trace-resolutions", "retained-trace-previews", "retained-trace-reviews"] as const;
export const MAX_RECORD_BYTES = 320 * 1024;
export const MAX_STATE_BYTES = 16 * 1024;
/** Host reopening follows at most this many immutable parent members before refusing hostile work. */
export const MAX_LINEAGE_ANCESTRY_DEPTH = 128;
export const ID = /^checkpoint_storyboard_[a-f0-9]{32}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
const revisionLimit = 1_000_000;

export const authorityBrand: unique symbol = Symbol("checkpoint-storyboard-record-store-authority");
export interface CheckpointStoryboardRecordStoreAuthority {
  readonly [authorityBrand]: "host-configured-c6c-record-store";
}
export interface CheckpointStoryboardRecordIdentity {
  readonly id: string;
  readonly sha256: string;
  readonly revision: number;
}
/** Sealed at record creation and replayed verbatim from immutable evidence. */
export type CheckpointStoryboardRecordProfile = "c6b1-scalar-spatial@1" | "c6b2-behavior@1" | "c6b3-relation@1" | "c6b4-relation-action@1" | "c6b5-lifecycle@1" | "c6b6-geometry-morph@1" | "c6b7-retained-trace@1";
/**
 * B1 deliberately has no `profile` property in its signed bytes. Later partitions
 * are tagged, rather than retroactively changing B1's immutable wire shape.
 */
export type CheckpointStoryboardRecordAdmission = {
  readonly staticProfileAdmitted: true;
  readonly profile?: CheckpointStoryboardRecordProfile;
};
export type CheckpointStoryboardRecordTargetState = "active" | "tombstoned";
export interface CheckpointStoryboardStoredRecord {
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly storyboard: CheckpointStoryboard;
  readonly lineage: { readonly root: CheckpointStoryboardRecordIdentity; readonly parent?: CheckpointStoryboardRecordIdentity };
  readonly target: { readonly state: CheckpointStoryboardRecordTargetState; readonly activeMaterializationBindings: 0 };
  readonly archive: { readonly terminal: boolean };
  /** First-batch records must not imply exact-base validation or materializability. */
  readonly admission: CheckpointStoryboardRecordAdmission;
}
/** Derived only from signed append-only C6C B1a records. */
export type CheckpointStoryboardMaterializationState = "unbound" | "preparing" | "bound" | "detached" | "abandoned";
export interface CheckpointStoryboardMaterializationBindingState {
  readonly state: CheckpointStoryboardMaterializationState;
  readonly active: 0 | 1;
  readonly bindingId?: string;
  readonly outputHandle?: string;
}
export type CheckpointStoryboardCreativeReviewView = Readonly<{ outcome: "accepted" | "changes_requested" | "rejected"; derivedRunId: string; scope: Readonly<{ shotId: string; atMs: number }>; preview: Readonly<{ width: number; height: number; runtimeEvidence: "host-browser" | "source-test" }>; evidence: Readonly<{ evidenceClass: "host-browser-association" | "source-test-association"; hostBrowser: false; humanReview: false; pixels: false; quality: false; finalMedia: false }> }>;
export type CheckpointStoryboardRetainedTraceReviewView = Readonly<{
  associationId: string;
  outcome: "accepted" | "changes_requested" | "rejected";
  scope: Readonly<{ atUs: number }>;
  preview: Readonly<{ width: number; height: number; runtimeEvidence: "host-gpu" | "source-test" }>;
  evidence: Readonly<{
    evidenceClass: "host-gpu-review-association" | "source-test-review-association";
    storyboardSha256: string;
    recipeSha256: string;
    packageInventorySha256: string;
    previewReceiptSha256: string;
    pngSha256: string;
    hostGpu: false;
    humanReview: false;
    pixels: false;
    quality: false;
    finalMedia: false;
  }>;
}>;
export interface CheckpointStoryboardRecordOperationEvidence {
  readonly id: string;
  readonly sha256: string;
  readonly operation: "timeline.checkpoint-storyboard.create" | "timeline.checkpoint-storyboard.revise" | "timeline.checkpoint-storyboard.remove" | "timeline.checkpoint-storyboard.archive";
}
export class CheckpointStoryboardRecordStoreError extends Error {
  constructor(
    readonly code: "record_not_found" | "record_tombstoned" | "lineage_archived" | "lineage_limit_exceeded" | "record_identity_conflict" | "store_busy" | "store_integrity_failed" | "store_authority_refused" | "record_commit_uncertain" | "materialization_authority_refused" | "materialization_profile_refused" | "materialization_binding_conflict" | "materialization_binding_uncertain" | "materialization_detached" | "materialization_not_bound" | "preview_authority_refused" | "preview_binding_not_active" | "preview_target_invalid" | "preview_cancelled" | "preview_publication_uncertain" | "creative_review_authority_refused" | "creative_review_binding_conflict" | "creative_review_evidence_refused" | "retained_trace_review_authority_refused" | "retained_trace_review_binding_conflict" | "retained_trace_review_evidence_refused" | "quality_review_authority_refused" | "quality_review_evidence_refused" | "quality_review_binding_conflict" | "quality_check_failed",
    message: string,
  ) { super(message); this.name = "CheckpointStoryboardRecordStoreError"; }
}

export type StableDirectory = { readonly path: string; readonly dev: number; readonly ino: number };
export type AuthorityFacts = {
  readonly configuredRoot: StableDirectory;
  readonly store: StableDirectory;
  readonly records: StableDirectory;
  readonly targets: StableDirectory;
  readonly lineages: StableDirectory;
  readonly locks: StableDirectory;
  readonly receipts: StableDirectory;
  readonly bindings: StableDirectory;
  readonly members: StableDirectory;
  /** Host-private B1b receipts and PNG evidence, never a user-selected output root. */
  readonly previews: StableDirectory;
  readonly creativeReviews: StableDirectory;
  /** Private B1e signed quality-receipt journals; no path is command data or output. */
  readonly qualityReviews: StableDirectory;
  /** Private C6C B2 durable behavior-resolution journals. */
  readonly behaviorResolutions: StableDirectory;
  /** Private C6C B3a durable relation-resolution journals. */
  readonly relationResolutions: StableDirectory;
  /** Private C6C B4a durable relation-action-resolution journals. */
  readonly relationActionResolutions: StableDirectory;
  /** Private C6C B5 durable lifecycle-resolution journals. */
  readonly lifecycleResolutions: StableDirectory;
  /** Private C6C B6 durable geometry-morph-resolution journals. */
  readonly geometryMorphResolutions: StableDirectory;
  /** Private C6C B7 durable retained-trace-resolution journals. */
  readonly retainedTraceResolutions: StableDirectory;
  /** Private C6C B7 GPU-preview state, receipt, and PNG evidence; never B1 preview data. */
  readonly retainedTracePreviews: StableDirectory;
  /** Private C6C B7 arbitrary-time review associations; never B1 creative-review data. */
  readonly retainedTraceReviews: StableDirectory;
  /** Separately minted for Core no-clobber publication below `previews`, never B1a's package anchor. */
  readonly previewWorkspaceAuthority: TrustedWorkspaceAnchor;
  /** Separately minted for B7 renderer-owned no-clobber evidence publication. */
  readonly retainedTracePreviewWorkspaceAuthority: TrustedWorkspaceAnchor;
  readonly integrityKey: Buffer;
  readonly ownerUid: number;
  readonly storeBinding: string;
};
export type StoredRecordFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-record@1";
  readonly storyboard: CheckpointStoryboard;
  readonly lineage: { readonly root: CheckpointStoryboardRecordIdentity; readonly parent?: CheckpointStoryboardRecordIdentity };
  readonly admission: CheckpointStoryboardRecordAdmission;
};
export type TargetFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-record-target@1";
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly state: CheckpointStoryboardRecordTargetState;
  readonly activeMaterializationBindings: 0;
  /** The create/revise receipt is part of the immutable exact-target commit marker. */
  readonly evidence: CheckpointStoryboardRecordOperationEvidence;
};
export type TombstoneFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-record-tombstone@1";
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly evidence: CheckpointStoryboardRecordOperationEvidence;
};
export type LineageFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-lineage@1";
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly terminal: boolean;
};
export type ArchiveFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-lineage-archive@1";
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly evidence: CheckpointStoryboardRecordOperationEvidence;
};
export type OperationEvidenceFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-record-operation@1";
  readonly id: string;
  readonly sha256: string;
  readonly operation: CheckpointStoryboardRecordOperationEvidence["operation"];
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly targetState: CheckpointStoryboardRecordTargetState;
  readonly lineageTerminal: boolean;
  readonly admission: CheckpointStoryboardRecordAdmission;
};

export type CheckpointStoryboardMaterializationInventory = {
  readonly sha256: string;
  readonly entryCount: number;
  readonly leafCount: number;
};
/** The exact C6B base identity, retained whole rather than collapsed to a convenience hash. */
export type CheckpointStoryboardMaterializationPackageIdentity = {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly motionRawSha256: string;
  readonly manifestCanonicalSha256: string;
  readonly motionCanonicalSha256: string;
  readonly inventory: CheckpointStoryboardMaterializationInventory;
  readonly c6aPlanFingerprint: string;
  readonly c6b1bProfileFingerprint: string;
  readonly c6b1bProjectionFingerprint: string;
};
export type CheckpointStoryboardMaterializationPlanIdentity = {
  readonly c6b1aPlanFingerprint: string;
  readonly c6b1aLowererProfileFingerprint: string;
  readonly c6b1bMaterializerProfileFingerprint: string;
  readonly c6b1bProjectionFingerprint: string;
};
export type CheckpointStoryboardMaterializationIntentFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-materialization-intent@1";
  readonly id: string;
  readonly sha256: string;
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly plan: CheckpointStoryboardMaterializationPlanIdentity;
  /** C6B's exact host-derived expected base, never a caller argument. */
  readonly expectedBase: CheckpointStoryboardMaterializationPackageIdentity;
  readonly outputHandle: string;
};
export type CheckpointStoryboardMaterializationBindingFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-materialization-binding@1";
  readonly id: string;
  readonly sha256: string;
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly intent: { readonly id: string; readonly sha256: string };
  readonly plan: CheckpointStoryboardMaterializationPlanIdentity;
  readonly source: { readonly expected: CheckpointStoryboardMaterializationPackageIdentity; readonly reopened: CheckpointStoryboardMaterializationPackageIdentity };
  readonly output: { readonly expected: CheckpointStoryboardMaterializationOutputIdentity; readonly reopened: CheckpointStoryboardMaterializationOutputIdentity };
  readonly c6b1bReceiptFingerprint: string;
  readonly outputHandle: string;
};
/** Exact C6B receipt output shape: retained fully so a binding cannot alias a different COW. */
export type CheckpointStoryboardMaterializationOutputIdentity = {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly motionRawSha256: string;
  readonly canonicalMotionSha256: string;
  readonly nonReceiptInventory: CheckpointStoryboardMaterializationInventory;
  readonly preservedLeaves: { readonly sha256: string; readonly count: number };
  readonly changed: { readonly paths: readonly string[]; readonly count: 2; readonly motionPropertyPaths: readonly string[]; readonly motionPropertyPathCount: number };
};
export type CheckpointStoryboardMaterializationDetachFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-materialization-detach@1";
  readonly id: string;
  readonly sha256: string;
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly binding: { readonly id: string; readonly sha256: string };
};
export type CheckpointStoryboardMaterializationCowStartFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-materialization-cow-start@1";
  readonly id: string;
  readonly sha256: string;
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly intent: { readonly id: string; readonly sha256: string };
};
export type CheckpointStoryboardMaterializationAbandonFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-materialization-abandon@1";
  readonly id: string;
  readonly sha256: string;
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly intent: { readonly id: string; readonly sha256: string };
  readonly reason: "proven-no-install" | "no-cow-start";
};
/** Required mutable signed pointer; append-only records remain the durable audit trail. */
export type CheckpointStoryboardMaterializationStateHeadFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1";
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly state: CheckpointStoryboardMaterializationState;
  readonly active: 0 | 1;
  readonly intent?: { readonly id: string; readonly sha256: string };
  /** A durable COW invocation was authorized only after this exact start was sealed. */
  readonly cowStart?: { readonly id: string; readonly sha256: string };
  readonly binding?: { readonly id: string; readonly sha256: string };
  readonly detach?: { readonly id: string; readonly sha256: string };
  readonly abandon?: { readonly id: string; readonly sha256: string };
};
export type CheckpointStoryboardLineageMemberFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-lineage-member@1";
  readonly id: string;
  readonly sha256: string;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly ordinal: number;
  readonly previous?: { readonly id: string; readonly sha256: string };
};
export type CheckpointStoryboardLineageMemberHeadFile = {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-lineage-member-head@1";
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly ordinal: number;
  readonly member: { readonly id: string; readonly sha256: string };
};

export function storeError(code: CheckpointStoryboardRecordStoreError["code"], message: string): CheckpointStoryboardRecordStoreError {
  return new CheckpointStoryboardRecordStoreError(code, message);
}
export function code(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
export function exact(value: unknown, required: readonly string[], optional: readonly string[] | string, label?: string): Record<string, unknown> {
  const extra = Array.isArray(optional) ? optional : [];
  const resolvedLabel = typeof optional === "string" ? optional : label ?? "Checkpoint storyboard store record";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storeError("store_integrity_failed", `${resolvedLabel} is not an object.`);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...extra]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(record, key))) throw storeError("store_integrity_failed", `${resolvedLabel} fields are invalid.`);
  return record;
}
export function sameIdentity(left: CheckpointStoryboardRecordIdentity, right: CheckpointStoryboardRecordIdentity): boolean { return left.id === right.id && left.sha256 === right.sha256 && left.revision === right.revision; }
export function sameEvidence(left: CheckpointStoryboardRecordOperationEvidence, right: CheckpointStoryboardRecordOperationEvidence): boolean { return left.id === right.id && left.sha256 === right.sha256 && left.operation === right.operation; }
export function isNotFound(error: unknown): error is CheckpointStoryboardRecordStoreError { return error instanceof CheckpointStoryboardRecordStoreError && error.code === "record_not_found"; }
export function readCheckpointStoryboardRecordIdentity(value: unknown): CheckpointStoryboardRecordIdentity { return readIdentity(value, "Checkpoint storyboard record identity"); }
export function readIdentity(value: unknown, label: string): CheckpointStoryboardRecordIdentity {
  const record = exact(value, ["id", "sha256", "revision"], label);
  if (typeof record.id !== "string" || !ID.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || record.id !== `checkpoint_storyboard_${record.sha256.slice(0, 32)}` || typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > revisionLimit) throw storeError("store_integrity_failed", `${label} is invalid.`);
  return Object.freeze({ id: record.id, sha256: record.sha256, revision: record.revision });
}
export function readEvidence(value: unknown): CheckpointStoryboardRecordOperationEvidence {
  const record = exact(value, ["id", "sha256", "operation"], "Checkpoint storyboard operation evidence reference");
  const operation = record.operation;
  if (typeof record.id !== "string" || !/^checkpoint_storyboard_operation_[a-f0-9]{32}$/.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || (operation !== "timeline.checkpoint-storyboard.create" && operation !== "timeline.checkpoint-storyboard.revise" && operation !== "timeline.checkpoint-storyboard.remove" && operation !== "timeline.checkpoint-storyboard.archive")) throw storeError("store_integrity_failed", "Checkpoint storyboard operation evidence reference is invalid.");
  return Object.freeze({ id: record.id, sha256: record.sha256, operation });
}
