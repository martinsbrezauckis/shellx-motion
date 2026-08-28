import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "../../gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "../../gpu-scene-static-plan";
import { validateMotionDocumentInStages } from "../../motion-validation";
import { generateObjectDiversityFixture } from "./generator";
import { OBJECT_DIVERSITY_LAYER_IDS, OBJECT_DIVERSITY_SOURCE } from "./object-diversity-fixture";

describe("M260 source-only object-diversity fixture", () => {
  it("has generator parity, passes semantic validation, and lowers representative frames in Core", async () => {
    const first = generateObjectDiversityFixture();
    const second = generateObjectDiversityFixture();
    expect(first).toEqual(OBJECT_DIVERSITY_SOURCE);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(await validateMotionDocumentInStages(first)).toMatchObject({ ok: true });

    const staticPlan = compileGpuSceneStaticPlan(first);
    expect(staticPlan).toMatchObject({ ok: true, plan: { canonicalFrameCount: 30 } });
    if (!staticPlan.ok) return;
    expect(staticPlan.plan.layers.find((layer) => layer.id === "closed-gradient-mask"))
      .toMatchObject({ keyframeTargets: ["gradient.angle"], geometry: { keyframed: true } });

    const frames = [0, 500, 999].map((atMs) => compileGpuScene2dPlan(first, atMs));
    for (const frame of frames) {
      expect(frame).toMatchObject({ ok: true, plan: { shapeCount: OBJECT_DIVERSITY_LAYER_IDS.length, maskCount: 1 } });
      if (!frame.ok) continue;
      const triangleIds = frame.plan.frame.draws
        .filter((draw) => draw.kind === "coloredTriangles")
        .map((draw) => draw.id);
      expect(triangleIds).toEqual(OBJECT_DIVERSITY_LAYER_IDS.slice(0, 6));
      expect(frame.plan.frame.draws).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "gradientRect", id: "closed-gradient-mask", mask: expect.objectContaining({ shape: "rect" }) })
      ]));
    }
    if (!frames.every((frame) => frame.ok)) return;
    expect(frames[0].plan.frame.fingerprint).not.toBe(frames[1].plan.frame.fingerprint);
    expect(frames[1].plan.frame.fingerprint).not.toBe(frames[2].plan.frame.fingerprint);
  });
});
