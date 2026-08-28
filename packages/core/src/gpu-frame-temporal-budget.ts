import { MAX_ENVIRONMENT_LAYERS } from "./environment";
import { gpuDrawNeedsComposite } from "./gpu-frame-intent-composite";
import type { GpuDrawIntent } from "./gpu-frame-intent-types";
import { GPU_MAX_TEMPORAL_SAMPLES } from "./gpu-frame-motion-blur";

/** Frame work counts every shutter sample; source admission still caps four active layers. */
export const GPU_MAX_ACTIVE_ENVIRONMENT_LAYERS = MAX_ENVIRONMENT_LAYERS;
export const GPU_MAX_ENVIRONMENT_DRAW_WORK = GPU_MAX_ACTIVE_ENVIRONMENT_LAYERS * GPU_MAX_TEMPORAL_SAMPLES;

/** One temporal group performs additive sample passes then one outer composite. */
export function gpuTemporalCompositeCount(draws: readonly GpuDrawIntent[]): number {
  let count = 0;
  for (let index = 0; index < draws.length; index += 1) {
    const draw = draws[index];
    if (draw.kind === "motionBlurStart") { count += 1; index += draw.drawCount + 1; continue; }
    if (gpuDrawNeedsComposite(draw)) count += 1;
  }
  return count;
}
