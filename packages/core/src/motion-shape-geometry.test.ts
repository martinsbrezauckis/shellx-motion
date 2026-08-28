import { describe, expect, it } from "vitest";
import { compileGpuSceneAuthoredShapeGeometry, compileGpuScenePathGeometry, tessellateGpuSceneAuthoredShapeGeometry } from "./gpu-scene-path-geometry";
import { buildMotionPublicSchema } from "./motion-public-schema";
import { MOTION_SHAPE_GEOMETRY_SCHEMA, resolveMotionShapeGeometry } from "./motion-shape-geometry";
import { loadSchema, validateDocument } from "./validate";
import type { MotionLayer } from "./types";

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };

function layer(geometry: Record<string, unknown>, extras: Record<string, unknown> = {}): MotionLayer {
  return {
    id: "geometry",
    type: "shape",
    startMs: 0,
    durationMs: 1_000,
    geometry: geometry as unknown as MotionLayer["geometry"],
    style: { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" },
    ...extras
  };
}

function geometry(kind: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind, viewBox: VIEW_BOX, ...fields };
}

function documentWith(geometryValue: unknown, layerExtras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "geometry-doc",
    name: "Geometry",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 100,
    layers: [{ id: "geometry", type: "shape", startMs: 0, durationMs: 1_000, geometry: geometryValue, ...layerExtras }],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" }
  };
}

describe("motion shape geometry v1", () => {
  it("publishes an exact-key discriminated v1 record schema", () => {
    const schema = buildMotionPublicSchema() as { $defs: Record<string, unknown> };
    const geometrySchema = schema.$defs.shapeGeometry as { oneOf: Array<Record<string, unknown>> };
    expect((schema.$defs.layer as { properties: Record<string, unknown> }).properties.geometry).toEqual({ $ref: "#/$defs/shapeGeometry" });
    expect(geometrySchema.oneOf).toHaveLength(6);
    expect(geometrySchema.oneOf.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(geometrySchema.oneOf.map((branch) => (branch.properties as Record<string, { const: string }>).kind.const)).toEqual(["line", "polyline", "polygon", "arc", "sector", "path"]);
    expect(schema.$defs.layerStyle).toMatchObject({
      properties: { strokeDasharray: { type: "array", minItems: 1, maxItems: 32, items: { type: "number", exclusiveMinimum: 0, maximum: 4096 } }, strokeDashoffset: { type: "number", minimum: -1_000_000, maximum: 1_000_000 } },
      allOf: [{ if: { required: ["strokeDashoffset"] }, then: { required: ["strokeDasharray"] } }]
    });
  });

  it("resolves each admitted primitive to deterministic bounded canonical contour data", () => {
    const fixtures = [
      geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }),
      geometry("polyline", { points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }] }),
      geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }),
      geometry("arc", { center: { x: 50, y: 50 }, radius: 25, startAngleDeg: 0, sweepAngleDeg: 90 }),
      geometry("sector", { center: { x: 50, y: 50 }, radius: 25, innerRadius: 10, startAngleDeg: 0, sweepAngleDeg: 90 }),
      geometry("path", { data: "M 0 0 L 100 0 L 100 100 L 0 100 Z" })
    ];
    const resolved = fixtures.map((value) => resolveMotionShapeGeometry(layer(value)));
    expect(resolved.every((value) => value.ok)).toBe(true);
    if (!resolved.every((value) => value.ok)) return;
    expect(resolved.map((value) => value.geometry.closed)).toEqual([false, false, true, false, true, true]);
    expect(resolved[3].geometry.vertices.at(0)).toEqual({ x: 75, y: 50 });
    expect(resolved[3].geometry.vertices.at(-1)).toEqual({ x: 50, y: 75 });
    expect(resolved[4].geometry.vertices.length).toBeLessThanOrEqual(2 * 65);
  });

  it("lowers open geometry as stroke-only triangles with stable fingerprints", () => {
    const first = compileGpuSceneAuthoredShapeGeometry(layer(geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] })));
    const second = compileGpuSceneAuthoredShapeGeometry(layer(geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] })));
    expect(first).toMatchObject({ ok: true, geometry: { contour: { closed: false }, fillTriangleIndices: [] } });
    if (!first.ok || !second.ok) return;
    expect(first.geometry).not.toHaveProperty("strokeDash");
    expect(first.geometry.fingerprint).toBe(second.geometry.fingerprint);
    const triangles = tessellateGpuSceneAuthoredShapeGeometry({
      geometry: first.geometry,
      box: VIEW_BOX,
      fill: { r: 1, g: 0, b: 0, a: 1 },
      stroke: { r: 1, g: 1, b: 1, a: 1 },
      strokeWidth: 2
    });
    expect(triangles).toHaveLength(6);
  });

  it("requires an explicit supported stroke and refuses open-contour fill or gradients", () => {
    const value = geometry("arc", { center: { x: 50, y: 50 }, radius: 25, startAngleDeg: 0, sweepAngleDeg: 90 });
    expect(compileGpuSceneAuthoredShapeGeometry(layer(value, { style: {} }))).toEqual({ ok: false, message: expect.stringContaining("requires an explicit") });
    expect(compileGpuSceneAuthoredShapeGeometry(layer(value, { fill: "#ff0000" }))).toEqual({ ok: false, message: expect.stringContaining("stroke-only") });
    expect(compileGpuSceneAuthoredShapeGeometry(layer(value, { gradient: { type: "linear", stops: [] } }))).toEqual({ ok: false, message: expect.stringContaining("refuses gradients") });
  });

  it("uses the fixed 64-segment full-sweep sector lowering without a duplicate seam", () => {
    const full = compileGpuSceneAuthoredShapeGeometry(layer(geometry("sector", {
      center: { x: 50, y: 50 }, radius: 40, startAngleDeg: 0, sweepAngleDeg: 360
    })));
    expect(full).toMatchObject({ ok: true, geometry: { contour: { closed: true }, fillTriangleIndices: expect.any(Array) } });
    if (!full.ok) return;
    expect(full.geometry.contour.vertices).toHaveLength(65);
    expect(full.geometry.contour.vertices.at(0)).not.toEqual(full.geometry.contour.vertices.at(-1));
  });

  it("keeps the no-new-geometry legacy path object and fingerprint unchanged", () => {
    const legacy = compileGpuScenePathGeometry({
      id: "badge", type: "shape", shape: "path", startMs: 0, durationMs: 1_000,
      "x-path": "M 0 0 L 100 0 L 100 100 L 0 100 Z",
      "x-path-viewBox": "0 0 100 100",
      style: { stroke: "#ff0080", strokeWidth: 4, strokeLinejoin: "miter", strokeLinecap: "butt" }
    });
    expect(legacy).toMatchObject({
      ok: true,
      geometry: {
        schema: "shellx-motion/gpu-scene-path-geometry@2",
        contours: [{ closed: true, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }],
        fingerprint: "8e92f77a0adc7b8865f5442fd69c6552d1110f15231d15a7182ce48cfc12ec05"
      }
    });
  });

  it.each([
    [geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }] }), "adjacent duplicate"],
    [geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }] }), "self-intersecting"],
    [geometry("line", { points: [{ x: Number.NaN, y: 0 }, { x: 100, y: 100 }] }), "must be finite"],
    [geometry("line", { points: Array.from({ length: 129 }, (_, index) => ({ x: index, y: index })) }), "exactly 2"],
    [geometry("arc", { center: { x: 50, y: 50 }, radius: 0, startAngleDeg: 0, sweepAngleDeg: 90 }), "positive bounded radius"],
    [geometry("arc", { center: { x: 50, y: 50 }, radius: 0.0000001, startAngleDeg: 0, sweepAngleDeg: 90 }), "adjacent duplicate"],
    [geometry("arc", { center: { x: 50, y: 50 }, radius: 25, startAngleDeg: 0, sweepAngleDeg: 0.0000001 }), "adjacent duplicate"],
    [geometry("sector", { center: { x: 50, y: 50 }, radius: 25, innerRadius: 25, startAngleDeg: 0, sweepAngleDeg: 90 }), "innerRadius"],
    [{ ...geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }), surprise: true }, "unknown field"]
  ])("refuses hostile geometry %#", (value, message) => {
    expect(resolveMotionShapeGeometry(layer(value))).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("refuses ambiguous legacy and v1 geometry rather than silently choosing one", () => {
    const value = geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] });
    expect(resolveMotionShapeGeometry(layer(value, { shape: "path" }))).toEqual({ ok: false, message: expect.stringContaining("cannot combine geometry") });
    expect(resolveMotionShapeGeometry(layer(value, { "x-path": "M 0 0 L 1 1" }))).toEqual({ ok: false, message: expect.stringContaining("cannot combine geometry") });
  });

  it("rejects unknown keys, non-shape ownership, infinite values, and point limits through motion validation", async () => {
    const schema = await loadSchema("motion");
    const unknown = await validateDocument(schema, documentWith({ ...geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }), unknown: 1 }));
    const nonShape = await validateDocument(schema, documentWith(geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }), { type: "text" }));
    const infinite = await validateDocument(schema, documentWith(geometry("polyline", { points: [{ x: 0, y: 0 }, { x: Infinity, y: 100 }] })));
    const tooMany = await validateDocument(schema, documentWith(geometry("polygon", { points: Array.from({ length: 129 }, (_, index) => ({ x: index % 100, y: Math.floor(index / 100) })) })));
    for (const result of [unknown, nonShape, infinite, tooMany]) expect(result.ok).toBe(false);
    expect(unknown).toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ path: "/layers/0/geometry", message: expect.stringContaining("unknown field") })]) });
    expect(nonShape).toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ path: "/layers/0/geometry", message: expect.stringContaining("only on shape") })]) });
  });

  it("validates only the numeric v1 dash spelling and never ignores an offset", async () => {
    const schema = await loadSchema("motion");
    const valid = await validateDocument(schema, documentWith(geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }), {
      style: { stroke: "#ffffff", strokeWidth: 2, strokeDasharray: [3, 2, 1], strokeDashoffset: 1 }
    }));
    const malformed = await validateDocument(schema, documentWith(geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }), {
      style: { stroke: "#ffffff", strokeWidth: 2, strokeDasharray: ["3", 2] }
    }));
    const ignored = await validateDocument(schema, documentWith(geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] }), {
      style: { strokeDashoffset: 1 }
    }));
    expect(valid.ok).toBe(true);
    for (const result of [malformed, ignored]) expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ path: "/layers/0/geometry" })]) });
  });
});
