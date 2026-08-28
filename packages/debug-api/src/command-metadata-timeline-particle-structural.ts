/** Closed argument contracts for complete bounded particle structure records, not scalar rich controls. */
import {
  MAX_PARTICLE_EMITTER_ORIGINS,
  MAX_PARTICLE_FIELD_SOURCES,
  MAX_PARTICLE_FIELD_V2_SOURCES,
  PARTICLE_FIELD_MAX_SOFTENING,
  PARTICLE_FIELD_MAX_STRENGTH,
  PARTICLE_FIELD_MIN_SOFTENING,
  PARTICLE_FIELD_MIN_STRENGTH,
  PARTICLE_FIELD_V2_MAX_ORIGIN_WEIGHT,
  PARTICLE_FIELD_V2_MAX_SPEED_SCALE,
  PARTICLE_FIELD_V2_MAX_TURBULENCE_SCALE,
  PARTICLE_FIELD_V2_MIN_ORIGIN_WEIGHT,
  PARTICLE_FIELD_V2_MIN_SPEED_SCALE,
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema } from "./command-registry.js";
import { argsSchema, editReceipt, LAYER_ID, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir", "layerId"];
const INDEX = { type: "number" as const, minimum: 0, maximum: MAX_PARTICLE_FIELD_V2_SOURCES, description: "Zero-based bounded record index; Core checks the current list length." };
const UNIT = { type: "number" as const, minimum: 0, maximum: 1, description: "Finite normalized value." };
const STRENGTH = { type: "number" as const, minimum: PARTICLE_FIELD_MIN_STRENGTH, maximum: PARTICLE_FIELD_MAX_STRENGTH, description: "Finite signed analytic strength." };

const SOURCE: MotionDebugArgPropertySchema = {
  type: "object",
  oneOf: [
    record(["kind", "centerX", "centerY", "strength", "softening"], { kind: { type: "string", enum: ["radial", "vortex"], description: "Radial or tangential source kind." }, centerX: UNIT, centerY: UNIT, strength: STRENGTH, softening: { type: "number", minimum: PARTICLE_FIELD_MIN_SOFTENING, maximum: PARTICLE_FIELD_MAX_SOFTENING, description: "Positive normalized falloff scale." } }),
    record(["kind", "angleDeg", "strength"], { kind: { type: "string", enum: ["flow"], description: "Fixed flow source kind." }, angleDeg: { type: "number", minimum: -360, maximum: 360, description: "Finite fixed flow direction in degrees." }, strength: STRENGTH }),
    record(["kind", "scale", "strength"], { kind: { type: "string", enum: ["turbulence"], description: "Fixed turbulence source kind." }, scale: { type: "number", minimum: PARTICLE_FIELD_MIN_SOFTENING, maximum: PARTICLE_FIELD_V2_MAX_TURBULENCE_SCALE, description: "Finite procedural-domain scale." }, strength: STRENGTH }),
    record(["kind", "centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"], { kind: { type: "string", enum: ["impact"], description: "Finite-lifetime impact source kind." }, centerX: UNIT, centerY: UNIT, radius: { type: "number", minimum: PARTICLE_FIELD_MIN_SOFTENING, maximum: 1, description: "Positive normalized impact radius." }, strength: STRENGTH, startProgress: UNIT, durationProgress: { type: "number", minimum: PARTICLE_FIELD_MIN_SOFTENING, maximum: 1, description: "Positive normalized impact duration." } }),
    record(["kind", "axis", "position", "restitution"], { kind: { type: "string", enum: ["collision"], description: "Axis-plane collision source kind." }, axis: { type: "string", enum: ["x", "y"], description: "Closed collision plane axis." }, position: UNIT, restitution: UNIT }),
  ],
  description: `Complete exact source record. v1 admits radial/vortex only and at most ${MAX_PARTICLE_FIELD_SOURCES}; v2 admits all listed kinds and at most ${MAX_PARTICLE_FIELD_V2_SOURCES}.`,
};
const ORIGIN: MotionDebugArgPropertySchema = record(["x", "y", "weight"], {
  x: UNIT, y: UNIT,
  weight: { type: "number", minimum: PARTICLE_FIELD_V2_MIN_ORIGIN_WEIGHT, maximum: PARTICLE_FIELD_V2_MAX_ORIGIN_WEIGHT, description: "Finite v2 spawn-origin weight." },
  directionOffsetDeg: { type: "number", minimum: -360, maximum: 360, description: "Optional finite direction offset in degrees." },
  speedScale: { type: "number", minimum: PARTICLE_FIELD_V2_MIN_SPEED_SCALE, maximum: PARTICLE_FIELD_V2_MAX_SPEED_SCALE, description: "Optional finite v2 speed multiplier." },
}, ["directionOffsetDeg", "speedScale"]);
const TRAIL: MotionDebugArgPropertySchema = record(["durationMs", "samples"], {
  durationMs: { type: "number", minimum: 1, maximum: 1_000, description: "Finite analytic lookback duration in milliseconds." },
  samples: { type: "number", minimum: 2, maximum: 4, description: "Integer analytic trail sample count; Core enforces integrality." },
  opacity: { type: "number", minimum: 0.05, maximum: 1, description: "Optional finite trail opacity." },
}, ["opacity"]);
const SHADING: MotionDebugArgPropertySchema = record(["mode"], {
  mode: { type: "string", enum: ["flat", "soft", "glow"], description: "Closed fixed-renderer shading mode." },
  sizeJitter: UNIT, opacityJitter: UNIT, glow: UNIT,
}, ["sizeJitter", "opacityJitter", "glow"]);

export const TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA = {
  "motion.timeline.particles.structural.inspect": { argsSchema: argsSchema(["packageRoot", "layerId"], { ...PACKAGE_ROOT, ...LAYER_ID }) },
  "motion.timeline.particles.field.source.insert": mutation("timeline.particles.field.source.insert", ["index", "source"], { index: INDEX, source: SOURCE }),
  "motion.timeline.particles.field.source.replace": mutation("timeline.particles.field.source.replace", ["index", "source"], { index: INDEX, source: SOURCE }),
  "motion.timeline.particles.field.source.move": mutation("timeline.particles.field.source.move", ["fromIndex", "toIndex"], { fromIndex: INDEX, toIndex: INDEX }),
  "motion.timeline.particles.field.source.delete": mutation("timeline.particles.field.source.delete", ["index"], { index: INDEX }),
  "motion.timeline.particles.emitter.origin.insert": mutation("timeline.particles.emitter.origin.insert", ["index", "origin"], { index: { ...INDEX, maximum: MAX_PARTICLE_EMITTER_ORIGINS, description: "Insertion position in the bounded v2 origin order." }, origin: ORIGIN }),
  "motion.timeline.particles.emitter.origin.replace": mutation("timeline.particles.emitter.origin.replace", ["index", "origin"], { index: { ...INDEX, maximum: MAX_PARTICLE_EMITTER_ORIGINS - 1, description: "Existing bounded v2 origin index." }, origin: ORIGIN }),
  "motion.timeline.particles.emitter.origin.move": mutation("timeline.particles.emitter.origin.move", ["fromIndex", "toIndex"], { fromIndex: { ...INDEX, maximum: MAX_PARTICLE_EMITTER_ORIGINS - 1, description: "Existing v2 origin index." }, toIndex: { ...INDEX, maximum: MAX_PARTICLE_EMITTER_ORIGINS - 1, description: "Final v2 origin position after removal/reinsertion." } }),
  "motion.timeline.particles.emitter.origin.delete": mutation("timeline.particles.emitter.origin.delete", ["index"], { index: { ...INDEX, maximum: MAX_PARTICLE_EMITTER_ORIGINS - 1, description: "Existing bounded v2 origin index." } }),
  "motion.timeline.particles.field.collision.axis.update": mutation("timeline.particles.field.collision.axis.update", ["index", "axis"], { index: INDEX, axis: { type: "string", enum: ["x", "y"], description: "Replacement axis on an existing v2 collision source." } }),
  "motion.timeline.particles.emitter.trail.add": mutation("timeline.particles.emitter.trail.add", ["trail"], { trail: TRAIL }),
  "motion.timeline.particles.emitter.trail.replace": mutation("timeline.particles.emitter.trail.replace", ["trail"], { trail: TRAIL }),
  "motion.timeline.particles.emitter.trail.remove": mutation("timeline.particles.emitter.trail.remove", [], {}),
  "motion.timeline.particles.emitter.shading.add": mutation("timeline.particles.emitter.shading.add", ["shading"], { shading: SHADING }),
  "motion.timeline.particles.emitter.shading.replace": mutation("timeline.particles.emitter.shading.replace", ["shading"], { shading: SHADING }),
  "motion.timeline.particles.emitter.shading.remove": mutation("timeline.particles.emitter.shading.remove", [], {}),
} satisfies Record<string, ParticleStructuralCommandMetadata>;

interface ParticleStructuralCommandMetadata {
  argsSchema: ReturnType<typeof argsSchema>;
  expectedReceipts?: ReturnType<typeof editReceipt>;
}

function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return { argsSchema: argsSchema(EDIT.concat(required), { ...PACKAGE_EDIT, ...LAYER_ID, ...properties }), expectedReceipts: editReceipt(operation) };
}

function record(required: string[], properties: Record<string, MotionDebugArgPropertySchema>, optional: string[] = []): MotionDebugArgPropertySchema {
  return { type: "object", required, properties, additionalProperties: false, description: `Exact plain-data record; optional fields: ${optional.length ? optional.join(", ") : "none"}.` };
}
