import type { GpuPrimitiveIntent, GpuRgba } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import { compileGpuSceneAuthoredShapeGeometry, compileGpuScenePathGeometry, hasGpuScenePathGeometry, isGpuScenePathShape, tessellateGpuSceneAuthoredShapeGeometry, tessellateGpuScenePathGeometry } from "./gpu-scene-path-geometry";
import { gpuSceneAuthoredClosedStrokeMiterProblem, gpuSceneAuthoredDashStrokeProblem, gpuSceneAuthoredOpenMiterProblem } from "./gpu-scene-path-tessellation";
import { gpuSceneEffects } from "./gpu-scene-effects";
import type { MotionLayer } from "./types";

export { hasGpuScenePathGeometry, isGpuScenePathShape } from "./gpu-scene-path-geometry";

const SUPPORTED_PATH_STYLE_FIELDS = new Set(["fill", "color", "width", "height", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin"]);
const SUPPORTED_AUTHORED_SHAPE_STYLE_FIELDS = new Set([...SUPPORTED_PATH_STYLE_FIELDS, "strokeDasharray", "strokeDashoffset"]);

export type GpuScenePathLoweringResult =
  /** `null` is the exact empty path-reveal window, not a fallback or dropped feature. */
  | { ok: true; draw: Extract<GpuPrimitiveIntent, { kind: "coloredTriangles" }> | null }
  | { ok: false; code: "gpu_unsupported_feature" | "gpu_unsupported_color"; message: string };

export function gpuScenePathUnsupportedFeature(layer: MotionLayer): string | null {
  const geometry = compileGpuScenePathGeometry(layer);
  return geometry.ok ? null : geometry.message;
}

/** Static admission for the versioned authored geometry record. */
export function gpuSceneAuthoredShapeUnsupportedFeature(layer: MotionLayer): string | null {
  const geometry = compileGpuSceneAuthoredShapeGeometry(layer);
  if (!geometry.ok) return geometry.message;
  if (!Object.keys(layer.style ?? {}).every((key) => SUPPORTED_AUTHORED_SHAPE_STYLE_FIELDS.has(key))) return `GPU shape ${layer.id} has an unsupported style field.`;
  if (geometry.geometry.strokeDash) {
    const stroke = typeof layer.style?.stroke === "string" ? parseGpuSceneColor(layer.style.stroke) : null;
    if (!geometry.geometry.stroke || !stroke || stroke.a <= 0) return `GPU shape ${layer.id} strokeDasharray requires an explicit supported visible stroke.`;
  }
  return gpuSceneAuthoredClosedStrokeMiterProblem(geometry.geometry);
}

export function gpuScenePathHasOnlySupportedStyles(layer: MotionLayer): boolean {
  return Object.keys(layer.style ?? {}).every((key) => SUPPORTED_PATH_STYLE_FIELDS.has(key));
}

export function gpuSceneAuthoredShapeHasOnlySupportedStyles(layer: MotionLayer): boolean {
  return Object.keys(layer.style ?? {}).every((key) => SUPPORTED_AUTHORED_SHAPE_STYLE_FIELDS.has(key));
}

/** Static admission for the stricter GPU path-reveal realization. */
export function gpuScenePathRevealUnsupportedFeature(layer: MotionLayer): string | null {
  if (!layer.pathReveal) return null;
  const reveal = layer.pathReveal;
  if (!Number.isFinite(reveal.start) || !Number.isFinite(reveal.end) || reveal.start < 0 || reveal.start > 1 || reveal.end < 0 || reveal.end > 1) {
    return `GPU path ${layer.id} pathReveal requires finite start/end values in 0..1.`;
  }
  const geometry = compileGpuScenePathGeometry(layer);
  if (!geometry.ok) return geometry.message;
  if (!geometry.geometry.stroke) return `GPU path ${layer.id} pathReveal requires an explicit finite butt/miter stroke.`;
  return null;
}

/** Lowers one prevalidated canonical path into a fixed, per-vertex-color triangle batch. */
export function compileGpuScenePathShape(input: {
  layer: MotionLayer;
  box: { x: number; y: number; width: number; height: number };
  fill: GpuRgba;
  opacity: number;
  scale: number;
  rotationDeg: number;
  pivotX: number;
  pivotY: number;
}): GpuScenePathLoweringResult {
  const geometry = compileGpuScenePathGeometry(input.layer);
  if (!geometry.ok) return { ok: false, code: "gpu_unsupported_feature", message: geometry.message };
  const strokeValue = typeof input.layer.style?.stroke === "string" ? input.layer.style.stroke : null;
  const stroke = strokeValue === null ? null : parseGpuSceneColor(strokeValue);
  if (strokeValue !== null && !stroke) return { ok: false, code: "gpu_unsupported_color", message: `GPU path ${input.layer.id} uses unsupported stroke '${strokeValue}'.` };
  const revealProblem = gpuScenePathRevealUnsupportedFeature(input.layer);
  if (revealProblem) return { ok: false, code: "gpu_unsupported_feature", message: revealProblem };
  const reveal = input.layer.pathReveal ?? null;
  const vertices = tessellateGpuScenePathGeometry({
    geometry: geometry.geometry,
    box: input.box,
    // Browser path reveals are stroke windows. Keep GPU equally explicit rather
    // than claiming SVG fill/dash semantics that this fixed triangle ABI lacks.
    fill: reveal ? null : input.fill,
    stroke: stroke ? { ...stroke, a: stroke.a * input.opacity } : null,
    strokeWidth: (geometry.geometry.stroke?.width ?? 0) * input.scale,
    reveal
  });
  if (vertices.length === 0 && reveal) return { ok: true, draw: null };
  if (vertices.length === 0) return { ok: false, code: "gpu_unsupported_feature", message: `GPU path ${input.layer.id} has neither a visible fill nor a visible stroke.` };
  return {
    ok: true,
    draw: {
      kind: "coloredTriangles", id: input.layer.id, blendMode: input.layer.blendMode ?? "normal", effects: gpuSceneEffects(input.layer), vertices,
      rotationDeg: input.rotationDeg, pivotX: input.pivotX, pivotY: input.pivotY
    }
  };
}

/**
 * Lowers the versioned authored contour ABI through the same fixed triangle
 * draw as legacy paths. Open contours have already refused fill/gradients and
 * require a supported miter/butt stroke before this point.
 */
export function compileGpuSceneAuthoredShape(input: {
  layer: MotionLayer;
  box: { x: number; y: number; width: number; height: number };
  fill: GpuRgba;
  opacity: number;
  scale: number;
  rotationDeg: number;
  pivotX: number;
  pivotY: number;
}): GpuScenePathLoweringResult {
  const geometry = compileGpuSceneAuthoredShapeGeometry(input.layer);
  if (!geometry.ok) return { ok: false, code: "gpu_unsupported_feature", message: geometry.message };
  const strokeValue = typeof input.layer.style?.stroke === "string" ? input.layer.style.stroke : null;
  const stroke = strokeValue === null ? null : parseGpuSceneColor(strokeValue);
  if (strokeValue !== null && !stroke) return { ok: false, code: "gpu_unsupported_color", message: `GPU shape ${input.layer.id} uses unsupported stroke '${strokeValue}'.` };
  const strokeWidth = (geometry.geometry.stroke?.width ?? 0) * input.scale;
  const dash = geometry.geometry.strokeDash ?? null;
  if (dash && (!stroke || stroke.a * input.opacity <= 0)) return { ok: false, code: "gpu_unsupported_feature", message: `GPU shape ${input.layer.id} strokeDasharray requires an explicit supported visible stroke.` };
  const closedMiterProblem = gpuSceneAuthoredClosedStrokeMiterProblem(geometry.geometry);
  if (closedMiterProblem) return { ok: false, code: "gpu_unsupported_feature", message: closedMiterProblem };
  const miterProblem = dash
    ? gpuSceneAuthoredDashStrokeProblem({ geometry: geometry.geometry, box: input.box, strokeWidth, dash, dashScale: input.scale })
    : gpuSceneAuthoredOpenMiterProblem({ geometry: geometry.geometry, box: input.box, strokeWidth });
  if (miterProblem) return { ok: false, code: "gpu_unsupported_feature", message: miterProblem };
  const vertices = tessellateGpuSceneAuthoredShapeGeometry({
    geometry: geometry.geometry,
    box: input.box,
    fill: input.fill,
    stroke: stroke ? { ...stroke, a: stroke.a * input.opacity } : null,
    strokeWidth,
    dash,
    dashScale: input.scale
  });
  if (vertices.length === 0) return { ok: false, code: "gpu_unsupported_feature", message: `GPU shape ${input.layer.id} has neither a visible fill nor a visible stroke.` };
  return {
    ok: true,
    draw: {
      kind: "coloredTriangles", id: input.layer.id, blendMode: input.layer.blendMode ?? "normal", effects: gpuSceneEffects(input.layer), vertices,
      rotationDeg: input.rotationDeg, pivotX: input.pivotX, pivotY: input.pivotY
    }
  };
}
