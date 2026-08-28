import { compileGpuSceneAuthoredShapeGeometry, gpuSceneAuthoredClosedStrokeMiterProblem, gpuSceneAuthoredDashStrokeProblem, parseGpuSceneColor, tessellateGpuSceneAuthoredShapeGeometry, type MotionLayer, type MotionPackage } from "@shellx-motion/core";
import type { RgbaCanvas } from "./native-raster-canvas";

const SUPPORTED_STYLE_FIELDS = new Set(["fill", "color", "width", "height", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeDashoffset"]);

export interface NativeAuthoredShapeTransform {
  x: number;
  y: number;
  scale: number;
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
}

/** Consumes Core's canonical geometry and triangles; no authored path parser exists here. */
export function drawNativeAuthoredShapeGeometry(
  canvas: RgbaCanvas,
  layer: MotionLayer,
  pkg: MotionPackage,
  transform: NativeAuthoredShapeTransform,
  style: Record<string, unknown>,
  resolveToken: (value: unknown, pkg: MotionPackage) => string
): void {
  const unsupportedStyle = Object.keys(style).find((key) => !SUPPORTED_STYLE_FIELDS.has(key));
  if (unsupportedStyle) throw new Error(`Native v1 geometry ${layer.id} does not support style.${unsupportedStyle}.`);
  if (layer.gradient || layer.pathReveal) throw new Error(`Native v1 geometry ${layer.id} refuses gradients and path reveal until an exact triangle realization exists.`);
  const width = transform.width ?? finiteNumber(layer.width) ?? finiteNumber(style.width) ?? 100;
  const height = transform.height ?? finiteNumber(layer.height) ?? finiteNumber(style.height) ?? 100;
  const opacity = finiteNumber(layer.opacity) ?? 1;
  if (width <= 0 || height <= 0 || !finitePositive(transform.scale) || opacity < 0 || opacity > 1) throw new Error(`Native v1 geometry ${layer.id} has an invalid transform or opacity.`);
  const compiled = compileGpuSceneAuthoredShapeGeometry(layer);
  if (!compiled.ok) throw new Error(compiled.message);
  const fillValue = resolveToken(stringValue(layer.fill) ?? stringValue(style.fill) ?? stringValue(layer.color) ?? stringValue(style.color) ?? "#ffffff", pkg);
  const fill = parseGpuSceneColor(fillValue);
  if (!fill) throw new Error(`Native v1 geometry ${layer.id} uses unsupported fill '${fillValue}'.`);
  const strokeValue = stringValue(style.stroke);
  const stroke = strokeValue === null ? null : parseGpuSceneColor(resolveToken(strokeValue, pkg));
  if (strokeValue !== null && !stroke) throw new Error(`Native v1 geometry ${layer.id} uses unsupported stroke '${strokeValue}'.`);
  const box = scaleBox(transform, width, height);
  const dash = compiled.geometry.strokeDash ?? null;
  const strokeWidth = (compiled.geometry.stroke?.width ?? 0) * transform.scale;
  if (dash && (!stroke || stroke.a * opacity <= 0)) throw new Error(`Native v1 geometry ${layer.id} strokeDasharray requires an explicit supported visible stroke.`);
  const closedMiterProblem = gpuSceneAuthoredClosedStrokeMiterProblem(compiled.geometry);
  if (closedMiterProblem) throw new Error(closedMiterProblem);
  if (dash) {
    const dashProblem = gpuSceneAuthoredDashStrokeProblem({ geometry: compiled.geometry, box, strokeWidth, dash, dashScale: transform.scale });
    if (dashProblem) throw new Error(dashProblem);
  }
  const vertices = tessellateGpuSceneAuthoredShapeGeometry({ geometry: compiled.geometry, box, fill: { ...fill, a: fill.a * opacity }, stroke: stroke ? { ...stroke, a: stroke.a * opacity } : null, strokeWidth, dash, dashScale: transform.scale });
  if (vertices.length === 0) throw new Error(`Native v1 geometry ${layer.id} has neither a visible fill nor a visible stroke.`);
  canvas.fillFlatColoredTriangles(vertices.map((vertex) => ({ x: vertex.x, y: vertex.y, color: { r: Math.round(vertex.color.r * 255), g: Math.round(vertex.color.g * 255), b: Math.round(vertex.color.b * 255), a: Math.round(vertex.color.a * 255) } })));
}

function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function finitePositive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
function scaleBox(transform: NativeAuthoredShapeTransform, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const anchorX = transform.originX ?? width / 2, anchorY = transform.originY ?? height / 2;
  return { x: transform.x + anchorX - (anchorX * transform.scale), y: transform.y + anchorY - (anchorY * transform.scale), width: width * transform.scale, height: height * transform.scale };
}
