/** Final-only B2 projection; range-local Browser ledgers never leak into this aggregate. */
import type { RenderSegmentGpuHybridIdentity } from "./render-segment-store-types.js";

export const RENDER_GPU_HYBRID_SEGMENT_AGGREGATE_PRODUCER_SCHEMA = "shellx-motion/gpu-hybrid-segment-aggregate-producer@1" as const;

export interface RenderSegmentGpuHybridAggregateProducerEvidence {
  schema: typeof RENDER_GPU_HYBRID_SEGMENT_AGGREGATE_PRODUCER_SCHEMA;
  frameLane: "gpu";
  identity: RenderSegmentGpuHybridIdentity;
  frameSequenceSha256: string;
  framePlanSequenceSha256: string;
  framePlanFingerprints: readonly string[];
  hybrid: {
    rangeCount: number;
    captureCount: number;
    captureSequenceSha256: string;
    rangeLedgerSequenceSha256: string;
  };
  finalReceiptInputHashes: Record<string, string>;
  scriptExecution?: never;
  warningUnion: readonly string[];
  warningsOmitted: number;
}
