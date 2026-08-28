/** Signed, append-only B7 arbitrary-time review journal. */
import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { findLineageRetainedTraceReviewsDirectory, lineageRetainedTraceReviewsDirectory } from "./checkpoint-storyboard-retained-trace-review-store.js";
import { readSignedFile, writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { exact, readIdentity, sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

export const MAX_RETAINED_TRACE_REVIEWS_PER_LINEAGE = 128;
export const MAX_RETAINED_TRACE_REVIEW_BYTES = 96 * 1024;
const PREVIEW_ID = /^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/u;
const BINDING_ID = /^checkpoint_storyboard_retained_trace_review_[a-f0-9]{32}$/u;
const INTENT_ID = /^checkpoint_storyboard_retained_trace_review_intent_[a-f0-9]{32}$/u;
const COMPLETE_ID = /^checkpoint_storyboard_retained_trace_review_complete_[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FILE = /^(checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32})\.review(?:\.(intent|complete))?\.json$/u;
type Ref = Readonly<{ id: string; sha256: string }>;
type FileEvidence = Readonly<{ sha256: string; byteLength: number }>;

export type RetainedTraceReviewBinding = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-review@1";
  id: string;
  sha256: string;
  identity: CheckpointStoryboardRecordIdentity;
  root: CheckpointStoryboardRecordIdentity;
  storyboard: Readonly<{ id: string; sha256: string; revision: number }>;
  recipe: Readonly<{ id: string; sha256: string; revision: number; recipeId: string }>;
  resolution: Readonly<{ bindingId: string; bindingSha256: string; outputHandle: string; receiptFingerprint: string; planFingerprint: string; profileFingerprint: string; tracePlanFingerprint: string; scheduleSha256: string }>;
  materialization: Readonly<{
    package: Readonly<{ id: string; manifestRawSha256: string; manifestCanonicalSha256: string; motionRawSha256: string; motionCanonicalSha256: string; inventory: Readonly<{ sha256: string; entryCount: number; leafCount: number }> }>;
    sidecar: Readonly<{ path: "analysis/checkpoint-storyboard/parametric-trace.plan.json"; rawSha256: string; canonicalSha256: string; byteLength: number }>;
  }>;
  frame: Readonly<{ stateId: string; atUs: number; receipt: FileEvidence; png: FileEvidence & Readonly<{ width: number; height: number }>; runtimeEvidence: "host-gpu" | "source-test"; previewHandleDigest: string }>;
  review: Readonly<{ decision: Readonly<{ id: string; sha256: string; outcome: "accepted" | "changes_requested" | "rejected" }>; reviewer: Readonly<{ kind: "human" | "policy"; id: string }>; authenticationDigest: string; handleDigest: string }>;
}>;
export type RetainedTraceReviewIntent = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-review-intent@1"; id: string; sha256: string; root: CheckpointStoryboardRecordIdentity; identity: CheckpointStoryboardRecordIdentity; stateId: string; binding: Ref }>;
export type RetainedTraceReviewCompletion = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-review-complete@1"; id: string; sha256: string; root: CheckpointStoryboardRecordIdentity; identity: CheckpointStoryboardRecordIdentity; stateId: string; binding: Ref; intent: Ref }>;
export type RetainedTraceReviewJournal = Readonly<{ bindings: readonly RetainedTraceReviewBinding[]; pending?: Readonly<{ intent: RetainedTraceReviewIntent; binding?: RetainedTraceReviewBinding }> }>;

export function createRetainedTraceReviewBinding(input: Omit<RetainedTraceReviewBinding, "schema" | "id" | "sha256">): RetainedTraceReviewBinding { return seal("checkpoint_storyboard_retained_trace_review_", "shellx-motion/private-checkpoint-storyboard-retained-trace-review@1", input) as RetainedTraceReviewBinding; }
export function createRetainedTraceReviewIntent(root: CheckpointStoryboardRecordIdentity, binding: RetainedTraceReviewBinding): RetainedTraceReviewIntent { return seal("checkpoint_storyboard_retained_trace_review_intent_", "shellx-motion/private-checkpoint-storyboard-retained-trace-review-intent@1", { root, identity: binding.identity, stateId: binding.frame.stateId, binding: ref(binding) }) as RetainedTraceReviewIntent; }
export function createRetainedTraceReviewCompletion(intent: RetainedTraceReviewIntent, binding: RetainedTraceReviewBinding): RetainedTraceReviewCompletion { return seal("checkpoint_storyboard_retained_trace_review_complete_", "shellx-motion/private-checkpoint-storyboard-retained-trace-review-complete@1", { root: intent.root, identity: intent.identity, stateId: intent.stateId, binding: ref(binding), intent: ref(intent) }) as RetainedTraceReviewCompletion; }

export async function publishRetainedTraceReviewIntent(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, value: RetainedTraceReviewIntent): Promise<void> { await publish(facts, root, value.stateId, "intent", value); }
export async function publishRetainedTraceReviewBinding(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, value: RetainedTraceReviewBinding): Promise<void> { await publish(facts, root, value.frame.stateId, "binding", value); }
export async function publishRetainedTraceReviewCompletion(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, value: RetainedTraceReviewCompletion): Promise<void> { await publish(facts, root, value.stateId, "complete", value); }

export async function readRetainedTraceReviewJournal(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<RetainedTraceReviewJournal> {
  const directory = await findLineageRetainedTraceReviewsDirectory(facts, root.id);
  if (!directory) return Object.freeze({ bindings: Object.freeze([]) });
  const intents = new Map<string, RetainedTraceReviewIntent>(), bindings = new Map<string, RetainedTraceReviewBinding>(), completions = new Map<string, RetainedTraceReviewCompletion>();
  const entries = await opendir(directory.path); let count = 0;
  try {
    for await (const entry of entries) {
      if (++count > MAX_RETAINED_TRACE_REVIEWS_PER_LINEAGE * 3 || !entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review journal exceeds its bounded file inventory.");
      const match = FILE.exec(entry.name);
      if (!match) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review journal contains an unsupported entry.");
      const stateId = match[1]!, kind = match[2] === "intent" ? "intent" : match[2] === "complete" ? "complete" : "binding";
      const raw = await readSignedFile(join(directory.path, entry.name), facts, MAX_RETAINED_TRACE_REVIEW_BYTES, "record_not_found");
      if (kind === "intent") intents.set(stateId, readIntent(raw));
      else if (kind === "complete") completions.set(stateId, readCompletion(raw));
      else bindings.set(stateId, readBinding(raw));
    }
  } finally { await entries.close().catch(() => undefined); }
  if (intents.size > MAX_RETAINED_TRACE_REVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review journal exceeds its association limit.");
  const completed: RetainedTraceReviewBinding[] = []; let pending: RetainedTraceReviewJournal["pending"];
  const ids = new Set([...intents.keys(), ...bindings.keys(), ...completions.keys()]);
  for (const stateId of [...ids].sort()) {
    const intent = intents.get(stateId), binding = bindings.get(stateId), completion = completions.get(stateId);
    if (!intent || !sameIdentity(intent.root, root) || intent.stateId !== stateId || (binding && (binding.frame.stateId !== stateId || !sameIdentity(binding.root, root) || !sameIdentity(binding.identity, intent.identity) || !sameRef(intent.binding, binding)))) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review journal does not form one exact intent and binding association.");
    if (completion) {
      if (!binding || completion.stateId !== stateId || !sameIdentity(completion.root, root) || !sameIdentity(completion.identity, intent.identity) || !sameRef(completion.intent, intent) || !sameRef(completion.binding, binding)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review completion does not close its exact publication.");
      completed.push(binding);
    } else {
      if (pending) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review journal has multiple unresolved publications.");
      pending = Object.freeze({ intent, ...(binding ? { binding } : {}) });
    }
  }
  return Object.freeze({ bindings: Object.freeze(completed), ...(pending ? { pending } : {}) });
}

function readBinding(value: unknown): RetainedTraceReviewBinding {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "storyboard", "recipe", "resolution", "materialization", "frame", "review"], "Retained-trace review binding");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-retained-trace-review@1") bad("binding schema");
  const identity = readIdentity(record.identity, "Retained-trace review identity"), root = readIdentity(record.root, "Retained-trace review root");
  const storyboard = exact(record.storyboard, ["id", "sha256", "revision"], "Retained-trace review storyboard"), recipe = exact(record.recipe, ["id", "sha256", "revision", "recipeId"], "Retained-trace review recipe");
  const resolution = exact(record.resolution, ["bindingId", "bindingSha256", "outputHandle", "receiptFingerprint", "planFingerprint", "profileFingerprint", "tracePlanFingerprint", "scheduleSha256"], "Retained-trace review resolution");
  const materialization = exact(record.materialization, ["package", "sidecar"], "Retained-trace review materialization"), pkg = exact(materialization.package, ["id", "manifestRawSha256", "manifestCanonicalSha256", "motionRawSha256", "motionCanonicalSha256", "inventory"], "Retained-trace review package"), inventory = exact(pkg.inventory, ["sha256", "entryCount", "leafCount"], "Retained-trace review inventory"), sidecar = exact(materialization.sidecar, ["path", "rawSha256", "canonicalSha256", "byteLength"], "Retained-trace review sidecar");
  const frame = exact(record.frame, ["stateId", "atUs", "receipt", "png", "runtimeEvidence", "previewHandleDigest"], "Retained-trace review frame"), receipt = readFile(frame.receipt, false), png = readFile(frame.png, true);
  const review = exact(record.review, ["decision", "reviewer", "authenticationDigest", "handleDigest"], "Retained-trace review host evidence"), decision = exact(review.decision, ["id", "sha256", "outcome"], "Retained-trace review decision"), reviewer = exact(review.reviewer, ["kind", "id"], "Retained-trace review reviewer");
  if (![storyboard.sha256, recipe.sha256, resolution.bindingSha256, resolution.receiptFingerprint, resolution.planFingerprint, resolution.profileFingerprint, resolution.tracePlanFingerprint, resolution.scheduleSha256, pkg.manifestRawSha256, pkg.manifestCanonicalSha256, pkg.motionRawSha256, pkg.motionCanonicalSha256, inventory.sha256, sidecar.rawSha256, sidecar.canonicalSha256, frame.previewHandleDigest, decision.sha256, review.authenticationDigest, review.handleDigest].every(hash)
    || !SAFE_ID.test(String(storyboard.id)) || !SAFE_ID.test(String(recipe.id)) || !SAFE_ID.test(String(recipe.recipeId)) || !SAFE_ID.test(String(pkg.id)) || !positiveRevision(storyboard.revision) || !positiveRevision(recipe.revision)
    || typeof resolution.bindingId !== "string" || !/^checkpoint_storyboard_retained_trace_resolution_binding_[a-f0-9]{32}$/u.test(resolution.bindingId) || typeof resolution.outputHandle !== "string" || !/^checkpoint_storyboard_retained_trace_output_[a-f0-9]{32}$/u.test(resolution.outputHandle)
    || !validInventory(inventory) || sidecar.path !== "analysis/checkpoint-storyboard/parametric-trace.plan.json" || !bounded(sidecar.byteLength, 1, 512 * 1024)
    || typeof frame.stateId !== "string" || !PREVIEW_ID.test(frame.stateId) || !bounded(frame.atUs, 0, 3_600_000_000) || (frame.runtimeEvidence !== "host-gpu" && frame.runtimeEvidence !== "source-test")
    || !validReviewDecision(decision, reviewer)) bad("binding facts");
  return checked(record, "checkpoint_storyboard_retained_trace_review_") as RetainedTraceReviewBinding;
}
function readIntent(value: unknown): RetainedTraceReviewIntent { const record = exact(value, ["schema", "id", "sha256", "root", "identity", "stateId", "binding"], "Retained-trace review intent"); if (record.schema !== "shellx-motion/private-checkpoint-storyboard-retained-trace-review-intent@1" || typeof record.stateId !== "string" || !PREVIEW_ID.test(record.stateId)) bad("intent"); readIdentity(record.root, "Retained-trace review intent root"); readIdentity(record.identity, "Retained-trace review intent identity"); readRef(record.binding, BINDING_ID); return checked(record, "checkpoint_storyboard_retained_trace_review_intent_") as RetainedTraceReviewIntent; }
function readCompletion(value: unknown): RetainedTraceReviewCompletion { const record = exact(value, ["schema", "id", "sha256", "root", "identity", "stateId", "binding", "intent"], "Retained-trace review completion"); if (record.schema !== "shellx-motion/private-checkpoint-storyboard-retained-trace-review-complete@1" || typeof record.stateId !== "string" || !PREVIEW_ID.test(record.stateId)) bad("completion"); readIdentity(record.root, "Retained-trace review completion root"); readIdentity(record.identity, "Retained-trace review completion identity"); readRef(record.binding, BINDING_ID); readRef(record.intent, INTENT_ID); return checked(record, "checkpoint_storyboard_retained_trace_review_complete_") as RetainedTraceReviewCompletion; }
function readFile(value: unknown, png: boolean): FileEvidence & { width?: number; height?: number } { const record = exact(value, png ? ["sha256", "byteLength", "width", "height"] : ["sha256", "byteLength"], `Retained-trace review ${png ? "PNG" : "receipt"}`); if (!hash(record.sha256) || !bounded(record.byteLength, 1, png ? 64 * 1024 * 1024 : 256 * 1024) || (png && (!bounded(record.width, 1, 16_384) || !bounded(record.height, 1, 16_384)))) bad("file evidence"); return Object.freeze(record) as FileEvidence & { width?: number; height?: number }; }
function readRef(value: unknown, pattern: RegExp): Ref { const record = exact(value, ["id", "sha256"], "Retained-trace review reference"); if (typeof record.id !== "string" || !pattern.test(record.id) || !hash(record.sha256) || !record.id.endsWith((record.sha256 as string).slice(0, 32))) bad("reference"); return Object.freeze({ id: record.id, sha256: record.sha256 as string }); }
function checked(record: Record<string, unknown>, prefix: string): object { if (typeof record.id !== "string" || typeof record.sha256 !== "string" || !HASH.test(record.sha256)) bad("deterministic identity"); const payload = { ...record }; delete payload.id; delete payload.sha256; const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex"); if (record.sha256 !== sha256 || record.id !== `${prefix}${sha256.slice(0, 32)}`) bad("deterministic identity"); return deepFreeze(structuredClone(record)); }
async function publish(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, stateId: string, kind: "intent" | "binding" | "complete", value: object): Promise<void> { const directory = await lineageRetainedTraceReviewsDirectory(facts, root.id), suffix = kind === "binding" ? "" : `.${kind}`; const path = join(directory.path, `${stateId}.review${suffix}.json`); try { await writeExclusiveSignedFile(path, value, facts, MAX_RETAINED_TRACE_REVIEW_BYTES); } catch (error) { if (!(error instanceof Error) || (error as { code?: string }).code !== "record_identity_conflict") throw error; if (canonicalJson(await readSignedFile(path, facts, MAX_RETAINED_TRACE_REVIEW_BYTES, "record_not_found")) !== canonicalJson(value)) throw storeError("retained_trace_review_binding_conflict", "Checkpoint storyboard retained-trace review journal leaf is occupied by different content."); } }
function seal(prefix: string, schema: string, value: object): object { const payload = { schema, ...value }, sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex"); return deepFreeze({ ...payload, id: `${prefix}${sha256.slice(0, 32)}`, sha256 }); }
function ref(value: { readonly id: string; readonly sha256: string }): Ref { return Object.freeze({ id: value.id, sha256: value.sha256 }); }
function sameRef(left: Ref, right: { readonly id: string; readonly sha256: string }): boolean { return left.id === right.id && left.sha256 === right.sha256; }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function bounded(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function positiveRevision(value: unknown): value is number { return bounded(value, 1, 1_000_000); }
function validInventory(value: Record<string, unknown>): boolean { return hash(value.sha256) && bounded(value.entryCount, 1, 2048) && bounded(value.leafCount, 1, 1024); }
function validReviewDecision(decision: Record<string, unknown>, reviewer: Record<string, unknown>): boolean {
  if (typeof decision.id !== "string" || !/^checkpoint_storyboard_retained_trace_review_decision_[a-f0-9]{32}$/u.test(decision.id) || typeof decision.sha256 !== "string" || !HASH.test(decision.sha256)
    || (decision.outcome !== "accepted" && decision.outcome !== "changes_requested" && decision.outcome !== "rejected") || (reviewer.kind !== "human" && reviewer.kind !== "policy") || typeof reviewer.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(reviewer.id)) return false;
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-review-decision@1", outcome: decision.outcome, reviewer: { kind: reviewer.kind, id: reviewer.id } };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return decision.sha256 === sha256 && decision.id === `checkpoint_storyboard_retained_trace_review_decision_${sha256.slice(0, 32)}`;
}
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) deepFreeze(child); Object.freeze(value); } return value; }
function bad(label: string): never { throw storeError("store_integrity_failed", `Checkpoint storyboard retained-trace review ${label} is invalid.`); }
