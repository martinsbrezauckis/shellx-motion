/** Keeps timeline structural routing bounded as layer, group, layout, and geometry domains evolve independently. */
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import {
  dispatchTimelineGroupsStructuralCommand,
  type TimelineGroupsStructuralServices
} from "./timeline-groups-structural.js";
import {
  dispatchTimelineLayersStructuralCommand,
  type TimelineLayersStructuralServices
} from "./timeline-layers-structural.js";
import {
  dispatchTimelineLayoutAuthoringCommand,
  type TimelineLayoutAuthoringServices
} from "./timeline-layout-authoring.js";
import {
  dispatchTimelineFixedAdjustmentAuthoringCommand,
  type TimelineFixedAdjustmentAuthoringServices
} from "./timeline-adjustment-fixed-authoring.js";
import {
  dispatchTimelineGradientColorKeyframeAuthoringCommand,
  type TimelineGradientColorKeyframeAuthoringServices
} from "./timeline-gradient-color-keyframes-authoring.js";
import {
  dispatchTimelinePointAuthoringCommand,
  type TimelinePointAuthoringServices
} from "./timeline-point-authoring.js";
import {
  dispatchTimelineParticleStructuralAuthoringCommand,
  type TimelineParticleStructuralAuthoringServices
} from "./timeline-particle-structural-authoring.js";
import {
  dispatchTimelineShapeGeometryAuthoringCommand,
  type TimelineShapeGeometryAuthoringServices
} from "./timeline-shape-geometry-authoring.js";
import {
  dispatchTimelineShapeGeometryKeyframeAuthoringCommand,
  type TimelineShapeGeometryKeyframeAuthoringServices
} from "./timeline-shape-geometry-keyframes-authoring.js";
import {
  dispatchTimelineTextRunsAuthoringCommand,
  type TimelineTextRunsAuthoringServices
} from "./timeline-text-runs-authoring.js";
import {
  dispatchTimelineBehaviorAuthoringCommand,
  type TimelineBehaviorAuthoringServices
} from "./timeline-behaviors-authoring.js";
import {
  dispatchTimelineRelationAuthoringCommand,
  type TimelineRelationAuthoringServices
} from "./timeline-relations-authoring.js";
import {
  dispatchTimelineRelationActionAuthoringCommand,
  type TimelineRelationActionAuthoringServices
} from "./timeline-relation-actions-authoring.js";
import {
  dispatchTimelineScene3DAnimationAuthoringCommand,
  type TimelineScene3DAnimationAuthoringServices
} from "./timeline-scene3d-animation-authoring.js";
import {
  dispatchTimelineLayoutGapAnimationAuthoringCommand,
  type TimelineLayoutGapAnimationAuthoringServices
} from "./timeline-layout-gap-animation-authoring.js";

export interface TimelineStructuralDispatchServices extends
  TimelineLayersStructuralServices,
  TimelineGroupsStructuralServices,
  TimelineLayoutAuthoringServices,
  TimelineFixedAdjustmentAuthoringServices,
  TimelineGradientColorKeyframeAuthoringServices,
  TimelinePointAuthoringServices,
  TimelineParticleStructuralAuthoringServices,
  TimelineShapeGeometryAuthoringServices,
  TimelineShapeGeometryKeyframeAuthoringServices,
  TimelineTextRunsAuthoringServices,
  TimelineBehaviorAuthoringServices,
  TimelineRelationAuthoringServices,
  TimelineRelationActionAuthoringServices,
  TimelineScene3DAnimationAuthoringServices,
  TimelineLayoutGapAnimationAuthoringServices {}

export async function dispatchTimelineStructuralCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineStructuralDispatchServices
): Promise<MotionDebugResult | null> {
  const layerMutation = await dispatchTimelineLayersStructuralCommand(command, args, services);
  if (layerMutation) return layerMutation;
  const groupMutation = await dispatchTimelineGroupsStructuralCommand(command, args, services);
  if (groupMutation) return groupMutation;
  const layoutMutation = await dispatchTimelineLayoutAuthoringCommand(command, args, services);
  if (layoutMutation) return layoutMutation;
  const adjustmentMutation = await dispatchTimelineFixedAdjustmentAuthoringCommand(command, args, services);
  if (adjustmentMutation) return adjustmentMutation;
  const gradientColorMutation = await dispatchTimelineGradientColorKeyframeAuthoringCommand(command, args, services);
  if (gradientColorMutation) return gradientColorMutation;
  const pointMutation = await dispatchTimelinePointAuthoringCommand(command, args, services);
  if (pointMutation) return pointMutation;
  const particleMutation = await dispatchTimelineParticleStructuralAuthoringCommand(command, args, services);
  if (particleMutation) return particleMutation;
  const geometryMutation = await dispatchTimelineShapeGeometryAuthoringCommand(command, args, services);
  if (geometryMutation) return geometryMutation;
  const geometryKeyframeMutation = await dispatchTimelineShapeGeometryKeyframeAuthoringCommand(command, args, services);
  if (geometryKeyframeMutation) return geometryKeyframeMutation;
  const textRunsMutation = await dispatchTimelineTextRunsAuthoringCommand(command, args, services);
  if (textRunsMutation) return textRunsMutation;
  const behaviorMutation = await dispatchTimelineBehaviorAuthoringCommand(command, args, services);
  if (behaviorMutation) return behaviorMutation;
  const relationMutation = await dispatchTimelineRelationAuthoringCommand(command, args, services);
  if (relationMutation) return relationMutation;
  const relationActionMutation = await dispatchTimelineRelationActionAuthoringCommand(command, args, services);
  const scene3dAnimationMutation = relationActionMutation ?? await dispatchTimelineScene3DAnimationAuthoringCommand(command, args, services);
  return scene3dAnimationMutation ?? await dispatchTimelineLayoutGapAnimationAuthoringCommand(command, args, services);
}
