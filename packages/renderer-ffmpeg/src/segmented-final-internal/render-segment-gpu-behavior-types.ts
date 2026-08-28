import type {
  RenderSegmentGpuBaseIdentity,
  RenderSegmentGpuStandardRangeProducerEvidence
} from "./render-segment-store-types.js";
import type { GpuSceneBehaviorFrameEvidenceFact } from "@shellx-motion/core";

export const RENDER_GPU_BEHAVIOR_SEGMENTED_IDENTITY_SCHEMA = "shellx-motion/gpu-behavior-segmented-identity@1" as const;
export const RENDER_GPU_BEHAVIOR_SEGMENT_RANGE_PRODUCER_SCHEMA = "shellx-motion/gpu-behavior-segment-range-producer@1" as const;
export const RENDER_GPU_BEHAVIOR_SEGMENT_AGGREGATE_PRODUCER_SCHEMA = "shellx-motion/gpu-behavior-segment-aggregate-producer@1" as const;
export const RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA = "shellx-motion/gpu-behavior-render-segment-store@1" as const;
/** Full schedules persist once and range slices once; behavior stores never use the generic 36k maximum. */
export const MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES = 16_000;

/** Separate durable identity; legacy GPU segment stores remain wire-identical. */
export interface RenderSegmentGpuBehaviorIdentity extends RenderSegmentGpuBaseIdentity {
  schema: typeof RENDER_GPU_BEHAVIOR_SEGMENTED_IDENTITY_SCHEMA;
  behaviors: {
    staticFingerprint: string;
    baseStaticFingerprint: string;
    behaviorStaticFingerprint: string;
    behaviorSourceSha256: string;
    targetLayerIds: readonly string[];
    staticBudget: {
      baseResourceReferenceCount: number;
      behaviorInputBytes: number;
      bindingCount: number;
      enabledBindingCount: number;
      behaviorFrameWorkUnits: number;
    };
    /** Whole-document Core schedule, computed before the durable store opens. */
    frames: readonly GpuSceneBehaviorFrameEvidenceFact[];
    framePlanSequenceSha256: string;
    frameBudgetSequenceSha256: string;
  };
}

/** Range checkpoints retain only their slice; the full schedule lives once in the store producer. */
export interface RenderSegmentGpuBehaviorRangeIdentity extends Omit<RenderSegmentGpuBehaviorIdentity, "behaviors"> {
  behaviors: Omit<RenderSegmentGpuBehaviorIdentity["behaviors"], "frames">;
}

export function renderSegmentGpuBehaviorRangeIdentity(identity: RenderSegmentGpuBehaviorIdentity): RenderSegmentGpuBehaviorRangeIdentity {
  const { frames: _frames, ...behaviors } = identity.behaviors;
  return Object.freeze({ ...identity, behaviors: Object.freeze({ ...behaviors }) });
}

export interface RenderSegmentGpuBehaviorRangeProducerEvidence extends Omit<RenderSegmentGpuStandardRangeProducerEvidence, "schema" | "identity"> {
  schema: typeof RENDER_GPU_BEHAVIOR_SEGMENT_RANGE_PRODUCER_SCHEMA;
  identity: RenderSegmentGpuBehaviorRangeIdentity;
  behaviors: { readonly frames: readonly GpuSceneBehaviorFrameEvidenceFact[]; framePlanSequenceSha256: string; frameBudgetSequenceSha256: string };
}

export interface RenderSegmentGpuBehaviorAggregateProducerEvidence extends Omit<RenderSegmentGpuBehaviorRangeProducerEvidence, "schema" | "behaviors"> {
  schema: typeof RENDER_GPU_BEHAVIOR_SEGMENT_AGGREGATE_PRODUCER_SCHEMA;
  behaviors: {
    rangeCount: number;
    framePlanRangeSequenceSha256: string;
    frameBudgetRangeSequenceSha256: string;
  };
}
