import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { canonicalJsonSha256 } from "../packages/core/src/canonical-json";
import { compileGltfObjectScenePlan } from "../packages/core/src/internal/scene-recipe/gltf-object-scene";
import { GLTF_OBJECT_SCENE_SCHEMA } from "../packages/core/src/internal/scene-recipe/gltf-object-scene-types";
import { compileGltfObjectStoryPlan } from "../packages/core/src/internal/scene-recipe/gltf-object-story";
import { carObjectPlan, carStory } from "../packages/core/src/internal/scene-recipe/gltf-object-scene.test-support";

export const C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT = Object.freeze({
  schema: "shellx-motion/c7a-gltf-object-scene-benchmark@1",
  warmupIterations: 10,
  measuredIterations: 100,
  checkpointCounts: Object.freeze([2, 8, 16]),
  nodeCount: 6,
  primitiveInstanceCount: 5,
});

export function runC7aGltfObjectSceneBenchmark() {
  const objectPlan = carObjectPlan();
  const results = C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT.checkpointCounts.map((checkpointCount) => {
    const storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan.fingerprint, checkpointCount));
    const assembly = {
      schema: GLTF_OBJECT_SCENE_SCHEMA,
      id: `car-scene-${checkpointCount}`,
      objectFingerprint: objectPlan.fingerprint,
      storyFingerprint: storyPlan.fingerprint,
      camera: { viewDirection: [1, 0.65, 1], fovDeg: 42, padding: 1.2 },
    };
    for (let iteration = 0; iteration < C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT.warmupIterations; iteration += 1) compileGltfObjectScenePlan(objectPlan, storyPlan, assembly);
    let plan = compileGltfObjectScenePlan(objectPlan, storyPlan, assembly);
    const started = performance.now();
    for (let iteration = 0; iteration < C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT.measuredIterations; iteration += 1) plan = compileGltfObjectScenePlan(objectPlan, storyPlan, assembly);
    const elapsed = performance.now() - started;
    const deterministic = {
      id: assembly.id,
      checkpointCount,
      nodeStateSampleCount: plan.budget.nodeStateSampleCount,
      primitiveInstanceSampleCount: plan.budget.primitiveInstanceSampleCount,
      transformedBoundsCornerCount: plan.budget.transformedBoundsCornerCount,
      planBytes: plan.budget.planBytes,
      objectFingerprint: plan.objectFingerprint,
      storyFingerprint: plan.storyFingerprint,
      objectTopologyFingerprint: plan.objectTopologyFingerprint,
      resourceFingerprint: plan.resources.fingerprint,
      checkpointSha256: canonicalJsonSha256(plan.checkpoints),
      boundsSha256: canonicalJsonSha256(plan.checkpoints.map((checkpoint) => checkpoint.bounds)),
      cameraSha256: canonicalJsonSha256(plan.checkpoints.map((checkpoint) => checkpoint.camera)),
      planFingerprint: plan.fingerprint,
    };
    return Object.freeze({
      ...deterministic,
      meanCompileMs: rounded(elapsed / C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT.measuredIterations),
      deterministicFingerprint: canonicalJsonSha256(deterministic),
    });
  });
  return Object.freeze({
    schema: C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT.schema,
    environment: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    contract: C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT,
    results: Object.freeze(results),
    deterministicFingerprint: canonicalJsonSha256({
      contract: C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT,
      results: results.map(({ meanCompileMs: _mean, ...result }) => result),
    }),
  });
}

function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(runC7aGltfObjectSceneBenchmark(), null, 2)}\n`);
