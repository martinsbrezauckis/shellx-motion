import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { canonicalJson, canonicalJsonSha256 } from "../packages/core/src/canonical-json";
import { parseGltfContainer } from "../packages/core/src/gltf-container";
import { projectGltfCanonicalScene3d } from "../packages/core/src/gltf-lowering";
import { compileGltfObjectPlan } from "../packages/core/src/internal/scene-recipe/gltf-object-plan";
import { GLTF_OBJECT_DECLARATION_SCHEMA } from "../packages/core/src/internal/scene-recipe/gltf-object-plan-types";

export const C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT = Object.freeze({
  schema: "shellx-motion/c7a-gltf-shared-mesh-benchmark@1",
  warmupIterations: 10,
  measuredIterations: 100,
  instanceCounts: Object.freeze([4, 16, 63]),
});

export function runC7aGltfSharedMeshBenchmark() {
  const results = C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.instanceCounts.map((instanceCount) => {
    const source = sharedTriangleGltf(instanceCount);
    const sourceBytes = Buffer.from(canonicalJson(source), "utf8");
    const container = parseGltfContainer(sourceBytes, "gltf");
    const declaration = {
      schema: GLTF_OBJECT_DECLARATION_SCHEMA,
      assetId: "car",
      sourceSha256: container.sourceSha256,
      roles: [
        { roleId: "body", nodeIndex: 0, expectedNodeName: "Car" },
        { roleId: "wheel-last", nodeIndex: instanceCount, expectedNodeName: `Wheel-${String(instanceCount).padStart(2, "0")}` },
      ],
    };
    for (let iteration = 0; iteration < C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.warmupIterations; iteration += 1) compileGltfObjectPlan(container, declaration);
    let plan = compileGltfObjectPlan(container, declaration);
    const planStarted = performance.now();
    for (let iteration = 0; iteration < C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.measuredIterations; iteration += 1) plan = compileGltfObjectPlan(container, declaration);
    const planElapsed = performance.now() - planStarted;
    const legacy = benchmarkLegacy(container);
    const deterministic = {
      id: `shared-triangle-${instanceCount}`,
      instanceCount,
      sourceBytes: sourceBytes.byteLength,
      planBytes: plan.budget.planBytes,
      nodeCount: plan.budget.nodeCount,
      primitiveResourceCount: plan.budget.primitiveResourceCount,
      primitiveInstanceCount: plan.budget.primitiveInstanceCount,
      uniqueGeometryBytes: plan.budget.uniqueGeometryBytes,
      expandedGeometryBytes: plan.budget.expandedGeometryBytes,
      hierarchySha256: canonicalJsonSha256(plan.nodes.map((node) => ({ id: node.id, parentId: node.parentId, childIds: node.childIds, primitiveRefs: node.primitiveRefs, transform: node.localTransformSha256 }))),
      resourceFingerprint: plan.resources.fingerprint,
      roleSha256: canonicalJsonSha256(plan.roles),
      planFingerprint: plan.fingerprint,
      legacy: legacy.deterministic,
    };
    return Object.freeze({
      ...deterministic,
      planMeanCompileMs: rounded(planElapsed / C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.measuredIterations),
      legacyMeanCompileMs: legacy.meanCompileMs,
      deterministicFingerprint: canonicalJsonSha256(deterministic),
    });
  });
  return Object.freeze({
    schema: C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.schema,
    environment: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    contract: C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT,
    results: Object.freeze(results),
    deterministicFingerprint: canonicalJsonSha256({
      contract: C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT,
      results: results.map(({ planMeanCompileMs: _plan, legacyMeanCompileMs: _legacy, ...result }) => result),
    }),
  });
}

function benchmarkLegacy(container: ReturnType<typeof parseGltfContainer>): {
  deterministic: Readonly<{ status: "accepted"; objectCount: number; duplicatedGeometryBytes: number } | { status: "refused"; reason: string }>;
  meanCompileMs: number | null;
} {
  let first: ReturnType<typeof projectGltfCanonicalScene3d>;
  try { first = projectGltfCanonicalScene3d(container); } catch (error) {
    return { deterministic: Object.freeze({ status: "refused", reason: error instanceof Error ? error.message : "unknown refusal" }), meanCompileMs: null };
  }
  for (let iteration = 0; iteration < C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.warmupIterations; iteration += 1) projectGltfCanonicalScene3d(container);
  const started = performance.now();
  for (let iteration = 0; iteration < C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.measuredIterations; iteration += 1) projectGltfCanonicalScene3d(container);
  const elapsed = performance.now() - started;
  const duplicatedGeometryBytes = first.scene3d.objects.reduce((sum, object) => object.primitive === "mesh"
    ? sum + 16 + object.geometry.positions.length * 8 + object.geometry.indices.length * 4
    : sum, 0);
  return { deterministic: Object.freeze({ status: "accepted", objectCount: first.scene3d.objects.length, duplicatedGeometryBytes }), meanCompileMs: rounded(elapsed / C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.measuredIterations) };
}

function sharedTriangleGltf(instanceCount: number): Record<string, unknown> {
  const bytes = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => bytes.writeUInt16LE(value, 36 + index * 2));
  const children = Array.from({ length: instanceCount }, (_value, index) => index + 1);
  return {
    asset: { version: "2.0", generator: "C7A3a shared triangle benchmark" },
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ name: "Car", children }, ...children.map((index) => ({ name: `Wheel-${String(index).padStart(2, "0")}`, mesh: 0, translation: [index * 0.25, 0, 0] }))],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(runC7aGltfSharedMeshBenchmark(), null, 2)}\n`);
