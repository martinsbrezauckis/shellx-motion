import type { MotionEasing } from "./types";
import type { MotionShapeGeometry } from "./motion-shape-geometry-types";

/** One complete v1 shape-geometry snapshot at an exact microsecond. */
export interface MotionShapeGeometryKeyframe {
  /** Exact non-negative microsecond timestamp; entries remain strictly ascending. */
  atUs: number;
  /** Complete fixed-topology geometry. Partial geometry patches are intentionally unsupported. */
  geometry: MotionShapeGeometry;
  /** Segment easing from this snapshot to the next. */
  easing?: MotionEasing;
}

/**
 * Bounded v1 shape-geometry animation. Geometry kind, viewBox, and interpolation topology are
 * fixed across every snapshot and against the owning static v1 geometry record.
 */
export interface MotionShapeGeometryKeyframes {
  schema: "shellx-motion/shape-geometry-keyframes@1";
  keyframes: readonly MotionShapeGeometryKeyframe[];
}
