import type { GpuDrawIntent, GpuLayerMaskIntent, GpuLayerEffects, GpuPrimitiveIntent, GpuRgba } from "./gpu-frame-intent";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { effectiveLayerAtMs } from "./timeline";
import type { MotionLayer } from "./types";

type CompileSample = (layer: MotionLayer, atMs: number) => { ok: true; draws: GpuPrimitiveIntent[] } | { ok: false; failure: GpuScene2dFailure };

/** Lowers one authored motion-blur effect into a flat, bounded isolated group. */
export function compileGpuSceneMotionBlur(
  sourceLayer: MotionLayer,
  currentDraws: GpuPrimitiveIntent[],
  atMs: number,
  fps: number,
  compileSample: CompileSample
): { ok: true; draws: GpuDrawIntent[]; sampleCount: number } | { ok: false; failure: GpuScene2dFailure } {
  const motionBlur = sourceLayer.effects?.motionBlur;
  if (!motionBlur) return { ok: true, draws: currentDraws, sampleCount: 0 };
  if (currentDraws.length === 0) return { ok: false, failure: { code: "gpu_resource_refused", message: "GPU motion blur requires at least one admitted primitive.", layerId: sourceLayer.id } };
  const shutterDurationMs = (1_000 / fps) * (motionBlur.shutterAngle / 360);
  const times = temporalSampleTimes(sourceLayer, atMs, motionBlur.samples, shutterDurationMs);
  const samples: GpuPrimitiveIntent[] = [];
  for (const [sampleIndex, sampleAtMs] of times.entries()) {
    const compiled = compileSample(effectiveLayerAtMs(sourceLayer, sampleAtMs), sampleAtMs);
    if (!compiled.ok) return compiled;
    compiled.draws.forEach((draw, primitiveIndex) => samples.push(scaleSample(draw, motionBlur.samples, `${sourceLayer.id}.sample-${sampleIndex}.${primitiveIndex}`)));
  }
  const composite = compositeOf(currentDraws[0]);
  const groupId = `${sourceLayer.id}.motion-blur`;
  return { ok: true, sampleCount: motionBlur.samples, draws: [
    { kind: "motionBlurStart", id: groupId, sampleCount: motionBlur.samples, drawCount: samples.length, shutterAngle: motionBlur.shutterAngle, shutterDurationMs, ...composite },
    ...samples,
    { kind: "motionBlurEnd", id: `${groupId}.end`, groupId }
  ] };
}

export function temporalSampleTimes(layer: MotionLayer, atMs: number, samples: number, shutterDurationMs: number): number[] {
  const earliest = layer.startMs; const latest = Math.max(earliest, layer.startMs + layer.durationMs - 0.001);
  return Array.from({ length: samples }, (_value, index) => clamp(atMs + ((index / (samples - 1)) - 0.5) * shutterDurationMs, earliest, latest));
}

function compositeOf(draw: GpuPrimitiveIntent): { blendMode: GpuPrimitiveIntent["blendMode"]; effects: GpuLayerEffects | null; mask?: GpuLayerMaskIntent } {
  return { blendMode: draw.blendMode, effects: draw.effects, ...(draw.mask ? { mask: draw.mask } : {}) };
}

function scaleSample(draw: GpuPrimitiveIntent, samples: number, id: string): GpuPrimitiveIntent {
  const base = { ...draw, id, blendMode: "normal" as const, effects: null, mask: undefined };
  if (base.kind === "rect" || base.kind === "triangles") return { ...base, color: alpha(base.color, samples) };
  if (base.kind === "ellipse") return { ...base, color: alpha(base.color, samples), stroke: alpha(base.stroke, samples) };
  if (base.kind === "coloredTriangles") return { ...base, vertices: base.vertices.map((vertex) => ({ ...vertex, color: alpha(vertex.color, samples) })) };
  if (base.kind === "points") return { ...base, points: base.points.map((point) => ({ ...point, color: alpha(point.color, samples) })) };
  if (base.kind === "particleCompute" || base.kind === "scene3d" || base.kind === "material") throw new Error(`GPU ${base.kind} draws cannot enter temporal motion blur.`);
  if (base.kind === "image" || base.kind === "text") return { ...base, opacity: base.opacity / samples };
  if (base.kind === "gradientRect") return { ...base, stops: base.stops.map((stop) => ({ ...stop, color: alpha(stop.color, samples) })) };
  // Environment colors are straight shader inputs. The fixed environment WGSL
  // applies draw opacity when it flattens the generated result, so scaling the
  // colors as well would square alpha in uncovered scene/overlay regions.
  if (base.kind === "environment") return { ...base, opacity: base.opacity / samples };
  return { ...base, fill: alpha(base.fill, samples), stroke: alpha(base.stroke, samples), shadow: base.shadow ? { ...base.shadow, color: alpha(base.shadow.color, samples) } : null };
}

function alpha(color: GpuRgba, samples: number): GpuRgba { return { ...color, a: color.a / samples }; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
