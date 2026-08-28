import type { CapabilityMatch, MotionDocument, RendererCapability } from "./types";

/** Generic render, delivery, import, and capability paths fail closed outside the exact O6 lowerer. */
export type MotionScene3DAnimationLegacyLane =
  | "browser"
  | "native"
  | "gpu-static"
  | "gpu-frame"
  | "ffmpeg-browser"
  | "ffmpeg-native"
  | "ffmpeg-gpu"
  | "cut"
  | "capability";

export const MOTION_SCENE3D_ANIMATION_LANE_REFUSAL_SCHEMA = "shellx-motion/scene3d-animation-lane-refusal@1" as const;
export const MOTION_SCENE3D_ANIMATION_LANE_REFUSAL_FEATURE = "motion.scene3d-animation@1" as const;

export interface MotionScene3DAnimationLaneRefusal {
  schema: typeof MOTION_SCENE3D_ANIMATION_LANE_REFUSAL_SCHEMA;
  code: "motion_scene3d_animation_unavailable";
  feature: typeof MOTION_SCENE3D_ANIMATION_LANE_REFUSAL_FEATURE;
  lane: MotionScene3DAnimationLegacyLane;
  message: string;
}

/**
 * Descriptor-only root sentinel. Accessors and reflection failures count as present so callers
 * refuse before evaluating untrusted descriptor data or allocating any render resource.
 */
export function motionScene3DAnimationStorePresent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, "scene3dAnimation"); }
  catch { return true; }
  return descriptor !== undefined && (!("value" in descriptor) || descriptor.value !== undefined);
}

export function motionScene3DAnimationLaneRefusal(
  motion: Pick<MotionDocument, "scene3dAnimation">,
  lane: MotionScene3DAnimationLegacyLane,
): MotionScene3DAnimationLaneRefusal | undefined {
  if (!motionScene3DAnimationStorePresent(motion)) return undefined;
  return Object.freeze({
    schema: MOTION_SCENE3D_ANIMATION_LANE_REFUSAL_SCHEMA,
    code: "motion_scene3d_animation_unavailable",
    feature: MOTION_SCENE3D_ANIMATION_LANE_REFUSAL_FEATURE,
    lane,
    message: messageFor(lane),
  });
}

export function motionScene3DAnimationCapabilityMatch(
  motion: Pick<MotionDocument, "scene3dAnimation">,
  capability: Pick<RendererCapability, "lane">,
): CapabilityMatch | undefined {
  const lane: MotionScene3DAnimationLegacyLane = capability.lane === "browser"
    ? "browser"
    : capability.lane === "native"
      ? "native"
      : capability.lane === "gpu"
        ? "gpu-static"
        : "capability";
  const refusal = motionScene3DAnimationLaneRefusal(motion, lane);
  return refusal ? {
    ok: false,
    lane: capability.lane,
    unsupported: [{ layerId: "__scene3d_animation__", feature: refusal.feature, reason: refusal.message }],
  } : undefined;
}

export function motionScene3DAnimationPackageRefusal(motion: MotionDocument) {
  if (!motionScene3DAnimationStorePresent(motion)) return undefined;
  return {
    code: "package_unrenderable" as const,
    message: "Generic render lanes do not support document scene3dAnimation@1; the sole exception is the direct @shellx-motion/renderer-browser renderMotionGpuPreview PNG-preview API.",
    suggestedAction: "Use the strict direct @shellx-motion/renderer-browser renderMotionGpuPreview PNG-preview API when its O6 package limits are met, or remove document scene3dAnimation@1.",
    layers: [{ layerId: "__scene3d_animation__", type: "document_scene3d_animation" }],
  };
}

function messageFor(lane: MotionScene3DAnimationLegacyLane): string {
  switch (lane) {
    case "gpu-static": return "GPU static planning does not yet support document scene3dAnimation@1.";
    case "gpu-frame": return "GPU frame planning does not yet support document scene3dAnimation@1.";
    case "browser": return "Browser rendering does not yet support document scene3dAnimation@1.";
    case "native": return "Native rendering does not yet support document scene3dAnimation@1.";
    case "ffmpeg-browser": return "FFmpeg browser-frame delivery does not yet support document scene3dAnimation@1.";
    case "ffmpeg-native": return "FFmpeg native-frame delivery does not yet support document scene3dAnimation@1.";
    case "ffmpeg-gpu": return "FFmpeg GPU-frame delivery does not yet support document scene3dAnimation@1.";
    case "cut": return "Cut import does not yet support document scene3dAnimation@1.";
    case "capability": return "Renderer capability matching does not yet support document scene3dAnimation@1.";
  }
}
