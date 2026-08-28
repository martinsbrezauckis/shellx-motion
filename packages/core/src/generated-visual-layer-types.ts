import type { MotionLayerType } from "./types";

/**
 * Layer types that generate their own pixels, rather than influencing another layer or carrying
 * non-visual data. Depth ordering and per-layer motion blur are defined over this exact set.
 *
 * This is deliberately distinct from `renderableLayerTypes()`: audio has no pixels, and
 * camera/adjustment/web influence or present pixels without being depth planes themselves. Keep
 * the runtime validator and the generated public schema on this one authority.
 */
export const GENERATED_VISUAL_LAYER_TYPES = [
  "shape", "text", "caption", "image", "video", "particles", "points", "shader", "scene3d", "environment"
] as const satisfies readonly MotionLayerType[];

// The validator tests arbitrary decoded values, so membership must accept a plain string at its edge.
export const GENERATED_VISUAL_LAYER_TYPE_SET: ReadonlySet<string> = new Set(GENERATED_VISUAL_LAYER_TYPES);
