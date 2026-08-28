import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { canonicalJson, canonicalJsonSha256 } from "../packages/core/src/canonical-json";
import { compileSceneRecipe } from "../packages/core/src/internal/scene-recipe/scene-recipe-compile";
import { DIRECTED_SHOT_SCHEMA, SCENE_RECIPE_SCHEMA } from "../packages/core/src/internal/scene-recipe/scene-recipe-types";

export const C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT = Object.freeze({
  schema: "shellx-motion/c7a-scene-resource-benchmark@1",
  warmupIterations: 10,
  measuredIterations: 100,
  cases: Object.freeze([
    Object.freeze({ id: "balls-10", geometry: "sphere" as const, count: 10 }),
    Object.freeze({ id: "balls-50", geometry: "sphere" as const, count: 50 }),
    Object.freeze({ id: "bricks-15", geometry: "box" as const, count: 15 }),
    Object.freeze({ id: "bricks-45", geometry: "box" as const, count: 45 }),
    Object.freeze({ id: "bricks-135", geometry: "box" as const, count: 135 }),
  ]),
});

export function runC7aSceneResourceBenchmark() {
  const results = C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT.cases.map((benchmarkCase) => {
    const recipe = buildRecipe(benchmarkCase.geometry, benchmarkCase.count);
    for (let iteration = 0; iteration < C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT.warmupIterations; iteration += 1) compileSceneRecipe(recipe);
    const started = performance.now();
    let plan = compileSceneRecipe(recipe);
    for (let iteration = 1; iteration < C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT.measuredIterations; iteration += 1) plan = compileSceneRecipe(recipe);
    const elapsedMs = performance.now() - started;
    const deterministic = {
      id: benchmarkCase.id,
      count: benchmarkCase.count,
      geometry: benchmarkCase.geometry,
      recipeBytes: Buffer.byteLength(canonicalJson(recipe), "utf8"),
      planBytes: plan.budget.planBytes,
      geometrySha256: plan.resources.geometry[0]!.geometrySha256,
      recipeSha256: plan.recipeSha256,
      planFingerprint: plan.fingerprint,
      uniqueGeometryBytes: plan.budget.uniqueGeometryBytes,
      expandedGeometryBytes: plan.budget.expandedGeometryBytes,
      geometryExpansionRatio: rounded(plan.budget.expandedGeometryBytes / plan.budget.uniqueGeometryBytes),
      stateSampleCount: plan.budget.stateSampleCount,
    };
    return Object.freeze({
      ...deterministic,
      totalCompileMs: rounded(elapsedMs),
      meanCompileMs: rounded(elapsedMs / C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT.measuredIterations),
      deterministicFingerprint: canonicalJsonSha256(deterministic),
    });
  });
  const deterministicFingerprint = canonicalJsonSha256({
    contract: C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT,
    results: results.map(({ totalCompileMs: _total, meanCompileMs: _mean, ...result }) => result),
  });
  return Object.freeze({
    schema: C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT.schema,
    environment: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    contract: C7A_SCENE_RESOURCE_BENCHMARK_CONTRACT,
    results: Object.freeze(results),
    deterministicFingerprint,
  });
}

function buildRecipe(geometry: "sphere" | "box", count: number): any {
  const entities = Array.from({ length: count }, (_entry, index) => ({ id: `item-${String(index).padStart(3, "0")}`, geometryRef: "shared-geometry", materialRef: index % 2 === 0 ? "material-a" : "material-b" }));
  const columns = Math.ceil(Math.sqrt(count));
  const states = (offset: number) => entities.map((entity, index) => ({ entityId: entity.id, position: [index % columns + offset, Math.floor(index / columns), 0], rotationDeg: [0, offset * 30, 0], scale: 1 }));
  return {
    schema: SCENE_RECIPE_SCHEMA,
    units: { length: "meter", angle: "degree", time: "microsecond", upAxis: "y", forwardAxis: "-z" },
    resources: {
      geometry: [geometry === "sphere"
        ? { id: "shared-geometry", kind: "sphere", radius: 0.25, quality: "cinematic" }
        : { id: "shared-geometry", kind: "box", size: [1.2, 0.45, 0.5] }],
      materials: [
        { id: "material-a", kind: "basic", baseColor: "#ef4444", emissive: 0 },
        { id: "material-b", kind: "basic", baseColor: "#f59e0b", emissive: 0 },
      ],
    },
    shots: [{
      schema: DIRECTED_SHOT_SCHEMA,
      id: "benchmark-shot",
      startUs: 0,
      endUs: 1_000_000,
      entities,
      generators: [],
      checkpoints: [
        { id: "start", atUs: 0, states: states(0), generatedStates: [] },
        { id: "end", atUs: 1_000_000, states: states(0.5), generatedStates: [] },
      ],
      presentation: {
        camera: { position: [0, 1, 6], target: [0, 0, 0], fovDeg: 40, near: 0.1, far: 100 },
        lighting: { ambient: 0.3, direction: [-0.4, -0.8, -0.5], intensity: 1.2, color: "#ffffff" },
        backgroundColor: "#050816",
      },
    }],
  };
}

function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(runC7aSceneResourceBenchmark(), null, 2)}\n`);
