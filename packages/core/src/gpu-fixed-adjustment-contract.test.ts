import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { MotionDocument } from "./types";

describe("fixed adjustment GPU contract", () => {
  it("keeps the no-adjustment static fingerprint golden and adds no adjustment topology", () => {
    const first = compileGpuSceneStaticPlan(base());
    const repeat = compileGpuSceneStaticPlan(structuredClone(base()));
    const frame = compileGpuScene2dPlan(base(), 500);
    expect(first).toMatchObject({ ok: true }); expect(repeat).toEqual(first);
    expect(frame).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.plan).toMatchObject({ fingerprint: "bb498cd2844395f84f31070aa93aedcfa6590b1eba4826a999b073f5d6978ea9", maxima: { maxAdjustmentCount: 0 }, layers: [{ id: "plate", type: "shape" }] });
    if (!frame.ok) return;
    expect(frame.plan.frame.fingerprint).toBe("89d1c0c40ebc7dc50795cd4a15d8cbea8d64f1b6b593c1dcdfb39647f8f4e13d");
    expect(JSON.stringify(first.plan.layers)).not.toContain("adjustment");
  });

  it("keeps static topology and runtime vignette-then-film-grain seeds deterministic", () => {
    const motion = withAdjustment();
    const staticFirst = compileGpuSceneStaticPlan(motion);
    const staticRepeat = compileGpuSceneStaticPlan(structuredClone(motion));
    expect(staticFirst).toEqual(staticRepeat);
    expect(staticFirst).toMatchObject({ ok: true, plan: { maxima: { maxAdjustmentCount: 1 }, layers: [{ id: "plate" }, { id: "finish", type: "adjustment" }] } });

    const first = compileGpuScene2dPlan(motion, 500);
    const repeat = compileGpuScene2dPlan(motion, 500);
    const nextFrame = compileGpuScene2dPlan(motion, 534);
    expect(first).toEqual(repeat);
    expect(first).toMatchObject({ ok: true, plan: { frame: { draws: [
      { kind: "rect", id: "plate" },
      { kind: "adjustment", id: "finish", vignette: { amount: 0.7, softness: 0.45, color: { r: 16 / 255, g: 32 / 255, b: 48 / 255, a: 128 / 255 } }, filmGrain: { amount: 0.25, size: 3, frameSeed: ((42 ^ Math.imul(16, 0x9e3779b1)) >>> 0) } },
    ] } } });
    if (!first.ok || !nextFrame.ok) return;
    const seed = first.plan.frame.draws.find((draw) => draw.kind === "adjustment")?.filmGrain?.frameSeed;
    const nextSeed = nextFrame.plan.frame.draws.find((draw) => draw.kind === "adjustment")?.filmGrain?.frameSeed;
    expect(nextSeed).not.toBe(seed);
  });
});

function base(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "fixed-adjustment-gpu", name: "Fixed adjustment GPU", durationMs: 1_000, fps: 30, width: 100, height: 60,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "plate", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { width: 100, height: 60 } }],
  } as MotionDocument;
}
function withAdjustment(): MotionDocument {
  const motion = base();
  motion.layers.push({ id: "finish", type: "adjustment", startMs: 0, durationMs: 1_000, effects: { vignette: { amount: 0.7, softness: 0.45, color: "#10203080" }, filmGrain: { amount: 0.25, size: 3, seed: 42 } } });
  return motion;
}
