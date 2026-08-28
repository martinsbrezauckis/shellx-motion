import type { GpuDrawIntent, GpuPrimitiveIntent } from "./gpu-frame-intent";
import { gpuSceneEffects } from "./gpu-scene-effects";
import { compileGpuSceneMotionBlur } from "./gpu-scene-motion-blur";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import type { MotionLayer } from "./types";

type PrimitiveResult = { ok: true; draws: GpuPrimitiveIntent[] } | { ok: false; failure: GpuScene2dFailure };

/** Applies one layer-level composite to the combined trail ribbon, caps and head. */
export function compileGpuSceneTrailComposite(input: {
  sourceLayer: MotionLayer;
  layer: MotionLayer;
  draws: GpuPrimitiveIntent[];
  atMs: number;
  fps: number;
  compileSample: (layer: MotionLayer, atMs: number) => PrimitiveResult;
}): { ok: true; draws: GpuDrawIntent[]; sampleCount: number } | { ok: false; failure: GpuScene2dFailure } {
  const effects = gpuSceneEffects(input.layer);
  const isolate = Boolean(input.layer.effects?.trail) && ((input.layer.blendMode ?? "normal") !== "normal" || effects !== null);
  if (!isolate) return compileGpuSceneMotionBlur(input.sourceLayer, input.draws, input.atMs, input.fps, input.compileSample);
  const normalized = normalize(input.draws);
  if (input.sourceLayer.effects?.motionBlur) {
    const current = withCompositeCarrier(normalized, input.layer);
    return compileGpuSceneMotionBlur(input.sourceLayer, current, input.atMs, input.fps, (sample, sampleAtMs) => {
      const compiled = input.compileSample(sample, sampleAtMs);
      return compiled.ok ? { ok: true, draws: normalize(compiled.draws) } : compiled;
    });
  }
  const groupId = `${input.layer.id}.trail-composite`;
  return { ok: true, sampleCount: 0, draws: [
    { kind: "groupStart", id: groupId, drawCount: normalized.length, x: 0, y: 0, scale: 1, rotationDeg: 0, pivotX: 0, pivotY: 0, opacity: 1, blendMode: input.layer.blendMode ?? "normal", effects },
    ...normalized,
    { kind: "groupEnd", id: `${groupId}.end`, groupId }
  ] };
}

function normalize(draws: readonly GpuPrimitiveIntent[]): GpuPrimitiveIntent[] {
  return draws.map((draw) => ({ ...draw, blendMode: "normal", effects: null, mask: undefined }));
}

function withCompositeCarrier(draws: GpuPrimitiveIntent[], layer: MotionLayer): GpuPrimitiveIntent[] {
  if (draws.length === 0) return draws;
  return [{ ...draws[0], blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer) }, ...draws.slice(1)];
}
