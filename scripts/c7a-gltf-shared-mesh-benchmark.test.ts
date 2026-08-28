import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT, runC7aGltfSharedMeshBenchmark } from "./c7a-gltf-shared-mesh-benchmark";

describe("C7A glTF shared-mesh benchmark", () => {
  it("pins the unrelated 4/16/63-instance matrix and root command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["c7a:gltf-shared-mesh-benchmark"]).toBe("tsx scripts/c7a-gltf-shared-mesh-benchmark.ts");
    expect(C7A_GLTF_SHARED_MESH_BENCHMARK_CONTRACT.instanceCounts).toEqual([4, 16, 63]);
  });

  it("separates exact hierarchy/resource evidence from host timing", () => {
    const first = runC7aGltfSharedMeshBenchmark(), second = runC7aGltfSharedMeshBenchmark();
    expect(second.deterministicFingerprint).toBe(first.deterministicFingerprint);
    expect(first.results.map((result) => result.primitiveResourceCount)).toEqual([1, 1, 1]);
    expect(first.results.map((result) => result.primitiveInstanceCount)).toEqual([4, 16, 63]);
    expect(first.results.map((result) => result.expandedGeometryBytes / result.uniqueGeometryBytes)).toEqual([4, 16, 63]);
    expect(first.results.map((result) => result.legacy.status)).toEqual(["accepted", "accepted", "refused"]);
    expect(first.results.every((result) => result.planMeanCompileMs > 0)).toBe(true);
  });
});
