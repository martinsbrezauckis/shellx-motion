import { compileGpuSceneRelationsStaticPlan } from "./gpu-scene-relations-composition";
import { motionRelationStorePresent } from "./motion-relation-lane-refusal";
import type { CapabilityMatch, MotionDocument, RendererCapability, RendererCapabilityMatchOptions } from "./types";

/**
 * Relations remain unavailable to generic GPU matching. This separate route is callable only by
 * explicit capability-card preview selection, where Browser owns the opaque wrapper execution.
 */
export function gpuRelationsStrictPreviewCapabilityMatch(
  motion: MotionDocument,
  capability: RendererCapability,
  options: RendererCapabilityMatchOptions,
): CapabilityMatch | undefined {
  if (!motionRelationStorePresent(motion) || capability.lane !== "gpu" || options.target !== "preview") return undefined;
  if (options.output !== "png-frame") return strictPreviewOutputRefusal(options.output);
  const result = compileGpuSceneRelationsStaticPlan(motion);
  if (result.ok) return { ok: true, lane: "gpu", unsupported: [] };
  return {
    ok: false,
    lane: "gpu",
    unsupported: [{
      layerId: result.failure.layerId ?? "__motion_relations__",
      feature: "motion.relations@1.strict-browser-gpu-preview",
      reason: `Strict Browser GPU relation preview refuses this scene: ${result.failure.message}`,
    }],
  };
}

function strictPreviewOutputRefusal(output: string | undefined): CapabilityMatch {
  return {
    ok: false,
    lane: "gpu",
    unsupported: [{
      layerId: "__motion_relations__",
      feature: "motion.relations@1.strict-browser-gpu-preview",
      reason: output === undefined
        ? "Strict Browser GPU relation preview requires the exact png-frame output."
        : `Strict Browser GPU relation preview produces only png-frame output, not ${output}.`,
    }],
  };
}
