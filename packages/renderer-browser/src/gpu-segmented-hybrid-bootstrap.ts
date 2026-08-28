import {
  compileGpuHybridTextureRequests,
  compileGpuSceneStaticPlan,
  streamingFrameTimestampMs,
  type GpuHybridTextureRequest,
} from "@shellx-motion/core";
import { bindGpuSegmentedHybridPrivateState, gpuSegmentedHybridPrivateState } from "./gpu-segmented-hybrid-admission";
import { openGpuSegmentedHybridRangeCapture } from "./gpu-segmented-hybrid-range";
import {
  GpuSegmentedHybridAdmission,
  type GpuSegmentedHybridPreparation,
  type GpuSegmentedHybridRangeCleanupEvidence,
} from "./gpu-segmented-hybrid-types";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";

/**
 * Captures and releases one canonical first-active texture before the durable
 * store opens. The caller supplies the same precontained runtime that was
 * opened with `dynamicImages: [preparation.dynamicTexture]`; no version-probe
 * or second Chromium process is created here.
 */
export async function bootstrapGpuSegmentedHybridAdmission(input: {
  readonly preparation: GpuSegmentedHybridPreparation;
  readonly runtime: GpuFrameRenderSession;
  readonly job: GpuStreamingJobContext;
}): Promise<GpuSegmentedHybridAdmission> {
  const version = input.runtime.browserVersion?.trim();
  if (!version) throw new Error("GPU segmented hybrid bootstrap requires the exact precontained runtime Chromium version.");
  const request = firstActiveRequest(input.preparation);
  const provisional = new GpuSegmentedHybridAdmission({
    schema: "shellx-motion/gpu-segmented-hybrid-admission@1",
    staticPlanFingerprint: input.preparation.identity.staticPlanFingerprint,
    descriptor: input.preparation.identity.descriptor,
    sourceSnapshot: input.preparation.identity.sourceSnapshot,
    captureContractSha256: input.preparation.identity.captureContractSha256,
    browser: Object.freeze({ ...input.preparation.identity.browser, version }),
    dynamicTexture: input.preparation.identity.dynamicTexture,
    policy: input.preparation.identity.policy,
    // Never returned: it only unlocks the internal bootstrap range capture.
    bootstrap: Object.freeze({ index: request.index, atMs: request.atMs, atUs: request.request.atUs, requestFingerprint: request.request.requestFingerprint, resourceId: input.preparation.dynamicTexture.id, width: request.request.width, height: request.request.height, pngSha256: "0".repeat(64), decodedRgbaSha256: "0".repeat(64), cleanup: placeholderCleanup(input.preparation.dynamicTexture) })
  }, input.preparation.dynamicTexture);
  bindGpuSegmentedHybridPrivateState(provisional, input.preparation);
  const capture = openGpuSegmentedHybridRangeCapture({
    admission: provisional,
    runtime: input.runtime,
    job: input.job,
    range: { index: 0, startFrameIndex: request.index, endFrameIndexExclusive: request.index + 1 },
    schedule: [request]
  });
  let cleanup: GpuSegmentedHybridRangeCleanupEvidence | undefined;
  try {
    const resource = await capture.capture(request);
    const ledger = capture.finish();
    cleanup = await capture.close();
    const entry = ledger.entries[0];
    if (!entry || resource.resourceId !== input.preparation.dynamicTexture.id || entry.resourceId !== resource.resourceId || entry.width !== resource.width || entry.height !== resource.height || entry.requestFingerprint !== request.request.requestFingerprint) {
      throw new Error("GPU segmented hybrid bootstrap capture lost its exact dynamic texture binding.");
    }
    const admission = new GpuSegmentedHybridAdmission(Object.freeze({
      schema: "shellx-motion/gpu-segmented-hybrid-admission@1" as const,
      staticPlanFingerprint: input.preparation.identity.staticPlanFingerprint,
      descriptor: input.preparation.identity.descriptor,
      sourceSnapshot: input.preparation.identity.sourceSnapshot,
      captureContractSha256: input.preparation.identity.captureContractSha256,
      browser: Object.freeze({ ...input.preparation.identity.browser, version }),
      dynamicTexture: input.preparation.identity.dynamicTexture,
      policy: input.preparation.identity.policy,
      bootstrap: Object.freeze({ ...entry, cleanup })
    }), input.preparation.dynamicTexture);
    bindGpuSegmentedHybridPrivateState(admission, input.preparation);
    return admission;
  } catch (error) {
    try {
      cleanup ??= await capture.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "GPU segmented hybrid bootstrap and cleanup both failed.");
    }
    throw error;
  }
}

function firstActiveRequest(preparation: GpuSegmentedHybridPreparation): { index: number; atMs: number; request: GpuHybridTextureRequest } {
  // The frozen descriptor's source snapshot is valid only at an active layer. Walk the bounded
  // canonical timeline to find the first Core-minted exact request, never duplicate timeline math.
  const motion = gpuSegmentedHybridPrivateState(preparation).packageTemplate.motion;
  const plan = compileGpuSceneStaticPlan(motion);
  if (!plan.ok) throw new Error(`GPU segmented hybrid bootstrap Core static planning failed: ${plan.failure.message}`);
  const topology = plan.plan.layers.find((layer) => layer.id === preparation.identity.descriptor.layerId);
  if (!topology || topology.firstCanonicalFrame === null) throw new Error("GPU segmented hybrid bootstrap found no active canonical frame.");
  const index = topology.firstCanonicalFrame;
  const atMs = streamingFrameTimestampMs(index, motion.fps, motion.durationMs);
  const planned = compileGpuHybridTextureRequests({ motion, atUs: Math.round(atMs * 1_000), snapshots: new Map([[preparation.identity.sourceSnapshot.layerId, preparation.identity.sourceSnapshot]]) });
  if (!planned.ok || planned.requests.length !== 1) throw new Error(`GPU segmented hybrid bootstrap did not mint one canonical first-active request${planned.ok ? "." : `: ${planned.failure.message}`}`);
  return { index, atMs, request: planned.requests[0] };
}

function placeholderCleanup(dynamicTexture: GpuSegmentedHybridPreparation["dynamicTexture"]): GpuSegmentedHybridRangeCleanupEvidence {
  return Object.freeze({ captureContext: "not-opened", scratch: "not-opened", dynamicTexture: Object.freeze({ ...dynamicTexture }) });
}
