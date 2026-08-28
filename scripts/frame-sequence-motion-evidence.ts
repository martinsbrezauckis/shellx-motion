/**
 * Bounded, path-free motion-density evidence for a complete rendered PNG sequence.
 *
 * This intentionally delegates both decoding and the grain-resistant still classification to
 * Core's `inspectFrameSequence`. Callers cannot accidentally substitute hash diversity, sparse
 * sampling, or a luma-only comparison for the product measurement.
 */
import { inspectFrameSequence } from "../packages/core/src/quality";

export const FRAME_SEQUENCE_MOTION_EVIDENCE_SCHEMA = "shellx-motion/frame-sequence-motion-evidence@1" as const;

export interface FrozenRangeEvidence {
  startMs: number;
  endMs: number;
  durationMs: number;
  holds: number;
}

export interface FrameSequenceMotionEvidence {
  schema: typeof FRAME_SEQUENCE_MOTION_EVIDENCE_SCHEMA;
  analyzedFrameCount: number;
  comparisons: number;
  frozenRatio: number;
  longestFrozenMs: number;
  longestFrozenSpanMs: number;
  frozenRunCount: number;
  frozenRangeCount: number;
  frozenRanges: FrozenRangeEvidence[];
  omittedFrozenRangeCount: number;
  meanFrameDifference: number;
  maxFrameDifference: number;
  meanChangedPixelRatio: number;
  maxChangedPixelRatio: number;
}

/**
 * Inspect every supplied frame and return only compact motion evidence suitable for a receipt or
 * release-proof record. It refuses failed, unavailable, sampled, or incomplete analysis rather
 * than turning those states into a deceptively quiet zero-valued result.
 */
export async function inspectCompleteFrameSequenceMotionEvidence(input: {
  framePaths: string[];
  durationMs: number;
  fps: number;
}): Promise<FrameSequenceMotionEvidence> {
  const inspection = await inspectFrameSequence(input);
  if (!inspection.ok) {
    // Core's invalid-frame message can contain an absolute source-frame path. The durable proof
    // record needs only the stable failure class, never a scratch location.
    throw new Error(`Frame sequence inspection failed: ${inspection.code}.`);
  }

  const motion = inspection.summary.motion;
  if (motion.status !== "analyzed") {
    throw new Error("Frame sequence motion analysis was unavailable.");
  }
  if (motion.coverage !== "complete" || motion.frameCount !== input.framePaths.length) {
    throw new Error("Frame sequence motion analysis was not complete.");
  }
  if (motion.frozenRanges.length > motion.policy.maxReportedRanges) {
    throw new Error("Frame sequence motion analysis exceeded its bounded range policy.");
  }

  return {
    schema: FRAME_SEQUENCE_MOTION_EVIDENCE_SCHEMA,
    analyzedFrameCount: motion.frameCount,
    comparisons: motion.comparisons,
    frozenRatio: motion.frozenRatio,
    longestFrozenMs: motion.longestFrozenMs,
    longestFrozenSpanMs: motion.longestFrozenSpanMs,
    frozenRunCount: motion.frozenRunCount,
    frozenRangeCount: motion.frozenRanges.length + motion.omittedRanges,
    frozenRanges: motion.frozenRanges.map((range) => ({
      startMs: range.startMs,
      endMs: range.endMs,
      durationMs: range.durationMs,
      holds: range.holds
    })),
    omittedFrozenRangeCount: motion.omittedRanges,
    meanFrameDifference: motion.meanFrameDifference,
    maxFrameDifference: motion.maxFrameDifference,
    meanChangedPixelRatio: motion.meanChangedPixelRatio,
    maxChangedPixelRatio: motion.maxChangedPixelRatio
  };
}
