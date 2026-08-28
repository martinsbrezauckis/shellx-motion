import type {
  LocalMotionJobEvidence,
  LocalMotionJobGovernor,
  RenderAudioMasterEvidence,
  RenderEncoderProbeEvidence,
  RenderLoudnessTrack,
  RenderLoudnessSummary
} from "@shellx-motion/core";
import type { RetainedDirectoryAuthority } from "@shellx-motion/core";
import type {
  EncodeImageSequenceWithPolicyInput,
  FfmpegCommand,
  FfmpegColorProfile,
  FfmpegExportPresetSpec,
  FfmpegHardwareEncodeCandidate,
  FfmpegHardwareEncoderUsability,
  FfmpegProcessResult,
  FfmpegObservedColor,
  FfmpegRunner,
  ProbeMediaResult
} from "./index.js";
import type { finalReceiptAudioOutput } from "./final-encode-shared.js";
import type { motionToolIdentityFor } from "./index.js";
import type {
  runStreamingFfmpegFinal,
  StreamingFfmpegFinalInput
} from "./streaming-foundation.js";
import type {
  StreamingEncodeAttemptOutcome,
  StreamingFfmpegAdmittedPreparationContext
} from "./streaming-foundation-types.js";
import type { StreamingFfmpegProcessFactory } from "./streaming-process.js";
import type { StreamingFrameFormat } from "./streaming-foundation-types.js";
import type { EncodePolicyCache } from "./encode-policy.js";
import type { resolveFinalAudioInputs } from "./final-encode-shared.js";
import type { FfmpegMediaInputSnapshot } from "./ffmpeg-media-input-fence.js";

export type StreamingPolicyBaseInput = Omit<
  EncodeImageSequenceWithPolicyInput,
  "framesDir" | "packageId" | "hardwareProbeResolver" | "resourcePreflight"
>;

/** Internal policy input: no materialized image-sequence directory or package id. */
export interface StreamingFinalEncodePolicyInput extends StreamingPolicyBaseInput {
  frameFormat?: StreamingFrameFormat;
  /** Analysis/probe runner; omitted uses the established real governed FFmpeg runner. */
  runner?: FfmpegRunner;
  produce: NonNullable<StreamingFfmpegFinalInput["produce"]>;
  signal?: AbortSignal;
  governor?: LocalMotionJobGovernor;
  scratchRoot?: string;
  operation?: string;
  callerId?: string;
  jobId?: string;
  qualityManifest?: StreamingFfmpegFinalInput["qualityManifest"];
  processFactory?: StreamingFfmpegProcessFactory;
  /** Optional FFprobe version, included in evidence when a caller already probed it. */
  ffprobeVersion?: string | null;
  /** Internal-only larger bounded hash window for a durable complete segment manifest. */
  qualityCapability?: StreamingFinalQualityCapability;
  /** Internal GPU-only authority for final-audio snapshots derived from immutable video PCM. */
  finalAudioSnapshotStaging?: { stagingRoot: string; authority: RetainedDirectoryAuthority };
  /**
   * GPU-only deferred preparation. It receives the encoder's already admitted lease, then returns
   * the real audio-aware policy input and producer before the process factory may run. The release
   * callback is owned by this wrapper and is called only after final receipt binding.
   */
  admittedPreflight?: (context: StreamingFfmpegAdmittedPreparationContext) => Promise<StreamingFinalEncodeAdmittedPreflight>;
}

export interface StreamingFinalEncodeAdmittedPreflight {
  readonly input: StreamingFinalEncodePreparationInput;
  readonly produce: NonNullable<StreamingFfmpegFinalInput["produce"]>;
  release?(): Promise<void>;
}

/**
 * Facts needed to choose and prepare a final encode. This excludes producer and governor ownership
 * deliberately: a later adapter may already hold an admission before it begins its final encode.
 */
export type StreamingFinalEncodePreparationInput = Omit<
  StreamingFinalEncodePolicyInput,
  "runner" | "produce" | "signal" | "governor" | "scratchRoot" | "operation" | "callerId" | "jobId" | "processFactory" | "admittedPreflight"
>;

/**
 * An internal transport may retain a bounded complete hash set rather than the streamed handoff's
 * 64-entry window. Omit this to preserve the public streamed-final contract exactly.
 */
export interface StreamingFinalQualityCapability {
  uniqueFrameHashCapacity: number;
}

export interface StreamingFinalPolicyAttempt {
  source: "hardware" | "software";
  encoder?: string;
  command: FfmpegCommand;
}

/** Internal, non-barrel preparation result consumed by either the streamed wrapper or a future admitted adapter. */
export interface PreparedStreamingFinalEncodePolicy {
  input: StreamingFinalEncodePreparationInput;
  frameCount: number;
  preset: FfmpegExportPresetSpec;
  /** Admitted private sources, retained with their caller-visible receipt paths and snapshot hashes. */
  audioInputs: ReturnType<typeof resolveFinalAudioInputs>;
  /** Sources after optional loudness measurement, used by the exact encode command and receipt. */
  renderAudioInputs: ReturnType<typeof resolveFinalAudioInputs>;
  compatibilityWarnings: string[];
  plannedAttempts: StreamingFinalPolicyAttempt[];
  cache: EncodePolicyCache;
  forceSoftwareEncode: boolean;
  hardwareDecision: {
    candidate?: FfmpegHardwareEncodeCandidate;
    probe?: FfmpegHardwareEncoderUsability;
    provenance?: "fresh-probe" | "cached";
    warnings: string[];
  };
  loudness: {
    inputs: ReturnType<typeof resolveFinalAudioInputs>;
    tracks: RenderLoudnessTrack[];
  };
  loudnessNormalizationRequested: boolean;
  /** Private copies retained until the streamed execution, readback, and receipt all complete. */
  mediaSnapshots: FfmpegMediaInputSnapshot[];
}

export type StreamingFinalEncodePreparationResult =
  | { ok: true; prepared: PreparedStreamingFinalEncodePolicy }
  | { ok: false; error: { code: string; message: string } };

/**
 * Actual encode observations supplied by the caller that owns FFmpeg execution. Attempts are
 * historical facts, rather than planned fallbacks, so cache invalidation cannot be inferred.
 */
export interface StreamingFinalEncodeExecutionEvidence {
  command: FfmpegCommand;
  output: FfmpegProcessResult;
  attempts: readonly StreamingEncodeAttemptOutcome[];
}

/**
 * Authoritative sequence evidence belongs to the frame producer/transport. It is intentionally
 * independent of streaming-foundation so an FFV1 checkpointed producer can attest to the same
 * final policy without pretending it used image2pipe.
 */
export interface StreamingFinalFrameSequenceEvidence {
  sha256: string;
  quality: {
    warnings: string[];
    frameCount: number;
    blankFrames: number;
    uniqueFrameHashes: number;
    uniqueFrameHashesExact: boolean;
  };
}

export interface StreamingFinalEncodeFinalizationInput {
  prepared: PreparedStreamingFinalEncodePolicy;
  /** Must already be appropriate to the caller's admission; finalization never creates one. */
  runner: FfmpegRunner;
  execution: StreamingFinalEncodeExecutionEvidence;
  frameSequence: StreamingFinalFrameSequenceEvidence;
}

export interface StreamingFinalReceiptEvidence {
  inputHashes: Record<string, string>;
  output: {
    path: string;
    sha256: string;
    width: number;
    height: number;
    durationMs: number;
    codec: string;
    container: string;
    preset: string;
    encoder?: string;
    encoderSource?: "hardware" | "software";
    encoderReason?: "probe-selected-hardware" | "forced-software" | "hardware-fallback" | "software-default";
    encoderProbe?: RenderEncoderProbeEvidence;
    encoderFallback?: { attemptedEncoder: string; reason: string };
    color?: FfmpegColorProfile & { observed?: FfmpegObservedColor };
    audio?: ReturnType<typeof finalReceiptAudioOutput>;
    observedMedia: ProbeMediaResult;
    /** Matches materialized receipt.output.tools; FFprobe is additive streamed-output evidence. */
    tools: {
      ffmpeg: ReturnType<typeof motionToolIdentityFor>;
      ffprobe: ReturnType<typeof motionToolIdentityFor>;
    };
    resources?: LocalMotionJobEvidence;
  };
  artifacts: [{ role: "rendered_media"; path: string; status: "available"; mediaType: string; primary: true }];
  warnings: string[];
  loudness?: RenderLoudnessSummary;
}

/**
 * Finalization evidence before a caller has completed its governor job. The resource claim is
 * intentionally absent so readback can run inside an existing admission without inventing it.
 */
export type StreamingFinalUnboundReceiptEvidence = Omit<StreamingFinalReceiptEvidence, "output"> & {
  output: Omit<StreamingFinalReceiptEvidence["output"], "resources">;
};

export interface StreamingFinalPartialOutputEvidence {
  path: string;
  status: "missing" | "unverified" | "nonconforming" | "available";
  sha256?: string;
  observedMedia?: ProbeMediaResult;
  validationFailure?: string;
  /** Delivered-program master readback when that target rejected this artifact. */
  audioMaster?: RenderAudioMasterEvidence;
  tools: {
    ffmpeg: ReturnType<typeof motionToolIdentityFor>;
    /** Present only once output readback actually invoked FFprobe. */
    ffprobe?: ReturnType<typeof motionToolIdentityFor>;
  };
}

/** Internal finalization result with the same receipt and partial-output vocabulary as the wrapper. */
export type StreamingFinalEncodeFinalizationResult =
  | {
      ok: true;
      command: FfmpegCommand;
      receiptEvidence: StreamingFinalUnboundReceiptEvidence;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        partialOutput?: StreamingFinalPartialOutputEvidence;
      };
    };

export type StreamingFinalEncodePolicyResult =
  | {
      ok: true;
      command: FfmpegCommand;
      plannedAttempts: StreamingFinalPolicyAttempt[];
      handoff: Extract<Awaited<ReturnType<typeof runStreamingFfmpegFinal>>, { ok: true }>['evidence'];
      receiptEvidence: StreamingFinalReceiptEvidence;
    }
  | {
      ok: false;
      plannedAttempts: StreamingFinalPolicyAttempt[];
      error: {
        code: string;
        message: string;
        process?: { exitCode: number; timedOut: boolean };
        resources?: LocalMotionJobEvidence;
        handoff?: Extract<Awaited<ReturnType<typeof runStreamingFfmpegFinal>>, { ok: false }>['error']['handoff'];
        partialOutput?: StreamingFinalPartialOutputEvidence;
      };
    };
