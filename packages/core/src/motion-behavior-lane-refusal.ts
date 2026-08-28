import { compileGpuSceneBehaviorStaticPlan } from "./gpu-scene-behavior-composition";
import type { CapabilityMatch, MotionDocument, RendererCapability } from "./types";

/** Phase-1 lanes that must refuse stored behaviors until their evaluator join is exact. */
export type MotionBehaviorLegacyLane =
  | "browser"
  | "native"
  | "gpu-static"
  | "gpu-frame"
  | "ffmpeg-browser"
  | "ffmpeg-native";

export const MOTION_BEHAVIOR_LANE_REFUSAL_SCHEMA = "shellx-motion/motion-behavior-lane-refusal@1" as const;
export const MOTION_BEHAVIOR_LANE_REFUSAL_FEATURE = "motion.behaviors@1" as const;

export interface MotionBehaviorLaneRefusal {
  schema: typeof MOTION_BEHAVIOR_LANE_REFUSAL_SCHEMA;
  code: "motion_behaviors_unavailable";
  feature: typeof MOTION_BEHAVIOR_LANE_REFUSAL_FEATURE;
  lane: MotionBehaviorLegacyLane;
  message: string;
}

/**
 * A presence-only fail-closed contract. Disabled bindings still reserve transform authority, so a
 * legacy lane cannot treat an empty-looking behavior store as equivalent to an absent one.
 */
export function motionBehaviorLaneRefusal(
  motion: Pick<MotionDocument, "behaviors">,
  lane: MotionBehaviorLegacyLane,
): MotionBehaviorLaneRefusal | undefined {
  if (motion.behaviors === undefined) return undefined;
  return Object.freeze({
    schema: MOTION_BEHAVIOR_LANE_REFUSAL_SCHEMA,
    code: "motion_behaviors_unavailable",
    feature: MOTION_BEHAVIOR_LANE_REFUSAL_FEATURE,
    lane,
    message: messageFor(lane),
  });
}

/** Capability-card guard shared by the legacy browser, native, and GPU projections. */
export function motionBehaviorCapabilityMatch(
  motion: Pick<MotionDocument, "behaviors">,
  capability: Pick<RendererCapability, "lane">,
): CapabilityMatch | undefined {
  const lane = capability.lane === "browser" || capability.lane === "native"
    ? capability.lane
    : undefined;
  const refusal = lane ? motionBehaviorLaneRefusal(motion, lane) : undefined;
  return refusal ? {
    ok: false, lane: capability.lane,
    unsupported: [{ layerId: "__motion_behaviors__", feature: refusal.feature, reason: refusal.message }],
  } : undefined;
}

/** Root-level package truth: all presently registered render lanes refuse a behavior store. */
export function motionBehaviorPackageRefusal(motion: MotionDocument) {
  if (motion.behaviors === undefined) return undefined;
  const gpu = compileGpuSceneBehaviorStaticPlan(motion);
  if (gpu.ok) return undefined;
  return {
    code: "package_unrenderable" as const,
    message: `No current render lane supports document behaviors@1: GPU behavior composition refused ${gpu.failure.message}`,
    suggestedAction: "Repair the behavior store or remove document behaviors@1 before rendering this package.",
    layers: [{ layerId: "__motion_behaviors__", type: "document_behavior_store" }],
  };
}

function messageFor(lane: MotionBehaviorLegacyLane): string {
  switch (lane) {
    case "gpu-static": return "GPU static planning does not yet support document behaviors@1.";
    case "gpu-frame": return "GPU frame planning does not yet support document behaviors@1.";
    case "browser": return "Browser rendering does not yet support document behaviors@1.";
    case "native": return "Native rendering does not yet support document behaviors@1.";
    case "ffmpeg-browser": return "FFmpeg browser-frame delivery does not yet support document behaviors@1.";
    case "ffmpeg-native": return "FFmpeg native-frame delivery does not yet support document behaviors@1.";
  }
}
