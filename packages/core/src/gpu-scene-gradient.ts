import type { GpuDrawIntent } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import type { MotionLayer } from "./types";

export type GpuSceneGradientResult =
  | { ok: true; paint: Pick<Extract<GpuDrawIntent, { kind: "gradientRect" }>, "gradientType" | "angleDeg" | "centerX" | "centerY" | "stops"> }
  | { ok: false; code: "gpu_unsupported_feature" | "gpu_unsupported_color"; message: string };

/** Resolves only finite, ordered, fixed-pipeline gradient data. */
export function compileGpuSceneGradient(layer: MotionLayer, opacity: number): GpuSceneGradientResult {
  const gradient = layer.gradient;
  if (!gradient || (gradient.type !== "linear" && gradient.type !== "radial") || gradient.stops.length < 2 || gradient.stops.length > 16) return problem("gpu_unsupported_feature", `GPU scene layer ${layer.id} has an invalid gradient.`);
  let prior = -1;
  const stops = [];
  for (const [index, stop] of gradient.stops.entries()) {
    if (!Number.isFinite(stop.offset) || stop.offset < prior || stop.offset < 0 || stop.offset > 1) return problem("gpu_unsupported_feature", `GPU scene layer ${layer.id} gradient stop ${index} is invalid or unordered.`);
    const color = parseGpuSceneColor(stop.color);
    if (!color) return problem("gpu_unsupported_color", `GPU scene layer ${layer.id} gradient stop ${index} uses unsupported color '${stop.color}'.`);
    prior = stop.offset;
    stops.push({ offset: stop.offset, color: { ...color, a: color.a * opacity } });
  }
  const angleDeg = finiteNumber(gradient.angle ?? 180);
  const centerX = finiteNumber(gradient.centerX ?? 0.5);
  const centerY = finiteNumber(gradient.centerY ?? 0.5);
  if (angleDeg === null || centerX === null || centerY === null || centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1) return problem("gpu_unsupported_feature", `GPU scene layer ${layer.id} has invalid gradient geometry.`);
  return { ok: true, paint: { gradientType: gradient.type, angleDeg, centerX, centerY, stops } };
}

function finiteNumber(value: number): number | null { return Number.isFinite(value) ? value : null; }
function problem(code: "gpu_unsupported_feature" | "gpu_unsupported_color", message: string): Extract<GpuSceneGradientResult, { ok: false }> { return { ok: false, code, message }; }
