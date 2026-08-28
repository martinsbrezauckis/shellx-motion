import { gpuSceneBehaviorFrameEvidenceSequences, type GpuSceneBehaviorFrameEvidenceFact, type GpuSceneBehaviorStaticPlan } from "@shellx-motion/core";
import type { GpuStreamingBehaviorEvidence } from "./gpu-streaming-producer-types";

export function gpuStreamingBehaviorEvidence(plan: GpuSceneBehaviorStaticPlan, frames: readonly GpuSceneBehaviorFrameEvidenceFact[]): GpuStreamingBehaviorEvidence {
  const sequences = gpuSceneBehaviorFrameEvidenceSequences(frames);
  return Object.freeze({
    schema: "shellx-motion/gpu-scene-behavior-streaming@1" as const,
    staticFingerprint: plan.fingerprint, baseStaticFingerprint: plan.baseStaticFingerprint,
    behaviorStaticFingerprint: plan.behaviorStaticFingerprint, behaviorSourceSha256: plan.behaviorSourceSha256,
    targetLayerIds: Object.freeze([...plan.targetLayerIds]), staticBudget: Object.freeze({ ...plan.budget }),
    frames: Object.freeze(frames.map((frame) => Object.freeze({ ...frame }))),
    ...sequences
  });
}
