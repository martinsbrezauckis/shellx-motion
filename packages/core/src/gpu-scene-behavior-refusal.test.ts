import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { MotionDocument } from "./types";

describe("GPU behavior Phase 1 refusal", () => {
  it("refuses both active and disabled behavior stores before static or frame output", () => {
    for (const enabled of [true, false]) {
      const motion = document(enabled);
      expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU static planning does not yet support document behaviors@1." } });
      expect(compileGpuScene2dPlan(motion, 500)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU frame planning does not yet support document behaviors@1." } });
    }
  });

  it("keeps no-behavior static and frame identities byte-identical", () => {
    const motion = document();
    const staticPlan = compileGpuSceneStaticPlan(motion);
    const framePlan = compileGpuScene2dPlan(motion, 500);
    expect(staticPlan).toMatchObject({ ok: true });
    expect(framePlan).toMatchObject({ ok: true });
    if (!staticPlan.ok || !framePlan.ok) return;
    expect(staticPlan.plan.fingerprint).toBe("17f46f9c2c2b551a1aeb02bd353e6791efb6bfac10ca89c2e124d672155567a8");
    expect(framePlan.plan.frame.fingerprint).toBe("594aaefa064d87e4208b2fe665d9278009a809a7b4859df3bceaccada779ad00");
  });
});

function document(enabled?: boolean): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gpu-behavior-refusal", name: "GPU behavior refusal", durationMs: 1_000, fps: 30, width: 100, height: 50,
    background: "#102030", assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ff0000", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 5, width: 20, height: 10 } }],
    ...(enabled === undefined ? {} : {
      behaviors: {
        schema: "shellx-motion/behaviors@1",
        bindings: [{ targetLayerId: "shape", enabled, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }],
      },
    }),
  };
}
