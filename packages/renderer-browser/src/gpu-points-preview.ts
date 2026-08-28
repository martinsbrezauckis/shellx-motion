import { defaultLocalMotionJobGovernor, gpuVideoTimelineAtUs, LocalMotionJobError, motionLayoutGapAnimationLaneRefusal, motionScene3DAnimationStorePresent, type MotionPackage } from "@shellx-motion/core";
import { compileGpuScene3DAnimationStaticPlan, type GpuScene3DAnimationFramePlan, type GpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";
import { createGpuFrameRenderSession, DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, type GpuFrameRenderSession } from "./gpu-frame-renderer";
import { deriveGpuEnvironmentSessionEnvelope } from "./gpu-page-environment-envelope";
import type { GpuPreviewDecodedVideoFrameBatch, GpuPreviewVideoFrameProvider, GpuPreviewVideoProviderCleanupEvidence, GpuPreviewVideoProviderProbe } from "./gpu-preview-video-frame-provider";
import { previewVideoProbeFailure, previewVideoProviderEvidenceFailure, previewVideoReceiptEvidence, type PreviewVideoReceiptEvidence } from "./gpu-preview-video-orchestration";
import { resolveGpuPreviewOutputPath } from "./gpu-preview-output";
import { captureGpuPreviewManifestIdentity, captureGpuPreviewPackageSnapshot, gpuPreviewPackageSnapshotFreshness, type GpuPreviewManifestIdentity, type GpuPreviewPackageSnapshot } from "./gpu-preview-package-snapshot";
import { gpuO6AdmittedMotionAuthority, gpuO6PackageSnapshotFreshness, packageWithGpuO6AdmittedMotion, refreshGpuO6AdmittedMotion } from "./gpu-o6-admitted-motion";
import { createGpuPreviewStaticPlanSession } from "./gpu-preview-static-plan-session";
import { finalizeGpuPreviewFrame } from "./gpu-preview-frame-finalize";
import { gpuPreviewPublicationUncertainty } from "./gpu-preview-publication-uncertainty";
import {
  assertNoStructuralPrivatePublication,
  resolveRendererPrivateOutputPublication
} from "./private-output-publication";
import { gpuPreviewAbortRequested, mergeGpuPreviewAbortSignals } from "./gpu-preview-session-abort";
import { renderGpuPreviewOneShot, type GpuPreviewOneShotOptions } from "./gpu-preview-one-shot";
import { prepareGpuPreviewVideo, type GpuPreviewVideoProviderAdmission, type PreparedGpuPreviewVideo } from "./gpu-preview-video-prepare";
import { admitGpuPreviewEffectModuleResources, prepareGpuPreviewAdmittedSceneResources } from "./gpu-preview-effect-module-admission";
import { gpuPreviewPlanFailure } from "./gpu-preview-refusal";
import { compileBehaviorAwareGpuFrame, compileGpuGeometryKeyframesPreResourceFrame, compileGpuRelationsPreResourceFrame, compileGpuScene3DAnimationPreResourceFrame } from "./gpu-behavior-frame-routing";
import { gltfPbrFinalEntrypointRefusal } from "./gltf-pbr-final-entrypoint-refusal";
import { gpuScene3dAnimationManifestAssetRefusal, gpuScene3dAnimationManifestPbrRefusal } from "./gpu-scene3d-animation-manifest-assets";
import {
  gpuEffectModuleApplicationLedger,
  gpuEffectModuleBeginUseFrameResources,
  recordGpuEffectModuleApplication,
  gpuPreviewEffectModuleReceiptEvidence,
  type GpuEffectModuleBeginUseLease
} from "./gpu-effect-module-use-authority";
import type { GpuPreviewFrame, GpuPreviewFrameOptions, GpuPreviewResult, GpuPreviewSession, GpuPreviewSessionCleanupEvidence, GpuPreviewSessionOptions } from "./gpu-preview-session-types";
export type { GpuPreviewFrame, GpuPreviewFrameOptions, GpuPreviewResult, GpuPreviewSession, GpuPreviewSessionCleanupEvidence, GpuPreviewSessionOptions } from "./gpu-preview-session-types";
const gpuPreviewOneShotAuthority = Symbol("gpuPreviewOneShotAuthority"), gpuCollisionShowcaseAuthority = Symbol("gpuCollisionShowcaseAuthority");

/** Public reusable sessions intentionally retain their existing non-O6 preview contract. */
export function createGpuPreviewSession(pkg: MotionPackage, options: GpuPreviewSessionOptions = {}): GpuPreviewSession {
  return createGpuPreviewSessionInternal(pkg, options);
}

/** Only the direct one-shot entry point holds this module-private O6 authority. */
function createGpuPreviewOneShotSession(pkg: MotionPackage, options: GpuPreviewSessionOptions = {}): GpuPreviewSession {
  return createGpuPreviewSessionInternal(pkg, options, gpuPreviewOneShotAuthority);
}
/** Source-only base for the closed C6G retained schedule; deliberately absent from the package index. */
export function createGpuCollisionShowcasePreviewSessionBase(pkg: MotionPackage, options: GpuPreviewSessionOptions = {}): GpuPreviewSession { return createGpuPreviewSessionInternal(pkg, options, gpuCollisionShowcaseAuthority); }

function createGpuPreviewSessionInternal(pkg: MotionPackage, options: GpuPreviewSessionOptions = {}, authority?: symbol): GpuPreviewSession {
  const oneShotAuthority = authority === gpuPreviewOneShotAuthority;
  const retainedScene3dAnimationAuthority = authority === gpuCollisionShowcaseAuthority;
  const governor = options.governor ?? defaultLocalMotionJobGovernor;
  let manifestIdentity: GpuPreviewManifestIdentity | undefined;
  let packageSnapshot: GpuPreviewPackageSnapshot | undefined;
  let runtime: GpuFrameRenderSession | undefined;
  let provider: GpuPreviewVideoFrameProvider | undefined;
  let providerProbe: GpuPreviewVideoProviderProbe | undefined;
  let closed = false;
  let cleanup: GpuPreviewSessionCleanupEvidence | undefined;
  let closePromise: Promise<GpuPreviewSessionCleanupEvidence> | undefined;
  let reservedDynamicVideoSlots = 0;
  let dynamicVideoWrites = 0;
  let terminalPoison = false;
  let operationTail: Promise<void> = Promise.resolve();
  let admittedO6Package: MotionPackage | undefined, retainedO6Static: ReturnType<typeof compileGpuScene3DAnimationStaticPlan> | undefined, retainedO6StaticCompilations = 0, retainedO6FramePlans = 0;
  const sessionAbort = new AbortController();
  const staticPlanSession = createGpuPreviewStaticPlanSession({ pkg, effectModuleAuthority: options.effectModuleAuthority, prepareResources: options.prepareResourcesForTest, admittedO6Package: () => admittedO6Package });
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = operationTail.then(operation, operation);
    operationTail = next.then(() => undefined, () => undefined);
    return next;
  };
  const ensureVideoProvider = async (signal: AbortSignal): Promise<GpuPreviewVideoProviderAdmission | { ok: false; error: { code: string; message: string } }> => {
    if (!staticPlanSession.packageHasVideo) return { ok: false, error: { code: "gpu_video_provider_unexpected", message: "GPU preview requested a video provider for a package without video." } };
    if (!provider) {
      if (!options.openVideoProvider) return { ok: false, error: { code: "gpu_preview_video_provider_required", message: "GPU preview packages with video require a host-owned exact-time preview provider before Chromium can open." } };
      let opened: GpuPreviewVideoFrameProvider | undefined;
      try {
        opened = await options.openVideoProvider({ pkg: admittedO6Package ?? pkg, signal });
        provider = opened;
        providerProbe = await provider.probe(signal);
      } catch (error) {
        const closeError = opened
          ? await opened.close().then(() => undefined, (cleanupError) => cleanupError)
          : undefined;
        provider = undefined; providerProbe = undefined;
        const message = error instanceof Error ? error.message : "The host-owned GPU preview video provider could not open or probe.";
        const cleanupMessage = closeError instanceof Error ? ` Provider cleanup also failed: ${closeError.message}` : closeError ? " Provider cleanup also failed." : "";
        return { ok: false, error: { code: signal.aborted ? "gpu_cancelled" : "gpu_preview_video_provider_refused", message: `${message}${cleanupMessage}` } };
      }
    }
    if (!providerProbe) return { ok: false, error: { code: "gpu_preview_video_provider_refused", message: "The host-owned GPU preview video provider did not retain a source probe." } };
    const evidenceFailure = previewVideoProviderEvidenceFailure(provider.evidence);
    if (evidenceFailure) { closed = true; terminalPoison = true; return { ok: false, error: { code: "gpu_preview_video_provider_refused", message: evidenceFailure } }; }
    const slotFailure = previewVideoProbeFailure(providerProbe, staticPlanSession.expectedVideoLayers);
    if (slotFailure) { closed = true; terminalPoison = true; return { ok: false, error: { code: "gpu_preview_video_provider_refused", message: slotFailure } }; }
    if (provider.evidence.sourceCount !== new Set(providerProbe.slots.map((slot) => slot.assetRef)).size) { closed = true; terminalPoison = true; return { ok: false, error: { code: "gpu_preview_video_provider_refused", message: "GPU preview video provider source count does not bind its probed immutable slots." } }; }
    return { ok: true, provider, probe: providerProbe };
  };
  const closeInternal = (waitForOperations: boolean): Promise<GpuPreviewSessionCleanupEvidence> => closePromise ??= (async () => {
    closed = true;
    sessionAbort.abort();
    if (waitForOperations) await operationTail.catch(() => undefined);
    const runtimeToClose = runtime, providerToClose = provider;
    const expectedReleasedFrames = providerToClose?.evidence.cache.entries ?? 0;
    const [runtimeClose, providerClose] = await Promise.allSettled([
      runtimeToClose?.close() ?? Promise.resolve(),
      providerToClose?.close() ?? Promise.resolve(undefined)
    ]);
    const runtimeResources = runtimeToClose?.resourceMetrics
      ? await runtimeToClose.resourceMetrics().catch(() => null)
      : null;
    runtime = undefined;
    let providerCleanup: GpuPreviewVideoProviderCleanupEvidence | null = null;
    if (providerClose.status === "fulfilled") providerCleanup = providerClose.value ?? null;
    provider = undefined; providerProbe = undefined;
    const destructionFailure = reservedDynamicVideoSlots > 0
      && runtimeResources?.dynamicImageTextureDestructions !== reservedDynamicVideoSlots;
    const providerCleanupFailure = providerToClose !== undefined
      && (providerCleanup === null || providerCleanup.releasedFrames !== expectedReleasedFrames || providerCleanup.releasedSources !== staticPlanSession.expectedVideoSourceCount || providerCleanup.privateScratchReleased !== true);
    if (runtimeClose.status === "rejected" || providerClose.status === "rejected" || destructionFailure || providerCleanupFailure) {
      const messages = [runtimeClose, providerClose].flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : "unknown cleanup failure"] : []);
      if (destructionFailure) messages.push("GPU preview dynamic texture destruction metrics did not match reserved slots");
      if (providerCleanupFailure) messages.push("GPU preview provider cleanup evidence did not release its cached frames, immutable source snapshots, and private scratch");
      throw new Error(`GPU preview cleanup failed: ${messages.join("; ")}`);
    }
    cleanup = Object.freeze({ closed: true as const, runtimeResources, provider: providerCleanup, ...(retainedScene3dAnimationAuthority ? { scene3dAnimation: { staticWrapperCompilations: retainedO6StaticCompilations, framePlanCompilations: retainedO6FramePlans } } : {}) });
    return cleanup;
  })();
  const close = (): Promise<GpuPreviewSessionCleanupEvidence> => closeInternal(true);
  const closeForPublication = (): Promise<GpuPreviewSessionCleanupEvidence> => closeInternal(false);
  const renderFrame = async (frameOptions: GpuPreviewFrameOptions): Promise<GpuPreviewResult> => {
    try {
      assertNoStructuralPrivatePublication(frameOptions);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "gpu_private_output_publication_refused",
          message: error instanceof Error ? error.message : "GPU private output publication is not renderer-minted."
        }
      };
    }
    const privateOutputPublication = resolveRendererPrivateOutputPublication(frameOptions);
    const result = await serialized<GpuPreviewResult>(async () => {
      const atMs = frameOptions.atMs ?? 0;
      if (closed) return { ok: false, error: { code: "gpu_cancelled", message: "The GPU preview session is closed." } };
      const cancellation = (): GpuPreviewResult | undefined => !gpuPreviewAbortRequested(frameOptions.signal, sessionAbort.signal) ? undefined : (closed = true, terminalPoison = true, { ok: false, error: { code: "gpu_cancelled", message: "The GPU preview request was cancelled before resource preparation or output-path setup." } });
      const initialCancellation = cancellation(); if (initialCancellation) return initialCancellation;
      // O6 preflight is descriptor-only in Core. Retain the source reference only for the
      // legacy branch; every O6 operation below receives its frozen Core-admitted snapshot.
      const sourceMotion = pkg.motion;
      const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(sourceMotion, "gpu-frame");
      if (layoutGapAnimationRefusal) return { ok: false, error: { code: "gpu_unsupported_feature", message: layoutGapAnimationRefusal.message } };
      const o6Present = motionScene3DAnimationStorePresent(sourceMotion);
      if (o6Present && !oneShotAuthority && !retainedScene3dAnimationAuthority) {
        return { ok: false, error: { code: "gpu_unsupported_feature", message: "Reusable GPU preview sessions do not admit document scene3dAnimation@1; only the direct @shellx-motion/renderer-browser renderMotionGpuPreview API is available." } };
      }
      const o6Static = o6Present ? retainedScene3dAnimationAuthority ? retainedO6Static ??= (() => { retainedO6StaticCompilations += 1; return compileGpuScene3DAnimationStaticPlan(sourceMotion); })() : compileGpuScene3DAnimationStaticPlan(sourceMotion) : undefined;
      if (o6Static && !o6Static.ok) return { ok: false, error: gpuPreviewPlanFailure(o6Static.failure) };
      const o6Authority = o6Static?.ok ? gpuO6AdmittedMotionAuthority(o6Static.plan) : undefined;
      if (o6Static?.ok && !o6Authority) return { ok: false, error: { code: "gpu_resource_refused", message: "GPU scene3d animation preview lost its Core-issued admitted Motion authority." } };
      const admittedO6Motion = o6Authority?.motion;
      if (o6Static?.ok) {
        const manifestAssetRefusal = gpuScene3dAnimationManifestAssetRefusal(pkg);
        if (manifestAssetRefusal) return { ok: false, error: manifestAssetRefusal };
        const manifestPbrRefusal = gpuScene3dAnimationManifestPbrRefusal(pkg);
        if (manifestPbrRefusal) return { ok: false, error: manifestPbrRefusal };
      }
      const pbrRefusal = o6Static?.ok ? undefined : gltfPbrFinalEntrypointRefusal(pkg, "gpu-preview");
      if (pbrRefusal) return { ok: false, error: pbrRefusal };
      if (admittedO6Motion) admittedO6Package = packageWithGpuO6AdmittedMotion(pkg, admittedO6Motion);
      // O6's compiler executes synchronously above, so capture its manifest identity before the
      // await below can yield to a mutating caller. Legacy paths retain their previous ordering.
      try { manifestIdentity ??= captureGpuPreviewManifestIdentity(pkg); }
      catch (error) { return { ok: false, error: { code: "gpu_input_hash_refused", message: error instanceof Error ? error.message : "GPU preview manifest identity could not be prepared." } }; }
      const staticResult = await staticPlanSession.resolve(o6Static?.plan);
      if (!staticResult.ok) return { ok: false, error: gpuPreviewPlanFailure(staticResult.failure) };
      const refreshedO6 = o6Authority ? refreshGpuO6AdmittedMotion(pkg, o6Authority.staticPlan) : undefined;
      if (refreshedO6 && !refreshedO6.ok) return { ok: false, error: { code: "gpu_resource_refused", message: refreshedO6.message } };
      const motion = o6Authority
        ? refreshedO6?.ok ? refreshedO6.motion : o6Authority.motion
        : pkg.motion;
      if (refreshedO6?.ok) admittedO6Package = packageWithGpuO6AdmittedMotion(pkg, refreshedO6.motion);
      const preResourcePlan = compileGpuScene3DAnimationPreResourceFrame(motion, atMs, staticResult.scene3dAnimationPlan)
        ?? compileGpuRelationsPreResourceFrame(motion, atMs, staticResult.relationsPlan)
        ?? compileGpuGeometryKeyframesPreResourceFrame(motion, atMs, staticResult.geometryKeyframesPlan);
      if (preResourcePlan && !preResourcePlan.ok) return { ok: false, error: gpuPreviewPlanFailure(preResourcePlan.failure) };
      const staticCancellation = cancellation(); if (staticCancellation) return staticCancellation;
      const snapshotFreshness = () => o6Authority
        ? gpuO6PackageSnapshotFreshness(pkg, packageSnapshot, o6Authority.staticPlan)
        : packageSnapshot ? gpuPreviewPackageSnapshotFreshness(pkg, packageSnapshot) : { ok: false as const, message: "GPU preview package snapshot was not captured before freshness validation." };
      try {
        packageSnapshot ??= captureGpuPreviewPackageSnapshot(pkg, manifestIdentity!, admittedO6Motion, o6Static?.ok ? o6Static.plan.documentFingerprint : undefined);
        const freshness = snapshotFreshness();
        if (!freshness.ok) return { ok: false, error: { code: "gpu_resource_refused", message: freshness.message } };
      }
      catch (error) { return { ok: false, error: { code: "gpu_input_hash_refused", message: error instanceof Error ? error.message : "GPU preview input identity could not be prepared." } }; }
      const resourceAdmission = await admitGpuPreviewEffectModuleResources(!!staticResult.plan.effectModules?.length, staticPlanSession.packageHasVideo, staticPlanSession.resources);
      if (!resourceAdmission.ok) return { ok: false, error: resourceAdmission.error };
      let resources = resourceAdmission.resources;
      const resourceFreshness = snapshotFreshness();
      if (!resourceFreshness.ok) return { ok: false, error: { code: "gpu_resource_refused", message: resourceFreshness.message } };
      const resourceCancellation = cancellation(); if (resourceCancellation) return resourceCancellation;
      let outputPath: string;
      try {
        outputPath = await (options.resolveOutputPathForTest ?? resolveGpuPreviewOutputPath)(packageSnapshot.packageId, frameOptions);
      } catch (error) {
        return { ok: false, error: { code: "invalid_output_path", message: error instanceof Error ? error.message : "GPU preview output path is invalid." } };
      }
      const outputPathFreshness = snapshotFreshness();
      if (!outputPathFreshness.ok) return { ok: false, error: { code: "gpu_resource_refused", message: outputPathFreshness.message } };
      const pathCancellation = cancellation(); if (pathCancellation) return pathCancellation;
      let disposeOperationSignal: (() => void) | undefined;
      try {
        let planFingerprint: string | undefined, behaviorFramePlan: import("@shellx-motion/core").GpuSceneBehaviorFramePlan | undefined, relationsFramePlan: import("@shellx-motion/core").GpuSceneRelationsFramePlan | undefined, scene3dAnimationFramePlan: GpuScene3DAnimationFramePlan | undefined, effectModuleEvidence: ReturnType<typeof gpuPreviewEffectModuleReceiptEvidence> | undefined, fulfilledVideo: { batch: GpuPreviewDecodedVideoFrameBatch; probe: GpuPreviewVideoProviderProbe } | undefined;
        const operationSignal = mergeGpuPreviewAbortSignals(frameOptions.signal, sessionAbort.signal); disposeOperationSignal = operationSignal.dispose;
        let video: PreparedGpuPreviewVideo | undefined; if (staticPlanSession.packageHasVideo) {
          const prepared = await prepareGpuPreviewVideo({ motion, atMs, signal: operationSignal.signal, ensure: ensureVideoProvider });
          if (!prepared.ok) { if (prepared.integrity || prepared.error.code === "gpu_cancelled") { closed = true; terminalPoison = true; } disposeOperationSignal(); disposeOperationSignal = undefined; return { ok: false, error: prepared.error }; }
          video = prepared.video;
          fulfilledVideo = { batch: video.batch, probe: video.probe };
        }
        let effectLease: GpuEffectModuleBeginUseLease | undefined;
        let effectModuleApplication: { index: number; atUs: number; framePlanFingerprint: string; layerId: string } | undefined;
        try {
          const governed = await governor.run({
          lane: "gpu",
          operation: "gpu.preview",
          scratchRoot: frameOptions.outDir,
          signal: operationSignal.signal,
          ...(frameOptions.callerId ? { callerId: frameOptions.callerId } : {}),
          ...(frameOptions.jobId ? { jobId: frameOptions.jobId } : {})
          }, async ({ signal, watchProcess }) => {
            // The governor is already admitted, then beginUse rechecks revocation before any GPU work.
            if (staticResult.resolution && staticResult.plan.effectModules?.length) effectLease = await options.effectModuleAuthority!.beginUse(staticResult.resolution);
            const prepared = await prepareGpuPreviewAdmittedSceneResources(resources, staticPlanSession.resources);
            if (!prepared.ok) return { ok: false as const, failure: prepared.error };
            const admittedResources = prepared.resources;
            resources = admittedResources;
            const frameResources = { images: admittedResources.images, fonts: admittedResources.fonts, ...(video ? { videos: video.videos, videoRequests: video.requests } : {}), ...(effectLease ? gpuEffectModuleBeginUseFrameResources(effectLease) : {}) };
            const planResult = preResourcePlan ?? compileBehaviorAwareGpuFrame(motion, atMs, staticResult.behaviorPlan, frameResources, staticResult.geometryKeyframesPlan, staticResult.relationsPlan, staticResult.scene3dAnimationPlan);
            if (!planResult.ok) return { ok: false as const, failure: gpuPreviewPlanFailure(planResult.failure) };
            const frame = planResult.frame;
            behaviorFramePlan = planResult.behaviorFramePlan;
            relationsFramePlan = planResult.relationsFramePlan;
            scene3dAnimationFramePlan = planResult.scene3dAnimationFramePlan;
            if (retainedScene3dAnimationAuthority && scene3dAnimationFramePlan) retainedO6FramePlans += 1;
            planFingerprint = scene3dAnimationFramePlan?.fingerprint ?? relationsFramePlan?.fingerprint ?? behaviorFramePlan?.fingerprint ?? planResult.geometryKeyframesFramePlan?.fingerprint ?? frame.fingerprint;
            const activeModule = frame.draws.find((draw) => draw.kind === "effectModule");
            if (activeModule) {
              const atUs = gpuVideoTimelineAtUs(atMs);
              if (atUs === null) return { ok: false as const, failure: { code: "gpu_invalid_time", message: "GPU effect-module preview time cannot be represented as integer microseconds." } };
              effectModuleApplication = { index: 0, atUs, framePlanFingerprint: planFingerprint, layerId: activeModule.layerId };
            }
            if (!runtime) {
              const environmentEnvelope = deriveGpuEnvironmentSessionEnvelope(staticResult.plan, motion);
              const opened = await (options.openRuntime ?? createGpuFrameRenderSession)(admittedResources.sessionImages, admittedResources.sessionFonts, { ...(environmentEnvelope ? { environmentEnvelope } : {}), ...(video ? { dynamicImages: video.dynamicSlots } : {}) });
              if (!opened.ok) return opened;
              runtime = opened.session;
              reservedDynamicVideoSlots = video?.dynamicSlots.length ?? 0;
            }
            watchProcess(runtime.browserProcess.pid);
            if (video?.batch.frames.length) {
              if (!runtime.replaceDynamicImages) return { ok: false as const, failure: { code: "gpu_preview_video_provider_refused", message: "The injected GPU runtime cannot replace pre-reserved dynamic video textures." } };
              const replaced = await runtime.replaceDynamicImages(video.batch.frames.map((frame) => frame.upload), { timeoutMs: frameOptions.timeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, signal });
              if (!replaced.ok) { closed = true; terminalPoison = true; return replaced; }
              dynamicVideoWrites += video.batch.frames.length;
            }
            const rendered = await runtime.render(frame, { timeoutMs: frameOptions.timeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, signal, ...(effectLease ? { effectModuleLease: effectLease } : {}) });
            if (rendered.ok && effectLease && effectModuleApplication) recordGpuEffectModuleApplication(effectLease, effectModuleApplication, frame);
            return rendered;
          });
          disposeOperationSignal(); disposeOperationSignal = undefined;
          if (!governed.value.ok) {
            if (governed.value.failure.code === "gpu_cancelled") { closed = true; terminalPoison = true; }
            return { ok: false, error: governed.value.failure, resources: governed.evidence };
          }
          if (!resources) throw new Error("GPU preview completed without prepared scene resources.");
          const effectModuleLedger = effectLease ? gpuEffectModuleApplicationLedger(effectLease, effectModuleApplication ? [effectModuleApplication] : []) : undefined;
          const videoEvidence = fulfilledVideo
            ? await previewVideoReceiptEvidence(provider, fulfilledVideo, runtime, atMs, dynamicVideoWrites)
            : undefined;
          if (videoEvidence && !videoEvidence.ok) { closed = true; terminalPoison = true; return { ok: false, error: videoEvidence.failure, resources: governed.evidence }; }
          if (effectLease) {
            const released = await effectLease.release();
            if (!released.released) throw new Error("GPU effect-module preview lease was already released before receipt publication.");
            if (effectModuleLedger) effectModuleEvidence = gpuPreviewEffectModuleReceiptEvidence(effectLease, effectModuleLedger);
            effectLease = undefined;
          }
          const published = await finalizeGpuPreviewFrame({
            pkg, snapshot: packageSnapshot, ...(o6Static?.ok ? { freshness: snapshotFreshness } : {}), outputPath, rgba: governed.value.frame.rgba, width: governed.value.frame.width, height: governed.value.frame.height, gpu: governed.value.frame.evidence, resources: governed.evidence, atMs, planFingerprint: planFingerprint!,
            resourceHashes: { ...resources.inputHashes, ...(fulfilledVideo ? provider?.inputHashes ?? {} : {}) }, externallyCancelled: () => frameOptions.signal?.aborted === true, sessionCancelled: () => sessionAbort.signal.aborted, finalizeCleanupBeforePublication: oneShotAuthority, closeForPublication, now: frameOptions.now,
            ...(videoEvidence?.ok ? { videoEvidence: videoEvidence.evidence } : {}), ...(effectModuleEvidence ? { effectModuleEvidence } : {}),
            ...(staticResult.behaviorPlan && behaviorFramePlan ? { behaviorEvidence: { staticPlan: staticResult.behaviorPlan, framePlan: behaviorFramePlan } } : {}),
            ...(staticResult.relationsPlan && relationsFramePlan ? { relationEvidence: { staticPlan: staticResult.relationsPlan, framePlan: relationsFramePlan } } : {}),
            ...(staticResult.scene3dAnimationPlan && scene3dAnimationFramePlan ? { scene3dAnimationEvidence: { staticPlan: staticResult.scene3dAnimationPlan, framePlan: scene3dAnimationFramePlan } } : {}),
            ...(privateOutputPublication ? { privateOutputPublication } : {}),
          });
          if (!published.ok) return { ok: false, error: published.error, resources: governed.evidence };
          return {
          ok: true,
          frame: {
            path: outputPath,
            sha256: published.sha256,
            width: governed.value.frame.width,
            height: governed.value.frame.height,
            atMs,
            gpu: governed.value.frame.evidence,
            resources: governed.evidence
          },
            receipt: published.receipt
          };
        } finally {
          if (effectLease) await effectLease.release();
        }
      } catch (error) {
        disposeOperationSignal?.();
        const uncertainty = gpuPreviewPublicationUncertainty(error);
        if (uncertainty) {
          return {
            ok: false,
            error: uncertainty
          };
        }
        const message = error instanceof Error ? error.message : "GPU preview admission failed.";
        const code = sessionAbort.signal.aborted || frameOptions.signal?.aborted
          ? "gpu_cancelled"
          : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "gpu_execution_refused";
        if (code === "job_cancelled" || code === "gpu_cancelled") closed = true;
        return {
          ok: false,
          error: { code, message },
          ...(error instanceof LocalMotionJobError && error.evidence ? { resources: error.evidence } : {})
        };
      }
    });
    if (terminalPoison) void close().catch(() => undefined);
    return result;
  };
  return { close, renderFrame };
}
/** Open, render one general GPU PNG frame, and release the GPU session. */
export function renderMotionGpuPreview(pkg: MotionPackage, options: GpuPreviewOneShotOptions): Promise<GpuPreviewResult> {
  return renderGpuPreviewOneShot(pkg, options, createGpuPreviewOneShotSession);
}
export type { GpuPreviewOneShotOptions } from "./gpu-preview-one-shot";
export const createGpuPointsPreviewSession = createGpuPreviewSession;
export { renderMotionGpuPointsPreview } from "./gpu-points-preview-compat";
export type { GpuPointsPreviewFrame, GpuPointsPreviewFrameOptions, GpuPointsPreviewResult, GpuPointsPreviewSession } from "./gpu-points-preview-compat";
export type GpuPointsPreviewSessionOptions = GpuPreviewSessionOptions;
