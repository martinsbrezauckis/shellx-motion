/** Immutable error assembly for internal segmented-final failures. */
import type { RenderSegmentSpoolFailureEvidence } from "./render-segment-spool-types.js";
import {
  SegmentedFinalAdapterFailure,
  type SegmentedFinalFailureEvidence,
  type SegmentedFinalFailureTransportEvidence
} from "./segmented-final-adapter-types.js";

export interface AdmittedResourceFailureSidecar {
  phase: SegmentedFinalFailureEvidence["phase"];
  transport?: SegmentedFinalFailureTransportEvidence;
  spool?: RenderSegmentSpoolFailureEvidence;
  partialOutput?: SegmentedFinalFailureEvidence["partialOutput"];
  publication?: SegmentedFinalFailureEvidence["publication"];
  cleanupCauses: readonly unknown[];
}

export function admittedFailure(
  code: string,
  phase: SegmentedFinalFailureEvidence["phase"],
  primaryCause: unknown,
  cleanupCauses: readonly unknown[] = [],
  transport?: SegmentedFinalFailureTransportEvidence,
  partialOutput?: SegmentedFinalFailureEvidence["partialOutput"],
  publication: SegmentedFinalFailureEvidence["publication"] = "not_published"
): SegmentedFinalAdapterFailure {
  return new SegmentedFinalAdapterFailure(
    code,
    {
      phase,
      ...(transport ? { transport } : {}),
      ...(partialOutput ? { partialOutput } : {}),
      publication
    },
    primaryCause,
    cleanupCauses
  );
}
