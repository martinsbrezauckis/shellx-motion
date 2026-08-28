/**
 * Public, closed adoption of durable segmented final delivery.
 *
 * Callers select only the segment size and whether an existing derived checkpoint may be resumed.
 * Store roots, FFV1 artifacts, concat lists and low-level producers stay private to this package.
 */
import {
  createRenderReceipt,
  motionBehaviorLaneRefusal,
  motionLayoutGapAnimationLaneRefusal,
  motionRelationLaneRefusal,
  motionScene3DAnimationLaneRefusal,
  requiredLoadedPackageInputHashes,
  type FrameSequenceQualityPolicy,
  type LocalMotionJobEvidence,
  type LocalMotionJobGovernor,
  type MotionAudioMasterBus,
  type MotionPackage,
  type OperationReceipt,
  type PublicationCommitUncertainEvidence
} from "@shellx-motion/core";
import {
  type BrowserCaptureWorkflow,
  type BrowserNetworkAccessOptions,
  type BrowserRenderSessionOptions,
  resolveGpuEffectModuleStaticPlanForUse,
  type MotionBrowserRenderSessionFactory
} from "@shellx-motion/renderer-browser";
import type { EncodePolicyCache } from "./encode-policy.js";
import type { FfmpegAudioInput, FfmpegExportPreset, FfmpegRunner } from "./index.js";
import { planRenderSegments } from "./segmented-final-internal/render-segment-plan.js";
import {
  renderSegmentedFinal as renderSegmentedFinalInternal,
  type SegmentedFinalTransportEvidence
} from "./segmented-final-internal/segmented-final-adapter.js";
import type { SegmentedFinalFailureEvidence } from "./segmented-final-internal/segmented-final-adapter-types.js";
import { SegmentedPublicationIdentityError } from "./segmented-final-internal/segmented-final-adapter-store.js";
import type { StreamingFfmpegProcessFactory } from "./streaming-process.js";
import type { SegmentedGpuToolPolicy } from "./segmented-final-gpu-policy.js";
import type { SegmentedGpuStaticPreflight } from "./segmented-final-gpu-host-types.js";
import { createSegmentedRangeProducer, segmentedFrameLaneRefusal, segmentedProducerFacts } from "./segmented-final-producers.js";
import { readSegmentedFinalRequest } from "./segmented-final-request.js";
import { hasGpuScene3dGltfPbrFinalRouteMarker } from "@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-final";
export type { SegmentedGpuToolPolicy } from "./segmented-final-gpu-policy.js";

export interface SegmentedFinalOptions {
  /** Positive count of canonical frames per durable FFV1 checkpoint. */
  segmentFrames: number;
  /** Reopen the one store deterministically derived from the final output path. */
  resume?: boolean;
}

/** Host-only controls. None of these are accepted from the CLI, Debug, MCP, or SDK wire surfaces. */
export interface SegmentedFinalToolPolicy {
  runner?: FfmpegRunner;
  cache?: EncodePolicyCache;
  ffmpegVersion?: string | null;
  ffprobeVersion?: string | null;
  forceSoftwareEncode?: boolean;
  verifyDeliveredColor?: boolean;
  processFactory?: StreamingFfmpegProcessFactory;
  browser?: {
    workflow?: BrowserCaptureWorkflow;
    networkAccess?: BrowserNetworkAccessOptions;
    launchBrowser?: BrowserRenderSessionOptions["launchBrowser"];
    sessionFactory?: MotionBrowserRenderSessionFactory;
    /** Set only by a host that proved approved-agent script authority for this session. */
    activeScriptSessionAvailable?: boolean;
  };
  native?: { now?: () => string };
  gpu?: SegmentedGpuToolPolicy;
}

export interface RenderSegmentedFinalInput {
  pkg: MotionPackage;
  frameLane: "browser" | "native" | "gpu";
  outputPath: string;
  segmented: SegmentedFinalOptions;
  preset?: FfmpegExportPreset;
  audioPath?: string;
  audio?: FfmpegAudioInput;
  audioTracks?: FfmpegAudioInput[];
  audioMaster?: MotionAudioMasterBus;
  inputRoots?: string[];
  outputRoots?: string[];
  quality?: FrameSequenceQualityPolicy;
  qualityManifest?: { exactSourceComparison?: "required" };
  signal?: AbortSignal;
  governor?: LocalMotionJobGovernor;
  scratchRoot?: string;
  operation?: string;
  callerId?: string;
  jobId?: string;
  now?: () => string;
  toolPolicy?: SegmentedFinalToolPolicy;
}

export type SegmentedFinalErrorCode =
  | "segment_store_busy"
  | "segment_checkpoint_invalid"
  | "segment_source_changed"
  | "segmented_final_unsupported"
  | "job_cancelled"
  | "job_deadline_exceeded"
  | "job_rss_limit_exceeded"
  | "job_scratch_budget_failed"
  | "segmented_final_failed";

export interface SegmentedFinalPublicFailure {
  code: SegmentedFinalErrorCode;
  message: string;
  retryable: boolean;
  evidence: SegmentedFinalFailureEvidence;
  resources?: LocalMotionJobEvidence;
  /** A direct final link may exist but failed the no-follow identity proof after it was attempted. */
  possiblyCommitted?: true;
  publicPaths?: readonly string[];
  expectedPublications?: readonly PublicationCommitUncertainEvidence[];
}

export interface SegmentedFinalFrameTransportEvidence extends SegmentedFinalTransportEvidence {
  frameLane: "browser" | "native" | "gpu";
  store: { location: "derived-from-output"; intent: "create" | "resume" };
}

export type RenderSegmentedFinalResult =
  | { ok: true; receipt: OperationReceipt; transport: SegmentedFinalFrameTransportEvidence }
  | { ok: false; error: SegmentedFinalPublicFailure };

/**
 * Render one loaded package through bounded durable segments. The derived store is acquired with
 * an exclusive sibling lock; a failed run preserves only its verified checkpoint for a later
 * explicit resume, while a successful run publishes no-clobber and removes owned intermediates.
 */
export async function renderSegmentedFinal(candidate: RenderSegmentedFinalInput): Promise<RenderSegmentedFinalResult> {
  const parsed = readSegmentedFinalRequest(candidate);
  if (!parsed.ok) return publicFailure(parsed.code, parsed.message, false, { phase: "preflight" });
  const { pkg, frameLane, segmented, toolPolicy, request } = parsed;
  try {
    const lane = frameLane === "browser" ? "ffmpeg-browser" : frameLane === "native" ? "ffmpeg-native" : "ffmpeg-gpu";
    const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(pkg.motion, lane);
    if (layoutGapAnimationRefusal) return publicFailure("segmented_final_unsupported", layoutGapAnimationRefusal.message, false, { phase: "preflight" });
    const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(pkg.motion, lane);
    if (scene3dAnimationRefusal) return publicFailure("segmented_final_unsupported", scene3dAnimationRefusal.message, false, { phase: "preflight" });
    // T2B2 has no segmented lowerer for the opaque exact-time geometry wrapper. Refuse
    // before hashing the package, opening static resources, acquiring a store, or staging output.
    if (frameLane === "gpu" && pkg.motion.layers.some((layer) => layer.visible !== false && layer.geometryKeyframes !== undefined)) {
      return publicFailure("segmented_final_unsupported", "GPU segmented delivery does not support shape geometry keyframes; only the strict Browser GPU preview producer can execute them.", false, { phase: "preflight" });
    }
    const relationRefusal = motionRelationLaneRefusal(pkg.motion, lane);
    if (relationRefusal) return publicFailure("segmented_final_unsupported", relationRefusal.message, false, { phase: "preflight" });
    const behaviorRefusal = frameLane === "browser"
      ? motionBehaviorLaneRefusal(pkg.motion, "ffmpeg-browser")
      : frameLane === "native"
        ? motionBehaviorLaneRefusal(pkg.motion, "ffmpeg-native")
        : undefined;
    if (behaviorRefusal) return publicFailure("segmented_final_unsupported", behaviorRefusal.message, false, { phase: "preflight" });
    if (hasGpuScene3dGltfPbrFinalRouteMarker(pkg)) {
      return publicFailure("segmented_final_unsupported", "The fixed glTF PBR route admits direct final only; segmented and resume delivery are refused before Browser resource preparation.", false, { phase: "preflight" });
    }
    const laneRefusal = segmentedFrameLaneRefusal({ pkg, frameLane, ...(toolPolicy ? { toolPolicy } : {}) } as RenderSegmentedFinalInput);
    if (laneRefusal) return publicFailure("segmented_final_unsupported", laneRefusal, false, { phase: "preflight" });
  } catch {
    return publicFailure("segment_checkpoint_invalid", "Segmented final delivery requires a complete loaded package and canonical timeline.", false, { phase: "preflight" });
  }
  const frameCount = Math.ceil((pkg.motion.durationMs / 1_000) * pkg.motion.fps);
  const input = { pkg, frameLane, ...(toolPolicy ? { toolPolicy } : {}) } as RenderSegmentedFinalInput;
  let plan;
  let inputHashes: Readonly<Record<string, string>>;
  let producer;
  let gpuPreflight: SegmentedGpuStaticPreflight | undefined;
  try {
    plan = planRenderSegments({ frameCount, segmentFrames: segmented.segmentFrames });
    inputHashes = requiredLoadedPackageInputHashes(pkg, "Segmented final delivery");
    if (frameLane === "gpu") {
      const authority = toolPolicy?.gpu?.effectModuleUseAuthority;
      const resolved = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, authority);
      if (!resolved.ok) return publicFailure("segmented_final_unsupported", resolved.failure.message, false, { phase: "preflight" });
      const hasModules = (resolved.plan.effectModules?.length ?? 0) > 0;
      if (hasModules && (!authority || !resolved.resolution)) {
        return publicFailure("segmented_final_unsupported", "GPU segmented effect modules require a trusted host use authority before governor admission.", false, { phase: "preflight" });
      }
      if (hasModules && (resolved.plan.hybridTextures?.length ?? 0) > 0) {
        return publicFailure("segmented_final_unsupported", "GPU segmented delivery does not combine governed effect modules with B2 hybrid surfaces.", false, { phase: "preflight" });
      }
      if (!hasModules && resolved.resolution) {
        return publicFailure("segmented_final_unsupported", "GPU segmented module resolution was supplied for a module-free static plan.", false, { phase: "preflight" });
      }
      gpuPreflight = {
        staticPlan: resolved.plan,
        ...(resolved.behaviorPlan ? { behaviorStaticPlan: resolved.behaviorPlan } : {}),
        ...(hasModules ? { effectModuleUse: { authority: authority!, resolution: resolved.resolution! } } : {})
      };
    }
    producer = frameLane === "gpu" ? undefined : await segmentedProducerFacts(input);
  } catch (error) {
    return publicFailure("segment_checkpoint_invalid", "Segmented final setup could not prove the package and canonical segment plan.", false, {
      phase: "preflight"
    });
  }

  const result = await renderSegmentedFinalInternal({
    package: {
      rootPath: pkg.root,
      id: pkg.manifest.id,
      manifestSha256: inputHashes["manifest.json"]!,
      inputHashes
    },
    timeline: {
      motionSha256: inputHashes[pkg.manifest.motion]!,
      frameCount,
      durationMs: pkg.motion.durationMs,
      fps: pkg.motion.fps,
      width: pkg.motion.width,
      height: pkg.motion.height
    },
    frameLane,
    ...(producer ? { producer } : {}),
    plan,
    outputPath: request.outputPath,
    ...(request.privateOutputPublication ? { privateOutputPublication: request.privateOutputPublication } : {}),
    store: { intent: segmented.resume === true ? "resume" : "create" },
    preset: request.preset,
    audioPath: request.audioPath,
    audio: request.audio,
    audioTracks: request.audioTracks,
    audioMaster: request.audioMaster,
    inputRoots: request.inputRoots,
    outputRoots: request.outputRoots,
    quality: request.quality,
    qualityManifest: request.qualityManifest,
    signal: request.signal,
    governor: request.governor,
    scratchRoot: request.scratchRoot,
    operation: request.operation ?? "ffmpeg.segmented-final",
    callerId: request.callerId,
    jobId: request.jobId,
    cache: toolPolicy?.cache,
    ffmpegVersion: toolPolicy?.ffmpegVersion,
    ffprobeVersion: toolPolicy?.ffprobeVersion,
    forceSoftwareEncode: toolPolicy?.forceSoftwareEncode,
    verifyDeliveredColor: toolPolicy?.verifyDeliveredColor,
    processFactory: toolPolicy?.processFactory,
    ...(frameLane === "gpu" ? {} : { createRangeProducer: createSegmentedRangeProducer(input) }),
    ...(frameLane === "gpu" ? { gpuHost: { pkg, policy: toolPolicy?.gpu, ...(gpuPreflight ? { preflight: gpuPreflight } : {}) } } : {})
  });
  if (!result.ok) return normalizedFailure(result.error.code, result.error.evidence, result.error.primaryCause);

  const transport: SegmentedFinalFrameTransportEvidence = {
    ...result.transport,
    frameLane,
    store: { location: "derived-from-output", intent: segmented.resume === true ? "resume" : "create" }
  };
  const receipt = createRenderReceipt({
    id: `segmented-final-${result.output.sha256.slice(0, 16)}`,
    packageId: pkg.manifest.id,
    lane: "ffmpeg",
    status: "passed",
    inputHashes: {
      ...result.receiptEvidence.inputHashes,
      ...(frameLane === "gpu" && result.transport.producer.frameLane === "gpu"
        ? result.transport.producer.finalReceiptInputHashes
        : {})
    },
    output: {
      ...result.receiptEvidence.output,
      frameTransport: transport,
      ...(transport.producer.scriptExecution ? { scriptExecution: transport.producer.scriptExecution } : {})
    },
    warnings: [...result.receiptEvidence.warnings, ...transport.producer.warningUnion]
  });
  receipt.createdAt = request.now?.() ?? receipt.createdAt;
  receipt.artifacts = result.receiptEvidence.artifacts.map((artifact) => ({ ...artifact }));
  return { ok: true, receipt, transport };
}

function normalizedFailure(code: string, evidence: SegmentedFinalFailureEvidence, primaryCause: unknown): RenderSegmentedFinalResult {
  if (code === "segment_store_busy") return publicFailure(code, "Another segmented render owns this output's derived checkpoint store.", true, evidence);
  if (code === "segment_source_changed") return publicFailure(code, "Package content changed while durable checkpoints were being created; start a fresh segmented render.", false, evidence);
  if (code === "job_cancelled" || code === "job_deadline_exceeded" || code === "job_rss_limit_exceeded" || code === "job_scratch_budget_failed") {
    return publicFailure(code, resourceMessage(code), code === "job_cancelled" || code === "job_deadline_exceeded", evidence, evidence.resources);
  }
  const uncertainty = segmentedPublicationUncertainty(primaryCause);
  if (uncertainty) {
    return publicFailure(
      "segment_checkpoint_invalid",
      "The final destination may have been created but could not be proven identical to verified staging; inspect the reported public evidence before retrying.",
      false,
      evidence,
      evidence.resources,
      uncertainty
    );
  }
  if (code.includes("checkpoint") || code.includes("integrity") || code.includes("tampered") || code.includes("publication_identity")) {
    return publicFailure("segment_checkpoint_invalid", "The durable checkpoint or its publication proof was invalid; inspect retained state and start a fresh render if necessary.", false, evidence, evidence.resources);
  }
  if (code.includes("policy") || code.includes("preflight")) {
    return publicFailure("segmented_final_unsupported", "This segmented render request uses a capability or quality contract that is not supported by durable segments.", false, evidence, evidence.resources);
  }
  void primaryCause;
  return publicFailure("segmented_final_failed", "Segmented final delivery did not complete. Verified checkpoints, if any, were retained only for an explicit resume.", true, evidence, evidence.resources);
}

/** Public direct-final failures retain the exact artifact whose post-link proof did not settle. */
export function segmentedPublicationUncertainty(error: unknown): Pick<SegmentedFinalPublicFailure, "possiblyCommitted" | "publicPaths" | "expectedPublications"> | undefined {
  if (!(error instanceof SegmentedPublicationIdentityError)) return undefined;
  return {
    possiblyCommitted: true,
    publicPaths: [error.expectedPublication.publicPath],
    expectedPublications: [error.expectedPublication]
  };
}

function resourceMessage(code: Extract<SegmentedFinalErrorCode, `job_${string}`>): string {
  if (code === "job_cancelled") return "Segmented final delivery was cancelled; retry with segmented.resume to continue from verified checkpoints.";
  if (code === "job_deadline_exceeded") return "Segmented final delivery reached its deadline; retry with segmented.resume after increasing the host deadline.";
  if (code === "job_rss_limit_exceeded") return "Segmented final delivery exceeded the host memory limit; retry after increasing the configured render budget.";
  return "Segmented final delivery exceeded the host scratch-space budget; free space or increase the configured budget before retrying.";
}

function publicFailure(
  code: SegmentedFinalErrorCode,
  message: string,
  retryable: boolean,
  evidence: SegmentedFinalFailureEvidence,
  resources?: LocalMotionJobEvidence,
  uncertainty?: Pick<SegmentedFinalPublicFailure, "possiblyCommitted" | "publicPaths" | "expectedPublications">
): RenderSegmentedFinalResult {
  return { ok: false, error: { code, message, retryable, evidence, ...(resources ? { resources } : {}), ...uncertainty } };
}
