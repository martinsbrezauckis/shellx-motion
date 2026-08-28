import type { GpuEffectModuleStaticDescriptor } from "@shellx-motion/core";
import type {
  GpuEffectModuleFinalReceiptEvidence
} from "@shellx-motion/renderer-browser";
import type {
  RenderSegmentGpuBaseIdentity,
  RenderSegmentGpuStandardRangeProducerEvidence
} from "./render-segment-store-types.js";

export const RENDER_GPU_EFFECT_MODULE_SEGMENTED_IDENTITY_SCHEMA = "shellx-motion/gpu-effect-module-segmented-identity@1" as const;
export const RENDER_GPU_EFFECT_MODULE_SEGMENT_RANGE_PRODUCER_SCHEMA = "shellx-motion/gpu-effect-module-segment-range-producer@1" as const;
export const RENDER_GPU_EFFECT_MODULE_SEGMENT_AGGREGATE_PRODUCER_SCHEMA = "shellx-motion/gpu-effect-module-segment-aggregate-producer@1" as const;
export const RENDER_GPU_EFFECT_MODULE_SEGMENT_STORE_SCHEMA = "shellx-motion/gpu-effect-module-render-segment-store@1" as const;

/** Immutable closed module descriptors, separate from the legacy GPU identity. */
export interface RenderSegmentGpuEffectModuleIdentity extends RenderSegmentGpuBaseIdentity {
  schema: typeof RENDER_GPU_EFFECT_MODULE_SEGMENTED_IDENTITY_SCHEMA;
  effectModules: {
    schema: "shellx-motion/gpu-segmented-effect-module-descriptors@1";
    descriptors: readonly GpuEffectModuleStaticDescriptor[];
    descriptorSequenceSha256: string;
  };
}

/** A pending Browser ledger and its post-release lease proof for one durable range. */
export interface RenderSegmentGpuEffectModuleRangeUseEvidence {
  schema: "shellx-motion/gpu-effect-module-segment-range-use@1";
  pending: {
    schema: "shellx-motion/gpu-effect-module-streaming-use@1";
    ledger: unknown;
    resources: {
      live: { uniformBufferSlots: 1; uniformBytes: 160; bindGroupSlots: 1; passes: number; frames: number; lateAllocationRefusals: 0; persistentTextureCount: 0 } | null;
      terminal: { uniformBufferSlots: 0; uniformBytes: 0; bindGroupSlots: 0; pipelineReleases: 1; preparedBindGroupReleases: 1; arenaUniformBufferDestructions: 1 } | null;
    };
    runtimeCleanup: "complete" | "failed";
    leaseRelease: "outer-host-owned-pending";
  };
  released: GpuEffectModuleFinalReceiptEvidence;
}

export interface RenderSegmentGpuEffectModuleRangeProducerEvidence extends Omit<RenderSegmentGpuStandardRangeProducerEvidence, "schema" | "identity"> {
  schema: typeof RENDER_GPU_EFFECT_MODULE_SEGMENT_RANGE_PRODUCER_SCHEMA;
  identity: RenderSegmentGpuEffectModuleIdentity;
  effectModules: RenderSegmentGpuEffectModuleRangeUseEvidence;
}

/** Receipt-safe aggregate: per-range details are committed only through digests. */
export interface RenderSegmentGpuEffectModuleAggregateProducerEvidence {
  schema: typeof RENDER_GPU_EFFECT_MODULE_SEGMENT_AGGREGATE_PRODUCER_SCHEMA;
  frameLane: "gpu";
  identity: RenderSegmentGpuEffectModuleIdentity;
  frameSequenceSha256: string;
  framePlanSequenceSha256: string;
  framePlanFingerprints: readonly string[];
  effectModules: {
    rangeCount: number;
    applicationCount: number;
    applicationSequenceSha256: string;
    rangeUseSequenceSha256: string;
    release: "all-ranges-released";
  };
  finalReceiptInputHashes: Record<string, string>;
  scriptExecution?: never;
  warningUnion: readonly string[];
  warningsOmitted: number;
}
