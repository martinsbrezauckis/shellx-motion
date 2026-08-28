import { assertLocalMotionFrameCountBudget, LocalMotionJobError } from "@shellx-motion/core";

/** A closed-open range over the canonical full Motion timeline. */
export interface BrowserStreamingFrameRange {
  startFrameIndex: number;
  endFrameIndexExclusive: number;
}

/** Bounded range evidence retained by a browser producer attempt. */
export interface BrowserStreamingFrameRangeEvidence extends BrowserStreamingFrameRange {
  /** Frame count of the package's complete canonical timeline, not just this producer attempt. */
  timelineFrameCount: number;
  /** Number of canonical frames selected for this producer attempt. */
  frameCount: number;
}

export function resolveBrowserStreamingFrameRange(
  range: BrowserStreamingFrameRange | undefined,
  timelineFrameCount: number
): BrowserStreamingFrameRangeEvidence {
  // The global timeline budget is authoritative even when an attempt selects only a short range.
  assertLocalMotionFrameCountBudget(timelineFrameCount);
  const startFrameIndex = range?.startFrameIndex ?? 0;
  const endFrameIndexExclusive = range?.endFrameIndexExclusive ?? timelineFrameCount;
  if (
    !Number.isSafeInteger(startFrameIndex)
    || !Number.isSafeInteger(endFrameIndexExclusive)
    || startFrameIndex < 0
    || endFrameIndexExclusive <= startFrameIndex
    || endFrameIndexExclusive > timelineFrameCount
  ) {
    throw new LocalMotionJobError(
      "job_input_budget_exceeded",
      `Browser streamed frame range must be nonempty safe integers within canonical timeline [0, ${timelineFrameCount}).`
    );
  }
  return {
    timelineFrameCount,
    startFrameIndex,
    endFrameIndexExclusive,
    frameCount: endFrameIndexExclusive - startFrameIndex
  };
}
