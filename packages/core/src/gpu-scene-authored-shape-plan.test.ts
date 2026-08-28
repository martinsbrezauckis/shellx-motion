import { describe, expect, it } from "vitest";
import { compileGpuSceneAuthoredShapeGeometry, tessellateGpuSceneAuthoredShapeGeometry } from "./gpu-scene-path-geometry";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { GPU_SCENE_AUTHORED_OPEN_STROKE_MAX_VERTICES, gpuSceneAuthoredOpenMiterProblem } from "./gpu-scene-path-tessellation";
import { MOTION_SHAPE_GEOMETRY_SCHEMA } from "./motion-shape-geometry";
import type { MotionDocument, MotionShapeGeometry } from "./types";

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };
const STROKE = { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" };

function shapeDocument(id: string, geometry: MotionShapeGeometry, extras: Record<string, unknown> = {}): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: `gpu-${id}`, name: id, durationMs: 1_000, fps: 30, width: 100, height: 100,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id, type: "shape", startMs: 0, durationMs: 1_000, geometry, transform: { width: 100, height: 100 }, ...extras }]
  };
}

function line(points: [{ x: number; y: number }, { x: number; y: number }]): Extract<MotionShapeGeometry, { kind: "line" }> {
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "line", viewBox: VIEW_BOX, points };
}

function polyline(points: Array<{ x: number; y: number }>): Extract<MotionShapeGeometry, { kind: "polyline" }> {
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "polyline", viewBox: VIEW_BOX, points };
}

function arc(center: { x: number; y: number }, radius: number, startAngleDeg: number, sweepAngleDeg: number): Extract<MotionShapeGeometry, { kind: "arc" }> {
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "arc", viewBox: VIEW_BOX, center, radius, startAngleDeg, sweepAngleDeg };
}

describe("GPU v1 authored shape plan lowering", () => {
  it.each([
    ["line", line([{ x: 0, y: 50 }, { x: 100, y: 50 }]), { style: STROKE }],
    ["polyline", polyline([{ x: 0, y: 25 }, { x: 50, y: 75 }, { x: 100, y: 25 }]), { style: STROKE }],
    ["polygon", { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "polygon", viewBox: VIEW_BOX, points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 90 }] } satisfies MotionShapeGeometry, {}],
    ["arc", arc({ x: 50, y: 50 }, 30, 0, 90), { style: STROKE }],
    ["sector", { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "sector", viewBox: VIEW_BOX, center: { x: 50, y: 50 }, radius: 30, innerRadius: 10, startAngleDeg: 0, sweepAngleDeg: 120 } satisfies MotionShapeGeometry, {}],
    ["path", { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox: VIEW_BOX, data: "M 0 0 L 100 0 L 100 100 L 0 100 Z" } satisfies MotionShapeGeometry, {}]
  ] as const)("lowers v1 %s into an ordinary fixed GPU triangle draw", (id, geometry, extras) => {
    const result = compileGpuScene2dPlan(shapeDocument(id, geometry, extras), 0);
    expect(result).toMatchObject({ ok: true, plan: { shapeCount: 1, frame: { draws: [{ kind: "coloredTriangles", id, vertices: expect.any(Array) }] } } });
    if (!result.ok) return;
    const draw = result.plan.frame.draws[0];
    expect(draw.kind).toBe("coloredTriangles");
    if (draw.kind === "coloredTriangles") expect(draw.vertices.length).toBeGreaterThan(0);
  });

  it("refuses unsupported open-contour paint instead of silently dropping it", () => {
    const geometry = line([{ x: 0, y: 50 }, { x: 100, y: 50 }]);
    expect(compileGpuScene2dPlan(shapeDocument("paint", geometry, { fill: "#ff0000", style: STROKE }), 0)).toMatchObject({
      ok: false, failure: { code: "gpu_unsupported_feature", layerId: "paint", message: expect.stringContaining("stroke-only") }
    });
    expect(compileGpuScene2dPlan(shapeDocument("round-join", geometry, { style: { ...STROKE, strokeLinejoin: "round" } }), 0)).toMatchObject({
      ok: false, failure: { code: "gpu_unsupported_feature", layerId: "round-join", message: expect.stringContaining("miter") }
    });
  });

  it("refuses concave closed v1 strokes instead of falling back to disconnected quads", () => {
    const fixtures = [
      ["concave-polygon", { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "polygon", viewBox: VIEW_BOX, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }],
      ["concave-path", { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox: VIEW_BOX, data: "M 0 0 L 100 0 L 50 50 L 100 100 L 0 100 Z" }],
      ["annular-sector", { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "sector", viewBox: VIEW_BOX, center: { x: 50, y: 50 }, radius: 40, innerRadius: 10, startAngleDeg: 0, sweepAngleDeg: 120 }]
    ] as const satisfies readonly [string, MotionShapeGeometry][];
    for (const [id, geometry] of fixtures) expect(compileGpuScene2dPlan(shapeDocument(id, geometry, { style: STROKE }), 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: id, message: expect.stringContaining("concave stroked contour") } });
  });

  it("realizes butt caps and connected exact miters, including a collinear continuation", () => {
    const rightAngle = polyline([{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }]);
    const compiled = compileGpuSceneAuthoredShapeGeometry(shapeDocument("right-angle", rightAngle, { style: STROKE }).layers[0]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const triangles = tessellateGpuSceneAuthoredShapeGeometry({ geometry: compiled.geometry, box: VIEW_BOX, fill: null, stroke: { r: 1, g: 1, b: 1, a: 1 }, strokeWidth: 2 });
    expect(triangles).toHaveLength(12);
    expect(triangles[1]).toMatchObject({ x: 51, y: 49 });
    expect(triangles[6]).toMatchObject({ x: 51, y: 49 });
    expect(Math.min(...triangles.map((vertex) => vertex.x))).toBe(0);

    const collinear = polyline([{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 50 }]);
    const collinearCompiled = compileGpuSceneAuthoredShapeGeometry(shapeDocument("collinear", collinear, { style: STROKE }).layers[0]);
    expect(collinearCompiled.ok).toBe(true);
    if (!collinearCompiled.ok) return;
    const collinearTriangles = tessellateGpuSceneAuthoredShapeGeometry({ geometry: collinearCompiled.geometry, box: VIEW_BOX, fill: null, stroke: { r: 1, g: 1, b: 1, a: 1 }, strokeWidth: 2 });
    expect(collinearTriangles).toHaveLength(12);
    expect(collinearTriangles[1]).toMatchObject({ x: 50, y: 49 });
    expect(collinearTriangles[6]).toMatchObject({ x: 50, y: 49 });
  });

  it("refuses acute and reversal joins, while retaining the bounded 128-point output ceiling", () => {
    const acute = polyline([{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 1, y: 60 }]);
    expect(compileGpuScene2dPlan(shapeDocument("acute", acute, { style: STROKE }), 0)).toMatchObject({
      ok: false, failure: { code: "gpu_unsupported_feature", layerId: "acute", message: expect.stringContaining("miter limit") }
    });
    const reversal = polyline([{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 0, y: 50 }]);
    expect(compileGpuScene2dPlan(shapeDocument("reversal", reversal, { style: STROKE }), 0)).toMatchObject({
      ok: false, failure: { code: "gpu_unsupported_feature", layerId: "reversal", message: expect.stringContaining("180-degree") }
    });

    const points = Array.from({ length: 128 }, (_, index) => ({ x: index, y: 50 }));
    const largest = { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "polyline", viewBox: { x: 0, y: 0, width: 127, height: 100 }, points } satisfies MotionShapeGeometry;
    const compiled = compileGpuSceneAuthoredShapeGeometry(shapeDocument("largest", largest, { style: STROKE }).layers[0]);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(gpuSceneAuthoredOpenMiterProblem({ geometry: compiled.geometry, box: { x: 0, y: 0, width: 127, height: 100 }, strokeWidth: 2 })).toBeNull();
    const triangles = tessellateGpuSceneAuthoredShapeGeometry({ geometry: compiled.geometry, box: { x: 0, y: 0, width: 127, height: 100 }, fill: null, stroke: { r: 1, g: 1, b: 1, a: 1 }, strokeWidth: 2 });
    expect(triangles).toHaveLength(762);
    expect(triangles.length).toBeLessThanOrEqual(GPU_SCENE_AUTHORED_OPEN_STROKE_MAX_VERTICES);
  });
});
