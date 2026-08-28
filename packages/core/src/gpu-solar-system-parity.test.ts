import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import type { MotionDocument } from "./types";

function motion(): MotionDocument { return { schema: "shellx-motion/motion@1", id: "solar-parity", name: "Solar parity", durationMs: 1_000, fps: 30, width: 100, height: 60, background: "#000000", assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [] }; }

describe("polished Solar System GPU parity", () => {
  it("composites the trail ribbon, caps and particle head once before glow and blend", () => {
    const scene = motion();
    scene.layers = [{ id: "sun-corona", type: "points", startMs: 0, durationMs: 1_000, color: "#80c0ffff", pointCloud: { points: [{ x: 10, y: 20, size: 6, opacity: 1 }], samples: [{ atMs: 0, positions: [{ x: 10, y: 20 }] }, { atMs: 1_000, positions: [{ x: 30, y: 20 }] }] }, effects: { trail: { durationMs: 500, samples: 3 }, glow: { radius: 16.5, color: "#ff9a47" } }, blendMode: "screen" }];
    const result = compileGpuScene2dPlan(scene, 500); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.frame.draws.map((draw) => draw.kind)).toEqual(["groupStart", "coloredTriangles", "points", "points", "groupEnd"]);
    expect(result.plan.frame.draws[0]).toMatchObject({ id: "sun-corona.trail-composite", blendMode: "screen", effects: { glow: { radius: 16.5 } }, drawCount: 3 });
    for (const draw of result.plan.frame.draws.slice(1, 4)) expect(draw).toMatchObject({ blendMode: "normal", effects: null });
    expect(result.plan.frame.budget).toMatchObject({ triangleVertexCount: 12, pointCount: 5, blendModeCount: 1, groupCount: 1, groupMaxDepth: 1, compositeCount: 1, glowEffectCount: 1 });
  });

  it("admits a stroked 70590px offscreen orbit without widening frame textures", () => {
    const scene = motion();
    scene.layers = [{ id: "orbit-neptune", type: "shape", shape: "ellipse", fill: "#00000000", startMs: 0, durationMs: 1_000, transform: { x: -33_856, y: -10_440, width: 70_590, height: 29_648 }, style: { stroke: "#aac4e526", strokeWidth: 0.8625 } }];
    expect(compileGpuScene2dPlan(scene, 0)).toMatchObject({ ok: true, plan: { frame: { width: 100, height: 60, draws: [{ kind: "ellipse", width: 70_590, height: 29_648, color: { a: 0 }, strokeWidth: 0.8625, stroke: { a: expect.closeTo(0x26 / 255, 6) } }] } } });
    scene.layers[0].transform!.width = 131_073;
    expect(compileGpuScene2dPlan(scene, 0)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("131072") } });
  });

  it("admits the 7540px Saturn close-up as geometry over a bounded PNG texture", () => {
    const scene = motion();
    scene.layers = [{ id: "planet-saturn", type: "image", assetRef: "assets/saturn.png", startMs: 0, durationMs: 1_000, fit: "fill", transform: { x: -2_800, y: -1_200, width: 7_540, height: 3_770 } }];
    const images = new Map([["assets/saturn.png", { resourceId: "saturn-png", assetRef: "assets/saturn.png", width: 2_048, height: 1_024, sha256: "a".repeat(64) }]]);
    expect(compileGpuScene2dPlan(scene, 0, { images })).toMatchObject({ ok: true, plan: { frame: { width: 100, height: 60, draws: [{ kind: "image", resourceId: "saturn-png", width: 7_540, height: 3_770 }] } } });
    scene.layers[0].transform!.width = 131_073;
    expect(compileGpuScene2dPlan(scene, 0, { images })).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("131072") } });
  });
});
