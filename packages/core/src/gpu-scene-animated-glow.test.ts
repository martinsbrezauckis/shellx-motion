import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import type { MotionDocument } from "./types";

function animatedGlow(endRadius = 24): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_gpu_animated_glow",
    name: "GPU animated glow",
    durationMs: 1_001,
    fps: 30,
    width: 100,
    height: 60,
    background: "#000000",
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "sun",
      type: "shape",
      shape: "ellipse",
      fill: "#fff2cb",
      startMs: 0,
      durationMs: 1_001,
      transform: { x: 30, y: 10, width: 40, height: 40 },
      effects: { glow: { radius: 8, color: "#ff7130" } },
      keyframes: { "effects.glow.radius": [{ atMs: 0, value: 8 }, { atMs: 1_000, value: endRadius }] }
    }]
  };
}

describe("GPU animated glow", () => {
  it("interpolates the public bounded glow-radius keyframe into the fixed GPU effect", () => {
    const first = compileGpuScene2dPlan(animatedGlow(), 0);
    const middle = compileGpuScene2dPlan(animatedGlow(), 500);
    const last = compileGpuScene2dPlan(animatedGlow(), 1_000);
    expect(first).toMatchObject({ ok: true, plan: { frame: { draws: [{ effects: { glow: { radius: 8 } } }] } } });
    expect(middle).toMatchObject({ ok: true, plan: { frame: { draws: [{ effects: { glow: { radius: 16 } } }] } } });
    expect(last).toMatchObject({ ok: true, plan: { frame: { draws: [{ effects: { glow: { radius: 24 } } }] } } });
    if (!first.ok || !middle.ok || !last.ok) return;
    expect(new Set([first.plan.frame.fingerprint, middle.plan.frame.fingerprint, last.plan.frame.fingerprint]).size).toBe(3);
  });

  it("still refuses a resolved glow radius beyond the public 128px bound", () => {
    expect(compileGpuScene2dPlan(animatedGlow(129), 1_000)).toMatchObject({
      ok: false,
      failure: { code: "gpu_resource_refused" }
    });
  });
});
