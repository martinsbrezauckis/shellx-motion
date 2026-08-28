/** Private, package-independent contracts for the governed creative loop. */
export const CREATIVE_BRIEF_SCHEMA = "shellx-motion/creative-brief@1" as const;
export const SHOT_PLAN_SCHEMA = "shellx-motion/shot-plan@1" as const;
export const ASSET_RECORD_SCHEMA = "shellx-motion/asset-record@1" as const;
export const CREATIVE_ASSET_LEDGER_SCHEMA = "shellx-motion/asset-ledger@1" as const;
export const CREATIVE_RUN_SCHEMA = "shellx-motion/creative-run@1" as const;
export const REVIEW_DECISION_SCHEMA = "shellx-motion/review-decision@1" as const;
export const CREATIVE_COMPILE_READINESS_SCHEMA = "shellx-motion/creative-compile-readiness@1" as const;

export const MAX_CREATIVE_CONTRACT_BYTES = 512 * 1024;
export const MAX_CREATIVE_CONTRACT_NODES = 512;
export const MAX_CREATIVE_CONTRACT_DEPTH = 8;
export const MAX_CREATIVE_RECORD_FIELDS = 16;
export const MAX_CREATIVE_SHOTS = 16;
export const MAX_CREATIVE_ACTIONS = 64;
export const MAX_CREATIVE_ASSET_SLOTS = 32;
export const MAX_CREATIVE_ASSETS = 64;
export const MAX_CREATIVE_REVIEW_FINDINGS = 32;
export const MAX_CREATIVE_REVISION_ATTEMPTS = 8;
export const MAX_CREATIVE_SHOT_DURATION_US = 600_000_000;
export const MAX_CREATIVE_ASSET_BYTES = 1_073_741_824;

export type CreativeActorKind = "human" | "ai" | "policy";
export type CreativeAssetKind = "image" | "video" | "audio" | "font" | "vector" | "data";
export type CreativeAssetOriginKind = "user-provided" | "generated" | "licensed" | "package-local";
export type CreativeAssetRightsStatus = "asserted" | "cleared" | "restricted" | "unknown";
export type CreativeAssetAvailability = "available" | "revoked";
export type ShotPlanApprovalStatus = "proposed" | "approved" | "rejected";
export type CreativeRunStatus = "planned" | "revision_required" | "accepted" | "rejected" | "cancelled";
export type CreativeReviewOutcome = "accepted" | "changes_requested" | "rejected";
export type CreativeFindingSeverity = "info" | "warning" | "error";

export interface CreativeIdentity { readonly id: string; readonly sha256: string }
export interface CreativeActor { readonly kind: CreativeActorKind; readonly id: string }
export interface CreativeBrief {
  readonly schema: typeof CREATIVE_BRIEF_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly revision: number;
  readonly parentRevision?: CreativeIdentity;
  readonly createdAt: string;
  readonly author: CreativeActor;
  readonly prompt: string;
  readonly goals: readonly string[];
  readonly constraints: readonly string[];
  readonly referenceAssetIds: readonly string[];
}
export interface CreativeBriefDescriptor {
  readonly createdAt: string;
  readonly author: CreativeActor;
  readonly prompt: string;
  readonly goals: readonly string[];
  readonly constraints: readonly string[];
  readonly referenceAssetIds?: readonly string[];
  readonly parent?: CreativeBrief;
}

export interface ShotAssetSlot {
  readonly id: string;
  readonly kind: CreativeAssetKind;
  readonly required: boolean;
  /** "asserted" accepts asserted or cleared; "cleared" accepts only cleared evidence. */
  readonly minimumRights: "asserted" | "cleared";
  readonly allowedOrigins: readonly CreativeAssetOriginKind[];
}
export interface ShotPlanShot {
  readonly id: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly purpose: string;
  /** Opaque action ids only. C4 owns registry resolution and authoring semantics. */
  readonly actionIds: readonly string[];
  readonly assetSlots: readonly ShotAssetSlot[];
}
export interface ShotPlanBudget { readonly actionLimit: number; readonly revisionLimit: number }
export type ShotPlanApproval =
  | { readonly status: "proposed" }
  | { readonly status: "approved" | "rejected"; readonly decidedBy: CreativeActor; readonly decidedAt: string; readonly reason: string };
export interface ShotPlan {
  readonly schema: typeof SHOT_PLAN_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly revision: number;
  readonly parentRevision?: CreativeIdentity;
  readonly createdAt: string;
  readonly brief: CreativeIdentity;
  readonly capabilityIds: readonly string[];
  readonly shots: readonly ShotPlanShot[];
  readonly budget: ShotPlanBudget;
  readonly approval: ShotPlanApproval;
}
export interface ShotPlanDescriptor {
  readonly brief: CreativeBrief;
  readonly createdAt: string;
  readonly capabilityIds: readonly string[];
  readonly shots: readonly ShotPlanShot[];
  readonly budget: ShotPlanBudget;
  readonly parent?: ShotPlan;
}

export interface CreativeAssetOrigin {
  readonly kind: CreativeAssetOriginKind;
  /** Opaque provenance handle, never a provider-local path or command. */
  readonly reference: string;
  readonly capturedAt: string;
}
export interface CreativeAssetRights {
  readonly status: CreativeAssetRightsStatus;
  readonly statement: string;
  readonly evidenceSha256?: string;
}
export interface CreativeAssetLineage {
  readonly parentAssetIds: readonly string[];
  readonly transformation: string;
}
export interface AssetRecord {
  readonly schema: typeof ASSET_RECORD_SCHEMA;
  /** Stable content identity; rights/availability changes mint a new record hash. */
  readonly id: string;
  readonly sha256: string;
  readonly kind: CreativeAssetKind;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly origin: CreativeAssetOrigin;
  readonly rights: CreativeAssetRights;
  readonly lineage: CreativeAssetLineage;
  readonly availability: CreativeAssetAvailability;
}
export interface AssetRecordDescriptor {
  readonly kind: CreativeAssetKind;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly origin: CreativeAssetOrigin;
  readonly rights: CreativeAssetRights;
  readonly lineage?: CreativeAssetLineage;
  readonly availability: CreativeAssetAvailability;
}
export interface CreativeAssetLedger {
  readonly schema: typeof CREATIVE_ASSET_LEDGER_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly revision: number;
  readonly parentRevision?: CreativeIdentity;
  readonly createdAt: string;
  readonly brief: CreativeIdentity;
  readonly assets: readonly AssetRecord[];
}
export interface CreativeAssetLedgerDescriptor {
  readonly brief: CreativeBrief;
  readonly createdAt: string;
  readonly assets: readonly AssetRecord[];
  readonly parent?: CreativeAssetLedger;
}

export interface CreativeAssetBinding {
  readonly shotId: string;
  readonly slotId: string;
  readonly assetId: string;
  /** Binds a slot to the immutable AssetRecord revision, not content identity alone. */
  readonly assetRecordSha256: string;
}
export interface CreativeRun {
  readonly schema: typeof CREATIVE_RUN_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly revision: number;
  readonly parentRevision?: CreativeIdentity;
  /** Separately capped so review cycles cannot grow unbounded. */
  readonly attempt: number;
  readonly createdAt: string;
  readonly brief: CreativeIdentity;
  readonly shotPlan: CreativeIdentity;
  readonly assetLedger: CreativeIdentity;
  readonly assetBindings: readonly CreativeAssetBinding[];
  readonly status: CreativeRunStatus;
}
export interface CreativeRunDescriptor {
  readonly brief: CreativeBrief;
  readonly shotPlan: ShotPlan;
  readonly assetLedger: CreativeAssetLedger;
  readonly createdAt: string;
  readonly assetBindings: readonly CreativeAssetBinding[];
}

export interface CreativeReviewRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface CreativeReviewFinding {
  readonly id: string;
  readonly severity: CreativeFindingSeverity;
  readonly code: string;
  readonly message: string;
  /** Optional shot/frame/region context; evidence, never a deterministic metric. */
  readonly shotId?: string;
  readonly atUs?: number;
  readonly region?: CreativeReviewRegion;
}
export interface ReviewDecision {
  readonly schema: typeof REVIEW_DECISION_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly createdAt: string;
  readonly run: CreativeIdentity;
  readonly reviewer: CreativeActor;
  readonly outcome: CreativeReviewOutcome;
  readonly findings: readonly CreativeReviewFinding[];
}
export interface ReviewDecisionDescriptor {
  readonly run: CreativeRun;
  readonly shotPlan: ShotPlan;
  readonly createdAt: string;
  readonly reviewer: CreativeActor;
  readonly outcome: CreativeReviewOutcome;
  readonly findings: readonly CreativeReviewFinding[];
}

export interface CreativeCompileReadiness {
  readonly schema: typeof CREATIVE_COMPILE_READINESS_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly run: CreativeIdentity;
  readonly shotPlan: CreativeIdentity;
  readonly assetLedger: CreativeIdentity;
  readonly bindings: readonly CreativeAssetBinding[];
}
export interface CreativeCompileIssue { readonly path: string; readonly code: string; readonly message: string }
export type CreativeCompileReadinessResult =
  | { readonly ok: true; readonly readiness: CreativeCompileReadiness }
  | { readonly ok: false; readonly issues: readonly CreativeCompileIssue[] };
