import { describe, expect, it } from "vitest";
import { compileGpuScenePathGeometry, GPU_SCENE_PATH_GEOMETRY_SCHEMA, tessellateGpuScenePathGeometry } from "./gpu-scene-path-geometry";
import type { MotionLayer } from "./types";

function path(overrides: Partial<MotionLayer> = {}): MotionLayer {
  return {
    id: "badge",
    type: "shape",
    shape: "path",
    startMs: 0,
    durationMs: 1_000,
    "x-path": "M 0 0 L 100 0 L 100 100 L 0 100 Z",
    "x-path-viewBox": "0 0 100 100",
    style: { stroke: "#ff0080", strokeWidth: 4, strokeLinejoin: "miter", strokeLinecap: "butt" },
    ...overrides
  };
}

describe("GPU scene path geometry", () => {
  it("canonicalizes one immutable convex linear contour and tessellates its fill and miter stroke", () => {
    const first = compileGpuScenePathGeometry(path());
    const second = compileGpuScenePathGeometry(path({ "x-path": "M0,0 L100,0 L100,100 L0,100 Z" }));
    expect(first).toMatchObject({
      ok: true,
      geometry: {
        schema: GPU_SCENE_PATH_GEOMETRY_SCHEMA,
        viewBox: { x: 0, y: 0, width: 100, height: 100 },
        contours: [{ closed: true, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }],
        fillRule: "nonzero",
        stroke: { width: 4, join: "miter", cap: "butt" }
      }
    });
    if (!first.ok || !second.ok) return;
    expect(first.geometry.fingerprint).toBe(second.geometry.fingerprint);
    expect(Object.isFrozen(first.geometry)).toBe(true);
    expect(Object.isFrozen(first.geometry.contours[0].vertices)).toBe(true);
    const triangles = tessellateGpuScenePathGeometry({
      geometry: first.geometry,
      box: { x: 10, y: 20, width: 40, height: 20 },
      fill: { r: 0, g: 0.5, b: 1, a: 1 },
      stroke: { r: 1, g: 0, b: 0.5, a: 1 },
      strokeWidth: 4
    });
    expect(triangles).toHaveLength(30);
    expect(triangles.slice(0, 3)).toEqual([
      { x: 10, y: 20, color: { r: 0, g: 0.5, b: 1, a: 1 } },
      { x: 50, y: 20, color: { r: 0, g: 0.5, b: 1, a: 1 } },
      { x: 50, y: 40, color: { r: 0, g: 0.5, b: 1, a: 1 } }
    ]);
    expect(triangles[6]).toMatchObject({ x: 8, y: 18, color: { r: 1, g: 0, b: 0.5, a: 1 } });
  });

  it("flattens relative quadratic and cubic commands into a bounded, fingerprinted simple contour", () => {
    const result = compileGpuScenePathGeometry(path({
      "x-path": "m 0 0 q 50 0 50 50 c 0 25 25 50 50 50 l -100 0 z"
    }));
    expect(result).toMatchObject({ ok: true, geometry: { schema: GPU_SCENE_PATH_GEOMETRY_SCHEMA, fillTriangleIndices: expect.any(Array) } });
    if (!result.ok) return;
    expect(result.geometry.contours[0].vertices.length).toBeGreaterThan(5);
    expect(result.geometry.contours[0].vertices.length).toBeLessThanOrEqual(128);
    expect(result.geometry.fillTriangleIndices).toHaveLength((result.geometry.contours[0].vertices.length - 2) * 3);
    expect(result.geometry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ear-clips one concave contour and emits a bounded butt-capped path-reveal stroke window", () => {
    const result = compileGpuScenePathGeometry(path({
      "x-path": "M 0 0 L 100 0 L 100 100 L 50 50 L 0 100 Z"
    }));
    expect(result).toMatchObject({ ok: true, geometry: { contours: [{ vertices: expect.any(Array) }], fillTriangleIndices: expect.any(Array) } });
    if (!result.ok) return;
    const fill = tessellateGpuScenePathGeometry({ geometry: result.geometry, box: { x: 0, y: 0, width: 100, height: 100 }, fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null, strokeWidth: 0 });
    expect(fill).toHaveLength(9);
    const reveal = tessellateGpuScenePathGeometry({ geometry: result.geometry, box: { x: 0, y: 0, width: 100, height: 100 }, fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: { r: 0, g: 1, b: 0, a: 1 }, strokeWidth: 4, reveal: { start: 0, end: 0.25 } });
    expect(reveal).toHaveLength(12);
    expect(reveal.every((vertex) => vertex.color.g === 1)).toBe(true);
    expect(tessellateGpuScenePathGeometry({ geometry: result.geometry, box: { x: 0, y: 0, width: 100, height: 100 }, fill: null, stroke: { r: 0, g: 1, b: 0, a: 1 }, strokeWidth: 4, reveal: { start: 0.5, end: 0.5 } })).toEqual([]);
  });

  it.each([
    ["M 0 0 A 10 10 0 0 1 100 100 Z", "permits only M, L, H, V, Q, C, and terminal Z commands"],
    ["M 0 0 L 100 0 L 100 100", "requires at least three vertices and one terminal Z closure"],
    ["M 0 0 L 100 100 L 0 100 L 100 0 Z", "refuses self-intersecting contours"],
    ["M 0 0 L 100 0 L 100 100 L 0 100 Z M 20 20 L 80 20 L 80 80 L 20 80 Z", "requires one terminal Z closure"]
  ])("refuses unsupported SVG geometry %s", (pathData, message) => {
    expect(compileGpuScenePathGeometry(path({ "x-path": pathData }))).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("refuses nonzero-external fill rules, unsupported stroke joins/caps, and viewBox escape", () => {
    expect(compileGpuScenePathGeometry(path({ "x-path-fillRule": "evenodd" }))).toEqual({ ok: false, message: expect.stringContaining("only nonzero fillRule") });
    expect(compileGpuScenePathGeometry(path({ style: { stroke: "#fff", strokeWidth: 2, strokeLinejoin: "round" } }))).toEqual({ ok: false, message: expect.stringContaining("miter stroke join") });
    expect(compileGpuScenePathGeometry(path({ style: { stroke: "#fff", strokeWidth: 2, strokeLinecap: "round" } }))).toEqual({ ok: false, message: expect.stringContaining("butt stroke cap") });
    expect(compileGpuScenePathGeometry(path({ "x-path": "M 0 0 L 101 0 L 100 100 Z" }))).toEqual({ ok: false, message: expect.stringContaining("stay inside its declared viewBox") });
  });
});
