import { describe, expect, it } from "vitest";
import { compileGpuScene3DAnimationFramePlan, compileGpuScene3DAnimationStaticPlan } from "../../gpu-scene3d-animation-composition";
import { compileCollisionShowcaseRecipe } from "./collision-showcase-compile";
import { lowerCollisionShowcasePlan } from "./collision-showcase-lower";
import { COLLISION_SHOWCASE_RECIPE_SCHEMA, type BingoCollisionShowcaseRecipe, type WreckingCollisionShowcaseRecipe } from "./collision-showcase-types";

const bingo = (): BingoCollisionShowcaseRecipe => ({
  schema: COLLISION_SHOWCASE_RECIPE_SCHEMA, kind: "bingo-sphere-3d@1", seed: 2_975_908_062,
  speed: 3.4, gravity: -1.1, restitution: 0.92, cageRadius: 2.2, ballRadius: 0.28,
  selectedBallId: "bingo-ball-07", mixingFrame: 6, selectedFrame: 46,
});
const wrecking = (): WreckingCollisionShowcaseRecipe => ({
  schema: COLLISION_SHOWCASE_RECIPE_SCHEMA, kind: "wrecking-wall-3d@1", seed: 487_201,
  gravity: -8, restitution: 0.18, swingSpeed: 6.5, tetherLength: 2.8,
  releaseAngleDeg: -70, impactFrame: 24, fallingFrame: 32,
});

describe("private C6G-B ordinary Scene3D lowering", () => {
  it("lowers Bingo to ten opaque hashed balls plus one separate low-opacity cage", () => {
    const plan = compileCollisionShowcaseRecipe(bingo());
    const first = lowerCollisionShowcasePlan(plan), repeated = lowerCollisionShowcasePlan(plan);
    expect(repeated).toEqual(first);
    expect(first.fingerprint).toBe("d25687bffc09f3805ec6e610aac4d6b2b70e76297d34b5bc7dc492bf3ba72b91");
    expect(first.motionSha256).toBe("6ed3fe7f238ba5155e2cd17f6bd90791af9c03d73d280d78821a3c6221253e44");
    expect(first.strictPreviewStaticFingerprint).toBe("cb685ae7520a81df332d9ae6efdfc751fe1ee39c41aef25ced1937cbfbbee7ea");
    expect(first.geometry).toEqual([{ id: "unit-sphere", geometrySha256: "5252243ce3067268f70ea0723cb2a028bd8d9b7cc842330e6d7ecacf2cfd42c8", vertexCount: 362, indexCount: 2_160 }]);
    expect(first.budget).toEqual({ sceneLayerCount: 2, sceneObjectCount: 11, meshVertexCount: 3_982, meshIndexCount: 23_760, trackCount: 11, keyframeCount: 612, planWorkUnits: 1_832, frameWorkUnits: 31 });
    expect(first.motion.layers.map((layer) => [layer.id, layer.opacity, layer.scene3d?.objects.length])).toEqual([
      ["c6g-bingo-balls", 1, 10], ["c6g-bingo-cage", 0.18, 1],
    ]);
    expect(first.motion.scene3dAnimation?.tracks.at(-1)).toMatchObject({
      id: "select-bingo-ball-07", locator: { layerId: "c6g-bingo-balls", objectId: "bingo-ball-07", property: "emissive" }, keyframes: [{ atUs: 3_833_333, value: 0.35 }, { atUs: 5_000_000, value: 1 }],
    });
    expect(first.evidence).toEqual({ planRecompiled: true, ordinaryScene3d: true, ordinaryScene3dAnimation: true, fixedHashedGeometry: true, fusedTetherRotationDerived: false, strictPreviewAdmitted: true, rendererInvoked: false, packageWritten: false });
  });

  it("fuses the tether into the animated wrecking sphere and remains below exact Scene3D ceilings", () => {
    const plan = compileCollisionShowcaseRecipe(wrecking()), lowered = lowerCollisionShowcasePlan(plan);
    expect(lowered.fingerprint).toBe("72ca24f49a4576be2c919ab009a11650c252f284ee2428e73a2e0c1f24265832");
    expect(lowered.motionSha256).toBe("d6cc94559b0c9ff69669c384b6f482686d213c503088fd5960dfa4578d49885b");
    expect(lowered.strictPreviewStaticFingerprint).toBe("aacb8461c121d09a7485fbdd28c4c5f5a6112a55b5ebe851cd7cbd619a02bc4b");
    expect(lowered.geometry).toEqual([
      { id: "brick-cuboid", geometrySha256: "a643d13a296beca8cf5e62a86d4c31af4314b662f30146224c0320db700463b8", vertexCount: 24, indexCount: 36 },
      { id: "wrecking-ball-tether", geometrySha256: "d74c8b615c71a51cceb219f603703799ad33d5a7ca9b3820d78741e8b87e8f54", vertexCount: 386, indexCount: 2_196 },
    ]);
    expect(lowered.budget).toEqual({ sceneLayerCount: 1, sceneObjectCount: 16, meshVertexCount: 746, meshIndexCount: 2_736, trackCount: 17, keyframeCount: 1_005, planWorkUnits: 3_015, frameWorkUnits: 51 });
    expect(lowered.motion.layers).toHaveLength(1);
    expect(lowered.motion.layers[0]!.scene3d?.objects).toHaveLength(16);
    const tether = lowered.motion.scene3dAnimation?.tracks.find((track) => track.id === "rot-wrecking-tether");
    expect(tether?.keyframes).toHaveLength(29);
    expect(tether?.keyframes[0]).toMatchObject({ atUs: 0, value: [0, 0, expect.closeTo(-70, 4)] });
    for (const keyframe of tether?.keyframes ?? []) {
      for (const component of Array.isArray(keyframe.value) ? keyframe.value : []) expect(Number.isSafeInteger(component * 1_000_000)).toBe(true);
    }
    expect(lowered.evidence.fusedTetherRotationDerived).toBe(true);
    expect(lowered.motion.scene3dAnimation?.tracks.filter((track) => track.id.startsWith("rot-brick-"))).toEqual([]);
  });

  it("passes existing strict static and exact checkpoint-frame planning without renderer work", () => {
    for (const recipe of [bingo(), wrecking()]) {
      const plan = compileCollisionShowcaseRecipe(recipe), lowered = lowerCollisionShowcasePlan(plan);
      const staticPlan = compileGpuScene3DAnimationStaticPlan(lowered.motion);
      expect(staticPlan.ok, staticPlan.ok ? undefined : staticPlan.failure.message).toBe(true);
      if (!staticPlan.ok) continue;
      expect(staticPlan.plan.fingerprint).toBe(lowered.strictPreviewStaticFingerprint);
      for (const checkpoint of plan.checkpoints) {
        const frame = compileGpuScene3DAnimationFramePlan(lowered.motion, staticPlan.plan, checkpoint.atUs, {});
        expect(frame.ok, frame.ok ? undefined : frame.failure.message).toBe(true);
        if (frame.ok) {
          expect(frame.plan.animationFramePlan.samples).toHaveLength(lowered.budget.trackCount);
          expect(frame.plan.frame.draws.filter((draw) => draw.kind === "scene3d").map((draw) => draw.id)).toEqual(staticPlan.plan.targetLayerIds);
        }
      }
    }
  });

  it("recompiles plan authority and refuses stale, expanded, or accessor-bearing envelopes", () => {
    const plan = compileCollisionShowcaseRecipe(bingo()), expected = lowerCollisionShowcasePlan(plan);
    expect(() => lowerCollisionShowcasePlan({ ...plan, fingerprint: "0".repeat(64) })).toThrow("stale or forged");
    expect(() => lowerCollisionShowcasePlan({ ...plan, extra: true })).toThrow("exact C6G-A plan envelope");
    const accessor = { ...plan };
    Object.defineProperty(accessor, "recipe", { enumerable: true, get() { throw new Error("must remain unread"); } });
    expect(() => lowerCollisionShowcasePlan(accessor)).toThrow("enumerable data field");
    const ignoredTamper = { ...plan, frames: [{ attacker: "ignored" }] };
    expect(lowerCollisionShowcasePlan(ignoredTamper)).toEqual(expected);
  });
});
