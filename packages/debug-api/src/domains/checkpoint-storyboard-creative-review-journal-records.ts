/** Private B1c append-only journal entry constructors and strict parsers. */
import { createHash } from "node:crypto";
import { canonicalJson } from "@shellx-motion/core";
import { COMPLETE_PREFIX, INTENT_PREFIX, MAX_BINDINGS_PER_LINEAGE, MEMBER_PREFIX, SHA256, type CreativeReviewCompletion, type CreativeReviewIntent, type CreativeReviewMember, type CreativeReviewMemberHead, type StoredBinding } from "./checkpoint-storyboard-creative-review-types.js";
import { exact, readIdentity, storeError, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

export function createIntent(root: CheckpointStoryboardRecordIdentity, binding: StoredBinding): CreativeReviewIntent {
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-creative-review-intent@1" as const, root, identity: binding.identity, binding: Object.freeze({ id: binding.id, sha256: binding.sha256 }) };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return Object.freeze({ ...payload, id: `${INTENT_PREFIX}${sha256.slice(0, 32)}`, sha256 });
}

export function createCompletion(root: CheckpointStoryboardRecordIdentity, binding: StoredBinding, member: CreativeReviewMember): CreativeReviewCompletion {
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-creative-review-complete@1" as const, root, identity: binding.identity, binding: Object.freeze({ id: binding.id, sha256: binding.sha256 }), member: Object.freeze({ id: member.id, sha256: member.sha256 }) };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return Object.freeze({ ...payload, id: `${COMPLETE_PREFIX}${sha256.slice(0, 32)}`, sha256 });
}

export function createMember(root: CheckpointStoryboardRecordIdentity, binding: StoredBinding, ordinal: number, previous?: CreativeReviewMember): CreativeReviewMember {
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member@1" as const, root, identity: binding.identity, ordinal, binding: Object.freeze({ id: binding.id, sha256: binding.sha256 }), ...(previous ? { previous: Object.freeze({ id: previous.id, sha256: previous.sha256 }) } : {}) };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return Object.freeze({ ...payload, id: `${MEMBER_PREFIX}${sha256.slice(0, 32)}`, sha256 });
}

export function readIntent(value: unknown): CreativeReviewIntent {
  const record = exact(value, ["schema", "id", "sha256", "root", "identity", "binding"], "Checkpoint storyboard creative-review intent");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review-intent@1" || typeof record.id !== "string" || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || record.id !== `${INTENT_PREFIX}${record.sha256.slice(0, 32)}`) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review intent identity is invalid.");
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-creative-review-intent@1" as const, root: readIdentity(record.root, "Checkpoint storyboard creative-review intent root"), identity: readIdentity(record.identity, "Checkpoint storyboard creative-review intent identity"), binding: readReference(record.binding, "Checkpoint storyboard creative-review intent final binding", "checkpoint_storyboard_creative_review_") };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (sha256 !== record.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review intent canonical identity is stale.");
  return Object.freeze({ ...payload, id: record.id, sha256 });
}

export function readCompletion(value: unknown): CreativeReviewCompletion {
  const record = exact(value, ["schema", "id", "sha256", "root", "identity", "binding", "member"], "Checkpoint storyboard creative-review completion");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review-complete@1" || typeof record.id !== "string" || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || record.id !== `${COMPLETE_PREFIX}${record.sha256.slice(0, 32)}`) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review completion identity is invalid.");
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-creative-review-complete@1" as const, root: readIdentity(record.root, "Checkpoint storyboard creative-review completion root"), identity: readIdentity(record.identity, "Checkpoint storyboard creative-review completion identity"), binding: readReference(record.binding, "Checkpoint storyboard creative-review completion final binding", "checkpoint_storyboard_creative_review_"), member: readReference(record.member, "Checkpoint storyboard creative-review completion member", MEMBER_PREFIX) };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (sha256 !== record.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review completion canonical identity is stale.");
  return Object.freeze({ ...payload, id: record.id, sha256 });
}

export function readMember(value: unknown): CreativeReviewMember {
  const record = exact(value, ["schema", "id", "sha256", "root", "identity", "ordinal", "binding"], ["previous"], "Checkpoint storyboard creative-review member");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review-member@1" || typeof record.id !== "string" || !record.id.startsWith(MEMBER_PREFIX) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || record.id !== `${MEMBER_PREFIX}${record.sha256.slice(0, 32)}` || !Number.isSafeInteger(record.ordinal) || (record.ordinal as number) < 1 || (record.ordinal as number) > MAX_BINDINGS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review member identity is invalid.");
  const previous = Object.hasOwn(record, "previous") ? readReference(record.previous, "Checkpoint storyboard creative-review previous member", MEMBER_PREFIX) : undefined;
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member@1" as const, root: readIdentity(record.root, "Checkpoint storyboard creative-review member root"), identity: readIdentity(record.identity, "Checkpoint storyboard creative-review member identity"), ordinal: record.ordinal as number, binding: readReference(record.binding, "Checkpoint storyboard creative-review member final binding", "checkpoint_storyboard_creative_review_"), ...(previous ? { previous } : {}) };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (sha256 !== record.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review member canonical identity is stale.");
  return Object.freeze({ ...payload, id: record.id, sha256 });
}

export function readMemberHead(value: unknown): CreativeReviewMemberHead {
  const record = exact(value, ["schema", "root", "ordinal", "member", "phase"], "Checkpoint storyboard creative-review member head");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review-member-head@1" || !Number.isSafeInteger(record.ordinal) || (record.ordinal as number) < 1 || (record.ordinal as number) > MAX_BINDINGS_PER_LINEAGE || (record.phase !== "preparing" && record.phase !== "complete")) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review member head is invalid.");
  return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-creative-review-member-head@1" as const, root: readIdentity(record.root, "Checkpoint storyboard creative-review head root"), ordinal: record.ordinal as number, member: readReference(record.member, "Checkpoint storyboard creative-review head member", MEMBER_PREFIX), phase: record.phase });
}

function readReference(value: unknown, label: string, prefix: string): Readonly<{ id: string; sha256: string }> {
  const record = exact(value, ["id", "sha256"], label);
  if (typeof record.id !== "string" || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || record.id !== `${prefix}${record.sha256.slice(0, 32)}`) throw storeError("store_integrity_failed", `${label} is invalid.`);
  return Object.freeze({ id: record.id, sha256: record.sha256 });
}
