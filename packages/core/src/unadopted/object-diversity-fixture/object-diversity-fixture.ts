import { MOTION_SHAPE_GEOMETRY_SCHEMA } from "../../motion-shape-geometry";
import type { MotionDocument } from "../../types";

/** Source-only M260-1 object-diversity fixture: no assets, renderer, or native dependency. */
export const OBJECT_DIVERSITY_FIXTURE_ID = "m260-object-diversity";
export const OBJECT_DIVERSITY_LAYER_IDS = [
  "line-dash",
  "polyline-stroke",
  "polygon-fill",
  "arc-stroke",
  "sector-fill",
  "path-fill",
  "closed-gradient-mask"
] as const;

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };
const STROKE = { stroke: "#f8fafc", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" } as const;

/**
 * This is intentionally ordinary Motion source rather than an external package
 * or a renderer fixture. The v1 contour ABI carries flat fill/stroke only, so
 * the closed-stop gradient is an adjacent rectangular layer with its own mask.
 */
export const OBJECT_DIVERSITY_SOURCE = {
  schema: "shellx-motion/motion@1",
  id: OBJECT_DIVERSITY_FIXTURE_ID,
  name: "M260 object diversity",
  durationMs: 1_000,
  fps: 30,
  width: 640,
  height: 360,
  background: "#102033",
  assets: [],
  provenance: { sourceApp: "m260-fixture", createdBy: "m260-fixture" },
  layers: [
    {
      id: "line-dash", type: "shape", startMs: 0, durationMs: 1_000,
      transform: { x: 20, y: 20, width: 120, height: 80 },
      geometry: { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "line", viewBox: VIEW_BOX, points: [{ x: 8, y: 50 }, { x: 92, y: 50 }] },
      style: { ...STROKE, stroke: "#38bdf8", strokeDasharray: [12, 6], strokeDashoffset: 3 }
    },
    {
      id: "polyline-stroke", type: "shape", startMs: 0, durationMs: 1_000,
      transform: { x: 180, y: 20, width: 120, height: 80 },
      geometry: { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "polyline", viewBox: VIEW_BOX, points: [{ x: 10, y: 78 }, { x: 50, y: 18 }, { x: 90, y: 78 }] },
      style: { ...STROKE, stroke: "#a7f3d0" }
    },
    {
      id: "polygon-fill", type: "shape", startMs: 0, durationMs: 1_000,
      transform: { x: 340, y: 20, width: 120, height: 80 }, fill: "#f97316",
      geometry: { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "polygon", viewBox: VIEW_BOX, points: [{ x: 12, y: 12 }, { x: 88, y: 12 }, { x: 50, y: 88 }] }
    },
    {
      id: "arc-stroke", type: "shape", startMs: 0, durationMs: 1_000,
      transform: { x: 20, y: 140, width: 120, height: 80 },
      geometry: { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "arc", viewBox: VIEW_BOX, center: { x: 50, y: 50 }, radius: 35, startAngleDeg: -120, sweepAngleDeg: 240 },
      style: { ...STROKE, stroke: "#facc15" }
    },
    {
      id: "sector-fill", type: "shape", startMs: 0, durationMs: 1_000,
      transform: { x: 180, y: 140, width: 120, height: 80 }, fill: "#c084fc",
      geometry: { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "sector", viewBox: VIEW_BOX, center: { x: 50, y: 50 }, radius: 38, innerRadius: 12, startAngleDeg: 25, sweepAngleDeg: 220 }
    },
    {
      id: "path-fill", type: "shape", startMs: 0, durationMs: 1_000,
      transform: { x: 340, y: 140, width: 120, height: 80 }, fill: "#fb7185",
      geometry: { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox: VIEW_BOX, data: "M 12 18 L 88 18 L 72 82 L 28 82 Z" }
    },
    {
      id: "closed-gradient-mask", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000,
      transform: { x: 500, y: 120, width: 110, height: 110 },
      gradient: {
        type: "linear", angle: 0,
        // The 0 and 1 endpoints keep the source gradient closed and explicit.
        stops: [{ offset: 0, color: "#22d3ee" }, { offset: 0.5, color: "#6366f1" }, { offset: 1, color: "#f472b6" }]
      },
      mask: { type: "rounded-rect", inset: { top: 6, right: 8, bottom: 10, left: 4 }, radius: 14, opacity: 0.9, featherPx: 2 },
      keyframes: { "gradient.angle": [{ atMs: 0, value: 0 }, { atMs: 500, value: 135 }, { atMs: 999, value: 270 }] }
    }
  ]
} satisfies MotionDocument;
