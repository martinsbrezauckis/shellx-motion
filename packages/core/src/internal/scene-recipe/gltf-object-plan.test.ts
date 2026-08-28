import { describe, expect, it } from "vitest";
import { parseGltfContainer } from "../../gltf-container";
import { projectGltfCanonicalScene3d } from "../../gltf-lowering";
import { compileGltfObjectPlan } from "./gltf-object-plan";
import { GLTF_OBJECT_DECLARATION_SCHEMA } from "./gltf-object-plan-types";

describe("C7A3a imported glTF hierarchy and shared meshes", () => {
  it("preserves stable hierarchy, local transforms, shared mesh resources, and explicit roles", () => {
    const container = parsed(sharedTriangleGltf(4));
    const declaration = roles(container, [
      { roleId: "body", nodeIndex: 0, expectedNodeName: "Car" },
      { roleId: "wheel-front-left", nodeIndex: 1, expectedNodeName: "Wheel-01" },
    ]);
    const first = compileGltfObjectPlan(container, declaration);
    const second = compileGltfObjectPlan(container, declaration);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.rootNodeIds).toEqual(["car.node.00"]);
    expect(first.nodes).toHaveLength(5);
    expect(first.nodes[1]).toMatchObject({
      id: "car.node.01",
      name: "Wheel-01",
      parentId: "car.node.00",
      primitiveRefs: ["car.mesh.00.primitive.00"],
      localTransform: { kind: "trs", translation: [0.25, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    expect(first.resources.primitives).toHaveLength(1);
    expect(first.roles).toEqual([
      { roleId: "body", nodeIndex: 0, expectedNodeName: "Car", nodeId: "car.node.00", nodePath: ["car.node.00"] },
      { roleId: "wheel-front-left", nodeIndex: 1, expectedNodeName: "Wheel-01", nodeId: "car.node.01", nodePath: ["car.node.00", "car.node.01"] },
    ]);
    expect(first.budget).toMatchObject({
      nodeCount: 5,
      meshNodeCount: 4,
      primitiveResourceCount: 1,
      primitiveInstanceCount: 4,
      reusedPrimitiveInstanceCount: 3,
      uniqueGeometryBytes: 100,
      expandedGeometryBytes: 400,
    });
    expect(first.evidence).toMatchObject({
      selectedSceneHierarchyPreserved: true,
      sharedMeshResources: true,
      explicitSemanticRoles: true,
      rendererInvoked: false,
      packageWritten: false,
    });
  });

  it("preserves admitted matrix transforms and scales to 63 shared instances without duplicating geometry", () => {
    const source = sharedTriangleGltf(63);
    (source.nodes as Record<string, unknown>[])[1] = {
      name: "Wheel-01",
      mesh: 0,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.25, 0, 0, 1],
    };
    const container = parsed(source);
    const plan = compileGltfObjectPlan(container, roles(container, [{ roleId: "wheel", nodeIndex: 1, expectedNodeName: "Wheel-01" }]));

    expect(plan.nodes).toHaveLength(64);
    expect(plan.nodes[1]!.localTransform).toMatchObject({ kind: "matrix", matrix: expect.arrayContaining([0.25]) });
    expect(plan.budget).toMatchObject({ primitiveResourceCount: 1, primitiveInstanceCount: 63, uniqueGeometryBytes: 100, expandedGeometryBytes: 6_300 });
    expect(() => projectGltfCanonicalScene3d(parsed(sharedTriangleGltf(63)))).toThrow("exceeds 16 mesh primitives");
  });

  it("fails closed on source drift, ambiguous hierarchy, role drift, extensions, deferred features, and hidden geometry", () => {
    const container = parsed(sharedTriangleGltf(4));
    const declaration = roles(container, [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Car" }]);

    expect(() => compileGltfObjectPlan(container, { ...declaration, sourceSha256: "0".repeat(64) })).toThrow("source hash does not match");
    expect(() => compileGltfObjectPlan(container, roles(container, [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Wrong" }]))).toThrow("expected node name");
    expect(() => compileGltfObjectPlan(container, roles(container, [{ roleId: "missing", nodeIndex: 63, expectedNodeName: null }]))).toThrow("outside the selected scene");

    const cycle = sharedTriangleGltf(2);
    (cycle.nodes as Record<string, unknown>[])[1]!.children = [0];
    expect(() => compileGltfObjectPlan(parsed(cycle), roles(parsed(cycle), [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Car" }]))).toThrow("contains a cycle");

    const sharedChild = sharedTriangleGltf(3);
    (sharedChild.nodes as Record<string, unknown>[])[1]!.children = [3];
    (sharedChild.nodes as Record<string, unknown>[])[2]!.children = [3];
    expect(() => {
      const parsedSharedChild = parsed(sharedChild);
      return compileGltfObjectPlan(parsedSharedChild, roles(parsedSharedChild, [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Car" }]));
    }).toThrow("each node may have only one parent");

    const externalParent = sharedTriangleGltf(2);
    (externalParent.nodes as Record<string, unknown>[]).push({ name: "Outside selected scene", children: [0] });
    const parsedExternalParent = parsed(externalParent);
    expect(() => compileGltfObjectPlan(parsedExternalParent, roles(parsedExternalParent, [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Car" }]))).toThrow("external or ambiguous parent");

    for (const mutate of [
      (source: Record<string, unknown>) => { source.extensionsRequired = ["KHR_draco_mesh_compression"]; },
      (source: Record<string, unknown>) => { source.animations = [{ channels: [], samplers: [] }]; },
      (source: Record<string, unknown>) => { (((source.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!.attributes as Record<string, unknown>).TEXCOORD_0 = 0; },
      (source: Record<string, unknown>) => { (source.nodes as Record<string, unknown>[])[1]!.extras = { semantic: "wheel" }; },
      (source: Record<string, unknown>) => { (source.nodes as Record<string, unknown>[])[1]!.matrix = Array(16).fill(0); },
    ]) {
      const hostile = sharedTriangleGltf(2); mutate(hostile);
      const parsedHostile = parsed(hostile);
      expect(() => compileGltfObjectPlan(parsedHostile, roles(parsedHostile, [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Car" }]))).toThrow();
    }

    const drifted = parsed(sharedTriangleGltf(2));
    drifted.buffers[0]![0] ^= 1;
    expect(() => compileGltfObjectPlan(drifted, roles(drifted, [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Car" }]))).toThrow("no longer matches its admitted hash");

    const jsonDrifted = parsed(sharedTriangleGltf(2));
    (jsonDrifted.json.nodes as Record<string, unknown>[])[0]!.name = "Changed after parse";
    expect(() => compileGltfObjectPlan(jsonDrifted, roles(jsonDrifted, [{ roleId: "body", nodeIndex: 0, expectedNodeName: "Changed after parse" }]))).toThrow("no longer matches its normalized source text");

    const skewed = sharedTriangleGltf(2);
    (skewed.nodes as Record<string, unknown>[])[1] = { name: "Wheel-01", mesh: 0, matrix: [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    const parsedSkewed = parsed(skewed);
    expect(() => compileGltfObjectPlan(parsedSkewed, roles(parsedSkewed, [{ roleId: "wheel", nodeIndex: 1, expectedNodeName: "Wheel-01" }]))).toThrow("skew or shear");
  });
});

function roles(container: ReturnType<typeof parsed>, bindings: readonly Record<string, unknown>[]) {
  return { schema: GLTF_OBJECT_DECLARATION_SCHEMA, assetId: "car", sourceSha256: container.sourceSha256, roles: bindings };
}

function parsed(source: Record<string, unknown>) {
  return parseGltfContainer(Buffer.from(JSON.stringify(source), "utf8"), "gltf");
}

function sharedTriangleGltf(instanceCount: number): Record<string, unknown> {
  const bytes = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => bytes.writeUInt16LE(value, 36 + index * 2));
  const children = Array.from({ length: instanceCount }, (_value, index) => index + 1);
  return {
    asset: { version: "2.0", generator: "C7A3a shared triangle" },
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    materials: [{ name: "Wheel material" }],
    meshes: [{ name: "Wheel mesh", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [
      { name: "Car", children },
      ...children.map((index) => ({ name: `Wheel-${String(index).padStart(2, "0")}`, mesh: 0, translation: [index * 0.25, 0, 0] })),
    ],
    scenes: [{ name: "Car scene", nodes: [0] }],
    scene: 0,
  };
}
