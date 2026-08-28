import { describe, expect, it } from "vitest";
import { BROWSER_CAPABILITY, GPU_CAPABILITY, matchRendererCapability, matchRendererCapabilityCards, NATIVE_CAPABILITY, renderLanesFor, unrenderablePackageRefusal } from "./capabilities";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { motionScene3DAnimationLaneRefusal, motionScene3DAnimationStorePresent } from "./motion-scene3d-animation-lane-refusal";
import type { MotionDocument } from "./types";

describe("scene3dAnimation@1 cross-lane refusal", () => {
  it("fails every capability card and GPU planner before scene traversal", () => {
    const motion = sceneDocument();
    expect(motionScene3DAnimationLaneRefusal(motion, "browser")).toMatchObject({
      schema: "shellx-motion/scene3d-animation-lane-refusal@1",
      code: "motion_scene3d_animation_unavailable",
      feature: "motion.scene3d-animation@1",
      message: "Browser rendering does not yet support document scene3dAnimation@1.",
    });
    for (const capability of [BROWSER_CAPABILITY, NATIVE_CAPABILITY, GPU_CAPABILITY]) {
      expect(matchRendererCapability(motion, capability)).toMatchObject({ ok: false, unsupported: [{ layerId: "__scene3d_animation__", feature: "motion.scene3d-animation@1" }] });
    }
    expect(matchRendererCapabilityCards(motion).matches.every((match) => !match.ok)).toBe(true);
    expect(renderLanesFor(motion)).toEqual([]);
    expect(unrenderablePackageRefusal(motion)).toMatchObject({ layers: [{ layerId: "__scene3d_animation__", type: "document_scene3d_animation" }] });
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { message: "GPU static planning does not yet support document scene3dAnimation@1." } });
    expect(compileGpuScene2dPlan(motion, 0)).toMatchObject({ ok: false, failure: { message: "GPU frame planning does not yet support document scene3dAnimation@1." } });
  });

  it("treats malformed, accessor, and reflection-failing roots as present without getter reads", () => {
    const malformed = sceneDocument();
    malformed.scene3dAnimation = { schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never;
    expect(motionScene3DAnimationLaneRefusal(malformed, "native")).toMatchObject({ code: "motion_scene3d_animation_unavailable" });
    let reads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "scene3dAnimation", { enumerable: true, get() { reads += 1; return malformed.scene3dAnimation; } });
    expect(motionScene3DAnimationStorePresent(hostile)).toBe(true);
    expect(reads).toBe(0);
    const reflectionFailure = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("no reflection"); } });
    expect(motionScene3DAnimationStorePresent(reflectionFailure)).toBe(true);
  });

  it("leaves legacy no-root capability truth and static fingerprints untouched", () => {
    const motion = sceneDocument();
    delete motion.scene3dAnimation;
    expect(motionScene3DAnimationLaneRefusal(motion, "native")).toBeUndefined();
    expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
  });

  it("refuses a companion relation rather than inheriting either strict GPU preview exception", () => {
    const motion = sceneDocument() as MotionDocument & { relations?: unknown };
    motion.relations = { schema: "shellx-motion/relations@1", bindings: [] };
    expect(matchRendererCapabilityCards(motion, { target: "preview", output: "png-frame" }).matches.find((match) => match.lane === "gpu")).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ feature: "motion.scene3d-animation@1.strict-browser-gpu-preview" })],
    });
  });
});

function sceneDocument(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "scene3d-refusal", name: "Scene3d refusal", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } }],
    scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never,
  };
}
