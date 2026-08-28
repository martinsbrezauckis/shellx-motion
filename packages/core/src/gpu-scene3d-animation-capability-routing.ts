import { compileGpuScene3DAnimationStaticPlan } from "./gpu-scene3d-animation-composition";
import { motionScene3DAnimationStorePresent } from "./motion-scene3d-animation-lane-refusal";
import type { CapabilityMatch, MotionDocument, RendererCapability, RendererCapabilityMatchOptions } from "./types";

export const GPU_SCENE3D_ANIMATION_STRICT_PREVIEW_FEATURE = "motion.scene3d-animation@1.strict-browser-gpu-preview" as const;

/** The O6 wrapper is discoverable only when the caller asks for its exact preview artifact. */
export function gpuScene3DAnimationStrictPreviewCapabilityMatch(
  motion: MotionDocument,
  capability: RendererCapability,
  options: RendererCapabilityMatchOptions,
): CapabilityMatch | undefined {
  if (!motionScene3DAnimationStorePresent(motion) || capability.lane !== "gpu" || options.target !== "preview") return undefined;
  if (options.output !== "png-frame") return outputRefusal(options.output);
  const result = compileGpuScene3DAnimationStaticPlan(motion);
  if (result.ok) return { ok: true, lane: "gpu", unsupported: [] };
  return {
    ok: false,
    lane: "gpu",
    unsupported: [{
      layerId: result.failure.layerId ?? "__scene3d_animation__",
      feature: GPU_SCENE3D_ANIMATION_STRICT_PREVIEW_FEATURE,
      reason: `Strict Browser GPU scene3d animation preview refuses this scene: ${result.failure.message}`,
    }],
  };
}

function outputRefusal(output: string | undefined): CapabilityMatch {
  return {
    ok: false,
    lane: "gpu",
    unsupported: [{
      layerId: "__scene3d_animation__",
      feature: GPU_SCENE3D_ANIMATION_STRICT_PREVIEW_FEATURE,
      reason: output === undefined
        ? "Strict Browser GPU scene3d animation preview requires the exact png-frame output."
        : `Strict Browser GPU scene3d animation preview produces only png-frame output, not ${output}.`,
    }],
  };
}
