import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import type { MotionDocument } from "./types";

function pathScene(): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "gpu-path-plan", name: "GPU path plan", durationMs: 1_000, fps: 30, width: 100, height: 60, background: "#102030ff", assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [] };
}

describe("GPU path scene-plan lowering", () => {
  it.each(["path", "freeform"] as const)("lowers one closed bounded %s contour into fixed colored triangles", (shape) => {
    const motion = pathScene();
    motion.layers = [{ id: `${shape}-shape`, type: "shape", shape, startMs: 0, durationMs: 1_000, fill: "#4080c080", transform: { x: 10, y: 5, width: 40, height: 20, rotation: 15 }, "x-path": "M 0 0 L 40 0 L 40 20 L 0 20 Z", "x-path-viewBox": "0 0 40 20", style: { stroke: "#ff0080", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" } }];
    const result = compileGpuScene2dPlan(motion, 0);
    expect(result).toMatchObject({ ok: true, plan: { shapeCount: 1, frame: { budget: { triangleVertexCount: 30, triangleBufferBytes: 720 }, draws: [{ kind: "coloredTriangles", id: `${shape}-shape`, rotationDeg: 15, pivotX: 30, pivotY: 15, vertices: expect.arrayContaining([{ x: 10, y: 5, color: { r: expect.closeTo(64 / 255), g: expect.closeTo(128 / 255), b: expect.closeTo(192 / 255), a: expect.closeTo(128 / 255) } }]) }] } } });
    if (!result.ok) return;
    expect(result.plan.frame.fingerprint).toBe(shape === "path"
      ? "9f1019d6da49e4bdd0efc10975cd46dad80f3d6fb4370b7728d29434efec77a1"
      : "4f55b962be2abc6ede9e4f9d2c9f838a7d638f8277512d0cf4c73f5db1b3d3f9");
  });

  it.each(["path", "freeform"] as const)("refuses malformed, open, or self-crossing %s contours with a typed feature failure", (shape) => {
    const motion = pathScene();
    for (const [id, path] of [[`${shape}-open`, "M 0 0 L 40 20"], [`${shape}-crossed`, "M 0 0 L 40 20 L 0 20 L 40 0 Z"]] as const) {
      motion.layers = [{ id, type: "shape", shape, startMs: 0, durationMs: 1_000, transform: { width: 40, height: 20 }, "x-path": path, "x-path-viewBox": "0 0 40 20" }];
      expect(compileGpuScene2dPlan(motion, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: id, message: expect.stringMatching(/requires at least three vertices|refuses self-intersecting contours/) } });
    }
  });

  it("lowers a relative concave path and exact animated GPU stroke-window without fabricating fill", () => {
    const motion = pathScene();
    motion.layers = [{ id: "reveal", type: "shape", shape: "path", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 5, width: 40, height: 20 }, "x-path": "m 0 0 l 40 0 l 0 20 l -20 -10 l -20 10 z", "x-path-viewBox": "0 0 40 20", style: { stroke: "#00ff00", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" }, pathReveal: { start: 0, end: 0.5 }, keyframes: { "pathReveal.end": [{ atMs: 0, value: 0.5 }, { atMs: 1_000, value: 0.25 }] } }];
    const first = compileGpuScene2dPlan(motion, 0), later = compileGpuScene2dPlan(motion, 500);
    expect(first).toMatchObject({ ok: true, plan: { frame: { draws: [{ kind: "coloredTriangles", id: "reveal", vertices: expect.any(Array) }] } } });
    expect(later).toMatchObject({ ok: true, plan: { frame: { draws: [{ kind: "coloredTriangles", id: "reveal", vertices: expect.any(Array) }] } } });
    if (!first.ok || !later.ok) return;
    const firstDraw = first.plan.frame.draws[0], laterDraw = later.plan.frame.draws[0];
    expect(firstDraw.kind === "coloredTriangles" && laterDraw.kind === "coloredTriangles" && firstDraw.vertices.length > laterDraw.vertices.length).toBe(true);
    motion.layers[0].pathReveal = { start: 0.75, end: 0.25 };
    expect(compileGpuScene2dPlan(motion, 0)).toMatchObject({ ok: true, plan: { frame: { draws: [] } } });
  });
});
