import type { AgentScriptExecutionEvidence } from "@shellx-motion/core";
import type {
  GpuSegmentedHybridAdmissionIdentity,
  GpuSegmentedHybridLedgerEntry,
  GpuSegmentedHybridRangeCleanupEvidence,
  GpuSegmentedHybridRangeLedger
} from "@shellx-motion/renderer-browser";
import type { GpuEnvironmentArenaEvidence } from "../gpu-final-receipt-provenance.js";
import type { RenderSegmentGpuHybridAggregateProducerEvidence } from "./render-segment-gpu-hybrid-aggregate.js";
import {
  RENDER_GPU_EFFECT_MODULE_SEGMENT_STORE_SCHEMA,
  type RenderSegmentGpuEffectModuleAggregateProducerEvidence,
  type RenderSegmentGpuEffectModuleIdentity,
  type RenderSegmentGpuEffectModuleRangeProducerEvidence
} from "./render-segment-gpu-effect-module-types.js";
import {
  RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA,
  type RenderSegmentGpuBehaviorAggregateProducerEvidence,
  type RenderSegmentGpuBehaviorIdentity,
  type RenderSegmentGpuBehaviorRangeProducerEvidence
} from "./render-segment-gpu-behavior-types.js";
export { RENDER_GPU_HYBRID_SEGMENT_AGGREGATE_PRODUCER_SCHEMA } from "./render-segment-gpu-hybrid-aggregate.js";
export type { RenderSegmentGpuHybridAggregateProducerEvidence } from "./render-segment-gpu-hybrid-aggregate.js";
export type { RenderSegmentGpuBehaviorAggregateProducerEvidence } from "./render-segment-gpu-behavior-types.js";
export const RENDER_SEGMENT_STORE_SCHEMA = "shellx-motion/render-segment-store@1" as const;
export const RENDER_GPU_SEGMENT_STORE_SCHEMA = "shellx-motion/gpu-render-segment-store@1" as const;
export const RENDER_GPU_HYBRID_SEGMENT_STORE_SCHEMA = "shellx-motion/gpu-hybrid-render-segment-store@1" as const;
export { RENDER_GPU_EFFECT_MODULE_SEGMENT_STORE_SCHEMA } from "./render-segment-gpu-effect-module-types.js";
export { RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA } from "./render-segment-gpu-behavior-types.js";
export const RENDER_SEGMENT_PLAN_SCHEMA = "shellx-motion/render-segment-plan@1" as const;
export const RENDER_SEGMENT_FRAME_SEQUENCE_SCHEMA = "shellx-motion/render-segment-frame-sequence@1" as const;
export const RENDER_SEGMENT_DELIVERY_SCHEMA = "shellx-motion/segmented-final-delivery@1" as const;
export const RENDER_GPU_SEGMENTED_IDENTITY_SCHEMA = "shellx-motion/gpu-segmented-identity@1" as const;
export const RENDER_GPU_HYBRID_SEGMENTED_IDENTITY_SCHEMA = "shellx-motion/gpu-hybrid-segmented-identity@1" as const;
export const RENDER_GPU_SEGMENTED_HOST_VERDICT_SCHEMA = "shellx-motion/gpu-segmented-host-verdict@1" as const;
export const RENDER_GPU_SEGMENT_RANGE_PRODUCER_SCHEMA = "shellx-motion/gpu-segment-range-producer@1" as const;
export const RENDER_GPU_HYBRID_SEGMENT_RANGE_PRODUCER_SCHEMA = "shellx-motion/gpu-hybrid-segment-range-producer@1" as const;
export const RENDER_GPU_HYBRID_CAPTURE_PLAN_SCHEMA = "shellx-motion/gpu-hybrid-capture-plan@1" as const;
export const MAX_RENDER_SEGMENTS = 512;
export type RenderSegmentStoreErrorCode =
  | "segment_plan_invalid"
  | "segment_frame_budget_exceeded"
  | "segment_count_exceeded"
  | "segment_store_path_invalid"
  | "segment_store_unrecognized"
  | "segment_store_schema_unsupported"
  | "segment_manifest_invalid"
  | "segment_plan_mismatch"
  | "segment_entry_invalid"
  | "segment_integrity_failed"
  | "segment_readback_invalid"
  | "segment_readback_verification_failed"
  | "segment_commit_invalid"
  | "segment_atomic_write_failed";
export class RenderSegmentStoreError extends Error {
  constructor(readonly code: RenderSegmentStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RenderSegmentStoreError";
  }
}
export interface RenderSegmentRange {
  index: number;
  startFrame: number;
  endFrameExclusive: number;
  frameCount: number;
}
export interface RenderSegmentPlan {
  schema: typeof RENDER_SEGMENT_PLAN_SCHEMA;
  frameCount: number;
  segmentFrames: number;
  segmentCount: number;
  ranges: RenderSegmentRange[];
}
export interface RenderSegmentStorePackageFacts {
  id: string;
  manifestSha256: string;
  contentSha256: string;
}

export interface RenderSegmentStoreTimelineFacts {
  motionSha256: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

export type RenderSegmentStoreFrameLane = "browser" | "native" | "gpu";

/**
 * Stable, path-free subset of one strict active GPU host proof.  It excludes
 * the probe timestamp and browser root PID, which cannot survive a later
 * process, but retains the executable, launch, adapter, runtime and
 * containment identities that must remain unchanged across a durable prefix.
 */
export type RenderSegmentGpuContainmentProfile =
  | {
    mode: "unix-process-group";
    memoryLimit: "rss-monitor";
    maxProcessTreeRssBytes: number;
    maxActiveProcesses?: never;
    launcherSha256?: never;
  }
  | {
    mode: "windows-job-object";
    memoryLimit: "job-commit";
    maxProcessTreeRssBytes: number;
    maxActiveProcesses: number;
    launcherSha256: string;
  };

export interface RenderSegmentGpuHostVerdict {
  schema: typeof RENDER_GPU_SEGMENTED_HOST_VERDICT_SCHEMA;
  platform: "linux" | "darwin" | "win32";
  browser: { source: "path" | "override" | "shellx-family"; executableSha256: string; version: string };
  launchProfileSha256: string;
  runtimeEvidenceSha256: string;
  adapterFingerprint: string;
  containment: RenderSegmentGpuContainmentProfile;
  /** The pre-store identity browser emitted no frames and closed before durable state opened. */
  session: {
    purpose: "pre-store-identity";
    emittedFrames: 0;
    cleanup: "complete";
  };
}

/** Immutable GPU closure shared by every range in one segmented final. */
export interface RenderSegmentGpuBaseIdentity {
  packageContentSha256: string;
  pipelineCatalogSha256: string;
  staticPlan: {
    fingerprint: string;
    documentFingerprint: string;
    resourceReferencesSha256: string;
    canonicalFrameCount: number;
    /** Authored environment layers. Draw work itself is range-local evidence. */
    maxEnvironmentCount: number;
  };
  staticScene: { sha256: string; inputHashesSha256: string };
  hostVerdict: RenderSegmentGpuHostVerdict;
  /** Immutable GPU-video authority, if the static scene requires admitted video. */
  videoStaging?: { ledgerSha256: string; pcmSha256: string };
}

export interface RenderSegmentGpuStandardIdentity extends RenderSegmentGpuBaseIdentity {
  schema: typeof RENDER_GPU_SEGMENTED_IDENTITY_SCHEMA;
}

/** One Core request per active hybrid frame, retained only as bounded scalar evidence. */
export interface RenderSegmentGpuHybridCapturePlan {
  schema: typeof RENDER_GPU_HYBRID_CAPTURE_PLAN_SCHEMA;
  /** Path-free scalar projection of the host-owned exact Core request plan. */
  entries: readonly Pick<GpuSegmentedHybridLedgerEntry, "index" | "atMs" | "atUs" | "requestFingerprint">[];
  sha256: string;
}

/**
 * Browser owns source bytes and capture policy. FFmpeg persists only its
 * path-free admission identity plus bounded Core request and bootstrap facts.
 */
export interface RenderSegmentGpuHybridIdentity extends RenderSegmentGpuBaseIdentity {
  schema: typeof RENDER_GPU_HYBRID_SEGMENTED_IDENTITY_SCHEMA;
  hybrid: {
    admission: GpuSegmentedHybridAdmissionIdentity;
    capturePlan: RenderSegmentGpuHybridCapturePlan;
  };
}

export type RenderSegmentGpuIdentity = RenderSegmentGpuStandardIdentity | RenderSegmentGpuHybridIdentity | RenderSegmentGpuEffectModuleIdentity | RenderSegmentGpuBehaviorIdentity;

/**
 * Per-range evidence preserves the exact hashes emitted by the existing GPU
 * final receipt provenance helper.  Frame and plan hashes are range-local;
 * all immutable hashes must agree with the store's GPU identity.
 */
export interface RenderSegmentGpuStandardRangeProducerEvidence {
  schema: typeof RENDER_GPU_SEGMENT_RANGE_PRODUCER_SCHEMA;
  frameLane: "gpu";
  identity: RenderSegmentGpuStandardIdentity;
  frameSequenceSha256: string;
  framePlanSequenceSha256: string;
  /** One immutable Core frame-plan fingerprint for every frame in this exact range. */
  framePlanFingerprints: readonly string[];
  /** Derived only for an environment-bearing static plan and exactly hash-bound below. */
  environmentArena?: Readonly<GpuEnvironmentArenaEvidence>;
  /** Exact retained GPU input-hash projection used by final receipts. */
  finalReceiptInputHashes: Record<string, string>;
  scriptExecution?: never;
  warningUnion: readonly string[];
  warningsOmitted: number;
}

/** Hybrid ledger and its exact Browser cleanup are committed with the FFV1 range artifact. */
export interface RenderSegmentGpuHybridRangeProducerEvidence {
  schema: typeof RENDER_GPU_HYBRID_SEGMENT_RANGE_PRODUCER_SCHEMA;
  frameLane: "gpu";
  identity: RenderSegmentGpuHybridIdentity;
  frameSequenceSha256: string;
  framePlanSequenceSha256: string;
  framePlanFingerprints: readonly string[];
  environmentArena?: Readonly<GpuEnvironmentArenaEvidence>;
  hybrid: {
    ledger: GpuSegmentedHybridRangeLedger;
    cleanup: GpuSegmentedHybridRangeCleanupEvidence;
  };
  finalReceiptInputHashes: Record<string, string>;
  scriptExecution?: never;
  warningUnion: readonly string[];
  warningsOmitted: number;
}

export type RenderSegmentGpuRangeProducerEvidence = RenderSegmentGpuStandardRangeProducerEvidence | RenderSegmentGpuHybridRangeProducerEvidence | RenderSegmentGpuEffectModuleRangeProducerEvidence | RenderSegmentGpuBehaviorRangeProducerEvidence;

/** Path-free host verdict which is immutable for the complete create/resume plan. */
export type RenderSegmentStoreProducerFacts =
  | { frameLane: "native" }
  | { frameLane: "browser"; scriptExecution: Readonly<AgentScriptExecutionEvidence> }
  | { frameLane: "gpu"; identity: RenderSegmentGpuIdentity };

/** The future FFmpeg segment adapter chooses these facts before opening the durable store. */
export interface RenderSegmentStoreIntermediateFacts {
  container: string;
  codec: string;
  extension: string;
}

/** Path-free immutable final-delivery request identity used only by the segmented-final adapter. */
export interface RenderSegmentStoreDeliveryFacts {
  schema: typeof RENDER_SEGMENT_DELIVERY_SCHEMA;
  outputPathSha256: string;
  preset: "mp4-h264" | "webm-vp9-alpha";
  audio: Array<{ contentSha256: string; controlsSha256: string }>;
  quality: { minDurationMs: number; minUniqueFrameHashes: number };
  forceSoftwareEncode: boolean;
  verifyDeliveredColor: boolean;
}

export interface RenderSegmentStoreReadbackFacts {
  verified: true;
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

export interface RenderSegmentLegacyRangeProducerEvidence {
  schema: "shellx-motion/segment-range-producer@1";
  frameLane: "browser" | "native";
  /** Mandatory for browser ranges; native ranges never claim browser script execution. */
  scriptExecution?: Readonly<AgentScriptExecutionEvidence>;
  /** Bounded producer warnings retained so resumed prefixes do not lose their evidence. */
  warningUnion: readonly string[];
  warningsOmitted: number;
}

export type RenderSegmentRangeProducerEvidence =
  | RenderSegmentLegacyRangeProducerEvidence
  | RenderSegmentGpuRangeProducerEvidence;

/** A receipt-facing complete producer can be a range (legacy/standard) or B2 hybrid aggregate. */
export type RenderSegmentFinalProducerEvidence = RenderSegmentRangeProducerEvidence | RenderSegmentGpuHybridAggregateProducerEvidence | RenderSegmentGpuEffectModuleAggregateProducerEvidence | RenderSegmentGpuBehaviorAggregateProducerEvidence;

export interface RenderSegmentArtifactFacts {
  path: string;
  sha256: string;
  byteLength: number;
}

/**
 * A durable checkpoint carries per-frame hashes only so a later internal final adapter can rebuild
 * the one full streamed-frame identity after a resume. These are not receipt-facing output data.
 */
export interface RenderSegmentCheckpoint {
  index: number;
  range: RenderSegmentRange;
  frameSequence: { schema: typeof RENDER_SEGMENT_FRAME_SEQUENCE_SCHEMA; sha256: string };
  frameHashes: string[];
  /** Executor-observed Core PNG quality evidence; all-blank resumed output remains a refusal. */
  blankFrameCount: number;
  /** Path-free producer verdict retained across resume; browser checkpoints require script evidence. */
  producer: RenderSegmentRangeProducerEvidence;
  artifact: RenderSegmentArtifactFacts;
  readback: RenderSegmentStoreReadbackFacts;
}

export interface RenderSegmentStoreManifest {
  schema: typeof RENDER_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_HYBRID_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_EFFECT_MODULE_SEGMENT_STORE_SCHEMA | typeof RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA;
  planFingerprint: string;
  plan: RenderSegmentPlan;
  package: RenderSegmentStorePackageFacts;
  frameLane: RenderSegmentStoreFrameLane;
  producer: RenderSegmentStoreProducerFacts;
  timeline: RenderSegmentStoreTimelineFacts;
  intermediate: RenderSegmentStoreIntermediateFacts;
  /** Absent only for the standalone pre-final spool primitive; present for every segmented delivery. */
  delivery?: RenderSegmentStoreDeliveryFacts;
  completed: RenderSegmentCheckpoint[];
}

export interface RenderSegmentReadbackVerificationInput {
  /** Exact canonical segment interval which the artifact must prove. */
  range: RenderSegmentRange;
  artifactPath: string;
  expected: {
    timeline: RenderSegmentStoreTimelineFacts;
    intermediate: RenderSegmentStoreIntermediateFacts;
  };
}

export type RenderSegmentReadbackVerifier = (
  input: RenderSegmentReadbackVerificationInput
) => Promise<RenderSegmentReadbackVerificationResult> | RenderSegmentReadbackVerificationResult;

export type RenderSegmentReadbackVerificationResult =
  | { ok: true; readback: RenderSegmentStoreReadbackFacts }
  | { ok: false; message: string };

export interface RenderSegmentStoreInput {
  rootPath: string;
  plan: RenderSegmentPlan;
  package: RenderSegmentStorePackageFacts;
  frameLane: RenderSegmentStoreFrameLane;
  producer: RenderSegmentStoreProducerFacts;
  timeline: RenderSegmentStoreTimelineFacts;
  intermediate: RenderSegmentStoreIntermediateFacts;
  delivery?: RenderSegmentStoreDeliveryFacts;
  /** Mandatory before committing or trusting any durable completed segment. */
  verifyReadback: RenderSegmentReadbackVerifier;
}

/** Creates a new empty store only; it refuses any existing nonempty root. */
export interface CreateRenderSegmentStoreInput extends RenderSegmentStoreInput {}

/** Resumes an existing recognized store only; it never creates a directory or manifest. */
export interface ResumeRenderSegmentStoreInput extends RenderSegmentStoreInput {
  /** Internal segmented-final recovery names, accepted only after immutable manifest binding. */
  recovery?: { stagingBasename: string; concatListBasename: "segments.ffconcat"; concatTempBasename: ".segments.ffconcat.partial" };
}

export interface CommitRenderSegmentInput {
  index: number;
  /** Must be the exact owned temporary pathname returned by `temporaryArtifactPath(index)`. */
  temporaryArtifactPath: string;
  frameSequenceSha256: string;
  frameHashes: readonly string[];
  blankFrameCount: number;
  producer: RenderSegmentRangeProducerEvidence;
}
