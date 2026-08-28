/** Host-registry parser for one authenticated B7 arbitrary-time review decision. */
import { createHash, createHmac } from "node:crypto";
import { canonicalJson } from "@shellx-motion/core";
import { readIdentity, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

const PREVIEW_HANDLE = /^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/u;
const RECEIPT_HANDLE = /^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$/u;
const DECISION_ID = /^checkpoint_storyboard_retained_trace_review_decision_[a-f0-9]{32}$/u;
const AUTH_ID = /^host_retained_trace_review_authentication_[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type RetainedTraceReviewActor = Readonly<{ kind: "human" | "policy"; id: string }>;
export type HostRetainedTraceReviewRegistration = Readonly<{
  record: Readonly<{ identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity }>;
  preview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  decision: unknown;
  authentication: Readonly<{ reviewer: Readonly<{ actor: RetainedTraceReviewActor; id: string; sha256: string }> }>;
}>;
export type ResolvedHostRetainedTraceReview = Readonly<{
  record: Readonly<{ identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity }>;
  preview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  decision: Readonly<{ id: string; sha256: string; outcome: "accepted" | "changes_requested" | "rejected" }>;
  reviewer: RetainedTraceReviewActor;
  authenticationDigest: string;
  handleDigest: string;
}>;

export function readHostRetainedTraceReviewRegistration(value: unknown, handle: string, integrityKey: Uint8Array, storeBinding: string, allowPolicyActors: boolean): ResolvedHostRetainedTraceReview {
  const record = exact(value, ["record", "preview", "decision", "authentication"], "retained-trace review registration");
  const recordBinding = exact(record.record, ["identity", "root"], "retained-trace review record binding");
  const identity = readIdentity(recordBinding.identity, "Checkpoint storyboard retained-trace review registered identity");
  const root = readIdentity(recordBinding.root, "Checkpoint storyboard retained-trace review registered root");
  const preview = exact(record.preview, ["previewHandle", "receiptHandle"], "retained-trace review preview");
  if (typeof preview.previewHandle !== "string" || !PREVIEW_HANDLE.test(preview.previewHandle) || typeof preview.receiptHandle !== "string" || !RECEIPT_HANDLE.test(preview.receiptHandle)) throw new Error("Checkpoint storyboard retained-trace review registered preview handles are invalid.");
  const decision = readDecision(record.decision, allowPolicyActors);
  const authentication = exact(record.authentication, ["reviewer"], "retained-trace review authentication");
  const attestation = readAttestation(authentication.reviewer, allowPolicyActors);
  if (decision.reviewer.kind !== attestation.actor.kind || decision.reviewer.id !== attestation.actor.id) throw new Error("Checkpoint storyboard retained-trace review attestation must match its sealed decision reviewer.");
  const authenticationDigest = keyedDigest(integrityKey, storeBinding, "authentication", { identity, root, preview, decision: { id: decision.id, sha256: decision.sha256 }, reviewer: attestation });
  const handleDigest = keyedDigest(integrityKey, storeBinding, "handle", { handle, authenticationDigest });
  return Object.freeze({
    record: Object.freeze({ identity, root }),
    preview: Object.freeze({ previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }),
    decision: Object.freeze({ id: decision.id, sha256: decision.sha256, outcome: decision.outcome }),
    reviewer: decision.reviewer,
    authenticationDigest,
    handleDigest,
  });
}

function readDecision(value: unknown, allowPolicyActors: boolean) {
  const record = exact(value, ["schema", "id", "sha256", "outcome", "reviewer"], "retained-trace review decision");
  const outcome = record.outcome;
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-retained-trace-review-decision@1" || typeof record.id !== "string" || !DECISION_ID.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || (outcome !== "accepted" && outcome !== "changes_requested" && outcome !== "rejected")) throw new Error("Checkpoint storyboard retained-trace review decision is invalid.");
  const reviewer = readActor(record.reviewer, allowPolicyActors);
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-review-decision@1" as const, outcome: outcome as "accepted" | "changes_requested" | "rejected", reviewer };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (record.sha256 !== sha256 || record.id !== `checkpoint_storyboard_retained_trace_review_decision_${sha256.slice(0, 32)}`) throw new Error("Checkpoint storyboard retained-trace review decision identity is invalid.");
  return Object.freeze({ ...payload, id: record.id, sha256, reviewer });
}

function readAttestation(value: unknown, allowPolicyActors: boolean) {
  const record = exact(value, ["actor", "id", "sha256"], "retained-trace review authentication attestation");
  if (typeof record.id !== "string" || !AUTH_ID.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || record.id !== `host_retained_trace_review_authentication_${record.sha256.slice(0, 32)}`) throw new Error("Checkpoint storyboard retained-trace review authentication identity is invalid.");
  return Object.freeze({ actor: readActor(record.actor, allowPolicyActors), id: record.id, sha256: record.sha256 });
}

function readActor(value: unknown, allowPolicyActors: boolean): RetainedTraceReviewActor {
  const actor = exact(value, ["kind", "id"], "retained-trace review actor");
  if ((actor.kind !== "human" && (actor.kind !== "policy" || !allowPolicyActors)) || typeof actor.id !== "string" || !ACTOR_ID.test(actor.id)) throw new Error("Checkpoint storyboard retained-trace reviewer must be an authenticated human unless policy review is explicitly enabled.");
  return Object.freeze({ kind: actor.kind, id: actor.id });
}

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Checkpoint storyboard ${label} must be a plain object.`);
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)) || keys.some((key) => !fields.includes(key))) throw new Error(`Checkpoint storyboard ${label} fields are invalid.`);
  return record;
}
function keyedDigest(key: Uint8Array, storeBinding: string, label: string, value: unknown): string { return createHmac("sha256", key).update(`checkpoint-storyboard-retained-trace-review-${label}@1\0`).update(storeBinding).update("\0").update(canonicalJson(value)).digest("hex"); }
