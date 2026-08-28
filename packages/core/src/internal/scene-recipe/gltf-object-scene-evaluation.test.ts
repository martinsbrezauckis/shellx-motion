import { describe, expect, it } from "vitest";
import { carObjectPlan, carStory } from "./gltf-object-scene.test-support";
import { compileGltfObjectSceneEvaluationPlan } from "./gltf-object-scene-evaluation";
import { GLTF_OBJECT_SCENE_EVALUATION_SCHEMA, type GltfObjectSceneEvaluationPlan, type GltfObjectSceneTransformInterpolation } from "./gltf-object-scene-evaluation-types";
import { evaluateGltfObjectSceneAtUs } from "./gltf-object-scene-evaluate";
import { compileGltfObjectScenePlan } from "./gltf-object-scene";
import { GLTF_OBJECT_SCENE_SCHEMA, type GltfObjectScenePlan } from "./gltf-object-scene-types";
import { compileGltfObjectStoryPlan } from "./gltf-object-story";

describe("C7A3d imported-object directed time evaluation", () => {
  it("preserves exact checkpoints and recomposes easing, material steps, bounds, and camera at intermediate times", () => {
    const fixture = evaluatedFixture(3, "ease-in");
    const duplicate = compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, fixture.evaluation);
    expect(duplicate.fingerprint).toBe(fixture.evaluationPlan.fingerprint);

    const exact = evaluateGltfObjectSceneAtUs(fixture.evaluationPlan, 500_000);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.frame.checkpointId).toBe("cp-01");
    expect(exact.frame.segmentId).toBeNull();
    expect(exact.frame.segmentProgress).toBeNull();
    expect(exact.frame.scene).toBe(fixture.scenePlan.checkpoints[1]);

    const beforeSwitch = evaluateGltfObjectSceneAtUs(fixture.evaluationPlan, 250_000);
    expect(beforeSwitch.ok).toBe(true);
    if (!beforeSwitch.ok) return;
    expect(beforeSwitch.frame).toMatchObject({ checkpointId: null, segmentId: "segment-00", segmentProgress: 0.5 });
    expect(translation(beforeSwitch.frame.scene, "car.node.00")).toEqual([1.25, 0, -0.375]);
    expect(bodyMaterial(beforeSwitch.frame.scene)).toEqual({ kind: "story", materialRef: "amber" });
    expect(beforeSwitch.frame.scene.camera.target).toEqual(beforeSwitch.frame.scene.bounds.center);
    expect(beforeSwitch.frame.scene.camera.far).toBeGreaterThan(beforeSwitch.frame.scene.camera.near);

    const atSwitch = evaluateGltfObjectSceneAtUs(fixture.evaluationPlan, 375_000);
    expect(atSwitch.ok).toBe(true);
    if (atSwitch.ok) expect(bodyMaterial(atSwitch.frame.scene)).toEqual({ kind: "story", materialRef: "blue" });
    expect(fixture.evaluationPlan).toMatchObject({
      budget: { segmentCount: 2, transformPolicyCount: 10, materialPolicyCount: 2, controlPolicyCount: 12 },
      evidence: { exactCheckpointIdentityPreserved: true, degreeSpaceRotationPreserved: true, hierarchyBoundsAndCameraReevaluated: true, rendererInvoked: false, packageWritten: false },
    });
  });

  it("supports every closed transform policy and preserves multi-revolution degree-space rotation", () => {
    const expectedX = new Map<GltfObjectSceneTransformInterpolation, number>([
      ["linear", 2.5], ["ease-in", 1.25], ["ease-out", 3.75], ["ease-in-out", 2.5], ["hold", 0],
    ]);
    for (const [interpolation, expected] of expectedX) {
      const fixture = evaluatedFixture(3, interpolation);
      const result = evaluateGltfObjectSceneAtUs(fixture.evaluationPlan, 250_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(translation(result.frame.scene, "car.node.00")[0]).toBe(expected);
    }

    const objectPlan = carObjectPlan(), story = carStory(objectPlan.fingerprint, 2);
    story.checkpoints[1]!.states[2]!.value.rotationDeg = [720, 0, 0];
    const storyPlan = compileGltfObjectStoryPlan(objectPlan, story);
    const scenePlan = compileGltfObjectScenePlan(objectPlan, storyPlan, sceneAssembly(objectPlan.fingerprint, storyPlan.fingerprint));
    const evaluation = evaluationRecipe(scenePlan, storyPlan, "linear");
    const plan = compileGltfObjectSceneEvaluationPlan(objectPlan, storyPlan, scenePlan, evaluation);
    const quarter = evaluateGltfObjectSceneAtUs(plan, 125_000);
    expect(quarter.ok).toBe(true);
    if (quarter.ok) {
      const wheel = quarter.frame.scene.nodeStates.find((state) => state.nodeId === "car.node.04")!;
      expect(wheel.localMatrix[5]).toBe(-1);
      expect(wheel.localMatrix[10]).toBe(-1);
    }
  });

  it("fails closed on sparse or mismatched policies, invalid switch times, hidden execution fields, forged plans, and out-of-range evaluation", () => {
    const fixture = evaluatedFixture(3, "linear"), valid = fixture.evaluation;
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, { ...valid, sceneFingerprint: "0".repeat(64) })).toThrow("does not match the assembled scene plan");
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, { ...valid, physics: {} })).toThrow("unknown field 'physics'");

    const sparse = structuredClone(valid); sparse.segments.pop();
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, sparse)).toThrow("must contain 2..2 entries");
    const wrongPair = structuredClone(valid); wrongPair.segments[0]!.toCheckpointId = "cp-02";
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, wrongPair)).toThrow("exact consecutive story checkpoints");
    const sparseControls = structuredClone(valid); sparseControls.segments[0]!.controls.pop();
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, sparseControls)).toThrow("must contain 6..6 entries");
    const scripted = structuredClone(valid); scripted.segments[0]!.controls[1]!.script = "move()";
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, scripted)).toThrow("unknown field 'script'");
    const invalidSwitch = structuredClone(valid); invalidSwitch.segments[0]!.controls[0]!.switchAtUs = 0;
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, fixture.scenePlan, invalidSwitch)).toThrow("greater than the segment start");

    const forgedScene = Object.freeze({ ...fixture.scenePlan, fingerprint: "0".repeat(64) }) as GltfObjectScenePlan;
    expect(() => compileGltfObjectSceneEvaluationPlan(fixture.objectPlan, fixture.storyPlan, forgedScene, valid)).toThrow("scene plan fingerprint does not match");
    const serialized = Object.freeze({ ...fixture.evaluationPlan }) as GltfObjectSceneEvaluationPlan;
    expect(evaluateGltfObjectSceneAtUs(serialized, 250_000)).toMatchObject({ ok: false, message: expect.stringContaining("compiler-minted") });
    expect(evaluateGltfObjectSceneAtUs(fixture.evaluationPlan, 1_500_000)).toMatchObject({ ok: false, message: expect.stringContaining("outside the story range") });
  });
});

function evaluatedFixture(checkpointCount: number, rootInterpolation: GltfObjectSceneTransformInterpolation) {
  const objectPlan = carObjectPlan();
  const storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan.fingerprint, checkpointCount));
  const scenePlan = compileGltfObjectScenePlan(objectPlan, storyPlan, sceneAssembly(objectPlan.fingerprint, storyPlan.fingerprint));
  const evaluation = evaluationRecipe(scenePlan, storyPlan, rootInterpolation);
  const evaluationPlan = compileGltfObjectSceneEvaluationPlan(objectPlan, storyPlan, scenePlan, evaluation);
  return { objectPlan, storyPlan, scenePlan, evaluation, evaluationPlan };
}

function sceneAssembly(objectFingerprint: string, storyFingerprint: string) {
  return { schema: GLTF_OBJECT_SCENE_SCHEMA, id: "car-shot", objectFingerprint, storyFingerprint, camera: { viewDirection: [1, 0.65, 1], fovDeg: 42, padding: 1.2 } };
}

function evaluationRecipe(scenePlan: GltfObjectScenePlan, storyPlan: ReturnType<typeof compileGltfObjectStoryPlan>, rootInterpolation: GltfObjectSceneTransformInterpolation): any {
  return {
    schema: GLTF_OBJECT_SCENE_EVALUATION_SCHEMA,
    sceneFingerprint: scenePlan.fingerprint,
    segments: storyPlan.checkpoints.slice(0, -1).map((from, index) => {
      const to = storyPlan.checkpoints[index + 1]!;
      return {
        id: `segment-${String(index).padStart(2, "0")}`,
        fromCheckpointId: from.id,
        toCheckpointId: to.id,
        controls: storyPlan.controls.map((control) => control.kind === "material"
          ? { controlId: control.id, kind: "material", switchAtUs: from.atUs + Math.floor((to.atUs - from.atUs) * 0.75) }
          : { controlId: control.id, kind: "transform", interpolation: control.id === "car-motion" ? rootInterpolation : "linear" }),
      };
    }),
  };
}

function translation(scene: GltfObjectScenePlan["checkpoints"][number], nodeId: string): number[] {
  return scene.nodeStates.find((state) => state.nodeId === nodeId)!.worldMatrix.slice(12, 15);
}

function bodyMaterial(scene: GltfObjectScenePlan["checkpoints"][number]) {
  return scene.primitiveInstances.find((instance) => instance.nodeId === "car.node.01")!.material;
}
