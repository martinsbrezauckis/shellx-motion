/** Exact defensive cloning for the four durable GPU identity families. */
import type { RenderSegmentGpuBaseIdentity, RenderSegmentGpuHybridIdentity, RenderSegmentGpuIdentity, RenderSegmentGpuStandardIdentity } from "./render-segment-store-types.js";
import type { RenderSegmentGpuEffectModuleIdentity } from "./render-segment-gpu-effect-module-types.js";
import type { RenderSegmentGpuBehaviorIdentity, RenderSegmentGpuBehaviorRangeIdentity } from "./render-segment-gpu-behavior-types.js";

function cloneGpuBaseIdentity(value: Readonly<RenderSegmentGpuBaseIdentity>) {
  return {
    packageContentSha256: value.packageContentSha256, pipelineCatalogSha256: value.pipelineCatalogSha256,
    staticPlan: { ...value.staticPlan }, staticScene: { ...value.staticScene },
    hostVerdict: { ...value.hostVerdict, browser: { ...value.hostVerdict.browser }, containment: { ...value.hostVerdict.containment }, session: { ...value.hostVerdict.session } },
    ...(value.videoStaging ? { videoStaging: { ...value.videoStaging } } : {})
  };
}

export function cloneGpuIdentity(value: Readonly<RenderSegmentGpuIdentity>): RenderSegmentGpuStandardIdentity | RenderSegmentGpuHybridIdentity | RenderSegmentGpuEffectModuleIdentity | RenderSegmentGpuBehaviorIdentity {
  const shared = cloneGpuBaseIdentity(value);
  if (value.schema === "shellx-motion/gpu-segmented-identity@1") return { ...shared, schema: value.schema } as RenderSegmentGpuStandardIdentity;
  if (value.schema === "shellx-motion/gpu-effect-module-segmented-identity@1") return {
    ...shared, schema: value.schema,
    effectModules: { schema: value.effectModules.schema, descriptors: value.effectModules.descriptors.map((descriptor) => structuredClone(descriptor)), descriptorSequenceSha256: value.effectModules.descriptorSequenceSha256 }
  } as RenderSegmentGpuEffectModuleIdentity;
  if (value.schema === "shellx-motion/gpu-behavior-segmented-identity@1") return {
    ...shared, schema: value.schema,
    behaviors: {
      staticFingerprint: value.behaviors.staticFingerprint, baseStaticFingerprint: value.behaviors.baseStaticFingerprint,
      behaviorStaticFingerprint: value.behaviors.behaviorStaticFingerprint, behaviorSourceSha256: value.behaviors.behaviorSourceSha256,
      targetLayerIds: [...value.behaviors.targetLayerIds], staticBudget: { ...value.behaviors.staticBudget },
      frames: value.behaviors.frames.map((frame) => ({ ...frame })),
      framePlanSequenceSha256: value.behaviors.framePlanSequenceSha256,
      frameBudgetSequenceSha256: value.behaviors.frameBudgetSequenceSha256
    }
  } as RenderSegmentGpuBehaviorIdentity;
  return {
    ...shared, schema: value.schema,
    hybrid: { admission: structuredClone(value.hybrid.admission), capturePlan: { ...value.hybrid.capturePlan, entries: value.hybrid.capturePlan.entries.map((entry) => ({ ...entry })) } }
  } as RenderSegmentGpuHybridIdentity;
}

export function cloneGpuBehaviorRangeIdentity(value: Readonly<RenderSegmentGpuBehaviorRangeIdentity>): RenderSegmentGpuBehaviorRangeIdentity {
  return {
    ...cloneGpuBaseIdentity(value), schema: value.schema,
    behaviors: {
      staticFingerprint: value.behaviors.staticFingerprint, baseStaticFingerprint: value.behaviors.baseStaticFingerprint,
      behaviorStaticFingerprint: value.behaviors.behaviorStaticFingerprint, behaviorSourceSha256: value.behaviors.behaviorSourceSha256,
      targetLayerIds: [...value.behaviors.targetLayerIds], staticBudget: { ...value.behaviors.staticBudget },
      framePlanSequenceSha256: value.behaviors.framePlanSequenceSha256, frameBudgetSequenceSha256: value.behaviors.frameBudgetSequenceSha256
    }
  } as RenderSegmentGpuBehaviorRangeIdentity;
}

export function cloneGpuEffectModuleRangeUse<T>(value: T): T { return structuredClone(value); }
