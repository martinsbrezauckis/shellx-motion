import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { parseGltfContainer } from "../../gltf-container";
import { compileGltfObjectPlan } from "./gltf-object-plan";
import { GLTF_OBJECT_DECLARATION_SCHEMA, type GltfObjectPlan } from "./gltf-object-plan-types";
import { compileGltfObjectScenePlan } from "./gltf-object-scene";
import { GLTF_OBJECT_SCENE_SCHEMA } from "./gltf-object-scene-types";
import { compileGltfObjectStoryPlan } from "./gltf-object-story";
import { GLTF_OBJECT_STORY_SCHEMA, type GltfObjectStoryPlan } from "./gltf-object-story-types";

describe("C7A3c imported-object directed-scene assembly", () => {
  it("composes unordered hierarchy nodes, local-pivot wrappers, exact materials, bounds, and a deterministic camera", () => {
    const objectPlan = carObjectPlan();
    const storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan));
    const assembly = sceneAssembly(objectPlan, storyPlan);
    const first = compileGltfObjectScenePlan(objectPlan, storyPlan, assembly);
    const second = compileGltfObjectScenePlan(objectPlan, storyPlan, assembly);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.checkpoints.map((checkpoint) => checkpoint.atUs)).toEqual([0, 1_000_000]);
    expect(first.resources).toBe(objectPlan.resources);
    expect(first.budget).toMatchObject({
      nodeCount: 3,
      primitiveResourceCount: 2,
      primitiveInstanceCount: 2,
      checkpointCount: 2,
      nodeStateSampleCount: 6,
      primitiveInstanceSampleCount: 4,
      transformedBoundsCornerCount: 32,
    });

    const end = first.checkpoints[1]!;
    const root = end.nodeStates.find((state) => state.nodeId === "car.node.02")!;
    const body = end.nodeStates.find((state) => state.nodeId === "car.node.00")!;
    const wheel = end.nodeStates.find((state) => state.nodeId === "car.node.01")!;
    expect(translation(root.worldMatrix)).toEqual([5, 0, -2]);
    expect(translation(body.worldMatrix)).toEqual([5, 0, -2]);
    expect(translation(wheel.worldMatrix)).toEqual([5, 0, -4]);
    expect(wheel.localMatrix.slice(12, 15)).toEqual([2, 0, 0]);
    expect(wheel.worldMatrixSha256).not.toBe(first.checkpoints[0]!.nodeStates.find((state) => state.nodeId === "car.node.01")!.worldMatrixSha256);

    expect(end.primitiveInstances).toEqual([
      { id: "car.node.00.instance.00", nodeId: "car.node.00", primitiveRef: "car.mesh.00.primitive.00", material: { kind: "story", materialRef: "blue" } },
      { id: "car.node.01.instance.00", nodeId: "car.node.01", primitiveRef: "car.mesh.01.primitive.00", material: { kind: "source", materialIndex: 1 } },
    ]);
    expect(end.camera.target).toEqual(end.bounds.center);
    expect(end.camera.near).toBeGreaterThan(0);
    expect(end.camera.far).toBeGreaterThan(end.camera.near);
    expect(distance(end.camera.position, end.camera.target)).toBeGreaterThanOrEqual(end.bounds.radius * end.camera.padding);
    expect(first.evidence).toMatchObject({
      importedLocalThenWrapper: true,
      parentWorldComposition: true,
      sharedGeometryResources: true,
      aggregateTransformedBounds: true,
      boundedCameraFraming: true,
      interpolationPerformed: false,
      physicsFieldsAccepted: false,
      rendererInvoked: false,
      packageWritten: false,
    });
    expect(objectPlan.nodes.map((node) => node.localTransformSha256)).toEqual(carObjectPlan().nodes.map((node) => node.localTransformSha256));
  });

  it("postmultiplies story wrappers after an admitted glTF matrix without replacing it", () => {
    const objectPlan = matrixObjectPlan();
    const storyPlan = compileGltfObjectStoryPlan(objectPlan, {
      schema: GLTF_OBJECT_STORY_SCHEMA,
      objectFingerprint: objectPlan.fingerprint,
      startUs: 0,
      endUs: 1_000_000,
      materials: [],
      controls: [{ id: "move", kind: "transform", roleId: "root" }],
      checkpoints: [
        { id: "start", atUs: 0, states: [{ controlId: "move", value: { translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 } }] },
        { id: "end", atUs: 1_000_000, states: [{ controlId: "move", value: { translation: [1, 0, 0], rotationDeg: [0, 0, 0], scale: 2 } }] },
      ],
    });
    const plan = compileGltfObjectScenePlan(objectPlan, storyPlan, sceneAssembly(objectPlan, storyPlan));
    const end = plan.checkpoints[1]!.nodeStates[0]!;
    expect(translation(end.localMatrix)).toEqual([2, 2, 3]);
    expect(end.localMatrix.slice(0, 12)).toEqual([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0]);
    expect(objectPlan.nodes[0]!.localTransform).toEqual({ kind: "matrix", matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] });
  });

  it("fails closed on identity drift, hidden camera fields, degenerate framing, forged plans, and hierarchy overflow", () => {
    const objectPlan = carObjectPlan(), storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan));
    const valid = sceneAssembly(objectPlan, storyPlan);
    expect(() => compileGltfObjectScenePlan(objectPlan, storyPlan, { ...valid, objectFingerprint: "0".repeat(64) })).toThrow("does not match the imported object plan");
    expect(() => compileGltfObjectScenePlan(objectPlan, storyPlan, { ...valid, storyFingerprint: "0".repeat(64) })).toThrow("does not match the imported object story plan");
    expect(() => compileGltfObjectScenePlan(objectPlan, storyPlan, { ...valid, camera: { ...valid.camera, near: 0.1 } })).toThrow("unknown field 'near'");
    expect(() => compileGltfObjectScenePlan(objectPlan, storyPlan, { ...valid, camera: { ...valid.camera, viewDirection: [0, 0, 0] } })).toThrow("must be non-zero");
    expect(() => compileGltfObjectScenePlan(objectPlan, storyPlan, { ...valid, physics: {} })).toThrow("unknown field 'physics'");

    const forgedStory = Object.freeze({ ...storyPlan, fingerprint: "0".repeat(64) }) as GltfObjectStoryPlan;
    expect(() => compileGltfObjectScenePlan(objectPlan, forgedStory, valid)).toThrow("story plan fingerprint does not match");
    const forgedObject = Object.freeze({ ...objectPlan, fingerprint: "0".repeat(64) }) as GltfObjectPlan;
    expect(() => compileGltfObjectScenePlan(forgedObject, storyPlan, valid)).toThrow("object plan fingerprint does not match");

    const overflowingObject = scaledHierarchyObjectPlan();
    const overflowingStory = compileGltfObjectStoryPlan(overflowingObject, rootOnlyStory(overflowingObject));
    expect(() => compileGltfObjectScenePlan(overflowingObject, overflowingStory, sceneAssembly(overflowingObject, overflowingStory))).toThrow("world matrix exceeds the finite 1000000-component cap");
  });
});

function sceneAssembly(objectPlan: GltfObjectPlan, storyPlan: GltfObjectStoryPlan) {
  return {
    schema: GLTF_OBJECT_SCENE_SCHEMA,
    id: "car-shot",
    objectFingerprint: objectPlan.fingerprint,
    storyFingerprint: storyPlan.fingerprint,
    camera: { viewDirection: [1, 0.6, 1], fovDeg: 42, padding: 1.2 },
  };
}

function carObjectPlan() {
  const container = parsed(carGltf());
  return compileGltfObjectPlan(container, {
    schema: GLTF_OBJECT_DECLARATION_SCHEMA,
    assetId: "car",
    sourceSha256: container.sourceSha256,
    roles: [
      { roleId: "body", nodeIndex: 0, expectedNodeName: "Body" },
      { roleId: "root", nodeIndex: 2, expectedNodeName: "Car" },
      { roleId: "wheel", nodeIndex: 1, expectedNodeName: "Wheel" },
    ],
  });
}

function carStory(objectPlan: GltfObjectPlan) {
  return {
    schema: GLTF_OBJECT_STORY_SCHEMA,
    objectFingerprint: objectPlan.fingerprint,
    startUs: 0,
    endUs: 1_000_000,
    materials: [{ id: "blue", kind: "basic", baseColor: "#38bdf8", emissive: 0.05 }],
    controls: [
      { id: "body-paint", kind: "material", roleId: "body", primitiveRef: "car.mesh.00.primitive.00" },
      { id: "root-motion", kind: "transform", roleId: "root" },
      { id: "wheel-spin", kind: "transform", roleId: "wheel" },
    ],
    checkpoints: [
      {
        id: "start",
        atUs: 0,
        states: [
          { controlId: "body-paint", value: { materialRef: "blue" } },
          { controlId: "root-motion", value: { translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 } },
          { controlId: "wheel-spin", value: { translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 } },
        ],
      },
      {
        id: "end",
        atUs: 1_000_000,
        states: [
          { controlId: "body-paint", value: { materialRef: "blue" } },
          { controlId: "root-motion", value: { translation: [4, 0, -2], rotationDeg: [0, 90, 0], scale: 1 } },
          { controlId: "wheel-spin", value: { translation: [0, 0, 0], rotationDeg: [180, 0, 0], scale: 1 } },
        ],
      },
    ],
  };
}

function matrixObjectPlan() {
  const gltf = triangleGltf([{ name: "Root", mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] }], [0]);
  const container = parsed(gltf);
  return compileGltfObjectPlan(container, {
    schema: GLTF_OBJECT_DECLARATION_SCHEMA,
    assetId: "matrix",
    sourceSha256: container.sourceSha256,
    roles: [{ roleId: "root", nodeIndex: 0, expectedNodeName: "Root" }],
  });
}

function scaledHierarchyObjectPlan() {
  const gltf = triangleGltf([
    { name: "Root", children: [1], scale: [100, 100, 100] },
    { name: "Middle", children: [2], scale: [100, 100, 100] },
    { name: "Middle-2", children: [3], scale: [100, 100, 100] },
    { name: "Leaf", mesh: 0, scale: [100, 100, 100] },
  ], [0]);
  const container = parsed(gltf);
  return compileGltfObjectPlan(container, {
    schema: GLTF_OBJECT_DECLARATION_SCHEMA,
    assetId: "scaled",
    sourceSha256: container.sourceSha256,
    roles: [{ roleId: "root", nodeIndex: 0, expectedNodeName: "Root" }],
  });
}

function rootOnlyStory(objectPlan: GltfObjectPlan) {
  const state = { controlId: "root-motion", value: { translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 } };
  return {
    schema: GLTF_OBJECT_STORY_SCHEMA,
    objectFingerprint: objectPlan.fingerprint,
    startUs: 0,
    endUs: 1,
    materials: [],
    controls: [{ id: "root-motion", kind: "transform", roleId: "root" }],
    checkpoints: [{ id: "start", atUs: 0, states: [state] }, { id: "end", atUs: 1, states: [state] }],
  };
}

function carGltf(): Record<string, unknown> {
  const base = triangleGltf([
    { name: "Body", mesh: 0 },
    { name: "Wheel", mesh: 1, translation: [2, 0, 0] },
    { name: "Car", children: [0, 1], translation: [1, 0, 0] },
  ], [2]);
  base.materials = [{ name: "Body" }, { name: "Wheel" }];
  base.meshes = [
    { primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
    { primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] },
  ];
  return base;
}

function triangleGltf(nodes: readonly Record<string, unknown>[], roots: readonly number[]): Record<string, unknown> {
  const bytes = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => bytes.writeUInt16LE(value, 36 + index * 2));
  return {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    materials: [{ name: "Material" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes,
    scenes: [{ nodes: roots }],
    scene: 0,
  };
}

function parsed(source: Record<string, unknown>) {
  return parseGltfContainer(Buffer.from(canonicalJson(source), "utf8"), "gltf");
}

function translation(matrix: readonly number[]): number[] { return matrix.slice(12, 15); }
function distance(left: readonly number[], right: readonly number[]): number { return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0)); }
