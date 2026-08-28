import type { MotionDocument, MotionLayer } from "@shellx-motion/core";
import type { InternalGpuFramePlan } from "./gpu-runtime-types";

export interface GpuEnvironmentSessionEnvelope {
  readonly width: number;
  readonly height: number;
  readonly groupDepth: number;
  readonly keyCleanup: boolean;
  readonly needsDepth: boolean;
}

/**
 * Environment sessions freeze only the static timeline's complete attachment
 * union. Non-environment sessions retain the pre-existing adaptable arena.
 */
export function deriveGpuEnvironmentSessionEnvelope(staticPlan: {
  readonly maxima: { readonly maxEnvironmentCount: number; readonly maxScene3dCount: number };
  readonly layers: readonly { readonly id: string; readonly type: string; readonly groupDepth: number }[];
}, motion: MotionDocument): GpuEnvironmentSessionEnvelope | null {
  if (staticPlan.maxima.maxEnvironmentCount === 0) return null;
  const layers = new Map(motion.layers.map((layer) => [layer.id, layer]));
  const keyCleanup = staticPlan.layers.some((topology) => {
    if (topology.type !== "image" && topology.type !== "video") return false;
    const layer = layers.get(topology.id);
    return layer !== undefined && requiresChromaMatteCleanup(layer);
  });
  return Object.freeze({
    width: motion.width,
    height: motion.height,
    groupDepth: staticPlan.layers.reduce((depth, layer) => Math.max(depth, layer.groupDepth - 1), 0),
    keyCleanup,
    needsDepth: staticPlan.maxima.maxScene3dCount > 0
  });
}

export function deriveGpuEnvironmentFrameEnvelope(plan: InternalGpuFramePlan): GpuEnvironmentSessionEnvelope | null {
  if (plan.budget.environmentCount === 0) return null;
  return Object.freeze({
    width: plan.width,
    height: plan.height,
    groupDepth: plan.budget.groupMaxDepth,
    keyCleanup: plan.budget.chromaMatteCleanupCount > 0,
    needsDepth: plan.budget.scene3dCount > 0
  });
}

function requiresChromaMatteCleanup(layer: MotionLayer): boolean {
  const matte = layer.keying?.matte;
  return matte !== undefined && (
    (matte.denoiseRadiusPx ?? 0) !== 0
    || (matte.growShrinkPx ?? 0) !== 0
    || (matte.chokePx ?? 0) !== 0
    || (matte.featherPx ?? 0) !== 0
    || (matte.blackClip ?? 0) !== 0
    || (matte.whiteClip ?? 1) !== 1
  );
}
