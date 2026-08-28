/** Exact B7 preview lookup and historical audit for arbitrary-time review bindings. */
import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { canonicalJson } from "@shellx-motion/core";
import { findLineageRetainedTracePreviewsDirectory } from "./checkpoint-storyboard-retained-trace-preview-store.js";
import {
  assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews,
  MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE,
  readCheckpointStoryboardRetainedTracePreviewState,
  reopenCompleteCheckpointStoryboardRetainedTracePreviewPair,
  retainedTracePreviewHandles,
  RETAINED_TRACE_PREVIEW_STATE_FILE,
  type CheckpointStoryboardRetainedTracePreviewPair,
} from "./checkpoint-storyboard-retained-trace-preview-state.js";
import { sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

const PREVIEW_HANDLE = /^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/u;
const RECEIPT_HANDLE = /^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$/u;

export async function reopenCheckpointStoryboardRetainedTracePreviewByHandles(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
  previewHandle: string,
  receiptHandle: string,
): Promise<CheckpointStoryboardRetainedTracePreviewPair> {
  if (!PREVIEW_HANDLE.test(previewHandle) || !RECEIPT_HANDLE.test(receiptHandle)) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review requires exact opaque preview and receipt handles.");
  await assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(facts, root);
  const directory = await findLineageRetainedTracePreviewsDirectory(facts, root.id);
  if (!directory) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review cannot find its private preview evidence.");
  const ids = await stateIds(directory.path);
  const matches: CheckpointStoryboardRetainedTracePreviewPair[] = [];
  for (const id of ids) {
    const state = await readCheckpointStoryboardRetainedTracePreviewState(facts, directory.path, id);
    if (state.phase !== "complete" || !sameIdentity(state.root, root)) continue;
    const handles = retainedTracePreviewHandles(facts, state);
    if (handles.preview === previewHandle && handles.receipt === receiptHandle) matches.push(await reopenCompleteCheckpointStoryboardRetainedTracePreviewPair(facts, directory.path, state, new Set([`${id}.png`, `${id}.receipt.json`])));
  }
  if (matches.length !== 1) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review could not resolve exactly one complete preview receipt and PNG pair.");
  return matches[0]!;
}

export async function assertCheckpointStoryboardRetainedTraceReviewPreviewEvidence(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
  expected: Readonly<{
    stateId: string;
    identity: CheckpointStoryboardRecordIdentity;
    binding: Readonly<{ id: string; sha256: string }>;
    atUs: number;
    runtimeEvidence: "host-gpu" | "source-test";
    previewHandleDigest: string;
    receipt: Readonly<{ sha256: string; byteLength: number }>;
    png: Readonly<{ sha256: string; byteLength: number; width: number; height: number }>;
  }>,
): Promise<void> {
  const directory = await findLineageRetainedTracePreviewsDirectory(facts, root.id);
  if (!directory) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review is missing its preview evidence directory.");
  await assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(facts, root);
  const state = await readCheckpointStoryboardRetainedTracePreviewState(facts, directory.path, expected.stateId);
  const handles = retainedTracePreviewHandles(facts, state);
  const previewHandleDigest = createHash("sha256").update(canonicalJson({ previewHandle: handles.preview, receiptHandle: handles.receipt })).digest("hex");
  if (state.phase !== "complete" || !state.receipt || !state.png || !sameIdentity(state.identity, expected.identity) || !sameIdentity(state.root, root)
    || state.binding.id !== expected.binding.id || state.binding.sha256 !== expected.binding.sha256 || state.atUs !== expected.atUs || state.runtimeEvidence !== expected.runtimeEvidence
    || previewHandleDigest !== expected.previewHandleDigest
    || state.receipt.sha256 !== expected.receipt.sha256 || state.receipt.byteLength !== expected.receipt.byteLength
    || state.png.sha256 !== expected.png.sha256 || state.png.byteLength !== expected.png.byteLength || state.png.width !== expected.png.width || state.png.height !== expected.png.height) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review cannot reopen its exact preview state.");
  }
  await reopenCompleteCheckpointStoryboardRetainedTracePreviewPair(facts, directory.path, state, new Set([`${state.id}.png`, `${state.id}.receipt.json`]));
}

async function stateIds(directory: string): Promise<readonly string[]> {
  const ids: string[] = [];
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      const id = entry.isFile() ? RETAINED_TRACE_PREVIEW_STATE_FILE.exec(entry.name)?.[1] : undefined;
      if (!id) continue;
      if (ids.length >= MAX_RETAINED_TRACE_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review exceeds its bounded preview lookup.");
      ids.push(id);
    }
  } finally { await entries.close().catch(() => undefined); }
  return Object.freeze(ids.sort());
}
