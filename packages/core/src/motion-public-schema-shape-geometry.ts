/** Closed public-schema definitions for v1 authored shape geometry. */
export function buildShapeGeometryDefinitions(): Record<string, unknown> {
  const point = { $ref: "#/$defs/shapeGeometryPoint" };
  const viewBox = { $ref: "#/$defs/shapeGeometryViewBox" };
  const common = { schema: { const: "shellx-motion/shape-geometry@1" }, viewBox };
  const points = (kind: "line" | "polyline" | "polygon", minItems: number, maxItems: number) => ({
    type: "object",
    required: ["schema", "kind", "viewBox", "points"],
    additionalProperties: false,
    properties: { ...common, kind: { const: kind }, points: { type: "array", minItems, maxItems, items: point } }
  });
  const arc = (kind: "arc" | "sector") => ({
    type: "object",
    required: ["schema", "kind", "viewBox", "center", "radius", "startAngleDeg", "sweepAngleDeg"],
    additionalProperties: false,
    properties: {
      ...common,
      kind: { const: kind },
      center: point,
      radius: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 },
      ...(kind === "sector" ? { innerRadius: { type: "number", minimum: 0, maximum: 1_000_000 } } : {}),
      startAngleDeg: { type: "number" },
      sweepAngleDeg: { type: "number", minimum: -360, maximum: 360 }
    }
  });
  return {
    shapeGeometryKeyframes: {
      type: "object",
      required: ["schema", "keyframes"],
      additionalProperties: false,
      properties: {
        schema: { const: "shellx-motion/shape-geometry-keyframes@1" },
        keyframes: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            required: ["atUs", "geometry"],
            additionalProperties: false,
            properties: {
              atUs: { type: "integer", minimum: 0, maximum: 1_000_000_000_000 },
              geometry: { $ref: "#/$defs/shapeGeometry" },
              easing: { $ref: "#/$defs/easing" }
            }
          }
        }
      },
      $comment: "Runtime requires exact safe-integer microseconds and one fixed kind, viewBox, point/path topology, and bounded interpolation workload against the owning shape geometry."
    },
    shapeGeometry: {
      oneOf: [
        points("line", 2, 2),
        points("polyline", 2, 128),
        points("polygon", 3, 128),
        arc("arc"),
        arc("sector"),
        {
          type: "object",
          required: ["schema", "kind", "viewBox", "data"],
          additionalProperties: false,
          properties: { ...common, kind: { const: "path" }, data: { type: "string", minLength: 1, maxLength: 16_384 } }
        }
      ],
      $comment: "Exact-key v1 authored shape geometry. Runtime validates finite values, in-viewBox coordinates, arc lowering, topology, and legacy ambiguity."
    },
    shapeGeometryViewBox: {
      type: "object",
      required: ["x", "y", "width", "height"],
      additionalProperties: false,
      properties: {
        x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
        y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
        width: { type: "number", exclusiveMinimum: 0, maximum: 2_000_000 },
        height: { type: "number", exclusiveMinimum: 0, maximum: 2_000_000 }
      }
    },
    shapeGeometryPoint: {
      type: "object",
      required: ["x", "y"],
      additionalProperties: false,
      properties: {
        x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
        y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 }
      }
    }
  };
}
