import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonSha256, streamingFrameTimestampMs } from "@shellx-motion/core";
import type { Scene3dGltfPbrFinalRoute } from "@shellx-motion/core/internal/scene3d-gltf-pbr-final";
import {
  GPU_ADAPTER_REQUEST_OPTIONS,
  openGpuRuntime,
  type GpuRuntimeSession,
} from "./gpu-browser-runtime";
import { finalizeGpuFrameReadback } from "./gpu-frame-readback-output";
import type { GpuStreamingFrameSink } from "./gpu-streaming-producer";
import { isGpuBrowserProcess, isGpuFinalLaunchContext, isPrecontainedGpuBrowser, type GpuStreamingJobContext } from "./gpu-process-containment";
import { GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG } from "./gpu-page-scene3d-gltf-pbr-contract";
import { openWebGpuPageSessionScene3dGltfPbr, closeWebGpuPageSessionScene3dGltfPbr } from "./gpu-page-scene3d-gltf-pbr-session";
import {
  readWebGpuPageSessionScene3dGltfPbrStreamingFrame,
  releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback,
  reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback,
} from "./gpu-page-scene3d-gltf-pbr-streaming-readback";
import {
  prepareGpuScene3dGltfPbrMaterialPage,
  releaseGpuScene3dGltfPbrMaterialPage,
  renderGpuScene3dGltfPbrMaterialPage,
} from "./gpu-scene3d-gltf-pbr-material-route";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";

export const GPU_SCENE3D_GLTF_PBR_STREAMING_PRODUCER_SCHEMA = "shellx-motion/gpu-scene3d-gltf-pbr-streaming-producer@1" as const;

export interface GpuScene3dGltfPbrStreamingProducerEvidence {
  readonly schema: typeof GPU_SCENE3D_GLTF_PBR_STREAMING_PRODUCER_SCHEMA;
  readonly routeFingerprint: string;
  readonly packageId: string;
  readonly sceneStateSha256: string;
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly catalogSha256: string;
  readonly runtime: GpuRuntimeEvidence | null;
  readonly browser: { readonly version: string | null; readonly process: Readonly<Record<string, unknown>> | null };
  readonly frameSequenceSha256: string | null;
  readonly framePlanSequenceSha256: string | null;
  readonly framesRendered: number;
  readonly retainedFrameCount: 0;
  readonly sessionFrameCacheEntries: 0;
  readonly readback: {
    readonly reservedReadbackBufferBytes: number;
    readonly readbackBufferAllocations: 0 | 1;
    readonly mapOperations: number;
    readonly released: boolean;
  };
  readonly cleanup: { readonly state: "pending" | "complete" | "failed"; readonly resourceReleased: boolean; readonly readbackReleased: boolean; readonly pageClosed: boolean };
  readonly fingerprint: string | null;
}

export interface GpuScene3dGltfPbrStreamingProducer {
  readonly frameCount: number;
  readonly width: 1280;
  readonly height: 720;
  readonly fps: number;
  readonly durationMs: number;
  readonly evidence: GpuScene3dGltfPbrStreamingProducerEvidence;
  produce(sink: GpuStreamingFrameSink, job: GpuStreamingJobContext): Promise<void>;
}

/** Separate persistent Browser PBR producer; it never touches the legacy GPU page catalog/session. */
export function createGpuScene3dGltfPbrStreamingProducer(
  route: Scene3dGltfPbrFinalRoute,
  timeline: { readonly fps: number; readonly durationMs: number; readonly width: number; readonly height: number },
): GpuScene3dGltfPbrStreamingProducer {
  if (!isExactImmutableRoute(route)
    || route.rendererCatalogSha256 !== GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256
    || timeline.width !== 1280 || timeline.height !== 720 || !Number.isSafeInteger(timeline.fps) || timeline.fps < 1 || timeline.fps > 240
    || !Number.isSafeInteger(timeline.durationMs) || timeline.durationMs < 1 || timeline.durationMs > 60_000) {
    throw new Error("The fixed glTF PBR streaming producer requires the exact immutable canonical-scene 1280x720 route.");
  }
  const frameCount = Math.ceil((timeline.durationMs / 1_000) * timeline.fps);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 14_400) throw new Error("The fixed glTF PBR streaming producer frame count is outside its bounded range.");
  let active = false;
  let evidence = initialEvidence(route);
  return {
    frameCount, width: 1280, height: 720, fps: timeline.fps, durationMs: timeline.durationMs,
    get evidence() { return evidence; },
    async produce(sink, job) {
      if (active) throw new Error("The fixed glTF PBR streaming producer is already active.");
      if (job.admission !== "pre-acquired" || typeof job.watchProcess !== "function" || !isGpuFinalLaunchContext(job)) {
        throw new Error("The fixed glTF PBR streaming producer requires pre-acquired process containment.");
      }
      active = true; evidence = initialEvidence(route);
      let runtime: GpuRuntimeSession | undefined;
      let resourcesPrepared = false, readbackReserved = false, pageClosed = false;
      let cleanupFailed = false;
      const frameSequence = createHash("sha256"), planSequence = createHash("sha256");
      try {
        throwIfAborted(job.signal);
        const opened = await openGpuRuntime({ finalBrowser: { scratchRoot: job.scratchRoot, maxProcessTreeRssBytes: job.maxProcessTreeRssBytes, signal: job.signal } });
        if (!opened.ok) throw new Error(opened.failure.message);
        runtime = opened.session;
        const browser = runtime.browserProcess;
        if (!isGpuBrowserProcess(browser) || !isPrecontainedGpuBrowser(browser.containment, browser.pid, job.maxProcessTreeRssBytes)) {
          throw new Error("The fixed glTF PBR streaming producer refused an uncontained Chromium process.");
        }
        job.watchProcess(browser.pid);
        const initialized = await runtime.page.evaluate(openWebGpuPageSessionScene3dGltfPbr, GPU_ADAPTER_REQUEST_OPTIONS);
        if (!initialized.ok) throw new Error(initialized.failure.message);
        const assessed = await runtime.assessRender(initialized.runtime);
        if (!assessed.ok) throw new Error(assessed.failure.message);
        const prepared = await prepareGpuScene3dGltfPbrMaterialPage(runtime.page, route.renderPlan, job.signal);
        if (!prepared.ok) throw new Error(prepared.failure.message);
        resourcesPrepared = true;
        const reservation = await runtime.page.evaluate(reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback, {
          schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback@1" as const,
          staticFingerprint: prepared.input.staticFingerprint,
          frameFingerprint: prepared.input.frameFingerprint,
        });
        if (!reservation.ok) throw new Error(reservation.failure.message);
        readbackReserved = true;
        evidence = withRuntime(evidence, assessed.evidence, runtime.browserVersion, browser);
        for (let index = 0; index < frameCount; index += 1) {
          throwIfAborted(job.signal);
          const atMs = streamingFrameTimestampMs(index, timeline.fps, timeline.durationMs), startedAtNs = process.hrtime.bigint();
          const rendered = await renderGpuScene3dGltfPbrMaterialPage(runtime.page, prepared.input, job.signal);
          if (!rendered.ok) throw new Error(rendered.failure.message);
          const readback = await runtime.page.evaluate(readWebGpuPageSessionScene3dGltfPbrStreamingFrame, {
            schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback@1" as const,
            staticFingerprint: prepared.input.staticFingerprint,
            frameFingerprint: prepared.input.frameFingerprint,
          });
          if (!readback.ok) throw new Error(readback.failure.message);
          const frame = finalizeGpuFrameReadback({ paddedBase64: readback.paddedBase64, width: readback.width, height: readback.height, bytesPerRow: readback.bytesPerRow, evidence: assessed.evidence, textFit: [], frameStartedAtNs: startedAtNs });
          try {
            await sink.write({ index, atMs, format: "rgba", width: frame.width, height: frame.height, strideBytes: frame.width * 4, colorSpace: "srgb", alphaMode: "straight", rgba: frame.rgba });
          } finally { frame.rgba.fill(0); }
          frameSequence.update(canonicalJson({ index, atMs, sha256: frame.sha256 }));
          planSequence.update(canonicalJson({ index, atMs, fingerprint: prepared.input.frameFingerprint }));
          evidence = Object.freeze({ ...evidence, framesRendered: index + 1, readback: { ...evidence.readback, reservedReadbackBufferBytes: readback.evidence.reservedReadbackBufferBytes, readbackBufferAllocations: 1 as const, mapOperations: readback.evidence.mapOperations } });
        }
        evidence = Object.freeze({ ...evidence, frameSequenceSha256: frameSequence.digest("hex"), framePlanSequenceSha256: planSequence.digest("hex") });
      } finally {
        if (runtime && readbackReserved) {
          const released = await runtime.page.evaluate(releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback).catch(() => null);
          if (!released?.hadReservedBuffer || released.destroyedReservedBuffer !== true || released.mapOperations !== evidence.framesRendered) cleanupFailed = true;
          else evidence = Object.freeze({ ...evidence, readback: { ...evidence.readback, released: true } });
        }
        if (runtime && resourcesPrepared) {
          const released = await releaseGpuScene3dGltfPbrMaterialPage(runtime.page, job.signal.aborted ? "cancelled" : "terminal").catch(() => null);
          const expected = route.renderPlan.framePlan.cleanup;
          if (!released?.hadResources || released.destroyedTextures !== expected.textureResourceIds.length || released.destroyedVertexBuffers !== expected.primitiveIds.length
            || released.destroyedIndexBuffers !== expected.primitiveIds.length || released.destroyedUniformBuffers !== expected.primitiveIds.length
            || released.destroyedRenderTargets !== 2 || released.remainingGpuResourceBytes !== 0) cleanupFailed = true;
          else evidence = Object.freeze({ ...evidence, cleanup: { ...evidence.cleanup, resourceReleased: true } });
        }
        if (runtime) {
          try {
            const closed = await runtime.page.evaluate(closeWebGpuPageSessionScene3dGltfPbr);
            if (!closed.deviceDestroyed || closed.forcedResourceRelease) cleanupFailed = true;
            await runtime.close(); pageClosed = true;
          } catch { cleanupFailed = true; }
        }
        evidence = finalizeEvidence(evidence, pageClosed, cleanupFailed);
        active = false;
        if (cleanupFailed) throw new Error("The fixed glTF PBR streaming producer could not prove terminal resource cleanup.");
      }
    },
  };
}

function initialEvidence(route: Scene3dGltfPbrFinalRoute): GpuScene3dGltfPbrStreamingProducerEvidence {
  return Object.freeze({
    schema: GPU_SCENE3D_GLTF_PBR_STREAMING_PRODUCER_SCHEMA, routeFingerprint: route.fingerprint, packageId: route.packageId, sceneStateSha256: route.sceneStateSha256,
    inputHashes: Object.freeze({ ...route.inputHashes }), catalogSha256: route.rendererCatalogSha256,
    runtime: null, browser: Object.freeze({ version: null, process: null }), frameSequenceSha256: null, framePlanSequenceSha256: null,
    framesRendered: 0, retainedFrameCount: 0, sessionFrameCacheEntries: 0,
    readback: Object.freeze({ reservedReadbackBufferBytes: 0, readbackBufferAllocations: 0, mapOperations: 0, released: false }),
    cleanup: Object.freeze({ state: "pending", resourceReleased: false, readbackReleased: false, pageClosed: false }), fingerprint: null,
  });
}
function isExactImmutableRoute(route: Scene3dGltfPbrFinalRoute): boolean {
  const sceneStateSha256 = route.sceneStateSha256;
  const staticPlan = route.renderPlan.staticPlan, framePlan = route.renderPlan.framePlan;
  const base = {
    schema: route.schema, packageId: route.packageId, locator: route.locator, sceneStateSha256,
    inputHashes: route.inputHashes, rendererCatalogSha256: route.rendererCatalogSha256,
  };
  return /^[a-f0-9]{64}$/.test(sceneStateSha256)
    && route.inputHashes["scene3d-gltf-pbr-scene-state"] === sceneStateSha256
    && route.inputHashes["scene3d-gltf-pbr-static-plan"] === staticPlan.fingerprint
    && route.inputHashes["scene3d-gltf-pbr-frame-plan"] === framePlan.fingerprint
    && staticPlan.sceneStateSha256 === sceneStateSha256
    && framePlan.sceneStateSha256 === sceneStateSha256
    && framePlan.staticFingerprint === staticPlan.fingerprint
    && route.fingerprint === canonicalJsonSha256(base);
}
function withRuntime(evidence: GpuScene3dGltfPbrStreamingProducerEvidence, runtime: GpuRuntimeEvidence, version: string, browser: { pid: number; containment: unknown }): GpuScene3dGltfPbrStreamingProducerEvidence {
  return Object.freeze({ ...evidence, runtime, browser: Object.freeze({ version, process: Object.freeze({ pid: browser.pid, containment: browser.containment }) }) });
}
function finalizeEvidence(evidence: GpuScene3dGltfPbrStreamingProducerEvidence, pageClosed: boolean, failed: boolean): GpuScene3dGltfPbrStreamingProducerEvidence {
  const cleanup = Object.freeze({ ...evidence.cleanup, state: failed ? "failed" as const : "complete" as const, readbackReleased: evidence.readback.released, pageClosed });
  const base = { ...evidence, cleanup, fingerprint: undefined };
  return Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) });
}
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The fixed glTF PBR streaming producer was cancelled."); }
