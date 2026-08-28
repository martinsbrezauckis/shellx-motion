import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import type { GpuSessionImageIdentity } from "./gpu-runtime-types";
import type { GpuStreamingFrameProducerEvidence } from "./gpu-streaming-producer-types";
import type { GpuVideoFrameProviderEvidence } from "./gpu-video-frame-provider";

export type MutableGpuStreamingMetrics = {
  delivery: "streamed-raw-rgba";
  ordering: "canonical-index-timestamp";
  frameCount: number;
  emittedFrames: number;
  activeFrameHandoffs: number;
  peakConcurrentFrameHandoffs: number;
  activeRgbaBuffers: number;
  peakRgbaBuffers: number;
  retainedFrameCount: 0;
  sessionFrameCacheEntries: 0;
};

export type MutableGpuStreamingEvidence = {
  schema: "shellx-motion/gpu-streaming-producer@1";
  inputHashes: Readonly<Record<string, string>>;
  immutableImageResources: readonly GpuSessionImageIdentity[];
  frameSequenceSha256: string | null;
  framePlanSequenceSha256: string | null;
  provenance: GpuStreamingFrameProducerEvidence["provenance"];
  gpu: GpuRuntimeEvidence | null;
  browserVersion: string | null;
  video: GpuVideoFrameProviderEvidence | null;
  hybrid: GpuStreamingFrameProducerEvidence["hybrid"];
  typography: GpuStreamingFrameProducerEvidence["typography"];
  runtimeLifecycle: GpuStreamingFrameProducerEvidence["runtimeLifecycle"];
  readback: GpuStreamingFrameProducerEvidence["readback"];
  sessionResources: GpuStreamingFrameProducerEvidence["sessionResources"];
  effectModules?: GpuStreamingFrameProducerEvidence["effectModules"];
  behaviors?: GpuStreamingFrameProducerEvidence["behaviors"];
  processMonitoring: GpuStreamingFrameProducerEvidence["processMonitoring"];
  session: GpuStreamingFrameProducerEvidence["session"];
};

export function mutableGpuStreamingMetrics(frameCount: number): MutableGpuStreamingMetrics {
  return {
    delivery: "streamed-raw-rgba",
    ordering: "canonical-index-timestamp",
    frameCount,
    emittedFrames: 0,
    activeFrameHandoffs: 0,
    peakConcurrentFrameHandoffs: 0,
    activeRgbaBuffers: 0,
    peakRgbaBuffers: 0,
    retainedFrameCount: 0,
    sessionFrameCacheEntries: 0
  };
}

export function emptyGpuStreamingEvidence(inputHashes: Readonly<Record<string, string>>): MutableGpuStreamingEvidence {
  return {
    schema: "shellx-motion/gpu-streaming-producer@1",
    inputHashes,
    immutableImageResources: [],
    frameSequenceSha256: null,
    framePlanSequenceSha256: null,
    provenance: { pipelineCatalog: null, staticPlan: null, staticScene: null, resourceBudget: null },
    gpu: null,
    browserVersion: null,
    video: null,
    hybrid: null,
    typography: { authority: "manifest-font-face-browser-shaped", shaping: "canvas-2d", fallbackPolicy: "manifest-bound-required", fontProbe: "font-face-load-and-font-set-check", fontAssets: [] },
    runtimeLifecycle: { browserSession: "single-per-render", device: "persistent-per-render", pipelines: "fixed-reused" },
    readback: null,
    sessionResources: null,
    processMonitoring: {
      mode: "precontained-direct-chromium",
      chromiumRootPid: "unavailable",
      watchedRoot: "not_registered",
      rssScope: "unavailable",
      measurement: "not_started",
      watchRegistered: false,
      containment: null,
      encoderContainmentCoversChromium: false,
      reasonCode: "final_launch_context_unavailable"
    },
    session: { state: "idle", cleanup: "not_started" }
  };
}

export function resetGpuStreamingMetrics(metrics: MutableGpuStreamingMetrics): void {
  metrics.emittedFrames = 0;
  metrics.activeFrameHandoffs = 0;
  metrics.peakConcurrentFrameHandoffs = 0;
  metrics.activeRgbaBuffers = 0;
  metrics.peakRgbaBuffers = 0;
}
