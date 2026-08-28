import { canonicalJson, gpuSceneBehaviorFrameEvidenceSequences } from "@shellx-motion/core";
import type { GpuEnvironmentArenaEvidence } from "./gpu-final-receipt-provenance.js";
import type { ExactGpuBehaviorEvidence } from "./gpu-final-behavior-evidence.js";
import { renderSegmentGpuBehaviorRangeIdentity, type RenderSegmentGpuBehaviorIdentity, type RenderSegmentGpuBehaviorRangeProducerEvidence } from "./segmented-final-internal/render-segment-gpu-behavior-types.js";

type Range = { startFrame: number; endFrameExclusive: number };
export function gpuBehaviorRangeProblem(identity: RenderSegmentGpuBehaviorIdentity, behavior: ExactGpuBehaviorEvidence | undefined, range: Range): string | undefined {
  const expected = identity.behaviors.frames.slice(range.startFrame, range.endFrameExclusive);
  const schedule = gpuSceneBehaviorFrameEvidenceSequences(identity.behaviors.frames);
  if (!behavior || behavior.staticFingerprint !== identity.behaviors.staticFingerprint || behavior.baseStaticFingerprint !== identity.behaviors.baseStaticFingerprint || behavior.behaviorStaticFingerprint !== identity.behaviors.behaviorStaticFingerprint || behavior.behaviorSourceSha256 !== identity.behaviors.behaviorSourceSha256 || canonicalJson(behavior.targetLayerIds) !== canonicalJson(identity.behaviors.targetLayerIds) || canonicalJson(behavior.staticBudget) !== canonicalJson(identity.behaviors.staticBudget) || schedule.framePlanSequenceSha256 !== identity.behaviors.framePlanSequenceSha256 || schedule.frameBudgetSequenceSha256 !== identity.behaviors.frameBudgetSequenceSha256 || canonicalJson(behavior.frames) !== canonicalJson(expected)) return "GPU behavior range did not retain the immutable Core behavior schedule.";
  return undefined;
}
export function gpuBehaviorRangeHashes(behavior: ExactGpuBehaviorEvidence): Record<string, string> {
  return { "gpu-behavior-static-plan": behavior.staticFingerprint, "gpu-behavior-base-static-plan": behavior.baseStaticFingerprint, "gpu-behavior-static": behavior.behaviorStaticFingerprint, "gpu-behavior-source": behavior.behaviorSourceSha256, "gpu-behavior-frame-plan-sequence": behavior.framePlanSequenceSha256!, "gpu-behavior-frame-budget-sequence": behavior.frameBudgetSequenceSha256! };
}
export function gpuBehaviorRangeEvidence(input: { identity: RenderSegmentGpuBehaviorIdentity; range: Range; frameSequenceSha256: string; framePlanSequenceSha256: string; framePlanFingerprints: readonly string[]; environmentArena?: GpuEnvironmentArenaEvidence; behavior: ExactGpuBehaviorEvidence; finalReceiptInputHashes: Record<string, string> }): RenderSegmentGpuBehaviorRangeProducerEvidence {
  return Object.freeze({ schema: "shellx-motion/gpu-behavior-segment-range-producer@1" as const, frameLane: "gpu" as const, identity: renderSegmentGpuBehaviorRangeIdentity(input.identity), frameSequenceSha256: input.frameSequenceSha256, framePlanSequenceSha256: input.framePlanSequenceSha256, framePlanFingerprints: Object.freeze([...input.framePlanFingerprints]), ...(input.environmentArena ? { environmentArena: input.environmentArena } : {}), behaviors: Object.freeze({ frames: Object.freeze(input.behavior.frames.map((frame) => Object.freeze({ ...frame }))), framePlanSequenceSha256: input.behavior.framePlanSequenceSha256, frameBudgetSequenceSha256: input.behavior.frameBudgetSequenceSha256 }), finalReceiptInputHashes: Object.freeze(input.finalReceiptInputHashes), warningUnion: [], warningsOmitted: 0 });
}
