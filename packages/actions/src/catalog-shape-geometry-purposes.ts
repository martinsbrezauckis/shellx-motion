/**
 * Reviewed purposes for the published typed shape-geometry Debug/MCP command family.
 *
 * The family already has direct CLI routes but no Action-surface coverage. These descriptions
 * explain the existing typed operations without silently broadening their public routes.
 */
export const SHAPE_GEOMETRY_PURPOSES: Readonly<Record<string, string>> = {
  "motion.timeline.shape.geometry.inspect": "Inspect one shape layer's v1 or legacy geometry, stroke dash, and resolved contour without mutating it.",
  "motion.timeline.shape.geometry.replace": "Replace one shape layer's complete v1 geometry in a copy-on-write package.",
  "motion.timeline.shape.geometry.point.update": "Replace one indexed point in a v1 line, polyline, or polygon geometry in a copy-on-write package.",
  "motion.timeline.shape.geometry.point.insert": "Insert one point at an ordered index in a v1 line, polyline, or polygon geometry in a copy-on-write package.",
  "motion.timeline.shape.geometry.point.move": "Reorder one existing point between ordered indexes in a v1 line, polyline, or polygon geometry in a copy-on-write package.",
  "motion.timeline.shape.geometry.point.range.delete": "Delete one half-open indexed point range from a v1 line, polyline, or polygon geometry while retaining its required minimum in a copy-on-write package.",
  "motion.timeline.shape.geometry.arc.update": "Update one or more bounded arc or sector controls in a v1 shape geometry in a copy-on-write package.",
  "motion.timeline.shape.geometry.path.replace": "Replace only the bounded v1 path data string in a copy-on-write package.",
  "motion.timeline.shape.geometry.legacy.migrate": "One-way migrate one legacy path or freeform shape to v1 path geometry with resolved-contour equivalence evidence in a copy-on-write package.",
  "motion.timeline.shape.geometry.dash.set": "Set one bounded v1 shape stroke dash array and optional phase offset in a copy-on-write package.",
  "motion.timeline.shape.geometry.dash.remove": "Remove both stroke dash fields from a v1 shape geometry in a copy-on-write package.",
  "motion.timeline.shape.geometry-keyframes.inspect": "Inspect one v1 shape layer's persisted exact-time geometry snapshots and evaluation without mutating it.",
  "motion.timeline.shape.geometry-keyframes.upsert": "Insert or replace one complete fixed-topology v1 geometry snapshot at an exact microsecond in a copy-on-write package.",
  "motion.timeline.shape.geometry-keyframes.delete": "Delete one exact-time v1 geometry snapshot while retaining a non-empty snapshot record in a copy-on-write package.",
  "motion.timeline.shape.geometry-keyframes.move": "Move one v1 geometry snapshot to a different exact microsecond while preserving its complete geometry in a copy-on-write package.",
};
