import type { MotionLayoutCompiledTransform, MotionLayoutChildTiming } from "./motion-layout";

/** Persisted, application-bound animation for the one admitted layout parameter. */
export const MOTION_LAYOUT_GAP_ANIMATION_SCHEMA = "shellx-motion/layout-gap-animation@1" as const;
export const MOTION_LAYOUT_GAP_ANIMATION_FRAME_SCHEMA = "shellx-motion/private-layout-gap-animation-frame@1" as const;

/** L1a carries one host continuation chain, therefore exactly one application/track. */
export const MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACKS = 1;
export const MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK = 64;
export const MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES = 64;
export const MAX_MOTION_LAYOUT_GAP_ANIMATION_INPUT_BYTES = 128 * 1024;
export const MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACK_BYTES = 12 * 1024;
export const MAX_MOTION_LAYOUT_GAP_ANIMATION_WORK_UNITS = 512;
export const MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US = 1_000_000_000_000;

/** Closed C2 subset whose resolver output remains in [0, 1] for t in [0, 1]. */
export const MOTION_LAYOUT_GAP_ANIMATION_EASINGS = [
  "linear",
  "hold",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
] as const;

export type MotionLayoutGapAnimationEasing = (typeof MOTION_LAYOUT_GAP_ANIMATION_EASINGS)[number];

export interface MotionLayoutGapAnimationKeyframe {
  atUs: number;
  value: number;
  easing?: MotionLayoutGapAnimationEasing;
}

/**
 * The application marker is deliberately repeated with every track. It is an
 * immutable binding, not a caller-held inverse patch or generic keyframe path.
 */
export interface MotionLayoutGapAnimationTrack {
  id: string;
  applicationId: string;
  applicationFingerprint: string;
  childLayerIds: readonly string[];
  keyframes: readonly MotionLayoutGapAnimationKeyframe[];
}

export interface MotionLayoutGapAnimationDescriptor {
  schema: typeof MOTION_LAYOUT_GAP_ANIMATION_SCHEMA;
  tracks: readonly MotionLayoutGapAnimationTrack[];
}

export interface MotionLayoutGapAnimationTrackBinding {
  applicationId: string;
  applicationFingerprint: string;
  groupId: string;
  childLayerIds: readonly string[];
  layoutKind: "row" | "column";
  staticGap: number;
  layoutFingerprint: string;
}

export interface MotionLayoutGapAnimationFrameTrack extends MotionLayoutGapAnimationTrackBinding {
  id: string;
  gap: number;
  /** Direct-child layout intent regenerated from the recorded pre-layout snapshots. */
  projection: readonly { layerId: string; transform: MotionLayoutCompiledTransform; timing: MotionLayoutChildTiming }[];
}

export interface MotionLayoutGapAnimationFrame {
  schema: typeof MOTION_LAYOUT_GAP_ANIMATION_FRAME_SCHEMA;
  atUs: number;
  tracks: readonly MotionLayoutGapAnimationFrameTrack[];
  fingerprint: string;
}
