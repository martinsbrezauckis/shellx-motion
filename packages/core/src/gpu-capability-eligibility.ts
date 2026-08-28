import { compileGpuSceneBehaviorStaticPlan } from "./gpu-scene-behavior-composition";
import { compileGpuSceneGeometryKeyframesStaticPlan } from "./gpu-scene-geometry-keyframes-composition";
import { gpuUnloweredRootAuthorityRefusal } from "./gpu-root-authority-fence";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { requiredLayerFeatures } from "./layer-capability-features";
import type { CapabilityMatch, MotionDocument, RendererCapability } from "./types";

/**
 * The GPU card names bounded primitives, not arbitrary combinations of those primitives.
 * Static planning is the common fail-closed authority used before resource staging and runtime
 * launch, so capability selection must take the same path instead of treating feature names as
 * independently composable promises.
 */
export function matchGpuSceneCapability(motion: MotionDocument, capability: RendererCapability): CapabilityMatch {
  const rootAuthorityRefusal = gpuUnloweredRootAuthorityRefusal(motion, "capability");
  if (rootAuthorityRefusal) {
    return {
      ok: false,
      lane: "gpu",
      unsupported: [{
        layerId: "document",
        feature: "gpu.scene.eligibility",
        reason: `Lane gpu refuses this bounded scene: ${rootAuthorityRefusal}`,
      }],
    };
  }
  const unsupportedTypes = motion.layers
    .filter((layer) => layer.visible !== false && !capability.layerTypes.includes(layer.type))
    .map((layer) => ({
      layerId: layer.id,
      feature: `layer.type:${layer.type}`,
      reason: `Lane gpu does not support ${layer.type} layers.`
    }));
  if (unsupportedTypes.length > 0) return { ok: false, lane: "gpu", unsupported: unsupportedTypes };
  const hasGeometryKeyframes = motion.layers.some((layer) => layer.visible !== false && layer.geometryKeyframes !== undefined);
  const unsupportedFeatures = motion.layers.flatMap((layer) => {
    if (layer.visible === false) return [];
    return requiredLayerFeatures(layer)
      .filter((feature) => feature === "text.runs.v1" || (feature === "shape.geometry.keyframes" && !capability.features.includes(feature)))
      .map((feature) => ({ layerId: layer.id, feature, reason: `Lane gpu does not support ${feature} on layer ${layer.id}.` }));
  });
  if (unsupportedFeatures.length > 0) return { ok: false, lane: "gpu", unsupported: unsupportedFeatures };
  const result = hasGeometryKeyframes
    ? compileGpuSceneGeometryKeyframesStaticPlan(motion)
    : motion.behaviors === undefined
    ? compileGpuSceneStaticPlan(motion)
    : compileGpuSceneBehaviorStaticPlan(motion);
  if (result.ok) return { ok: true, lane: "gpu", unsupported: [] };
  const failure = result.failure;
  return {
    ok: false,
    lane: "gpu",
    unsupported: [{
      layerId: failure.layerId ?? "document",
      feature: "gpu.scene.eligibility",
      reason: `Lane gpu refuses this bounded scene: ${failure.message}`
    }]
  };
}
