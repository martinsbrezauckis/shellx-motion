import { motionRelationLaneRefusal, type MotionPackage } from "@shellx-motion/core";

/** Root-store admission stays outside Cut's layer-lowering catalogue until a receiver lowers it. */
export function cutRelationUnsupported(pkg: MotionPackage) {
  const refusal = motionRelationLaneRefusal(pkg.motion, "cut");
  return refusal ? [{
    layerId: "__motion_relations__",
    feature: refusal.feature,
    reason: refusal.message,
  }] : undefined;
}
