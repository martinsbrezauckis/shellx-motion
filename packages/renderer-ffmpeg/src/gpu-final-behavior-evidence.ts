import { gpuSceneBehaviorFrameEvidenceSequences } from "@shellx-motion/core";
import type { GpuStreamingFrameProducerEvidence } from "@shellx-motion/renderer-browser";

const SHA256 = /^[a-f0-9]{64}$/;
type GpuStreamingBehaviorEvidence = NonNullable<GpuStreamingFrameProducerEvidence["behaviors"]>;
export type ExactGpuBehaviorEvidence = GpuStreamingBehaviorEvidence & { framePlanSequenceSha256: string; frameBudgetSequenceSha256: string };

export function exactGpuBehaviorEvidence(value: GpuStreamingBehaviorEvidence | undefined): ExactGpuBehaviorEvidence | undefined {
  if (!value || value.schema !== "shellx-motion/gpu-scene-behavior-streaming@1" || ![value.staticFingerprint, value.baseStaticFingerprint, value.behaviorStaticFingerprint, value.behaviorSourceSha256, value.framePlanSequenceSha256, value.frameBudgetSequenceSha256].every((entry) => typeof entry === "string" && SHA256.test(entry))
    || !Array.isArray(value.targetLayerIds) || value.targetLayerIds.length > 32 || new Set(value.targetLayerIds).size !== value.targetLayerIds.length || value.targetLayerIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128)
    || !Number.isSafeInteger(value.staticBudget.baseResourceReferenceCount) || value.staticBudget.baseResourceReferenceCount < 0 || !Number.isSafeInteger(value.staticBudget.behaviorInputBytes) || value.staticBudget.behaviorInputBytes < 1 || !Number.isSafeInteger(value.staticBudget.bindingCount) || value.staticBudget.bindingCount < 1 || value.staticBudget.bindingCount > 32 || !Number.isSafeInteger(value.staticBudget.enabledBindingCount) || value.staticBudget.enabledBindingCount < 0 || value.staticBudget.enabledBindingCount > value.staticBudget.bindingCount || !Number.isSafeInteger(value.staticBudget.behaviorFrameWorkUnits) || value.staticBudget.behaviorFrameWorkUnits < 0
    || !Array.isArray(value.frames) || value.frames.length > 36_000 || value.frames.some((frame, index) => !Number.isSafeInteger(frame.index) || frame.index < 0 || (index > 0 && frame.index <= value.frames[index - 1]!.index) || !Number.isFinite(frame.atMs) || !Number.isSafeInteger(frame.atUs) || frame.atUs < 0 || !SHA256.test(frame.fingerprint) || !SHA256.test(frame.budgetSha256))) return undefined;
  const sequences = gpuSceneBehaviorFrameEvidenceSequences(value.frames);
  if (sequences.framePlanSequenceSha256 !== value.framePlanSequenceSha256 || sequences.frameBudgetSequenceSha256 !== value.frameBudgetSequenceSha256) return undefined;
  return value as ExactGpuBehaviorEvidence;
}
