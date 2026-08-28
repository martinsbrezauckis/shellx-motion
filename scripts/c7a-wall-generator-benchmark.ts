import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { canonicalJson, canonicalJsonSha256 } from "../packages/core/src/canonical-json";
import { compileSceneRecipe } from "../packages/core/src/internal/scene-recipe/scene-recipe-compile";
import { DIRECTED_SHOT_SCHEMA, SCENE_RECIPE_SCHEMA, WALL_GENERATOR_SCHEMA } from "../packages/core/src/internal/scene-recipe/scene-recipe-types";

export const C7A_WALL_GENERATOR_BENCHMARK_CONTRACT = Object.freeze({
  schema: "shellx-motion/c7a-wall-generator-benchmark@1",
  warmupIterations: 10,
  measuredIterations: 100,
  cases: Object.freeze([
    Object.freeze({ id: "wall-15", rows: 3, columns: 5, bond: "running" as const, pattern: "cycle" as const }),
    Object.freeze({ id: "wall-45", rows: 5, columns: 9, bond: "running" as const, pattern: "row-cycle" as const }),
    Object.freeze({ id: "wall-135", rows: 9, columns: 15, bond: "stack" as const, pattern: "cycle" as const }),
  ]),
});

export function runC7aWallGeneratorBenchmark() {
  const results = C7A_WALL_GENERATOR_BENCHMARK_CONTRACT.cases.map((benchmarkCase) => {
    const recipe = buildWallRecipe(benchmarkCase);
    for (let iteration = 0; iteration < C7A_WALL_GENERATOR_BENCHMARK_CONTRACT.warmupIterations; iteration += 1) compileSceneRecipe(recipe);
    const started = performance.now();
    let plan = compileSceneRecipe(recipe);
    for (let iteration = 1; iteration < C7A_WALL_GENERATOR_BENCHMARK_CONTRACT.measuredIterations; iteration += 1) plan = compileSceneRecipe(recipe);
    const elapsedMs = performance.now() - started;
    const shot = plan.shots[0]!;
    const deterministic = {
      id: benchmarkCase.id,
      rows: benchmarkCase.rows,
      columns: benchmarkCase.columns,
      entityCount: shot.entities.length,
      recipeBytes: Buffer.byteLength(canonicalJson(recipe), "utf8"),
      planBytes: plan.budget.planBytes,
      uniqueGeometryBytes: plan.budget.uniqueGeometryBytes,
      expandedGeometryBytes: plan.budget.expandedGeometryBytes,
      generatorFingerprint: shot.generatorFingerprint,
      entityOrderSha256: shot.entityOrderSha256,
      materialAssignmentSha256: canonicalJsonSha256(shot.entities.map((entity) => [entity.id, entity.materialRef])),
      checkpointStateSha256: shot.checkpointStateSha256,
      planFingerprint: plan.fingerprint,
    };
    return Object.freeze({
      ...deterministic,
      totalCompileMs: rounded(elapsedMs),
      meanCompileMs: rounded(elapsedMs / C7A_WALL_GENERATOR_BENCHMARK_CONTRACT.measuredIterations),
      deterministicFingerprint: canonicalJsonSha256(deterministic),
    });
  });
  return Object.freeze({
    schema: C7A_WALL_GENERATOR_BENCHMARK_CONTRACT.schema,
    environment: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    contract: C7A_WALL_GENERATOR_BENCHMARK_CONTRACT,
    results: Object.freeze(results),
    deterministicFingerprint: canonicalJsonSha256({
      contract: C7A_WALL_GENERATOR_BENCHMARK_CONTRACT,
      results: results.map(({ totalCompileMs: _total, meanCompileMs: _mean, ...result }) => result),
    }),
  });
}

function buildWallRecipe(config: (typeof C7A_WALL_GENERATOR_BENCHMARK_CONTRACT.cases)[number]): any {
  return {
    schema: SCENE_RECIPE_SCHEMA,
    units: { length: "meter", angle: "degree", time: "microsecond", upAxis: "y", forwardAxis: "-z" },
    resources: {
      geometry: [{ id: "brick", kind: "box", size: [1.2, 0.45, 0.5] }],
      materials: [
        { id: "amber", kind: "basic", baseColor: "#f59e0b", emissive: 0 },
        { id: "blue", kind: "basic", baseColor: "#38bdf8", emissive: 0.05 },
        { id: "white", kind: "basic", baseColor: "#ffffff", emissive: 0 },
      ],
    },
    shots: [{
      schema: DIRECTED_SHOT_SCHEMA,
      id: "generated-wall",
      startUs: 0,
      endUs: 1_000_000,
      entities: [],
      generators: [{
        schema: WALL_GENERATOR_SCHEMA,
        id: "wall",
        geometryRef: "brick",
        rows: config.rows,
        columns: config.columns,
        bond: config.bond,
        gap: [0.08, 0.05],
        origin: [0, 0.25, 0],
        materialPattern: { kind: config.pattern, materialRefs: ["white", "blue", "amber"] },
      }],
      checkpoints: [
        { id: "start", atUs: 0, states: [], generatedStates: [{ generatorId: "wall", translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 }] },
        { id: "end", atUs: 1_000_000, states: [], generatedStates: [{ generatorId: "wall", translation: [1, 2, 0], rotationDeg: [0, 0, 15], scale: 1.1 }] },
      ],
      presentation: {
        camera: { position: [0, 3, 18], target: [0, 3, 0], fovDeg: 40, near: 0.1, far: 100 },
        lighting: { ambient: 0.3, direction: [-0.4, -0.8, -0.5], intensity: 1.2, color: "#ffffff" },
        backgroundColor: "#050816",
      },
    }],
  };
}

function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(runC7aWallGeneratorBenchmark(), null, 2)}\n`);
