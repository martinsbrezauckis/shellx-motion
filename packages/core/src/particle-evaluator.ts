import { PARTICLE_FIELD_V2_SCHEMA } from "./particle-field-types";
import { normalizeParticleField } from "./particle-field-normalize";
import {
  createMotionParticleEvaluatorReference,
  evaluateMotionParticlesReference,
  particleFieldDeflectionReference,
  type MotionParticleEvaluationInput,
  type MotionParticleEvaluator,
  type MotionParticleSample
} from "./particle-evaluator-reference";
import type { MotionParticleEmitter } from "./types";

export {
  MAX_EVALUATED_PARTICLE_COUNT,
  MAX_EVALUATED_PARTICLE_GRAVITY,
  MAX_EVALUATED_PARTICLE_LIFETIME_MS,
  MAX_EVALUATED_PARTICLE_SIZE,
  MAX_EVALUATED_PARTICLE_SPEED,
  MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION,
  PARTICLE_OUTPUT_DECIMALS,
  particleRandom,
  roundParticleOutput,
  type MotionParticleEvaluationInput,
  type MotionParticleEvaluator,
  type MotionParticleSample
} from "./particle-evaluator-reference";

/** Public renderer evaluator: v2 is GPU-only and must never silently degrade to CPU heads. */
export function evaluateMotionParticles(input: MotionParticleEvaluationInput): MotionParticleSample[] {
  return evaluateMotionParticlesReference({ ...input, emitter: admittedPublicEmitter(input.emitter) });
}

export function createMotionParticleEvaluator(input: MotionParticleEvaluationInput): MotionParticleEvaluator {
  return createMotionParticleEvaluatorReference({ ...input, emitter: admittedPublicEmitter(input.emitter) });
}

export function particleFieldDeflection(emitter: MotionParticleEmitter, baseX: number, baseY: number, progress: number): { x: number; y: number } {
  return particleFieldDeflectionReference(admittedPublicEmitter(emitter), baseX, baseY, progress);
}

function admittedPublicEmitter(emitter: MotionParticleEmitter): MotionParticleEmitter {
  const field = normalizeParticleField(emitter.field);
  if (field.schema === PARTICLE_FIELD_V2_SCHEMA) {
    throw new Error(`${PARTICLE_FIELD_V2_SCHEMA} requires the fixed high-density GPU renderer ABI and cannot use the public CPU particle evaluator.`);
  }
  if (field.schema === null) return emitter;
  return { ...emitter, field: { schema: field.schema, sources: field.sources.map((source) => ({ ...source })) } as MotionParticleEmitter["field"] };
}
