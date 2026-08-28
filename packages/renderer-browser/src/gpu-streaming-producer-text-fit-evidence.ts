import type { GpuTextFitEvidence } from "./gpu-runtime-types";
import type { MutableGpuStreamingEvidence } from "./gpu-streaming-producer-state";

const MAX_RETAINED_TEXT_FIT_OBSERVATIONS = 128;

/** Retains bounded browser glyph-layout facts without retaining text or pixel data. */
export function bindGpuTextFitEvidence(
  evidence: MutableGpuStreamingEvidence,
  atMs: number,
  textFit: readonly GpuTextFitEvidence[]
): void {
  const previous = evidence.typography.textFit;
  if (!previous && textFit.length === 0) return;
  const observations = [...(previous?.observations ?? [])];
  let omittedObservationCount = previous?.omittedObservationCount ?? 0;
  for (const observation of textFit) {
    if (observations.length >= MAX_RETAINED_TEXT_FIT_OBSERVATIONS) {
      omittedObservationCount += 1;
      continue;
    }
    observations.push({ ...observation, atMs });
  }
  evidence.typography = {
    ...evidence.typography,
    textFit: {
      authority: "browser-canvas-glyph-bounds",
      checkedFrameCount: (previous?.checkedFrameCount ?? 0) + 1,
      retainedObservationCount: observations.length,
      omittedObservationCount,
      observations
    }
  };
}
