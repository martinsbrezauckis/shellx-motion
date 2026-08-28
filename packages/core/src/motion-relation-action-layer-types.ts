import type { MotionLayerType } from "./types";

/**
 * The closed role vocabulary for relation-action definitions.
 *
 * Relation actions materialize only ordinary layers from this subset. Runtime
 * readers, the public structural schema, and Debug metadata all project from
 * this executable source rather than carrying independent eight-layer lists.
 */
export const MOTION_RELATION_ACTION_ROLE_LAYER_TYPES = [
  "shape", "text", "caption", "image", "video", "points", "particles", "group"
] as const satisfies readonly MotionLayerType[];

export const MOTION_RELATION_ACTION_ROLE_LAYER_TYPE_SET: ReadonlySet<MotionLayerType> = new Set(
  MOTION_RELATION_ACTION_ROLE_LAYER_TYPES
);
