/** Argument and receipt contracts for exact v1 shape-geometry inspection and authoring. */
import {
  MAX_MOTION_SHAPE_GEOMETRY_COORDINATE,
  MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES,
  MAX_MOTION_SHAPE_GEOMETRY_POINTS,
  MOTION_SHAPE_GEOMETRY_SCHEMA,
  GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS,
  GPU_SCENE_STROKE_DASH_MAX_ITEM_LENGTH,
  GPU_SCENE_STROKE_DASH_MAX_OFFSET
} from "@shellx-motion/core";
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, LAYER_ID, PACKAGE_EDIT, PACKAGE_ROOT } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir", "layerId"];
const FINITE_COORDINATE = {
  type: "number", minimum: -MAX_MOTION_SHAPE_GEOMETRY_COORDINATE, maximum: MAX_MOTION_SHAPE_GEOMETRY_COORDINATE
} as const;
const POINT_SCHEMA: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y"], additionalProperties: false,
  properties: {
    x: { ...FINITE_COORDINATE, description: "Finite geometry-space x coordinate." },
    y: { ...FINITE_COORDINATE, description: "Finite geometry-space y coordinate." }
  },
  description: "Exact finite geometry-space point."
};
const VIEW_BOX_SCHEMA: MotionDebugArgPropertySchema = {
  type: "object", required: ["x", "y", "width", "height"], additionalProperties: false,
  properties: {
    x: { ...FINITE_COORDINATE, description: "View-box x origin." },
    y: { ...FINITE_COORDINATE, description: "View-box y origin." },
    width: { type: "number", exclusiveMinimum: 0, maximum: MAX_MOTION_SHAPE_GEOMETRY_COORDINATE, description: "Positive view-box width." },
    height: { type: "number", exclusiveMinimum: 0, maximum: MAX_MOTION_SHAPE_GEOMETRY_COORDINATE, description: "Positive view-box height." }
  },
  description: "Exact bounded geometry coordinate space."
};
const BASE_GEOMETRY_PROPERTIES = {
  schema: { type: "string", enum: [MOTION_SHAPE_GEOMETRY_SCHEMA], description: "Exact v1 geometry schema." },
  kind: { type: "string", enum: ["line", "polyline", "polygon", "arc", "sector", "path"], description: "Closed geometry discriminant." },
  viewBox: VIEW_BOX_SCHEMA
} satisfies Record<string, MotionDebugArgPropertySchema>;
export const TIMELINE_SHAPE_GEOMETRY_VALUE_SCHEMA: MotionDebugArgPropertySchema = {
  type: "object",
  oneOf: [
    pointGeometry("line", 2, 2), pointGeometry("polyline", 2, MAX_MOTION_SHAPE_GEOMETRY_POINTS),
    pointGeometry("polygon", 3, MAX_MOTION_SHAPE_GEOMETRY_POINTS),
    arcGeometry("arc", false), arcGeometry("sector", true),
    {
      type: "object", required: ["schema", "kind", "viewBox", "data"], additionalProperties: false,
      properties: {
        ...BASE_GEOMETRY_PROPERTIES,
        kind: { type: "string", enum: ["path"], description: "Path geometry discriminant." },
        data: { type: "string", maxLength: MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES, description: "Complete bounded path data." }
      },
      description: "Exact bounded path geometry."
    }
  ],
  description: "Complete exact shellx-motion/shape-geometry@1 record; partial merge is not supported."
};
const POINT = {
  point: POINT_SCHEMA
};
const INDEX = {
  index: { type: "number" as const, minimum: 0, description: "Zero-based geometry point index." }
};

function mutation(operation: string, required: string[], properties: Record<string, MotionDebugArgPropertySchema>) {
  return {
    argsSchema: argsSchema(EDIT.concat(required), { ...PACKAGE_EDIT, ...LAYER_ID, ...properties }),
    expectedReceipts: editReceipt(operation)
  };
}

export const TIMELINE_SHAPE_GEOMETRY_COMMAND_METADATA = {
  "motion.timeline.shape.geometry.inspect": {
    argsSchema: argsSchema(["packageRoot", "layerId"], { ...PACKAGE_ROOT, ...LAYER_ID })
  },
  "motion.timeline.shape.geometry.replace": mutation("timeline.shape.geometry.replace", ["geometry"], {
    geometry: TIMELINE_SHAPE_GEOMETRY_VALUE_SCHEMA
  }),
  "motion.timeline.shape.geometry.point.update": mutation("timeline.shape.geometry.point.update", ["index", "point"], { ...INDEX, ...POINT }),
  "motion.timeline.shape.geometry.point.insert": mutation("timeline.shape.geometry.point.insert", ["index", "point"], { ...INDEX, ...POINT }),
  "motion.timeline.shape.geometry.point.move": mutation("timeline.shape.geometry.point.move", ["fromIndex", "toIndex"], {
    fromIndex: { type: "number", minimum: 0, description: "Existing zero-based point index." },
    toIndex: { type: "number", minimum: 0, description: "Destination zero-based point index after removal." }
  }),
  "motion.timeline.shape.geometry.point.range.delete": mutation("timeline.shape.geometry.point.range.delete", ["startIndex", "endIndexExclusive"], {
    startIndex: { type: "number", minimum: 0, description: "Inclusive zero-based start of the point range." },
    endIndexExclusive: { type: "number", minimum: 1, description: "Exclusive zero-based end of the half-open point range." }
  }),
  "motion.timeline.shape.geometry.arc.update": mutation("timeline.shape.geometry.arc.update", [], {
    center: { ...POINT_SCHEMA, description: "Optional exact finite arc or sector center." },
    radius: { type: "number", description: "Optional finite outer radius." },
    innerRadius: { type: "number", description: "Optional finite sector inner radius." },
    startAngleDeg: { type: "number", description: "Optional finite start angle in degrees." },
    sweepAngleDeg: { type: "number", description: "Optional finite signed sweep angle in degrees." }
  }),
  "motion.timeline.shape.geometry.path.replace": mutation("timeline.shape.geometry.path.replace", ["data"], {
    data: { type: "string", description: "Complete bounded path data for a v1 path geometry." }
  }),
  "motion.timeline.shape.geometry.legacy.migrate": mutation("timeline.shape.geometry.legacy.migrate", [], {}),
  "motion.timeline.shape.geometry.dash.set": mutation("timeline.shape.geometry.dash.set", ["strokeDasharray"], {
    strokeDasharray: { type: "array", minItems: 1, maxItems: GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS, items: { type: "number", exclusiveMinimum: 0, maximum: GPU_SCENE_STROKE_DASH_MAX_ITEM_LENGTH }, description: "Positive rendered-length dash runs; odd arrays repeat once under SVG semantics." },
    strokeDashoffset: { type: "number", minimum: -GPU_SCENE_STROKE_DASH_MAX_OFFSET, maximum: GPU_SCENE_STROKE_DASH_MAX_OFFSET, description: "Optional rendered-length phase offset." }
  }),
  "motion.timeline.shape.geometry.dash.remove": mutation("timeline.shape.geometry.dash.remove", [], {})
} satisfies MotionDebugCommandMetadata;

function pointGeometry(kind: "line" | "polyline" | "polygon", minItems: number, maxItems: number): MotionDebugArgPropertySchema {
  return {
    type: "object", required: ["schema", "kind", "viewBox", "points"], additionalProperties: false,
    properties: {
      ...BASE_GEOMETRY_PROPERTIES,
      kind: { type: "string", enum: [kind], description: `${kind} geometry discriminant.` },
      points: { type: "array", items: POINT_SCHEMA, minItems, maxItems, description: `Ordered ${kind} vertices.` }
    },
    description: `Exact bounded ${kind} geometry.`
  };
}

function arcGeometry(kind: "arc" | "sector", innerRadius: boolean): MotionDebugArgPropertySchema {
  return {
    type: "object", required: ["schema", "kind", "viewBox", "center", "radius", "startAngleDeg", "sweepAngleDeg"], additionalProperties: false,
    properties: {
      ...BASE_GEOMETRY_PROPERTIES,
      kind: { type: "string", enum: [kind], description: `${kind} geometry discriminant.` },
      center: POINT_SCHEMA,
      radius: { type: "number", exclusiveMinimum: 0, maximum: MAX_MOTION_SHAPE_GEOMETRY_COORDINATE, description: "Positive outer radius." },
      ...(innerRadius ? { innerRadius: { type: "number" as const, minimum: 0, maximum: MAX_MOTION_SHAPE_GEOMETRY_COORDINATE, description: "Optional non-negative inner radius below radius." } } : {}),
      startAngleDeg: { type: "number", description: "Finite start angle in degrees." },
      sweepAngleDeg: { type: "number", description: "Finite non-zero bounded sweep angle in degrees." }
    },
    description: `Exact bounded ${kind} geometry.`
  };
}
