import { canonicalJsonSha256, createGpuHybridTextureSourceSnapshot, createRenderReceipt, motionBehaviorLaneRefusal, motionLayoutGapAnimationLaneRefusal, motionRelationLaneRefusal, motionScene3DAnimationLaneRefusal, normalizeMotionAudioMaster, type GpuSceneBehaviorStaticPlan, type GpuSceneStaticPlan } from "@shellx-motion/core";
import { hasScene3dGltfPbrHdr10FinalLocator } from "@shellx-motion/core/internal/scene3d-gltf-pbr-hdr10-final";
import { runStreamingFinalEncodePolicy } from "./streaming-final-encode-policy.js";
import type { StreamingFfmpegFinalInput } from "./streaming-foundation-types.js";
import { gpuStreamingProducer, gpuVideoStagingEvidence, prepareAdmittedGpuDelivery, preflightGpuDelivery, type GpuDeliveryFailure } from "./streaming-final-gpu.js";
import { gpuFinalEffectModuleReceiptInputHashes, gpuFinalReceiptInputHashes } from "./gpu-final-receipt-provenance.js";
import { combineGpuFinalRenderAndCleanupFailure, releaseAdmittedGpuFinalDelivery } from "./gpu-final-admitted-cleanup.js";
import { bindGpuVideoAudioSnapshots, preliminaryGpuAudio } from "./streaming-final-gpu-audio.js";
import { knownProducerFailure, mergedProducerWarnings, publicEncoderHandoff, publicNativeProducerEvidence, safeProducerMessage } from "./streaming-final-adapter-evidence.js";
import type { RenderStreamingFinalInput, RenderStreamingFinalResult, StreamingFinalFrameTransportEvidence, StreamingFinalProducerEvidence } from "./streaming-final-adapter-types.js";
import {
  gpuEffectModuleFinalReceiptEvidence,
  resolveGpuEffectModuleStaticPlanForUse,
  type BrowserStreamingFrameProducer,
  type GpuEffectModuleBeginUseLease,
  type GpuEffectModuleUseAuthority,
  type GpuEffectModuleUseResolution
} from "@shellx-motion/renderer-browser";
import type { NativeFrameProducerEvidence } from "@shellx-motion/renderer-native";
import { browserProducer, nativeProducer, unpreparedGpuProducer } from "./streaming-final-adapter-producers.js";
import { planStreamingFinalCommand } from "./streaming-final-command-plan.js";
import type { FinalVideoFrameTransportPlan } from "./final-video-frame-transport.js";
import { admittedScene3dGltfPbrPreflight } from "./streaming-final-gltf-pbr.js";
import { hasGpuScene3dGltfPbrFinalRouteMarker, resolveGpuScene3dGltfPbrFinalRoute, type GpuScene3dGltfPbrFinalRouteResolution } from "@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-final";
import { activeGpuVideoKeyframedPlaybackRateLayer } from "./gpu-video-frame-schedule.js";

type StreamingTransport = Extract<FinalVideoFrameTransportPlan, { delivery: "streamed" }>;

/**
 * The resolver is pure and runs before the outer FFmpeg governor.  The
 * resolution deliberately holds no registry lock; the lease linearizes the
 * current install/revocation state only after the one final job is admitted.
 */
/** Internal direct-final seam; not exported from the package entrypoint. */
export interface GpuEffectModuleFinalPreflight {
  readonly authority: GpuEffectModuleUseAuthority;
  readonly resolution: GpuEffectModuleUseResolution;
}

/** Internal direct-final seam; not exported from the package entrypoint. */
export interface GpuEffectModuleReleaseState {
  complete: boolean;
  failed: boolean;
  lease?: GpuEffectModuleBeginUseLease;
}

/** Execute one already-publication-staged streamed final. GPU resources and video stay inside its admission. */
export async function renderStreamingFinalUnpublished(input: RenderStreamingFinalInput): Promise<RenderStreamingFinalResult> {
  const { motion } = input.pkg;
  const policy = input.toolPolicy;
  const preliminaryAudio = input.frameLane === "gpu" ? preliminaryGpuAudio(input) : input;
  const preliminaryPlan = planStreamingFinalCommand({
    fps: motion.fps, width: motion.width, height: motion.height, durationMs: motion.durationMs,
    ...(input.frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}), outputPath: input.outputPath,
    ...(input.preset ? { preset: input.preset } : {}), ...(preliminaryAudio.audioPath ? { audioPath: preliminaryAudio.audioPath } : {}),
    ...(preliminaryAudio.audio ? { audio: preliminaryAudio.audio } : {}), ...(preliminaryAudio.audioTracks ? { audioTracks: preliminaryAudio.audioTracks } : {}),
    ...(preliminaryAudio.audioMaster !== undefined ? { audioMaster: preliminaryAudio.audioMaster } : {}),
    ...(input.inputRoots ? { inputRoots: input.inputRoots } : {}), ...(input.outputRoots ? { outputRoots: input.outputRoots } : {}),
    ...(input.quality ? { quality: input.quality } : {}), ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}),
    ...(input.transport ? { transport: input.transport } : {}), ...(input.keepFrames !== undefined ? { keepFrames: input.keepFrames } : {}),
    capturedBrowserWorkflow: Boolean(policy?.browser?.workflow), injectedFrameRenderer: policy?.injectedFrameRenderer === true
  });
  if (!preliminaryPlan.ok) return preliminaryPlan;
  const preflight = await preflightDelivery(input);
  if (!preflight.ok) return { ok: false, transport: preliminaryPlan.transport, error: preflight.failure };
  const audioMaster = normalizeMotionAudioMaster(input.audioMaster) ?? undefined;
  let producerEvidence: StreamingFinalProducerEvidence | undefined;
  let sourceRefusal: { code: string; message: string } | undefined;
  let admittedGpuFailure: GpuDeliveryFailure | undefined;
  const effectModuleRelease: GpuEffectModuleReleaseState | undefined = preflight.effectModuleUse
    ? { complete: false, failed: false }
    : undefined;
  const produce = chooseProducer(input, (evidence) => { producerEvidence = evidence; }, (error) => { sourceRefusal ??= knownProducerFailure(error); });
  const encoded = await runStreamingFinalEncodePolicy({
    fps: motion.fps, width: motion.width, height: motion.height, durationMs: motion.durationMs,
    ...(input.frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}), outputPath: input.outputPath,
    ...(input.preset ? { preset: input.preset } : {}), ...(preliminaryAudio.audioPath ? { audioPath: preliminaryAudio.audioPath } : {}),
    ...(preliminaryAudio.audio ? { audio: preliminaryAudio.audio } : {}), ...(preliminaryAudio.audioTracks ? { audioTracks: preliminaryAudio.audioTracks } : {}),
    ...(audioMaster ? { audioMaster } : {}), ...(input.inputRoots ? { inputRoots: input.inputRoots } : {}), ...(input.outputRoots ? { outputRoots: input.outputRoots } : {}),
    ...(input.quality ? { quality: input.quality } : {}), ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.governor ? { governor: input.governor } : {}),
    ...(input.scratchRoot ? { scratchRoot: input.scratchRoot } : {}), ...(input.operation ? { operation: input.operation } : {}),
    ...(input.callerId ? { callerId: input.callerId } : {}), ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(policy?.runner ? { runner: policy.runner } : {}), ...(policy?.cache ? { cache: policy.cache } : {}),
    ...(policy?.ffmpegVersion !== undefined ? { ffmpegVersion: policy.ffmpegVersion } : {}), ...(policy?.ffprobeVersion !== undefined ? { ffprobeVersion: policy.ffprobeVersion } : {}),
    ...(policy?.forceSoftwareEncode !== undefined ? { forceSoftwareEncode: policy.forceSoftwareEncode } : {}), ...(policy?.verifyDeliveredColor !== undefined ? { verifyDeliveredColor: policy.verifyDeliveredColor } : {}),
    ...(policy?.processFactory ? { processFactory: policy.processFactory } : {}),
    ...(input.frameLane === "gpu" ? { admittedPreflight: preflight.pbrRoute
      ? admittedScene3dGltfPbrPreflight(input, preflight.pbrRoute, (evidence) => { producerEvidence = evidence; }, (error) => { sourceRefusal ??= knownProducerFailure(error); })
    : admittedGpuPreflight(input, gpuStaticPlan(preflight.staticPlan), audioMaster, policy, preflight.effectModuleUse, effectModuleRelease, (failure) => { admittedGpuFailure = failure; }, (evidence) => { producerEvidence = evidence; }, (error) => { sourceRefusal ??= knownProducerFailure(error); }, preflight.behaviorStaticPlan) } : {}),
    produce
  });
  if (!encoded.ok) return encodedFailure(encoded, preliminaryPlan.transport, sourceRefusal, admittedGpuFailure, producerEvidence);
  return encodedSuccess(input, encoded, preliminaryPlan.transport, producerEvidence, effectModuleRelease);
}

async function preflightDelivery(input: RenderStreamingFinalInput): Promise<
  | { ok: true; staticPlan?: import("@shellx-motion/core").GpuSceneStaticPlan; behaviorStaticPlan?: GpuSceneBehaviorStaticPlan; effectModuleUse?: GpuEffectModuleFinalPreflight; pbrRoute?: Extract<GpuScene3dGltfPbrFinalRouteResolution, { kind: "present" }> }
  | { ok: false; failure: { code: string; message: string } }
> {
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(input.pkg.motion, input.frameLane === "browser"
    ? "ffmpeg-browser"
    : input.frameLane === "native"
      ? "ffmpeg-native"
      : "ffmpeg-gpu");
  if (layoutGapAnimationRefusal) return { ok: false, failure: { code: layoutGapAnimationRefusal.code, message: layoutGapAnimationRefusal.message } };
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(input.pkg.motion, input.frameLane === "browser"
    ? "ffmpeg-browser"
    : input.frameLane === "native"
      ? "ffmpeg-native"
      : "ffmpeg-gpu");
  if (scene3dAnimationRefusal) return { ok: false, failure: { code: scene3dAnimationRefusal.code, message: scene3dAnimationRefusal.message } };
  const relationRefusal = motionRelationLaneRefusal(input.pkg.motion, input.frameLane === "browser"
    ? "ffmpeg-browser"
    : input.frameLane === "native"
      ? "ffmpeg-native"
      : "ffmpeg-gpu");
  if (relationRefusal) return { ok: false, failure: { code: relationRefusal.code, message: relationRefusal.message } };
  if (hasScene3dGltfPbrHdr10FinalLocator(input.pkg.manifest.data)) {
    return { ok: false, failure: { code: "gltf_pbr_hdr10_private_direct_final_only", message: "The HDR10 glTF PBR marker refuses generic Browser, Native, GPU, and fallback final routing." } };
  }
  const behaviorRefusal = input.frameLane === "browser"
    ? motionBehaviorLaneRefusal(input.pkg.motion, "ffmpeg-browser")
    : input.frameLane === "native"
      ? motionBehaviorLaneRefusal(input.pkg.motion, "ffmpeg-native")
      : undefined;
  if (behaviorRefusal) return { ok: false, failure: { code: behaviorRefusal.code, message: behaviorRefusal.message } };
  if (hasGpuScene3dGltfPbrFinalRouteMarker(input.pkg) && input.frameLane !== "gpu") {
    return {
      ok: false,
      failure: {
        code: "gltf_pbr_final_direct_final_only",
        message: "The marked glTF PBR package refuses browser/native final fallback; only the authenticated 1280x720 static GPU direct-final lane is admitted.",
      },
    };
  }
  if (input.frameLane === "gpu") {
    return await preflightGpuFinalDelivery(input);
  }
  if (input.frameLane === "browser") {
    const { browserTypographyAttestationRefusal } = await import("@shellx-motion/renderer-browser");
    const failure = browserTypographyAttestationRefusal(input.pkg); if (failure) return { ok: false, failure };
  }
  if (input.frameLane === "native") {
    const { preflightNativeDelivery } = await import("./streaming-final-adapter-producers.js");
    const failure = preflightNativeDelivery(input); if (failure) return { ok: false, failure };
  }
  return { ok: true };
}

/**
 * Pure direct-final GPU admission planning. Both public publication and the
 * unpublished renderer call this before an outer job waits; it opens no
 * package resources and holds no registry lock across the governor boundary.
 */
export async function preflightGpuFinalDelivery(input: RenderStreamingFinalInput): Promise<
  | { ok: true; staticPlan: import("@shellx-motion/core").GpuSceneStaticPlan; behaviorStaticPlan?: GpuSceneBehaviorStaticPlan; effectModuleUse?: GpuEffectModuleFinalPreflight }
  | { ok: true; pbrRoute: Extract<GpuScene3dGltfPbrFinalRouteResolution, { kind: "present" }> }
  | { ok: false; failure: GpuDeliveryFailure }
> {
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(input.pkg.motion, "ffmpeg-gpu");
  if (layoutGapAnimationRefusal) return { ok: false, failure: { code: layoutGapAnimationRefusal.code, message: layoutGapAnimationRefusal.message } };
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(input.pkg.motion, "ffmpeg-gpu");
  if (scene3dAnimationRefusal) return { ok: false, failure: { code: scene3dAnimationRefusal.code, message: scene3dAnimationRefusal.message } };
  // T2B2 deliberately reserves geometry-keyframe execution for the strict Browser GPU
  // preview producer. Do not let its stripped legacy base plan reach final resource or
  // publication admission until a final lowerer can bind the exact frame wrapper.
  if (input.pkg.motion.layers.some((layer) => layer.visible !== false && layer.geometryKeyframes !== undefined)) {
    return { ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU final delivery does not support shape geometry keyframes; only the strict Browser GPU preview producer can execute them." } };
  }
  const keyframedVideoPlaybackRate = activeGpuVideoKeyframedPlaybackRateLayer(input.pkg);
  if (!keyframedVideoPlaybackRate.ok) return { ok: false, failure: keyframedVideoPlaybackRate.failure };
  if (keyframedVideoPlaybackRate.layer) return { ok: false, failure: { code: "gpu_unsupported_feature", layerId: keyframedVideoPlaybackRate.layer.id, message: `GPU final delivery does not support keyframed playbackRate on video layer ${keyframedVideoPlaybackRate.layer.id}; use a static playbackRate.` } };
  const relationRefusal = motionRelationLaneRefusal(input.pkg.motion, "ffmpeg-gpu");
  if (relationRefusal) return { ok: false, failure: { code: relationRefusal.code, message: relationRefusal.message } };
  if (hasScene3dGltfPbrHdr10FinalLocator(input.pkg.manifest.data)) {
    return { ok: false, failure: { code: "gpu_resource_refused", message: "The HDR10 glTF PBR marker requires its private software direct-final lane before GPU resource admission." } };
  }
  if (hasGpuScene3dGltfPbrFinalRouteMarker(input.pkg)) {
    try {
      const resolved = await resolveGpuScene3dGltfPbrFinalRoute(input.pkg);
      if (resolved.kind !== "present") return { ok: false, failure: { code: "gpu_resource_refused", message: "The glTF PBR final marker was present but could not resolve an authenticated route." } };
      return { ok: true, pbrRoute: resolved };
    } catch (error) {
      return { ok: false, failure: { code: "gpu_resource_refused", message: error instanceof Error ? `The glTF PBR final route was refused: ${error.message}` : "The glTF PBR final route was refused." } };
    }
  }
  const authority = input.toolPolicy?.gpu?.effectModuleUseAuthority;
  const resolved = await resolveGpuEffectModuleStaticPlanForUse(input.pkg.motion, authority);
  if (!resolved.ok) return { ok: false, failure: resolved.failure };
  const checked = preflightGpuDelivery(input, resolved.plan, resolved.behaviorPlan);
  if (!checked.ok) return checked;
  const hasModules = (resolved.plan.effectModules?.length ?? 0) > 0;
  if (!hasModules) {
    if (resolved.resolution) {
      return { ok: false, failure: { code: "gpu_resource_refused", message: "GPU effect-module resolution was supplied for a module-free static plan." } };
    }
    return checked;
  }
  if (!authority || !resolved.resolution) {
    return { ok: false, failure: { code: "gpu_resource_refused", message: "GPU effect modules require a trusted host use authority before final admission." } };
  }
  if ((resolved.plan.hybridTextures?.length ?? 0) > 0) {
    return { ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU final delivery does not combine governed effect modules with B2 hybrid surfaces." } };
  }
  return { ...checked, effectModuleUse: { authority, resolution: resolved.resolution } };
}

function gpuStaticPlan(plan: import("@shellx-motion/core").GpuSceneStaticPlan | undefined): import("@shellx-motion/core").GpuSceneStaticPlan {
  if (!plan) throw new Error("GPU final admission did not retain its static scene plan.");
  return plan;
}

function chooseProducer(input: RenderStreamingFinalInput, observe: (evidence: StreamingFinalProducerEvidence) => void, failed: (error: unknown) => void): NonNullable<StreamingFfmpegFinalInput["produce"]> {
  if (input.frameLane === "browser") return browserProducer(input, (evidence: BrowserStreamingFrameProducer["evidence"]) => observe({ frameLane: "browser", evidence }), failed);
  if (input.frameLane === "native") return nativeProducer(input, (evidence: NativeFrameProducerEvidence) => observe({ frameLane: "native", evidence: publicNativeProducerEvidence(evidence) }), failed);
  return unpreparedGpuProducer();
}

export function admittedGpuPreflight(input: RenderStreamingFinalInput, staticPlan: import("@shellx-motion/core").GpuSceneStaticPlan, audioMaster: ReturnType<typeof normalizeMotionAudioMaster> | undefined, policy: RenderStreamingFinalInput["toolPolicy"], effectModuleUse: GpuEffectModuleFinalPreflight | undefined, effectModuleRelease: GpuEffectModuleReleaseState | undefined, failed: (failure: GpuDeliveryFailure) => void, observe: (evidence: StreamingFinalProducerEvidence) => void, producerFailed: (error: unknown) => void, behaviorStaticPlan?: GpuSceneBehaviorStaticPlan) {
  return async (context: import("./streaming-foundation-types.js").StreamingFfmpegAdmittedPreparationContext) => {
    let lease: GpuEffectModuleBeginUseLease | undefined;
    let admitted: Extract<Awaited<ReturnType<typeof prepareAdmittedGpuDelivery>>, { ok: true }> | undefined;
    try {
      // This is intentionally the first admitted action. `beginUse` proves a
      // current install and revocation state, then returns with no registry
      // lock retained before any package resource, browser, or encoder work.
      if (effectModuleUse) {
        lease = await effectModuleUse.authority.beginUse(effectModuleUse.resolution);
        if (effectModuleRelease) effectModuleRelease.lease = lease;
      }
      const hybridTopologyPreflight = directGpuHybridTopologyPreflight(staticPlan);
      const prepared = await prepareAdmittedGpuDelivery(input, staticPlan, {
        ...context,
        ...(hybridTopologyPreflight ? { hybridTopologyPreflight } : {})
      }, behaviorStaticPlan);
      if (!prepared.ok) { failed(prepared.failure); throw new Error(prepared.failure.message); }
      admitted = prepared;
      const delivery = prepared.delivery;
      const gpuAudio = delivery.video ? bindGpuVideoAudioSnapshots(input, delivery.video.audioSnapshots) : { audioPath: input.audioPath, audio: input.audio, audioTracks: input.audioTracks, inputRoots: input.inputRoots };
      return {
        input: {
          fps: input.pkg.motion.fps, width: input.pkg.motion.width, height: input.pkg.motion.height, durationMs: input.pkg.motion.durationMs, frameFormat: "rgba" as const, outputPath: input.outputPath,
          ...(input.preset ? { preset: input.preset } : {}), ...(gpuAudio.audioPath ? { audioPath: gpuAudio.audioPath } : {}), ...(gpuAudio.audio ? { audio: gpuAudio.audio } : {}), ...(gpuAudio.audioTracks ? { audioTracks: gpuAudio.audioTracks } : {}), ...(audioMaster ? { audioMaster } : {}), ...(gpuAudio.inputRoots ? { inputRoots: gpuAudio.inputRoots } : {}),
          ...(delivery.stagingRoot && delivery.stagingAuthority ? { finalAudioSnapshotStaging: { stagingRoot: delivery.stagingRoot, authority: delivery.stagingAuthority } } : {}),
          ...(input.outputRoots ? { outputRoots: input.outputRoots } : {}), ...(input.quality ? { quality: input.quality } : {}), ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}), ...(policy?.cache ? { cache: policy.cache } : {}), ...(policy?.ffmpegVersion !== undefined ? { ffmpegVersion: policy.ffmpegVersion } : {}), ...(policy?.ffprobeVersion !== undefined ? { ffprobeVersion: policy.ffprobeVersion } : {}), ...(policy?.forceSoftwareEncode !== undefined ? { forceSoftwareEncode: policy.forceSoftwareEncode } : {}), ...(policy?.verifyDeliveredColor !== undefined ? { verifyDeliveredColor: policy.verifyDeliveredColor } : {})
        },
        produce: gpuStreamingProducer(input, (evidence) => observe({ frameLane: "gpu", evidence: { ...evidence, ...(delivery.video ? { videoStaging: gpuVideoStagingEvidence(delivery.video) } : {}) } }), producerFailed, delivery.staticPlan, delivery.resources, delivery.video, lease, delivery.behaviorStaticPlan),
        release: async () => {
          let cleanupFailure: unknown;
          try { await releaseAdmittedGpuFinalDelivery(admitted!.delivery.release, lease); }
          catch (error) { cleanupFailure = error; }
          if (effectModuleRelease) {
            effectModuleRelease.complete = true;
            effectModuleRelease.failed = cleanupFailure !== undefined;
          }
          if (cleanupFailure !== undefined) throw cleanupFailure;
        }
      };
    } catch (error) {
      let cleanupFailure: unknown;
      if (admitted) {
        try { await releaseAdmittedGpuFinalDelivery(admitted.delivery.release, lease); }
        catch (cleanup) { cleanupFailure = cleanup; }
      } else if (lease) {
        try { await releaseAdmittedGpuFinalDelivery(async () => {}, lease); }
        catch (cleanup) { cleanupFailure = cleanup; }
      }
      if (effectModuleRelease) {
        effectModuleRelease.complete = true;
        effectModuleRelease.failed = cleanupFailure !== undefined;
      }
      throw cleanupFailure === undefined ? error : combineGpuFinalRenderAndCleanupFailure(error, cleanupFailure);
    }
  };
}

/**
 * Direct final has no durable prefix: this only proves Core can lower the
 * declared B2 shape before resources open. The subsequent borrowed Browser
 * capture remains the sole actual-source and pixel authority, and this marker
 * is intentionally absent from receipts and input hashes.
 */
/** Internal test seam: no-pixel Core lowering only; Browser capture owns direct final provenance. */
export function directGpuHybridTopologyPreflight(staticPlan: GpuSceneStaticPlan): import("./streaming-final-gpu.js").GpuHybridTopologyPreflight | undefined {
  const descriptor = staticPlan.hybridTextures?.[0];
  if (!descriptor) return undefined;
  const sourceSnapshotSha256 = canonicalJsonSha256({ schema: "shellx-motion/gpu-direct-hybrid-topology-source@1", descriptorFingerprint: descriptor.descriptorFingerprint });
  const captureContractSha256 = canonicalJsonSha256({ schema: "shellx-motion/gpu-direct-hybrid-topology-contract@1", staticPlanFingerprint: staticPlan.fingerprint, descriptorFingerprint: descriptor.descriptorFingerprint, sourceSnapshotSha256 });
  const sourceSnapshot = createGpuHybridTextureSourceSnapshot({ descriptor, sourceSnapshotSha256, sourceByteLength: 1, captureContractSha256 });
  return {
    sourceSnapshot,
    dynamicTexture: {
      id: `direct-hybrid-topology-${descriptor.descriptorFingerprint.slice(0, 24)}`,
      width: descriptor.width,
      height: descriptor.height,
      sourceSha256: captureContractSha256
    }
  };
}

function encodedFailure(encoded: Awaited<ReturnType<typeof runStreamingFinalEncodePolicy>>, transport: StreamingTransport, source?: { code: string; message: string }, gpu?: GpuDeliveryFailure, producer?: StreamingFinalProducerEvidence): RenderStreamingFinalResult {
  if (encoded.ok) throw new Error("Expected a failed streamed encoder result.");
  return { ok: false, transport, error: { code: source?.code ?? gpu?.code ?? encoded.error.code, message: source?.message ?? gpu?.message ?? safeProducerMessage(encoded.error.message), ...(encoded.error.resources ? { resources: encoded.error.resources } : {}), ...(encoded.error.handoff ? { handoff: publicEncoderHandoff(encoded.error.handoff) } : {}), ...(encoded.error.partialOutput ? { partialOutput: encoded.error.partialOutput } : {}), ...(producer ? { producer } : {}) } };
}

function encodedSuccess(input: RenderStreamingFinalInput, encoded: Extract<Awaited<ReturnType<typeof runStreamingFinalEncodePolicy>>, { ok: true }>, transport: StreamingTransport, producer: StreamingFinalProducerEvidence | undefined, effectModuleRelease: GpuEffectModuleReleaseState | undefined): RenderStreamingFinalResult {
  if (!producer) return missingProducerEvidence(encoded, transport);
  const scriptExecution = producer.frameLane === "browser" ? producer.evidence.scriptExecution : undefined;
  if (producer.frameLane === "browser" && !scriptExecution) return { ok: false, transport, error: { code: "producer_script_evidence_missing", message: "Browser streamed final rendering completed without session-owned script evidence.", producer } };
  const gpuHashes = gpuFinalReceiptInputHashes(producer);
  if (input.frameLane === "gpu" && !gpuHashes) return { ok: false, transport, error: { code: "gpu_provenance_missing", message: "GPU final rendering completed without complete scene, pipeline, resource-budget, adapter, and canonical-frame provenance.", producer } };
  if (effectModuleRelease && (!effectModuleRelease.complete || effectModuleRelease.failed)) {
    return { ok: false, transport, error: { code: "gpu_effect_module_release_failed", message: "GPU final rendering completed pixels but did not complete its governed effect-module lease release.", producer } };
  }
  const releasedEffectModules = effectModuleRelease
    ? releasedGpuEffectModuleReceipt(effectModuleRelease, producer)
    : undefined;
  if (effectModuleRelease && !releasedEffectModules) {
    return { ok: false, transport, error: { code: "gpu_effect_module_release_evidence_missing", message: "GPU final rendering completed pixels but did not retain complete released effect-module evidence.", producer } };
  }
  const effectModuleHashes = gpuFinalEffectModuleReceiptInputHashes(producer, releasedEffectModules);
  if (effectModuleHashes === undefined) {
    return { ok: false, transport, error: { code: "gpu_effect_module_provenance_missing", message: "GPU final rendering completed without exact governed effect-module provenance.", producer } };
  }
  const frameTransport: StreamingFinalFrameTransportEvidence = {
    delivery: "streamed", frameLane: input.frameLane,
    frameCount: Math.ceil((input.pkg.motion.durationMs / 1_000) * input.pkg.motion.fps), retainedFrameCount: 0,
    producer,
    ...(releasedEffectModules ? { effectModules: releasedEffectModules } : {}),
    encoderHandoff: publicEncoderHandoff(encoded.handoff)
  };
  const receipt = createRenderReceipt({ id: `streaming-final-${encoded.receiptEvidence.output.sha256.slice(0, 16)}`, packageId: input.pkg.manifest.id, lane: "ffmpeg", status: "passed", inputHashes: { ...encoded.receiptEvidence.inputHashes, ...(gpuHashes ?? {}), ...effectModuleHashes }, output: { ...encoded.receiptEvidence.output, ...(scriptExecution ? { scriptExecution } : {}), frameTransport }, warnings: mergedProducerWarnings(encoded.receiptEvidence.warnings, producer) });
  receipt.createdAt = input.now?.() ?? receipt.createdAt;
  receipt.artifacts = encoded.receiptEvidence.artifacts.map((artifact) => ({ ...artifact }));
  return { ok: true, command: encoded.command, receipt, transport: frameTransport };
}

function releasedGpuEffectModuleReceipt(effectModuleRelease: GpuEffectModuleReleaseState, producer: StreamingFinalProducerEvidence) {
  if (!effectModuleRelease.lease || producer.frameLane !== "gpu" || !producer.evidence.effectModules) return undefined;
  try {
    return gpuEffectModuleFinalReceiptEvidence(effectModuleRelease.lease, producer.evidence.effectModules.ledger);
  } catch {
    return undefined;
  }
}

function missingProducerEvidence(encoded: Extract<Awaited<ReturnType<typeof runStreamingFinalEncodePolicy>>, { ok: true }>, transport: StreamingTransport): RenderStreamingFinalResult {
  return { ok: false, transport, error: { code: "producer_evidence_missing", message: "Streamed final rendering completed without producer evidence.", partialOutput: { path: encoded.receiptEvidence.output.path, status: "available", sha256: encoded.receiptEvidence.output.sha256, observedMedia: encoded.receiptEvidence.output.observedMedia, tools: encoded.receiptEvidence.output.tools } } };
}
