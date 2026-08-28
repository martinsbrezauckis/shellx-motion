import { GpuFrameIntentError } from "./gpu-frame-intent-error";
import type { GpuRgba, GpuTextFitIntent, GpuTextShadow } from "./gpu-frame-intent-types";

const MAX_COORDINATE = 1_000_000;
const MAX_BLUR = 512;

/** Re-admits the closed text-only payload before a renderer page sees it. */
export function readGpuFrameTextShadow(value: unknown, name: string): GpuTextShadow | null {
  if (value === null) return null;
  if (!record(value) || Object.keys(value).some((key) => key !== "offsetX" && key !== "offsetY" && key !== "blur" && key !== "color")) throw new GpuFrameIntentError(`${name} must be null or a closed text-shadow object.`);
  return {
    offsetX: coordinate(value.offsetX, `${name}.offsetX`),
    offsetY: coordinate(value.offsetY, `${name}.offsetY`),
    blur: nonNegative(value.blur, `${name}.blur`, MAX_BLUR),
    color: rgba(value.color, `${name}.color`)
  };
}

/** Converts package-safe-area geometry to a renderer-independent closed intent. */
export function readGpuFrameTextFit(value: unknown, name: string): GpuTextFitIntent | null {
  if (value === null) return null;
  if (!record(value) || Object.keys(value).some((key) => key !== "policy" && key !== "safeArea" && key !== "minFontSize")) throw new GpuFrameIntentError(`${name} must be null or a closed text-fit object.`);
  const policy = enumValue(value.policy, `${name}.policy`, ["safe", "allow-crop", "auto-fit"] as const);
  const minFontSize = value.minFontSize === null ? null : positive(value.minFontSize, `${name}.minFontSize`);
  if (policy === "auto-fit" && minFontSize === null) throw new GpuFrameIntentError(`${name}.minFontSize is required for auto-fit.`);
  if (policy !== "auto-fit" && minFontSize !== null) throw new GpuFrameIntentError(`${name}.minFontSize is valid only for auto-fit.`);
  if (value.safeArea === null) {
    if (policy !== "allow-crop") throw new GpuFrameIntentError(`${name}.safeArea is required for ${policy}.`);
    return { policy, safeArea: null, minFontSize };
  }
  if (!record(value.safeArea) || Object.keys(value.safeArea).some((key) => key !== "top" && key !== "right" && key !== "bottom" && key !== "left")) throw new GpuFrameIntentError(`${name}.safeArea must be a bounded rectangle.`);
  const safeArea = {
    top: coordinate(value.safeArea.top, `${name}.safeArea.top`),
    right: coordinate(value.safeArea.right, `${name}.safeArea.right`),
    bottom: coordinate(value.safeArea.bottom, `${name}.safeArea.bottom`),
    left: coordinate(value.safeArea.left, `${name}.safeArea.left`)
  };
  if (safeArea.right < safeArea.left || safeArea.bottom < safeArea.top) throw new GpuFrameIntentError(`${name}.safeArea bounds are inverted.`);
  return { policy, safeArea, minFontSize };
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function coordinate(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) throw new GpuFrameIntentError(`${name} must be a finite coordinate.`); return value; }
function positive(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_COORDINATE) throw new GpuFrameIntentError(`${name} must be a positive finite number.`); return value; }
function nonNegative(value: unknown, name: string, maximum: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) throw new GpuFrameIntentError(`${name} must be finite in 0..${maximum}.`); return value; }
function rgba(value: unknown, name: string): GpuRgba { if (!record(value) || ![value.r, value.g, value.b, value.a].every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1)) throw new GpuFrameIntentError(`${name} must contain finite r, g, b and a channels in 0..1.`); return { r: value.r as number, g: value.g as number, b: value.b as number, a: value.a as number }; }
function enumValue<const T extends readonly string[]>(value: unknown, name: string, values: T): T[number] { if (typeof value !== "string" || !values.includes(value)) throw new GpuFrameIntentError(`${name} is invalid.`); return value as T[number]; }
