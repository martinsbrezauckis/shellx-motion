import type { GpuEffectModuleStaticDescriptor, GpuHybridTextureStaticDescriptor, GpuSceneBehaviorFrameEvidenceFact, GpuSceneBehaviorStaticPlan, GpuSceneStaticMaxima, MotionBrowserExecutableLocation, MotionPackage } from "@shellx-motion/core";
import type { GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import type { GpuEffectModuleApplicationLedger, GpuEffectModuleBeginUseLease } from "./gpu-effect-module-use-authority";
import type { GpuEnvironmentSessionEnvelope } from "./gpu-page-environment-envelope";
import type { GpuBrowserProcessTreeContainment, GpuStreamingJobContext } from "./gpu-process-containment";
import type { GpuPipelineCatalogEvidence, GpuResourceBudgetEvidence, GpuStaticSceneFingerprintEvidence } from "./gpu-provenance";
import type { PreparedGpuSceneResources } from "./gpu-scene-resources";
import type { GpuReadbackFrameObservation, GpuRuntimeEvidence, GpuSessionFontResource, GpuSessionImageIdentity, GpuSessionImageResource, GpuTextFitEvidence } from "./gpu-runtime-types";
import type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import type { GpuVideoFrameProvider, GpuVideoFrameProviderEvidence } from "./gpu-video-frame-provider";
import type { GpuHybridCaptureBinding } from "./gpu-browser-hybrid";
import type { GpuHybridBrowserCapture } from "./gpu-browser-hybrid";
import type { GpuRestrictedShaderHybridBinding, GpuRestrictedShaderHybridCapture } from "./gpu-restricted-shader-hybrid";
import type { GpuSegmentedHybridAdmission, GpuSegmentedHybridRangeCleanupEvidence, GpuSegmentedHybridRangeLedger, GpuSegmentedHybridRangeScheduleEntry } from "./gpu-segmented-hybrid-types";
import type { GpuSessionDynamicImageReservation } from "./gpu-runtime-types";

export interface GpuStreamingFrameSink {
  write(frame: { index: number; atMs: number; format: "rgba"; width: number; height: number; strideBytes: number; colorSpace: "srgb"; alphaMode: "straight"; rgba: Buffer }): Promise<void>;
}

export interface GpuStreamingFrameProducerInput {
  pkg: MotionPackage;
  /** Compiled by final preflight before any package resource read or browser launch. */
  staticPlan: GpuStreamingStaticPlan;
  /** Separate Core behavior identity; the legacy static-plan@1 remains the resource topology. */
  behaviorStaticPlan?: GpuSceneBehaviorStaticPlan;
  /**
   * An already-current, host-owned use lease for every descriptor in a
   * module-bearing static plan.  The producer neither acquires nor releases
   * it: outer final/segment lifecycle owns that linearization.
   */
  effectModuleLease?: GpuEffectModuleBeginUseLease;
  openRuntime?: (images: readonly GpuSessionImageResource[], fonts: readonly GpuSessionFontResource[], options: { finalBrowser: { scratchRoot: string; maxProcessTreeRssBytes: number; signal: AbortSignal }; browserLocation?: MotionBrowserExecutableLocation; environmentEnvelope?: GpuEnvironmentSessionEnvelope; dynamicImages?: readonly GpuSessionDynamicImageReservation[] }) => Promise<GpuFrameRenderSessionOpenResult>;
  resources?: PreparedGpuSceneResources;
  openVideoProvider?: () => Promise<GpuVideoFrameProvider>;
  /** Internal host/test seam. Production opens this only from the one GPU runtime browser. */
  openHybridCapture?: (input: { pkg: MotionPackage; runtime: import("./gpu-frame-renderer").GpuFrameRenderSession; job: GpuStreamingJobContext }) => Promise<GpuHybridBrowserCapture | GpuRestrictedShaderHybridCapture>;
  frameTimeoutMs?: number;
  /** Internal durable-segment host seam. Indices remain canonical global timeline indices. */
  range?: GpuStreamingFrameRange;
  /** Internal host-only executable binding used to recheck every durable range. */
  browserLocation?: MotionBrowserExecutableLocation;
  /** Internal B2 host seam. The source remains opaque; only Core exact range schedule crosses it. */
  segmentedHybrid?: {
    readonly admission: GpuSegmentedHybridAdmission;
    readonly schedule: readonly GpuSegmentedHybridRangeScheduleEntry[];
  };
}

export interface GpuStreamingFrameRange {
  readonly index: number;
  readonly startFrameIndex: number;
  readonly endFrameIndexExclusive: number;
}

/** Range-local evidence retained by the producer but never published as a full raw-frame cache. */
export interface GpuStreamingFrameRangeEvidence {
  readonly frameHashes: readonly string[];
  readonly framePlanFingerprints: readonly string[];
  /** Direct strict-hybrid equivalent of the B2 range ledger; source evidence stays in `evidence.hybrid`. */
  readonly directHybridLedger?: GpuSegmentedHybridRangeLedger;
  readonly segmentedHybrid?: {
    readonly identity: GpuSegmentedHybridAdmission["identity"];
    readonly ledger: GpuSegmentedHybridRangeLedger;
    readonly cleanup: GpuSegmentedHybridRangeCleanupEvidence;
  };
}

export interface GpuStreamingFrameProducerMetrics {
  readonly delivery: "streamed-raw-rgba"; readonly ordering: "canonical-index-timestamp"; readonly frameCount: number; readonly emittedFrames: number;
  readonly activeFrameHandoffs: number; readonly peakConcurrentFrameHandoffs: number; readonly activeRgbaBuffers: number; readonly peakRgbaBuffers: number;
  readonly retainedFrameCount: 0; readonly sessionFrameCacheEntries: 0;
}

/**
 * Aggregate, path-free facts for the portable GPU-readback-to-raw-RGBA route.
 * Timing is observational qualification evidence and is deliberately separate
 * from the deterministic byte/copy/allocation transport identity.
 */
export interface GpuReadbackTransportEvidence {
  readonly schema: "shellx-motion/gpu-readback-transport@1";
  readonly transport: {
    readonly path: "webgpu-texture-map-read-cdp-base64-owned-rgba";
    readonly framesObserved: number;
    readonly width: number;
    readonly height: number;
    readonly tightBytesPerRow: number;
    readonly mappedBytesPerRow: number;
    readonly bytes: {
      readonly gpuTextureToMappedReadback: number;
      readonly cdpBase64Payload: number;
      readonly hostBase64Decoded: number;
    };
    readonly allocations: {
      readonly hostBase64Decode: number;
      readonly rowCompaction: number;
      readonly straightAlpha: 0;
    };
    readonly rowCompaction: {
      readonly tightRowFrames: number;
      readonly paddedRowFrames: number;
      readonly copiedBytes: number;
      readonly allocationCount: number;
    };
    readonly straightAlpha: {
      readonly inPlaceOwnedBufferFrames: number;
      readonly copiedBytes: 0;
      readonly allocationCount: 0;
    };
    readonly output: {
      readonly format: "rgba";
      readonly colorSpace: "srgb";
      readonly alphaMode: "straight";
      readonly strideBytes: number;
      readonly hashing: "sha256-tight-straight-rgba";
    };
  };
  readonly timing: {
    readonly observational: true;
    readonly clock: "node-process-hrtime";
    readonly scope: "admitted-frame-render-and-readback";
    readonly framesObserved: number;
    readonly totalNanoseconds: number;
    readonly minNanoseconds: number;
    readonly maxNanoseconds: number;
  };
}

export interface GpuStreamingProvenanceEvidence {
  readonly pipelineCatalog: GpuPipelineCatalogEvidence | null;
  readonly staticPlan: GpuStreamingStaticPlanEvidence | null;
  readonly staticScene: GpuStaticSceneFingerprintEvidence | null;
  readonly resourceBudget: GpuResourceBudgetEvidence | null;
}

/** Immutable Core topology handed to the producer; no geometry cache is implied. */
export interface GpuStreamingStaticPlan {
  readonly schema: "shellx-motion/gpu-scene-static-plan@1";
  readonly fingerprint: string;
  readonly documentFingerprint: string;
  readonly canonicalFrameCount: number;
  readonly resources: readonly { key: string; kind: "image" | "video" | "font" | "browser-surface"; assetRef: string; family?: string }[];
  /** Existing B2 branch; C2 refuses this in combination with effectModules. */
  readonly hybridTextures?: readonly GpuHybridTextureStaticDescriptor[];
  /** Omitted, rather than empty, for the legacy no-module identity. */
  readonly effectModules?: readonly GpuEffectModuleStaticDescriptor[];
  readonly layers: readonly {
    id: string;
    type: string;
    groupDepth: number;
    geometry: { reuse: "not-claimed" };
  }[];
  readonly maxima: Readonly<GpuSceneStaticMaxima>;
}

export interface GpuStreamingStaticPlanEvidence {
  readonly schema: "shellx-motion/gpu-scene-static-plan@1";
  readonly fingerprint: string;
  readonly documentFingerprint: string;
  readonly canonicalFrameCount: number;
  readonly resourceReferencesSha256: string;
  readonly resourceReferenceCount: number;
  readonly maxima: Readonly<GpuSceneStaticMaxima>;
  readonly geometryReuse: "not-claimed";
  /**
   * Exact closed descriptors only when modules are declared.  These hold
   * hashes and normalized parameters, never a registry path or raw manifest.
   */
  readonly effectModules?: readonly GpuEffectModuleStaticDescriptor[];
}

/**
 * Scalar facts read while the effect pass remains resident.  They deliberately
 * exclude page/session internals and all registry/file details.
 */
export interface GpuStreamingEffectModuleLiveResources {
  readonly uniformBufferSlots: 1;
  readonly uniformBytes: 160;
  readonly bindGroupSlots: 1;
  readonly passes: number;
  readonly frames: number;
  readonly lateAllocationRefusals: 0;
  readonly persistentTextureCount: 0;
}

/** Exact scalar release facts read only after the Browser session has closed. */
export interface GpuStreamingEffectModuleTerminalResources {
  readonly uniformBufferSlots: 0;
  readonly uniformBytes: 0;
  readonly bindGroupSlots: 0;
  readonly pipelineReleases: 1;
  readonly preparedBindGroupReleases: 1;
  readonly arenaUniformBufferDestructions: 1;
}

/**
 * Present only for a governed module-bearing delivery.  Registry release is
 * intentionally still pending: the outer final/range owner releases its lease
 * after this producer has closed its Browser runtime.
 */
export interface GpuStreamingEffectModuleEvidence {
  readonly schema: "shellx-motion/gpu-effect-module-streaming-use@1";
  readonly ledger: GpuEffectModuleApplicationLedger;
  readonly resources: {
    readonly live: GpuStreamingEffectModuleLiveResources | null;
    readonly terminal: GpuStreamingEffectModuleTerminalResources | null;
  };
  readonly runtimeCleanup: "complete" | "failed";
  readonly leaseRelease: "outer-host-owned-pending";
}

/** Parallel behavior identity for GPU streaming; omitted from all legacy evidence. */
export interface GpuStreamingBehaviorEvidence {
  readonly schema: "shellx-motion/gpu-scene-behavior-streaming@1";
  readonly staticFingerprint: string;
  readonly baseStaticFingerprint: string;
  readonly behaviorStaticFingerprint: string;
  readonly behaviorSourceSha256: string;
  readonly targetLayerIds: readonly string[];
  readonly staticBudget: Readonly<{ baseResourceReferenceCount: number; behaviorInputBytes: number; bindingCount: number; enabledBindingCount: number; behaviorFrameWorkUnits: number }>;
  /** Exact per-frame Core wrapper facts; range-local when segmented. */
  readonly frames: readonly GpuSceneBehaviorFrameEvidenceFact[];
  readonly framePlanSequenceSha256: string;
  readonly frameBudgetSequenceSha256: string;
}

export interface GpuStreamingFrameProducerEvidence {
  readonly schema: "shellx-motion/gpu-streaming-producer@1";
  readonly inputHashes: Readonly<Record<string, string>>;
  /** Exact source and page-decoded identities for immutable still textures; no pixel buffer is retained. */
  readonly immutableImageResources: readonly GpuSessionImageIdentity[];
  readonly frameSequenceSha256: string | null;
  readonly framePlanSequenceSha256: string | null;
  readonly provenance: GpuStreamingProvenanceEvidence;
  readonly gpu: GpuRuntimeEvidence | null;
  /** Exact version from the pre-contained Chromium root that rendered this producer. */
  readonly browserVersion: string | null;
  readonly video: GpuVideoFrameProviderEvidence | null;
  /** Browser-produced source pixels, explicitly distinct from GPU-native draws. */
  readonly hybrid: ((GpuHybridCaptureBinding | GpuRestrictedShaderHybridBinding) & {
    readonly inputHashes: Readonly<Record<string, string>>;
    readonly capturedFrames: number;
    /** Legacy direct-capture sequence: {index,atMs,pngSha256,rgbaSha256}. */
    readonly captureFrameSequenceSha256: string | null;
    /** B2 exact Core request/resource ledger sequence, distinct from the legacy receipt field. */
    readonly exactCaptureLedgerSequenceSha256: string | null;
  }) | null;
  readonly typography: {
    authority: "manifest-font-face-browser-shaped";
    shaping: "canvas-2d";
    fallbackPolicy: "manifest-bound-required";
    fontProbe: "font-face-load-and-font-set-check";
    fontAssets: Array<{ resourceId: string; assetRef: string; family: string; weight: number; style: string; sha256: string }>;
    textFit?: {
      authority: "browser-canvas-glyph-bounds";
      checkedFrameCount: number;
      retainedObservationCount: number;
      omittedObservationCount: number;
      observations: readonly (GpuTextFitEvidence & { atMs: number })[];
    };
  };
  readonly runtimeLifecycle: { browserSession: "single-per-render"; device: "persistent-per-render"; pipelines: "fixed-reused" };
  /** Exact bounded byte/copy/allocation evidence; absent until a producer has emitted frames. */
  readonly readback: GpuReadbackTransportEvidence | null;
  /** Frozen scalar allocation counters read before the page session is torn down. */
  readonly sessionResources: GpuPageSessionResourceMetrics | null;
  /** Omitted from legacy/no-module producer evidence and receipt inputs. */
  readonly effectModules?: GpuStreamingEffectModuleEvidence;
  /** Omitted from no-behavior producer evidence and receipt inputs. */
  readonly behaviors?: GpuStreamingBehaviorEvidence;
  readonly processMonitoring: {
    mode: "precontained-direct-chromium"; chromiumRootPid: number | "unavailable"; watchedRoot: "precontained-chromium-root" | "not_registered";
    rssScope: "precontained-chromium-tree" | "unavailable"; measurement: "exact-precontained-chromium-root-pid" | "not_started"; watchRegistered: boolean;
    containment: GpuBrowserProcessTreeContainment | null; encoderContainmentCoversChromium: boolean;
    reasonCode?: "browser_pid_unavailable" | "final_launch_context_unavailable" | "browser_containment_unavailable";
  };
  readonly session: { state: "idle" | "opening" | "rendering" | "closing" | "closed" | "not_opened" | "open_failed" | "cleanup_failed"; cleanup: "not_started" | "pending" | "complete" | "failed" };
}

export interface GpuStreamingFrameProducer {
  readonly frameCount: number; readonly durationMs: number; readonly fps: number; readonly width: number; readonly height: number;
  readonly metrics: Readonly<GpuStreamingFrameProducerMetrics>; readonly evidence: Readonly<GpuStreamingFrameProducerEvidence>;
  /** Internal-only range-local proof used by durable segment storage. */
  readonly rangeEvidence: Readonly<GpuStreamingFrameRangeEvidence> | null;
  produce(sink: GpuStreamingFrameSink, job: GpuStreamingJobContext): Promise<void>;
}
