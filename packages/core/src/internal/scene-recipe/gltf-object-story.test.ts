import { describe, expect, it } from "vitest";
import { parseGltfContainer } from "../../gltf-container";
import { compileGltfObjectPlan } from "./gltf-object-plan";
import { GLTF_OBJECT_DECLARATION_SCHEMA, type GltfObjectPlan } from "./gltf-object-plan-types";
import { compileGltfObjectStoryPlan } from "./gltf-object-story";
import { GLTF_OBJECT_STORY_SCHEMA } from "./gltf-object-story-types";

describe("C7A3b role-addressed imported-object stories", () => {
  it("resolves exact transform and material checkpoints without changing imported topology", () => {
    const objectPlan = carObjectPlan();
    const story = carStory(objectPlan);
    const first = compileGltfObjectStoryPlan(objectPlan, story);
    const second = compileGltfObjectStoryPlan(objectPlan, story);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.controls).toEqual([
      { id: "body-paint", kind: "material", roleId: "body", primitiveRef: "car.mesh.00.primitive.00", nodeId: "car.node.01" },
      { id: "car-motion", kind: "transform", roleId: "car-root", nodeId: "car.node.00" },
      { id: "wheel-fl-spin", kind: "transform", roleId: "wheel-front-left", nodeId: "car.node.02" },
    ]);
    expect(first.checkpoints[1]!.states).toEqual([
      { controlId: "body-paint", value: { materialRef: "blue" }, nodeId: "car.node.01", primitiveRef: "car.mesh.00.primitive.00" },
      { controlId: "car-motion", value: { translation: [4, 0, -2], rotationDeg: [0, 45, 0], scale: 1.1 }, nodeId: "car.node.00", primitiveRef: null },
      { controlId: "wheel-fl-spin", value: { translation: [0, 0, 0], rotationDeg: [360, 0, 0], scale: 1 }, nodeId: "car.node.02", primitiveRef: null },
    ]);
    expect(first.budget).toMatchObject({ materialCount: 2, transformControlCount: 2, materialControlCount: 1, checkpointCount: 3, stateSampleCount: 9 });
    expect(first.evidence).toMatchObject({ wrapperTransformsOnly: true, importedTopologyImmutable: true, importedGeometryImmutable: true, rendererInvoked: false, packageWritten: false });

    const changed = carStory(objectPlan);
    changed.checkpoints[1]!.states[1]!.value.translation[0] = 6;
    const changedPlan = compileGltfObjectStoryPlan(objectPlan, changed);
    expect(changedPlan.fingerprint).not.toBe(first.fingerprint);
    expect(changedPlan.objectTopologyFingerprint).toBe(first.objectTopologyFingerprint);
    expect(objectPlan.fingerprint).toBe(first.objectFingerprint);
  });

  it("fails closed on drifted identity, implicit roles/slots, competing authority, sparse states, and material ambiguity", () => {
    const objectPlan = carObjectPlan(), valid = carStory(objectPlan);
    expect(() => compileGltfObjectStoryPlan(objectPlan, { ...valid, objectFingerprint: "0".repeat(64) })).toThrow("does not match the imported object plan");

    const unknownRole = carStory(objectPlan);
    unknownRole.controls[1]!.roleId = "inferred-wheel";
    expect(() => compileGltfObjectStoryPlan(objectPlan, unknownRole)).toThrow("does not identify an explicit imported-object role");

    const wrongSlot = carStory(objectPlan);
    wrongSlot.controls[0]!.primitiveRef = "car.mesh.01.primitive.00";
    expect(() => compileGltfObjectStoryPlan(objectPlan, wrongSlot)).toThrow("not directly attached");

    const competing = carStory(objectPlan);
    competing.controls.splice(2, 0, { id: "car-motion-2", kind: "transform", roleId: "car-root" });
    competing.checkpoints.forEach((checkpoint: any) => checkpoint.states.splice(2, 0, { controlId: "car-motion-2", value: { translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 } }));
    expect(() => compileGltfObjectStoryPlan(objectPlan, competing)).toThrow("control authorities must be unique");

    const aliasedObjectPlan = carObjectPlan(true), aliased = carStory(aliasedObjectPlan);
    aliased.controls.splice(2, 0, { id: "car-motion-alias", kind: "transform", roleId: "car-root-alias" });
    aliased.checkpoints.forEach((checkpoint: any) => checkpoint.states.splice(2, 0, { controlId: "car-motion-alias", value: { translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 } }));
    expect(() => compileGltfObjectStoryPlan(aliasedObjectPlan, aliased)).toThrow("control authorities must be unique");

    const sparse = carStory(objectPlan);
    sparse.checkpoints[1]!.states.pop();
    expect(() => compileGltfObjectStoryPlan(objectPlan, sparse)).toThrow("must contain 3..3 entries");

    const wrongOrder = carStory(objectPlan);
    wrongOrder.checkpoints[1]!.states.reverse();
    expect(() => compileGltfObjectStoryPlan(objectPlan, wrongOrder)).toThrow("must match the control order exactly");

    const missingMaterial = carStory(objectPlan);
    missingMaterial.checkpoints[1]!.states[0]!.value.materialRef = "missing";
    expect(() => compileGltfObjectStoryPlan(objectPlan, missingMaterial)).toThrow("does not identify a declared story material");

    const unusedMaterial = carStory(objectPlan);
    unusedMaterial.materials.push({ id: "white", kind: "basic", baseColor: "#ffffff", emissive: 0 });
    expect(() => compileGltfObjectStoryPlan(objectPlan, unusedMaterial)).toThrow("is never used by a checkpoint");

    const scripted = carStory(objectPlan);
    scripted.checkpoints[0]!.states[1]!.value.script = "drive()";
    expect(() => compileGltfObjectStoryPlan(objectPlan, scripted)).toThrow("unknown field 'script'");

    const forged = Object.freeze({ ...objectPlan, fingerprint: "f".repeat(64) }) as GltfObjectPlan;
    expect(() => compileGltfObjectStoryPlan(forged, valid)).toThrow("fingerprint does not match its contents");
  });
});

function carObjectPlan(includeRootAlias = false) {
  const container = parseGltfContainer(Buffer.from(JSON.stringify(carGltf()), "utf8"), "gltf");
  return compileGltfObjectPlan(container, {
    schema: GLTF_OBJECT_DECLARATION_SCHEMA,
    assetId: "car",
    sourceSha256: container.sourceSha256,
    roles: [
      { roleId: "body", nodeIndex: 1, expectedNodeName: "Body" },
      { roleId: "car-root", nodeIndex: 0, expectedNodeName: "Car" },
      ...(includeRootAlias ? [{ roleId: "car-root-alias", nodeIndex: 0, expectedNodeName: "Car" }] : []),
      { roleId: "wheel-back-left", nodeIndex: 4, expectedNodeName: "Wheel-BL" },
      { roleId: "wheel-back-right", nodeIndex: 5, expectedNodeName: "Wheel-BR" },
      { roleId: "wheel-front-left", nodeIndex: 2, expectedNodeName: "Wheel-FL" },
      { roleId: "wheel-front-right", nodeIndex: 3, expectedNodeName: "Wheel-FR" },
    ],
  });
}

function carStory(objectPlan: ReturnType<typeof carObjectPlan>): any {
  const transform = (controlId: string, translation: number[], rotationDeg: number[], scale = 1) => ({ controlId, value: { translation, rotationDeg, scale } });
  const checkpoint = (id: string, atUs: number, materialRef: string, x: number, yaw: number, wheel: number) => ({
    id,
    atUs,
    states: [
      { controlId: "body-paint", value: { materialRef } },
      transform("car-motion", [x, 0, -x / 2], [0, yaw, 0], x === 4 ? 1.1 : 1),
      transform("wheel-fl-spin", [0, 0, 0], [wheel, 0, 0]),
    ],
  });
  return {
    schema: GLTF_OBJECT_STORY_SCHEMA,
    objectFingerprint: objectPlan.fingerprint,
    startUs: 0,
    endUs: 5_000_000,
    materials: [
      { id: "amber", kind: "basic", baseColor: "#f59e0b", emissive: 0 },
      { id: "blue", kind: "basic", baseColor: "#38bdf8", emissive: 0.05 },
    ],
    controls: [
      { id: "body-paint", kind: "material", roleId: "body", primitiveRef: "car.mesh.00.primitive.00" },
      { id: "car-motion", kind: "transform", roleId: "car-root" },
      { id: "wheel-fl-spin", kind: "transform", roleId: "wheel-front-left" },
    ],
    checkpoints: [
      checkpoint("start", 0, "amber", 0, 0, 0),
      checkpoint("turn", 2_500_000, "blue", 4, 45, 360),
      checkpoint("end", 5_000_000, "amber", 8, 90, 720),
    ],
  };
}

function carGltf(): Record<string, unknown> {
  const bytes = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => bytes.writeUInt16LE(value, 36 + index * 2));
  return {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    materials: [{ name: "Body" }, { name: "Wheel" }],
    meshes: [
      { name: "Body", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
      { name: "Wheel", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] },
    ],
    nodes: [
      { name: "Car", children: [1, 2, 3, 4, 5] },
      { name: "Body", mesh: 0 },
      { name: "Wheel-FL", mesh: 1, translation: [-1, 0, 1] },
      { name: "Wheel-FR", mesh: 1, translation: [1, 0, 1] },
      { name: "Wheel-BL", mesh: 1, translation: [-1, 0, -1] },
      { name: "Wheel-BR", mesh: 1, translation: [1, 0, -1] },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}
