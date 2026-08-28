import {
  MAX_MOTION_LAYOUT_DIMENSION,
  MAX_MOTION_LAYOUT_GRID_COLUMNS,
  MAX_MOTION_LAYOUT_REPEATER_INSTANCES,
  MAX_MOTION_LAYOUT_ROTATION,
  MAX_MOTION_LAYOUT_SCALE,
  MAX_MOTION_LAYOUT_TIME_MS
} from "./motion-layout-types";

const ID = { type: "string", minLength: 1, maxLength: 128 };
const SHA256 = { type: "string", pattern: "^[a-f0-9]{64}$" };

/** Exact document-resident layout-application records; no runtime-only rollback state is implied. */
export function buildLayoutApplicationDefinitions(): Record<string, unknown> {
  return {
    layoutApplication: {
      type: "object",
      required: ["schema", "id", "fingerprint", "groupId", "layoutFingerprint", "childLayerIds", "materializedChildLayerIds", "layout", "repeaters", "patches", "trackPatches", "generatedLayers"],
      properties: {
        schema: { const: "shellx-motion/layout-application@1" }, id: ID, fingerprint: SHA256, groupId: ID, layoutFingerprint: SHA256,
        childLayerIds: identifierArray(1, 256), materializedChildLayerIds: identifierArray(1, 256),
        layout: { $ref: "#/$defs/layoutApplicationLayout" }, repeaters: { type: "array", maxItems: 16, items: { $ref: "#/$defs/layoutApplicationRepeater" } },
        patches: { type: "array", maxItems: 256, items: { $ref: "#/$defs/layoutApplicationPatch" } },
        trackPatches: { type: "array", maxItems: 256, items: { $ref: "#/$defs/layoutApplicationTrackPatch" } },
        generatedLayers: { type: "array", maxItems: 256, items: { $ref: "#/$defs/layoutApplicationGeneratedLayer" } }
      },
      additionalProperties: false
    },
    layoutApplicationLayout: { oneOf: [layoutVariant("row"), layoutVariant("column"), layoutVariant("stack"), layoutVariant("grid"), layoutVariant("radial")] },
    layoutApplicationPadding: { type: "object", required: ["top", "right", "bottom", "left"], properties: { top: nonNegativeDimension(), right: nonNegativeDimension(), bottom: nonNegativeDimension(), left: nonNegativeDimension() }, additionalProperties: false },
    layoutApplicationAlign: { type: "object", required: ["x", "y"], properties: { x: { enum: ["start", "center", "end", "stretch"] }, y: { enum: ["start", "center", "end", "stretch"] } }, additionalProperties: false },
    layoutApplicationRepeater: {
      type: "object", required: ["schema", "sourceId", "count", "transformDelta", "opacityDelta", "indexTimeStaggerMs"],
      properties: {
        schema: { const: "shellx-motion/repeater@1" }, sourceId: ID, count: { type: "integer", minimum: 1, maximum: MAX_MOTION_LAYOUT_REPEATER_INSTANCES },
        transformDelta: { type: "object", required: ["x", "y", "scale", "rotation"], properties: { x: boundedSignedDimension(), y: boundedSignedDimension(), scale: { type: "number", minimum: -MAX_MOTION_LAYOUT_SCALE, maximum: MAX_MOTION_LAYOUT_SCALE }, rotation: boundedRotation() }, additionalProperties: false },
        opacityDelta: { type: "number", minimum: -1, maximum: 1 }, indexTimeStaggerMs: { type: "integer", minimum: 0, maximum: MAX_MOTION_LAYOUT_TIME_MS }
      }, additionalProperties: false
    },
    layoutApplicationPatch: { type: "object", required: ["layerId", "before", "after"], properties: { layerId: ID, before: { $ref: "#/$defs/layoutApplicationSnapshot" }, after: { $ref: "#/$defs/layoutApplicationSnapshot" } }, additionalProperties: false },
    layoutApplicationSnapshot: { type: "object", required: ["transform", "timing"], properties: { transform: { $ref: "#/$defs/layoutApplicationTransform" }, timing: { $ref: "#/$defs/layoutApplicationTiming" } }, additionalProperties: false },
    layoutApplicationTransform: {
      type: "object", required: ["width", "height"],
      properties: { x: boundedSignedDimension(), y: boundedSignedDimension(), width: { type: "number", exclusiveMinimum: 0, maximum: MAX_MOTION_LAYOUT_DIMENSION }, height: { type: "number", exclusiveMinimum: 0, maximum: MAX_MOTION_LAYOUT_DIMENSION }, scale: { type: "number", exclusiveMinimum: 0, maximum: MAX_MOTION_LAYOUT_SCALE }, rotation: boundedRotation(), opacity: { type: "number", minimum: 0, maximum: 1 } },
      patternProperties: { "^x-": {} }, additionalProperties: false
    },
    layoutApplicationTiming: { type: "object", required: ["startMs", "durationMs"], properties: { startMs: { type: "integer", minimum: 0, maximum: MAX_MOTION_LAYOUT_TIME_MS }, durationMs: { type: "integer", minimum: 1, maximum: MAX_MOTION_LAYOUT_TIME_MS } }, additionalProperties: false },
    layoutApplicationTrackPatch: { type: "object", required: ["trackId", "beforeLayerIds", "afterLayerIds"], properties: { trackId: ID, beforeLayerIds: identifierArray(0, 512), afterLayerIds: identifierArray(0, 512) }, additionalProperties: false },
    layoutApplicationGeneratedLayer: { type: "object", required: ["id", "sourceLayerId", "instanceIndex", "layerSha256"], properties: { id: ID, sourceLayerId: ID, instanceIndex: { type: "integer", minimum: 1, maximum: 128 }, layerSha256: SHA256 }, additionalProperties: false }
  };
}

function layoutVariant(kind: "row" | "column" | "stack" | "grid" | "radial"): Record<string, unknown> {
  const common = {
    schema: { const: "shellx-motion/layout@1" }, kind: { const: kind }, width: positiveDimension(), height: positiveDimension(),
    padding: { $ref: "#/$defs/layoutApplicationPadding" }, gap: nonNegativeDimension(),
    align: { $ref: "#/$defs/layoutApplicationAlign" }, distribution: { enum: ["start", "center", "end", "space-between", "space-around", "space-evenly"] }, overflow: { enum: ["clip", "allow"] }
  };
  const properties = kind === "grid" ? { ...common, columns: { type: "integer", minimum: 1, maximum: MAX_MOTION_LAYOUT_GRID_COLUMNS } }
    : kind === "radial" ? { ...common, radius: nonNegativeDimension(), startAngleDeg: boundedRotation(), sweepAngleDeg: boundedRotation() }
      : common;
  return { type: "object", required: Object.keys(properties), properties, additionalProperties: false };
}

function identifierArray(minItems: number, maxItems: number): Record<string, unknown> { return { type: "array", minItems, maxItems, uniqueItems: true, items: ID }; }
function positiveDimension(): Record<string, unknown> { return { type: "number", minimum: 1, maximum: MAX_MOTION_LAYOUT_DIMENSION }; }
function nonNegativeDimension(): Record<string, unknown> { return { type: "number", minimum: 0, maximum: MAX_MOTION_LAYOUT_DIMENSION }; }
function boundedSignedDimension(): Record<string, unknown> { return { type: "number", minimum: -MAX_MOTION_LAYOUT_DIMENSION, maximum: MAX_MOTION_LAYOUT_DIMENSION }; }
function boundedRotation(): Record<string, unknown> { return { type: "number", minimum: -MAX_MOTION_LAYOUT_ROTATION, maximum: MAX_MOTION_LAYOUT_ROTATION }; }
