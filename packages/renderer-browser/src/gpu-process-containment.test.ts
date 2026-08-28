import { createHash } from "node:crypto";
import { compileGpuSceneStaticPlan, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { type GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import {
  createGpuStreamingFrameProducer as createGpuStreamingFrameProducerImpl,
  GpuStreamingProducerContainmentError,
  type GpuStreamingJobContext
} from "./gpu-streaming-producer";
import type { GpuStreamingFrameProducerInput } from "./gpu-streaming-producer-types";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";

function staticPlanFor(pkg: MotionPackage) {
  const staticPlan = compileGpuSceneStaticPlan(pkg.motion); if (!staticPlan.ok) throw new Error(staticPlan.failure.message);
  return staticPlan.plan;
}

function createGpuStreamingFrameProducer(input: Omit<GpuStreamingFrameProducerInput, "staticPlan">) {
  return createGpuStreamingFrameProducerImpl({ ...input, staticPlan: staticPlanFor(input.pkg) });
}

describe("GPU browser process containment", () => {
  it("watches the exact pre-contained Chromium root before emitting frames", async () => {
    const watched = vi.fn();
    const producer = createGpuStreamingFrameProducer({ pkg: gpuPackage(), openRuntime: async () => fakeRuntime() });

    await producer.produce({ async write() {} }, containedJob(new AbortController().signal, watched));

    expect(watched).toHaveBeenCalledTimes(1);
    expect(watched).toHaveBeenCalledWith(4_242);
    expect(producer.evidence.processMonitoring).toEqual({
      mode: "precontained-direct-chromium",
      chromiumRootPid: 4_242,
      watchedRoot: "precontained-chromium-root",
      rssScope: "precontained-chromium-tree",
      measurement: "exact-precontained-chromium-root-pid",
      watchRegistered: true,
      containment: containment(4_242),
      encoderContainmentCoversChromium: true
    });
  });

  it("closes the owned browser runtime when the admitted job aborts", async () => {
    const controller = new AbortController();
    const closed = vi.fn();
    const producer = createGpuStreamingFrameProducer({
      pkg: gpuPackage(),
      openRuntime: async () => fakeRuntime(closed)
    });

    await expect(producer.produce({
      async write() { controller.abort(new Error("operator cancelled")); }
    }, containedJob(controller.signal))).rejects.toThrow("operator cancelled");

    expect(closed).toHaveBeenCalledTimes(1);
    expect(producer.evidence.session).toEqual({ state: "closed", cleanup: "complete" });
  });

  it("closes the owned browser runtime after WebGPU device loss", async () => {
    const closed = vi.fn();
    const producer = createGpuStreamingFrameProducer({
      pkg: gpuPackage(),
      openRuntime: async () => fakeRuntime(closed, {
        code: "gpu_device_lost",
        message: "device lost in test"
      })
    });

    await expect(producer.produce({ async write() {} }, containedJob(new AbortController().signal)))
      .rejects.toMatchObject({ code: "gpu_device_lost" });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(producer.evidence.session).toEqual({ state: "closed", cleanup: "complete" });
  });

  it("refuses a runtime without a BrowserServer PID and closes it without registering a fallback PID", async () => {
    const watched = vi.fn();
    const closed = vi.fn();
    const producer = createGpuStreamingFrameProducer({
      pkg: gpuPackage(),
      openRuntime: async () => {
        const opened = fakeRuntime(closed);
        if (!opened.ok) return opened;
        return { ok: true, session: { ...opened.session, browserProcess: undefined as unknown as typeof opened.session.browserProcess } };
      }
    });

    await expect(producer.produce({ async write() {} }, containedJob(new AbortController().signal, watched)))
      .rejects.toBeInstanceOf(GpuStreamingProducerContainmentError);

    expect(watched).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(producer.evidence.processMonitoring).toMatchObject({
      chromiumRootPid: "unavailable",
      watchRegistered: false,
      containment: null,
      encoderContainmentCoversChromium: false,
      reasonCode: "browser_pid_unavailable"
    });
  });

  it("fails closed before launch when an outer final adapter does not provide admitted final bounds", async () => {
    const opened = vi.fn(async () => fakeRuntime());
    const producer = createGpuStreamingFrameProducer({ pkg: gpuPackage(), openRuntime: opened });

    await expect(producer.produce({ async write() {} }, {
      admission: "pre-acquired",
      signal: new AbortController().signal,
      scratchRoot: "",
      maxProcessTreeRssBytes: 0,
      watchProcess() {}
    })).rejects.toBeInstanceOf(GpuStreamingProducerContainmentError);

    expect(opened).not.toHaveBeenCalled();
    expect(producer.evidence.processMonitoring).toMatchObject({
      chromiumRootPid: "unavailable",
      containment: null,
      encoderContainmentCoversChromium: false,
      reasonCode: "final_launch_context_unavailable"
    });
  });
});

function gpuPackage(): MotionPackage {
  return {
    root: "/test/gpu-containment",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_gpu_containment",
      name: "GPU containment",
      motion: "motion.json",
      assets: [],
      sourceApp: "test",
      compatibility: { lanes: ["gpu"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_gpu_containment",
      name: "GPU containment",
      durationMs: 1_000,
      fps: 2,
      width: 2,
      height: 2,
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" },
      layers: []
    }
  };
}

function containedJob(signal: AbortSignal, watchProcess: (pid: number) => void = () => undefined): GpuStreamingJobContext {
  return {
    admission: "pre-acquired",
    signal,
    scratchRoot: "/test/scratch",
    maxProcessTreeRssBytes: 512 * 1024 * 1024,
    watchProcess
  };
}

function containment(rootPid: number) {
  return {
    rootPid,
    mode: "unix-process-group" as const,
    status: "enforced" as const,
    killTree: true as const,
    memoryLimit: "rss-monitor" as const,
    maxProcessTreeRssBytes: 512 * 1024 * 1024
  };
}

function fakeRuntime(
  onClose: () => void = () => undefined,
  failure?: { code: "gpu_device_lost"; message: string }
): GpuFrameRenderSessionOpenResult {
  let framesRendered = 0;
  return {
    ok: true,
    session: {
      browserProcess: { pid: 4_242, launcher: "precontained-direct-chromium", containment: containment(4_242) },
      async uploadImages(images) { return { ok: true, uploaded: images.length }; },
      async resourceMetrics() {
        return {
          schema: "shellx-motion/gpu-page-session-resources@1" as const,
          framesRendered,
          frameArenaReconfigurations: 1,
          frameTextureSlots: 1,
          frameTextureBytes: 4,
          depthTextureBytes: 0,
          readbackBytes: 4,
          frameArenaBytes: 8,
          frameTextureHighWaterSlots: 1,
          frameTextureHighWaterBytes: 4,
          frameArenaHighWaterBytes: 8,
          frameArenaReservations: framesRendered,
          frameArenaLateAllocationRefusals: 0,
          dynamicBufferSlots: 1,
          dynamicBufferBytes: 4,
          dynamicBufferHighWaterSlots: 1,
          dynamicBufferHighWaterBytes: 4,
          environmentUniformCapacitySlots: 0,
          environmentUniformBytes: 0,
          environmentUniformHighWaterSlots: 0,
          environmentUniformHighWaterBytes: 0,
          environmentUniformLateAllocationRefusals: 0,
          environmentDrawsRendered: 0,
          environmentEnvelopeReservations: 0,
          immutableImageTextures: 0,
          retainedTextSurfaces: 0,
          pointRaster: "gpu-native-instanced" as const,
          pointPositionEvaluation: "core-cpu-exact-time" as const,
          pointComputeField: "not-used" as const,
          immutablePointBufferSlots: 0,
          immutablePointBufferBytes: 0,
          immutablePointMirrorBytes: 0,
          immutablePointBufferHighWaterSlots: 0,
          immutablePointBufferHighWaterBytes: 0,
          adapterPointInstanceLimit: 0,
          computeParticleBufferSlots: 0,
          computeParticleBufferBytes: 0,
          computeParticleBufferHighWaterSlots: 0,
          computeParticleBufferHighWaterBytes: 0,
          adapterComputeParticleInstanceLimit: 0,
          computeParticleDispatches: 0,
          computeParticleAbi: "not-used" as const,
          computeParticleInstanceBytes: 0,
          computeParticleRetainedBufferCount: 0,
          computeParticleUniformBytes: 0,
          computeParticleRasterCalls: 0,
          computeParticleHeadRasterCalls: 0,
          computeParticleTrailRasterCalls: 0,
          computeParticleCapacityReconfigurations: 0,
          computeParticleLateAllocationRefusals: 0
        };
      },
      async render(plan) {
        if (failure) return { ok: false, failure };
        const frame = plan as { width: number; height: number };
        const rgba = Buffer.alloc(frame.width * frame.height * 4, 0x7f);
        const mappedBytesPerRow = Math.ceil((frame.width * 4) / 256) * 256;
        const mappedBytes = mappedBytesPerRow * frame.height;
        framesRendered += 1;
        return {
          ok: true,
          frame: {
            rgba,
            sha256: createHash("sha256").update(rgba).digest("hex"),
            width: frame.width,
            height: frame.height,
            evidence: gpuEvidence(),
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
          }
        };
      },
      async close() { onClose(); }
    }
  };
}

function gpuEvidence(): GpuRuntimeEvidence {
  return {
    schema: "shellx-motion/gpu-runtime-evidence@1",
    backend: "webgpu-browser",
    browserSource: "test",
    webgpuFeatureStatus: "enabled",
    adapterFingerprint: "0".repeat(64),
    adapter: {
      cdpVendorId: 1,
      cdpDeviceId: 2,
      cdpVendor: "test",
      cdpDevice: "test",
      vendor: "test",
      device: "test",
      architecture: null,
      description: null
    },
    limits: { maxTextureDimension2D: 4_096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 }
  };
}
