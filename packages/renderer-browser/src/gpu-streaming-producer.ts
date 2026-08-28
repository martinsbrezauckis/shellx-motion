import { createHash } from "node:crypto";
import {
  canonicalJson,
  gpuSceneBehaviorFrameEvidenceFact,
  motionLayoutGapAnimationLaneRefusal,
  motionScene3DAnimationLaneRefusal,
  streamingFrameTimestampMs
} from "@shellx-motion/core";
import {
  createGpuFrameRenderSession,
  DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS,
  type GpuFrameRenderSession
} from "./gpu-frame-renderer";
import { isGpuBrowserProcess, isGpuFinalLaunchContext, isPrecontainedGpuBrowser } from "./gpu-process-containment";
import { GPU_PAGE_PIPELINE_CATALOG } from "./gpu-page-pipeline-catalog";
import { createGpuResourceBudgetAccumulator, fingerprintGpuStaticScene } from "./gpu-provenance";
import { gpuLoadedPackageInputHashes } from "./gpu-loaded-input-hashes";
import { prepareGpuSceneResources } from "./gpu-scene-resources";
import { attestGpuSessionResources } from "./gpu-streaming-producer-session-resources";
import { createGpuReadbackTransportAccumulator } from "./gpu-streaming-producer-readback-evidence";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import { emptyGpuStreamingEvidence, mutableGpuStreamingMetrics, resetGpuStreamingMetrics, type MutableGpuStreamingEvidence } from "./gpu-streaming-producer-state";
import { bindGpuTextFitEvidence } from "./gpu-streaming-producer-text-fit-evidence";
import type { GpuStreamingFrameProducer, GpuStreamingFrameProducerInput, GpuStreamingStaticPlan, GpuStreamingStaticPlanEvidence } from "./gpu-streaming-producer-types";
import type { GpuVideoFrameProvider } from "./gpu-video-frame-provider";
import { openGpuStreamingHybridLifecycle, type GpuStreamingHybridLifecycle } from "./gpu-streaming-producer-hybrid-lifecycle";
import { attestGpuStreamingStaticPlan, validateGpuStreamingPreparedResources } from "./gpu-streaming-static-plan";
import { deriveGpuEnvironmentSessionEnvelope } from "./gpu-page-environment-envelope";
import { admittedGpuStreamingRange, canonicalGpuStreamingFrameCount } from "./gpu-streaming-producer-range";
import { openGpuStreamingEffectModuleRun, type GpuStreamingEffectModuleRun } from "./gpu-streaming-producer-effect-modules";
import { compileBehaviorAwareGpuFrame } from "./gpu-behavior-frame-routing";
import { gpuStreamingBehaviorEvidence } from "./gpu-streaming-behavior-evidence";
import { admitGpuStreamingStaticPlan } from "./gpu-streaming-static-admission";
import {
  GpuStreamingProducerBusyError,
  GpuStreamingProducerCapabilityError,
  GpuStreamingProducerCleanupError,
  GpuStreamingProducerContainmentError,
  GpuStreamingProducerRuntimeError
} from "./gpu-streaming-producer-errors";
export type { GpuBrowserProcessTreeContainment, GpuStreamingJobContext } from "./gpu-process-containment";
export type { GpuReadbackTransportEvidence, GpuStreamingFrameProducer, GpuStreamingFrameProducerEvidence, GpuStreamingFrameProducerInput, GpuStreamingFrameProducerMetrics, GpuStreamingFrameRange, GpuStreamingFrameRangeEvidence, GpuStreamingFrameSink, GpuStreamingProvenanceEvidence, GpuStreamingStaticPlan, GpuStreamingStaticPlanEvidence } from "./gpu-streaming-producer-types";
export {
  GpuStreamingProducerBusyError,
  GpuStreamingProducerCapabilityError,
  GpuStreamingProducerCleanupError,
  GpuStreamingProducerContainmentError,
  GpuStreamingProducerRuntimeError
} from "./gpu-streaming-producer-errors";
/** Production bridge from the bounded GPU profile to final one-frame-at-a-time RGBA delivery. */
export function createGpuStreamingFrameProducer(input: GpuStreamingFrameProducerInput): GpuStreamingFrameProducer {
  const { durationMs, fps, width, height } = input.pkg.motion;
  const canonicalFrameTotal = canonicalGpuStreamingFrameCount(durationMs, fps);
  const range = admittedGpuStreamingRange(input.range, canonicalFrameTotal);
  const frameCount = range.endFrameIndexExclusive - range.startFrameIndex;
  const frameTimeoutMs = input.frameTimeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS;
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(input.pkg.motion, "gpu-static");
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(input.pkg.motion, "gpu-static");
  const rootStoreRefusal = layoutGapAnimationRefusal ?? scene3dAnimationRefusal;
  const staticAdmission = rootStoreRefusal
    ? { behaviorStaticPlan: input.behaviorStaticPlan, staticPlan: input.staticPlan, failure: { code: rootStoreRefusal.code, message: rootStoreRefusal.message } }
    : admitGpuStreamingStaticPlan(input, input.pkg.motion, canonicalFrameTotal, input.pkg.manifest.assets);
  const loadedInputHashes = rootStoreRefusal ? Object.freeze({}) : gpuLoadedPackageInputHashes(input.pkg);
  const { behaviorStaticPlan, staticPlan, failure: staticPlanFailure } = staticAdmission;
  const environmentEnvelope = staticPlan && !staticPlanFailure
    ? deriveGpuEnvironmentSessionEnvelope(staticPlan, input.pkg.motion)
    : null;
  const staticPlanEvidence = staticPlan && !staticPlanFailure ? attestGpuStreamingStaticPlan(staticPlan) : null;
  let preparedResources = input.resources;
  const metrics = mutableGpuStreamingMetrics(frameCount);
  let evidence = initialEvidence(loadedInputHashes, staticPlanEvidence);
  let rangeEvidence: Readonly<{ frameHashes: readonly string[]; framePlanFingerprints: readonly string[] }> | null = null;
  let active = false;
  return {
    frameCount,
    durationMs,
    fps,
    width,
    height,
    metrics,
    get evidence() { return evidence; },
    get rangeEvidence() { return rangeEvidence; },
    async produce(sink, job) {
      if (job.admission !== "pre-acquired") throw new Error("GPU streamed frame producer requires a pre-acquired job context.");
      if (active) throw new GpuStreamingProducerBusyError();
      active = true;
      resetGpuStreamingMetrics(metrics);
      evidence = initialEvidence(loadedInputHashes, staticPlanEvidence);
      rangeEvidence = null;
      evidence.session.state = "opening";
      evidence.session.cleanup = "pending";
      let runtime: GpuFrameRenderSession | undefined;
      let videoProvider: GpuVideoFrameProvider | undefined;
      let hybrid: GpuStreamingHybridLifecycle | null = null;
      let effectModules: GpuStreamingEffectModuleRun | null = null;
      let operationError: unknown | undefined;
      let openFailed = false;
      const frameSequence = createHash("sha256");
      const planSequence = createHash("sha256");
      const behaviorFrames: import("@shellx-motion/core").GpuSceneBehaviorFrameEvidenceFact[] = [];
      const resourceBudget = createGpuResourceBudgetAccumulator(frameCount);
      const readbackEvidence = createGpuReadbackTransportAccumulator();
      const rangeFrameHashes: string[] = [];
      const rangeFramePlanFingerprints: string[] = [];
      try {
        throwIfAborted(job.signal);
        if (staticPlanFailure) throw new GpuStreamingProducerCapabilityError(staticPlanFailure);
        try {
          effectModules = openGpuStreamingEffectModuleRun(staticPlan, input.effectModuleLease, input.segmentedHybrid);
        } catch (error) {
          throw new GpuStreamingProducerCapabilityError({ code: staticPlan.effectModules && (staticPlan.hybridTextures?.length || input.segmentedHybrid) ? "gpu_unsupported_feature" : "gpu_resource_refused", message: error instanceof Error ? error.message : "GPU final delivery refused its effect-module use." });
        }
        if (typeof job.watchProcess !== "function" || !isGpuFinalLaunchContext(job)) {
          throw new GpuStreamingProducerContainmentError(
            "GPU final rendering requires an admitted scratch root and process-tree limit before Chromium launch."
          );
        }
        preparedResources ??= await prepareGpuSceneResources(input.pkg, staticPlan.resources);
        if (staticPlan.maxima.maxVideoCount > 0) {
          if (!input.openVideoProvider) throw new GpuStreamingProducerCapabilityError({ code: "gpu_unsupported_feature", message: "GPU final rendering requires a host-owned immutable video-frame provider for active GPU video layers." });
          videoProvider = await input.openVideoProvider();
        }
        const staticResourceFailure = validateGpuStreamingPreparedResources(staticPlan, preparedResources, videoProvider);
        if (staticResourceFailure) throw new GpuStreamingProducerCapabilityError(staticResourceFailure);
        const resourceInputHashes = Object.freeze({ ...preparedResources.inputHashes, ...videoProvider?.inputHashes });
        const staticScene = fingerprintGpuStaticScene({
          motion: input.pkg.motion,
          loadedInputHashes,
          resourceInputHashes,
          pipelineCatalogSha256: GPU_PAGE_PIPELINE_CATALOG.sha256
        });
        evidence.inputHashes = Object.freeze({ ...loadedInputHashes, ...resourceInputHashes });
        evidence.provenance = {
          pipelineCatalog: GPU_PAGE_PIPELINE_CATALOG,
          staticPlan: staticPlanEvidence,
          staticScene,
          resourceBudget: null
        };
        evidence.typography.fontAssets = preparedResources.sessionFonts.map(({ resourceId, assetRef, family, weight, style, sha256 }) => ({ resourceId, assetRef, family, weight, style, sha256 }));
        const finalBrowser = {
          scratchRoot: job.scratchRoot,
          maxProcessTreeRssBytes: job.maxProcessTreeRssBytes,
          signal: job.signal
        };
        const openRuntime = input.openRuntime
          ?? ((images, fonts, options) => createGpuFrameRenderSession(images, fonts, options));
        const opened = await openRuntime(preparedResources.sessionImages, preparedResources.sessionFonts, {
          finalBrowser,
          ...(input.browserLocation ? { browserLocation: input.browserLocation } : {}),
          ...(environmentEnvelope ? { environmentEnvelope } : {}),
          ...(input.segmentedHybrid ? { dynamicImages: [input.segmentedHybrid.admission.dynamicTexture] } : {})
        });
        if (!opened.ok) {
          openFailed = true;
          throw new GpuStreamingProducerRuntimeError(opened.failure);
        }
        runtime = opened.session;
        evidence.browserVersion = runtime.browserVersion?.trim() || null;
        evidence.immutableImageResources = Object.freeze((runtime.immutableImageResources ?? []).map((image) => Object.freeze({ ...image })));
        const browserProcess = runtime.browserProcess;
        if (!isGpuBrowserProcess(browserProcess)) {
          evidence.processMonitoring = {
            ...evidence.processMonitoring,
            reasonCode: "browser_pid_unavailable"
          };
          throw new GpuStreamingProducerContainmentError(
            "GPU final rendering refused a browser runtime without an owned Chromium root PID."
          );
        }
        if (!isPrecontainedGpuBrowser(browserProcess.containment, browserProcess.pid, job.maxProcessTreeRssBytes)) {
          evidence.processMonitoring = {
            ...evidence.processMonitoring,
            reasonCode: "browser_containment_unavailable"
          };
          throw new GpuStreamingProducerContainmentError(
            "GPU final rendering refused a Chromium runtime without pre-launch enforced containment for the exact root PID."
          );
        }
        job.watchProcess(browserProcess.pid);
        evidence.processMonitoring = {
          mode: "precontained-direct-chromium",
          chromiumRootPid: browserProcess.pid,
          watchedRoot: "precontained-chromium-root",
          rssScope: "precontained-chromium-tree",
          measurement: "exact-precontained-chromium-root-pid",
          watchRegistered: true,
          containment: Object.freeze({ ...browserProcess.containment }),
          encoderContainmentCoversChromium: true
        };
        // Module/behavior paths deliberately avoid legacy hybrid recompile.
        hybrid = effectModules || behaviorStaticPlan
          ? null
          : await openGpuStreamingHybridLifecycle({ producer: input, pkg: input.pkg, runtime, job, range, loadedInputHashes, resourceInputHashes });
        evidence.session.state = "rendering";
        for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
          throwIfAborted(job.signal);
          const atMs = streamingFrameTimestampMs(index, fps, durationMs);
          const videoBatch = videoProvider ? await videoProvider.frameAt(atMs, job.signal) : undefined;
          if (videoBatch && videoBatch.atMs !== atMs) throw new GpuStreamingProducerCapabilityError({ code: "gpu_resource_refused", message: "GPU video provider returned a frame batch for the wrong canonical timestamp." });
          if (videoBatch?.frames.length) {
            const uploaded = await runtime.uploadImages(videoBatch.frames.map((frame) => frame.upload), { timeoutMs: frameTimeoutMs, signal: job.signal });
            if (!uploaded.ok) throw new GpuStreamingProducerRuntimeError(uploaded.failure);
          }
          const capturedHybrid = hybrid ? await hybrid.frameResources({ index, atMs, evidence, signal: job.signal }) : null;
          if (capturedHybrid && !capturedHybrid.ok) throw new GpuStreamingProducerRuntimeError(capturedHybrid.failure);
          const exactHybrid = capturedHybrid?.ok ? capturedHybrid.resources : undefined;
          const videos = videoBatch ? new Map(videoBatch.frames.map((frame) => [frame.layerId, frame.resource])) : undefined;
          const frameResources = {
            images: preparedResources.images,
            ...(videos ? { videos } : {}),
            ...(exactHybrid ? { hybridTextureRequests: exactHybrid.hybridTextureRequests, hybridTextures: exactHybrid.hybridTextures } : {}),
            fonts: preparedResources.fonts,
            ...(effectModules?.resources ?? {})
          };
          const compiled = compileBehaviorAwareGpuFrame(input.pkg.motion, atMs, behaviorStaticPlan, frameResources);
          if (!compiled.ok) throw new GpuStreamingProducerCapabilityError(compiled.failure);
          const frame = compiled.frame;
          resourceBudget.observe(frame.budget);
          const result = await runtime.render(frame, {
            timeoutMs: frameTimeoutMs,
            signal: job.signal,
            ...(input.effectModuleLease ? { effectModuleLease: input.effectModuleLease } : {})
          });
          if (!result.ok) throw new GpuStreamingProducerRuntimeError(result.failure);
          try { effectModules?.recordSuccessfulFrame(index, atMs, frame); } catch (error) {
            throw new GpuStreamingProducerCapabilityError({ code: "gpu_resource_refused", message: error instanceof Error ? error.message : "GPU effect-module frame application record was refused." });
          }
          if (!result.frame.readback) throw new GpuStreamingProducerCapabilityError({ code: "gpu_readback_evidence_missing", message: "GPU final rendering requires exact readback copy and allocation evidence for every emitted frame." });
          const observedReadback = readbackEvidence.observe(result.frame.readback);
          if (!observedReadback.ok) throw new GpuStreamingProducerCapabilityError({ code: "gpu_readback_evidence_invalid", message: observedReadback.message });
          bindGpuEvidence(evidence, result.frame.evidence);
          bindGpuTextFitEvidence(evidence, atMs, result.frame.textFit ?? []);
          planSequence.update(canonicalJson({ index, atMs, fingerprint: frame.fingerprint }));
          if (compiled.behaviorFramePlan) {
            const behaviorFrame = compiled.behaviorFramePlan;
            behaviorFrames.push(gpuSceneBehaviorFrameEvidenceFact(index, atMs, behaviorFrame));
          }
          frameSequence.update(canonicalJson({ index, atMs, sha256: result.frame.sha256 }));
          rangeFramePlanFingerprints.push(frame.fingerprint);
          rangeFrameHashes.push(result.frame.sha256);
          let rgba: Buffer | undefined = result.frame.rgba;
          metrics.activeRgbaBuffers += 1;
          metrics.peakRgbaBuffers = Math.max(metrics.peakRgbaBuffers, metrics.activeRgbaBuffers);
          metrics.activeFrameHandoffs += 1;
          metrics.peakConcurrentFrameHandoffs = Math.max(metrics.peakConcurrentFrameHandoffs, metrics.activeFrameHandoffs);
          try {
            await sink.write({
              index,
              atMs,
              format: "rgba",
              width: result.frame.width,
              height: result.frame.height,
              strideBytes: result.frame.width * 4,
              colorSpace: "srgb",
              alphaMode: "straight",
              rgba
            });
            metrics.emittedFrames += 1;
            throwIfAborted(job.signal);
          } finally {
            rgba = undefined;
            metrics.activeFrameHandoffs -= 1;
            metrics.activeRgbaBuffers -= 1;
          }
        }
        const sessionResources = await attestGpuSessionResources(runtime, frameCount);
        if (!sessionResources.ok) throw new GpuStreamingProducerCapabilityError(sessionResources.failure);
        try { effectModules?.attestLive(sessionResources.metrics); } catch (error) {
          throw new GpuStreamingProducerCapabilityError({ code: "gpu_session_resources_invalid", message: error instanceof Error ? error.message : "GPU effect-module live resource evidence was refused." });
        }
        const finalizedReadback = readbackEvidence.finish(frameCount);
        if (!finalizedReadback.ok) throw new GpuStreamingProducerCapabilityError({ code: "gpu_readback_evidence_invalid", message: finalizedReadback.message });
        evidence.readback = finalizedReadback.evidence;
        evidence.sessionResources = sessionResources.metrics;
        evidence.frameSequenceSha256 = frameSequence.digest("hex");
        evidence.framePlanSequenceSha256 = planSequence.digest("hex");
        if (behaviorStaticPlan) evidence.behaviors = gpuStreamingBehaviorEvidence(behaviorStaticPlan, behaviorFrames);
        hybrid?.finish(evidence);
        rangeEvidence = Object.freeze({
          frameHashes: Object.freeze([...rangeFrameHashes]),
          framePlanFingerprints: Object.freeze([...rangeFramePlanFingerprints]),
          ...(hybrid?.directLedger ? { directHybridLedger: hybrid.directLedger } : {})
        });
        evidence.provenance = {
          ...evidence.provenance,
          resourceBudget: resourceBudget.finish()
        };
        evidence.video = videoProvider?.evidence ?? null;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        evidence.session.state = runtime ? "closing" : openFailed ? "open_failed" : "not_opened";
        evidence.video = videoProvider?.evidence ?? null;
        const closeErrors: unknown[] = [];
        try { await videoProvider?.close(); } catch (error) { closeErrors.push(error); }
        try { await hybrid?.close(); } catch (error) { closeErrors.push(error); }
        try { await runtime?.close(); } catch (error) { closeErrors.push(error); }
        if (effectModules && runtime) {
          try {
            const terminal = await runtime.resourceMetrics?.();
            effectModules.attestTerminal(terminal);
          } catch (error) {
            closeErrors.push(error);
          }
        }
        let effectModuleEvidence: import("./gpu-streaming-producer-types").GpuStreamingEffectModuleEvidence | undefined;
        if (effectModules) try { effectModuleEvidence = effectModules.evidence(closeErrors.length === 0 ? "complete" : "failed"); } catch (error) { closeErrors.push(error); }
        const closeCause = closeErrors.length > 1
          ? new AggregateError(closeErrors, "GPU source producer and hardware runtime cleanup both failed.")
          : closeErrors[0];
        if (closeCause === undefined) {
          evidence.session.state = runtime ? "closed" : evidence.session.state;
          evidence.session.cleanup = "complete";
        } else {
          evidence.session.state = "cleanup_failed";
          evidence.session.cleanup = "failed";
        }
        if (effectModuleEvidence) evidence.effectModules = effectModuleEvidence;
        active = false;
        if (closeCause === undefined && rangeEvidence && hybrid?.segmented?.ledger && hybrid.segmented.cleanup) {
          rangeEvidence = Object.freeze({
            ...rangeEvidence,
            segmentedHybrid: Object.freeze({
              identity: hybrid.segmented.identity,
              ledger: hybrid.segmented.ledger,
              cleanup: hybrid.segmented.cleanup
            })
          });
        }
        if (closeCause !== undefined) throw new GpuStreamingProducerCleanupError(operationError, closeCause);
      }
    }
  };
}
function bindGpuEvidence(evidence: MutableGpuStreamingEvidence, gpu: GpuRuntimeEvidence): void {
  if (evidence.gpu && evidence.gpu.adapterFingerprint !== gpu.adapterFingerprint) throw new GpuStreamingProducerRuntimeError({ code: "gpu_adapter_identity_unavailable", message: "GPU adapter identity changed during one streamed render session." });
  evidence.gpu = gpu;
}
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("GPU streamed frame production was cancelled.");
}
function initialEvidence(inputHashes: Readonly<Record<string, string>>, staticPlan: GpuStreamingStaticPlanEvidence | null): MutableGpuStreamingEvidence {
  const evidence = emptyGpuStreamingEvidence(inputHashes);
  evidence.provenance = { ...evidence.provenance, staticPlan };
  return evidence;
}

/** Verify the host-owned opaque lease before it can reach Core or Chromium. */
