/** Private B1b reopen and historical audit used only by C6C B1c. */
import { opendir } from "node:fs/promises";
import { canonicalJson, hashBuffer } from "@shellx-motion/core";
import { findLineagePreviewsDirectory, lineagePreviewsDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";
import {
  assertLineageHasNoUnsettledCheckpointStoryboardPreviews,
  previewHandles,
  readPreviewState,
  reopenCompletePreviewPair,
  STATE_FILE,
  MAX_PREVIEWS_PER_LINEAGE,
  type CheckpointStoryboardReopenedPreviewPair,
} from "./checkpoint-storyboard-preview-state.js";

export async function reopenCheckpointStoryboardCompletePreviewByHandles(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
  previewHandle: string,
  receiptHandle: string,
): Promise<CheckpointStoryboardReopenedPreviewPair> {
  if (!/^checkpoint_storyboard_preview_[a-f0-9]{32}$/u.test(previewHandle) || !/^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$/u.test(receiptHandle))
    throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review requires exact opaque preview and receipt handles.");
  await assertLineageHasNoUnsettledCheckpointStoryboardPreviews(facts, root);
  const directory = await lineagePreviewsDirectory(facts, root.id);
  const names: string[] = [];
  const reader = await opendir(directory.path);
  try {
    for await (const entry of reader) {
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard preview evidence directory cannot be safely reopened for creative review.");
      if (STATE_FILE.test(entry.name)) {
        if (names.length >= MAX_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard preview evidence directory exceeds its bounded creative-review scan.");
        names.push(entry.name);
      } else if (!/^(?:checkpoint_storyboard_preview_[a-f0-9]{32}\.(?:png|receipt\.json))$/u.test(entry.name)) {
        throw storeError("store_integrity_failed", "Checkpoint storyboard preview evidence directory cannot be safely reopened for creative review.");
      }
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
  const matches: CheckpointStoryboardReopenedPreviewPair[] = [];
  for (const name of names.sort()) {
    const state = await readPreviewState(facts, directory.path, STATE_FILE.exec(name)![1]!);
    if (!sameIdentity(state.root, root) || state.phase !== "complete") continue;
    const handles = previewHandles(facts, state);
    if (handles.preview === previewHandle && handles.receipt === receiptHandle) {
      if (state.schema === "shellx-motion/private-checkpoint-storyboard-preview-state@2" && state.sampling?.mode !== "interior") {
        throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review requires an interior B1b preview; terminal endpoint evidence requires B1e witness authority.");
      }
      const evidence = await reopenCompletePreviewPair(facts, directory.path, state, new Set([`${state.id}.png`, `${state.id}.receipt.json`]));
      matches.push(Object.freeze({
        state,
        ...evidence,
      }));
    }
  }
  if (matches.length !== 1)
    throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review could not resolve exactly one complete preview receipt and PNG pair.");
  return matches[0]!;
}

/** Historical B1c audit: resolve retained B1b evidence without a caller handle. */
export async function assertCheckpointStoryboardCreativeReviewPreviewEvidence(
  facts: AuthorityFacts,
  root: CheckpointStoryboardRecordIdentity,
  expected: Readonly<{
    identity: CheckpointStoryboardRecordIdentity;
    binding: Readonly<{ id: string; sha256: string }>;
    targetSha256: string;
    receiptSha256: string;
    pngSha256: string;
    snapshotSha256: string;
    bindingSchema: "shellx-motion/private-checkpoint-storyboard-creative-review@1" | "shellx-motion/private-checkpoint-storyboard-creative-review@2";
    samplingSha256?: string;
    width: number;
    height: number;
    runtimeEvidence: "host-browser" | "source-test";
  }>,
): Promise<void> {
  const directory = await findLineagePreviewsDirectory(facts, root.id);
  if (!directory) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review association is missing its B1b evidence directory.");
  await assertLineageHasNoUnsettledCheckpointStoryboardPreviews(facts, root);
  const names: string[] = [];
  const reader = await opendir(directory.path);
  try {
    for await (const entry of reader) {
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review association has unsupported B1b evidence residue.");
      if (STATE_FILE.test(entry.name)) {
        if (names.length >= MAX_PREVIEWS_PER_LINEAGE) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review association exceeds its bounded B1b scan.");
        names.push(entry.name);
      }
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
  let matches = 0;
  for (const name of names.sort()) {
    const state = await readPreviewState(facts, directory.path, STATE_FILE.exec(name)![1]!);
    if (state.phase !== "complete" || !sameIdentity(state.identity, expected.identity) || state.binding.id !== expected.binding.id || state.binding.sha256 !== expected.binding.sha256 || !state.receipt || !state.png || state.receipt.sha256 !== expected.receiptSha256 || state.png.sha256 !== expected.pngSha256 || state.png.width !== expected.width || state.png.height !== expected.height || state.runtimeEvidence !== expected.runtimeEvidence) continue;
    if ((expected.bindingSchema === "shellx-motion/private-checkpoint-storyboard-creative-review@1" && state.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@1")
      || (expected.bindingSchema === "shellx-motion/private-checkpoint-storyboard-creative-review@2" && (state.schema !== "shellx-motion/private-checkpoint-storyboard-preview-state@2" || state.sampling?.mode !== "interior"))) continue;
    const targetSha256 = hashBuffer(Buffer.from(canonicalJson(state.target), "utf8"));
    const evidence = await reopenCompletePreviewPair(facts, directory.path, state, new Set([`${state.id}.png`, `${state.id}.receipt.json`]));
    if (targetSha256 === expected.targetSha256 && evidence.snapshotSha256 === expected.snapshotSha256 && (expected.bindingSchema === "shellx-motion/private-checkpoint-storyboard-creative-review@1" || evidence.samplingSha256 === expected.samplingSha256)) matches += 1;
  }
  if (matches !== 1) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review association cannot reopen exactly one sealed B1b preview pair.");
}
