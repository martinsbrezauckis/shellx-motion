import type { GpuDrawIntent, GpuRgba } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import type { MotionLayer } from "./types";

type StyledRectangle = Pick<Extract<GpuDrawIntent, {kind:"styledRect"}>, "radius" | "strokeWidth" | "stroke" | "shadow">;
export type GpuStyledRectangleResult = { ok: true; style: StyledRectangle | null } | { ok: false; failure: GpuScene2dFailure };

/** Compiles bounded rect-only radius, stroke and shadow styling. */
export function compileGpuStyledRectangle(layer: MotionLayer, opacity: number, scale: number): GpuStyledRectangleResult {
  const style = layer.style ?? {};
  const radius = readPixelNumber(style.borderRadius ?? style.radius ?? 0); const strokeWidth = readPixelNumber(style.strokeWidth ?? style.borderWidth ?? 0);
  const strokeValue = typeof style.stroke === "string" ? style.stroke : typeof style.borderColor === "string" ? style.borderColor : "#00000000";
  const stroke = parseGpuSceneColor(strokeValue);
  if (radius === null || strokeWidth === null || radius < 0 || strokeWidth < 0 || !stroke) return failure(layer.id, "invalid radius or stroke styling");
  const shadowValue = hasKeys(style.shadow) ? style.shadow : hasKeys(style.boxShadow) ? style.boxShadow : null;
  let shadow: Extract<GpuDrawIntent, {kind:"styledRect"}>["shadow"] = null;
  if (shadowValue) {
    const record = shadowValue as Record<string, unknown>; const offsetX = readPixelNumber(record.offsetX ?? record.x ?? 0); const offsetY = readPixelNumber(record.offsetY ?? record.y ?? 0); const blur = readPixelNumber(record.blurRadius ?? record.blur ?? 0); const spread = readPixelNumber(record.spreadRadius ?? record.spread ?? 0); const shadowColorValue = typeof record.color === "string" ? record.color : "#00000059"; const shadowColor = parseGpuSceneColor(shadowColorValue);
    if (offsetX === null || offsetY === null || blur === null || spread === null || blur < 0 || !shadowColor || blur * scale > 512) return failure(layer.id, "invalid bounded shadow styling");
    shadow = { offsetX: offsetX * scale, offsetY: offsetY * scale, blur: blur * scale, spread: spread * scale, color: withOpacity(shadowColor, opacity) };
  }
  if (radius === 0 && strokeWidth === 0 && shadow === null) return { ok: true, style: null };
  return { ok: true, style: { radius: radius * scale, strokeWidth: strokeWidth * scale, stroke: withOpacity(stroke, opacity), shadow } };
}

function withOpacity(color: GpuRgba, opacity: number): GpuRgba { return { ...color, a: color.a * opacity }; }
function readPixelNumber(value: unknown): number | null { if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value !== "string") return null; const match = /^([-+]?(?:\d+\.?\d*|\.\d+))(?:px)?$/i.exec(value.trim()); return match ? Number(match[1]) : null; }
function hasKeys(value: unknown): boolean { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0; }
function failure(layerId: string, reason: string): GpuStyledRectangleResult { return { ok: false, failure: { code: "gpu_unsupported_feature", message: `GPU scene layer ${layerId} has ${reason}.`, layerId } }; }
