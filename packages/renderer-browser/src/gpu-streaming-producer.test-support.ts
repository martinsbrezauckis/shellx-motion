import { createHash } from "node:crypto";
import type { GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-streaming-producer";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";

export function fakeGpuRuntime(onClose: () => void, failure?: { code: "gpu_device_lost"; message: string }): GpuFrameRenderSessionOpenResult {
  let framesRendered = 0;
  return { ok: true, session: {
    browserProcess: { pid: 4_242, launcher: "precontained-direct-chromium", containment: { rootPid: 4_242, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 512 * 1024 * 1024 } },
    async uploadImages(images) { return { ok: true, uploaded: images.length }; },
    async resourceMetrics() { return fakeGpuSessionResources(framesRendered); },
    async render(plan) {
      if (failure) return { ok: false, failure };
      const frame = plan as { width: number; height: number }; const rgba = Buffer.alloc(frame.width * frame.height * 4, 0x7f); framesRendered += 1;
      const mappedBytesPerRow = Math.ceil((frame.width * 4) / 256) * 256;
      const mappedBytes = mappedBytesPerRow * frame.height;
      return { ok: true, frame: {
        rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: frame.width, height: frame.height, evidence: fakeGpuEvidence(),
        readback: {
          schema: "shellx-motion/gpu-readback-frame@1", width: frame.width, height: frame.height,
          tightBytesPerRow: frame.width * 4, mappedBytesPerRow,
          gpuTextureToMappedReadbackBytes: mappedBytes, cdpBase64PayloadBytes: Math.ceil(mappedBytes / 3) * 4, hostBase64DecodedBytes: mappedBytes,
          allocations: { hostBase64Decode: 1, rowCompaction: mappedBytesPerRow === frame.width * 4 ? 0 : 1, straightAlpha: 0 },
          copiedBytes: { rowCompaction: mappedBytesPerRow === frame.width * 4 ? 0 : frame.width * frame.height * 4, straightAlpha: 0 },
          rowCompaction: mappedBytesPerRow === frame.width * 4 ? "bypassed-tight-stride" : "copied-padded-rows",
          straightAlpha: "in-place-owned-buffer", hostFrameElapsedNanoseconds: 0,
          hostClock: "node-process-hrtime", hostTimingScope: "admitted-frame-render-and-readback"
        }
      } };
    },
    async close() { onClose(); }
  } };
}

export function fakeGpuSessionResources(framesRendered: number) {
  return { schema: "shellx-motion/gpu-page-session-resources@1" as const, framesRendered, frameArenaReconfigurations: 1, frameTextureSlots: 1, frameTextureBytes: 4, depthTextureBytes: 0, readbackBytes: 4, frameArenaBytes: 8, frameTextureHighWaterSlots: 1, frameTextureHighWaterBytes: 4, frameArenaHighWaterBytes: 8, frameArenaReservations: framesRendered, frameArenaLateAllocationRefusals: 0, dynamicBufferSlots: 1, dynamicBufferBytes: 4, dynamicBufferHighWaterSlots: 1, dynamicBufferHighWaterBytes: 4, environmentUniformCapacitySlots: 0, environmentUniformBytes: 0, environmentUniformHighWaterSlots: 0, environmentUniformHighWaterBytes: 0, environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: 0, environmentEnvelopeReservations: 0, immutableImageTextures: 0, retainedTextSurfaces: 0, pointRaster: "gpu-native-instanced" as const, pointPositionEvaluation: "core-cpu-exact-time" as const, pointComputeField: "not-used" as const, immutablePointBufferSlots: 0, immutablePointBufferBytes: 0, immutablePointMirrorBytes: 0, immutablePointBufferHighWaterSlots: 0, immutablePointBufferHighWaterBytes: 0, adapterPointInstanceLimit: 0, computeParticleBufferSlots: 0, computeParticleBufferBytes: 0, computeParticleBufferHighWaterSlots: 0, computeParticleBufferHighWaterBytes: 0, adapterComputeParticleInstanceLimit: 0, computeParticleDispatches: 0, computeParticleAbi: "not-used" as const, computeParticleInstanceBytes: 0, computeParticleRetainedBufferCount: 0, computeParticleUniformBytes: 0, computeParticleRasterCalls: 0, computeParticleHeadRasterCalls: 0, computeParticleTrailRasterCalls: 0, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0 };
}

export function containedGpuJob(signal = new AbortController().signal, watched: number[] = []): GpuStreamingJobContext {
  return { admission: "pre-acquired", signal, scratchRoot: "/test/scratch", maxProcessTreeRssBytes: 512 * 1024 * 1024, watchProcess(pid) { watched.push(pid); } };
}

export function fakeGpuEvidence(): GpuRuntimeEvidence {
  return { schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "enabled", adapterFingerprint: "0".repeat(64), adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null }, limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 } };
}
