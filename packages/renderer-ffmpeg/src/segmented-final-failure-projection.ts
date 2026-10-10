/** Public V1 failure projection remains separate from internal lifecycle and cleanup implementation. */
import type { LocalMotionJobEvidence, PublicationCommitUncertainEvidence } from "@shellx-motion/core";
import { SegmentedPublicationIdentityError } from "./segmented-final-internal/segmented-final-adapter-store.js";
import type { SegmentedFinalFailureEvidence } from "./segmented-final-internal/segmented-final-adapter-types.js";
import type { RenderSegmentedFinalResult, SegmentedFinalErrorCode, SegmentedFinalPublicFailure } from "./segmented-final.js";

/** Public direct-final failures retain the exact artifact whose post-link proof did not settle. */
export function segmentedPublicationUncertainty(error: unknown): Pick<SegmentedFinalPublicFailure, "possiblyCommitted" | "publicPaths" | "expectedPublications"> | undefined {
  if (!(error instanceof SegmentedPublicationIdentityError)) return undefined;
  return { possiblyCommitted: true, publicPaths: [error.expectedPublication.publicPath], expectedPublications: [error.expectedPublication] };
}

export function resourceMessage(code: Extract<SegmentedFinalErrorCode, `job_${string}`>): string {
  if (code === "job_cancelled") return "Segmented final delivery was cancelled; retry with segmented.resume to continue from verified checkpoints.";
  if (code === "job_deadline_exceeded") return "Segmented final delivery reached its deadline; retry with segmented.resume after increasing the host deadline.";
  if (code === "job_rss_limit_exceeded") return "Segmented final delivery exceeded the host memory limit; retry after increasing the configured render budget.";
  return "Segmented final delivery exceeded the host scratch-space budget; free space or increase the configured budget before retrying.";
}

export function publicFailure(
  code: SegmentedFinalErrorCode,
  message: string,
  retryable: boolean,
  evidence: SegmentedFinalFailureEvidence,
  resources?: LocalMotionJobEvidence,
  uncertainty?: Pick<SegmentedFinalPublicFailure, "possiblyCommitted" | "publicPaths" | "expectedPublications">
): RenderSegmentedFinalResult {
  return { ok: false, error: { code, message, retryable, evidence, ...(resources ? { resources } : {}), ...uncertainty } };
}
