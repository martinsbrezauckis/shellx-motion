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
  PARTICLE_FIELD_V2_SCHEMA
} from "./particle-field-types";

export interface ParticleFieldValidationError {
  path: string;
  message: string;
}

/** Fail-closed semantic validation for v1 and additive v2 data-only particle fields. */
export function validateParticleField(value: unknown, path: string, errors: ParticleFieldValidationError[]): void {
  const field = record(value);
  if (!field) return void errors.push({ path, message: "must be an object" });
  const isV1 = field.schema === PARTICLE_FIELD_SCHEMA;
  const isV2 = field.schema === PARTICLE_FIELD_V2_SCHEMA;
  if (!isV1 && !isV2) {
    errors.push({ path: `${path}/schema`, message: `must be ${PARTICLE_FIELD_SCHEMA} or ${PARTICLE_FIELD_V2_SCHEMA}` });
  }
  const maximum = isV2 ? MAX_PARTICLE_FIELD_V2_SOURCES : MAX_PARTICLE_FIELD_SOURCES;
  if (!Array.isArray(field.sources) || field.sources.length < 1 || field.sources.length > maximum) {
    errors.push({ path: `${path}/sources`, message: `must contain between 1 and ${maximum} sources` });
  } else {
    field.sources.forEach((sourceValue, index) => isV2
      ? validateV2Source(sourceValue, `${path}/sources/${index}`, errors)
      : validateV1Source(sourceValue, `${path}/sources/${index}`, errors));
  }
  for (const key of Object.keys(field)) {
    if (key !== "schema" && key !== "sources") errors.push({ path: `${path}/${key}`, message: "is not supported on particle fields" });
  }
}

/** Validates fields attached to an emitter only when it has selected particle-field@2. */
export function validateParticleEmitterV2Extensions(emitter: Record<string, unknown>, path: string, errors: ParticleFieldValidationError[]): void {
  const field = record(emitter.field);
  const isV2 = field?.schema === PARTICLE_FIELD_V2_SCHEMA;
  const extensions = ["origins", "trail", "shading"] as const;
  for (const name of extensions) {
    if (name in emitter && !isV2) errors.push({ path: `${path}/${name}`, message: `requires ${PARTICLE_FIELD_V2_SCHEMA}` });
  }
  if (!isV2) return;
  if (!Number.isInteger(emitter.count) || (emitter.count as number) < 100_000 || (emitter.count as number) > 131_072 || emitter.shape !== "circle") {
    errors.push({ path: `${path}/field`, message: `${PARTICLE_FIELD_V2_SCHEMA} requires the fixed 100000..131072 circular high-density route; low-count lanes must not silently ignore v2 trail or shading.` });
  }
  if ("origins" in emitter) validateOrigins(emitter.origins, `${path}/origins`, errors);
  if ("trail" in emitter) validateAnalyticTrail(emitter.trail, `${path}/trail`, errors);
  if ("shading" in emitter) validateShading(emitter.shading, `${path}/shading`, errors);
}

function validateV1Source(value: unknown, path: string, errors: ParticleFieldValidationError[]): void {
  const source = record(value);
  if (!source) return void errors.push({ path, message: "must be an object" });
  if (source.kind !== "radial" && source.kind !== "vortex") errors.push({ path: `${path}/kind`, message: "must be radial or vortex" });
  validateRadialSource(source, path, errors);
}

function validateV2Source(value: unknown, path: string, errors: ParticleFieldValidationError[]): void {
  const source = record(value);
  if (!source) return void errors.push({ path, message: "must be an object" });
  switch (source.kind) {
    case "radial": case "vortex":
      validateRadialSource(source, path, errors);
      return;
    case "flow":
      bounded(source.angleDeg, -360, 360, `${path}/angleDeg`, errors);
      bounded(source.strength, PARTICLE_FIELD_MIN_STRENGTH, PARTICLE_FIELD_MAX_STRENGTH, `${path}/strength`, errors);
      rejectUnknown(source, ["kind", "angleDeg", "strength"], path, errors);
      return;
    case "turbulence":
      bounded(source.scale, PARTICLE_FIELD_MIN_SOFTENING, PARTICLE_FIELD_V2_MAX_TURBULENCE_SCALE, `${path}/scale`, errors);
      bounded(source.strength, PARTICLE_FIELD_MIN_STRENGTH, PARTICLE_FIELD_MAX_STRENGTH, `${path}/strength`, errors);
      rejectUnknown(source, ["kind", "scale", "strength"], path, errors);
      return;
    case "impact":
      bounded(source.centerX, 0, 1, `${path}/centerX`, errors);
      bounded(source.centerY, 0, 1, `${path}/centerY`, errors);
      bounded(source.radius, PARTICLE_FIELD_MIN_SOFTENING, 1, `${path}/radius`, errors);
      bounded(source.strength, PARTICLE_FIELD_MIN_STRENGTH, PARTICLE_FIELD_MAX_STRENGTH, `${path}/strength`, errors);
      bounded(source.startProgress, 0, 1, `${path}/startProgress`, errors);
      bounded(source.durationProgress, PARTICLE_FIELD_MIN_SOFTENING, 1, `${path}/durationProgress`, errors);
      if (finite(source.startProgress) && finite(source.durationProgress) && source.startProgress + source.durationProgress > 1) {
        errors.push({ path: `${path}/durationProgress`, message: "must end within lifetime progress 0..1" });
      }
      rejectUnknown(source, ["kind", "centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"], path, errors);
      return;
    case "collision":
      if (source.axis !== "x" && source.axis !== "y") errors.push({ path: `${path}/axis`, message: "must be x or y" });
      bounded(source.position, 0, 1, `${path}/position`, errors);
      bounded(source.restitution, 0, 1, `${path}/restitution`, errors);
      rejectUnknown(source, ["kind", "axis", "position", "restitution"], path, errors);
      return;
    default:
      errors.push({ path: `${path}/kind`, message: "must be radial, vortex, flow, turbulence, impact, or collision" });
      return;
  }
}

function validateRadialSource(source: Record<string, unknown>, path: string, errors: ParticleFieldValidationError[]): void {
  bounded(source.centerX, 0, 1, `${path}/centerX`, errors);
  bounded(source.centerY, 0, 1, `${path}/centerY`, errors);
  bounded(source.strength, PARTICLE_FIELD_MIN_STRENGTH, PARTICLE_FIELD_MAX_STRENGTH, `${path}/strength`, errors);
  bounded(source.softening, PARTICLE_FIELD_MIN_SOFTENING, PARTICLE_FIELD_MAX_SOFTENING, `${path}/softening`, errors);
  rejectUnknown(source, ["kind", "centerX", "centerY", "strength", "softening"], path, errors);
}

function validateOrigins(value: unknown, path: string, errors: ParticleFieldValidationError[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTICLE_EMITTER_ORIGINS) {
    errors.push({ path, message: `must contain between 1 and ${MAX_PARTICLE_EMITTER_ORIGINS} origins` });
    return;
  }
  value.forEach((candidate, index) => {
    const origin = record(candidate), originPath = `${path}/${index}`;
    if (!origin) return void errors.push({ path: originPath, message: "must be an object" });
    bounded(origin.x, 0, 1, `${originPath}/x`, errors);
    bounded(origin.y, 0, 1, `${originPath}/y`, errors);
    bounded(origin.weight, PARTICLE_FIELD_V2_MIN_ORIGIN_WEIGHT, PARTICLE_FIELD_V2_MAX_ORIGIN_WEIGHT, `${originPath}/weight`, errors);
    if ("directionOffsetDeg" in origin) bounded(origin.directionOffsetDeg, -360, 360, `${originPath}/directionOffsetDeg`, errors);
    if ("speedScale" in origin) bounded(origin.speedScale, PARTICLE_FIELD_V2_MIN_SPEED_SCALE, PARTICLE_FIELD_V2_MAX_SPEED_SCALE, `${originPath}/speedScale`, errors);
    rejectUnknown(origin, ["x", "y", "weight", "directionOffsetDeg", "speedScale"], originPath, errors);
  });
}

function validateAnalyticTrail(value: unknown, path: string, errors: ParticleFieldValidationError[]): void {
  const trail = record(value);
  if (!trail) return void errors.push({ path, message: "must be an object" });
  bounded(trail.durationMs, 1, 1_000, `${path}/durationMs`, errors);
  const samples = trail.samples;
  if (!Number.isInteger(samples) || typeof samples !== "number" || samples < 2 || samples > 4) errors.push({ path: `${path}/samples`, message: "must be an integer between 2 and 4" });
  if ("opacity" in trail) bounded(trail.opacity, 0.05, 1, `${path}/opacity`, errors);
  rejectUnknown(trail, ["durationMs", "samples", "opacity"], path, errors);
}

function validateShading(value: unknown, path: string, errors: ParticleFieldValidationError[]): void {
  const shading = record(value);
  if (!shading) return void errors.push({ path, message: "must be an object" });
  if (shading.mode !== "flat" && shading.mode !== "soft" && shading.mode !== "glow") errors.push({ path: `${path}/mode`, message: "must be flat, soft, or glow" });
  for (const key of ["sizeJitter", "opacityJitter", "glow"] as const) if (key in shading) bounded(shading[key], 0, 1, `${path}/${key}`, errors);
  rejectUnknown(shading, ["mode", "sizeJitter", "opacityJitter", "glow"], path, errors);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: ParticleFieldValidationError[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ path: `${path}/${key}`, message: "is not supported on particle field sources" });
}

function bounded(value: unknown, min: number, max: number, path: string, errors: ParticleFieldValidationError[]): void {
  if (!finite(value) || value < min || value > max) errors.push({ path, message: `must be a finite number between ${min} and ${max}` });
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}
