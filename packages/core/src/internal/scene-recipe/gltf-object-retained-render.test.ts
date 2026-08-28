import { describe, expect, it } from "vitest";
import { carObjectPlan, carStory } from "./gltf-object-scene.test-support";
import { evaluateGltfObjectSceneAtUs } from "./gltf-object-scene-evaluate";
import { compileGltfObjectSceneEvaluationPlan } from "./gltf-object-scene-evaluation";
import { GLTF_OBJECT_SCENE_EVALUATION_SCHEMA } from "./gltf-object-scene-evaluation-types";
import { compileGltfObjectScenePlan } from "./gltf-object-scene";
import { GLTF_OBJECT_SCENE_SCHEMA } from "./gltf-object-scene-types";
import {
  compileGltfObjectRetainedRenderFramePlan,
  compileGltfObjectRetainedRenderStaticPlan,
  readGltfObjectRetainedRenderFrameUpload,
  readGltfObjectRetainedRenderStaticUpload,
} from "./gltf-object-retained-render";
import { GLTF_OBJECT_RETAINED_RENDER_SCHEMA, type GltfObjectRetainedRenderStaticPlan } from "./gltf-object-retained-render-types";
import { compileGltfObjectStoryPlan } from "./gltf-object-story";

describe("C7A3e imported-object retained renderer lowering", () => {
  it("retains shared geometry once and lowers exact/intermediate frames into stable instance slots", () => {
    const fixture = retainedFixture();
    expect(fixture.staticPlan).toMatchObject({
      budget: {
        geometryResourceCount: 2,
        instanceSlotCount: 5,
        reusedInstanceCount: 3,
        vertexBufferBytes: 144,
        indexBufferBytes: 24,
        uniformBufferBytes: 1_280,
      },
      evidence: { sharedGeometryRetainedOnce: true, stableInstanceUniformSlots: true, perFrameGpuAllocations: 0, rendererInvoked: false, packageWritten: false },
    });
    expect(fixture.staticPlan.fingerprint).toBe("a46eb817bbc7175d5aee06e1ad0c4113feb36f62b7bb3d22733f3a1fc3e3b2af");
    const staticUpload = readGltfObjectRetainedRenderStaticUpload(fixture.staticPlan);
    expect(staticUpload.geometries).toHaveLength(2);
    expect(staticUpload.instanceSlots).toHaveLength(5);
    expect(staticUpload.geometries.every((geometry) => geometry.verticesBase64.length > 0 && geometry.indicesBase64.length > 0)).toBe(true);

    const exactScene = evaluated(fixture.evaluationPlan, 0);
    const intermediateScene = evaluated(fixture.evaluationPlan, 375_000);
    const exact = compileGltfObjectRetainedRenderFramePlan(fixture.staticPlan, exactScene);
    const intermediate = compileGltfObjectRetainedRenderFramePlan(fixture.staticPlan, intermediateScene);
    expect(exact.bindings.map((binding) => binding.instanceId)).toEqual(fixture.staticPlan.instanceSlots.map((slot) => slot.instanceId));
    expect(exact.bindings.map((binding) => binding.primitiveRef)).toEqual(intermediate.bindings.map((binding) => binding.primitiveRef));
    expect(exact.bindings[0]?.color).toEqual([245 / 255, 158 / 255, 11 / 255, 1].map(Math.fround));
    expect(intermediate.bindings[0]?.color).toEqual([56 / 255, 189 / 255, 248 / 255, 1].map(Math.fround));
    expect(intermediate.bindings[1]?.color).toEqual([0.125490203499794, 0.12941177189350128, 0.14901961386203766, 1]);
    expect(intermediate.bindings[0]?.modelMatrix).not.toEqual(exact.bindings[0]?.modelMatrix);
    expect(intermediate.viewProjection).not.toEqual(exact.viewProjection);
    expect(readGltfObjectRetainedRenderFrameUpload(fixture.staticPlan, intermediate)).toMatchObject({ schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1", fingerprint: intermediate.fingerprint, atUs: 375_000 });
    expect(intermediate).not.toHaveProperty("geometries");
  });

  it("is deterministic and binds frame uploads to compiler-minted static authority", () => {
    const first = retainedFixture(), second = retainedFixture();
    expect(second.staticPlan.fingerprint).toBe(first.staticPlan.fingerprint);
    const firstFrame = compileGltfObjectRetainedRenderFramePlan(first.staticPlan, evaluated(first.evaluationPlan, 250_000));
    const secondFrame = compileGltfObjectRetainedRenderFramePlan(second.staticPlan, evaluated(second.evaluationPlan, 250_000));
    expect(secondFrame.fingerprint).toBe(firstFrame.fingerprint);
    const cloned = Object.freeze({ ...first.staticPlan }) as GltfObjectRetainedRenderStaticPlan;
    expect(() => readGltfObjectRetainedRenderStaticUpload(cloned)).toThrow("compiler-minted");
    expect(() => compileGltfObjectRetainedRenderFramePlan(first.staticPlan, evaluated(second.evaluationPlan, 250_000))).toThrow("exact evaluator and scene plans");
  });

  it("refuses incomplete palettes, hidden execution fields, forged frames, and frame-plan substitution", () => {
    const fixture = retainedFixture();
    expect(() => compileGltfObjectRetainedRenderStaticPlan(fixture.evaluationPlan, { ...renderRecipe(fixture.evaluationPlan.fingerprint), physics: {} })).toThrow("unknown field 'physics'");
    expect(() => compileGltfObjectRetainedRenderStaticPlan(fixture.evaluationPlan, { ...renderRecipe(fixture.evaluationPlan.fingerprint), sourceMaterials: [{ materialIndex: 0, baseColor: "#ffffff", emissive: 0 }] })).toThrow("exactly cover source material slots");
    const source = evaluated(fixture.evaluationPlan, 250_000);
    const forged = Object.freeze({ ...source, fingerprint: "0".repeat(64) });
    expect(() => compileGltfObjectRetainedRenderFramePlan(fixture.staticPlan, forged)).toThrow("exact evaluator and scene plans");
    const frame = compileGltfObjectRetainedRenderFramePlan(fixture.staticPlan, source);
    const substituted = Object.freeze({ ...frame, staticFingerprint: "0".repeat(64) });
    expect(() => readGltfObjectRetainedRenderFrameUpload(fixture.staticPlan, substituted)).toThrow("exact static plan");
    const equivalent = Object.freeze({ ...frame });
    expect(() => readGltfObjectRetainedRenderFrameUpload(fixture.staticPlan, equivalent)).toThrow("exact static plan");
    expect(() => readGltfObjectRetainedRenderFrameUpload(retainedFixture().staticPlan, frame)).toThrow("exact static plan");
  });
});

function retainedFixture() {
  const objectPlan = carObjectPlan();
  const storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan.fingerprint, 3));
  const scenePlan = compileGltfObjectScenePlan(objectPlan, storyPlan, { schema: GLTF_OBJECT_SCENE_SCHEMA, id: "car-shot", objectFingerprint: objectPlan.fingerprint, storyFingerprint: storyPlan.fingerprint, camera: { viewDirection: [1, 0.65, 1], fovDeg: 42, padding: 1.2 } });
  const evaluation = {
    schema: GLTF_OBJECT_SCENE_EVALUATION_SCHEMA,
    sceneFingerprint: scenePlan.fingerprint,
    segments: storyPlan.checkpoints.slice(0, -1).map((from, index) => {
      const to = storyPlan.checkpoints[index + 1]!;
      return { id: `segment-${index}`, fromCheckpointId: from.id, toCheckpointId: to.id, controls: storyPlan.controls.map((control) => control.kind === "material" ? { controlId: control.id, kind: "material", switchAtUs: from.atUs + 375_000 } : { controlId: control.id, kind: "transform", interpolation: "ease-in-out" }) };
    }),
  };
  const evaluationPlan = compileGltfObjectSceneEvaluationPlan(objectPlan, storyPlan, scenePlan, evaluation);
  const staticPlan = compileGltfObjectRetainedRenderStaticPlan(evaluationPlan, renderRecipe(evaluationPlan.fingerprint));
  return { evaluationPlan, staticPlan };
}

function renderRecipe(evaluationFingerprint: string) {
  return {
    schema: GLTF_OBJECT_RETAINED_RENDER_SCHEMA,
    evaluationFingerprint,
    viewport: { width: 640, height: 360 },
    backgroundColor: "#07111f",
    lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 },
    sourceMaterials: [
      { materialIndex: 0, baseColor: "#d97706", emissive: 0 },
      { materialIndex: 1, baseColor: "#202126", emissive: 0.02 },
    ],
  };
}

function evaluated(plan: ReturnType<typeof compileGltfObjectSceneEvaluationPlan>, atUs: number) {
  const result = evaluateGltfObjectSceneAtUs(plan, atUs);
  if (!result.ok) throw new Error(result.message);
  return result.frame;
}
