import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { canonicalJson, canonicalJsonSha256 } from "../packages/core/src/canonical-json";
import { carObjectPlan, carStory } from "../packages/core/src/internal/scene-recipe/gltf-object-scene.test-support";
import { compileGltfObjectStoryPlan } from "../packages/core/src/internal/scene-recipe/gltf-object-story";

export const C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT = Object.freeze({
  schema: "shellx-motion/c7a-gltf-object-story-benchmark@1",
  warmupIterations: 10,
  measuredIterations: 100,
  checkpointCounts: Object.freeze([2, 8, 16]),
  controlCount: 6,
});

export function runC7aGltfObjectStoryBenchmark() {
  const objectPlan = carObjectPlan();
  const results = C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT.checkpointCounts.map((checkpointCount) => {
    const story = carStory(objectPlan.fingerprint, checkpointCount);
    for (let iteration = 0; iteration < C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT.warmupIterations; iteration += 1) compileGltfObjectStoryPlan(objectPlan, story);
    let plan = compileGltfObjectStoryPlan(objectPlan, story);
    const started = performance.now();
    for (let iteration = 0; iteration < C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT.measuredIterations; iteration += 1) plan = compileGltfObjectStoryPlan(objectPlan, story);
    const elapsed = performance.now() - started;
    const deterministic = {
      id: `car-story-${checkpointCount}`,
      checkpointCount,
      controlCount: plan.controls.length,
      stateSampleCount: plan.budget.stateSampleCount,
      storyBytes: Buffer.byteLength(canonicalJson(story), "utf8"),
      planBytes: plan.budget.planBytes,
      objectFingerprint: plan.objectFingerprint,
      objectTopologyFingerprint: plan.objectTopologyFingerprint,
      controlSha256: canonicalJsonSha256(plan.controls),
      checkpointSha256: canonicalJsonSha256(plan.checkpoints),
      planFingerprint: plan.fingerprint,
    };
    return Object.freeze({
      ...deterministic,
      meanCompileMs: rounded(elapsed / C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT.measuredIterations),
      deterministicFingerprint: canonicalJsonSha256(deterministic),
    });
  });
  return Object.freeze({
    schema: C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT.schema,
    environment: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    contract: C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT,
    results: Object.freeze(results),
    deterministicFingerprint: canonicalJsonSha256({
      contract: C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT,
      results: results.map(({ meanCompileMs: _mean, ...result }) => result),
    }),
  });
}

function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(runC7aGltfObjectStoryBenchmark(), null, 2)}\n`);
