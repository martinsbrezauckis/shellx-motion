import type {
  LocalMotionJobContext,
  LocalMotionJobEvidence,
  LocalMotionJobErrorCode,
  LocalMotionJobGovernor,
  LocalMotionProcessContainmentEvidence,
  LocalMotionRuntimeSandboxEvidence
} from "@shellx-motion/core";
import type { MotionPackageContentFingerprint } from "./package-content-fingerprint.js";
import type { PreAdmittedSegmentReadbackInput } from "./segment-ffprobe-readback.js";
import type {
  RenderSegmentPlan,
  RenderSegmentRangeProducerEvidence,
  RenderSegmentFinalProducerEvidence,
  RenderSegmentRange,
  RenderSegmentReadbackVerificationResult,
  RenderSegmentStoreDeliveryFacts,
  RenderSegmentStoreProducerFacts,
  RenderSegmentStoreManifest
} from "./render-segment-store-types.js";
import type { StreamingFfmpegProcessFactory } from "../streaming-process.js";

/** Internal loaded package facts; the caller owns package loading and manifest/motion hashes. */
export interface RenderSegmentSpoolPackageFacts {
  rootPath: string;
  id: string;
  manifestSha256: string;
  /** Exact loader-owned structural hashes that the live content fingerprint must still contain. */
  inputHashes?: Readonly<Record<string, string>>;
}

/** Existing canonical render facts, intentionally separate from product receipt data. */
export interface RenderSegmentSpoolTimelineFacts {
  motionSha256: string;
  frameCount: number;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

export interface RenderSegmentRangeProducer {
  /** A producer must emit only its assigned global canonical frame range under awaited backpressure. */
  produce(
    sink: RenderSegmentSpoolFrameSink,
    job: RenderSegmentSpoolProducerJobContext
  ): Promise<void>;
  /** Bounded path-free evidence is read only after `produce` completes successfully. */
  readonly evidence?: Readonly<RenderSegmentRangeProducerEvidence>;
  /** Optional idempotent owner cleanup before production can reach a durable checkpoint. */
  abort?(): Promise<void>;
}

/** Structural adapter boundary: browser and native range producers can both implement this. */
export type RenderSegmentRangeProducerFactory = (input: {
  /** The complete immutable segment interval, including its canonical plan index. */
  range: { index: number; startFrameIndex: number; endFrameIndexExclusive: number };
  timeline: RenderSegmentSpoolTimelineFacts;
  frameLane: "browser" | "native" | "gpu";
}) => Promise<RenderSegmentRangeProducer> | RenderSegmentRangeProducer;

/** The legacy PNG handoff remains unchanged; GPU owns a separate, tightly packed raw RGBA lane. */
export type RenderSegmentSpoolFrame = { index: number; atMs: number; png: Buffer } | {
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

/** Method syntax intentionally preserves existing narrow PNG producer annotations. */
export interface RenderSegmentSpoolFrameSink {
  write(frame: RenderSegmentSpoolFrame): Promise<void>;
}

/** The pre-acquired structural context understood by both existing range producer families. */
export interface RenderSegmentSpoolProducerJobContext {
  readonly admission: "pre-acquired";
  readonly jobId: string;
  readonly scratchRoot: string;
  /** Present only for strict GPU ranges; copied unchanged from the outer governor policy. */
  readonly maxProcessTreeRssBytes?: number;
  readonly signal: AbortSignal;
  watchProcess(pid: number): void;
  reportSandbox(evidence: LocalMotionRuntimeSandboxEvidence): void;
}

/**
 * The internal tooling boundary is deliberately mandatory: it receives the already-admitted job,
 * so a caller cannot silently use ordinary unmonitored FFprobe spawning inside a spool.
 */
export type RenderSegmentSpoolToolProbeVerifier = (
  input: PreAdmittedSegmentReadbackInput
) => Promise<RenderSegmentReadbackVerificationResult>;

export interface RenderSegmentSpoolInput {
  package: RenderSegmentSpoolPackageFacts;
  timeline: RenderSegmentSpoolTimelineFacts;
  frameLane: "browser" | "native" | "gpu";
  /** Current host-owned verdict, bound into the durable create/resume identity. */
  producer: RenderSegmentStoreProducerFacts;
  plan: RenderSegmentPlan;
  store: { intent: "create" | "resume"; rootPath: string };
  delivery?: RenderSegmentStoreDeliveryFacts;
  resumeRecovery?: { stagingBasename: string; concatListBasename: "segments.ffconcat"; concatTempBasename: ".segments.ffconcat.partial" };
  createRangeProducer: RenderSegmentRangeProducerFactory;
  /** Production uses the contained FFmpeg process factory; tests may inject a bounded fake. */
  processFactory?: StreamingFfmpegProcessFactory;
  /** Defaults to the contained FFprobe helper; never to ordinary ungoverned `probeMedia`. */
  verifyReadback?: RenderSegmentSpoolToolProbeVerifier;
  signal?: AbortSignal;
  /** Absolute wall-clock deadline for this internal spool operation. */
  deadlineAtMs?: number;
  governor?: LocalMotionJobGovernor;
  scratchRoot?: string;
  operation?: string;
  callerId?: string;
  jobId?: string;
}

export interface RenderSegmentSpoolAdmittedInput extends Omit<RenderSegmentSpoolInput, "governor" | "signal" | "scratchRoot" | "operation" | "callerId" | "jobId"> {
  job: LocalMotionJobContext;
  /** Supplied by the owning governor for strict GPU range Chromium containment. */
  maxProcessTreeRssBytes?: number;
  /**
   * Optional owner-provided reporter for a larger admitted operation. Reusing it lets a later
   * final concat, FFprobe and the segment spool attest one consistent containment fact.
   */
  evidenceReporter?: RenderSegmentSpoolEvidenceReporter;
}

export type RenderSegmentSpoolPhase =
  | "source_fingerprint"
  | "store"
  | "producer"
  | "frame_validation"
  | "encoder"
  | "checkpoint"
  | "source_recheck"
  | "cancelled"
  | "deadline"
  | "resource";

export type RenderSegmentSpoolFailureCode =
  | "segment_source_fingerprint_failed"
  | "segment_source_changed"
  | "segment_store_failed"
  | "segment_producer_failed"
  | "segment_frame_invalid"
  | "segment_encoder_failed"
  | "segment_checkpoint_failed"
  | "segment_cancelled"
  | "segment_deadline_exceeded"
  | "segment_resource_failed";

export interface RenderSegmentSpoolFailureEvidence {
  phase: RenderSegmentSpoolPhase;
  range: RenderSegmentRange | null;
  verifiedPrefixSegments: number;
  retention: {
    verifiedPrefixPreserved: true;
    currentTemporaryArtifact: "not_started" | "missing" | "removed" | "retained";
  };
  cleanup: {
    attempted: boolean;
    outcome: "not_needed" | "missing" | "removed" | "retained";
  };
  /** Exact Core resource/cancellation code when the governor supplied the primary failure. */
  resourceCode?: LocalMotionJobErrorCode;
}

/** A wrapper preserves immutable primary and cleanup errors without attempting to annotate them. */
export class RenderSegmentSpoolFailure extends Error {
  constructor(
    readonly code: RenderSegmentSpoolFailureCode,
    readonly evidence: RenderSegmentSpoolFailureEvidence,
    readonly primaryCause: unknown,
    readonly cleanupCauses: readonly unknown[] = []
  ) {
    super(`Segment spool failed during ${evidence.phase}.`, { cause: primaryCause });
    this.name = "RenderSegmentSpoolFailure";
    Object.setPrototypeOf(this, RenderSegmentSpoolFailure.prototype);
  }
}

export type RenderSegmentSpoolResult =
  | {
      ok: true;
      manifest: RenderSegmentStoreManifest;
      packageContent: MotionPackageContentFingerprint;
      handoff: {
        delivery: "resumable-ffv1-segments";
        sequential: true;
        maxConcurrentPngHandoffs: 1;
        observedMaxConcurrentPngHandoffs: number;
      };
      /** Durable prefix reopened before this invocation began producing any new range. */
      resume: { verifiedPrefixSegments: number };
      /** Complete evidence reconstructed from persisted checkpoints, including a resumed prefix. */
      producer: RenderSegmentFinalProducerEvidence;
      resources?: LocalMotionJobEvidence;
    }
  | { ok: false; error: RenderSegmentSpoolFailure; resources?: LocalMotionJobEvidence };

/** Internal-only hook used to give each admitted process the same deduplicating evidence reporter. */
export interface RenderSegmentSpoolEvidenceReporter {
  reportProcessContainment(evidence: LocalMotionProcessContainmentEvidence): void;
  reportSandbox(evidence: LocalMotionRuntimeSandboxEvidence): void;
}
