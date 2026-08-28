/** Shared private contracts for the admitted GPU segmented-final host. */
import type { GpuSceneBehaviorStaticPlan, GpuSceneStaticPlan, RetainedDirectoryAuthority } from "@shellx-motion/core";
import type { GpuEffectModuleUseAuthority, GpuEffectModuleUseResolution } from "@shellx-motion/renderer-browser";
import type { StreamingFinalToolPolicy } from "./streaming-final-adapter-types.js";
import type { RenderSegmentStoreProducerFacts } from "./segmented-final-internal/render-segment-store-types.js";

/** Restricted to the normal strict GPU final policy; callers cannot provide an identity or producer. */
export type SegmentedGpuHostPolicy = NonNullable<StreamingFinalToolPolicy["gpu"]>;

/** Pure pre-governor closure; the opaque resolution cannot open a module. */
export interface SegmentedGpuStaticPreflight {
  readonly staticPlan: GpuSceneStaticPlan;
  readonly behaviorStaticPlan?: GpuSceneBehaviorStaticPlan;
  readonly effectModuleUse?: {
    readonly authority: GpuEffectModuleUseAuthority;
    readonly resolution: GpuEffectModuleUseResolution;
  };
}

/** Resources retained for the one admitted segment spool, concat, and finalization operation. */
export interface PreparedSegmentedGpuHost {
  readonly producer: Extract<RenderSegmentStoreProducerFacts, { frameLane: "gpu" }>;
  readonly createRangeProducer: import("./segmented-final-internal/render-segment-spool-types.js").RenderSegmentRangeProducerFactory;
  readonly audio: Pick<
    import("./segmented-final-internal/segmented-final-adapter-types.js").RenderSegmentedFinalInput,
    "audioPath" | "audio" | "audioTracks" | "inputRoots"
  >;
  /** Exact source hashes that every later package-content scan must retain. */
  readonly packageContentExpectedFileHashes?: Readonly<Record<string, string>>;
  readonly finalAudioSnapshotStaging?: {
    stagingRoot: string;
    authority: RetainedDirectoryAuthority;
  };
  /** Releases the exact private staging child after finalization has released audio snapshots. */
  release(): Promise<void>;
}
