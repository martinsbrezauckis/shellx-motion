export const FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA = "shellx-motion/frame-checkpoint-manifest-request@1" as const;
export const FRAME_CHECKPOINT_MANIFEST_SCHEMA = "shellx-motion/frame-checkpoint-manifest@1" as const;
export const FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA = "shellx-motion/frame-checkpoint-output-append@1" as const;
export const FRAME_CHECKPOINT_EVALUATOR_VERSION = "motion.frame-checkpoint-evaluator@1" as const;

export const FRAME_CHECKPOINT_MANIFEST_LIMITS = Object.freeze({
  maxTotalFrames: 3_600 as const,
  maxWindowFrames: 64 as const,
  maxInputs: 16 as const,
  maxCheckpoints: 64 as const,
  maxOutputHashes: 64 as const,
  maxRateNumerator: 240_240 as const,
  maxRateDenominator: 1_001 as const,
  maxFramesPerSecond: 240 as const,
});

export interface FrameCheckpointManifestRequest {
  readonly schema: typeof FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA;
  readonly evaluatorVersion: typeof FRAME_CHECKPOINT_EVALUATOR_VERSION;
  readonly seed: number;
  readonly rate: { readonly numerator: number; readonly denominator: number };
  readonly totalFrameCount: number;
  readonly frameRange: { readonly startFrameIndex: number; readonly frameCount: number };
  readonly inputs: readonly { readonly inputId: string; readonly sha256: string }[];
  readonly checkpoints: readonly { readonly checkpointId: string; readonly atUs: number; readonly sha256: string }[];
}

export interface FrameCheckpointOutputAppend {
  readonly schema: typeof FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA;
  readonly entries: readonly { readonly frameIndex: number; readonly sha256: string }[];
}

export interface FrameCheckpointManifest {
  readonly schema: typeof FRAME_CHECKPOINT_MANIFEST_SCHEMA;
  readonly evaluatorVersion: typeof FRAME_CHECKPOINT_EVALUATOR_VERSION;
  readonly seed: number;
  readonly rate: FrameCheckpointManifestRequest["rate"];
  readonly totalFrameCount: number;
  readonly frameRange: FrameCheckpointManifestRequest["frameRange"];
  readonly inputs: FrameCheckpointManifestRequest["inputs"];
  readonly inputsSha256: string;
  readonly checkpoints: readonly {
    readonly checkpointId: string;
    readonly atUs: number;
    readonly sha256: string;
    readonly frameIndex: number;
    readonly frameAtUs: number;
    readonly offsetUs: number;
  }[];
  readonly frames: readonly { readonly frameIndex: number; readonly atUs: number; readonly checkpointIds: readonly string[] }[];
  readonly outputHashRange: {
    readonly startFrameIndex: number;
    readonly entries: readonly { readonly frameIndex: number; readonly sha256: string }[];
  };
  readonly resume: { readonly completedFrameCount: number; readonly nextFrameIndex: number | null; readonly windowComplete: boolean };
  readonly requestSha256: string;
  readonly revision: number;
  readonly parentFingerprint?: string;
  readonly evidence: {
    readonly timeMapping: "floor-rational-frame-time-to-microseconds";
    readonly reducedRationalRate: true;
    readonly exactInputHashes: true;
    readonly contiguousOutputHashRange: true;
    readonly noIO: true;
    readonly noStore: true;
    readonly noRenderer: true;
    readonly noFinalMedia: true;
    readonly noPublicCoreRoot: true;
  };
  readonly fingerprint: string;
}
