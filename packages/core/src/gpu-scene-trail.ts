import { createHash } from "node:crypto";
import {
  MAX_ACTIVE_TRAIL_VERTICES,
  MAX_TRAIL_DURATION_MS,
  MAX_TRAIL_SAMPLES,
  MIN_TRAIL_SAMPLES,
  evaluateMotionTrail,
  motionTrailForLayer,
  planMotionTrailStroke,
  type MotionTrailSegment
} from "./motion-trail";
import { GPU_MAX_TRIANGLE_VERTICES, type GpuPrimitiveIntent, type GpuRgba } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import type { MotionLayer } from "./types";

export interface GpuSceneTrailResult {
  ok: true;
  draws: GpuPrimitiveIntent[];
  pointCount: number;
  triangleVertexCount: number;
}

/** Validates the existing stateless, bounded trail contract before GPU lowering. */
export function gpuSceneTrailProblem(layer: MotionLayer): string | null {
  const declared = layer.effects?.trail;
  if (!declared) return null;
  if (layer.type !== "points" && layer.type !== "particles") return "GPU trails are available only on points and particle layers.";
  const trail = motionTrailForLayer(layer);
  if (!trail || trail.durationMs < 1 || trail.durationMs > MAX_TRAIL_DURATION_MS || trail.samples < MIN_TRAIL_SAMPLES || trail.samples > MAX_TRAIL_SAMPLES) {
    return "GPU trails require the bounded static durationMs and samples contract.";
  }
  if (!Number.isInteger(trail.samples)) return "GPU trail samples must be an integer.";
  return null;
}

/**
 * Resolves Core-owned trail geometry at an exact timestamp, then lowers it to
 * fixed GPU triangles plus instanced round caps. There is no persistent trail
 * history texture or package-selected compute program.
 */
export function compileGpuSceneTrail(input: {
  layer: MotionLayer;
  atMs: number;
  dimensions: { width: number; height: number };
  viewport: { width: number; height: number };
  transform: { x: number; y: number; scale: number; originX: number; originY: number; rotation: number };
  fallbackColor: string;
  opacity: number;
}): GpuSceneTrailResult | { ok: false; message: string } {
  const problem = gpuSceneTrailProblem(input.layer);
  if (problem) return { ok: false, message: problem };
  if (!input.layer.effects?.trail) return { ok: true, draws: [], pointCount: 0, triangleVertexCount: 0 };
  try {
    const geometry = evaluateMotionTrail({ layer: input.layer, atMs: input.atMs, particleDimensions: input.dimensions });
    if (geometry.vertices > MAX_ACTIVE_TRAIL_VERTICES) return { ok: false, message: `GPU trail vertices exceed ${MAX_ACTIVE_TRAIL_VERTICES}.` };
    const stroke = planMotionTrailStroke({ segments: geometry.segments, transform: input.transform, clip: input.viewport });
    if (stroke.segments.length * 6 > GPU_MAX_TRIANGLE_VERTICES) return { ok: false, message: `GPU trail triangles exceed ${GPU_MAX_TRIANGLE_VERTICES} vertices.` };
    return lowerTrail(stroke.segments, input);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "GPU trail geometry could not be admitted." };
  }
}

function lowerTrail(segments: readonly MotionTrailSegment[], input: Parameters<typeof compileGpuSceneTrail>[0]): GpuSceneTrailResult | { ok: false; message: string } {
  const vertices: Array<{ x: number; y: number; color: GpuRgba }> = [];
  const caps: Array<{ x: number; y: number; size: number; color: GpuRgba }> = [];
  for (const segment of segments) {
    const color = parseGpuSceneColor(segment.color ?? input.fallbackColor);
    if (!color) return { ok: false, message: `GPU trail layer ${input.layer.id} uses an unsupported trail color.` };
    const paint = { ...color, a: color.a * segment.opacity * input.opacity };
    const deltaX = segment.x1 - segment.x0;
    const deltaY = segment.y1 - segment.y0;
    const length = Math.hypot(deltaX, deltaY);
    if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(segment.width) || segment.width <= 0) continue;
    const half = segment.width / 2;
    const normalX = (-deltaY / length) * half;
    const normalY = (deltaX / length) * half;
    const a = { x: segment.x0 + normalX, y: segment.y0 + normalY, color: paint };
    const b = { x: segment.x0 - normalX, y: segment.y0 - normalY, color: paint };
    const c = { x: segment.x1 + normalX, y: segment.y1 + normalY, color: paint };
    const d = { x: segment.x1 - normalX, y: segment.y1 - normalY, color: paint };
    vertices.push(a, b, c, c, b, d);
    caps.push({ x: segment.x0, y: segment.y0, size: segment.width, color: paint }, { x: segment.x1, y: segment.y1, size: segment.width, color: paint });
  }
  if (vertices.length === 0) return { ok: true, draws: [], pointCount: 0, triangleVertexCount: 0 };
  const id = `trail-${createHash("sha256").update(input.layer.id, "utf8").digest("hex").slice(0, 16)}`;
  // The persistent compositor already isolates any non-normal primitive draw and
  // applies the declared fixed blend formula. Keep the ribbon and its round caps
  // in the same declared mode as the point/particle head, without adding a new
  // trail-specific compositor or package-selected shader.
  const blendMode = input.layer.blendMode ?? "normal";
  return {
    ok: true,
    draws: [
      { kind: "coloredTriangles", id: `${id}.ribbon`, blendMode, effects: null, vertices, rotationDeg: 0, pivotX: 0, pivotY: 0 },
      { kind: "points", id: `${id}.caps`, blendMode, effects: null, seed: 0, instanceBufferMode: "dynamic", points: caps }
    ],
    pointCount: caps.length,
    triangleVertexCount: vertices.length
  };
}
