/** Internal executing adapter for durable FFV1 ranges. It intentionally has no package-barrel export. */
import type {
  FrameSequenceQualityPolicy,
  LocalMotionJobEvidence,
  LocalMotionJobGovernor
} from "@shellx-motion/core";
import type { MotionAudioMasterBus } from "@shellx-motion/core";
import type { EncodePolicyCache } from "../encode-policy.js";
import type { FfmpegAudioInput, FfmpegExportPreset, ProbeMediaResult } from "../index.js";
import type { RenderSegmentRangeProducerFactory, RenderSegmentSpoolToolProbeVerifier } from "./render-segment-spool-types.js";
import type { RenderSegmentSpoolFailureEvidence } from "./render-segment-spool-types.js";
import type { RenderSegmentPlan, RenderSegmentStoreProducerFacts, RenderSegmentStoreReadbackFacts, RenderSegmentFinalProducerEvidence } from "./render-segment-store-types.js";
import type { StreamingEncodeAttemptOutcome } from "../streaming-foundation-types.js";
import type { StreamingFfmpegProcessFactory } from "../streaming-process.js";
import type { StreamingFinalReceiptEvidence } from "../streaming-final-encode-policy-types.js";

export interface SegmentedFinalPackageFacts {
  rootPath: string;
  id: string;
  manifestSha256: string;
  /** Loader-owned parsed input hashes. Public segmented delivery always supplies this authority. */
  inputHashes?: Readonly<Record<string, string>>;
}

export interface SegmentedFinalTimelineFacts {
  motionSha256: string;
  frameCount: number;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

/** Renderer-neutral input: the caller owns range production and never passes a browser/native object. */
export interface RenderSegmentedFinalInput {
  package: SegmentedFinalPackageFacts;
  timeline: SegmentedFinalTimelineFacts;
  frameLane: "browser" | "native" | "gpu";
  /** Set before spool by browser/native setup or by the admitted GPU host. */
  producer?: RenderSegmentStoreProducerFacts;
  plan: RenderSegmentPlan;
  outputPath: string;
  /** Host-owned deferred CLI delivery stage. The deterministic checkpoint store remains keyed by outputPath. */
  privateOutputPublication?: import("@shellx-motion/core").DerivedOutputPublication;
  store: { intent: "create" | "resume" };
  /** Set before spool by browser/native setup or by the admitted GPU host. */
  createRangeProducer?: RenderSegmentRangeProducerFactory;
  /** Private host request. No caller-provided proof or producer reaches this seam. */
  gpuHost?: {
    pkg: import("@shellx-motion/core").MotionPackage;
    policy?: import("../segmented-final-gpu-host-types.js").SegmentedGpuHostPolicy;
    /** Pure static resolution from the public host boundary; no lease has begun yet. */
    preflight?: import("../segmented-final-gpu-host-types.js").SegmentedGpuStaticPreflight;
  };
  preset?: FfmpegExportPreset;
  audioPath?: string;
  audio?: FfmpegAudioInput;
  audioTracks?: FfmpegAudioInput[];
  audioMaster?: MotionAudioMasterBus;
  inputRoots?: string[];
  outputRoots?: string[];
  quality?: FrameSequenceQualityPolicy;
  qualityManifest?: { exactSourceComparison?: "required" };
  forceSoftwareEncode?: boolean;
  verifyDeliveredColor?: boolean;
  cache?: EncodePolicyCache;
  ffmpegVersion?: string | null;
  ffprobeVersion?: string | null;
  processFactory?: StreamingFfmpegProcessFactory;
  verifyReadback?: RenderSegmentSpoolToolProbeVerifier;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  governor?: LocalMotionJobGovernor;
  scratchRoot?: string;
  operation?: string;
  callerId?: string;
  jobId?: string;
}

export interface SegmentedFinalSegmentEvidence {
  index: number;
  range: { index: number; startFrame: number; endFrameExclusive: number; frameCount: number };
  artifactSha256: string;
  frameSequenceSha256: string;
  readback: RenderSegmentStoreReadbackFacts;
}

export interface SegmentedFinalTransportEvidence {
  delivery: "resumable-ffv1-segments";
  planFingerprint: string;
  frameSequence: { schema: "shellx-motion/streamed-frame-sequence@1"; sha256: string };
  segments: SegmentedFinalSegmentEvidence[];
  resume: { verifiedPrefixSegments: number; newlyCompletedSegments: number };
  concatListSha256: string;
  attempts: StreamingEncodeAttemptOutcome[];
  sequential: true;
  /** Omitted for the existing browser/native image2pipe contract. */
  frameFormat?: "rgba";
  maxConcurrentPngHandoffs: 1;
  observedMaxConcurrentPngHandoffs: number;
  /** Complete bounded evidence reconstructed from every persisted checkpoint. */
  producer: RenderSegmentFinalProducerEvidence;
  quality: {
    warnings: string[];
    frameCount: number;
    blankFrames: number;
    uniqueFrameHashes: number;
    uniqueFrameHashesExact: true;
    motion: { status: "unavailable"; reason: "segment-resume-does-not-persist-pixel-planes" };
  };
  producerWarnings: { coverage: "complete" };
  retention: {
    verifiedSegments: "cleaned" | "retained" | "partially_cleaned";
    cleanup: "complete" | "retained";
    removedSegmentCount: number;
    missingSegmentCount: number;
    retainedSegmentCount: number;
  };
}

export interface SegmentedFinalPartialOutputEvidence {
  status: "missing" | "unverified" | "nonconforming" | "available";
  sha256?: string;
  observedMedia?: Omit<ProbeMediaResult, "path">;
  validationFailure?: string;
}

export interface SegmentedFinalFailureEvidence {
  phase: "preflight" | "spool" | "concat" | "finalize" | "publish" | "cancelled" | "deadline" | "resource";
  transport?: SegmentedFinalFailureTransportEvidence;
  /** Path-free durable-prefix state reported before a spool could return a full manifest. */
  spool?: RenderSegmentSpoolFailureEvidence;
  partialOutput?: SegmentedFinalPartialOutputEvidence;
  publication?: "not_published" | "published_stage_retained" | "destination_created_identity_unverified";
  resources?: LocalMotionJobEvidence;
}

/** Failure lifecycle never fabricates a completed concat, final quality, or published delivery. */
export interface SegmentedFinalFailureTransportEvidence {
  delivery: "resumable-ffv1-segments";
  planFingerprint: string;
  frameSequence: { schema: "shellx-motion/streamed-frame-sequence@1"; sha256: string };
  segments: SegmentedFinalSegmentEvidence[];
  resume: { verifiedPrefixSegments: number; newlyCompletedSegments: number };
  concat: { state: "not_created" | "created" | "tampered"; sha256?: string };
  attempts: StreamingEncodeAttemptOutcome[];
  sequential: true;
  /** Omitted for the existing browser/native image2pipe contract. */
  frameFormat?: "rgba";
  maxConcurrentPngHandoffs: 1;
  observedMaxConcurrentPngHandoffs: number;
  retention: {
    verifiedPrefixSegments: number;
    verifiedSegments: "preserved";
    stagingCleanup: "not_started" | "missing" | "removed" | "retained";
  };
  publication: "not_published" | "destination_created_identity_unverified";
}

/** Keeps immutable, frozen, and primitive primary/cleanup causes observable without editing them. */
export class SegmentedFinalAdapterFailure extends Error {
  constructor(
    readonly code: string,
    readonly evidence: SegmentedFinalFailureEvidence,
    readonly primaryCause: unknown,
    readonly cleanupCauses: readonly unknown[] = []
  ) {
    super(`Segmented final adapter failed during ${evidence.phase}.`, { cause: primaryCause });
    this.name = "SegmentedFinalAdapterFailure";
    Object.setPrototypeOf(this, SegmentedFinalAdapterFailure.prototype);
  }
}

export type RenderSegmentedFinalResult =
  | {
      ok: true;
      output: {
        sha256: string;
        width: number;
        height: number;
        durationMs: number;
        codec: string;
        container: string;
        preset: string;
      };
      inputHashes: Record<string, string>;
      warnings: string[];
      resources: LocalMotionJobEvidence;
      transport: SegmentedFinalTransportEvidence;
      /** Full finalization/readback/tool evidence, bound to the outer governor admission. */
      receiptEvidence: StreamingFinalReceiptEvidence;
    }
  | { ok: false; error: SegmentedFinalAdapterFailure };
