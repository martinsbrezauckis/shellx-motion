/**
 * Reviewed pre-adoption C5C1A facade. This has no MotionDocument, public Core barrel,
 * package export, renderer, Debug, CLI, SDK, or capability-card join.
 */
export { evaluateMotionScene3DAnimationPlan } from "../../motion-scene3d-animation-evaluate";
export { compileMotionScene3DAnimationPlan } from "../../motion-scene3d-animation-plan";
export type {
  MotionScene3DAnimationDescriptor,
  MotionScene3DAnimationFramePlan,
  MotionScene3DAnimationFramePlanResult,
  MotionScene3DAnimationLocator,
  MotionScene3DAnimationPlan,
  MotionScene3DAnimationPlanResult,
  MotionScene3DAnimationSource,
} from "../../motion-scene3d-animation-types";
