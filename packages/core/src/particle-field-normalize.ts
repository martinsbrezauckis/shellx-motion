import {
  MAX_PARTICLE_EMITTER_ORIGINS,
  MAX_PARTICLE_FIELD_SOURCES,
  MAX_PARTICLE_FIELD_V2_SOURCES,
  PARTICLE_FIELD_MAX_SOFTENING,
  PARTICLE_FIELD_MAX_STRENGTH,
  PARTICLE_FIELD_MIN_SOFTENING,
  PARTICLE_FIELD_MIN_STRENGTH,
  PARTICLE_FIELD_SCHEMA,
  PARTICLE_FIELD_V2_MAX_ORIGIN_WEIGHT,
  PARTICLE_FIELD_V2_MAX_SPEED_SCALE,
  PARTICLE_FIELD_V2_MAX_TURBULENCE_SCALE,
  PARTICLE_FIELD_V2_MIN_ORIGIN_WEIGHT,
  PARTICLE_FIELD_V2_MIN_SPEED_SCALE,
  PARTICLE_FIELD_V2_SCHEMA,
  type MotionParticleAnalyticTrail,
  type MotionParticleEmitterOrigin,
  type MotionParticleFieldSource,
  type MotionParticleFieldV2Source,
  type MotionParticleShading
} from "./particle-field-types";

export interface NormalizedParticleField {
  schema: typeof PARTICLE_FIELD_SCHEMA | typeof PARTICLE_FIELD_V2_SCHEMA | null;
  sources: readonly (MotionParticleFieldSource | MotionParticleFieldV2Source)[];
}

/** Direct consumers use this too, so malformed values cannot bypass package validation. */
export function normalizeParticleField(value: unknown): NormalizedParticleField {
  if (value === undefined) return { schema: null, sources: [] };
  const field = object(value, "Particle field");
  rejectKeys(field, ["schema", "sources"], "Particle field");
  if (field.schema === PARTICLE_FIELD_SCHEMA) return {
    schema: PARTICLE_FIELD_SCHEMA,
    sources: boundedSources(field.sources, MAX_PARTICLE_FIELD_SOURCES).map((source, index) => v1Source(source, index))
  };
  if (field.schema === PARTICLE_FIELD_V2_SCHEMA) return {
    schema: PARTICLE_FIELD_V2_SCHEMA,
    sources: boundedSources(field.sources, MAX_PARTICLE_FIELD_V2_SOURCES).map((source, index) => v2Source(source, index))
  };
  throw new Error(`Particle field requires schema ${PARTICLE_FIELD_SCHEMA} or ${PARTICLE_FIELD_V2_SCHEMA}.`);
}

export function normalizeParticleOrigins(value: unknown, schema: NormalizedParticleField["schema"]): readonly MotionParticleEmitterOrigin[] {
  if (value === undefined) return [];
  requireV2(schema, "Particle origins");
  return boundedArray(value, 1, MAX_PARTICLE_EMITTER_ORIGINS, "Particle origins").map((candidate, index) => {
    const origin = object(candidate, `Particle origin ${index}`);
    rejectKeys(origin, ["x", "y", "weight", "directionOffsetDeg", "speedScale"], `Particle origin ${index}`);
    return {
      x: bounded(origin.x, 0, 1, `Particle origin ${index} x`), y: bounded(origin.y, 0, 1, `Particle origin ${index} y`),
      weight: bounded(origin.weight, PARTICLE_FIELD_V2_MIN_ORIGIN_WEIGHT, PARTICLE_FIELD_V2_MAX_ORIGIN_WEIGHT, `Particle origin ${index} weight`),
      ...(origin.directionOffsetDeg === undefined ? {} : { directionOffsetDeg: bounded(origin.directionOffsetDeg, -360, 360, `Particle origin ${index} directionOffsetDeg`) }),
      ...(origin.speedScale === undefined ? {} : { speedScale: bounded(origin.speedScale, PARTICLE_FIELD_V2_MIN_SPEED_SCALE, PARTICLE_FIELD_V2_MAX_SPEED_SCALE, `Particle origin ${index} speedScale`) })
    };
  });
}

export function normalizeParticleTrail(value: unknown, schema: NormalizedParticleField["schema"]): MotionParticleAnalyticTrail | null {
  if (value === undefined) return null;
  requireV2(schema, "Particle analytic trail");
  const trail = object(value, "Particle analytic trail");
  rejectKeys(trail, ["durationMs", "samples", "opacity"], "Particle analytic trail");
  const samples = bounded(trail.samples, 2, 4, "Particle analytic trail samples");
  if (!Number.isInteger(samples)) throw new Error("Particle analytic trail samples must be an integer in 2..4.");
  return { durationMs: bounded(trail.durationMs, 1, 1_000, "Particle analytic trail durationMs"), samples, ...(trail.opacity === undefined ? {} : { opacity: bounded(trail.opacity, 0.05, 1, "Particle analytic trail opacity") }) };
}

export function normalizeParticleShading(value: unknown, schema: NormalizedParticleField["schema"]): MotionParticleShading | null {
  if (value === undefined) return null;
  requireV2(schema, "Particle shading");
  const shading = object(value, "Particle shading");
  rejectKeys(shading, ["mode", "sizeJitter", "opacityJitter", "glow"], "Particle shading");
  if (shading.mode !== "flat" && shading.mode !== "soft" && shading.mode !== "glow") throw new Error("Particle shading mode must be flat, soft, or glow.");
  return { mode: shading.mode, ...(shading.sizeJitter === undefined ? {} : { sizeJitter: bounded(shading.sizeJitter, 0, 1, "Particle shading sizeJitter") }), ...(shading.opacityJitter === undefined ? {} : { opacityJitter: bounded(shading.opacityJitter, 0, 1, "Particle shading opacityJitter") }), ...(shading.glow === undefined ? {} : { glow: bounded(shading.glow, 0, 1, "Particle shading glow") }) };
}

function v1Source(value: unknown, index: number): MotionParticleFieldSource {
  const source = object(value, `Particle field source ${index}`);
  rejectKeys(source, ["kind", "centerX", "centerY", "strength", "softening"], `Particle field source ${index}`);
  if (source.kind !== "radial" && source.kind !== "vortex") throw new Error(`Particle field source ${index} must be radial or vortex.`);
  return radialSource(source, index);
}

function v2Source(value: unknown, index: number): MotionParticleFieldV2Source {
  const source = object(value, `Particle field source ${index}`), prefix = `Particle field source ${index}`;
  if (source.kind === "radial" || source.kind === "vortex") { rejectKeys(source, ["kind", "centerX", "centerY", "strength", "softening"], prefix); return radialSource(source, index); }
  if (source.kind === "flow") { rejectKeys(source, ["kind", "angleDeg", "strength"], prefix); return { kind: "flow", angleDeg: bounded(source.angleDeg, -360, 360, `${prefix} angleDeg`), strength: bounded(source.strength, -1, 1, `${prefix} strength`) }; }
  if (source.kind === "turbulence") { rejectKeys(source, ["kind", "scale", "strength"], prefix); return { kind: "turbulence", scale: bounded(source.scale, PARTICLE_FIELD_MIN_SOFTENING, PARTICLE_FIELD_V2_MAX_TURBULENCE_SCALE, `${prefix} scale`), strength: bounded(source.strength, -1, 1, `${prefix} strength`) }; }
  if (source.kind === "impact") {
    rejectKeys(source, ["kind", "centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"], prefix);
    const startProgress = bounded(source.startProgress, 0, 1, `${prefix} startProgress`), durationProgress = bounded(source.durationProgress, PARTICLE_FIELD_MIN_SOFTENING, 1, `${prefix} durationProgress`);
    if (startProgress + durationProgress > 1) throw new Error(`${prefix} impact must end within lifetime progress 0..1.`);
    return { kind: "impact", centerX: bounded(source.centerX, 0, 1, `${prefix} centerX`), centerY: bounded(source.centerY, 0, 1, `${prefix} centerY`), radius: bounded(source.radius, PARTICLE_FIELD_MIN_SOFTENING, 1, `${prefix} radius`), strength: bounded(source.strength, -1, 1, `${prefix} strength`), startProgress, durationProgress };
  }
  if (source.kind === "collision") { rejectKeys(source, ["kind", "axis", "position", "restitution"], prefix); if (source.axis !== "x" && source.axis !== "y") throw new Error(`${prefix} collision axis must be x or y.`); return { kind: "collision", axis: source.axis, position: bounded(source.position, 0, 1, `${prefix} position`), restitution: bounded(source.restitution, 0, 1, `${prefix} restitution`) }; }
  throw new Error(`${prefix} must be radial, vortex, flow, turbulence, impact, or collision.`);
}

function radialSource(source: Record<string, unknown>, index: number): MotionParticleFieldSource {
  const prefix = `Particle field source ${index}`;
  return { kind: source.kind as "radial" | "vortex", centerX: bounded(source.centerX, 0, 1, `${prefix} centerX`), centerY: bounded(source.centerY, 0, 1, `${prefix} centerY`), strength: bounded(source.strength, PARTICLE_FIELD_MIN_STRENGTH, PARTICLE_FIELD_MAX_STRENGTH, `${prefix} strength`), softening: bounded(source.softening, PARTICLE_FIELD_MIN_SOFTENING, PARTICLE_FIELD_MAX_SOFTENING, `${prefix} softening`) };
}

function requireV2(schema: NormalizedParticleField["schema"], label: string): void { if (schema !== PARTICLE_FIELD_V2_SCHEMA) throw new Error(`${label} requires ${PARTICLE_FIELD_V2_SCHEMA}.`); }
function boundedSources(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new Error(`Particle field must contain between 1 and ${maximum} sources.`); return value; }
function boundedArray(value: unknown, minimum: number, maximum: number, label: string): unknown[] { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain between ${minimum} and ${maximum} entries.`); return value; }
function bounded(value: unknown, minimum: number, maximum: number, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}.`); return value; }
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error(`${label} must be a plain data object.`); return value as Record<string, unknown>; }
function rejectKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} does not support ${key}.`); }
