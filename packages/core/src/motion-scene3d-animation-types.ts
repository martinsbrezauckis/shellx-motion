import { SCENE_3D_CONTROL_BOUNDS } from "./scene-3d";
import type { MotionEasing, MotionScene3D, MotionVec3 } from "./types";

/**
 * Portable descriptor identity for the optional Motion-document scene3d animation root.
 * Planning and frame-plan identities remain Core-internal implementation details.
 */
export const MOTION_SCENE3D_ANIMATION_SCHEMA = "shellx-motion/scene3d-animation@1" as const;
export const MOTION_SCENE3D_ANIMATION_PLAN_SCHEMA = "shellx-motion/private-scene3d-animation-plan@1" as const;
export const MOTION_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA = "shellx-motion/private-scene3d-animation-frame-plan@1" as const;

export const MAX_MOTION_SCENE3D_ANIMATION_TRACKS = 64;
export const MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK = 64;
export const MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES = 2_048;
export const MAX_MOTION_SCENE3D_ANIMATION_TRACK_BYTES = 16 * 1024;
export const MAX_MOTION_SCENE3D_ANIMATION_INPUT_BYTES = 256 * 1024;
export const MAX_MOTION_SCENE3D_ANIMATION_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_MOTION_SCENE3D_ANIMATION_PLAN_WORK_UNITS = 4_096;
export const MAX_MOTION_SCENE3D_ANIMATION_FRAME_WORK_UNITS = 256;
export const MAX_MOTION_SCENE3D_ANIMATION_TIME_US = 1_000_000_000_000;

export type MotionScene3DAnimationValueKind = "number" | "vec3" | "color";
export type MotionScene3DAnimationValue = number | MotionVec3 | string;

export type MotionScene3DAnimationLocator =
  | { layerId: string; scope: "camera"; property: "position" | "target" | "fovDeg" }
  | { layerId: string; scope: "lighting"; property: "ambient" | "direction" | "intensity" | "color" }
  | { layerId: string; scope: "object"; objectId: string; property: "position" | "rotationDeg" | "scale" | "emissive" | "color" }
  | { layerId: string; scope: "background"; property: "color" };

export interface MotionScene3DAnimationKeyframe {
  atUs: number;
  value: MotionScene3DAnimationValue;
  easing?: MotionEasing;
}

export interface MotionScene3DAnimationTrack {
  id: string;
  locator: MotionScene3DAnimationLocator;
  keyframes: readonly MotionScene3DAnimationKeyframe[];
}

export interface MotionScene3DAnimationDescriptor {
  schema: typeof MOTION_SCENE3D_ANIMATION_SCHEMA;
  tracks: readonly MotionScene3DAnimationTrack[];
}

/** A detached projection of existing Motion `scene3d` layers, not a second scene graph. */
export interface MotionScene3DAnimationSourceLayer {
  id: string;
  type: "scene3d";
  scene3d: MotionScene3D;
}

export interface MotionScene3DAnimationSource {
  layers: readonly MotionScene3DAnimationSourceLayer[];
}

export interface MotionScene3DAnimationCompileInput {
  animation: MotionScene3DAnimationDescriptor;
  source: MotionScene3DAnimationSource;
}

export interface MotionScene3DAnimationPlanTrack extends MotionScene3DAnimationTrack {
  kind: MotionScene3DAnimationValueKind;
  /** Existing scene value used before the first authored key. */
  baseValue: MotionScene3DAnimationValue;
  sourceSha256: string;
}

export interface MotionScene3DAnimationPlan {
  schema: typeof MOTION_SCENE3D_ANIMATION_PLAN_SCHEMA;
  sourceSha256: string;
  tracks: readonly MotionScene3DAnimationPlanTrack[];
  budget: Readonly<{
    sourceLayerCount: number;
    sourceObjectCount: number;
    trackCount: number;
    keyframeCount: number;
    inputBytes: number;
    planWorkUnits: number;
    frameWorkUnits: number;
  }>;
  evidence: Readonly<{ noRenderer: true; noPixelClaim: true; staticTopology: true }>;
  fingerprint: string;
}

export interface MotionScene3DAnimationFrameSample {
  id: string;
  locator: MotionScene3DAnimationLocator;
  value: MotionScene3DAnimationValue;
  sourceSha256: string;
}

export interface MotionScene3DAnimationFramePlan {
  schema: typeof MOTION_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  samples: readonly MotionScene3DAnimationFrameSample[];
  budget: Readonly<{ activeTrackCount: number; frameWorkUnits: number }>;
  fingerprint: string;
}

export type MotionScene3DAnimationPlanResult = { ok: true; plan: MotionScene3DAnimationPlan } | { ok: false; message: string };
export type MotionScene3DAnimationFramePlanResult = { ok: true; plan: MotionScene3DAnimationFramePlan } | { ok: false; message: string };

export function motionScene3DAnimationValueKind(locator: MotionScene3DAnimationLocator): MotionScene3DAnimationValueKind {
  if (locator.scope === "background") return "color";
  if (locator.scope === "camera") return locator.property === "fovDeg" ? "number" : "vec3";
  if (locator.scope === "lighting") return locator.property === "color" ? "color" : locator.property === "direction" ? "vec3" : "number";
  return locator.property === "color" ? "color" : locator.property === "position" || locator.property === "rotationDeg" ? "vec3" : "number";
}

export function motionScene3DAnimationLocatorKey(locator: MotionScene3DAnimationLocator): string {
  return `${locator.layerId}\u0000${locator.scope}\u0000${locator.scope === "object" ? locator.objectId : ""}\u0000${locator.property}`;
}

export function motionScene3DAnimationNumericBounds(locator: MotionScene3DAnimationLocator): readonly [number, number] | null {
  if (locator.scope === "background" || (locator.scope === "lighting" && locator.property === "color") || (locator.scope === "object" && locator.property === "color")) return null;
  if (locator.scope === "camera") return locator.property === "fovDeg" ? SCENE_3D_CONTROL_BOUNDS.cameraFovDeg : SCENE_3D_CONTROL_BOUNDS.position;
  if (locator.scope === "lighting") return locator.property === "ambient" ? SCENE_3D_CONTROL_BOUNDS.lightingAmbient : locator.property === "intensity" ? SCENE_3D_CONTROL_BOUNDS.lightingIntensity : SCENE_3D_CONTROL_BOUNDS.lightingDirection;
  return locator.property === "position" ? SCENE_3D_CONTROL_BOUNDS.position : locator.property === "rotationDeg" ? SCENE_3D_CONTROL_BOUNDS.rotationDeg : locator.property === "scale" ? SCENE_3D_CONTROL_BOUNDS.scale : SCENE_3D_CONTROL_BOUNDS.emissive;
}
