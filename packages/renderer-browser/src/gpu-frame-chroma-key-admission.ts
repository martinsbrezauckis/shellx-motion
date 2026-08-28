import type { InternalGpuChromaKey, InternalGpuChromaMatteCleanup, InternalGpuRgba } from "./gpu-runtime-types";

/** Re-admits the exact closed chroma-key data accepted by Core. */
export function admitGpuChromaKey(value: unknown): InternalGpuChromaKey | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !["keyColor", "similarity", "smoothness", "shadow", "spillSuppression", "spillBalance", "edgeColorCorrection", "matte"].includes(key))) return undefined;
  const keyColor = rgba(value.keyColor);
  const similarity = unit(value.similarity); const smoothness = unit(value.smoothness); const shadow = unit(value.shadow);
  const spillSuppression = unit(value.spillSuppression); const spillBalance = signedUnit(value.spillBalance); const edgeColorCorrection = unit(value.edgeColorCorrection);
  const matte = admitMatte(value.matte);
  if (!keyColor || keyColor.a !== 1 || similarity === null || smoothness === null || shadow === null || spillSuppression === null || spillBalance === null || edgeColorCorrection === null || !matte) return undefined;
  return { keyColor, similarity, smoothness, shadow, spillSuppression, spillBalance, edgeColorCorrection, matte };
}

function admitMatte(value: unknown): InternalGpuChromaMatteCleanup | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["denoiseRadiusPx", "growShrinkPx", "chokePx", "featherPx", "blackClip", "whiteClip"].includes(key))) return null;
  const denoiseRadiusPx = integer(value.denoiseRadiusPx, 0, 4);
  const growShrinkPx = integer(value.growShrinkPx, -16, 16);
  const chokePx = integer(value.chokePx, 0, 16);
  const featherPx = integer(value.featherPx, 0, 32);
  const blackClip = unit(value.blackClip);
  const whiteClip = unit(value.whiteClip);
  return denoiseRadiusPx === null || growShrinkPx === null || chokePx === null || featherPx === null || blackClip === null || whiteClip === null || blackClip >= whiteClip ? null : { denoiseRadiusPx, growShrinkPx, chokePx, featherPx, blackClip, whiteClip };
}

function rgba(value: unknown): InternalGpuRgba | null {
  if (!isRecord(value) || ![value.r, value.g, value.b, value.a].every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1)) return null;
  return { r: value.r as number, g: value.g as number, b: value.b as number, a: value.a as number };
}
function unit(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function signedUnit(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1 ? value : null; }
function integer(value: unknown, minimum: number, maximum: number): number | null { return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
