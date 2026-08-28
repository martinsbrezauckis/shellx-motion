/**
 * Bounded data contracts for seeded particle fields. They describe fixed
 * Motion-owned mechanics; they never select code, kernels, clocks, or storage.
 */
export const PARTICLE_FIELD_SCHEMA = "shellx-motion/particle-field@1" as const;
export const PARTICLE_FIELD_V2_SCHEMA = "shellx-motion/particle-field@2" as const;
export const MAX_PARTICLE_FIELD_SOURCES = 3;
export const MAX_PARTICLE_FIELD_V2_SOURCES = 4;
export const MAX_PARTICLE_EMITTER_ORIGINS = 4;
export const PARTICLE_FIELD_MIN_STRENGTH = -1;
export const PARTICLE_FIELD_MAX_STRENGTH = 1;
export const PARTICLE_FIELD_MIN_SOFTENING = 0.01;
export const PARTICLE_FIELD_MAX_SOFTENING = 1;
export const PARTICLE_FIELD_V2_MAX_TURBULENCE_SCALE = 4;
export const PARTICLE_FIELD_V2_MIN_ORIGIN_WEIGHT = 0.01;
export const PARTICLE_FIELD_V2_MAX_ORIGIN_WEIGHT = 1;
export const PARTICLE_FIELD_V2_MIN_SPEED_SCALE = 0.25;
export const PARTICLE_FIELD_V2_MAX_SPEED_SCALE = 4;

/** A source pulls toward its centre or applies the corresponding tangential turn. */
export interface MotionParticleFieldSource {
  kind: "radial" | "vortex";
  /** Normalized horizontal centre within the particle layer, in 0..1. */
  centerX: number;
  /** Normalized vertical centre within the particle layer, in 0..1. */
  centerY: number;
  /** Signed normalized source strength. Negative values reverse the declared direction. */
  strength: number;
  /** Normalized radial falloff scale. It prevents singular visual deflection at a source centre. */
  softening: number;
}

export interface MotionParticleFlowSource {
  kind: "flow";
  /** Fixed screen-space direction, in degrees. */
  angleDeg: number;
  strength: number;
}

export interface MotionParticleTurbulenceSource {
  kind: "turbulence";
  /** Fixed procedural-domain scale; the seed remains emitter-owned. */
  scale: number;
  strength: number;
}

/** A finite-lifetime outward pulse on canonical layer progress `(atMs - layerStartMs) / lifetimeMs`, never randomized particle age. */
export interface MotionParticleImpactSource {
  kind: "impact";
  centerX: number;
  centerY: number;
  radius: number;
  strength: number;
  startProgress: number;
  durationProgress: number;
}

/**
 * One axis-aligned reflecting plane. This is deliberately not general mesh,
 * particle-particle, or continuous collision detection.
 */
export interface MotionParticleCollisionSource {
  kind: "collision";
  axis: "x" | "y";
  position: number;
  restitution: number;
}

export type MotionParticleFieldV2Source =
  | MotionParticleFieldSource
  | MotionParticleFlowSource
  | MotionParticleTurbulenceSource
  | MotionParticleImpactSource
  | MotionParticleCollisionSource;

export interface MotionParticleFieldV1 {
  schema: typeof PARTICLE_FIELD_SCHEMA;
  /** Ordered, bounded source data. Sources are evaluated independently and summed once. */
  sources: MotionParticleFieldSource[];
}

export interface MotionParticleFieldV2 {
  schema: typeof PARTICLE_FIELD_V2_SCHEMA;
  /** Ordered fixed mechanics evaluated from exact document/lifetime time. */
  sources: MotionParticleFieldV2Source[];
}

/** v1 remains byte/semantic compatible; v2 is an additive closed contract. */
export type MotionParticleField = MotionParticleFieldV1 | MotionParticleFieldV2;

/** One weighted spawn origin within the layer; no per-origin callback or state exists. */
export interface MotionParticleEmitterOrigin {
  x: number;
  y: number;
  weight: number;
  directionOffsetDeg?: number;
  speedScale?: number;
}

/** Analytic shader lookback only; it never allocates a particle-history buffer. */
export interface MotionParticleAnalyticTrail {
  durationMs: number;
  samples: number;
  opacity?: number;
}

/** Fixed head appearance controls for the owned particle shader. */
export interface MotionParticleShading {
  mode: "flat" | "soft" | "glow";
  sizeJitter?: number;
  opacityJitter?: number;
  glow?: number;
}
