import type { CapabilityMatch, MotionDocument, RendererCapability } from "./types";

/** Persisted layout-gap data has no renderer lowerer in C2-L1; every render entry stays closed. */
export type MotionLayoutGapAnimationLane = "browser" | "native" | "gpu-static" | "gpu-frame" | "ffmpeg-browser" | "ffmpeg-native" | "ffmpeg-gpu" | "cut" | "capability";
export const MOTION_LAYOUT_GAP_ANIMATION_LANE_REFUSAL_SCHEMA = "shellx-motion/layout-gap-animation-lane-refusal@1" as const;
export const MOTION_LAYOUT_GAP_ANIMATION_LANE_REFUSAL_FEATURE = "motion.layout-gap-animation@1" as const;
export interface MotionLayoutGapAnimationLaneRefusal { schema: typeof MOTION_LAYOUT_GAP_ANIMATION_LANE_REFUSAL_SCHEMA; code: "motion_layout_gap_animation_unavailable"; feature: typeof MOTION_LAYOUT_GAP_ANIMATION_LANE_REFUSAL_FEATURE; lane: MotionLayoutGapAnimationLane; message: string; }

/** Accessors, proxies, and malformed roots count as present without a getter read. */
export function motionLayoutGapAnimationStorePresent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, "layoutGapAnimation"); } catch { return true; }
  return descriptor !== undefined && (!("value" in descriptor) || descriptor.value !== undefined);
}
export function motionLayoutGapAnimationLaneRefusal(motion: Pick<MotionDocument, "layoutGapAnimation">, lane: MotionLayoutGapAnimationLane): MotionLayoutGapAnimationLaneRefusal | undefined {
  if (!motionLayoutGapAnimationStorePresent(motion)) return undefined;
  return Object.freeze({ schema: MOTION_LAYOUT_GAP_ANIMATION_LANE_REFUSAL_SCHEMA, code: "motion_layout_gap_animation_unavailable", feature: MOTION_LAYOUT_GAP_ANIMATION_LANE_REFUSAL_FEATURE, lane, message: messageFor(lane) });
}
export function motionLayoutGapAnimationCapabilityMatch(motion: Pick<MotionDocument, "layoutGapAnimation">, capability: Pick<RendererCapability, "lane">): CapabilityMatch | undefined {
  const lane: MotionLayoutGapAnimationLane = capability.lane === "browser" ? "browser" : capability.lane === "native" ? "native" : capability.lane === "gpu" ? "gpu-static" : "capability";
  const refusal = motionLayoutGapAnimationLaneRefusal(motion, lane);
  return refusal ? { ok: false, lane: capability.lane, unsupported: [{ layerId: "__layout_gap_animation__", feature: refusal.feature, reason: refusal.message }] } : undefined;
}
export function motionLayoutGapAnimationPackageRefusal(motion: MotionDocument) {
  if (!motionLayoutGapAnimationStorePresent(motion)) return undefined;
  return { code: "package_unrenderable" as const, message: "Render lanes do not yet support document layoutGapAnimation@1; C2-L1 is a Core and Debug authoring checkpoint only.", suggestedAction: "Remove document layoutGapAnimation@1 before rendering, or use the Core/Debug lifecycle to inspect or edit it.", layers: [{ layerId: "__layout_gap_animation__", type: "document_layout_gap_animation" }] };
}
function messageFor(lane: MotionLayoutGapAnimationLane): string {
  switch (lane) {
    case "gpu-static": return "GPU static planning does not yet support document layoutGapAnimation@1.";
    case "gpu-frame": return "GPU frame planning does not yet support document layoutGapAnimation@1.";
    case "browser": return "Browser rendering does not yet support document layoutGapAnimation@1.";
    case "native": return "Native rendering does not yet support document layoutGapAnimation@1.";
    case "ffmpeg-browser": return "FFmpeg browser-frame delivery does not yet support document layoutGapAnimation@1.";
    case "ffmpeg-native": return "FFmpeg native-frame delivery does not yet support document layoutGapAnimation@1.";
    case "ffmpeg-gpu": return "FFmpeg GPU-frame delivery does not yet support document layoutGapAnimation@1.";
    case "cut": return "Cut import does not yet support document layoutGapAnimation@1.";
    case "capability": return "Renderer capability matching does not yet support document layoutGapAnimation@1.";
  }
}
