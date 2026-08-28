import type { MotionEasing } from "./types";

/** One complete fixed-topology color snapshot for a structured gradient. */
export interface MotionGradientColorKeyframe {
  /** Exact non-negative microsecond timestamp; snapshots stay in ascending order. */
  atUs: number;
  /** One authored color per existing gradient stop, in its existing order. */
  colors: readonly string[];
  /** Segment easing from this snapshot to the next; the last easing is retained as authored data. */
  easing?: MotionEasing;
}

/**
 * Bounded v1 color animation for a fixed existing gradient topology. It deliberately owns only
 * stop colors: gradient kind, stops/offsets/count and linear/radial geometry stay authored-static.
 */
export interface MotionGradientColorKeyframes {
  schema: "shellx-motion/gradient-color-keyframes@1";
  keyframes: readonly MotionGradientColorKeyframe[];
}
