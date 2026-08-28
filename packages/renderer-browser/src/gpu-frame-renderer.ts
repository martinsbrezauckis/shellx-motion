import type { MotionBrowserExecutableLocation } from "@shellx-motion/core";
import { admitInternalGpuFramePlan } from "./gpu-frame-plan-admission"; import { installWebGpuPageSessionAdjustmentPipeline } from "./gpu-page-adjustment";
import { installWebGpuPageSessionBlendPipeline } from "./gpu-page-blend"; import { installWebGpuPageSessionBlurPipeline } from "./gpu-page-blur";
import { GPU_ADAPTER_REQUEST_OPTIONS, openGpuRuntime, type GpuBrowserProcess, type GpuFinalBrowserLaunchContext } from "./gpu-browser-runtime";
import type { GpuBrowserSessionIdentity } from "./gpu-browser-session-identity";
import type { Browser } from "playwright-core";
import { closeWebGpuPageSession, openWebGpuPageSession, renderWebGpuPageSessionFrame, uploadWebGpuPageSessionImages } from "./gpu-page-session";
import { replaceWebGpuPageSessionDynamicImages, reserveWebGpuPageSessionDynamicImages } from "./gpu-page-session-dynamic-images"; import { installWebGpuPageSessionResources, readWebGpuPageSessionResourceMetrics, type GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import { installWebGpuPageSessionInstanceBuffers } from "./gpu-page-instance-buffers"; import { installWebGpuPageSessionParticleCompute } from "./gpu-page-particle-compute";
import { installWebGpuPageSessionParticleComputeV2 } from "./gpu-page-particle-compute-v2";
import { prepareWebGpuPageSessionTextSurfaces, uploadWebGpuPageSessionFonts } from "./gpu-page-text-session";
import { installWebGpuPageSessionGradientPipeline } from "./gpu-page-gradient"; import { installWebGpuPageSessionGlowPipeline } from "./gpu-page-glow";
import { installWebGpuPageSessionMaskPipeline } from "./gpu-page-mask"; import { installWebGpuPageSessionStyledRectanglePipeline } from "./gpu-page-styled-rectangle";
import { installWebGpuPageSessionScene3dPipeline } from "./gpu-page-scene3d"; import { installWebGpuPageSessionEnvironmentPipeline } from "./gpu-page-environment";
import { installWebGpuPageSessionMaterialPipeline } from "./gpu-page-material"; import { installWebGpuPageSessionChromaKeyPipeline } from "./gpu-page-chroma-key";
import { installWebGpuPageSessionChromaMatteCleanupPipeline } from "./gpu-page-chroma-matte-cleanup";
import { closeGpuAfterimageStack, finalizeGpuAfterimageTerminalMetrics, mergeGpuAfterimageResourceMetrics, prepareGpuAfterimageFrame, renderGpuFrameWithAfterimage, type GpuAfterimagePageEvaluator } from "./gpu-frame-renderer-afterimage";
import { verifyGpuEffectModuleBeginUseLease, type GpuEffectModuleBeginUseLease } from "./gpu-effect-module-use-authority";
import { finalizeGpuFrameReadback } from "./gpu-frame-readback-output";
import { gpuCancellationFailure, type GpuRenderedFrame, type GpuRuntimeEvidence, type GpuRuntimeFailure, type GpuSessionDynamicImageReservation, type GpuSessionFontResource, type GpuSessionImageIdentity, type GpuSessionImageResource, type GpuSessionRgbaImageResource } from "./gpu-runtime-types";
import { createGpuPageFrameTransport, installGpuPageFrameTransport } from "./gpu-page-frame-transport"; import { GPU_PAGE_SERIALIZATION_RUNTIME } from "./gpu-page-serialization-runtime";
import { createGpuPageFrameReservation, reserveWebGpuPageSessionEnvironmentEnvelope, reserveWebGpuPageSessionFrameResources } from "./gpu-page-frame-reservation";
import { admitCombinedSessionImages, admitSessionDynamicImages, admitSessionFonts, admitSessionImages, GpuFrameAbortError, GpuFrameTimeoutError, raceGpuFrameOperation } from "./gpu-frame-renderer-operation";
import { deriveGpuEnvironmentFrameEnvelope, type GpuEnvironmentSessionEnvelope } from "./gpu-page-environment-envelope";
import { attachGpuCheckpointStoryboardRetainedTraceSession, createCheckpointStoryboardRetainedTraceRenderSessionFactory } from "./gpu-checkpoint-storyboard-retained-trace-session";
export { raceGpuFrameOperation } from "./gpu-frame-renderer-operation";
/** Bounded first-frame allowance for driver and fixed-pipeline compilation. */
export const DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS = 30_000;
export const MAX_GPU_FRAME_OPERATION_TIMEOUT_MS = 60_000;
export type InternalGpuFrameResult =
  | { ok: true; frame: GpuRenderedFrame }
  | { ok: false; failure: GpuRuntimeFailure };

export interface GpuFrameRenderSession {
  /** Exact Playwright BrowserServer root, registered before any final frame is emitted. */
  readonly browserProcess: GpuBrowserProcess;
  /** Version and immutable identity observed from this exact Chromium session. */
  readonly browserVersion?: string; readonly browserIdentity?: GpuBrowserSessionIdentity;
  /** Immutable runtime attestation from the exact browser process that owns this session. */
  readonly runtimeEvidence?: GpuRuntimeEvidence;
  /** Page-produced immutable static-image identities; no page object or texture escapes the session. */
  readonly immutableImageResources?: readonly GpuSessionImageIdentity[];
  /**
   * Internal-only borrowed browser capability for a governed hybrid surface.
   * It refers to this session's exact Chromium root and never transfers
   * lifecycle ownership to the surface producer.
   */
  borrowGpuBrowser?(): Browser;
  /** Replace bounded dynamic media textures before the next admitted frame. */
  uploadImages(images: readonly GpuSessionImageResource[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: true; uploaded: number } | { ok: false; failure: GpuRuntimeFailure }>;
  /** Replaces an already-reserved preview texture in-place; texture identity and dimensions never change. */
  replaceDynamicImages?(images: readonly GpuSessionRgbaImageResource[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: true; replaced: number } | { ok: false; failure: GpuRuntimeFailure }>;
  /** Snapshot of bounded page allocations; terminal evidence owns no live GPU handle. */
  resourceMetrics?(): Promise<GpuPageSessionResourceMetrics | null>;
  /** Render any number of independently admitted frames through one browser session. */
  render(plan: unknown, options?: { timeoutMs?: number; signal?: AbortSignal; effectModuleLease?: GpuEffectModuleBeginUseLease }): Promise<InternalGpuFrameResult>;
  close(): Promise<void>;
}

export type GpuFrameRenderSessionOpenResult =
  | { ok: true; session: GpuFrameRenderSession }
  | { ok: false; failure: GpuRuntimeFailure };

/** Strict final delivery supplies this only after its outer governor has admitted scratch and memory. */
export interface GpuFrameRenderSessionOptions {
  readonly finalBrowser?: GpuFinalBrowserLaunchContext;
  /** Internal host-only binding for evidence-producing sessions. */
  readonly browserLocation?: MotionBrowserExecutableLocation;
  /** Static-plan knowledge may reserve environment attachments before frame zero. */
  readonly environmentEnvelope?: GpuEnvironmentSessionEnvelope;
  /** Exact preview-only texture slots, admitted before Chromium opens. */
  readonly dynamicImages?: readonly GpuSessionDynamicImageReservation[];
}

export const createCheckpointStoryboardRetainedTraceRenderSession = createCheckpointStoryboardRetainedTraceRenderSessionFactory(createGpuFrameRenderSession);

/**
 * One-shot WebGPU execution primitive used by the strict points preview route.
 * There is no browser/CPU fallback: a missing or software adapter is a typed refusal.
 */
export async function renderInternalGpuFrame(plan: unknown, timeoutMs: number = DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS): Promise<InternalGpuFrameResult> {
  // Admission is deliberately before opening Chromium: malformed or over-budget input must not
  // consume a browser/GPU process merely to learn that it is refused.
  const admittedPlan = admitInternalGpuFramePlan(plan);
  if (!admittedPlan) {
    return { ok: false, failure: { code: "gpu_limits_exceeded", message: "The GPU frame plan is outside the fixed internal execution budget." } };
  }
  if (admittedPlan.draws.some((draw) => draw.kind === "effectModule")) {
    return { ok: false, failure: { code: "gpu_resource_refused", message: "GPU effect-module frames require a current opaque begin-use lease." } };
  }
  const environmentEnvelope = deriveGpuEnvironmentFrameEnvelope(admittedPlan);
  const opened = await createGpuFrameRenderSession([], [], environmentEnvelope ? { environmentEnvelope } : {});
  if (!opened.ok) return opened;
  try {
    return await opened.session.render(admittedPlan, { timeoutMs });
  } finally {
    await opened.session.close();
  }
}

/**
 * Open one trusted browser/GPU session for a bounded sequence of scene frames.
 * A cancelled frame tears the session down; callers must open a new one instead
 * of accidentally continuing with a possibly lost device.
 */
export async function createGpuFrameRenderSession(
  images: readonly GpuSessionImageResource[] = [],
  fonts: readonly GpuSessionFontResource[] = [],
  options: GpuFrameRenderSessionOptions = {}
): Promise<GpuFrameRenderSessionOpenResult> {
  const admittedImages = admitSessionImages(images);
  if (!admittedImages.ok) return admittedImages;
  const admittedDynamicImages = admitSessionDynamicImages(options.dynamicImages ?? []);
  if (!admittedDynamicImages.ok) return admittedDynamicImages;
  const combinedImages = admitCombinedSessionImages(images, admittedDynamicImages.images);
  if (!combinedImages.ok) return combinedImages;
  const admittedFonts = admitSessionFonts(fonts);
  if (!admittedFonts.ok) return admittedFonts;
  if (options.environmentEnvelope && (!Number.isInteger(options.environmentEnvelope.width) || !Number.isInteger(options.environmentEnvelope.height) || !Number.isInteger(options.environmentEnvelope.groupDepth) || options.environmentEnvelope.width < 1 || options.environmentEnvelope.height < 1 || options.environmentEnvelope.groupDepth < 0 || options.environmentEnvelope.groupDepth > 5 || typeof options.environmentEnvelope.keyCleanup !== "boolean" || typeof options.environmentEnvelope.needsDepth !== "boolean")) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU environment envelope is outside fixed dimensions." } };
  const opened = await openGpuRuntime({
    ...(options.finalBrowser ? { finalBrowser: options.finalBrowser } : {}),
    ...(options.browserLocation ? { browserLocation: options.browserLocation } : {})
  });
  if (!opened.ok) return opened;
  const serializationRuntime = await opened.session.page.evaluate(GPU_PAGE_SERIALIZATION_RUNTIME).catch(() => false);
  if (serializationRuntime !== true) {
    await opened.session.close();
    return { ok: false, failure: { code: "gpu_render_failed", message: "The persistent GPU page session could not install its fixed serialization runtime." } };
  }
  const frameTransport=await opened.session.page.evaluate(installGpuPageFrameTransport).catch(()=>({ok:false as const,failure:{code:"gpu_render_failed" as const,message:"The persistent GPU page session could not install its frame transport."}}));if(!frameTransport.ok){await opened.session.close();return frameTransport;}
  const initialized = await opened.session.page.evaluate(openWebGpuPageSession, GPU_ADAPTER_REQUEST_OPTIONS).catch(() => ({
    ok: false as const,
    failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not initialize." }
  }));
  if (!initialized.ok) {
    await opened.session.close();
    return initialized;
  }
  const resourcePools = await opened.session.page.evaluate(installWebGpuPageSessionResources).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install bounded resource pools." } }));
  if (!resourcePools.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return resourcePools; }
  const instanceBuffers = await opened.session.page.evaluate(installWebGpuPageSessionInstanceBuffers).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install bounded instance buffers." } }));
  if (!instanceBuffers.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return instanceBuffers; }
  const particleCompute = await opened.session.page.evaluate(installWebGpuPageSessionParticleCompute).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install fixed particle compute." } }));
  if (!particleCompute.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return particleCompute; }
  const gradientPipeline = await opened.session.page.evaluate(installWebGpuPageSessionGradientPipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its gradient pipeline." } }));
  if (!gradientPipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return gradientPipeline; }
  const styledRectanglePipeline = await opened.session.page.evaluate(installWebGpuPageSessionStyledRectanglePipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its styled rectangle pipeline." } }));
  if (!styledRectanglePipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return styledRectanglePipeline; }
  const blendPipeline = await opened.session.page.evaluate(installWebGpuPageSessionBlendPipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its blend pipeline." } }));
  if (!blendPipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return blendPipeline; }
  const blurPipeline = await opened.session.page.evaluate(installWebGpuPageSessionBlurPipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its blur pipeline." } }));
  if (!blurPipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return blurPipeline; }
  const glowPipeline = await opened.session.page.evaluate(installWebGpuPageSessionGlowPipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its glow pipeline." } }));
  if (!glowPipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return glowPipeline; }
  const maskPipeline = await opened.session.page.evaluate(installWebGpuPageSessionMaskPipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its mask pipeline." } }));
  if (!maskPipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return maskPipeline; }
  const adjustmentPipeline = await opened.session.page.evaluate(installWebGpuPageSessionAdjustmentPipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its adjustment pipeline." } }));
  if (!adjustmentPipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return adjustmentPipeline; }
  const scene3dPipeline = await opened.session.page.evaluate(installWebGpuPageSessionScene3dPipeline).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install its scene3d pipeline." } }));
  if (!scene3dPipeline.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return scene3dPipeline; }
  const environmentPipeline=await opened.session.page.evaluate(installWebGpuPageSessionEnvironmentPipeline).catch(()=>({ok:false as const,failure:{code:"gpu_render_failed" as const,message:"The persistent GPU page session could not install its environment pipeline."}}));
  if(!environmentPipeline.ok){await opened.session.page.evaluate(closeWebGpuPageSession).catch(()=>undefined);await opened.session.close();return environmentPipeline;}
  if (options.environmentEnvelope) {
    const envelope = await opened.session.page.evaluate(reserveWebGpuPageSessionEnvironmentEnvelope, options.environmentEnvelope).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not reserve its environment envelope." } }));
    if (!envelope.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return envelope; }
  }
  const materialPipeline=await opened.session.page.evaluate(installWebGpuPageSessionMaterialPipeline).catch(()=>({ok:false as const,failure:{code:"gpu_render_failed" as const,message:"The persistent GPU page session could not install its material pipeline."}}));
  if(!materialPipeline.ok){await opened.session.page.evaluate(closeWebGpuPageSession).catch(()=>undefined);await opened.session.close();return materialPipeline;}
  const chromaKeyPipeline=await opened.session.page.evaluate(installWebGpuPageSessionChromaKeyPipeline).catch(()=>({ok:false as const,failure:{code:"gpu_render_failed" as const,message:"The persistent GPU page session could not install its chroma-key pipeline."}}));
  if(!chromaKeyPipeline.ok){await opened.session.page.evaluate(closeWebGpuPageSession).catch(()=>undefined);await opened.session.close();return chromaKeyPipeline;}
  const chromaMatteCleanupPipeline=await opened.session.page.evaluate(installWebGpuPageSessionChromaMatteCleanupPipeline).catch(()=>({ok:false as const,failure:{code:"gpu_render_failed" as const,message:"The persistent GPU page session could not install its chroma matte-cleanup pipelines."}}));
  if(!chromaMatteCleanupPipeline.ok){await opened.session.page.evaluate(closeWebGpuPageSession).catch(()=>undefined);await opened.session.close();return chromaMatteCleanupPipeline;}
  let immutableImageResources: readonly GpuSessionImageIdentity[] = [];
  if (admittedImages.images.length > 0) {
    const uploaded = await opened.session.page.evaluate(uploadWebGpuPageSessionImages, admittedImages.images).catch(() => ({
      ok: false as const,
      failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not upload image resources." }
    }));
    if (!uploaded.ok) {
      await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined);
      await opened.session.close();
      return uploaded;
    }
    immutableImageResources = Object.freeze(uploaded.decoded.map((image) => Object.freeze({ ...image })));
  }
  if (admittedDynamicImages.images.length > 0) {
    const reserved = await opened.session.page.evaluate(reserveWebGpuPageSessionDynamicImages, admittedDynamicImages.images).catch(() => ({
      ok: false as const,
      failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not reserve dynamic image textures." }
    }));
    if (!reserved.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return reserved; }
  }
  if (admittedFonts.fonts.length > 0) {
    const uploaded = await raceGpuFrameOperation(opened.session.page.evaluate(uploadWebGpuPageSessionFonts, admittedFonts.fonts), DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not register font resources." } }));
    if (!uploaded.ok) { await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined); await opened.session.close(); return uploaded; }
  }
  const assessment = await opened.session.assessRender(initialized.runtime);
  if (!assessment.ok) {
    await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => undefined);
    await opened.session.close();
    return assessment;
  }
  let closed = false;
  let operating = false;
  let terminalResourceMetrics: GpuPageSessionResourceMetrics | null = null;
  let particleComputeV2Installed = false;
  let afterimageStackInstalled = false;
  const pageAfterimage = opened.session.page as unknown as GpuAfterimagePageEvaluator;
  const resourceMetrics = async (): Promise<GpuPageSessionResourceMetrics | null> => await mergeGpuAfterimageResourceMetrics(pageAfterimage, await opened.session.page.evaluate(readWebGpuPageSessionResourceMetrics).catch(() => null), afterimageStackInstalled).catch(() => null);
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const beforeClose = await resourceMetrics();
    const afterimageCleanup = await closeGpuAfterimageStack(pageAfterimage, afterimageStackInstalled).catch(() => null);
    const rawCleanup = await opened.session.page.evaluate(closeWebGpuPageSession).catch(() => null);
    const cleanup = rawCleanup && typeof rawCleanup === "object" && Number.isSafeInteger((rawCleanup as { dynamicImageTextureDestructions?: unknown }).dynamicImageTextureDestructions) && (rawCleanup as { dynamicImageTextureDestructions: number }).dynamicImageTextureDestructions >= 0 ? (rawCleanup as { dynamicImageTextureDestructions: number }) : { dynamicImageTextureDestructions: 0 };
    try { terminalResourceMetrics = finalizeGpuAfterimageTerminalMetrics(beforeClose, cleanup.dynamicImageTextureDestructions, admittedDynamicImages.images.length > 0, afterimageCleanup); }
    finally { await opened.session.close(); }
  };
  const session = attachGpuCheckpointStoryboardRetainedTraceSession({ session: {
      browserProcess: opened.session.browserProcess,
      browserVersion: opened.session.browserVersion,
      browserIdentity: opened.session.browserIdentity,
      runtimeEvidence: assessment.evidence,
      immutableImageResources,
      borrowGpuBrowser: () => opened.session.borrowGpuBrowser(),
      close,
      async resourceMetrics() {
        if (closed) return terminalResourceMetrics;
        return await resourceMetrics();
      },
      async uploadImages(images, options = {}) {
        const admitted = admitSessionImages(images); if (!admitted.ok) return admitted;
        if (closed) return { ok: false, failure: gpuCancellationFailure("The GPU frame session is closed.") };
        if (options.signal?.aborted) { await close(); return { ok: false, failure: gpuCancellationFailure("GPU image upload was cancelled before execution.") }; }
        if (operating) return { ok: false, failure: { code: "gpu_render_failed", message: "GPU frame session accepts exactly one ordered frame operation at a time." } };
        operating = true;
        try {
          const uploaded = await raceGpuFrameOperation(opened.session.page.evaluate(uploadWebGpuPageSessionImages, admitted.images.map((image) => ({ ...image, replace: true as const }))), options.timeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, options.signal);
          if (!uploaded.ok && uploaded.failure.code === "gpu_device_lost") await close();
          return uploaded;
        } catch (error) {
          if (error instanceof GpuFrameTimeoutError || error instanceof GpuFrameAbortError) await close();
          return { ok: false, failure: { code: error instanceof GpuFrameTimeoutError ? "gpu_render_timeout" : error instanceof GpuFrameAbortError ? "gpu_cancelled" : "gpu_render_failed", message: error instanceof GpuFrameTimeoutError ? error.message : error instanceof GpuFrameAbortError ? error.message : "The persistent GPU page session could not replace dynamic media resources." } };
        } finally {
          operating = false;
        }
      },
      async replaceDynamicImages(images, options = {}) {
        const admitted = admitSessionImages(images); if (!admitted.ok) return admitted;
        if (admitted.images.some((image) => !("rgbaBase64" in image))) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU dynamic image replacement accepts only exact RGBA pixels." } };
        if (closed) return { ok: false, failure: gpuCancellationFailure("The GPU frame session is closed.") };
        if (options.signal?.aborted) { await close(); return { ok: false, failure: gpuCancellationFailure("GPU dynamic image replacement was cancelled before execution.") }; }
        if (operating) return { ok: false, failure: { code: "gpu_render_failed", message: "GPU frame session accepts exactly one ordered frame operation at a time." } };
        operating = true;
        try {
          const replaced = await raceGpuFrameOperation(opened.session.page.evaluate(replaceWebGpuPageSessionDynamicImages, admitted.images), options.timeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, options.signal);
          if (!replaced.ok) await close();
          return replaced.ok ? { ok: true, replaced: replaced.replaced } : replaced;
        } catch (error) {
          if (error instanceof GpuFrameTimeoutError || error instanceof GpuFrameAbortError) await close();
          return { ok: false, failure: { code: error instanceof GpuFrameTimeoutError ? "gpu_render_timeout" : error instanceof GpuFrameAbortError ? "gpu_cancelled" : "gpu_render_failed", message: error instanceof GpuFrameTimeoutError ? error.message : error instanceof GpuFrameAbortError ? error.message : "The persistent GPU page session could not replace reserved dynamic textures." } };
        } finally {
          operating = false;
        }
      },
      async render(plan, options = {}) {
        const timeoutMs = options.timeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_GPU_FRAME_OPERATION_TIMEOUT_MS) {
          return { ok: false, failure: { code: "gpu_render_timeout", message: `GPU frame timeout must be an integer in 1..${MAX_GPU_FRAME_OPERATION_TIMEOUT_MS}ms.` } };
        }
        const admittedPlan = admitInternalGpuFramePlan(plan);
        if (!admittedPlan) {
          return { ok: false, failure: { code: "gpu_limits_exceeded", message: "The GPU frame plan is outside the fixed internal execution budget." } };
        }
        const afterimageDraw = admittedPlan.draws.find((draw) => draw.kind === "effectModule");
        if (afterimageDraw) {
          const leaseProblem = verifyGpuEffectModuleBeginUseLease(options.effectModuleLease, afterimageDraw);
          if (leaseProblem) return { ok: false, failure: { code: "gpu_resource_refused", message: leaseProblem } };
        }
        if (operating) return { ok: false, failure: { code: "gpu_render_failed", message: "GPU frame session accepts exactly one ordered frame operation at a time." } };
        if (closed) return { ok: false, failure: gpuCancellationFailure("The GPU frame session is closed.") };
        if (options.signal?.aborted) {
          await close();
          return { ok: false, failure: gpuCancellationFailure("GPU frame rendering was cancelled before execution.") };
        }
        operating = true;
        const needsParticleComputeV2 = admittedPlan.draws.some((draw) => draw.kind === "particleCompute" && (draw as unknown as { schema?: unknown }).schema === "shellx-motion/gpu-compute-particle-field@2");
        if (needsParticleComputeV2 && !particleComputeV2Installed) {
          const particleV2 = await opened.session.page.evaluate(installWebGpuPageSessionParticleComputeV2).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The persistent GPU page session could not install fixed v2 particle compute." } }));
          if (!particleV2.ok) { operating = false; return particleV2; }
          particleComputeV2Installed = true;
        }
        const frameStartedAtNs = process.hrtime.bigint();
        const abort = () => { void close(); };
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          const output = await raceGpuFrameOperation(
            (async () => {
              const reserved = await opened.session.page.evaluate(reserveWebGpuPageSessionFrameResources, createGpuPageFrameReservation(admittedPlan));
              if (!reserved.ok) return { ...reserved, reservationFailed: true as const };
              if (afterimageDraw) {
                const prepared = await prepareGpuAfterimageFrame(pageAfterimage, admittedPlan, afterimageDraw, afterimageStackInstalled);
                afterimageStackInstalled ||= prepared.installed;
                if (!prepared.ok) return { ...prepared, reservationFailed: true as const };
              }
              const textPrepared = admittedPlan.budget.textCount === 0 ? { ok: true as const, count: 0, textFit: [] as const } : await opened.session.page.evaluate(prepareWebGpuPageSessionTextSurfaces, admittedPlan);
              if (!textPrepared.ok) return textPrepared;
              const rendered = await renderGpuFrameWithAfterimage(pageAfterimage, admittedPlan, afterimageDraw !== undefined);
              return rendered.ok ? { ...rendered, textFit: textPrepared.textFit } : rendered;
            })(),
            timeoutMs,
            options.signal
          );
          if (!output.ok) {
            if (afterimageDraw || output.failure.code === "gpu_device_lost" || ("reservationFailed" in output && output.reservationFailed)) await close();
            return { ok: false, failure: output.failure };
          }
          return {
            ok: true,
            frame: finalizeGpuFrameReadback({
              paddedBase64: output.paddedBase64,
              width: admittedPlan.width,
              height: admittedPlan.height,
              bytesPerRow: output.bytesPerRow,
              evidence: assessment.evidence,
              textFit: output.textFit,
              frameStartedAtNs
            })
          };
        } catch (error) {
          if (error instanceof GpuFrameAbortError) {
            await close();
            return { ok: false, failure: gpuCancellationFailure() };
          }
          if (error instanceof GpuFrameTimeoutError) await close();
          const message = error instanceof GpuFrameTimeoutError ? error.message : "The hardware WebGPU frame operation failed.";
          const code = error instanceof GpuFrameTimeoutError ? "gpu_render_timeout" : "gpu_render_failed";
          return { ok: false, failure: { code, message } };
        } finally {
          operating = false;
          options.signal?.removeEventListener("abort", abort);
        }
      }
    }, page: opened.session.page, evidence: assessment.evidence, isClosed: () => closed, isOperating: () => operating, setOperating: (value) => { operating = value; }, defaultTimeoutMs: DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, maxTimeoutMs: MAX_GPU_FRAME_OPERATION_TIMEOUT_MS });
  return { ok: true, session };
}
