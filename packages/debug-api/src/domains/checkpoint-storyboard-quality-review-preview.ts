/** B1e-only reopen of one authenticated B1b v2 pair. PNG bytes remain in-process and are never retained. */
import { opendir } from "node:fs/promises";
import { canonicalJson, hashBuffer, inspectPngBuffer } from "@shellx-motion/core";
import { findLineagePreviewsDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";
import { assertLineageHasNoUnsettledCheckpointStoryboardPreviews, MAX_PREVIEWS_PER_LINEAGE, previewHandles, readPreviewState, reopenCompletePreviewPairForQuality, STATE_FILE, type CheckpointStoryboardPreviewSampling, type CheckpointStoryboardPreviewState } from "./checkpoint-storyboard-preview-state.js";
import type { StoredQualityReview } from "./checkpoint-storyboard-quality-review-types.js";

const PREVIEW_HANDLE = /^checkpoint_storyboard_preview_[a-f0-9]{32}$/u;
const RECEIPT_HANDLE = /^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$/u;

export type ReopenedQualityPreview = Readonly<{
  state: CheckpointStoryboardPreviewState & Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-preview-state@2"; sampling: CheckpointStoryboardPreviewSampling }>;
  snapshotSha256: string;
  samplingSha256: string;
  terminalBoundarySha256?: string;
  png: Buffer;
}>;

export async function reopenCheckpointStoryboardQualityPreviewByHandles(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
  previewHandle: string,
  receiptHandle: string,
): Promise<ReopenedQualityPreview> {
  if (!PREVIEW_HANDLE.test(previewHandle) || !RECEIPT_HANDLE.test(receiptHandle)) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review requires exact opaque B1b preview and receipt handles.");
  await assertLineageHasNoUnsettledCheckpointStoryboardPreviews(facts, root);
  const directory = await findLineagePreviewsDirectory(facts, root.id);
  if (!directory) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review cannot reopen a missing B1b evidence directory.");
  const names: string[] = [];
  const reader = await opendir(directory.path);
  try { for await (const entry of reader) {
    if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard B1e quality review preview roster contains an unsupported private entry.");
    if (STATE_FILE.test(entry.name)) {
      if (names.length >= MAX_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard B1e quality review preview roster exceeds its bounded scan.");
      names.push(entry.name);
    } else if (!/^(?:checkpoint_storyboard_preview_[a-f0-9]{32}\.(?:png|receipt\.json))$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard B1e quality review preview roster contains an unknown private entry.");
  } } finally { await reader.close().catch(() => undefined); }
  const matches: ReopenedQualityPreview[] = [];
  for (const name of names.sort()) {
    const state = await readPreviewState(facts, directory.path, STATE_FILE.exec(name)![1]!);
    if (!sameIdentity(state.root, root) || state.phase !== "complete") continue;
    const handles = previewHandles(facts, state);
    if (handles.preview !== previewHandle || handles.receipt !== receiptHandle) continue;
    if (state.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@2" || !state.sampling) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review requires exactly one B1b v2 preview receipt pair.");
    const reopened = await reopenCompletePreviewPairForQuality(facts, directory.path, state, new Set([`${state.id}.png`, `${state.id}.receipt.json`]));
    if (state.sampling.mode === "terminal-boundary" && !reopened.terminalBoundarySha256) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard terminal quality review requires exact reopened terminal-boundary evidence.");
    matches.push(Object.freeze({ state: state as ReopenedQualityPreview["state"], ...reopened }));
  }
  if (matches.length !== 1) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard quality review could not resolve exactly one complete B1b v2 PNG pair.");
  return matches[0]!;
}

/** Historical B1e audit: reopen one sealed B1b v2 pair and reproduce only the fixed integrity verdict. */
export async function assertCheckpointStoryboardQualityPreviewEvidence(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, expected: StoredQualityReview): Promise<void> {
  const directory = await findLineagePreviewsDirectory(facts, root.id);
  if (!directory) throw storeError("store_integrity_failed", "Checkpoint storyboard quality receipt is missing its B1b evidence directory.");
  const names: string[] = [];
  await assertLineageHasNoUnsettledCheckpointStoryboardPreviews(facts, root);
  const reader = await opendir(directory.path);
  try { for await (const entry of reader) { if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard quality receipt has unsupported B1b evidence residue."); if (STATE_FILE.test(entry.name)) { if (names.length >= MAX_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard quality receipt exceeds its bounded B1b scan."); names.push(entry.name); } } } finally { await reader.close().catch(() => undefined); }
  let matches = 0;
  for (const name of names.sort()) {
    const state = await readPreviewState(facts, directory.path, STATE_FILE.exec(name)![1]!);
    if (state.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@2" || state.phase !== "complete" || !state.sampling || !sameIdentity(state.identity, expected.identity) || !sameIdentity(state.root, root) || state.binding.id !== expected.b1a.bindingId || state.binding.sha256 !== expected.b1a.bindingSha256 || !state.receipt || !state.png || state.receipt.sha256 !== expected.preview.receiptSha256 || state.png.sha256 !== expected.preview.pngSha256 || state.png.width !== expected.preview.width || state.png.height !== expected.preview.height || state.runtimeEvidence !== expected.preview.runtimeEvidence || canonicalJson(state.sampling) !== canonicalJson(expected.preview.sampling)) continue;
    const reopened = await reopenCompletePreviewPairForQuality(facts, directory.path, state, new Set([`${state.id}.png`, `${state.id}.receipt.json`]));
    if (hashBuffer(Buffer.from(canonicalJson(state.target), "utf8")) !== expected.preview.targetSha256 || reopened.snapshotSha256 !== expected.preview.snapshotSha256 || reopened.samplingSha256 !== hashBuffer(Buffer.from(canonicalJson(expected.preview.sampling), "utf8")) || reopened.terminalBoundarySha256 !== expected.preview.terminalBoundarySha256) continue;
    const inspected = inspectPngBuffer(reopened.png);
    const failure = !inspected.ok ? "invalid_png" : inspected.width !== state.png.width || inspected.height !== state.png.height ? "png_dimension_mismatch" : undefined;
    if ((expected.verdict === "passed" && failure === undefined) || (expected.verdict === "failed" && expected.failure === failure)) matches += 1;
  }
  if (matches !== 1) throw storeError("store_integrity_failed", "Checkpoint storyboard quality receipt cannot reopen exactly one sealed B1b v2 preview pair and fixed integrity verdict.");
}
