/** Core-derived behavior proof prepared before a durable segmented store exists. */
import {
  compileGpuSceneBehaviorFramePlan,
  gpuSceneBehaviorFrameEvidenceFact,
  gpuSceneBehaviorFrameEvidenceSequences,
  gpuVideoTimelineAtUs,
  streamingFrameTimestampMs,
  type GpuSceneBehaviorFrameEvidenceFact,
  type MotionDocument
} from "@shellx-motion/core";
import type { PreparedGpuSceneResources } from "@shellx-motion/renderer-browser";
import type { RenderSegmentSpoolTimelineFacts } from "./segmented-final-internal/render-segment-spool-types.js";
import { MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES } from "./segmented-final-internal/render-segment-gpu-behavior-types.js";

export function compileSegmentedGpuBehaviorSchedule(input: { motion: MotionDocument; timeline: RenderSegmentSpoolTimelineFacts; resources: PreparedGpuSceneResources }): Readonly<{ frames: readonly GpuSceneBehaviorFrameEvidenceFact[]; framePlanSequenceSha256: string; frameBudgetSequenceSha256: string }> {
  if (!Number.isSafeInteger(input.timeline.frameCount) || input.timeline.frameCount < 1 || input.timeline.frameCount > MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES) {
    throw new Error(`GPU behavior segmented schedule stores at most ${MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES} Core frame facts before durable output.`);
  }
  if (input.timeline.durationMs !== input.motion.durationMs || input.timeline.fps !== input.motion.fps) {
    throw new Error("GPU behavior segmented schedule requires the exact Motion duration and fps timeline.");
  }
  const frames: GpuSceneBehaviorFrameEvidenceFact[] = [];
  for (let index = 0; index < input.timeline.frameCount; index += 1) {
    const atMs = streamingFrameTimestampMs(index, input.timeline.fps, input.timeline.durationMs);
    const atUs = gpuVideoTimelineAtUs(atMs);
    if (atUs === null) throw new Error("GPU behavior segmented schedule cannot represent a canonical frame timestamp as integer microseconds.");
    const compiled = compileGpuSceneBehaviorFramePlan(input.motion, atUs, { images: input.resources.images, fonts: input.resources.fonts });
    if (!compiled.ok) throw new Error(`GPU behavior segmented schedule refused frame ${index}: ${compiled.failure.message}`);
    frames.push(gpuSceneBehaviorFrameEvidenceFact(index, atMs, compiled.plan));
  }
  return Object.freeze({ frames: Object.freeze(frames), ...gpuSceneBehaviorFrameEvidenceSequences(frames) });
}
