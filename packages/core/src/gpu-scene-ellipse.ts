import { GPU_MAX_FRAME_DIMENSION, type GpuRgba } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import type { MotionLayer } from "./types";

const ELLIPSE_STYLE_FIELDS = new Set(["fill", "color", "width", "height", "stroke", "strokeWidth"]);

export function gpuSceneEllipseHasOnlySupportedStyles(layer: MotionLayer): boolean {
  return Object.keys(layer.style ?? {}).every((key) => ELLIPSE_STYLE_FIELDS.has(key));
}

/** Resolves the fixed fill/stroke fields used by Motion's owned ellipse shader. */
export function compileGpuSceneEllipseStroke(layer: MotionLayer, opacity: number, scale: number):
  | { ok: true; strokeWidth: number; stroke: GpuRgba }
  | { ok: false; message: string } {
  const strokeValue = layer.style?.stroke;
  const widthValue = layer.style?.strokeWidth;
  if (strokeValue === undefined && widthValue === undefined) return { ok: true, strokeWidth: 0, stroke: transparent() };
  if (typeof strokeValue !== "string" || typeof widthValue !== "number" || !Number.isFinite(widthValue) || widthValue < 0) {
    return { ok: false, message: `GPU ellipse ${layer.id} requires stroke and a finite nonnegative strokeWidth together.` };
  }
  const stroke = parseGpuSceneColor(strokeValue);
  const strokeWidth = widthValue * scale;
  if (!stroke || !Number.isFinite(strokeWidth) || strokeWidth > GPU_MAX_FRAME_DIMENSION) {
    return { ok: false, message: `GPU ellipse ${layer.id} has an unsupported stroke or exceeds the ${GPU_MAX_FRAME_DIMENSION}px stroke bound.` };
  }
  return { ok: true, strokeWidth, stroke: { ...stroke, a: stroke.a * opacity } };
}

function transparent(): GpuRgba { return { r: 0, g: 0, b: 0, a: 0 }; }
