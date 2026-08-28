import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT, runC7aGltfObjectStoryBenchmark } from "./c7a-gltf-object-story-benchmark";

describe("C7A glTF object-story benchmark", () => {
  it("pins the 2/8/16-checkpoint matrix and root command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["c7a:gltf-object-story-benchmark"]).toBe("tsx scripts/c7a-gltf-object-story-benchmark.ts");
    expect(C7A_GLTF_OBJECT_STORY_BENCHMARK_CONTRACT).toMatchObject({ checkpointCounts: [2, 8, 16], controlCount: 6 });
  });

  it("separates exact role/checkpoint evidence from host timing", () => {
    const first = runC7aGltfObjectStoryBenchmark(), second = runC7aGltfObjectStoryBenchmark();
    expect(second.deterministicFingerprint).toBe(first.deterministicFingerprint);
    expect(first.results.map((result) => result.checkpointCount)).toEqual([2, 8, 16]);
    expect(first.results.map((result) => result.controlCount)).toEqual([6, 6, 6]);
    expect(first.results.map((result) => result.stateSampleCount)).toEqual([12, 48, 96]);
    expect(new Set(first.results.map((result) => result.objectTopologyFingerprint)).size).toBe(1);
    expect(first.results.every((result) => result.meanCompileMs > 0)).toBe(true);
  });
});
