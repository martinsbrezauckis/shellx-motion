import type { GpuDrawIntent } from "./gpu-frame-intent-types";

type CompositeDraw = Exclude<GpuDrawIntent, { kind: "adjustment" | "motionBlurEnd" | "groupEnd" }>;

export function isGpuCompositeDraw(draw: GpuDrawIntent): draw is CompositeDraw { return draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd"; }
export function gpuDrawHasChromaMatteCleanup(draw: GpuDrawIntent): boolean {
  if (!isGpuCompositeDraw(draw) || draw.kind !== "image" || !draw.chromaKey) return false;
  const matte = draw.chromaKey.matte;
  return matte.denoiseRadiusPx !== 0 || matte.growShrinkPx !== 0 || matte.chokePx !== 0 || matte.featherPx !== 0 || matte.blackClip !== 0 || matte.whiteClip !== 1;
}
export function gpuChromaMatteCleanupPassCount(draw: GpuDrawIntent): number {
  if (!gpuDrawHasChromaMatteCleanup(draw) || draw.kind !== "image") return 0;
  const matte = draw.chromaKey!.matte;
  return Number(matte.denoiseRadiusPx > 0) * 2 + Number(matte.growShrinkPx !== 0) * 2 + Number(matte.chokePx > 0) * 2 + Number(matte.featherPx > 0) * 2 + 1;
}
export function gpuDrawNeedsComposite(draw: GpuDrawIntent): boolean { return isGpuCompositeDraw(draw) && (draw.kind === "environment" || draw.kind === "material" || draw.kind === "motionBlurStart" || draw.kind === "groupStart" || gpuDrawHasChromaMatteCleanup(draw) || draw.blendMode !== "normal" || draw.effects !== null || draw.mask !== undefined); }
export function gpuDrawHasMask(draw: GpuDrawIntent): boolean { return isGpuCompositeDraw(draw) && draw.mask !== undefined; }
export function gpuDrawHasBlur(draw: GpuDrawIntent): boolean { return isGpuCompositeDraw(draw) && (draw.effects?.blur ?? 0) > 0; }
export function gpuDrawHasGlow(draw: GpuDrawIntent): boolean { return isGpuCompositeDraw(draw) && draw.effects?.glow !== null && draw.effects?.glow !== undefined; }
export function gpuDrawHasBlurredGlow(draw: GpuDrawIntent): boolean { return isGpuCompositeDraw(draw) && (draw.effects?.glow?.radius ?? 0) > 0; }
export function gpuDrawHasColorEffects(draw: GpuDrawIntent): boolean { if (!isGpuCompositeDraw(draw)) return false; const effect = draw.effects; return effect !== null && (effect.brightness !== 1 || effect.contrast !== 1 || effect.saturate !== 1 || effect.grayscale !== 0); }
