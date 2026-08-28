import type { GpuChromaKeyIntent, GpuChromaMatteCleanupIntent, GpuRgba } from "./gpu-frame-intent-types";
import { GpuFrameIntentError } from "./gpu-frame-intent-error";

/** Re-admits fixed chroma-key values before renderer-owned WGSL sees a plan. */
export function readGpuChromaKeyIntent(value: unknown, name: string): GpuChromaKeyIntent {
  if (!isRecord(value) || Object.keys(value).some((key) => !["keyColor", "similarity", "smoothness", "shadow", "spillSuppression", "spillBalance", "edgeColorCorrection", "matte"].includes(key))) {
    throw new GpuFrameIntentError(`${name} must contain only fixed Motion chroma-key controls.`);
  }
  const keyColor = rgba(value.keyColor, `${name}.keyColor`);
  if (keyColor.a !== 1) throw new GpuFrameIntentError(`${name}.keyColor.a must equal 1.`);
  const spillBalance = value.spillBalance;
  if (typeof spillBalance !== "number" || !Number.isFinite(spillBalance) || spillBalance < -1 || spillBalance > 1) throw new GpuFrameIntentError(`${name}.spillBalance must be finite in -1..1.`);
  return { keyColor, similarity: unit(value.similarity, `${name}.similarity`), smoothness: unit(value.smoothness, `${name}.smoothness`), shadow: unit(value.shadow, `${name}.shadow`), spillSuppression: unit(value.spillSuppression, `${name}.spillSuppression`), spillBalance, edgeColorCorrection: unit(value.edgeColorCorrection, `${name}.edgeColorCorrection`), matte: matte(value.matte, `${name}.matte`) };
}

function matte(value: unknown, name: string): GpuChromaMatteCleanupIntent {
  if (!isRecord(value) || Object.keys(value).some((key) => !["denoiseRadiusPx", "growShrinkPx", "chokePx", "featherPx", "blackClip", "whiteClip"].includes(key))) throw new GpuFrameIntentError(`${name} must contain only fixed Motion matte-cleanup controls.`);
  const blackClip = unit(value.blackClip, `${name}.blackClip`);
  const whiteClip = unit(value.whiteClip, `${name}.whiteClip`);
  if (blackClip >= whiteClip) throw new GpuFrameIntentError(`${name}.blackClip must be less than ${name}.whiteClip.`);
  return {
    denoiseRadiusPx: integer(value.denoiseRadiusPx, 0, 4, `${name}.denoiseRadiusPx`),
    growShrinkPx: integer(value.growShrinkPx, -16, 16, `${name}.growShrinkPx`),
    chokePx: integer(value.chokePx, 0, 16, `${name}.chokePx`),
    featherPx: integer(value.featherPx, 0, 32, `${name}.featherPx`),
    blackClip,
    whiteClip
  };
}

function rgba(value: unknown, name: string): GpuRgba {
  if (!isRecord(value) || ![value.r, value.g, value.b, value.a].every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1)) throw new GpuFrameIntentError(`${name} must contain finite r, g, b and a channels in 0..1.`);
  return { r: value.r as number, g: value.g as number, b: value.b as number, a: value.a as number };
}
function unit(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new GpuFrameIntentError(`${name} must be finite in 0..1.`); return value; }
function integer(value: unknown, minimum: number, maximum: number, name: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new GpuFrameIntentError(`${name} must be an integer in ${minimum}..${maximum}.`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
