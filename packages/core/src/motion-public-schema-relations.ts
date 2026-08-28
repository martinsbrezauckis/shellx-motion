import {
  MAX_MOTION_RELATION_BINDINGS,
  MAX_MOTION_RELATION_COORDINATE,
  MAX_MOTION_RELATION_DURATION_US,
  MAX_MOTION_RELATION_ROTATION_DEGREES,
  MAX_MOTION_RELATION_SCALE,
  MIN_MOTION_RELATION_SCALE,
  MOTION_RELATIONS_SCHEMA,
} from "./motion-relation-types";

/** Exact portable structure for the public `relations@1` root; document ownership stays in Core. */
export function buildMotionRelationDefinitions(): Record<string, unknown> {
  const identifier = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" };
  const coordinate = { type: "number", minimum: -MAX_MOTION_RELATION_COORDINATE, maximum: MAX_MOTION_RELATION_COORDINATE };
  const endpoint = {
    type: "object", required: ["layerId", "anchor"], additionalProperties: false,
    properties: {
      layerId: identifier,
      anchor: { type: "object", required: ["x", "y"], additionalProperties: false, properties: { x: coordinate, y: coordinate } },
    },
  };
  const offset = {
    type: "object", required: ["space", "x", "y", "rotationDeg", "scale"], additionalProperties: false,
    properties: {
      space: { enum: ["source", "world"] }, x: coordinate, y: coordinate,
      rotationDeg: { type: "number", minimum: -MAX_MOTION_RELATION_ROTATION_DEGREES, maximum: MAX_MOTION_RELATION_ROTATION_DEGREES },
      scale: { type: "number", minimum: MIN_MOTION_RELATION_SCALE, maximum: MAX_MOTION_RELATION_SCALE },
    },
  };
  const common = {
    id: identifier,
    enabled: { type: "boolean" },
    source: endpoint,
    target: endpoint,
    startUs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    durationUs: { type: "integer", minimum: 1, maximum: MAX_MOTION_RELATION_DURATION_US },
  };
  return {
    motionRelations: {
      type: "object", required: ["schema", "bindings"], additionalProperties: false,
      properties: { schema: { const: MOTION_RELATIONS_SCHEMA }, bindings: { type: "array", minItems: 1, maxItems: MAX_MOTION_RELATION_BINDINGS, items: { $ref: "#/$defs/motionRelation" } } },
      $comment: "Runtime requires strict UTF-16/code-unit id order, exact document-us bounds, root-owned shape endpoints, acyclic dependencies, and exclusive transform authority even for disabled bindings.",
    },
    motionRelation: {
      oneOf: [
        {
          type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "mode", "offset"], additionalProperties: false,
          properties: { ...common, kind: { const: "attach" }, mode: { enum: ["follow", "similarity"] }, offset },
          allOf: [{
            if: { required: ["mode"], properties: { mode: { const: "follow" } } },
            then: { properties: { offset: {
              required: ["rotationDeg", "scale"],
              properties: { rotationDeg: { const: 0 }, scale: { const: 1 } },
            } } },
          }],
        },
        {
          type: "object", required: ["id", "enabled", "kind", "source", "target", "startUs", "durationUs", "rotationOffsetDeg"], additionalProperties: false,
          properties: { ...common, kind: { const: "aim" }, rotationOffsetDeg: { type: "number", minimum: -MAX_MOTION_RELATION_ROTATION_DEGREES, maximum: MAX_MOTION_RELATION_ROTATION_DEGREES } },
        },
      ],
    },
  };
}
