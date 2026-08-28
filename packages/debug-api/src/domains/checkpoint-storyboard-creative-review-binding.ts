/** Private B1c final-binding construction and intentionally limited public projection. */
import { createHash } from "node:crypto";
import { canonicalJson } from "@shellx-motion/core";
import { type ResolvedHostCreativeReview } from "./checkpoint-storyboard-creative-review-authority.js";
import { type CheckpointStoryboardReopenedPreviewPair } from "./checkpoint-storyboard-preview-state.js";
import { type StoredBinding, type CreativeIdentity } from "./checkpoint-storyboard-creative-review-types.js";
import { storeError, type CheckpointStoryboardCreativeReviewView, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";
import { type readMaterializationBinding } from "./checkpoint-storyboard-materialization-bindings.js";

export function createBinding(
  identity: CheckpointStoryboardRecordIdentity,
  root: CheckpointStoryboardRecordIdentity,
  materialization: Awaited<ReturnType<typeof readMaterializationBinding>> & {},
  preview: CheckpointStoryboardReopenedPreviewPair,
  creative: ResolvedHostCreativeReview,
): StoredBinding {
  if (!materialization || !preview.state.receipt || !preview.state.png)
    throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review could not retain exact binding evidence.");
  if (preview.state.schema === "shellx-motion/private-checkpoint-storyboard-preview-state@2" && preview.state.sampling?.mode !== "interior") {
    throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative review requires interior B1b sampling; terminal endpoint evidence requires B1e witness authority.");
  }
  const atMs = preview.state.target.resolvedAtMs;
  const atUs = atMs * 1_000;
  if (!Number.isSafeInteger(atUs) || atUs < creative.creative.selectedShot.startUs || atUs >= creative.creative.selectedShot.startUs + creative.creative.selectedShot.durationUs || creative.creative.findings.some((finding) => finding.shotId !== creative.creative.selectedShot.id || finding.atUs !== atUs)) {
    throw storeError("creative_review_evidence_refused", "Checkpoint storyboard creative-review findings must exactly name the selected shot and B1b preview time.");
  }
  const targetSha256 = createHash("sha256").update(canonicalJson(preview.state.target)).digest("hex");
  const isLegacyPreview = preview.state.schema === "shellx-motion/private-checkpoint-storyboard-preview-state@1";
  const payload = {
    schema: isLegacyPreview ? "shellx-motion/private-checkpoint-storyboard-creative-review@1" as const : "shellx-motion/private-checkpoint-storyboard-creative-review@2" as const,
    identity, root,
    c6: Object.freeze({ fingerprint: identity.sha256 }),
    b1a: Object.freeze({ bindingId: materialization.id, bindingSha256: materialization.sha256, c6bReceiptFingerprint: materialization.c6b1bReceiptFingerprint }),
    preview: Object.freeze({ targetSha256, receiptSha256: preview.state.receipt.sha256, pngSha256: preview.state.png.sha256, snapshotSha256: preview.snapshotSha256, ...(!isLegacyPreview ? { samplingSha256: preview.samplingSha256 } : {}), width: preview.state.png.width, height: preview.state.png.height, runtimeEvidence: preview.state.runtimeEvidence }),
    creative: Object.freeze({ brief: creativeIdentity(creative.creative.brief), shotPlan: creativeIdentity(creative.creative.shotPlan), assetLedger: creativeIdentity(creative.creative.assetLedger), run: creativeIdentity(creative.creative.run), reviewDecision: creativeIdentity(creative.creative.reviewDecision) }),
    host: Object.freeze({ shotPlanApprover: creative.authentication.shotPlanApprover, reviewDecisionReviewer: creative.authentication.reviewDecisionReviewer, authenticationDigest: creative.authentication.authenticationDigest, handleDigest: creative.authentication.handleDigest }),
    outcome: creative.creative.outcome,
    derivedRunId: creative.creative.derivedRunId,
    scope: Object.freeze({ shotId: creative.creative.selectedShot.id, atMs }),
  };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return Object.freeze({ ...payload, id: `checkpoint_storyboard_creative_review_${sha256.slice(0, 32)}`, sha256 });
}

export function publicView(binding: StoredBinding): CheckpointStoryboardCreativeReviewView {
  return Object.freeze({
    outcome: binding.outcome,
    derivedRunId: binding.derivedRunId,
    scope: binding.scope,
    preview: Object.freeze({ width: binding.preview.width, height: binding.preview.height, runtimeEvidence: binding.preview.runtimeEvidence }),
    evidence: Object.freeze({ evidenceClass: binding.preview.runtimeEvidence === "source-test" ? "source-test-association" : "host-browser-association", hostBrowser: false, humanReview: false, pixels: false, quality: false, finalMedia: false }),
  });
}

function creativeIdentity(value: { id: string; sha256: string }): CreativeIdentity {
  return Object.freeze({ id: value.id, sha256: value.sha256 });
}
