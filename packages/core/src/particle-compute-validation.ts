import { GPU_COMPUTE_PARTICLE_MAX_COUNT, GPU_COMPUTE_PARTICLE_MIN_COUNT } from "./gpu-particle-compute";

export const MAX_CPU_PARTICLE_COUNT = 1_000;

/** Appends only the density/route errors; scalar emitter validation remains in validate.ts. */
export function validateParticleComputeDensity(
  emitter: Record<string, unknown>,
  path: string,
  errors: Array<{ path: string; message: string }>
): void {
  const count = emitter.count;
  if (!isPositiveInteger(count) || (typeof count === "number" && count > GPU_COMPUTE_PARTICLE_MAX_COUNT)) {
    errors.push({ path: `${path}/emitter/count`, message: `must be an integer between 1 and ${GPU_COMPUTE_PARTICLE_MAX_COUNT}` });
    return;
  }
  if (count <= MAX_CPU_PARTICLE_COUNT) return;
  if (count < GPU_COMPUTE_PARTICLE_MIN_COUNT || !emitter.field) {
    errors.push({ path: `${path}/emitter/count`, message: `counts above ${MAX_CPU_PARTICLE_COUNT} require the bounded analytic field and a count in ${GPU_COMPUTE_PARTICLE_MIN_COUNT}..${GPU_COMPUTE_PARTICLE_MAX_COUNT}` });
  }
  if (emitter.shape !== "circle") errors.push({ path: `${path}/emitter/shape`, message: "counts above 1000 require an explicit circle shape for the fixed GPU compute field" });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
