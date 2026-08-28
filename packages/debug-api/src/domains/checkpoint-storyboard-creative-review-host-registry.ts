/** Private host-registry parser for C6C B1c creative-review authority. */
import { createHmac } from "node:crypto";
import { canonicalJson } from "@shellx-motion/core";
import {
  applyReviewDecisionToCreativeRun,
  readCreativeAssetLedger,
  readCreativeBrief,
  readCreativeRun,
  readReviewDecision,
  readShotPlan,
  type CreativeActor,
} from "./creative-contract/creative-contract.js";
import {
  readIdentity,
  type CheckpointStoryboardRecordIdentity,
} from "./checkpoint-storyboard-record-store-types.js";

const PREVIEW_HANDLE = /^checkpoint_storyboard_preview_[a-f0-9]{32}$/u;
const RECEIPT_HANDLE = /^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$/u;
const HOST_AUTH_EVIDENCE_ID = /^host_creative_authentication_[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

type HostAuthenticatedActor = Readonly<{
  kind: "human" | "policy";
  id: string;
}>;
type HostAuthenticationAttestation = Readonly<{
  actor: HostAuthenticatedActor;
  id: string;
  sha256: string;
}>;
export type HostCreativeReviewRegistration = Readonly<{
  /** Exact host-reopened C6 identity/root; a review handle cannot cross lineages. */
  record: Readonly<{
    identity: CheckpointStoryboardRecordIdentity;
    root: CheckpointStoryboardRecordIdentity;
  }>;
  /** Existing B1b HMAC handles that this host registration was minted for. */
  preview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  /** Host-only raw records. They are verified, summarized, and never command input. */
  creative: Readonly<{
    brief: unknown;
    shotPlan: unknown;
    assetLedger: unknown;
    run: unknown;
    reviewDecision: unknown;
    shotId: string;
  }>;
  authentication: Readonly<{
    shotPlanApprover: HostAuthenticationAttestation;
    reviewDecisionReviewer: HostAuthenticationAttestation;
  }>;
}>;
export type ResolvedHostCreativeReview = Readonly<{
  record: Readonly<{
    identity: CheckpointStoryboardRecordIdentity;
    root: CheckpointStoryboardRecordIdentity;
  }>;
  preview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  creative: Readonly<{
    brief: Readonly<{ id: string; sha256: string }>;
    shotPlan: Readonly<{ id: string; sha256: string }>;
    assetLedger: Readonly<{ id: string; sha256: string }>;
    run: Readonly<{ id: string; sha256: string }>;
    reviewDecision: Readonly<{ id: string; sha256: string }>;
    outcome: "accepted" | "changes_requested" | "rejected";
    derivedRunId: string;
    selectedShot: Readonly<{ id: string; startUs: number; durationUs: number }>;
    findings: readonly Readonly<{ shotId?: string; atUs?: number }> [];
  }>;
  authentication: Readonly<{
    shotPlanApprover: HostAuthenticatedActor;
    reviewDecisionReviewer: HostAuthenticatedActor;
    authenticationDigest: string;
    handleDigest: string;
  }>;
}>;

export function readHostCreativeReviewRegistration(
  value: unknown,
  handle: string,
  integrityKey: Uint8Array,
  storeBinding: string,
  allowPolicyActors: boolean,
): ResolvedHostCreativeReview {
  const record = exact(value, ["record", "preview", "creative", "authentication"]);
  const recordBinding = exact(record.record, ["identity", "root"]);
  const identity = readIdentity(recordBinding.identity, "Checkpoint storyboard creative-review registered identity");
  const root = readIdentity(recordBinding.root, "Checkpoint storyboard creative-review registered root");
  const preview = exact(record.preview, ["previewHandle", "receiptHandle"]);
  if (typeof preview.previewHandle !== "string" || !PREVIEW_HANDLE.test(preview.previewHandle) || typeof preview.receiptHandle !== "string" || !RECEIPT_HANDLE.test(preview.receiptHandle))
    throw new Error("Checkpoint storyboard creative-review registered B1b handles are invalid.");
  const creative = exact(record.creative, ["brief", "shotPlan", "assetLedger", "run", "reviewDecision", "shotId"]);
  if (typeof creative.shotId !== "string" || !SHOT_ID.test(creative.shotId))
    throw new Error("Checkpoint storyboard creative-review registered shot scope is invalid.");
  const brief = readCreativeBrief(creative.brief);
  const shotPlan = readShotPlan(creative.shotPlan);
  const assetLedger = readCreativeAssetLedger(creative.assetLedger);
  const run = readCreativeRun(creative.run);
  const decision = readReviewDecision(creative.reviewDecision);
  const creativeIdentity = (entry: { id: string; sha256: string }) => Object.freeze({ id: entry.id, sha256: entry.sha256 });
  if (shotPlan.approval.status !== "approved")
    throw new Error("Checkpoint storyboard creative-review host registration requires an approved ShotPlan.");
  if (!sameCreativeIdentity(shotPlan.brief, creativeIdentity(brief)) || !sameCreativeIdentity(assetLedger.brief, creativeIdentity(brief)) || !sameCreativeIdentity(run.brief, creativeIdentity(brief)) || !sameCreativeIdentity(run.shotPlan, creativeIdentity(shotPlan)) || !sameCreativeIdentity(run.assetLedger, creativeIdentity(assetLedger)) || run.status !== "planned" || !sameCreativeIdentity(decision.run, creativeIdentity(run)))
    throw new Error("Checkpoint storyboard creative-review host records do not form one exact sealed join.");
  if (decision.outcome !== "accepted" && decision.findings.length === 0)
    throw new Error("Checkpoint storyboard creative-review nonaccepted decision requires one finding.");
  const selectedShot = shotPlan.shots.find((shot) => shot.id === creative.shotId);
  if (!selectedShot)
    throw new Error("Checkpoint storyboard creative-review host registration selected shot is absent from its sealed ShotPlan.");
  if (decision.findings.some((finding) => finding.shotId !== selectedShot.id || !Number.isSafeInteger(finding.atUs) || (finding.atUs ?? -1) < selectedShot.startUs || (finding.atUs ?? Number.MAX_SAFE_INTEGER) >= selectedShot.startUs + selectedShot.durationUs))
    throw new Error("Checkpoint storyboard creative-review findings must name the selected sealed shot and one in-shot time.");
  const approvalActor = readAuthenticatedRecordActor(shotPlan.approval.decidedBy, "Checkpoint storyboard creative-review ShotPlan approver", allowPolicyActors);
  const reviewerActor = readAuthenticatedRecordActor(decision.reviewer, "Checkpoint storyboard creative-review ReviewDecision reviewer", allowPolicyActors);
  const authentication = exact(record.authentication, ["shotPlanApprover", "reviewDecisionReviewer"]);
  const approverAttestation = readHostAttestation(authentication.shotPlanApprover, "Checkpoint storyboard creative-review ShotPlan approver authentication", allowPolicyActors);
  const reviewerAttestation = readHostAttestation(authentication.reviewDecisionReviewer, "Checkpoint storyboard creative-review ReviewDecision reviewer authentication", allowPolicyActors);
  if (!sameActor(approvalActor, approverAttestation.actor) || !sameActor(reviewerActor, reviewerAttestation.actor))
    throw new Error("Checkpoint storyboard creative-review host role attestations must match the sealed ShotPlan approver and ReviewDecision reviewer exactly.");
  const derived = applyReviewDecisionToCreativeRun(run, decision);
  const authenticationDigest = keyedDigest(integrityKey, storeBinding, "authentication", {
    identity, root, preview: { previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle },
    shotPlanApprover: approverAttestation, reviewDecisionReviewer: reviewerAttestation,
  });
  const handleDigest = keyedDigest(integrityKey, storeBinding, "handle", { handle, authenticationDigest });
  return Object.freeze({
    record: Object.freeze({ identity, root }),
    preview: Object.freeze({ previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }),
    creative: Object.freeze({
      brief: creativeIdentity(brief), shotPlan: creativeIdentity(shotPlan), assetLedger: creativeIdentity(assetLedger),
      run: creativeIdentity(run), reviewDecision: creativeIdentity(decision), outcome: decision.outcome, derivedRunId: derived.id,
      selectedShot: Object.freeze({ id: selectedShot.id, startUs: selectedShot.startUs, durationUs: selectedShot.durationUs }),
      findings: Object.freeze(decision.findings.map((finding) => Object.freeze({ ...(finding.shotId ? { shotId: finding.shotId } : {}), ...(finding.atUs !== undefined ? { atUs: finding.atUs } : {}) }))),
    }),
    authentication: Object.freeze({ shotPlanApprover: approvalActor, reviewDecisionReviewer: reviewerActor, authenticationDigest, handleDigest }),
  });
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkpoint storyboard creative-review host registry entry must be a plain object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)) || keys.some((key) => !fields.includes(key)))
    throw new Error("Checkpoint storyboard creative-review host registry fields are invalid.");
  return record;
}

function readAuthenticatedRecordActor(value: CreativeActor, label: string, allowPolicyActors: boolean): HostAuthenticatedActor {
  if ((value.kind !== "human" && (value.kind !== "policy" || !allowPolicyActors)) || !ACTOR_ID.test(value.id))
    throw new Error(`${label} must be a human actor; policy is permitted only by explicit host opt-in.`);
  return Object.freeze({ kind: value.kind, id: value.id });
}

function readHostAttestation(value: unknown, label: string, allowPolicyActors: boolean): HostAuthenticationAttestation {
  const record = exact(value, ["actor", "id", "sha256"]);
  if (typeof record.id !== "string" || !HOST_AUTH_EVIDENCE_ID.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || record.id !== `host_creative_authentication_${record.sha256.slice(0, 32)}`)
    throw new Error(`${label} identity is invalid.`);
  const actorRecord = exact(record.actor, ["kind", "id"]);
  if ((actorRecord.kind !== "human" && (actorRecord.kind !== "policy" || !allowPolicyActors)) || typeof actorRecord.id !== "string" || !ACTOR_ID.test(actorRecord.id))
    throw new Error(`${label} actor is invalid.`);
  return Object.freeze({ actor: Object.freeze({ kind: actorRecord.kind, id: actorRecord.id }), id: record.id, sha256: record.sha256 });
}

function sameCreativeIdentity(left: Readonly<{ id: string; sha256: string }>, right: Readonly<{ id: string; sha256: string }>): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

function sameActor(left: HostAuthenticatedActor, right: HostAuthenticatedActor): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function keyedDigest(integrityKey: Uint8Array, storeBinding: string, label: string, value: unknown): string {
  return createHmac("sha256", integrityKey).update(`checkpoint-storyboard-creative-review-${label}@1\0`).update(storeBinding).update("\0").update(canonicalJson(value)).digest("hex");
}
