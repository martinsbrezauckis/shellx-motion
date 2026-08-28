import { assertLocalMotionFrameCountBudget, LocalMotionJobError } from "@shellx-motion/core";

/** A closed-open range over the native producer's canonical full timeline. */
export interface NativeFrameProducerRange {
  startFrameIndex: number;
  endFrameIndexExclusive: number;
}

/** Bounded range evidence for one native producer attempt. */
export interface NativeFrameProducerRangeEvidence extends NativeFrameProducerRange {
  timelineFrameCount: number;
  frameCount: number;
}

export function resolveNativeFrameProducerRange(
  range: NativeFrameProducerRange | undefined,
  timelineFrameCount: number
): NativeFrameProducerRangeEvidence {
  // A small selected range must not bypass the package-wide local frame budget.
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
      `Native streamed frame range must be nonempty safe integers within canonical timeline [0, ${timelineFrameCount}).`
    );
  }
  return {
    timelineFrameCount,
    startFrameIndex,
    endFrameIndexExclusive,
    frameCount: endFrameIndexExclusive - startFrameIndex
  };
}

/** Validate the legacy full-timeline fields before an optional range can select from them. */
export function assertNativeFrameProducerTimeline(input: {
  frameCount: number;
  fps: number;
  durationMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.frameCount)
    || input.frameCount <= 0
    || !Number.isFinite(input.fps)
    || input.fps <= 0
    || !Number.isFinite(input.durationMs)
    || input.durationMs <= 0
  ) {
    throw new LocalMotionJobError(
      "job_input_budget_exceeded",
      "Native streamed frame production requires a positive frameCount, fps, and durationMs."
    );
  }
  assertLocalMotionFrameCountBudget(input.frameCount);
  const expectedFrameCount = Math.ceil((input.durationMs / 1_000) * input.fps);
  if (input.frameCount !== expectedFrameCount) {
    throw new LocalMotionJobError(
      "job_input_budget_exceeded",
      `Streaming frameCount ${input.frameCount} must equal ceil(durationMs / 1000 * fps) (${expectedFrameCount}).`
    );
  }
}
