import { describe, expect, it } from "vitest";
import type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import { attestGpuSessionResources, gpuSessionDynamicImageMetricsProblem, isGpuSessionResources } from "./gpu-streaming-producer-session-resources";

describe("GPU session resource evidence", () => {
  it("accepts internally consistent live arena evidence, including prior high-water usage", () => {
    expect(isGpuSessionResources(metrics({
      frameTextureHighWaterSlots: 2,
      frameTextureHighWaterBytes: 8,
      frameArenaHighWaterBytes: 16,
      dynamicBufferHighWaterSlots: 2,
      dynamicBufferHighWaterBytes: 8
    }), 3)).toBe(true);
  });

  it("refuses forged frame-arena and pool counters that cannot describe a live session", () => {
    expect(isGpuSessionResources(metrics({ frameArenaBytes: 0, frameArenaHighWaterBytes: 0 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ frameArenaBytes: 7 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ frameTextureSlots: 0 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ frameTextureHighWaterSlots: 0 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ dynamicBufferSlots: 0 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ dynamicBufferHighWaterBytes: 0 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ frameArenaReconfigurations: 0, frameTextureSlots: 0, frameTextureBytes: 0, readbackBytes: 0, frameArenaBytes: 0 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ frameArenaReservations: 2 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ frameArenaLateAllocationRefusals: 1 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ environmentDrawsRendered: 4 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ environmentDrawsRendered: 4, environmentUniformCapacitySlots: 32, environmentUniformBytes: 8_192, environmentUniformHighWaterSlots: 32, environmentUniformHighWaterBytes: 8_192 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ environmentDrawsRendered: 4, environmentEnvelopeReservations: 1, environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216, environmentUniformLateAllocationRefusals: 1 }), 3)).toBe(false);
    expect(isGpuSessionResources(metrics({ environmentDrawsRendered: 4, environmentEnvelopeReservations: 0, environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216 }), 3)).toBe(false);
  });

  it("binds admitted environment work to the frozen 36-slot reservation", () => {
    expect(isGpuSessionResources(metrics({ environmentDrawsRendered: 12, environmentEnvelopeReservations: 1, environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216 }), 3)).toBe(true);
    expect(isGpuSessionResources(metrics({ environmentDrawsRendered: 0, environmentEnvelopeReservations: 1, environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216 }), 3)).toBe(true);
    expect(isGpuSessionResources(metrics({ environmentDrawsRendered: 97, environmentEnvelopeReservations: 1, environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216 }), 3)).toBe(false);
  });

  it("distinguishes no compute from fixed v1 and v2 two-buffer analytic routes", () => {
    expect(isGpuSessionResources(metrics(), 3)).toBe(true);
    expect(isGpuSessionResources(metrics({ adapterComputeParticleInstanceLimit: 131_072 }), 3)).toBe(true);
    expect(isGpuSessionResources(v1Metrics(), 3)).toBe(true);
    expect(isGpuSessionResources(v2Metrics(), 3)).toBe(true);
  });

  it("binds a complete fixed dynamic-texture reservation without weakening the plain snapshot", async () => {
    const dynamic = metrics({
      dynamicImageTextureSlots: 1,
      dynamicImageTextureBytes: 5_760_000,
      dynamicImageTextureHighWaterSlots: 1,
      dynamicImageTextureHighWaterBytes: 5_760_000,
      dynamicImageTextureWrites: 3,
      dynamicImageTextureReplacements: 3,
      dynamicImageTextureLateRefusals: 0,
      dynamicImageTextureDestructions: 0
    });
    expect(isGpuSessionResources(dynamic, 3)).toBe(true);
    const attested = await attestGpuSessionResources({ resourceMetrics: async () => dynamic } as never, 3);
    expect(attested).toMatchObject({ ok: true, metrics: { dynamicImageTextureSlots: 1, dynamicImageTextureBytes: 5_760_000, dynamicImageTextureWrites: 3 } });
    expect(isGpuSessionResources({ ...dynamic, dynamicImageTextureReplacements: 2 }, 3)).toBe(false);
    expect(isGpuSessionResources({ ...dynamic, dynamicImageTextureLateRefusals: 1 }, 3)).toBe(false);
    expect(isGpuSessionResources({ ...dynamic, dynamicImageTextureDestructions: 1 }, 3)).toBe(false);
    const { dynamicImageTextureWrites: _missing, ...incomplete } = dynamic;
    expect(isGpuSessionResources(incomplete, 3)).toBe(false);
    expect(gpuSessionDynamicImageMetricsProblem(dynamic, { slots: 1, bytes: 5_760_000, writes: 3 })).toBeNull();
    expect(gpuSessionDynamicImageMetricsProblem(dynamic, { slots: 1, bytes: 5_760_000, writes: 2 })).toContain("capture range");
    expect(gpuSessionDynamicImageMetricsProblem(metrics(), null)).toBeNull();
    expect(gpuSessionDynamicImageMetricsProblem(dynamic, null)).toContain("unclaimed");
  });

  it("admits only the complete live afterimage branch and preserves the no-module snapshot", async () => {
    const live = metrics({
      afterimageStackUniformBufferSlots: 1,
      afterimageStackUniformBytes: 160,
      afterimageStackBindGroupSlots: 1,
      afterimageStackPasses: 2,
      afterimageStackFrames: 2,
      afterimageStackLateAllocationRefusals: 0,
      afterimageStackPersistentTextureCount: 0
    });
    expect(isGpuSessionResources(metrics(), 3)).toBe(true);
    expect(isGpuSessionResources(live, 3)).toBe(true);
    const attested = await attestGpuSessionResources({ resourceMetrics: async () => live } as never, 3);
    expect(attested).toMatchObject({ ok: true, metrics: { afterimageStackUniformBufferSlots: 1, afterimageStackUniformBytes: 160, afterimageStackBindGroupSlots: 1, afterimageStackPasses: 2, afterimageStackFrames: 2 } });
    expect(isGpuSessionResources({ ...live, afterimageStackUniformBytes: 159 }, 3)).toBe(false);
    expect(isGpuSessionResources({ ...live, afterimageStackLateAllocationRefusals: 1 }, 3)).toBe(false);
    expect(isGpuSessionResources({ ...live, afterimageStackPipelineReleases: 1 }, 3)).toBe(false);
    const { afterimageStackFrames: _missing, ...incomplete } = live;
    expect(isGpuSessionResources(incomplete, 3)).toBe(false);
  });

  it("refuses incomplete, growing, impossible, or mislabeled compute evidence", () => {
    expect(isGpuSessionResources(metrics({ pointComputeField: "fixed-analytic-v1" }), 3)).toBe(false);
    expect(isGpuSessionResources(v1Metrics({ computeParticleUniformBytes: 432 }), 3)).toBe(false);
    expect(isGpuSessionResources(v1Metrics({ computeParticleRasterCalls: 4 }), 3)).toBe(false);
    expect(isGpuSessionResources(v2Metrics({ computeParticleBufferSlots: 3, computeParticleBufferHighWaterSlots: 3 }), 3)).toBe(false);
    expect(isGpuSessionResources(v2Metrics({ adapterComputeParticleInstanceLimit: 99_999 }), 3)).toBe(false);
    expect(isGpuSessionResources(v2Metrics({ computeParticleAbi: "shellx-motion/gpu-compute-particle-field@1" }), 3)).toBe(false);
    expect(isGpuSessionResources(v2Metrics({ computeParticleHeadRasterCalls: 2 }), 3)).toBe(false);
    expect(isGpuSessionResources(v2Metrics({ computeParticleTrailRasterCalls: 1, computeParticleRasterCalls: 4 }), 3)).toBe(false);
    expect(isGpuSessionResources(v2Metrics({ computeParticleCapacityReconfigurations: 1, computeParticleLateAllocationRefusals: 1 }), 3)).toBe(false);
  });

  it("freezes every required v2 ABI receipt field rather than dropping it at producer handoff", async () => {
    const result = await attestGpuSessionResources({ resourceMetrics: async () => v2Metrics() } as never, 3);
    expect(result).toMatchObject({ ok: true, metrics: { computeParticleAbi: "shellx-motion/gpu-compute-particle-field@2", computeParticleInstanceBytes: 64, computeParticleRetainedBufferCount: 2, computeParticleUniformBytes: 432, computeParticleRasterCalls: 6, computeParticleHeadRasterCalls: 3, computeParticleTrailRasterCalls: 3, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0 } });
    if (result.ok) expect(Object.isFrozen(result.metrics)).toBe(true);
  });
});

function metrics(overrides: Partial<GpuPageSessionResourceMetrics> = {}): GpuPageSessionResourceMetrics {
  return { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 3, frameArenaReconfigurations: 1, frameTextureSlots: 1, frameTextureBytes: 4, depthTextureBytes: 0, readbackBytes: 4, frameArenaBytes: 8, frameTextureHighWaterSlots: 1, frameTextureHighWaterBytes: 4, frameArenaHighWaterBytes: 8, frameArenaReservations: 3, frameArenaLateAllocationRefusals: 0, dynamicBufferSlots: 1, dynamicBufferBytes: 4, dynamicBufferHighWaterSlots: 1, dynamicBufferHighWaterBytes: 4, environmentUniformCapacitySlots: 0, environmentUniformBytes: 0, environmentUniformHighWaterSlots: 0, environmentUniformHighWaterBytes: 0, environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: 0, environmentEnvelopeReservations: 0, immutableImageTextures: 0, retainedTextSurfaces: 0, pointRaster: "gpu-native-instanced", pointPositionEvaluation: "core-cpu-exact-time", pointComputeField: "not-used", immutablePointBufferSlots: 0, immutablePointBufferBytes: 0, immutablePointMirrorBytes: 0, immutablePointBufferHighWaterSlots: 0, immutablePointBufferHighWaterBytes: 0, adapterPointInstanceLimit: 0, computeParticleBufferSlots: 0, computeParticleBufferBytes: 0, computeParticleBufferHighWaterSlots: 0, computeParticleBufferHighWaterBytes: 0, adapterComputeParticleInstanceLimit: 0, computeParticleDispatches: 0, computeParticleAbi: "not-used", computeParticleInstanceBytes: 0, computeParticleRetainedBufferCount: 0, computeParticleUniformBytes: 0, computeParticleRasterCalls: 0, computeParticleHeadRasterCalls: 0, computeParticleTrailRasterCalls: 0, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0, ...overrides };
}
function v1Metrics(overrides: Partial<GpuPageSessionResourceMetrics> = {}): GpuPageSessionResourceMetrics { return metrics({ pointPositionEvaluation: "gpu-fixed-analytic-time", pointComputeField: "fixed-analytic-v1", computeParticleBufferSlots: 2, computeParticleBufferBytes: 6_400_000, computeParticleBufferHighWaterSlots: 2, computeParticleBufferHighWaterBytes: 6_400_000, adapterComputeParticleInstanceLimit: 131_072, computeParticleDispatches: 3, computeParticleAbi: "shellx-motion/gpu-compute-particle-field@1", computeParticleInstanceBytes: 32, computeParticleRetainedBufferCount: 2, computeParticleUniformBytes: 240, computeParticleRasterCalls: 3, computeParticleHeadRasterCalls: 3, ...overrides }); }
function v2Metrics(overrides: Partial<GpuPageSessionResourceMetrics> = {}): GpuPageSessionResourceMetrics { return metrics({ pointPositionEvaluation: "gpu-fixed-analytic-time", pointComputeField: "fixed-analytic-v2", computeParticleBufferSlots: 2, computeParticleBufferBytes: 12_800_000, computeParticleBufferHighWaterSlots: 2, computeParticleBufferHighWaterBytes: 12_800_000, adapterComputeParticleInstanceLimit: 131_072, computeParticleDispatches: 3, computeParticleAbi: "shellx-motion/gpu-compute-particle-field@2", computeParticleInstanceBytes: 64, computeParticleRetainedBufferCount: 2, computeParticleUniformBytes: 432, computeParticleRasterCalls: 6, computeParticleHeadRasterCalls: 3, computeParticleTrailRasterCalls: 3, ...overrides }); }
