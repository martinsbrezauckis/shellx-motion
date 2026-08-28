import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT, runC7aGltfObjectSceneBenchmark } from "./c7a-gltf-object-scene-benchmark";

describe("C7A glTF object-scene benchmark", () => {
  it("pins the 2/8/16-checkpoint assembly matrix and root command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["c7a:gltf-object-scene-benchmark"]).toBe("tsx scripts/c7a-gltf-object-scene-benchmark.ts");
    expect(C7A_GLTF_OBJECT_SCENE_BENCHMARK_CONTRACT).toMatchObject({ checkpointCounts: [2, 8, 16], nodeCount: 6, primitiveInstanceCount: 5 });
  });

  it("separates exact matrices, bounds, and camera evidence from host timing", () => {
    const first = runC7aGltfObjectSceneBenchmark(), second = runC7aGltfObjectSceneBenchmark();
    expect(second.deterministicFingerprint).toBe(first.deterministicFingerprint);
    expect(first.results.map((result) => result.nodeStateSampleCount)).toEqual([12, 48, 96]);
    expect(first.results.map((result) => result.primitiveInstanceSampleCount)).toEqual([10, 40, 80]);
    expect(first.results.map((result) => result.transformedBoundsCornerCount)).toEqual([80, 320, 640]);
    expect(new Set(first.results.map((result) => result.objectTopologyFingerprint)).size).toBe(1);
    expect(new Set(first.results.map((result) => result.resourceFingerprint)).size).toBe(1);
    expect(first.results.every((result) => result.meanCompileMs > 0)).toBe(true);
  }, 15_000);
});
