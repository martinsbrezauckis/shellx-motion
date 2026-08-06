import type { MotionEasing } from "./types";

/** Spatial interpolation metadata owned by a transform.x keyframe. */
export type MotionSpatialTangentMode = "linear" | "smooth" | "broken" | "auto";

export interface MotionSpatialHandle {
  x: number;
  y: number;
}

export interface MotionSpatialInterpolation {
  mode: MotionSpatialTangentMode;
  in: MotionSpatialHandle;
  out: MotionSpatialHandle;
}

export interface MotionSpatialPathPoint {
  atMs: number;
  x: number;
  y: number;
  easing?: MotionEasing;
  spatial: MotionSpatialInterpolation;
}
