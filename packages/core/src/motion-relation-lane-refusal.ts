import type { CapabilityMatch, MotionDocument, RendererCapability } from "./types";

/** All current projections fail closed on the public relation root until a renderer lowerer exists. */
export type MotionRelationLegacyLane =
  | "browser"
  | "native"
  | "gpu-static"
  | "gpu-frame"
  | "ffmpeg-browser"
  | "ffmpeg-native"
  | "ffmpeg-gpu"
  | "cut"
  | "capability";

export const MOTION_RELATION_LANE_REFUSAL_SCHEMA = "shellx-motion/motion-relation-lane-refusal@1" as const;
export const MOTION_RELATION_LANE_REFUSAL_FEATURE = "motion.relations@1" as const;

export interface MotionRelationLaneRefusal {
  schema: typeof MOTION_RELATION_LANE_REFUSAL_SCHEMA;
  code: "motion_relations_unavailable";
  feature: typeof MOTION_RELATION_LANE_REFUSAL_FEATURE;
  lane: MotionRelationLegacyLane;
  message: string;
}

/**
 * Descriptor-only root sentinel. An inaccessible accessor or reflection failure is present so every
 * consumer refuses without evaluating an untrusted `relations` getter or parsing its nested store.
 */
export function motionRelationStorePresent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, "relations"); }
  catch { return true; }
  return descriptor !== undefined && (!("value" in descriptor) || descriptor.value !== undefined);
}

/** Disabled bindings reserve authority too, so any present store must take the same fail-closed path. */
export function motionRelationLaneRefusal(
  motion: Pick<MotionDocument, "relations">,
  lane: MotionRelationLegacyLane,
): MotionRelationLaneRefusal | undefined {
  if (!motionRelationStorePresent(motion)) return undefined;
  return Object.freeze({
    schema: MOTION_RELATION_LANE_REFUSAL_SCHEMA,
    code: "motion_relations_unavailable",
    feature: MOTION_RELATION_LANE_REFUSAL_FEATURE,
    lane,
    message: messageFor(lane),
  });
}

/** Capability truth shares the same sentinel; no layer capability list advertises the root store. */
export function motionRelationCapabilityMatch(
  motion: Pick<MotionDocument, "relations">,
  capability: Pick<RendererCapability, "lane">,
): CapabilityMatch | undefined {
  const lane: MotionRelationLegacyLane = capability.lane === "browser"
    ? "browser"
    : capability.lane === "native"
      ? "native"
      : capability.lane === "gpu"
        ? "gpu-static"
        : "capability";
  const refusal = motionRelationLaneRefusal(motion, lane);
  return refusal ? {
    ok: false,
    lane: capability.lane,
    unsupported: [{ layerId: "__motion_relations__", feature: refusal.feature, reason: refusal.message }],
  } : undefined;
}

/** Root-level package truth: relations are valid document data but unrenderable until a lane lowers them. */
export function motionRelationPackageRefusal(motion: MotionDocument) {
  if (!motionRelationStorePresent(motion)) return undefined;
  return {
    code: "package_unrenderable" as const,
    message: "No current render lane supports document relations@1; every lane refuses before relation resource preparation.",
    suggestedAction: "Remove document relations@1 or select a future renderer release that explicitly lowers relations.",
    layers: [{ layerId: "__motion_relations__", type: "document_relation_store" }],
  };
}

function messageFor(lane: MotionRelationLegacyLane): string {
  switch (lane) {
    case "gpu-static": return "GPU static planning does not yet support document relations@1.";
    case "gpu-frame": return "GPU frame planning does not yet support document relations@1.";
    case "browser": return "Browser rendering does not yet support document relations@1.";
    case "native": return "Native rendering does not yet support document relations@1.";
    case "ffmpeg-browser": return "FFmpeg browser-frame delivery does not yet support document relations@1.";
    case "ffmpeg-native": return "FFmpeg native-frame delivery does not yet support document relations@1.";
    case "ffmpeg-gpu": return "FFmpeg GPU-frame delivery does not yet support document relations@1.";
    case "cut": return "Cut import does not yet support document relations@1.";
    case "capability": return "Renderer capability matching does not yet support document relations@1.";
  }
}
