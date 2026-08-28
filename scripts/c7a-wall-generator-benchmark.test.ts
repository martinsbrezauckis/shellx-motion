import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { C7A_WALL_GENERATOR_BENCHMARK_CONTRACT, runC7aWallGeneratorBenchmark } from "./c7a-wall-generator-benchmark";

describe("C7A wall-generator benchmark", () => {
  it("pins the variable topology matrix and root command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["c7a:wall-generator-benchmark"]).toBe("tsx scripts/c7a-wall-generator-benchmark.ts");
    expect(C7A_WALL_GENERATOR_BENCHMARK_CONTRACT.cases.map((entry) => entry.rows * entry.columns)).toEqual([15, 45, 135]);
  });

  it("separates exact generator evidence from host timing", () => {
    const first = runC7aWallGeneratorBenchmark(), second = runC7aWallGeneratorBenchmark();
    expect(second.deterministicFingerprint).toBe(first.deterministicFingerprint);
    expect(first.results.map((result) => result.entityCount)).toEqual([15, 45, 135]);
    expect(first.results.map((result) => result.expandedGeometryBytes / result.uniqueGeometryBytes)).toEqual([15, 45, 135]);
    expect(first.results.every((result) => result.meanCompileMs > 0)).toBe(true);
  });
});
