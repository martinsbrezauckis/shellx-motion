import { canonicalJson } from "./canonical-json";
import {
  MAX_PARTICLE_EMITTER_ORIGINS,
  MAX_PARTICLE_FIELD_SOURCES,
  MAX_PARTICLE_FIELD_V2_SOURCES,
  PARTICLE_FIELD_SCHEMA,
  PARTICLE_FIELD_V2_SCHEMA,
} from "./particle-field-types";
import { validateParticleEmitter } from "./validate";
import type {
  MotionDocument,
  MotionLayer,
  MotionParticleEmitter,
} from "./types";
import type {
  MotionParticleAnalyticTrail,
  MotionParticleEmitterOrigin,
  MotionParticleField,
  MotionParticleFieldSource,
  MotionParticleFieldV2Source,
  MotionParticleShading,
} from "./particle-field-types";

export interface ParticleStructuralState {
  layerIndex: number;
  layer: MotionLayer;
  emitter: MotionParticleEmitter;
  field: MotionParticleField | null;
}

export function assertExactInput(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const record = plainDataRecord(value, label);
  assertExactKeys(record, allowed, label);
  return record;
}

/**
 * Precondition: callers supply a typed document that has passed document-level validation.
 * This leaf separately guards its COW boundary against hostile data and validates the full emitter.
 */
export function readParticleStructuralState(motion: MotionDocument, layerIdValue: unknown, requireEditable: boolean): ParticleStructuralState {
  assertPlainDataTree(motion, "Motion document");
  const layerId = nonEmptyString(layerIdValue, "Particle layerId");
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = motion.layers[layerIndex];
  if (layer.type !== "particles") throw new Error(`Motion layer ${layerId} is not a particles layer.`);
  if (requireEditable && layer.locked) throw new Error(`Cannot edit locked layer: ${layerId}.`);
  const lockedTrack = requireEditable
    ? (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id)))
    : undefined;
  if (lockedTrack) throw new Error(`Cannot edit particle structure on locked track: ${lockedTrack.id}.`);
  const emitter = cloneEmitter(layer.emitter, layerId);
  assertFinalParticleEmitter(emitter, layerId);
  return { layerIndex, layer, emitter, field: emitter.field ?? null };
}

export function requireField(state: ParticleStructuralState): MotionParticleField {
  if (!state.field) throw new Error(`Particles layer ${state.layer.id} has no particle field.`);
  return state.field;
}

export function requireV2Field(state: ParticleStructuralState): Extract<MotionParticleField, { schema: typeof PARTICLE_FIELD_V2_SCHEMA }> {
  const field = requireField(state);
  if (field.schema !== PARTICLE_FIELD_V2_SCHEMA) throw new Error(`Particles layer ${state.layer.id} requires ${PARTICLE_FIELD_V2_SCHEMA}.`);
  return field;
}

export function sourceLimit(field: MotionParticleField): number {
  return field.schema === PARTICLE_FIELD_V2_SCHEMA ? MAX_PARTICLE_FIELD_V2_SOURCES : MAX_PARTICLE_FIELD_SOURCES;
}

export function assertIndex(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  }
}

export function moveArrayEntry<T>(entries: T[], fromIndex: number, toIndex: number): void {
  const [entry] = entries.splice(fromIndex, 1);
  entries.splice(toIndex, 0, entry);
}

/** Structural parsing creates complete closed records; scalar property edits remain rich-control-owned. */
export function exactParticleSource(value: unknown, schema: MotionParticleField["schema"]): MotionParticleFieldSource | MotionParticleFieldV2Source {
  const source = plainDataRecord(value, "Particle field source");
  if (typeof source.kind !== "string") throw new Error("Particle field source kind must be a string.");
  if (schema === PARTICLE_FIELD_SCHEMA) {
    if (source.kind !== "radial" && source.kind !== "vortex") throw new Error(`Particle field ${PARTICLE_FIELD_SCHEMA} permits radial or vortex sources only.`);
    assertExactKeys(source, ["kind", "centerX", "centerY", "strength", "softening"], "Particle field source");
    return { kind: source.kind, centerX: source.centerX as number, centerY: source.centerY as number, strength: source.strength as number, softening: source.softening as number };
  }
  switch (source.kind) {
    case "radial": case "vortex":
      assertExactKeys(source, ["kind", "centerX", "centerY", "strength", "softening"], "Particle field source");
      return { kind: source.kind, centerX: source.centerX as number, centerY: source.centerY as number, strength: source.strength as number, softening: source.softening as number };
    case "flow":
      assertExactKeys(source, ["kind", "angleDeg", "strength"], "Particle field source");
      return { kind: "flow", angleDeg: source.angleDeg as number, strength: source.strength as number };
    case "turbulence":
      assertExactKeys(source, ["kind", "scale", "strength"], "Particle field source");
      return { kind: "turbulence", scale: source.scale as number, strength: source.strength as number };
    case "impact":
      assertExactKeys(source, ["kind", "centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"], "Particle field source");
      return { kind: "impact", centerX: source.centerX as number, centerY: source.centerY as number, radius: source.radius as number, strength: source.strength as number, startProgress: source.startProgress as number, durationProgress: source.durationProgress as number };
    case "collision":
      assertExactKeys(source, ["kind", "axis", "position", "restitution"], "Particle field source");
      return { kind: "collision", axis: source.axis as "x" | "y", position: source.position as number, restitution: source.restitution as number };
    default:
      throw new Error(`Particle field ${PARTICLE_FIELD_V2_SCHEMA} does not support source kind ${source.kind}.`);
  }
}

export function exactParticleOrigin(value: unknown): MotionParticleEmitterOrigin {
  const origin = plainDataRecord(value, "Particle origin");
  assertExactKeys(origin, ["x", "y", "weight", "directionOffsetDeg", "speedScale"], "Particle origin", ["directionOffsetDeg", "speedScale"]);
  return {
    x: origin.x as number,
    y: origin.y as number,
    weight: origin.weight as number,
    ...(Object.hasOwn(origin, "directionOffsetDeg") ? { directionOffsetDeg: origin.directionOffsetDeg as number } : {}),
    ...(Object.hasOwn(origin, "speedScale") ? { speedScale: origin.speedScale as number } : {}),
  };
}

export function exactAnalyticTrail(value: unknown): MotionParticleAnalyticTrail {
  const trail = plainDataRecord(value, "Particle analytic trail");
  assertExactKeys(trail, ["durationMs", "samples", "opacity"], "Particle analytic trail", ["opacity"]);
  return {
    durationMs: trail.durationMs as number,
    samples: trail.samples as number,
    ...(Object.hasOwn(trail, "opacity") ? { opacity: trail.opacity as number } : {}),
  };
}

export function exactParticleShading(value: unknown): MotionParticleShading {
  const shading = plainDataRecord(value, "Particle shading");
  assertExactKeys(shading, ["mode", "sizeJitter", "opacityJitter", "glow"], "Particle shading", ["sizeJitter", "opacityJitter", "glow"]);
  return {
    mode: shading.mode as MotionParticleShading["mode"],
    ...(Object.hasOwn(shading, "sizeJitter") ? { sizeJitter: shading.sizeJitter as number } : {}),
    ...(Object.hasOwn(shading, "opacityJitter") ? { opacityJitter: shading.opacityJitter as number } : {}),
    ...(Object.hasOwn(shading, "glow") ? { glow: shading.glow as number } : {}),
  };
}

/** The renderer-owned particle validation stays the final authority for every commit. */
export function assertFinalParticleEmitter(emitterValue: unknown, layerId: string): asserts emitterValue is MotionParticleEmitter {
  const emitter = plainDataRecord(emitterValue, `Particles layer ${layerId} emitter`);
  const errors: Array<{ path: string; message: string }> = [];
  validateParticleEmitter({ type: "particles", emitter }, `/layers/${layerId}`, errors);
  if (errors.length > 0) throw new Error(`Particle structural mutation is invalid: ${errors[0]!.path} ${errors[0]!.message}.`);
}

export function sameData(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function commitParticleEmitter(
  motion: MotionDocument,
  state: ParticleStructuralState,
  emitter: MotionParticleEmitter,
): { motion: MotionDocument; layer: MotionLayer } {
  assertPlainDataTree(motion, "Motion document");
  const layer: MotionLayer = { ...structuredClone(state.layer), emitter: structuredClone(emitter) };
  assertFinalParticleEmitter(layer.emitter, state.layer.id);
  return {
    motion: { ...motion, layers: motion.layers.map((candidate, index) => index === state.layerIndex ? layer : structuredClone(candidate)) },
    layer,
  };
}

export function cloneEmitter(value: unknown, layerId: string): MotionParticleEmitter {
  const emitter = plainDataRecord(value, `Particles layer ${layerId} emitter`);
  return structuredClone(emitter) as unknown as MotionParticleEmitter;
}

export function originLimit(): number { return MAX_PARTICLE_EMITTER_ORIGINS; }

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  assertPlainDataTree(value, label);
  return value as Record<string, unknown>;
}

/** Refuses nested accessors before any COW `structuredClone` can execute an input getter. */
function assertPlainDataTree(value: unknown, label: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${label} must not contain cycles.`);
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error(`${label} has unsupported array property ${String(key)}.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw new Error(`${label}[${key}] must be a data property.`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error(`${label}[${index}] must be present.`);
      assertPlainDataTree(value[index], `${label}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain data object.`);
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object.`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable) throw new Error(`${label} must contain enumerable data properties only.`);
    if (!("value" in descriptor)) throw new Error(`${label} must contain data properties only.`);
    assertPlainDataTree(descriptor.value, `${label}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} does not support ${key}.`);
  for (const key of allowed) if (!optional.includes(key) && !Object.hasOwn(value, key)) throw new Error(`${label} requires ${key}.`);
}
