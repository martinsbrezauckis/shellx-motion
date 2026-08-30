import { acquireDerivedOutputPublication, colorPipelinePreallocationRefusal, motionBehaviorLaneRefusal, motionLayoutGapAnimationLaneRefusal, motionRelationLaneRefusal, motionScene3DAnimationLaneRefusal } from "@shellx-motion/core";
import { hasScene3dGltfPbrHdr10FinalLocator } from "@shellx-motion/core/internal/scene3d-gltf-pbr-hdr10-final";
import { planStreamingFinalCommand, resolveStreamingFinalTransport } from "./streaming-final-command-plan.js";
import { preflightGpuFinalDelivery } from "./streaming-final-adapter-execution.js";
import { redactAbortedStreamingOutput, remapStreamingReceiptOutput, streamingPublicationFailure } from "./streaming-final-publication.js";
import { preliminaryGpuAudio } from "./streaming-final-gpu-audio.js";
import { renderStreamingFinalUnpublished } from "./streaming-final-adapter-execution.js";
import type { RenderStreamingFinalInput, RenderStreamingFinalResult } from "./streaming-final-adapter-types.js";
import { planLinearSrgbSdrFinalRender, preflightLinearSrgbSdrFinalRender, renderLinearSrgbSdrFinalUnpublished } from "./linear-srgb-sdr-final-public.js";
import { claimLinearSrgbSdrFinalPreparation } from "./linear-srgb-sdr-final-adapter.js";

/** Public streamed-final adapter: validates public shape, reserves output publication, then executes one staged render. */
export async function renderStreamingFinal(input: RenderStreamingFinalInput): Promise<RenderStreamingFinalResult> {
  const strict = await preflightLinearSrgbSdrFinalRender(input);
  if (strict.kind === "refused") {
    const transport = resolveStreamingFinalTransport({ transport: input.transport, keepFrames: input.keepFrames, capturedBrowserWorkflow: Boolean(input.toolPolicy?.browser?.workflow), qualityManifest: input.qualityManifest, quality: input.quality, injectedFrameRenderer: input.toolPolicy?.injectedFrameRenderer === true });
    return { ok: false, transport: transport.ok ? transport.plan : transport.transport, error: strict.error };
  }
  if (strict.kind === "strict") return await renderStrict(input, strict.preparation);
  const colorPipelineRefusal = colorPipelinePreallocationRefusal(input.pkg.motion, `ffmpeg-${input.frameLane}`);
  if (colorPipelineRefusal) {
    const transport = resolveStreamingFinalTransport({ transport: input.transport, keepFrames: input.keepFrames, capturedBrowserWorkflow: Boolean(input.toolPolicy?.browser?.workflow), qualityManifest: input.qualityManifest, quality: input.quality, injectedFrameRenderer: input.toolPolicy?.injectedFrameRenderer === true });
    return { ok: false, transport: transport.ok ? transport.plan : transport.transport, error: colorPipelineRefusal };
  }
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(input.pkg.motion, input.frameLane === "browser" ? "ffmpeg-browser" : input.frameLane === "native" ? "ffmpeg-native" : "ffmpeg-gpu");
  if (layoutGapAnimationRefusal) {
    const transport = resolveStreamingFinalTransport({ transport: input.transport, keepFrames: input.keepFrames, capturedBrowserWorkflow: Boolean(input.toolPolicy?.browser?.workflow), qualityManifest: input.qualityManifest, quality: input.quality, injectedFrameRenderer: input.toolPolicy?.injectedFrameRenderer === true });
    return { ok: false, transport: transport.ok ? transport.plan : transport.transport, error: { code: layoutGapAnimationRefusal.code, message: layoutGapAnimationRefusal.message } };
  }
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(input.pkg.motion, input.frameLane === "browser" ? "ffmpeg-browser" : input.frameLane === "native" ? "ffmpeg-native" : "ffmpeg-gpu");
  if (scene3dAnimationRefusal) {
    const transport = resolveStreamingFinalTransport({ transport: input.transport, keepFrames: input.keepFrames, capturedBrowserWorkflow: Boolean(input.toolPolicy?.browser?.workflow), qualityManifest: input.qualityManifest, quality: input.quality, injectedFrameRenderer: input.toolPolicy?.injectedFrameRenderer === true });
    return { ok: false, transport: transport.ok ? transport.plan : transport.transport, error: { code: scene3dAnimationRefusal.code, message: scene3dAnimationRefusal.message } };
  }
  const preliminaryAudio = input.frameLane === "gpu" ? preliminaryGpuAudio(input) : input;
  const planned = planStreamingFinalCommand({
    fps: input.pkg.motion.fps, width: input.pkg.motion.width, height: input.pkg.motion.height, durationMs: input.pkg.motion.durationMs,
    outputPath: input.outputPath, preset: input.preset, ...(input.frameLane === "gpu" ? { frameFormat: "rgba" as const } : {}),
    ...(preliminaryAudio.audioPath ? { audioPath: preliminaryAudio.audioPath } : {}), ...(preliminaryAudio.audio ? { audio: preliminaryAudio.audio } : {}), ...(preliminaryAudio.audioTracks ? { audioTracks: preliminaryAudio.audioTracks } : {}), ...(preliminaryAudio.audioMaster ? { audioMaster: preliminaryAudio.audioMaster } : {}),
    ...(input.inputRoots ? { inputRoots: input.inputRoots } : {}), ...(input.outputRoots ? { outputRoots: input.outputRoots } : {}),
    ...(input.quality ? { quality: input.quality } : {}), ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}), ...(input.transport ? { transport: input.transport } : {}), ...(input.keepFrames !== undefined ? { keepFrames: input.keepFrames } : {}),
    capturedBrowserWorkflow: Boolean(input.toolPolicy?.browser?.workflow), injectedFrameRenderer: input.toolPolicy?.injectedFrameRenderer === true
  });
  if (!planned.ok) return planned;
  if (hasScene3dGltfPbrHdr10FinalLocator(input.pkg.manifest.data)) {
    return { ok: false, transport: planned.transport, error: { code: "gltf_pbr_hdr10_private_direct_final_only", message: "The HDR10 glTF PBR marker refuses every generic final route before output publication; only its private authenticated software direct-final lane is eligible." } };
  }
  const relationRefusal = motionRelationLaneRefusal(input.pkg.motion, input.frameLane === "browser"
    ? "ffmpeg-browser"
    : input.frameLane === "native"
      ? "ffmpeg-native"
      : "ffmpeg-gpu");
  if (relationRefusal) return { ok: false, transport: planned.transport, error: { code: relationRefusal.code, message: relationRefusal.message } };
  const behaviorRefusal = input.frameLane === "browser"
    ? motionBehaviorLaneRefusal(input.pkg.motion, "ffmpeg-browser")
    : input.frameLane === "native"
      ? motionBehaviorLaneRefusal(input.pkg.motion, "ffmpeg-native")
      : undefined;
  if (behaviorRefusal) return { ok: false, transport: planned.transport, error: { code: behaviorRefusal.code, message: behaviorRefusal.message } };
  if (input.frameLane === "gpu") {
    const gpuPreflight = await preflightGpuFinalDelivery(input);
    if (!gpuPreflight.ok) return { ok: false, transport: planned.transport, error: gpuPreflight.failure };
  }
  try {
    const publication = input.outputPublication ?? await acquireDerivedOutputPublication({ outputPath: input.outputPath, kind: "file", force: input.force === true });
    let published = false;
    let handedToPair = false;
    try {
      const staged = await renderStreamingFinalUnpublished({ ...input, outputPath: publication.stagingPath, outputRoots: [publication.rootPath] });
      if (!staged.ok) return redactAbortedStreamingOutput(staged);
      if (input.outputPublication) {
        handedToPair = true;
        return staged;
      }
      await publication.publishFile(await publication.verifyFile());
      published = true;
      return {
        ...staged,
        command: { ...staged.command, args: staged.command.args.map((arg) => arg === publication.stagingPath ? input.outputPath : arg) },
        receipt: remapStreamingReceiptOutput(staged.receipt, publication.stagingPath, input.outputPath)
      };
    } finally {
      if (!published && !handedToPair) await publication.abort();
    }
  } catch (error) {
    return { ok: false, transport: planned.transport, error: streamingPublicationFailure(error) };
  }
}

async function renderStrict(input: RenderStreamingFinalInput, preparation: import("./linear-srgb-sdr-final-adapter.js").LinearSrgbSdrFinalPreparation): Promise<RenderStreamingFinalResult> {
  const transport = { delivery: "streamed" as const, reason: "stream_default" as const };
  try {
    claimLinearSrgbSdrFinalPreparation(input.pkg.motion, preparation);
  } catch (error) {
    return { ok: false, transport, error: { code: "linear_srgb_sdr_final_unsupported", message: error instanceof Error ? error.message : "Strict linear-sRGB SDR preparation could not be claimed." } };
  }
  const currentPlan = planLinearSrgbSdrFinalRender(input);
  if (currentPlan.kind !== "strict") {
    return { ok: false, transport, error: currentPlan.kind === "refused" ? currentPlan.error : { code: "linear_srgb_sdr_final_unsupported", message: "Strict linear-sRGB SDR input changed before output reservation." } };
  }
  try {
    const publication = input.outputPublication ?? await acquireDerivedOutputPublication({ outputPath: input.outputPath, kind: "file", force: input.force === true });
    let published = false;
    let handedToPair = false;
    try {
      const staged = await renderLinearSrgbSdrFinalUnpublished({ ...input, transport, outputPublication: publication, linearSrgbSdrFinalPreparation: preparation });
      if (!staged.ok) return redactAbortedStreamingOutput(staged);
      if (input.outputPublication) {
        handedToPair = true;
        return staged;
      }
      await publication.publishFile(await publication.verifyFile());
      published = true;
      return {
        ...staged,
        receipt: remapStreamingReceiptOutput(staged.receipt, publication.stagingPath, input.outputPath),
      };
    } finally {
      if (!published && !handedToPair) await publication.abort();
    }
  } catch (error) {
    return { ok: false, transport, error: streamingPublicationFailure(error) };
  }
}
