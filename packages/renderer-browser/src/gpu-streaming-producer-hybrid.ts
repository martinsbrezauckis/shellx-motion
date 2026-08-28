import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonSha256,
  compileGpuHybridTextureRequests,
  compileGpuSceneStaticPlan,
  createGpuHybridTextureResourceBinding,
  createGpuHybridTextureSourceSnapshot,
  gpuHybridTextureResourceBindingFailure,
  streamingFrameTimestampMs,
  type GpuHybridTextureRequest,
  type GpuHybridTextureResourceBinding,
  type GpuHybridTextureSourceSnapshot,
  type GpuHybridTextureStaticDescriptor,
  type MotionPackage,
} from "@shellx-motion/core";
import { GPU_PAGE_PIPELINE_CATALOG } from "./gpu-page-pipeline-catalog";
import { fingerprintGpuStaticScene } from "./gpu-provenance";
import { openGpuHybridBrowserCapture, type GpuHybridBrowserCapture } from "./gpu-browser-hybrid";
import { openGpuRestrictedShaderHybridCapture, type GpuRestrictedShaderHybridCapture } from "./gpu-restricted-shader-hybrid";
import { DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, type GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";
import type { MutableGpuStreamingEvidence } from "./gpu-streaming-producer-state";
import type { GpuStreamingFrameProducerInput } from "./gpu-streaming-producer-types";
import { createGpuHybridCaptureLedger } from "./gpu-segmented-hybrid-ledger";
import type { GpuSegmentedHybridRangeLedger } from "./gpu-segmented-hybrid-types";

export interface GpuStreamingHybridSource {
  capture(input: { readonly index: number; readonly atMs: number; readonly evidence: MutableGpuStreamingEvidence }): Promise<
    | ({ readonly ok: true } & GpuStreamingHybridFrameResources)
    | { readonly ok: false; readonly failure: GpuRuntimeFailure }
  >;
  finish(evidence: MutableGpuStreamingEvidence): GpuSegmentedHybridRangeLedger;
  close(): Promise<void>;
}

export interface GpuStreamingHybridFrameResources {
  readonly hybridTextureRequests: ReadonlyMap<string, GpuHybridTextureRequest>;
  readonly hybridTextures: ReadonlyMap<string, GpuHybridTextureResourceBinding>;
}

/** Keeps browser-surface capture/provenance out of the final frame loop. */
export async function openGpuStreamingHybridSource(input: {
  readonly producer: GpuStreamingFrameProducerInput;
  readonly pkg: MotionPackage;
  readonly runtime: GpuFrameRenderSession;
  readonly job: GpuStreamingJobContext;
  readonly loadedInputHashes: Readonly<Record<string, string>>;
  readonly resourceInputHashes: Readonly<Record<string, string>>;
}): Promise<GpuStreamingHybridSource | null> {
  const staticPlan = compileGpuSceneStaticPlan(input.pkg.motion);
  if (!staticPlan.ok) throw new Error("GPU direct hybrid requires exactly one Core governed hybrid texture descriptor.");
  const coreStaticPlan = staticPlan.plan;
  const descriptors = coreStaticPlan.hybridTextures ?? [];
  if (descriptors.length === 0) return null;
  if (descriptors.length !== 1) {
    throw new Error("GPU direct hybrid requires exactly one Core governed hybrid texture descriptor.");
  }
  const descriptor = descriptors[0]!;
  const range = captureRange(input.producer, coreStaticPlan.canonicalFrameCount);
  const capture = input.producer.openHybridCapture
    ? await input.producer.openHybridCapture({ pkg: input.pkg, runtime: input.runtime, job: input.job })
    : descriptor.producer === "strict-data-only-html"
      ? await openGpuHybridBrowserCapture({ pkg: input.pkg, runtime: input.runtime, job: input.job, layerId: descriptor.layerId })
      : await openGpuRestrictedShaderHybridCapture({ pkg: input.pkg, runtime: input.runtime, job: input.job, layerId: descriptor.layerId });
  let sourceSnapshot: ReturnType<typeof createGpuHybridTextureSourceSnapshot>;
  let expectedCaptureCount: number | undefined;
  try {
    const contractSha256 = canonicalJsonSha256({
      schema: "shellx-motion/gpu-direct-hybrid-capture-contract@1",
      staticPlanFingerprint: coreStaticPlan.fingerprint,
      descriptorFingerprint: descriptor.descriptorFingerprint,
      sourceSnapshotSha256: capture.sourceSnapshot.sourceSnapshotSha256,
      sourceByteLength: capture.sourceSnapshot.sourceByteLength,
      policy: "strict-data-only-or-restricted-glsl-borrowed-runtime",
    });
    sourceSnapshot = createGpuHybridTextureSourceSnapshot({
      descriptor,
      sourceSnapshotSha256: capture.sourceSnapshot.sourceSnapshotSha256,
      sourceByteLength: capture.sourceSnapshot.sourceByteLength,
      captureContractSha256: contractSha256,
    });
    expectedCaptureCount = plannedCaptureCount(input.pkg, sourceSnapshot, range);
  } catch (error) {
    await closeDirectHybrid(capture, error);
    throw error;
  }
  if (!sourceSnapshot || expectedCaptureCount === undefined) throw new Error("GPU direct hybrid source snapshot setup was not admitted.");
  const ledger = createGpuHybridCaptureLedger({ range, expectedCaptureCount });
  const legacySequence = createHash("sha256");
  return {
    async capture({ index, atMs, evidence }) {
      const requested = compileGpuHybridTextureRequests({
        motion: input.pkg.motion,
        atUs: Math.round(atMs * 1_000),
        snapshots: new Map([[sourceSnapshot.layerId, sourceSnapshot]]),
      });
      if (!requested.ok) return { ok: false, failure: { code: "gpu_render_failed", message: `GPU direct hybrid Core request planning failed: ${requested.failure.message}` } };
      if (requested.requests.length === 0) return { ok: true, hybridTextureRequests: new Map(), hybridTextures: new Map() };
      if (requested.requests.length !== 1 || requested.requests[0]!.layerId !== descriptor.layerId) {
        return { ok: false, failure: { code: "gpu_render_failed", message: "GPU direct hybrid Core request planning did not mint its one declared texture request." } };
      }
      const request = requested.requests[0]!;
      const captured = await capture.capture(atMs);
      const captureBindingFailure = directHybridCaptureBindingFailure(captured.binding, descriptor, sourceSnapshot);
      if (captureBindingFailure) return { ok: false, failure: { code: "gpu_render_failed", message: captureBindingFailure } };
      if (captured.texture.width !== request.width || captured.texture.height !== request.height || captured.texture.rgba.byteLength !== request.width * request.height * 4) {
        return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU direct hybrid capture texture geometry does not match its exact Core request." } };
      }
      if (createHash("sha256").update(captured.texture.rgba).digest("hex") !== captured.texture.decodedSha256) {
        return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU hybrid capture RGBA bytes do not match their exact decoded identity." } };
      }
      const uploaded = await input.runtime.uploadImages([captured.texture], {
        timeoutMs: input.producer.frameTimeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS,
        signal: input.job.signal
      });
      if (!uploaded.ok) return uploaded;
      const resource = createGpuHybridTextureResourceBinding({ request, resourceId: captured.texture.id, decodedRgbaSha256: captured.texture.decodedSha256 });
      const layer = input.pkg.motion.layers.find((layer) => layer.id === descriptor.layerId);
      const resourceBindingFailure = layer ? gpuHybridTextureResourceBindingFailure({ motion: input.pkg.motion, layer, atUs: request.atUs, request, resource }) : "GPU direct hybrid descriptor layer disappeared.";
      if (resourceBindingFailure) return { ok: false, failure: { code: "gpu_render_failed", message: resourceBindingFailure } };
      const evidenceBindingFailure = bindGpuHybridEvidence(evidence, captured.binding);
      if (evidenceBindingFailure) return { ok: false, failure: evidenceBindingFailure };
      evidence.provenance = {
        ...evidence.provenance,
        staticScene: fingerprintGpuStaticScene({
          motion: input.pkg.motion,
          loadedInputHashes: input.loadedInputHashes,
          resourceInputHashes: { ...input.resourceInputHashes, ...captured.binding.inputHashes },
          pipelineCatalogSha256: GPU_PAGE_PIPELINE_CATALOG.sha256
        })
      };
      try {
        ledger.observe({ index, atMs, atUs: request.atUs, requestFingerprint: request.requestFingerprint, resourceId: resource.resourceId, width: resource.width, height: resource.height, pngSha256: captured.pngSha256, decodedRgbaSha256: captured.texture.decodedSha256 });
        legacySequence.update(canonicalJson({ index, atMs, pngSha256: captured.pngSha256, rgbaSha256: captured.texture.decodedSha256 }));
      } catch (error) {
        return { ok: false, failure: { code: "gpu_render_failed", message: error instanceof Error ? error.message : "GPU direct hybrid capture ledger failed." } };
      }
      return {
        ok: true,
        hybridTextureRequests: new Map([[request.layerId, request]]),
        hybridTextures: new Map([[request.layerId, resource]])
      };
    },
    finish(evidence) {
      const completed = ledger.finish();
      if (evidence.hybrid) evidence.hybrid = Object.freeze({
        ...evidence.hybrid,
        captureFrameSequenceSha256: legacySequence.digest("hex"),
        exactCaptureLedgerSequenceSha256: completed.sequenceSha256,
      });
      return completed;
    },
    async close() { await capture.close(); }
  };
}

async function closeDirectHybrid(capture: GpuHybridBrowserCapture | GpuRestrictedShaderHybridCapture, error: unknown): Promise<void> {
  try {
    await capture.close();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "GPU direct hybrid setup and cleanup both failed.");
  }
}

function captureRange(input: GpuStreamingFrameProducerInput, frameCount: number): { index: number; startFrameIndex: number; endFrameIndexExclusive: number } {
  const value = input.range ?? { index: 0, startFrameIndex: 0, endFrameIndexExclusive: frameCount };
  if (!Number.isSafeInteger(value.index) || value.index < 0 || !Number.isSafeInteger(value.startFrameIndex) || !Number.isSafeInteger(value.endFrameIndexExclusive) || value.startFrameIndex < 0 || value.endFrameIndexExclusive <= value.startFrameIndex || value.endFrameIndexExclusive > frameCount) {
    throw new Error("GPU direct hybrid range is not a canonical non-empty frame interval.");
  }
  return Object.freeze({ ...value });
}

function plannedCaptureCount(pkg: MotionPackage, sourceSnapshot: ReturnType<typeof createGpuHybridTextureSourceSnapshot>, range: { startFrameIndex: number; endFrameIndexExclusive: number }): number {
  let count = 0;
  for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
    const atMs = streamingFrameTimestampMs(index, pkg.motion.fps, pkg.motion.durationMs);
    const planned = compileGpuHybridTextureRequests({ motion: pkg.motion, atUs: Math.round(atMs * 1_000), snapshots: new Map([[sourceSnapshot.layerId, sourceSnapshot]]) });
    if (!planned.ok || planned.requests.length > 1) throw new Error(`GPU direct hybrid cannot pre-admit its exact Core request schedule${planned.ok ? "." : `: ${planned.failure.message}`}`);
    count += planned.requests.length;
  }
  return count;
}

function directHybridCaptureBindingFailure(
  binding: Awaited<ReturnType<GpuHybridBrowserCapture["capture"]>>["binding"] | Awaited<ReturnType<GpuRestrictedShaderHybridCapture["capture"]>>["binding"],
  descriptor: GpuHybridTextureStaticDescriptor,
  sourceSnapshot: GpuHybridTextureSourceSnapshot
): string | null {
  if (binding.layerId !== descriptor.layerId || binding.source !== descriptor.assetRef) {
    return "GPU direct hybrid capture binding does not match its exact Core descriptor layer and source.";
  }
  if (descriptor.producer === "strict-data-only-html") {
    if (binding.schema !== "shellx-motion/gpu-hybrid-capture@1" || binding.producer !== "governed-browser-surface") {
      return "GPU direct hybrid capture binding does not match its strict data-only HTML Core producer.";
    }
    return binding.sourceDocument.sourceSha256 === sourceSnapshot.sourceSnapshotSha256 && binding.sourceDocument.byteLength === sourceSnapshot.sourceByteLength
      ? null
      : "GPU direct hybrid HTML capture binding does not match its immutable source snapshot.";
  }
  if (binding.schema !== "shellx-motion/gpu-restricted-shader-hybrid@1" || binding.producer !== "governed-restricted-glsl-webgl") {
    return "GPU direct hybrid capture binding does not match its isolated restricted GLSL Core producer.";
  }
  return binding.shader.sourceSha256 === sourceSnapshot.sourceSnapshotSha256 && binding.shader.byteLength === sourceSnapshot.sourceByteLength
    ? null
    : "GPU direct hybrid restricted GLSL capture binding does not match its immutable source snapshot.";
}

function bindGpuHybridEvidence(evidence: MutableGpuStreamingEvidence, binding: Awaited<ReturnType<(GpuHybridBrowserCapture | GpuRestrictedShaderHybridCapture)["capture"]>>["binding"]): GpuRuntimeFailure | null {
  const next = { ...binding };
  if (evidence.hybrid) {
    const current = { ...evidence.hybrid, capturedFrames: undefined, captureFrameSequenceSha256: undefined, exactCaptureLedgerSequenceSha256: undefined };
    if (canonicalJson(current) !== canonicalJson(next)) {
      return { code: "gpu_render_failed", message: "GPU hybrid browser provenance changed during one retained render session." };
    }
    evidence.hybrid = Object.freeze({ ...evidence.hybrid, capturedFrames: evidence.hybrid.capturedFrames + 1 });
    return null;
  }
  evidence.inputHashes = Object.freeze({ ...evidence.inputHashes, ...binding.inputHashes });
  evidence.hybrid = Object.freeze({ ...next, capturedFrames: 1, captureFrameSequenceSha256: null, exactCaptureLedgerSequenceSha256: null });
  return null;
}
