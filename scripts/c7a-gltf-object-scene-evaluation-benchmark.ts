import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { canonicalJsonSha256 } from "../packages/core/src/canonical-json";
import { carObjectPlan, carStory } from "../packages/core/src/internal/scene-recipe/gltf-object-scene.test-support";
import { compileGltfObjectSceneEvaluationPlan } from "../packages/core/src/internal/scene-recipe/gltf-object-scene-evaluation";
import { GLTF_OBJECT_SCENE_EVALUATION_SCHEMA } from "../packages/core/src/internal/scene-recipe/gltf-object-scene-evaluation-types";
import { evaluateGltfObjectSceneAtUs } from "../packages/core/src/internal/scene-recipe/gltf-object-scene-evaluate";
import { compileGltfObjectScenePlan } from "../packages/core/src/internal/scene-recipe/gltf-object-scene";
import { GLTF_OBJECT_SCENE_SCHEMA } from "../packages/core/src/internal/scene-recipe/gltf-object-scene-types";
import { compileGltfObjectStoryPlan } from "../packages/core/src/internal/scene-recipe/gltf-object-story";

export const C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT = Object.freeze({
  schema: "shellx-motion/c7a-gltf-object-scene-evaluation-benchmark@1",
  warmupIterations: 3,
  measuredIterations: 20,
  checkpointCounts: Object.freeze([2, 8, 16]),
  samplePolicy: "checkpoints-and-midpoints",
});

export function runC7aGltfObjectSceneEvaluationBenchmark() {
  const objectPlan = carObjectPlan();
  const results = C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT.checkpointCounts.map((checkpointCount) => {
    const storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan.fingerprint, checkpointCount));
    const scenePlan = compileGltfObjectScenePlan(objectPlan, storyPlan, {
      schema: GLTF_OBJECT_SCENE_SCHEMA,
      id: `car-scene-${checkpointCount}`,
      objectFingerprint: objectPlan.fingerprint,
      storyFingerprint: storyPlan.fingerprint,
      camera: { viewDirection: [1, 0.65, 1], fovDeg: 42, padding: 1.2 },
    });
    const evaluation = {
      schema: GLTF_OBJECT_SCENE_EVALUATION_SCHEMA,
      sceneFingerprint: scenePlan.fingerprint,
      segments: storyPlan.checkpoints.slice(0, -1).map((from, index) => {
        const to = storyPlan.checkpoints[index + 1]!;
        return {
          id: `segment-${String(index).padStart(2, "0")}`,
          fromCheckpointId: from.id,
          toCheckpointId: to.id,
          controls: storyPlan.controls.map((control) => control.kind === "material"
            ? { controlId: control.id, kind: "material", switchAtUs: from.atUs + Math.floor((to.atUs - from.atUs) / 2) }
            : { controlId: control.id, kind: "transform", interpolation: control.id === "car-motion" ? "ease-in-out" : "linear" }),
        };
      }),
    };
    const plan = compileGltfObjectSceneEvaluationPlan(objectPlan, storyPlan, scenePlan, evaluation);
    const sampleTimes = storyPlan.checkpoints.flatMap((checkpoint, index) => index === storyPlan.checkpoints.length - 1
      ? [checkpoint.atUs]
      : [checkpoint.atUs, checkpoint.atUs + Math.floor((storyPlan.checkpoints[index + 1]!.atUs - checkpoint.atUs) / 2)]);
    for (let iteration = 0; iteration < C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT.warmupIterations; iteration += 1) evaluateAll(plan, sampleTimes);
    let frames = evaluateAll(plan, sampleTimes);
    const started = performance.now();
    for (let iteration = 0; iteration < C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT.measuredIterations; iteration += 1) frames = evaluateAll(plan, sampleTimes);
    const elapsed = performance.now() - started;
    const deterministic = {
      id: `car-evaluation-${checkpointCount}`,
      checkpointCount,
      segmentCount: plan.budget.segmentCount,
      sampleCount: sampleTimes.length,
      exactCheckpointSampleCount: checkpointCount,
      intermediateSampleCount: sampleTimes.length - checkpointCount,
      controlPolicyCount: plan.budget.controlPolicyCount,
      planBytes: plan.budget.planBytes,
      objectFingerprint: plan.objectFingerprint,
      storyFingerprint: plan.storyFingerprint,
      sceneFingerprint: plan.sceneFingerprint,
      evaluationFingerprint: plan.fingerprint,
      sampleTimesSha256: canonicalJsonSha256(sampleTimes),
      frameSha256: canonicalJsonSha256(frames.map((frame) => frame.fingerprint)),
    };
    return Object.freeze({
      ...deterministic,
      meanFrameEvaluationMs: rounded(elapsed / (C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT.measuredIterations * sampleTimes.length)),
      deterministicFingerprint: canonicalJsonSha256(deterministic),
    });
  });
  return Object.freeze({
    schema: C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT.schema,
    environment: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    contract: C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT,
    results: Object.freeze(results),
    deterministicFingerprint: canonicalJsonSha256({
      contract: C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT,
      results: results.map(({ meanFrameEvaluationMs: _mean, ...result }) => result),
    }),
  });
}

function evaluateAll(plan: ReturnType<typeof compileGltfObjectSceneEvaluationPlan>, sampleTimes: readonly number[]) {
  return sampleTimes.map((atUs) => {
    const result = evaluateGltfObjectSceneAtUs(plan, atUs);
    if (!result.ok) throw new Error(result.message);
    return result.frame;
  });
}

function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(runC7aGltfObjectSceneEvaluationBenchmark(), null, 2)}\n`);
