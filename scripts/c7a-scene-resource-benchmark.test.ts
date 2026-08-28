import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT, runC7aSceneResourceBenchmark } from "./c7a-scene-resource-benchmark";

describe("C7A scene-resource benchmark", () => {
  it("keeps the matrix and root command pinned", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["c7a:scene-resource-benchmark"]).toBe("tsx scripts/c7a-scene-resource-benchmark.ts");
    expect(C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT).toMatchObject({
      warmupIterations: 10,
      measuredIterations: 100,
      cases: [
        { id: "balls-10", count: 10 },
        { id: "balls-50", count: 50 },
        { id: "bricks-15", count: 15 },
        { id: "bricks-45", count: 45 },
        { id: "bricks-135", count: 135 },
      ],
    });
  });

  it("separates deterministic evidence from environmental timing", () => {
    const first = runC7aSceneResourceBenchmark();
    const second = runC7aSceneResourceBenchmark();
    expect(second.deterministicFingerprint).toBe(first.deterministicFingerprint);
    expect(first.results.map((result) => result.deterministicFingerprint))
      .toEqual(second.results.map((result) => result.deterministicFingerprint));
    expect(first.results.every((result) => result.meanCompileMs > 0)).toBe(true);
    expect(first.results.find((result) => result.id === "balls-50")!.geometryExpansionRatio).toBe(50);
    expect(first.results.find((result) => result.id === "bricks-135")!.geometryExpansionRatio).toBe(135);
  }, 15_000);
});
