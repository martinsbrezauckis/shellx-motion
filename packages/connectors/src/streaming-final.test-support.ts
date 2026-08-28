import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { canonicalJsonSha256, escalateReceiptStatusForWarnings, hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { gpuFinalReceiptInputHashes, type StreamingFinalFrameTransportEvidence, type StreamingFinalProducerEvidence } from "@shellx-motion/renderer-ffmpeg";
import type { ConnectorStreamingFinalRenderer } from "./streaming-final";

/**
 * A high-level connector seam: it writes only a magic-bearing staged fixture and returns a
 * production-shaped receipt. Renderer integration owns real image2pipe/process/readback proof.
 */
export function successfulStreamingRenderer(input: string | {
  label?: string;
  status?: OperationReceipt["status"];
  warnings?: string[];
  output?: Record<string, unknown>;
} = "streamed test media"): ConnectorStreamingFinalRenderer {
  const options = typeof input === "string" ? { label: input } : input;
  return async (input) => {
    const warnings = options.warnings ?? [];
    const bytes = streamingTestMediaBytes(options.label ?? "streamed test media", input.outputPath);
    await mkdir(dirname(input.outputPath), { recursive: true });
    await writeFile(input.outputPath, bytes);
    const frameTransport = streamedTransportEvidence(input.frameLane, input.pkg.motion.durationMs, input.pkg.motion.fps);
    const gpuHashes = input.frameLane === "gpu"
      ? gpuFinalReceiptInputHashes(frameTransport.producer as Extract<StreamingFinalProducerEvidence, { frameLane: "gpu" }>)
      : undefined;
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `streaming-test-${hashBuffer(bytes).slice(0, 16)}`,
      operation: "render.final",
      // Match the production render-final construction: a supplied `passed` verdict cannot
      // conceal a retained actionable diagnostic, while an already decided warning/failed/not_run
      // verdict stays intact. Connector tests use this seam as a production-shaped receipt.
      status: escalateReceiptStatusForWarnings(options.status ?? "passed", warnings),
      packageId: input.pkg.manifest.id,
      inputHashes: {
        motion: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")),
        ...(gpuHashes ?? {})
      },
      createdAt: input.now?.() ?? "2026-08-08T00:00:00.000Z",
      lane: "ffmpeg",
      output: {
        path: input.outputPath,
        sha256: hashBuffer(bytes),
        frameTransport,
        ...(input.audio ? { audio: { ...input.audio, codec: "aac" } } : {}),
        ...(input.audioTracks ? { audioTracks: input.audioTracks.map((audio) => ({ ...audio, codec: "aac" })) } : {}),
        ...(options.output ?? {})
      },
      artifacts: [{ role: "rendered_media", path: input.outputPath, status: "available" }],
      warnings
    };
    return {
      ok: true,
      receipt
    };
  };
}

/** Minimal magic-bearing media for connector artifact attestation; it is not a simulated encoder. */
export function streamingTestMediaBytes(label: string, outputPath = "final.mp4"): Buffer {
  const payload = Buffer.from(label, "utf8");
  switch (extname(outputPath).toLowerCase()) {
    case ".webm":
      return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), payload]);
    case ".gif":
      return Buffer.concat([Buffer.from("GIF89a", "ascii"), payload]);
    case ".mov":
    case ".mp4":
    default:
      return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypisom", "ascii"), payload]);
  }
}

export function failedStreamingRenderer(code = "streaming_test_failed", message = "streaming test failure"): ConnectorStreamingFinalRenderer {
  return async () => ({
    ok: false,
    transport: { delivery: "streamed", reason: "stream_default" },
    error: { code, message }
  });
}

function streamedTransportEvidence(
  frameLane: "browser" | "native" | "gpu",
  durationMs: number,
  fps: number
): StreamingFinalFrameTransportEvidence {
  const frameCount = Math.ceil((durationMs / 1_000) * fps);
  return {
    delivery: "streamed",
    frameLane,
    frameCount,
    retainedFrameCount: 0,
    producer: frameLane === "browser"
      ? {
          frameLane: "browser",
          evidence: {
            schema: "shellx-motion/browser-streaming-producer@1",
            warningUnion: [],
            warningsOmitted: 0,
            stableInputHashUnion: {},
            stableInputHashKeysOmitted: 0,
            stableInputHashConflictKeys: [],
            stableInputHashConflictKeysOmitted: 0,
            processMonitoring: {
              mode: "cooperative-browser-session",
              chromiumPid: "unavailable",
              watchedRoot: "host-node-process",
              rssScope: "host-node-process-tree",
              measurement: "conservative-fallback-not-exact-per-job",
              encoderRssOverlap: "possible",
              encoderContainmentCoversChromium: false,
              reasonCode: "worker_process_unavailable"
            },
            session: { state: "closed", cleanup: "complete" }
          }
        }
      : frameLane === "native" ? {
          frameLane: "native",
          evidence: {
            schema: "shellx-motion/native-frame-producer-evidence@1",
            producer: { frameCacheEntries: 0, emittedFrameCount: frameCount, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 1 },
            session: {
              cleanupState: "closed",
              frameCacheEntries: 0,
              assetCache: { scope: "native-render-session-decoded-assets", includedInFrameRetention: false }
            },
            terminal: { lastFrameReceipt: null, laneWarnings: [], warningsOmitted: 0, downstreamAudioHandoffLayers: [], audioHandoffLayersOmitted: 0 }
          }
        }
      : {
          // Test seam only: this is structurally complete evidence, but no connector test treats
          // it as native hardware proof.
          frameLane: "gpu",
          evidence: gpuStreamingTestEvidence(frameCount)
        },
    encoderHandoff: {
      delivery: "streamed",
      maxConcurrentProducerWrites: 1,
      observedMaxConcurrentProducerWrites: 1,
      maxBufferedInputBytes: 16_384,
      inputHighWaterMarkBytes: 16_384,
      ...(frameLane === "gpu" ? { maxFrameBytesPerFrame: 16_384, maxRgbaBytesPerFrame: 16_384 } : { maxPngBytesPerFrame: 16_384 }),
      backpressure: { writes: frameCount, drainWaits: 0 },
      encoderHandoffSourceFramesRetained: 0,
      qualityPlaneSetCapacity: 2,
      uniqueHashCapacity: 2,
      attempts: [{ source: "software", encoder: "libx264", outcome: "succeeded" }],
      quality: { warnings: [], frameCount, blankFrames: 0, uniqueFrameHashes: Math.min(frameCount, 2), uniqueFrameHashesExact: true }
    }
  } satisfies StreamingFinalFrameTransportEvidence;
}

export function gpuStreamingTestEvidence(frameCount: number): Extract<StreamingFinalProducerEvidence, { frameLane: "gpu" }> ["evidence"] {
  const hash = "a".repeat(64);
  const mappedBytesPerRow = 256;
  const mappedFrameBytes = mappedBytesPerRow;
  const base64BytesPerFrame = Math.ceil(mappedFrameBytes / 3) * 4;
  const resourceBudget = {
    schema: "shellx-motion/gpu-resource-budget-evidence@1" as const,
    expectedFrames: frameCount,
    observedFrames: frameCount,
    maxima: { environmentCount: 0, environmentUniformBytes: 0 }
  };
  return {
    schema: "shellx-motion/gpu-streaming-producer@1",
    inputHashes: { "motion.json": hash },
    immutableImageResources: [],
    frameSequenceSha256: hash,
    framePlanSequenceSha256: hash,
    provenance: {
      pipelineCatalog: { schema: "shellx-motion/gpu-pipeline-catalog@1", entries: [], sha256: hash },
      staticPlan: {
        schema: "shellx-motion/gpu-scene-static-plan@1", fingerprint: hash, documentFingerprint: hash,
        canonicalFrameCount: frameCount, resourceReferencesSha256: hash, resourceReferenceCount: 0,
        maxima: { canonicalFrameCount: frameCount, maxEnvironmentCount: 0 }, geometryReuse: "not-claimed"
      },
      staticScene: { schema: "shellx-motion/gpu-static-scene-fingerprint@1", pipelineCatalogSha256: hash, inputHashesSha256: hash, sha256: hash },
      resourceBudget: { ...resourceBudget, sha256: canonicalJsonSha256(resourceBudget) }
    },
    browserVersion: "connector-test-browser/1",
    gpu: {
      schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "connector-test", webgpuFeatureStatus: "enabled",
      adapterFingerprint: hash,
      adapter: { cdpVendorId: 1, cdpDeviceId: 1, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
      limits: { maxTextureDimension2D: 1, maxBufferSize: 1, maxStorageBufferBindingSize: 1 }
    },
    video: null,
    hybrid: null,
    typography: { authority: "manifest-font-face-browser-shaped", shaping: "canvas-2d", fallbackPolicy: "manifest-bound-required", fontProbe: "font-face-load-and-font-set-check", fontAssets: [] },
    runtimeLifecycle: { browserSession: "single-per-render", device: "persistent-per-render", pipelines: "fixed-reused" },
    readback: {
      schema: "shellx-motion/gpu-readback-transport@1",
      transport: {
        path: "webgpu-texture-map-read-cdp-base64-owned-rgba", framesObserved: frameCount, width: 1, height: 1,
        tightBytesPerRow: 4, mappedBytesPerRow,
        bytes: { gpuTextureToMappedReadback: mappedFrameBytes * frameCount, cdpBase64Payload: base64BytesPerFrame * frameCount, hostBase64Decoded: mappedFrameBytes * frameCount },
        allocations: { hostBase64Decode: frameCount, rowCompaction: frameCount, straightAlpha: 0 },
        rowCompaction: { tightRowFrames: 0, paddedRowFrames: frameCount, copiedBytes: 4 * frameCount, allocationCount: frameCount },
        straightAlpha: { inPlaceOwnedBufferFrames: frameCount, copiedBytes: 0, allocationCount: 0 },
        output: { format: "rgba", colorSpace: "srgb", alphaMode: "straight", strideBytes: 4, hashing: "sha256-tight-straight-rgba" }
      },
      timing: { observational: true, clock: "node-process-hrtime", scope: "admitted-frame-render-and-readback", framesObserved: frameCount, totalNanoseconds: 0, minNanoseconds: 0, maxNanoseconds: 0 }
    },
    sessionResources: {
      schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: frameCount,
      frameArenaReconfigurations: 1, frameTextureSlots: 1, frameTextureBytes: 4, depthTextureBytes: 0, readbackBytes: 4, frameArenaBytes: 8,
      frameTextureHighWaterSlots: 1, frameTextureHighWaterBytes: 4, frameArenaHighWaterBytes: 8,
      frameArenaReservations: frameCount, frameArenaLateAllocationRefusals: 0,
      dynamicBufferSlots: 1, dynamicBufferBytes: 4, dynamicBufferHighWaterSlots: 1, dynamicBufferHighWaterBytes: 4,
      environmentUniformCapacitySlots: 0, environmentUniformBytes: 0, environmentUniformHighWaterSlots: 0, environmentUniformHighWaterBytes: 0, environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: 0, environmentEnvelopeReservations: 0,
      immutableImageTextures: 0, retainedTextSurfaces: 0,
      pointRaster: "gpu-native-instanced", pointPositionEvaluation: "core-cpu-exact-time", pointComputeField: "not-used",
      immutablePointBufferSlots: 0, immutablePointBufferBytes: 0, immutablePointMirrorBytes: 0, immutablePointBufferHighWaterSlots: 0, immutablePointBufferHighWaterBytes: 0, adapterPointInstanceLimit: 0,
      computeParticleBufferSlots: 0, computeParticleBufferBytes: 0, computeParticleBufferHighWaterSlots: 0, computeParticleBufferHighWaterBytes: 0, adapterComputeParticleInstanceLimit: 0,
      computeParticleDispatches: 0, computeParticleAbi: "not-used", computeParticleInstanceBytes: 0, computeParticleRetainedBufferCount: 0, computeParticleUniformBytes: 0,
      computeParticleRasterCalls: 0, computeParticleHeadRasterCalls: 0, computeParticleTrailRasterCalls: 0, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0
    },
    processMonitoring: { mode: "precontained-direct-chromium", chromiumRootPid: 42, watchedRoot: "precontained-chromium-root", rssScope: "precontained-chromium-tree", measurement: "exact-precontained-chromium-root-pid", watchRegistered: true, containment: null, encoderContainmentCoversChromium: false },
    session: { state: "closed", cleanup: "complete" }
  } as unknown as Extract<StreamingFinalProducerEvidence, { frameLane: "gpu" }> ["evidence"];
}
