import type { GpuCompositeIntent, GpuRgba } from "./gpu-frame-intent-types";
import type { GpuComputeParticleFieldV2Descriptor } from "./gpu-particle-compute";

/** Data-only input for the fixed Motion-owned analytic particle field pipeline. */
export interface GpuComputeParticleFieldIntent extends GpuCompositeIntent {
  kind: "particleCompute";
  schema: "shellx-motion/gpu-compute-particle-field@1";
  id: string;
  seed: number;
  count: number;
  atMs: number;
  startMs: number;
  lifetimeMs: number;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  originX: number;
  originY: number;
  rotationDeg: number;
  opacity: number;
  color: GpuRgba;
  secondaryColor: GpuRgba;
  minSize: number;
  maxSize: number;
  minSpeed: number;
  maxSpeed: number;
  direction: number;
  spread: number;
  gravity: number;
  fadeOut: boolean;
  sources: Array<{ kind: "radial" | "vortex"; centerX: number; centerY: number; strength: number; softening: number }>;
}

/** Additive v2 ABI. Renderers must opt in explicitly; v1 remains unchanged. */
export interface GpuComputeParticleFieldV2Intent extends GpuCompositeIntent, GpuComputeParticleFieldV2Descriptor {
  kind: "particleCompute";
  id: string;
}

export type GpuComputeParticleIntent = GpuComputeParticleFieldIntent | GpuComputeParticleFieldV2Intent;
