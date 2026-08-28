import { GpuFrameIntentError } from "./gpu-frame-intent-error";

export function readGpuComputeFinite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new GpuFrameIntentError(`${name} must be finite.`);
  return value;
}

export function readGpuComputeBounded(value: unknown, name: string, minimum: number, maximum: number): number {
  const number = readGpuComputeFinite(value, name);
  if (number < minimum || number > maximum) throw new GpuFrameIntentError(`${name} must be finite in ${minimum}..${maximum}.`);
  return number;
}

export function readGpuComputeSeed(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new GpuFrameIntentError(`${name} must be an unsigned 32-bit integer.`);
  return value;
}

export function readGpuComputeRotation(value: unknown, name: string): number {
  const rotation = readGpuComputeFinite(value, name);
  if (Math.abs(rotation) > 1_000_000) throw new GpuFrameIntentError(`${name} exceeds the rotation bound.`);
  return rotation;
}
