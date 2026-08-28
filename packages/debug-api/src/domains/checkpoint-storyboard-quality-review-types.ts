/** Private C6C B1e signed receipt and journal shapes. No handle, path, record body, or pixel escapes. */
import type { CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

export const QUALITY_RECEIPT_FILE = /^(checkpoint_storyboard_[a-f0-9]{32})\.quality-review\.json$/u;
export const QUALITY_INTENT_FILE = /^(checkpoint_storyboard_[a-f0-9]{32})\.quality-review\.intent\.json$/u;
export const MAX_QUALITY_REVIEWS_PER_LINEAGE = 128;
export const MAX_QUALITY_RECEIPT_BYTES = 24 * 1024;
export const QUALITY_PROFILE = "checkpoint-storyboard-authenticated-png-integrity@1" as const;
/** SHA-256 of canonical `{checks,id}` for the fixed code-owned profile; it is not caller data. */
export const QUALITY_PROFILE_SHA256 = "cb964163531b86d0743feb256d5c86bf41b9d0e22767fa093e7605b2f0a20dea" as const;
export const SHA256 = /^[a-f0-9]{64}$/u;

export type CheckpointStoryboardQualityReviewInput = Readonly<{
  preview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  review:
    | Readonly<{ kind: "interior"; creativeReviewHandle: string }>
    | Readonly<{ kind: "terminal-endpoint"; endpointWitnessHandle: string }>;
}>;
export type StoredQualityReview = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-preview-quality-review@1";
  id: string;
  sha256: string;
  identity: CheckpointStoryboardRecordIdentity;
  root: CheckpointStoryboardRecordIdentity;
  b1a: Readonly<{ bindingId: string; bindingSha256: string; c6bReceiptFingerprint: string }>;
  preview: Readonly<{
    targetSha256: string;
    receiptSha256: string;
    pngSha256: string;
    snapshotSha256: string;
    width: number;
    height: number;
    runtimeEvidence: "host-browser" | "source-test";
    sampling: Readonly<{ mode: "interior" | "terminal-boundary"; renderedAtMs: number; documentDurationMs: number; interval: "[0,D)"; layerContent: "included" | "excluded-no-hold" }>;
    terminalBoundarySha256?: string;
  }>;
  b1c: Readonly<{ bindingId: string; bindingSha256: string; hostHandleDigest: string; samplingSha256: string }>;
  review:
    | Readonly<{ kind: "interior"; creativeHandleDigest: string }>
    | Readonly<{
      kind: "terminal-endpoint";
      endpointWitnessDigest: string;
      endpointAtUs: number;
      /** Signed non-sensitive endpoint fact; neither a shot id nor a host review record. */
      selectedShotEndUs: number;
      relation: "adjacent-end-exclusive";
      claims: Readonly<{ visibleFinalState: false; heldLayerContent: false; humanPixelReview: false; finalMedia: false }>;
    }>;
  profile: Readonly<{ id: typeof QUALITY_PROFILE; sha256: typeof QUALITY_PROFILE_SHA256; checks: readonly ["authenticated-png-pair", "decoded-png", "dimensions"] }>;
  verdict: "passed" | "failed";
  failure?: "invalid_png" | "png_dimension_mismatch";
  /** B1e deliberately cannot produce or transport any final acceptance decision. */
  finalAcceptance: "unavailable";
}>;
export type QualityReviewIntent = Readonly<{
  schema: "shellx-motion/private-checkpoint-storyboard-preview-quality-review-intent@1";
  id: string;
  sha256: string;
  root: CheckpointStoryboardRecordIdentity;
  identity: CheckpointStoryboardRecordIdentity;
  receipt: Readonly<{ id: string; sha256: string }>;
}>;
export type QualityReviewJournal = Readonly<{
  receipts: readonly StoredQualityReview[];
  pending?: Readonly<{ intent: QualityReviewIntent }>;
}>;
