import { describe, expect, it } from "vitest";
import { compileGpuPointsPreviewPlan } from "./gpu-points-plan";
import type { MotionDocument } from "./types";

function motion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_gpu_points",
    name: "GPU points",
    durationMs: 100,
    fps: 30,
    width: 64,
    height: 32,
    background: "#00000000",
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "stars",
      type: "points",
      startMs: 0,
      durationMs: 100,
      opacity: 0.5,
      color: "#ffffff",
      pointCloud: {
        points: [{ x: 4, y: 8, size: 4, opacity: 0.5, color: "#ff000080" }],
        samples: [
          { atMs: 0, positions: [{ x: 4, y: 8, size: 4, opacity: 0.5 }] },
          { atMs: 100, positions: [{ x: 24, y: 8, size: 8, opacity: 1 }] }
        ]
      }
    }]
  };
}

describe("compileGpuPointsPreviewPlan", () => {
  it("uses the shared exact-time CPU point evaluator and carries alpha into fixed GPU instances", () => {
    const first = compileGpuPointsPreviewPlan(motion(), 50);
    const second = compileGpuPointsPreviewPlan(JSON.parse(JSON.stringify(motion())), 50);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const point = first.plan.frame.draws[0];
    expect(point.kind).toBe("points");
    if (point.kind !== "points") return;
    // 4 -> 24 at exactly 50ms is the same shared CPU reference interpolation.
    expect(point.points[0]).toMatchObject({ x: 14, y: 8, size: 6, color: { r: 1, g: 0, b: 0 } });
    expect(point.points[0].color.a).toBeCloseTo((128 / 255) * 0.75 * 0.5, 8);
    expect(first.plan.frame.fingerprint).toBe(second.plan.frame.fingerprint);
  });

  it("refuses every unsupported visual expansion before a browser or GPU is opened", () => {
    const effected = motion();
    effected.layers[0].effects = { trail: { durationMs: 30, samples: 3 } };
    expect(compileGpuPointsPreviewPlan(effected, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_effect", layerId: "stars" } });

    const transformed = motion();
    transformed.layers[0].transform = { x: 1, y: 0 };
    expect(compileGpuPointsPreviewPlan(transformed, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "stars" } });

    const nonPoints = motion();
    nonPoints.layers.push({ id: "title", type: "text", startMs: 0, durationMs: 100, text: "No fallback" });
    expect(compileGpuPointsPreviewPlan(nonPoints, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_layer", layerId: "title" } });

    const namedColor = motion();
    namedColor.layers[0].color = "red";
    expect(compileGpuPointsPreviewPlan(namedColor, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_color", layerId: "stars" } });

    const overBoundColor = motion();
    overBoundColor.layers[0].color = `#fff${" ".repeat(126)}`;
    expect(compileGpuPointsPreviewPlan(overBoundColor, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_color", layerId: "stars" } });
  });
});
