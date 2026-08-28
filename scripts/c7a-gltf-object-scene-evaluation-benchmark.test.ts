import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT, runC7aGltfObjectSceneEvaluationBenchmark } from "./c7a-gltf-object-scene-evaluation-benchmark";

describe("C7A glTF object-scene evaluation benchmark", () => {
  it("pins the 2/8/16-checkpoint frame matrix and root command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["c7a:gltf-object-scene-evaluation-benchmark"]).toBe("tsx scripts/c7a-gltf-object-scene-evaluation-benchmark.ts");
    expect(C7A_GLTF_OBJECT_SCENE_EVALUATION_BENCHMARK_CONTRACT).toMatchObject({ checkpointCounts: [2, 8, 16], samplePolicy: "checkpoints-and-midpoints" });
  });

  it("separates exact checkpoint/intermediate-frame evidence from host timing", () => {
    const first = runC7aGltfObjectSceneEvaluationBenchmark(), second = runC7aGltfObjectSceneEvaluationBenchmark();
    expect(second.deterministicFingerprint).toBe(first.deterministicFingerprint);
    expect(first.results.map((result) => result.sampleCount)).toEqual([3, 15, 31]);
    expect(first.results.map((result) => result.exactCheckpointSampleCount)).toEqual([2, 8, 16]);
    expect(first.results.map((result) => result.intermediateSampleCount)).toEqual([1, 7, 15]);
    expect(first.results.map((result) => result.controlPolicyCount)).toEqual([6, 42, 90]);
    expect(first.results.every((result) => result.meanFrameEvaluationMs > 0)).toBe(true);
  }, 15_000);
});
