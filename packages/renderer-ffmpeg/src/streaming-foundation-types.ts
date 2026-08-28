import type {
  FrameSequenceQualityPolicy,
  LocalMotionJobEvidence,
  LocalMotionJobGovernor,
  LocalMotionRuntimeSandboxEvidence
} from "@shellx-motion/core";
import type { FfmpegCommand, FfmpegProcessResult, FfmpegRunner } from "./index";
import type { StreamingFfmpegProcessFactory } from "./streaming-process";

export type StreamingFrameFormat = "png" | "rgba";

export type StreamingFrame =
  | { index: number; atMs: number; png: Buffer; format?: "png" }
  | {
      index: number;
      atMs: number;
      format: "rgba";
      rgba: Buffer;
      width: number;
      height: number;
      strideBytes: number;
      colorSpace: "srgb";
      alphaMode: "straight";
    };

export interface StreamingFrameSink {
  /** Write exactly one bounded frame, waiting for FFmpeg stdin drain before the next frame begins. */
  write(frame: StreamingFrame): Promise<void>;
}

/** A producer runs inside the encoder's existing governor job and must not acquire another slot. */
export interface StreamingProducerJobContext {
  readonly admission: "pre-acquired";
  readonly jobId: string;
  readonly scratchRoot: string;
  /** The outer governor's actual admitted tree limit, passed unchanged to GPU final Chromium containment. */
  readonly maxProcessTreeRssBytes?: number;
  readonly signal: AbortSignal;
  watchProcess(pid: number): void;
  reportSandbox(evidence: LocalMotionRuntimeSandboxEvidence): void;
}

/** Renderer-owned code implements this callback; FFmpeg never imports a browser or native renderer. */
export type StreamingFrameProducer = (
  sink: StreamingFrameSink,
  context: {
    signal: AbortSignal;
    attempt: StreamingEncodeAttempt;
    job: StreamingProducerJobContext;
    /** Execute producer work under the existing governor lease; never call governor.run again. */
    runAdmitted<T>(operation: (job: StreamingProducerJobContext) => Promise<T>): Promise<T>;
  }
) => Promise<void>;

/**
 * A narrow preparation hook which runs after the one outer FFmpeg lease is admitted and before
 * any encoder process is created.  It exists for producers (notably GPU video) whose immutable
 * source staging changes the final audio command.  The callback receives a runner that is bound
 * to that same lease; it cannot create a nested governor job.
 */
export interface StreamingFfmpegAdmittedPreparationContext {
  readonly job: StreamingProducerJobContext;
  readonly runner: FfmpegRunner;
}

export interface StreamingFfmpegAdmittedPreparation {
  readonly attempts: readonly StreamingEncodeAttempt[];
  readonly produce: StreamingFrameProducer;
}

export interface StreamingEncodeAttempt {
  /** Hardware is attempted first; software is an exact rerun, never a retained frame cache. */
  source: "hardware" | "software";
  encoder?: string;
  command: FfmpegCommand;
}

export interface StreamingQualityManifestBoundary {
  /** Current quality manifests need materialized exact source PNGs for decoded-media comparison. */
  exactSourceComparison?: "required";
}

/**
 * Exact result of an encoder attempt observed by the streaming handoff. A retry is recorded only
 * after that attempt actually stopped; callers must never infer a retry from the selected command.
 */
export interface StreamingEncodeAttemptOutcome {
  source: "hardware" | "software";
  encoder?: string;
  outcome: "succeeded" | "failed";
  failure?: {
    code: StreamingFfmpegFailureCode;
    message: string;
    process?: { exitCode: number; timedOut: boolean };
  };
}

/** Bounded state owned by the encoder handoff, deliberately not a claim about a producer cache. */
export interface StreamingFfmpegHandoffEvidence {
  delivery: "streamed";
  frameFormat: StreamingFrameFormat;
  /** One producer call may be active; Node's byte queue is reported separately. */
  maxConcurrentProducerWrites: 1;
  observedMaxConcurrentProducerWrites: number;
  maxBufferedInputBytes: number;
  inputHighWaterMarkBytes: number;
  /** The exact transport-specific frame ceiling. */
  maxFrameBytesPerFrame: number;
  /** Present only for the compatibility image2pipe transport. */
  maxPngBytesPerFrame?: number;
  /** Present only for tightly packed raw RGBA. */
  maxRgbaBytesPerFrame?: number;
  backpressure: { writes: number; drainWaits: number };
  /** The handoff retains no source PNG after its write resolves. It makes no claim about the producer. */
  encoderHandoffSourceFramesRetained: 0;
  /** Fixed quality working-set capacity, not a terminal-retention claim. */
  qualityPlaneSetCapacity: 2;
  uniqueHashCapacity: number;
  attempts: StreamingEncodeAttemptOutcome[];
  frameSequence?: { schema: "shellx-motion/streamed-frame-sequence@1"; sha256: string };
  quality?: { warnings: string[]; frameCount: number; blankFrames: number; uniqueFrameHashes: number; uniqueFrameHashesExact: boolean };
}

export interface StreamingFfmpegFinalInput {
  frameCount: number;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  /** Defaults to the existing PNG image2pipe compatibility transport. */
  frameFormat?: StreamingFrameFormat;
  quality?: FrameSequenceQualityPolicy;
  /** Required unless {@link admittedPrepare} supplies the real attempt set after admission. */
  attempts?: readonly StreamingEncodeAttempt[];
  /** Required unless {@link admittedPrepare} supplies the real producer after admission. */
  produce?: StreamingFrameProducer;
  /**
   * Replaces the provisional attempts/producer after an outer lease is admitted.  The provisional
   * values are still structurally validated before admission; this hook's returned values are
   * revalidated before any encoder launch.  The hook owner retains and releases any staged files
   * after final receipt binding, because encoder audio input hashes may still need them.
   */
  admittedPrepare?: (context: StreamingFfmpegAdmittedPreparationContext) => Promise<StreamingFfmpegAdmittedPreparation>;
  signal?: AbortSignal;
  governor?: LocalMotionJobGovernor;
  scratchRoot?: string;
  operation?: string;
  callerId?: string;
  jobId?: string;
  qualityManifest?: StreamingQualityManifestBoundary;
  processFactory?: StreamingFfmpegProcessFactory;
}

export type StreamingFfmpegFinalResult =
  | {
      ok: true;
      command: FfmpegCommand;
      output: FfmpegProcessResult;
      evidence: StreamingFfmpegHandoffEvidence & {
        frameSequence: { schema: "shellx-motion/streamed-frame-sequence@1"; sha256: string };
        quality: { warnings: string[]; frameCount: number; blankFrames: number; uniqueFrameHashes: number; uniqueFrameHashesExact: boolean };
        resources: LocalMotionJobEvidence;
      };
    }
  | {
      ok: false;
      error: {
        code: StreamingFfmpegFailureCode;
        message: string;
        process?: { exitCode: number; timedOut: boolean };
        resources?: LocalMotionJobEvidence;
        /** Partial handoff evidence, including every attempt that actually ran. */
        handoff?: StreamingFfmpegHandoffEvidence;
      };
    };

export type StreamingFfmpegFailureCode =
  | "encoder_failed"
  | "frame_quality_failed"
  | "invalid_frame"
  | "producer_failed"
  | "streaming_command_invalid"
  | "streaming_quality_boundary_unsupported"
  | "streaming_quality_policy_unsupported"
  | "streaming_metadata_invalid"
  | "streaming_retry_policy_invalid"
  | "streaming_write_concurrent"
  | "streaming_evidence_conflict"
  | import("@shellx-motion/core").LocalMotionJobErrorCode;
