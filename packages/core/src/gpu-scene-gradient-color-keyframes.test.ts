import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import type { MotionDocument } from "./types";

function motion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gradient-colors", name: "Gradient colors", durationMs: 1_000, fps: 30, width: 100, height: 60,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "animated-colors", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000,
      transform: { x: 5, y: 6, width: 40, height: 20 },
      gradient: {
        type: "linear", angle: 30,
        stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#000000" }],
        colorKeyframes: {
          schema: "shellx-motion/gradient-color-keyframes@1",
          keyframes: [{ atUs: 0, colors: ["#ff0000", "#000000"] }, { atUs: 1_000, colors: ["#0000ff", "#ffffff"] }],
        },
      },
    }],
  };
}

describe("GPU fixed-topology gradient color snapshots", () => {
  it("lowers changing colors through the existing bounded gradient uniforms", () => {
    const first = compileGpuScene2dPlan(motion(), 0);
    const middle = compileGpuScene2dPlan(motion(), 0.5);
    expect(first).toMatchObject({ ok: true });
    expect(middle).toMatchObject({ ok: true });
    if (!first.ok || !middle.ok) return;
    expect(first.plan.frame.draws).toMatchObject([{ kind: "gradientRect", stops: [{ offset: 0, color: { r: 1, g: 0, b: 0 } }, { offset: 1, color: { r: 0, g: 0, b: 0 } }] }]);
    expect(middle.plan.frame.draws).toMatchObject([{ kind: "gradientRect", stops: [{ offset: 0, color: { r: expect.closeTo(0.502, 3), g: 0, b: expect.closeTo(0.502, 3) } }, { offset: 1, color: { r: expect.closeTo(0.502, 3), g: expect.closeTo(0.502, 3), b: expect.closeTo(0.502, 3) } }] }]);
    expect(middle.plan.frame.budget).toEqual(first.plan.frame.budget);
  });
});
