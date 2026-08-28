import type {
  FrameSequenceQualityPolicy,
  DerivedOutputPublication,
  LocalMotionJobEvidence,
  LocalMotionJobGovernor,
  MotionToolIdentity,
  MotionAudioMasterBus,
  RenderAudioMasterEvidence,
  MotionPackage,
  OperationReceipt,
  PublicationCommitUncertainEvidence
} from "@shellx-motion/core";
import type {
  BrowserCaptureWorkflow,
  BrowserNetworkAccessOptions,
  BrowserRenderSessionOptions,
  MotionBrowserRenderSessionFactory,
  BrowserStreamingFrameProducerEvidence,
  GpuEffectModuleFinalReceiptEvidence,
  GpuEffectModuleUseAuthority,
  GpuStreamingFrameProducerEvidence,
  GpuStreamingFrameProducerInput
} from "@shellx-motion/renderer-browser";
import type { GpuScene3dGltfPbrStreamingProducerEvidence } from "@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-final";
import type { EncodePolicyCache } from "./encode-policy.js";
import type { FfmpegAudioInput, FfmpegCommand, FfmpegExportPreset, FfmpegRunner, ProbeMediaResult } from "./index.js";
import type { StreamingFfmpegProcessFactory } from "./streaming-process.js";
import type { FinalVideoFrameTransportPlan } from "./final-video-frame-transport.js";
import type { StreamingFrameFormat } from "./streaming-foundation-types.js";
import type { GpuVideoStagingTestFacts } from "./streaming-final-gpu.js";
import type { GpuVideoStagingLedger } from "./gpu-video-staging-budget.js";

/** Tool and renderer controls accepted by {@link renderStreamingFinal}; all execute locally. */
export interface StreamingFinalToolPolicy {
  runner?: FfmpegRunner;
  cache?: EncodePolicyCache;
  ffmpegVersion?: string | null;
  ffprobeVersion?: string | null;
  forceSoftwareEncode?: boolean;
  verifyDeliveredColor?: boolean;
  /** Test seam for a shell-free image2pipe process; production uses the contained process factory. */
  processFactory?: StreamingFfmpegProcessFactory;
  browser?: {
    workflow?: BrowserCaptureWorkflow;
    networkAccess?: BrowserNetworkAccessOptions;
    launchBrowser?: BrowserRenderSessionOptions["launchBrowser"];
    /** Opaque host-only session binding; never accepted from Debug, MCP, CLI, or SDK args. */
    sessionFactory?: MotionBrowserRenderSessionFactory;
  };
  native?: { now?: () => string };
  gpu?: {
    openRuntime?: GpuStreamingFrameProducerInput["openRuntime"];
    frameTimeoutMs?: number;
    /**
     * Opaque host-injected read/use authority for governed GPU effect modules.
     * It is never request data: consumers can resolve a Motion document and
     * begin a bounded use, but cannot list, install, inspect, revoke, or read
     * a registry entry.
     */
    effectModuleUseAuthority?: GpuEffectModuleUseAuthority;
    /**
     * Unit-test seam only. Production derives media facts from immutable snapshots and creates its
     * own exact private child below the admitted job scratch root; callers cannot choose that root.
     */
    testVideoStaging?: GpuVideoStagingTestFacts;
  };
  /** Test-only seam. It deliberately plans materialization rather than injecting a streamed source. */
  injectedFrameRenderer?: boolean;
}

/** Inputs shared by the pure streamed-command planner and the executing adapter. */
export interface PlanStreamingFinalCommandInput {
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  /** Internal producer transport; existing browser/native callers use PNG, GPU uses raw RGBA. */
  frameFormat?: StreamingFrameFormat;
  outputPath: string;
  preset?: FfmpegExportPreset;
  audioPath?: string;
  audio?: FfmpegAudioInput;
  audioTracks?: FfmpegAudioInput[];
  audioMaster?: MotionAudioMasterBus;
  inputRoots?: string[];
  outputRoots?: string[];
  quality?: FrameSequenceQualityPolicy;
  qualityManifest?: { exactSourceComparison?: "required" };
  /** Explicit retention intent. A framesDir alone does not request materialization. */
  keepFrames?: boolean;
  /** An already made plan is checked against the supplied capability facts before any work starts. */
  transport?: FinalVideoFrameTransportPlan;
  capturedBrowserWorkflow?: boolean;
  injectedFrameRenderer?: boolean;
}

/** High-level streamed final-video API. It accepts an already-loaded package and never selects a command surface. */
export interface RenderStreamingFinalInput extends Omit<PlanStreamingFinalCommandInput,
  "fps" | "width" | "height" | "durationMs" | "frameFormat" | "capturedBrowserWorkflow" | "injectedFrameRenderer"
> {
  pkg: MotionPackage;
  frameLane: "browser" | "native" | "gpu";
  signal?: AbortSignal;
  governor?: LocalMotionJobGovernor;
  scratchRoot?: string;
  operation?: string;
  callerId?: string;
  jobId?: string;
  /** Explicit CLI-only overwrite intent; normal publication is always no-clobber. */
  force?: boolean;
  /** Renderer-host-only paired-publication stage. When supplied, success remains private. */
  outputPublication?: DerivedOutputPublication;
  now?: () => string;
  toolPolicy?: StreamingFinalToolPolicy;
}

/** Public, bounded observation of the image2pipe handoff. It does not expose the internal foundation API. */
export interface StreamingFinalEncoderHandoffEvidence {
  delivery: "streamed";
  /** Present on v0.2 GPU/raw transports; omitted historical evidence means PNG. */
  frameFormat?: StreamingFrameFormat;
  maxConcurrentProducerWrites: 1;
  observedMaxConcurrentProducerWrites: number;
  maxBufferedInputBytes: number;
  inputHighWaterMarkBytes: number;
  /** Present on new transport-aware evidence; historical PNG evidence uses maxPngBytesPerFrame. */
  maxFrameBytesPerFrame?: number;
  maxPngBytesPerFrame?: number;
  maxRgbaBytesPerFrame?: number;
  backpressure: { writes: number; drainWaits: number };
  encoderHandoffSourceFramesRetained: 0;
  qualityPlaneSetCapacity: 2;
  uniqueHashCapacity: number;
  attempts: Array<{
    source: "hardware" | "software";
    encoder?: string;
    outcome: "succeeded" | "failed";
    failure?: { code: string; message: string; process?: { exitCode: number; timedOut: boolean } };
  }>;
  frameSequence?: { schema: "shellx-motion/streamed-frame-sequence@1"; sha256: string };
  quality?: { warnings: string[]; frameCount: number; blankFrames: number; uniqueFrameHashes: number; uniqueFrameHashesExact: boolean };
}

/** Native terminal evidence after removing output paths and unbounded receipt collections. */
export interface StreamingFinalNativeProducerEvidence {
  schema: "shellx-motion/native-frame-producer-evidence@1";
  producer: { frameCacheEntries: 0; emittedFrameCount: number; inFlightPngHandoffs: number; peakInFlightPngHandoffs: number };
  session: {
    cleanupState: "not_opened" | "open" | "closed" | "close_failed";
    frameCacheEntries: 0;
    assetCache: { scope: "native-render-session-decoded-assets"; includedInFrameRetention: false };
  };
  terminal: {
    lastFrameReceipt: Pick<OperationReceipt, "schema" | "id" | "operation" | "status" | "packageId" | "createdAt" | "lane"> | null;
    laneWarnings: string[];
    warningsOmitted: number;
    downstreamAudioHandoffLayers: Array<{ id: string; type: string }>;
    audioHandoffLayersOmitted: number;
  };
}

/** Bounded source evidence retained by the final adapter, without frame buffers, paths, or result arrays. */
export type StreamingFinalProducerEvidence =
  | { frameLane: "browser"; evidence: BrowserStreamingFrameProducerEvidence }
  | { frameLane: "native"; evidence: StreamingFinalNativeProducerEvidence }
  | { frameLane: "gpu"; evidence: GpuStreamingFrameProducerEvidence & { videoStaging?: StreamingFinalGpuVideoStagingEvidence } }
  /** Internal fixed-PBR session. It is still delivered through the public GPU raw-RGBA lane. */
  | { frameLane: "gpu-pbr"; evidence: GpuScene3dGltfPbrStreamingProducerEvidence };

/** Bounded, path-free proof that GPU video PCM and its aggregate reservation reached final delivery. */
export interface StreamingFinalGpuVideoStagingEvidence {
  readonly ledger: GpuVideoStagingLedger;
  /** SHA-256 over the canonically ordered immutable full-source PCM hashes. */
  readonly pcmSha256: string;
}

/** Receipt-ready evidence placed at `receipt.output.frameTransport` on a streamed success. */
export interface StreamingFinalFrameTransportEvidence {
  delivery: "streamed";
  frameLane: "browser" | "native" | "gpu";
  frameCount: number;
  retainedFrameCount: 0;
  producer: StreamingFinalProducerEvidence;
  /** Present only after a governed GPU module lease released successfully. */
  effectModules?: GpuEffectModuleFinalReceiptEvidence;
  encoderHandoff: StreamingFinalEncoderHandoffEvidence;
}

/** Static command-planning result; errors are typed and no execution has begun. */
export type StreamingFinalCommandPlanResult =
  | { ok: true; transport: Extract<FinalVideoFrameTransportPlan, { delivery: "streamed" }>; command: FfmpegCommand }
  | { ok: false; transport: FinalVideoFrameTransportPlan; error: { code: string; message: string } };

/** Executed streamed-final result, carrying either a Core receipt or bounded failure evidence. */
export type RenderStreamingFinalResult =
  | { ok: true; command: FfmpegCommand; receipt: OperationReceipt; transport: StreamingFinalFrameTransportEvidence }
  | {
      ok: false;
      transport: FinalVideoFrameTransportPlan;
      error: {
        code: string;
        message: string;
        resources?: LocalMotionJobEvidence;
        handoff?: StreamingFinalEncoderHandoffEvidence;
        partialOutput?: {
          path: string;
          status: "missing" | "unverified" | "nonconforming" | "available";
          sha256?: string;
          observedMedia?: ProbeMediaResult;
          validationFailure?: string;
          audioMaster?: RenderAudioMasterEvidence;
          tools: { ffmpeg: MotionToolIdentity; ffprobe?: MotionToolIdentity };
        };
        producer?: StreamingFinalProducerEvidence;
        /** The final link was attempted; inspect these canonical public paths before retrying. */
        possiblyCommitted?: true;
        publicPaths?: readonly string[];
        expectedPublication?: PublicationCommitUncertainEvidence;
      };
    };
