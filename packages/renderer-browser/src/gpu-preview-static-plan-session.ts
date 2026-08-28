import type { MotionPackage } from "@shellx-motion/core";
import type { GpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";
import { resolveGpuEffectModuleStaticPlanForUse } from "./gpu-effect-module-use-authority";
import { prepareGpuSceneResources, type PreparedGpuSceneResources } from "./gpu-scene-resources";

type StaticPlan = Awaited<ReturnType<typeof resolveGpuEffectModuleStaticPlanForUse>>;

interface GpuPreviewStaticPlanSessionInput {
  pkg: MotionPackage;
  effectModuleAuthority: Parameters<typeof resolveGpuEffectModuleStaticPlanForUse>[1];
  prepareResources?: (pkg: MotionPackage) => Promise<PreparedGpuSceneResources>;
  admittedO6Package(): MotionPackage | undefined;
}

/** Retains the resolved plan and resource promise while O6 swaps only the Motion package façade. */
export function createGpuPreviewStaticPlanSession(input: GpuPreviewStaticPlanSessionInput) {
  let staticPlan: StaticPlan | undefined, staticPlanPromise: Promise<StaticPlan> | undefined;
  let preparedResources: Promise<PreparedGpuSceneResources> | undefined;
  let packageHasVideo = false, expectedVideoLayers = new Map<string, string>(), expectedVideoSourceCount = 0;
  const resolve = async (scene3dAnimationPlan?: GpuScene3DAnimationStaticPlan): Promise<StaticPlan> => {
    staticPlan ??= await (staticPlanPromise ??= scene3dAnimationPlan
      ? Promise.resolve({ ok: true, plan: scene3dAnimationPlan.basePlan, scene3dAnimationPlan })
      : resolveGpuEffectModuleStaticPlanForUse(input.pkg.motion, input.effectModuleAuthority));
    if (staticPlan.ok) {
      packageHasVideo = staticPlan.plan.maxima.maxVideoCount > 0;
      expectedVideoLayers = new Map(staticPlan.plan.resources.filter((resource) => resource.kind === "video").flatMap((resource) => resource.consumers.map((consumer) => [consumer.layerId, resource.assetRef] as const)));
      expectedVideoSourceCount = new Set(expectedVideoLayers.values()).size;
    }
    return staticPlan;
  };
  const resources = (): Promise<PreparedGpuSceneResources> => {
    preparedResources ??= (input.prepareResources ?? prepareGpuSceneResources)(input.admittedO6Package() ?? input.pkg);
    return preparedResources;
  };
  return {
    resolve,
    resources,
    get packageHasVideo() { return packageHasVideo; },
    get expectedVideoLayers() { return expectedVideoLayers; },
    get expectedVideoSourceCount() { return expectedVideoSourceCount; },
  };
}
