import { PARTICLE_FIELD_SCHEMA, PARTICLE_FIELD_V2_SCHEMA, type MotionParticleEmitterOrigin, type MotionParticleFieldSource, type MotionParticleFieldV2Source } from "./particle-field-types";
import { normalizeParticleField, normalizeParticleOrigins, normalizeParticleShading, type NormalizedParticleField } from "./particle-field-normalize";
import type { MotionParticleEmitter } from "./types";

/** Private deterministic reference only. Public renderer callers use particle-evaluator.ts. */
export const MAX_EVALUATED_PARTICLE_COUNT = 1000;
export const MAX_EVALUATED_PARTICLE_LIFETIME_MS = 60_000;
export const MAX_EVALUATED_PARTICLE_SIZE = 256;
export const MAX_EVALUATED_PARTICLE_SPEED = 2_000;
export const MAX_EVALUATED_PARTICLE_GRAVITY = 5_000;
export const MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION = 2;
export const PARTICLE_OUTPUT_DECIMALS = 6;
export interface MotionParticleEvaluationInput { emitter: MotionParticleEmitter; atMs: number; startMs: number; width: number; height: number; }
export interface MotionParticleSample { x: number; y: number; size: number; opacity: number; color: string; shape: "circle" | "square"; progress: number; }
export interface MotionParticleEvaluator { count: number; sampleAt(particleIndex: number, atMs: number): MotionParticleSample; cycleStartAt(particleIndex: number, atMs: number): number; }

export function evaluateMotionParticlesReference(input: MotionParticleEvaluationInput): MotionParticleSample[] {
  const evaluator = createMotionParticleEvaluatorReference(input), samples: MotionParticleSample[] = [];
  for (let particleIndex = 0; particleIndex < evaluator.count; particleIndex += 1) samples.push(evaluator.sampleAt(particleIndex, input.atMs));
  return samples;
}

export function createMotionParticleEvaluatorReference(input: MotionParticleEvaluationInput): MotionParticleEvaluator {
  const emitter = input.emitter, field = normalizeParticleField(emitter.field), origins = field.schema === PARTICLE_FIELD_V2_SCHEMA ? normalizeParticleOrigins(emitter.origins, field.schema) : [], shading = field.schema === PARTICLE_FIELD_V2_SCHEMA ? normalizeParticleShading(emitter.shading, field.schema) : null;
  const width = finiteOr(input.width, 100), height = finiteOr(input.height, 100), startMs = finiteOr(input.startMs, 0), seed = finiteOr(emitter.seed, 0) >>> 0;
  const count = Math.min(MAX_EVALUATED_PARTICLE_COUNT, Math.max(1, Math.floor(finiteOr(emitter.count, 1))));
  const lifetimeMs = Math.min(MAX_EVALUATED_PARTICLE_LIFETIME_MS, Math.max(1, finiteOr(emitter.lifetimeMs, 1_000)));
  const minSize = Math.min(MAX_EVALUATED_PARTICLE_SIZE, Math.max(0.1, finiteOr(emitter.minSize, 2))), maxSize = Math.min(MAX_EVALUATED_PARTICLE_SIZE, Math.max(minSize, finiteOr(emitter.maxSize, 8)));
  const minSpeed = Math.min(MAX_EVALUATED_PARTICLE_SPEED, Math.max(0, finiteOr(emitter.minSpeed, 20))), maxSpeed = Math.min(MAX_EVALUATED_PARTICLE_SPEED, Math.max(minSpeed, finiteOr(emitter.maxSpeed, 80)));
  const direction = finiteOr(emitter.direction, -90), spread = Math.min(360, Math.max(0, finiteOr(emitter.spread, 45))), gravity = Math.min(MAX_EVALUATED_PARTICLE_GRAVITY, Math.max(-MAX_EVALUATED_PARTICLE_GRAVITY, finiteOr(emitter.gravity, 0)));
  const color = nonEmptyStringOr(emitter.color, "#ffffff"), secondaryColor = nonEmptyStringOr(emitter.secondaryColor, color);
  const lifecycle = (particleIndex: number, atMs: number) => {
    if (!Number.isInteger(particleIndex) || particleIndex < 0 || particleIndex >= count) throw new Error(`Particle index must be an integer in 0..${count - 1}.`);
    const phaseMs = particleRandom(seed, particleIndex, 0) * lifetimeMs, localMs = Math.max(0, finiteOr(atMs, 0) - startMs), ageMs = (localMs + phaseMs) % lifetimeMs;
    return { ageMs, cycleStartMs: startMs + Math.max(0, Math.floor((localMs + phaseMs) / lifetimeMs) * lifetimeMs - phaseMs) };
  };
  return { count, cycleStartAt(particleIndex, atMs) { return roundParticleOutput(lifecycle(particleIndex, atMs).cycleStartMs); }, sampleAt(particleIndex, atMs) {
    const { ageMs } = lifecycle(particleIndex, atMs), progress = ageMs / lifetimeMs, timelineProgress = clamp((finiteOr(atMs, 0) - startMs) / lifetimeMs, 0, 1), origin = originForParticle(origins, seed, particleIndex);
    const angleRadians = (direction + (origin?.directionOffsetDeg ?? 0) + (particleRandom(seed, particleIndex, 1) - 0.5) * spread) * Math.PI / 180;
    const speed = (minSpeed + particleRandom(seed, particleIndex, 2) * (maxSpeed - minSpeed)) * (origin?.speedScale ?? 1);
    const rawSize = minSize + particleRandom(seed, particleIndex, 3) * (maxSize - minSize), size = rawSize * (1 + signedRandom(seed, particleIndex, 6) * (shading?.sizeJitter ?? 0));
    const ageSeconds = ageMs / 1000, baseCenterX = (origin?.x ?? 0.5) * width + Math.cos(angleRadians) * speed * ageSeconds, baseCenterY = (origin?.y ?? 0.5) * height + Math.sin(angleRadians) * speed * ageSeconds + 0.5 * gravity * ageSeconds * ageSeconds;
    const deflection = particleFieldDeflectionReferenceFor(field, baseCenterX / (width || 1), baseCenterY / (height || 1), progress, timelineProgress, seed, particleIndex);
    const opacityBase = emitter.fadeOut !== false ? Math.max(0, 1 - progress) : 1, opacity = opacityBase * (1 - particleRandom(seed, particleIndex, 7) * (shading?.opacityJitter ?? 0));
    return { x: roundParticleOutput(baseCenterX + deflection.x * width - size / 2), y: roundParticleOutput(baseCenterY + deflection.y * height - size / 2), size: roundParticleOutput(size), opacity: roundParticleOutput(opacity), color: particleRandom(seed, particleIndex, 4) < 0.5 ? color : secondaryColor, shape: emitter.shape === "square" ? "square" : "circle", progress: roundParticleOutput(progress) };
  } };
}

export function particleFieldDeflectionReference(emitter: MotionParticleEmitter, baseX: number, baseY: number, progress: number): { x: number; y: number } { return particleFieldDeflectionReferenceFor(normalizeParticleField(emitter.field), baseX, baseY, progress, progress, 0, 0); }
function particleFieldDeflectionReferenceFor(field: NormalizedParticleField, baseX: number, baseY: number, particleProgress: number, timelineProgress: number, seed: number, particleIndex: number): { x: number; y: number } { if (field.sources.length === 0) return { x: 0, y: 0 }; if (field.schema === PARTICLE_FIELD_SCHEMA) return v1Deflection(field.sources as readonly MotionParticleFieldSource[], baseX, baseY, particleProgress); return v2Deflection(field.sources as readonly MotionParticleFieldV2Source[], baseX, baseY, particleProgress, timelineProgress, seed, particleIndex); }
function v1Deflection(sources: readonly MotionParticleFieldSource[], baseX: number, baseY: number, progress: number): { x: number; y: number } { const p2 = clamp(finiteOr(progress, 0), 0, 1) ** 2; let x = 0, y = 0; for (const source of sources) { const dx = source.centerX - baseX, dy = source.centerY - baseY, distanceSquared = dx * dx + dy * dy; if (distanceSquared === 0) continue; const distance = Math.sqrt(distanceSquared), magnitude = source.strength * p2 * ((source.softening * source.softening) / (distanceSquared + source.softening * source.softening)), unitX = dx / distance, unitY = dy / distance; if (source.kind === "vortex") { x += -unitY * magnitude; y += unitX * magnitude; } else { x += unitX * magnitude; y += unitY * magnitude; } } return { x: clamp(x, -MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION, MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION), y: clamp(y, -MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION, MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION) }; }
function v2Deflection(sources: readonly MotionParticleFieldV2Source[], baseX: number, baseY: number, particleProgress: number, timelineProgress: number, seed: number, particleIndex: number): { x: number; y: number } { const p2 = clamp(finiteOr(particleProgress, 0), 0, 1) ** 2; let x = baseX, y = baseY; for (const source of sources) { if (source.kind === "collision") { if (source.axis === "x" && x > source.position) x = source.position - (x - source.position) * source.restitution; if (source.axis === "y" && y > source.position) y = source.position - (y - source.position) * source.restitution; continue; } if (source.kind === "flow") { const radians = source.angleDeg * Math.PI / 180, magnitude = source.strength * p2; x += Math.cos(radians) * magnitude; y += Math.sin(radians) * magnitude; continue; } if (source.kind === "turbulence") { const angle = deterministicNoise(seed, particleIndex, x * source.scale, y * source.scale, particleProgress) * Math.PI * 2; x += Math.cos(angle) * source.strength * p2; y += Math.sin(angle) * source.strength * p2; continue; } const dx = source.centerX - x, dy = source.centerY - y, distanceSquared = dx * dx + dy * dy; if (distanceSquared === 0) continue; const distance = Math.sqrt(distanceSquared), unitX = dx / distance, unitY = dy / distance; if (source.kind === "impact") { const local = (timelineProgress - source.startProgress) / source.durationProgress, pulse = local < 0 || local > 1 ? 0 : Math.sin(Math.PI * local), ring = clamp(1 - Math.abs(distance - source.radius) / source.radius, 0, 1), magnitude = source.strength * pulse * ring; x -= unitX * magnitude; y -= unitY * magnitude; continue; } const magnitude = source.strength * p2 * ((source.softening * source.softening) / (distanceSquared + source.softening * source.softening)); if (source.kind === "vortex") { x += -unitY * magnitude; y += unitX * magnitude; } else { x += unitX * magnitude; y += unitY * magnitude; } } return { x: clamp(x - baseX, -MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION, MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION), y: clamp(y - baseY, -MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION, MAX_PARTICLE_FIELD_NORMALIZED_DEFLECTION) }; }
function originForParticle(origins: readonly MotionParticleEmitterOrigin[], seed: number, particleIndex: number): MotionParticleEmitterOrigin | null { if (!origins.length) return null; const total = origins.reduce((sum, origin) => sum + origin.weight, 0), target = particleRandom(seed, particleIndex, 5) * total; let accumulated = 0; for (const origin of origins) { accumulated += origin.weight; if (target < accumulated) return origin; } return origins[origins.length - 1] ?? null; }
function deterministicNoise(seed: number, index: number, x: number, y: number, progress: number): number { const mixed = (Math.imul(Math.floor(x * 4096), 0x9e3779b1) ^ Math.imul(Math.floor(y * 4096), 0x85ebca6b) ^ Math.imul(Math.floor(progress * 4096), 0xc2b2ae35)) >>> 0; return particleRandom((seed ^ mixed) >>> 0, index, 8); }
function signedRandom(seed: number, index: number, channel: number): number { return particleRandom(seed, index, channel) * 2 - 1; }
export function particleRandom(seed: number, particleIndex: number, channel: number): number { let value = (seed ^ Math.imul(particleIndex + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0; value ^= value >>> 16; value = Math.imul(value, 0x7feb352d); value ^= value >>> 15; value = Math.imul(value, 0x846ca68b); value ^= value >>> 16; return (value >>> 0) / 0x1_0000_0000; }
export function roundParticleOutput(value: number): number { const rounded = Math.round(value * 10 ** PARTICLE_OUTPUT_DECIMALS) / 10 ** PARTICLE_OUTPUT_DECIMALS; return Object.is(rounded, -0) ? 0 : rounded; }
function finiteOr(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function nonEmptyStringOr(value: unknown, fallback: string): string { return typeof value === "string" && value.length > 0 ? value : fallback; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
