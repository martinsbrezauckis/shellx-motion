import type { GpuPageComputeParticleMetrics } from "./gpu-page-particle-compute";
import type { GpuPageComputeParticleV2Metrics } from "./gpu-page-particle-compute-v2";
import type { GpuPageInstanceBufferMetrics } from "./gpu-page-instance-buffers";

export interface GpuPageSessionResourceMetrics {
  readonly schema: "shellx-motion/gpu-page-session-resources@1";
  readonly framesRendered: number;
  readonly frameArenaReconfigurations: number;
  readonly frameTextureSlots: number;
  readonly frameTextureBytes: number;
  readonly depthTextureBytes?: number;
  readonly readbackBytes?: number;
  readonly frameArenaBytes?: number;
  readonly frameTextureHighWaterSlots: number;
  readonly frameTextureHighWaterBytes: number;
  readonly frameArenaHighWaterBytes?: number;
  readonly frameArenaReservations: number;
  readonly frameArenaLateAllocationRefusals: number;
  readonly dynamicBufferSlots: number;
  readonly dynamicBufferBytes: number;
  readonly dynamicBufferHighWaterSlots: number;
  readonly dynamicBufferHighWaterBytes: number;
  readonly environmentUniformCapacitySlots: number;
  readonly environmentUniformBytes: number;
  readonly environmentUniformHighWaterSlots: number;
  readonly environmentUniformHighWaterBytes: number;
  readonly environmentUniformLateAllocationRefusals: number;
  readonly environmentDrawsRendered: number;
  readonly environmentEnvelopeReservations: number;
  /** Omitted until a fixed C2 intrinsic reserves its one retained slot. */
  readonly afterimageStackUniformBufferSlots?: 0 | 1;
  readonly afterimageStackUniformBytes?: 0 | 160;
  readonly afterimageStackBindGroupSlots?: 0 | 1;
  readonly afterimageStackPasses?: number;
  readonly afterimageStackFrames?: number;
  readonly afterimageStackLateAllocationRefusals?: number;
  readonly afterimageStackPersistentTextureCount?: 0;
  /** Terminal-only exact cleanup evidence; omitted for sessions that never installed the intrinsic. */
  readonly afterimageStackPipelineReleases?: 0 | 1;
  readonly afterimageStackPreparedBindGroupReleases?: number;
  readonly afterimageStackArenaUniformBufferDestructions?: 0 | 1;
  readonly immutableImageTextures: number;
  /** Preview-only exact-frame texture reservations. These slots never grow while scrubbing. */
  readonly dynamicImageTextureSlots?: number;
  readonly dynamicImageTextureBytes?: number;
  readonly dynamicImageTextureHighWaterSlots?: number;
  readonly dynamicImageTextureHighWaterBytes?: number;
  readonly dynamicImageTextureWrites?: number;
  readonly dynamicImageTextureReplacements?: number;
  readonly dynamicImageTextureLateRefusals?: number;
  readonly dynamicImageTextureDestructions?: number;
  readonly retainedTextSurfaces: number;
  readonly pointRaster: "gpu-native-instanced";
  readonly pointPositionEvaluation: "core-cpu-exact-time" | "gpu-fixed-analytic-time" | "mixed-core-cpu-and-gpu-fixed-analytic-time";
  readonly pointComputeField: "not-used" | "fixed-analytic-v1" | "fixed-analytic-v2";
  readonly immutablePointBufferSlots: number;
  readonly immutablePointBufferBytes: number;
  readonly immutablePointMirrorBytes: number;
  readonly immutablePointBufferHighWaterSlots: number;
  readonly immutablePointBufferHighWaterBytes: number;
  readonly adapterPointInstanceLimit: number;
  readonly computeParticleBufferSlots: number;
  readonly computeParticleBufferBytes: number;
  readonly computeParticleBufferHighWaterSlots: number;
  readonly computeParticleBufferHighWaterBytes: number;
  readonly adapterComputeParticleInstanceLimit: number;
  readonly computeParticleDispatches: number;
  readonly computeParticleAbi: "not-used" | "shellx-motion/gpu-compute-particle-field@1" | "shellx-motion/gpu-compute-particle-field@2";
  readonly computeParticleInstanceBytes: number;
  readonly computeParticleRetainedBufferCount: number;
  readonly computeParticleUniformBytes: number;
  readonly computeParticleRasterCalls: number;
  readonly computeParticleHeadRasterCalls: number;
  readonly computeParticleTrailRasterCalls: number;
  readonly computeParticleCapacityReconfigurations: number;
  readonly computeParticleLateAllocationRefusals: number;
}

export interface GpuPageMutableResourceMetrics {
  framesRendered: number; frameArenaReconfigurations: number; frameTextureSlots: number; frameTextureBytes: number;
  depthTextureBytes: number; readbackBytes: number; frameArenaBytes: number; frameTextureHighWaterSlots: number;
  frameTextureHighWaterBytes: number; frameArenaHighWaterBytes: number; dynamicBufferSlots: number; dynamicBufferBytes: number;
  dynamicBufferHighWaterSlots: number; dynamicBufferHighWaterBytes: number; frameArenaReservations: number; frameArenaLateAllocationRefusals: number;
  environmentUniformCapacitySlots: number; environmentUniformBytes: number; environmentUniformHighWaterSlots: number; environmentUniformHighWaterBytes: number; environmentUniformLateAllocationRefusals: number; environmentDrawsRendered: number; environmentEnvelopeReservations: number;
}

/** Reads deterministic allocation high-water counts without retaining page state. */
export async function readWebGpuPageSessionResourceMetrics(): Promise<GpuPageSessionResourceMetrics | null> {
  const browserGlobal = globalThis as unknown as {
    __shellxMotionGpuSessionV1?: {
      images?: Map<string, unknown>;
      textSurfaces?: Map<string, unknown>;
      dynamicImages?: { metrics: { reservedSlots: number; reservedBytes: number; highWaterSlots: number; highWaterBytes: number; writes: number; replacements: number; lateRefusals: number; destructions: number } };
      resources?: { snapshot(images: number, textSurfaces: number): GpuPageSessionResourceMetrics };
      instanceBuffers?: { snapshot(): GpuPageInstanceBufferMetrics };
      computeParticles?: { snapshot(): GpuPageComputeParticleMetrics };
      computeParticlesV2?: { snapshot(): GpuPageComputeParticleV2Metrics };
    };
  };
  const state = browserGlobal.__shellxMotionGpuSessionV1;
  if (!state?.resources) return null;
  const dynamic = state.dynamicImages?.metrics;
  const immutableImageTextures = (state.images?.size ?? 0) - (dynamic?.reservedSlots ?? 0);
  if (!Number.isSafeInteger(immutableImageTextures) || immutableImageTextures < 0) return null;
  const resourceMetrics = state.resources.snapshot(immutableImageTextures, state.textSurfaces?.size ?? 0);
  const pointInstances = state.instanceBuffers?.snapshot();
  const v1Compute = state.computeParticles?.snapshot();
  const v2Compute = state.computeParticlesV2?.snapshot();
  const v2Dispatched = (v2Compute?.computeParticleDispatches ?? 0) > 0;
  const compute = v2Dispatched ? v2Compute : v1Compute;
  const pointPositionEvaluation = compute?.computeParticleDispatches
    ? pointInstances?.immutablePointBufferSlots
      ? "mixed-core-cpu-and-gpu-fixed-analytic-time" as const
      : "gpu-fixed-analytic-time" as const
    : pointInstances?.positionEvaluation ?? "core-cpu-exact-time" as const;
  return Object.freeze({
    ...resourceMetrics,
    ...(dynamic ? {
      dynamicImageTextureSlots: dynamic.reservedSlots,
      dynamicImageTextureBytes: dynamic.reservedBytes,
      dynamicImageTextureHighWaterSlots: dynamic.highWaterSlots,
      dynamicImageTextureHighWaterBytes: dynamic.highWaterBytes,
      dynamicImageTextureWrites: dynamic.writes,
      dynamicImageTextureReplacements: dynamic.replacements,
      dynamicImageTextureLateRefusals: dynamic.lateRefusals,
      dynamicImageTextureDestructions: dynamic.destructions
    } : {}),
    pointRaster: pointInstances?.pointRaster ?? "gpu-native-instanced",
    pointPositionEvaluation,
    pointComputeField: compute?.computeField ?? pointInstances?.computeField ?? "not-used",
    immutablePointBufferSlots: pointInstances?.immutablePointBufferSlots ?? 0,
    immutablePointBufferBytes: pointInstances?.immutablePointBufferBytes ?? 0,
    immutablePointMirrorBytes: pointInstances?.immutablePointMirrorBytes ?? 0,
    immutablePointBufferHighWaterSlots: pointInstances?.immutablePointBufferHighWaterSlots ?? 0,
    immutablePointBufferHighWaterBytes: pointInstances?.immutablePointBufferHighWaterBytes ?? 0,
    adapterPointInstanceLimit: pointInstances?.adapterPointInstanceLimit ?? 0,
    computeParticleBufferSlots: compute?.computeParticleBufferSlots ?? 0,
    computeParticleBufferBytes: compute?.computeParticleBufferBytes ?? 0,
    computeParticleBufferHighWaterSlots: compute?.computeParticleBufferHighWaterSlots ?? 0,
    computeParticleBufferHighWaterBytes: compute?.computeParticleBufferHighWaterBytes ?? 0,
    adapterComputeParticleInstanceLimit: compute?.adapterComputeParticleInstanceLimit ?? 0,
    computeParticleDispatches: compute?.computeParticleDispatches ?? 0,
    computeParticleAbi: v2Dispatched ? v2Compute!.abi : compute?.computeParticleDispatches ? "shellx-motion/gpu-compute-particle-field@1" : "not-used",
    computeParticleInstanceBytes: v2Dispatched ? v2Compute!.instanceBytes : compute?.computeParticleDispatches ? 32 : 0,
    computeParticleRetainedBufferCount: v2Dispatched ? v2Compute!.retainedBufferCount : compute?.computeParticleDispatches ? 2 : 0,
    computeParticleUniformBytes: v2Dispatched ? v2Compute!.uniformBytes : compute?.computeParticleDispatches ? 240 : 0,
    computeParticleRasterCalls: v2Dispatched ? v2Compute!.rasterCalls : compute?.computeParticleDispatches ?? 0,
    computeParticleHeadRasterCalls: v2Dispatched ? v2Compute!.headRasterCalls : compute?.computeParticleDispatches ?? 0,
    computeParticleTrailRasterCalls: v2Dispatched ? v2Compute!.trailRasterCalls : 0,
    computeParticleCapacityReconfigurations: v2Dispatched ? v2Compute!.capacityReconfigurations : 0,
    computeParticleLateAllocationRefusals: v2Dispatched ? v2Compute!.lateAllocationRefusals : 0
  });
}
