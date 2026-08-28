import { canonicalJson } from "../../canonical-json";
import { parseGltfContainer } from "../../gltf-container";
import { compileGltfObjectPlan } from "./gltf-object-plan";
import { GLTF_OBJECT_DECLARATION_SCHEMA } from "./gltf-object-plan-types";
import { GLTF_OBJECT_STORY_SCHEMA } from "./gltf-object-story-types";

export function carObjectPlan() {
  const container = parseGltfContainer(Buffer.from(canonicalJson(carGltf()), "utf8"), "gltf");
  return compileGltfObjectPlan(container, {
    schema: GLTF_OBJECT_DECLARATION_SCHEMA,
    assetId: "car",
    sourceSha256: container.sourceSha256,
    roles: [
      { roleId: "body", nodeIndex: 1, expectedNodeName: "Body" },
      { roleId: "car-root", nodeIndex: 0, expectedNodeName: "Car" },
      { roleId: "wheel-back-left", nodeIndex: 4, expectedNodeName: "Wheel-BL" },
      { roleId: "wheel-back-right", nodeIndex: 5, expectedNodeName: "Wheel-BR" },
      { roleId: "wheel-front-left", nodeIndex: 2, expectedNodeName: "Wheel-FL" },
      { roleId: "wheel-front-right", nodeIndex: 3, expectedNodeName: "Wheel-FR" },
    ],
  });
}

export function carStory(objectFingerprint: string, checkpointCount: number) {
  const controls = [
    { id: "body-paint", kind: "material", roleId: "body", primitiveRef: "car.mesh.00.primitive.00" },
    { id: "car-motion", kind: "transform", roleId: "car-root" },
    { id: "wheel-bl-spin", kind: "transform", roleId: "wheel-back-left" },
    { id: "wheel-br-spin", kind: "transform", roleId: "wheel-back-right" },
    { id: "wheel-fl-spin", kind: "transform", roleId: "wheel-front-left" },
    { id: "wheel-fr-spin", kind: "transform", roleId: "wheel-front-right" },
  ];
  const checkpoints = Array.from({ length: checkpointCount }, (_value, index) => {
    const progress = index / (checkpointCount - 1), spin = index * 180;
    const transform = (controlId: string, rotationDeg: number[]) => ({ controlId, value: { translation: [0, 0, 0], rotationDeg, scale: 1 } });
    return {
      id: `cp-${String(index).padStart(2, "0")}`,
      atUs: index * 500_000,
      states: [
        { controlId: "body-paint", value: { materialRef: index % 2 === 0 ? "amber" : "blue" } },
        { controlId: "car-motion", value: { translation: [progress * 10, 0, -progress * 3], rotationDeg: [0, progress * 90, 0], scale: 1 } },
        transform("wheel-bl-spin", [spin, 0, 0]),
        transform("wheel-br-spin", [spin, 0, 0]),
        transform("wheel-fl-spin", [spin, 0, 0]),
        transform("wheel-fr-spin", [spin, 0, 0]),
      ],
    };
  });
  return {
    schema: GLTF_OBJECT_STORY_SCHEMA,
    objectFingerprint,
    startUs: 0,
    endUs: (checkpointCount - 1) * 500_000,
    materials: [{ id: "amber", kind: "basic", baseColor: "#f59e0b", emissive: 0 }, { id: "blue", kind: "basic", baseColor: "#38bdf8", emissive: 0.05 }],
    controls,
    checkpoints,
  };
}

function carGltf(): Record<string, unknown> {
  const bytes = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => bytes.writeUInt16LE(value, 36 + index * 2));
  return {
    asset: { version: "2.0" }, buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    materials: [{ name: "Body" }, { name: "Wheel" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }, { primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] }],
    nodes: [{ name: "Car", children: [1, 2, 3, 4, 5] }, { name: "Body", mesh: 0 }, { name: "Wheel-FL", mesh: 1 }, { name: "Wheel-FR", mesh: 1 }, { name: "Wheel-BL", mesh: 1 }, { name: "Wheel-BR", mesh: 1 }],
    scenes: [{ nodes: [0] }], scene: 0,
  };
}
