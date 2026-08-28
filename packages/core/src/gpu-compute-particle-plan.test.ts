import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { MotionDocument } from "./types";

describe("fixed high-density GPU particle-plan admission", () => {
  it("separates 100k analytic instances from CPU points and binds exact static/runtime budgets", () => {
    const motion = document();
    const runtime = compileGpuScene2dPlan(motion, 500); const statics = compileGpuSceneStaticPlan(motion);
    expect(runtime).toMatchObject({ ok: true }); expect(statics).toMatchObject({ ok: true });
    if (!runtime.ok || !statics.ok) return;
    expect(runtime.plan).toMatchObject({ particleCount: 100_000, pointCount: 0, frame: { draws: [expect.objectContaining({ kind: "particleCompute", count: 100_000, atMs: 500 })], budget: { pointCount: 0, computeParticleFieldCount: 1, computeParticleCount: 100_000, computeParticleBufferBytes: 6_400_000 } } });
    expect(statics.plan.maxima).toMatchObject({ maxPointCount: 0, maxComputeParticleFieldCount: 1, maxComputeParticleCount: 100_000 });
  });

  it("is canonical-time deterministic and refuses every non-fixed density/composite route", () => {
    const motion = document();
    const first = compileGpuScene2dPlan(motion, 500), later = compileGpuScene2dPlan(motion, 1_400), replay = compileGpuScene2dPlan(motion, 500);
    expect(first).toMatchObject({ ok: true }); expect(later).toMatchObject({ ok: true }); expect(replay).toMatchObject({ ok: true });
    if (!first.ok || !later.ok || !replay.ok) return;
    expect(replay.plan.frame.fingerprint).toBe(first.plan.frame.fingerprint); expect(later.plan.frame.fingerprint).not.toBe(first.plan.frame.fingerprint);
    for (const mutate of [
      (value: MotionDocument) => { value.layers[0].emitter!.count = 1_001; },
      (value: MotionDocument) => { value.layers[0].emitter!.count = 99_999; },
      (value: MotionDocument) => { delete value.layers[0].emitter!.field; },
      (value: MotionDocument) => { value.layers[0].emitter!.shape = "square"; },
      (value: MotionDocument) => { value.layers[0].effects = { blur: 1 }; },
      (value: MotionDocument) => { value.layers[0].mask = { type: "rect" }; }
    ]) {
      const changed = structuredClone(motion); mutate(changed);
      expect(compileGpuSceneStaticPlan(changed)).toMatchObject({ ok: false });
    }
  });

  it("refuses different non-overlapping capacities before a persistent session can open", () => {
    const motion = document();
    motion.layers[0].durationMs = 1_000;
    motion.layers.push({
      ...structuredClone(motion.layers[0]),
      id: "later-dust",
      startMs: 1_000,
      durationMs: 1_000,
      emitter: { ...structuredClone(motion.layers[0].emitter!), count: 131_072 }
    });
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({
      ok: false,
      failure: {
        code: "gpu_resource_refused",
        message: expect.stringContaining("one retained particle capacity")
      }
    });
  });

  it("refuses non-overlapping v1 and v2 fields at one count because their retained pools differ", () => {
    const motion = document();
    motion.layers[0].durationMs = 1_000;
    motion.layers.push({
      ...structuredClone(motion.layers[0]),
      id: "later-v2-dust",
      startMs: 1_000,
      durationMs: 1_000,
      emitter: { ...structuredClone(motion.layers[0].emitter!), field: { schema: "shellx-motion/particle-field@2", sources: [{ kind: "flow", angleDeg: 15, strength: 0.2 }] } }
    });
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({
      ok: false,
      failure: {
        code: "gpu_resource_refused",
        message: expect.stringContaining("one retained particle ABI across the complete timeline")
      }
    });
  });
});

function document(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "compute_field", name: "Compute field", durationMs: 2_000, fps: 30, width: 80, height: 40, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "dust", type: "particles", startMs: 0, durationMs: 2_000, transform: { width: 80, height: 40, originX: 40, originY: 20 }, emitter: { seed: 71, count: 100_000, lifetimeMs: 2_000, shape: "circle", color: "#ff8040", secondaryColor: "#40a0ff", minSize: 4, maxSize: 8, minSpeed: 12, maxSpeed: 30, direction: -70, spread: 40, gravity: 6, fadeOut: true, field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "radial", centerX: 0.25, centerY: 0.75, strength: 0.3, softening: 0.2 }, { kind: "vortex", centerX: 0.6, centerY: 0.4, strength: -0.5, softening: 0.12 }] } } }]
  };
}
