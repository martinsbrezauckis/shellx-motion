import { GpuFrameIntentError } from "./gpu-frame-intent-error";
import type { GpuDrawIntent } from "./gpu-frame-intent-types";

export function readGpuFrameText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new GpuFrameIntentError(`${name} must be a string.`);
  return value;
}

export function readGpuFrameSafeText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GpuFrameIntentError(`${name} must be bounded printable text.`);
  }
  return value;
}

export function readGpuFrameInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new GpuFrameIntentError(`${name} must be an integer in ${minimum}..${maximum}.`);
  }
  return value;
}

export function readGpuFramePositiveUnitless(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new GpuFrameIntentError(`${name} must be finite in 0..${maximum}.`);
  }
  return value;
}

export function readGpuFrameNonNegative(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new GpuFrameIntentError(`${name} must be finite in 0..${maximum}.`);
  }
  return value;
}

export function readGpuFrameStyledRectangleShadow(value: unknown, name: string): Extract<GpuDrawIntent, { kind: "styledRect" }>["shadow"] {
  if (value === null) return null;
  if (!isGpuFrameRecord(value)) throw new GpuFrameIntentError(`${name} must be null or a bounded shadow object.`);
  return {
    offsetX: readGpuFrameCoordinate(value.offsetX, `${name}.offsetX`),
    offsetY: readGpuFrameCoordinate(value.offsetY, `${name}.offsetY`),
    blur: readGpuFrameNonNegative(value.blur, `${name}.blur`, 512),
    spread: readGpuFrameCoordinate(value.spread, `${name}.spread`),
    color: readGpuFrameRgba(value.color, `${name}.color`)
  };
}

export function readGpuFrameEnum<const T extends readonly string[]>(value: unknown, name: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new GpuFrameIntentError(`${name} is unsupported.`);
  return value as T[number];
}

export function isGpuFrameRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readGpuFrameCoordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new GpuFrameIntentError(`${name} must be a bounded finite coordinate.`);
  }
  return value;
}

function readGpuFrameRgba(value: unknown, name: string): { r: number; g: number; b: number; a: number } {
  if (!isGpuFrameRecord(value) || ![value.r, value.g, value.b, value.a].every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
    throw new GpuFrameIntentError(`${name} must contain finite r, g, b and a channels in 0..1.`);
  }
  return { r: value.r as number, g: value.g as number, b: value.b as number, a: value.a as number };
}
