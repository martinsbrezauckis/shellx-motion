import {
  MAX_PARTICLE_EMITTER_ORIGINS,
  MAX_PARTICLE_FIELD_SOURCES,
  MAX_PARTICLE_FIELD_V2_SOURCES,
  PARTICLE_FIELD_SCHEMA,
  PARTICLE_FIELD_V2_SCHEMA,
  type MotionParticleField,
  type MotionParticleFieldSource,
  type MotionParticleFieldV2Source
} from "./particle-field-types";
import { normalizeParticleField, normalizeParticleOrigins, normalizeParticleShading, normalizeParticleTrail } from "./particle-field-normalize";
import type { MotionParticleEmitter } from "./types";

/** Fixed Motion-owned compute ABIs. Package data never selects WGSL, a kernel, or a workgroup size. */
export const GPU_COMPUTE_PARTICLE_FIELD_SCHEMA = "shellx-motion/gpu-compute-particle-field@1" as const;
export const GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA = "shellx-motion/gpu-compute-particle-field@2" as const;
export const GPU_COMPUTE_PARTICLE_MIN_COUNT = 100_000;
export const GPU_COMPUTE_PARTICLE_MAX_COUNT = 131_072;
export const GPU_COMPUTE_PARTICLE_WORKGROUP_SIZE = 256;
/** v1 remains exactly two retained 32-byte instance buffers (8 MiB maximum). */
export const GPU_COMPUTE_PARTICLE_INSTANCE_BYTES = 32;
export const GPU_COMPUTE_PARTICLE_PING_PONG_BUFFER_COUNT = 2;
export const GPU_COMPUTE_PARTICLE_MAX_INSTANCE_MEMORY_BYTES = GPU_COMPUTE_PARTICLE_MAX_COUNT * GPU_COMPUTE_PARTICLE_INSTANCE_BYTES * GPU_COMPUTE_PARTICLE_PING_PONG_BUFFER_COUNT;
/** v2 packs analytic trail samples/head shading into two retained 64-byte buffers (16 MiB maximum). */
export const GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES = 64;
export const GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT = 2;
export const GPU_COMPUTE_PARTICLE_V2_MAX_INSTANCE_MEMORY_BYTES = GPU_COMPUTE_PARTICLE_MAX_COUNT * GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES * GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT;
/** One fixed compute dispatch resolves all v2 particle state for an exact frame. */
export const GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT = 1;
/** The owned shader uses one head raster pass, plus one optional analytic-trail pass. */
export const GPU_COMPUTE_PARTICLE_V2_MIN_RASTER_PASS_COUNT = 1;
export const GPU_COMPUTE_PARTICLE_V2_MAX_RASTER_PASS_COUNT = 2;

export interface GpuComputeParticleFieldSource { kind: "radial" | "vortex"; centerX: number; centerY: number; strength: number; softening: number; }
export interface GpuComputeParticleV2Origin { x: number; y: number; weight: number; directionOffsetDeg: number; speedScale: number; }
export interface GpuComputeParticleV2Trail { durationMs: number; samples: number; opacity: number; }
export interface GpuComputeParticleV2Shading { mode: "flat" | "soft" | "glow"; sizeJitter: number; opacityJitter: number; glow: number; }

/** Shared scalar portion of the closed fixed descriptor. */
export interface GpuComputeParticleFieldDescriptor {
  schema: typeof GPU_COMPUTE_PARTICLE_FIELD_SCHEMA;
  seed: number; count: number; atMs: number; startMs: number; lifetimeMs: number; width: number; height: number;
  x: number; y: number; scale: number; originX: number; originY: number; rotationDeg: number; opacity: number;
  color: { r: number; g: number; b: number; a: number }; secondaryColor: { r: number; g: number; b: number; a: number };
  minSize: number; maxSize: number; minSpeed: number; maxSpeed: number; direction: number; spread: number; gravity: number; fadeOut: boolean;
  sources: readonly GpuComputeParticleFieldSource[];
}

/** Fixed v2 ABI: source/origin variants are all data and memory/pass facts are explicit. */
export interface GpuComputeParticleFieldV2Descriptor extends Omit<GpuComputeParticleFieldDescriptor, "schema" | "sources"> {
  schema: typeof GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA;
  sources: readonly MotionParticleFieldV2Source[];
  origins: readonly GpuComputeParticleV2Origin[];
  trail: GpuComputeParticleV2Trail | null;
  shading: GpuComputeParticleV2Shading;
  computeDispatchCount: typeof GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT;
  rasterPassCount: typeof GPU_COMPUTE_PARTICLE_V2_MIN_RASTER_PASS_COUNT | typeof GPU_COMPUTE_PARTICLE_V2_MAX_RASTER_PASS_COUNT;
  instanceBytes: typeof GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES;
  retainedBufferCount: typeof GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT;
  retainedInstanceBytes: number;
}

export type GpuComputeParticleAbi = "v1" | "v2";

/** True only for high-density fixed forms; lower counts remain the exact Core evaluator route. */
export function isGpuComputeParticleEmitter(emitter: MotionParticleEmitter | undefined): emitter is MotionParticleEmitter & { field: MotionParticleField } {
  return gpuComputeParticleEmitterAbi(emitter) !== null;
}

export function gpuComputeParticleEmitterAbi(emitter: MotionParticleEmitter | undefined): GpuComputeParticleAbi | null {
  if (!emitter || !Number.isInteger(emitter.count) || emitter.count < GPU_COMPUTE_PARTICLE_MIN_COUNT || emitter.count > GPU_COMPUTE_PARTICLE_MAX_COUNT || emitter.shape !== "circle") return null;
  try {
    const field = normalizeParticleField(emitter.field);
    if (field.schema === PARTICLE_FIELD_SCHEMA && field.sources.length >= 1 && field.sources.length <= MAX_PARTICLE_FIELD_SOURCES) return "v1";
    if (field.schema === PARTICLE_FIELD_V2_SCHEMA && field.sources.length >= 1 && field.sources.length <= MAX_PARTICLE_FIELD_V2_SOURCES) {
      normalizeParticleOrigins(emitter.origins, field.schema); normalizeParticleTrail(emitter.trail, field.schema); normalizeParticleShading(emitter.shading, field.schema);
      return "v2";
    }
  } catch { /* malformed direct data has no compute route */ }
  return null;
}

export function gpuComputeParticleEmitterProblem(emitter: MotionParticleEmitter | undefined): string | null {
  if (!emitter || !Number.isInteger(emitter.count) || emitter.count < GPU_COMPUTE_PARTICLE_MIN_COUNT || emitter.count > GPU_COMPUTE_PARTICLE_MAX_COUNT) return `GPU compute particle fields require an integer count in ${GPU_COMPUTE_PARTICLE_MIN_COUNT}..${GPU_COMPUTE_PARTICLE_MAX_COUNT}.`;
  if (emitter.shape !== "circle") return "GPU compute particle fields require an explicit circular particle head.";
  if (!gpuComputeParticleEmitterAbi(emitter)) return `GPU compute particle fields require ${PARTICLE_FIELD_SCHEMA} (1..${MAX_PARTICLE_FIELD_SOURCES} radial/vortex sources) or ${PARTICLE_FIELD_V2_SCHEMA} (1..${MAX_PARTICLE_FIELD_V2_SOURCES} fixed sources).`;
  return null;
}

/** v1 compatibility predicate retained for existing v1 consumers. */
export function isGpuComputeParticleField(value: unknown): value is Extract<MotionParticleField, { schema: typeof PARTICLE_FIELD_SCHEMA }> {
  try { const field = normalizeParticleField(value); return field.schema === PARTICLE_FIELD_SCHEMA && field.sources.every((source): source is MotionParticleFieldSource => source.kind === "radial" || source.kind === "vortex"); } catch { return false; }
}
export function isGpuComputeParticleFieldV2(value: unknown): value is Extract<MotionParticleField, { schema: typeof PARTICLE_FIELD_V2_SCHEMA }> {
  try { return normalizeParticleField(value).schema === PARTICLE_FIELD_V2_SCHEMA; } catch { return false; }
}
