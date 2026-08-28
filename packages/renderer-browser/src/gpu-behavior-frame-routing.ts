import {
  compileGpuSceneBehaviorFramePlan,
  compileGpuSceneGeometryKeyframesFramePlan,
  compileGpuSceneRelationsFramePlan,
  compileGpuScene2dPlan,
  gpuVideoTimelineAtUs,
  type GpuFramePlan,
  type GpuScene2dCompileResources,
  type GpuScene2dFailure,
  type GpuSceneBehaviorFramePlan,
  type GpuSceneBehaviorStaticPlan,
  type GpuSceneGeometryKeyframesFramePlan,
  type GpuSceneGeometryKeyframesStaticPlan,
  type GpuSceneRelationsFramePlan,
  type GpuSceneRelationsStaticPlan,
  type MotionDocument
} from "@shellx-motion/core";
import { compileGpuScene3DAnimationFramePlan, type GpuScene3DAnimationFramePlan, type GpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";

export type BehaviorAwareGpuFrame = { ok: true; frame: GpuFramePlan; behaviorFramePlan?: GpuSceneBehaviorFramePlan; geometryKeyframesFramePlan?: GpuSceneGeometryKeyframesFramePlan; relationsFramePlan?: GpuSceneRelationsFramePlan; scene3dAnimationFramePlan?: GpuScene3DAnimationFramePlan } | { ok: false; failure: GpuScene2dFailure };

/** The O6 wrapper binds its exact Core frame before resource preparation or runtime open. */
export function compileGpuScene3DAnimationPreResourceFrame(motion: MotionDocument, atMs: number, staticPlan: GpuScene3DAnimationStaticPlan | undefined): BehaviorAwareGpuFrame | undefined {
  return staticPlan ? compileBehaviorAwareGpuFrame(motion, atMs, undefined, {}, undefined, undefined, staticPlan) : undefined;
}

/** Source-only preview routing: bind the Core wrapper before any resource or runtime work. */
export function compileGpuGeometryKeyframesPreResourceFrame(motion: MotionDocument, atMs: number, staticPlan: GpuSceneGeometryKeyframesStaticPlan | undefined): BehaviorAwareGpuFrame | undefined {
  return staticPlan ? compileBehaviorAwareGpuFrame(motion, atMs, undefined, {}, staticPlan) : undefined;
}

/** The sole relation executor preflights the opaque Core wrapper before Browser resources open. */
export function compileGpuRelationsPreResourceFrame(motion: MotionDocument, atMs: number, staticPlan: GpuSceneRelationsStaticPlan | undefined): BehaviorAwareGpuFrame | undefined {
  return staticPlan ? compileBehaviorAwareGpuFrame(motion, atMs, undefined, {}, undefined, staticPlan) : undefined;
}

/** The Browser GPU entrypoints share Core's one exact atMs-to-atUs bridge. */
export function compileBehaviorAwareGpuFrame(motion: MotionDocument, atMs: number, behaviorStaticPlan: GpuSceneBehaviorStaticPlan | undefined, resources: GpuScene2dCompileResources, geometryKeyframesStaticPlan?: GpuSceneGeometryKeyframesStaticPlan, relationsStaticPlan?: GpuSceneRelationsStaticPlan, scene3dAnimationStaticPlan?: GpuScene3DAnimationStaticPlan): BehaviorAwareGpuFrame {
  if (scene3dAnimationStaticPlan) {
    if (behaviorStaticPlan || geometryKeyframesStaticPlan || relationsStaticPlan) return { ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU Browser cannot combine a scene3d animation execution wrapper with behavior, geometry-keyframe, or relation wrappers." } };
    const atUs = gpuVideoTimelineAtUs(atMs);
    if (atUs === null) return { ok: false, failure: { code: "gpu_invalid_time", message: "GPU scene3d animation frame time cannot be represented as canonical integer microseconds." } };
    const scene3dAnimation = compileGpuScene3DAnimationFramePlan(motion, scene3dAnimationStaticPlan, atUs, resources);
    return scene3dAnimation.ok ? { ok: true, frame: scene3dAnimation.plan.frame, scene3dAnimationFramePlan: scene3dAnimation.plan } : scene3dAnimation;
  }
  if (relationsStaticPlan) {
    if (behaviorStaticPlan || geometryKeyframesStaticPlan) return { ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU Browser cannot combine a relation execution wrapper with behavior or geometry-keyframe wrappers." } };
    const atUs = gpuVideoTimelineAtUs(atMs);
    if (atUs === null) return { ok: false, failure: { code: "gpu_invalid_time", message: "GPU relation frame time cannot be represented as canonical integer microseconds." } };
    const relations = compileGpuSceneRelationsFramePlan(motion, relationsStaticPlan, atUs, resources);
    return relations.ok ? { ok: true, frame: relations.plan.frame, relationsFramePlan: relations.plan } : relations;
  }
  if (geometryKeyframesStaticPlan) {
    if (behaviorStaticPlan) return { ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU Browser cannot combine behavior and geometry-keyframe execution wrappers." } };
    const atUs = gpuVideoTimelineAtUs(atMs);
    if (atUs === null) return { ok: false, failure: { code: "gpu_invalid_time", message: "GPU geometry-keyframe frame time cannot be represented as canonical integer microseconds." } };
    const geometry = compileGpuSceneGeometryKeyframesFramePlan(motion, geometryKeyframesStaticPlan, atUs, resources);
    return geometry.ok ? { ok: true, frame: geometry.plan.frame, geometryKeyframesFramePlan: geometry.plan } : geometry;
  }
  if (!behaviorStaticPlan) {
    const legacy = compileGpuScene2dPlan(motion, atMs, resources);
    return legacy.ok ? { ok: true, frame: legacy.plan.frame } : legacy;
  }
  const atUs = gpuVideoTimelineAtUs(atMs);
  if (atUs === null) return { ok: false, failure: { code: "gpu_invalid_time", message: "GPU behavior frame time cannot be represented as canonical integer microseconds." } };
  const behavior = compileGpuSceneBehaviorFramePlan(motion, atUs, resources);
  return behavior.ok ? { ok: true, frame: behavior.plan.frame, behaviorFramePlan: behavior.plan } : behavior;
}
