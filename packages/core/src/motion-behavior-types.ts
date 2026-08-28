import type { MotionShapeGeometry } from "./motion-shape-geometry-types";
import type { MotionEasing } from "./types";

/** Persisted document-root behavior store. It is intentionally separate from keyframes. */
export const MOTION_BEHAVIORS_SCHEMA = "shellx-motion/behaviors@1" as const;
export const MAX_MOTION_BEHAVIORS = 32;
export const MAX_MOTION_BEHAVIOR_DURATION_US = 3_600_000_000;
export const MAX_MOTION_BEHAVIOR_BINDING_BYTES = 16 * 1024;
export const MAX_MOTION_BEHAVIOR_STORE_BYTES = 512 * 1024;
export const MAX_MOTION_BEHAVIOR_FRAME_WORK_UNITS = 32_768;
/**
 * Exact public numeric admission shared by persistent behavior storage, its
 * evaluator, and caller-facing schemas. Target-relative checks stay in the
 * evaluator because they require the target layer's transform.
 */
export const MOTION_BEHAVIOR_MIN_COORDINATE = -1_000_000;
export const MOTION_BEHAVIOR_MAX_COORDINATE = 1_000_000;
export const MOTION_BEHAVIOR_MIN_VELOCITY = -100_000;
export const MOTION_BEHAVIOR_MAX_VELOCITY = 100_000;
export const MOTION_BEHAVIOR_MIN_GRAVITY = 0;
export const MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY = 0.000001;
export const MOTION_BEHAVIOR_MAX_GRAVITY = 100_000;
export const MOTION_BEHAVIOR_MIN_RESTITUTION = 0;
export const MOTION_BEHAVIOR_MAX_RESTITUTION = 1;
export const MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT = 0;
export const MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT = 0.95;

export interface MotionBehaviorGravity {
  kind: "gravity";
  velocityX: number;
  velocityY: number;
  gravityY: number;
}

export interface MotionBehaviorBounce {
  kind: "bounce";
  floorY: number;
  velocityY: number;
  gravityY: number;
  restitution: number;
}

export interface MotionBehaviorSquash {
  kind: "squash";
  axis: "vertical" | "horizontal";
  amount: number;
}

interface MotionBehaviorBase {
  targetLayerId: string;
  enabled: boolean;
  startUs: number;
  durationUs: number;
}

/** A closed v1 path controls ordinary transform x/y and, optionally, rotation. */
export interface MotionPathFollowBehavior extends MotionBehaviorBase {
  kind: "path-follow";
  geometry: Extract<MotionShapeGeometry, { kind: "path" }>;
  offsetUs?: number;
  direction?: "forward" | "reverse";
  orientToPath?: boolean;
  easing?: MotionEasing;
}

/** Analytic gravity/bounce and optional centre-preserving squash. */
export interface MotionTransformBehavior extends MotionBehaviorBase {
  kind: "transform";
  motion?: MotionBehaviorGravity | MotionBehaviorBounce;
  squash?: MotionBehaviorSquash;
}

export type MotionBehavior = MotionPathFollowBehavior | MotionTransformBehavior;

export interface MotionBehaviorStore {
  schema: typeof MOTION_BEHAVIORS_SCHEMA;
  /** Strict UTF-16/code-unit ascending unique targetLayerId order is required. */
  bindings: MotionBehavior[];
}
