/** Bounded read-only B1e receipt journal. Intent then immutable receipt gives replay-safe recovery. */
import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, compareCodeUnits } from "@shellx-motion/core";
import { findLineageQualityReviewsDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { assertLineageCreativeReviewJournalIsComplete } from "./checkpoint-storyboard-creative-review.js";
import { readMaterializationBinding } from "./checkpoint-storyboard-materialization-bindings.js";
import { assertCheckpointStoryboardQualityPreviewEvidence } from "./checkpoint-storyboard-quality-review-preview.js";
import { readSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { exact, readIdentity, sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";
import { MAX_QUALITY_RECEIPT_BYTES, MAX_QUALITY_REVIEWS_PER_LINEAGE, QUALITY_INTENT_FILE, QUALITY_PROFILE, QUALITY_PROFILE_SHA256, QUALITY_RECEIPT_FILE, SHA256, type QualityReviewIntent, type QualityReviewJournal, type StoredQualityReview } from "./checkpoint-storyboard-quality-review-types.js";

export async function readQualityReviewJournal(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<QualityReviewJournal> {
  const directory = await findLineageQualityReviewsDirectory(facts, root.id);
  if (!directory) return Object.freeze({ receipts: Object.freeze([]) });
  const receiptNames: string[] = [], intentNames: string[] = [];
  const entries = await opendir(directory.path);
  try { for await (const entry of entries) {
    if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review journal contains an unsupported private entry.");
    const names = QUALITY_RECEIPT_FILE.test(entry.name) ? receiptNames : QUALITY_INTENT_FILE.test(entry.name) ? intentNames : undefined;
    if (!names || names.length >= MAX_QUALITY_REVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review journal is not a bounded recognized roster.");
    names.push(entry.name);
  } } finally { await entries.close().catch(() => undefined); }
  const receipts = new Map<string, StoredQualityReview>();
  for (const name of receiptNames.sort()) {
    const match = QUALITY_RECEIPT_FILE.exec(name);
    const receipt = readQualityReview(await readSignedFile(join(directory.path, name), facts, MAX_QUALITY_RECEIPT_BYTES, "record_not_found"));
    if (!match || receipt.identity.id !== match[1] || !sameIdentity(receipt.root, root) || receipts.has(receipt.identity.id)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review receipt escaped or duplicated its root roster.");
    receipts.set(receipt.identity.id, receipt);
  }
  const intents = new Map<string, QualityReviewIntent>();
  for (const name of intentNames.sort()) {
    const match = QUALITY_INTENT_FILE.exec(name);
    const intent = readQualityReviewIntent(await readSignedFile(join(directory.path, name), facts, MAX_QUALITY_RECEIPT_BYTES, "record_not_found"));
    if (!match || intent.identity.id !== match[1] || !sameIdentity(intent.root, root) || intents.has(intent.identity.id)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review intent escaped or duplicated its root roster.");
    intents.set(intent.identity.id, intent);
  }
  if (receipts.size !== intents.size || [...receipts.values()].some((receipt) => {
    const intent = intents.get(receipt.identity.id);
    return !intent || intent.receipt.id !== receipt.id || intent.receipt.sha256 !== receipt.sha256;
  })) {
    const pending = [...intents.values()].filter((intent) => !receipts.has(intent.identity.id));
    if (pending.length !== 1 || receipts.size + 1 !== intents.size) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review journal has an incomplete immutable receipt association.");
    return Object.freeze({ receipts: Object.freeze([...receipts.values()].sort((a, b) => compareCodeUnits(a.identity.id, b.identity.id))), pending: Object.freeze({ intent: pending[0]! }) });
  }
  return Object.freeze({ receipts: Object.freeze([...receipts.values()].sort((a, b) => compareCodeUnits(a.identity.id, b.identity.id))) });
}
/** Lifecycle/audit guard: no transition may discard an unresolved B1e intent. */
export async function assertLineageQualityReviewJournalIsComplete(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<QualityReviewJournal> {
  const journal = await readQualityReviewJournal(facts, root);
  if (journal.pending) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review roster has an unresolved exact publication and cannot be destructively transitioned.");
  const creativeJournal = await assertLineageCreativeReviewJournalIsComplete(facts, root);
  for (const receipt of journal.receipts) {
    let record;
    try { record = await readStoredRecordUnlocked(facts, receipt.identity); }
    catch { throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review receipt cannot reopen its exact immutable record."); }
    const materialization = await readMaterializationBinding(facts, receipt.identity);
    const creative = creativeJournal.bindings.find((binding) => sameIdentity(binding.identity, receipt.identity));
    if (!sameIdentity(record.lineage.root, root) || !materialization || !sameIdentity(materialization.root, root) || materialization.id !== receipt.b1a.bindingId || materialization.sha256 !== receipt.b1a.bindingSha256 || materialization.c6b1bReceiptFingerprint !== receipt.b1a.c6bReceiptFingerprint || !creative || creative.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review@2" || creative.id !== receipt.b1c.bindingId || creative.sha256 !== receipt.b1c.bindingSha256 || creative.host.handleDigest !== receipt.b1c.hostHandleDigest || creative.preview.samplingSha256 !== receipt.b1c.samplingSha256 || (receipt.review.kind === "interior" && receipt.review.creativeHandleDigest !== creative.host.handleDigest)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review receipt cannot reopen its exact B1a and durable B1c associations.");
    await assertCheckpointStoryboardQualityPreviewEvidence(facts, root, receipt);
    const terminalDurationUs = receipt.preview.sampling.documentDurationMs * 1_000;
    if (receipt.review.kind === "terminal-endpoint" && (receipt.preview.sampling.mode !== "terminal-boundary" || !Number.isSafeInteger(terminalDurationUs) || receipt.review.selectedShotEndUs !== receipt.review.endpointAtUs || receipt.review.endpointAtUs !== terminalDurationUs)) throw storeError("store_integrity_failed", "Checkpoint storyboard terminal quality receipt no longer proves selected-shot-end adjacency to exact B1b terminal duration.");
  }
  return journal;
}

export function createQualityReviewIntent(root: CheckpointStoryboardRecordIdentity, receipt: StoredQualityReview): QualityReviewIntent {
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-preview-quality-review-intent@1" as const, root, identity: receipt.identity, receipt: Object.freeze({ id: receipt.id, sha256: receipt.sha256 }) };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return Object.freeze({ ...payload, id: `checkpoint_storyboard_quality_review_intent_${sha256.slice(0, 32)}`, sha256 });
}
export function readQualityReviewIntent(value: unknown): QualityReviewIntent {
  const record = exact(value, ["schema", "id", "sha256", "root", "identity", "receipt"], "Checkpoint storyboard quality-review intent");
  const receipt = exact(record.receipt, ["id", "sha256"], "Checkpoint storyboard quality-review intent receipt");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-preview-quality-review-intent@1" || typeof record.id !== "string" || !/^checkpoint_storyboard_quality_review_intent_[a-f0-9]{32}$/u.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || typeof receipt.id !== "string" || !/^checkpoint_storyboard_preview_quality_review_[a-f0-9]{32}$/u.test(receipt.id) || typeof receipt.sha256 !== "string" || !SHA256.test(receipt.sha256)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review intent is invalid.");
  const payload = { schema: record.schema, root: readIdentity(record.root, "Checkpoint storyboard quality-review intent root"), identity: readIdentity(record.identity, "Checkpoint storyboard quality-review intent identity"), receipt: Object.freeze({ id: receipt.id, sha256: receipt.sha256 }) } as const;
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (record.sha256 !== sha256 || record.id !== `checkpoint_storyboard_quality_review_intent_${sha256.slice(0, 32)}`) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review intent canonical identity is stale.");
  return Object.freeze({ ...payload, id: record.id, sha256 });
}

export function readQualityReview(value: unknown): StoredQualityReview {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "b1a", "preview", "b1c", "review", "profile", "verdict", "finalAcceptance"], ["failure"], "Checkpoint storyboard quality-review receipt");
  const b1a = exact(record.b1a, ["bindingId", "bindingSha256", "c6bReceiptFingerprint"], "Checkpoint storyboard quality-review B1a evidence");
  const preview = exact(record.preview, ["targetSha256", "receiptSha256", "pngSha256", "snapshotSha256", "width", "height", "runtimeEvidence", "sampling"], ["terminalBoundarySha256"], "Checkpoint storyboard quality-review preview evidence");
  const sampling = exact(preview.sampling, ["mode", "renderedAtMs", "documentDurationMs", "interval", "layerContent"], "Checkpoint storyboard quality-review sampling");
  const b1c = exact(record.b1c, ["bindingId", "bindingSha256", "hostHandleDigest", "samplingSha256"], "Checkpoint storyboard quality-review B1c evidence");
  const profile = exact(record.profile, ["id", "sha256", "checks"], "Checkpoint storyboard quality-review profile");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-preview-quality-review@1" || typeof record.id !== "string" || !/^checkpoint_storyboard_preview_quality_review_[a-f0-9]{32}$/u.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || !validReference(b1a.bindingId, /^checkpoint_storyboard_materialization_binding_[a-f0-9]{32}$/u, b1a.bindingSha256) || typeof b1a.c6bReceiptFingerprint !== "string" || !SHA256.test(b1a.c6bReceiptFingerprint) || !validPreview(preview, sampling) || !validReference(b1c.bindingId, /^checkpoint_storyboard_creative_review_[a-f0-9]{32}$/u, b1c.bindingSha256) || typeof b1c.hostHandleDigest !== "string" || !SHA256.test(b1c.hostHandleDigest) || typeof b1c.samplingSha256 !== "string" || !SHA256.test(b1c.samplingSha256) || profile.id !== QUALITY_PROFILE || profile.sha256 !== QUALITY_PROFILE_SHA256 || !Array.isArray(profile.checks) || canonicalJson(profile.checks) !== canonicalJson(["authenticated-png-pair", "decoded-png", "dimensions"]) || (record.verdict !== "passed" && record.verdict !== "failed") || (record.failure !== undefined && record.failure !== "invalid_png" && record.failure !== "png_dimension_mismatch") || (record.verdict === "passed" ? record.failure !== undefined : record.failure === undefined) || record.finalAcceptance !== "unavailable") throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review receipt evidence is invalid.");
  const review = readReview(record.review);
  const payload = { schema: record.schema as StoredQualityReview["schema"], identity: readIdentity(record.identity, "Checkpoint storyboard quality-review identity"), root: readIdentity(record.root, "Checkpoint storyboard quality-review root"), b1a: Object.freeze({ bindingId: b1a.bindingId as string, bindingSha256: b1a.bindingSha256 as string, c6bReceiptFingerprint: b1a.c6bReceiptFingerprint as string }), preview: Object.freeze({ targetSha256: preview.targetSha256 as string, receiptSha256: preview.receiptSha256 as string, pngSha256: preview.pngSha256 as string, snapshotSha256: preview.snapshotSha256 as string, width: preview.width as number, height: preview.height as number, runtimeEvidence: preview.runtimeEvidence as "host-browser" | "source-test", sampling: Object.freeze({ mode: sampling.mode as "interior" | "terminal-boundary", renderedAtMs: sampling.renderedAtMs as number, documentDurationMs: sampling.documentDurationMs as number, interval: "[0,D)" as const, layerContent: sampling.layerContent as "included" | "excluded-no-hold" }), ...(typeof preview.terminalBoundarySha256 === "string" ? { terminalBoundarySha256: preview.terminalBoundarySha256 } : {}) }), b1c: Object.freeze({ bindingId: b1c.bindingId as string, bindingSha256: b1c.bindingSha256 as string, hostHandleDigest: b1c.hostHandleDigest as string, samplingSha256: b1c.samplingSha256 as string }), review, profile: Object.freeze({ id: QUALITY_PROFILE, sha256: QUALITY_PROFILE_SHA256, checks: Object.freeze(["authenticated-png-pair", "decoded-png", "dimensions"] as const) }), verdict: record.verdict as "passed" | "failed", ...(record.failure ? { failure: record.failure as "invalid_png" | "png_dimension_mismatch" } : {}), finalAcceptance: "unavailable" as const };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (record.sha256 !== sha256 || record.id !== `checkpoint_storyboard_preview_quality_review_${sha256.slice(0, 32)}`) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review receipt canonical identity is stale.");
  return Object.freeze({ ...payload, id: record.id, sha256 });
}

function validReference(id: unknown, grammar: RegExp, sha256: unknown): boolean { return typeof id === "string" && grammar.test(id) && typeof sha256 === "string" && SHA256.test(sha256); }
function validPreview(preview: Record<string, unknown>, sampling: Record<string, unknown>): boolean {
  const renderedAtMs = sampling.renderedAtMs, documentDurationMs = sampling.documentDurationMs;
  return ["targetSha256", "receiptSha256", "pngSha256", "snapshotSha256"].every((field) => typeof preview[field] === "string" && SHA256.test(preview[field] as string)) && Number.isSafeInteger(preview.width) && (preview.width as number) > 0 && Number.isSafeInteger(preview.height) && (preview.height as number) > 0 && (preview.runtimeEvidence === "host-browser" || preview.runtimeEvidence === "source-test") && (sampling.mode === "interior" || sampling.mode === "terminal-boundary") && Number.isSafeInteger(renderedAtMs) && (renderedAtMs as number) >= 0 && Number.isSafeInteger(documentDurationMs) && (documentDurationMs as number) > 0 && sampling.interval === "[0,D)" && ((sampling.mode === "interior" && sampling.layerContent === "included" && (renderedAtMs as number) < (documentDurationMs as number) && preview.terminalBoundarySha256 === undefined) || (sampling.mode === "terminal-boundary" && sampling.layerContent === "excluded-no-hold" && renderedAtMs === documentDurationMs && typeof preview.terminalBoundarySha256 === "string" && SHA256.test(preview.terminalBoundarySha256)));
}
function readReview(value: unknown): StoredQualityReview["review"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review association is invalid.");
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  const matches = (fields: readonly string[]) => keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field)) && keys.every((field) => fields.includes(field));
  if (record.kind === "interior" && matches(["kind", "creativeHandleDigest"]) && typeof record.creativeHandleDigest === "string" && SHA256.test(record.creativeHandleDigest)) return Object.freeze({ kind: "interior", creativeHandleDigest: record.creativeHandleDigest });
  if (record.kind !== "terminal-endpoint" || !matches(["kind", "endpointWitnessDigest", "endpointAtUs", "selectedShotEndUs", "relation", "claims"])) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review association is invalid.");
  const claims = exact(record.claims, ["visibleFinalState", "heldLayerContent", "humanPixelReview", "finalMedia"], "Checkpoint storyboard endpoint quality claims");
  if (typeof record.endpointWitnessDigest !== "string" || !SHA256.test(record.endpointWitnessDigest) || !Number.isSafeInteger(record.endpointAtUs) || (record.endpointAtUs as number) < 1_000 || !Number.isSafeInteger(record.selectedShotEndUs) || (record.selectedShotEndUs as number) < 1_000 || record.relation !== "adjacent-end-exclusive" || claims.visibleFinalState !== false || claims.heldLayerContent !== false || claims.humanPixelReview !== false || claims.finalMedia !== false) throw storeError("store_integrity_failed", "Checkpoint storyboard terminal quality-review claims are invalid.");
  return Object.freeze({ kind: "terminal-endpoint", endpointWitnessDigest: record.endpointWitnessDigest, endpointAtUs: record.endpointAtUs as number, selectedShotEndUs: record.selectedShotEndUs as number, relation: "adjacent-end-exclusive", claims: Object.freeze({ visibleFinalState: false, heldLayerContent: false, humanPixelReview: false, finalMedia: false }) });
}
