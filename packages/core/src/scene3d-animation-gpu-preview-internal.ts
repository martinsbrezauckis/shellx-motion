/** Shipping-only renderer bridge; not part of the public Core barrel. */
export {
  compileGpuScene3DAnimationFramePlan,
  compileGpuScene3DAnimationStaticPlan,
  gpuScene3DAnimationAdmittedMotion,
  GPU_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA,
  GPU_SCENE3D_ANIMATION_PREVIEW_LIMITS,
  GPU_SCENE3D_ANIMATION_STATIC_PLAN_SCHEMA,
} from "./gpu-scene3d-animation-composition";
export type {
  GpuScene3DAnimationFramePlan,
  GpuScene3DAnimationFramePlanResult,
  GpuScene3DAnimationPreviewLimits,
  GpuScene3DAnimationStaticPlan,
  GpuScene3DAnimationStaticPlanResult,
} from "./gpu-scene3d-animation-composition";
