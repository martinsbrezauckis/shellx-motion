import {
  MAX_PARTICLE_EMITTER_ORIGINS,
  MAX_PARTICLE_FIELD_SOURCES,
  MAX_PARTICLE_FIELD_V2_SOURCES,
  PARTICLE_FIELD_MAX_SOFTENING,
  PARTICLE_FIELD_MAX_STRENGTH,
  PARTICLE_FIELD_MIN_SOFTENING,
  PARTICLE_FIELD_MIN_STRENGTH,
  PARTICLE_FIELD_SCHEMA,
  PARTICLE_FIELD_V2_SCHEMA
} from "./particle-field-types";

type Scalar = string | number | boolean;
export type ParticleFieldRichEdit = { pointer: string; oldValue: Scalar; newValue: Scalar };

/** Closed scalar controls for existing v1 and additive v2 field payloads. */
export function editParticleFieldRichControl(emitterValue: unknown, layerType: unknown, path: string, rawValue: unknown): ParticleFieldRichEdit | null {
  const source = /^emitter\.field\.sources\.([0-9]+)\.([A-Za-z]+)$/.exec(path);
  const origin = /^emitter\.origins\.([0-9]+)\.(x|y|weight|directionOffsetDeg|speedScale)$/.exec(path);
  const trail = /^emitter\.trail\.(durationMs|samples|opacity)$/.exec(path);
  const shading = /^emitter\.shading\.(mode|sizeJitter|opacityJitter|glow)$/.exec(path);
  if (!source && !origin && !trail && !shading) return null;
  const emitter = requiredRecord(emitterValue, "particle emitter", layerType, "particles");
  const field = requiredRecord(emitter.field, "particle field", layerType, "particles");
  if (field.schema !== PARTICLE_FIELD_SCHEMA && field.schema !== PARTICLE_FIELD_V2_SCHEMA) throw new Error(`Particle field requires schema ${PARTICLE_FIELD_SCHEMA} or ${PARTICLE_FIELD_V2_SCHEMA}.`);
  if (source) return editSource(field, Number(source[1]), source[2], rawValue, path);
  if (field.schema !== PARTICLE_FIELD_V2_SCHEMA) return null;
  if (origin) return editOrigin(emitter, Number(origin[1]), origin[2], rawValue, path);
  if (trail) return editNumber(requiredRecord(emitter.trail, "particle analytic trail", layerType, "particles"), trail[1], rawValue, path, trail[1] === "durationMs" ? [1, 1_000] : trail[1] === "samples" ? [2, 4, true] : [0.05, 1]);
  if (shading) return editShading(requiredRecord(emitter.shading, "particle shading", layerType, "particles"), shading[1], rawValue, path);
  return null;
}

function editSource(field: Record<string, unknown>, sourceIndex: number, property: string, rawValue: unknown, path: string): ParticleFieldRichEdit {
  const maximum = field.schema === PARTICLE_FIELD_V2_SCHEMA ? MAX_PARTICLE_FIELD_V2_SOURCES : MAX_PARTICLE_FIELD_SOURCES, sources = field.sources;
  if (!Array.isArray(sources) || sourceIndex >= sources.length || sourceIndex >= maximum) throw new Error(`Particle field source index must name an existing source in 0..${maximum - 1}.`);
  const source = requiredRecord(sources[sourceIndex], "particle field source", "particles", "particles"), allowed = sourceRules(field.schema, source.kind, property);
  if (!allowed) throw new Error(`Unsupported rich control path: ${path}`);
  if (source.kind === "impact" && (property === "startProgress" || property === "durationProgress")) {
    const next = boundedNumber(rawValue, allowed[0], allowed[1], path, allowed[2]);
    const other = property === "startProgress" ? source.durationProgress : source.startProgress;
    if (typeof other !== "number" || !Number.isFinite(other) || next + other > 1) throw new Error(`${path} must keep impact startProgress + durationProgress within 1.`);
  }
  return editNumber(source, property, rawValue, path, allowed);
}

function editOrigin(emitter: Record<string, unknown>, originIndex: number, property: string, rawValue: unknown, path: string): ParticleFieldRichEdit {
  const origins = emitter.origins;
  if (!Array.isArray(origins) || originIndex >= origins.length || originIndex >= MAX_PARTICLE_EMITTER_ORIGINS) throw new Error(`Particle origin index must name an existing origin in 0..${MAX_PARTICLE_EMITTER_ORIGINS - 1}.`);
  const rule = property === "x" || property === "y" ? [0, 1] as const : property === "weight" ? [0.01, 1] as const : property === "directionOffsetDeg" ? [-360, 360] as const : [0.25, 4] as const;
  return editNumber(requiredRecord(origins[originIndex], "particle origin", "particles", "particles"), property, rawValue, path, rule);
}

function editShading(shading: Record<string, unknown>, property: string, rawValue: unknown, path: string): ParticleFieldRichEdit {
  if (property === "mode") {
    if (rawValue !== "flat" && rawValue !== "soft" && rawValue !== "glow") throw new Error(`${path} must be flat, soft, or glow.`);
    const oldValue = shading.mode; if (typeof oldValue !== "string") throw new Error("emitter/shading/mode is not declared."); shading.mode = rawValue;
    return { pointer: "emitter/shading/mode", oldValue, newValue: rawValue };
  }
  return editNumber(shading, property, rawValue, path, [0, 1]);
}

function sourceRules(schema: unknown, kind: unknown, property: string): readonly [number, number, boolean?] | null {
  if (schema === PARTICLE_FIELD_SCHEMA) {
    if (kind !== "radial" && kind !== "vortex") return null;
    return ["centerX", "centerY"].includes(property) ? [0, 1] : property === "strength" ? [PARTICLE_FIELD_MIN_STRENGTH, PARTICLE_FIELD_MAX_STRENGTH] : property === "softening" ? [PARTICLE_FIELD_MIN_SOFTENING, PARTICLE_FIELD_MAX_SOFTENING] : null;
  }
  if (kind === "radial" || kind === "vortex") return ["centerX", "centerY"].includes(property) ? [0, 1] : property === "strength" ? [PARTICLE_FIELD_MIN_STRENGTH, PARTICLE_FIELD_MAX_STRENGTH] : property === "softening" ? [PARTICLE_FIELD_MIN_SOFTENING, PARTICLE_FIELD_MAX_SOFTENING] : null;
  if (kind === "flow") return property === "angleDeg" ? [-360, 360] : property === "strength" ? [-1, 1] : null;
  if (kind === "turbulence") return property === "scale" ? [0.01, 4] : property === "strength" ? [-1, 1] : null;
  if (kind === "impact") return ["centerX", "centerY", "startProgress"].includes(property) ? [0, 1] : property === "radius" || property === "durationProgress" ? [0.01, 1] : property === "strength" ? [-1, 1] : null;
  if (kind === "collision") return property === "position" || property === "restitution" ? [0, 1] : null;
  return null;
}

function editNumber(record: Record<string, unknown>, property: string, rawValue: unknown, path: string, rule: readonly [number, number, boolean?]): ParticleFieldRichEdit {
  const value = boundedNumber(rawValue, rule[0], rule[1], path, rule[2]), oldValue = record[property];
  if (typeof oldValue !== "number" || !Number.isFinite(oldValue)) throw new Error(`emitter/${property} is not declared.`);
  record[property] = value;
  return { pointer: path.replaceAll(".", "/"), oldValue, newValue: value };
}

function requiredRecord(value: unknown, label: string, type: unknown, expectedType: string): Record<string, unknown> { if (type !== expectedType || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not available on this layer.`); return value as Record<string, unknown>; }
function boundedNumber(value: unknown, min: number, max: number, label: string, integer = false): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label} must be between ${min} and ${max}${integer ? " as an integer" : ""}.`); return value; }
