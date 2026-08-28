import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { compileSceneRecipe } from "./scene-recipe-compile";
import { readSceneRecipe } from "./scene-recipe-read";
import { DIRECTED_SHOT_SCHEMA, SCENE_RECIPE_SCHEMA, WALL_GENERATOR_SCHEMA } from "./scene-recipe-types";

describe("C7A private scene resource and directed-shot recipe", () => {
  it("compiles shared analytic geometry and materials once for repeated directed instances", () => {
    const recipe = fixture(10);
    const first = compileSceneRecipe(recipe), second = compileSceneRecipe(structuredClone(recipe));
    expect(second).toEqual(first);
    expect(first.recipeSha256).toBe(second.recipeSha256);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.resources.geometry.map((resource) => [resource.id, resource.vertexCount, resource.indexCount])).toEqual([
      ["ball", 362, 2_160],
      ["floor", 24, 36],
    ]);
    expect(first.budget).toMatchObject({
      geometryResourceCount: 2,
      materialResourceCount: 2,
      shotCount: 1,
      entityInstanceCount: 11,
      checkpointCount: 2,
      stateSampleCount: 22,
      reusedGeometryInstanceCount: 9,
    });
    expect(first.budget.expandedGeometryBytes).toBeGreaterThan(first.budget.uniqueGeometryBytes * 4);
    const { fingerprint: _fingerprint, ...payload } = first;
    expect(first.budget.planBytes).toBe(Buffer.byteLength(canonicalJson(payload), "utf8"));
    expect(first.evidence).toEqual({
      directedShotsOnly: true,
      strictShotUnion: true,
      sharedGeometryResources: true,
      sharedMaterialResources: true,
      exactCheckpointStates: true,
      generatedTopology: true,
      generatedMaterialAssignment: true,
      physicsFieldsAccepted: false,
      rendererInvoked: false,
      packageRead: false,
      packageWritten: false,
      providerSelected: false,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.resources.geometry[0]!.geometry.positions)).toBe(true);
  });

  it("keeps shot timeline order independent from ids while requiring non-overlap", () => {
    const first = fixture(1).shots[0]!;
    const second = { ...structuredClone(first), id: "a-second", startUs: 2_000_000, endUs: 3_000_000, checkpoints: first.checkpoints.map((checkpoint: any, index: number) => ({ ...checkpoint, id: index === 0 ? "later-start" : "later-end", atUs: index === 0 ? 2_000_000 : 3_000_000 })) };
    const recipe = fixture(1); recipe.shots = [{ ...first, id: "z-first" }, second];
    expect(readSceneRecipe(recipe).shots.map((shot) => shot.id)).toEqual(["z-first", "a-second"]);
    expect(() => readSceneRecipe({ ...recipe, shots: [first, { ...second, startUs: 999_999, checkpoints: second.checkpoints.map((checkpoint: any, index: number) => ({ ...checkpoint, atUs: index === 0 ? 999_999 : checkpoint.atUs })) }] })).toThrow("ordered non-overlapping intervals");
  });

  it("refuses simulated or mixed-category fields in the directed shot union", () => {
    const recipe = fixture(1), shot = recipe.shots[0]!;
    expect(() => readSceneRecipe({ ...recipe, shots: [{ ...shot, schema: "shellx-motion/simulated-shot@1", physics: { gravity: [0, -9.81, 0] } }] })).toThrow("unknown field 'physics'");
    expect(() => readSceneRecipe({ ...recipe, shots: [{ ...shot, physics: { gravity: [0, -9.81, 0] } }] })).toThrow("unknown field 'physics'");
  });

  it("refuses unknown resources, incomplete state order, and excess aggregate samples", () => {
    const recipe = fixture(1), shot = recipe.shots[0]!;
    expect(() => readSceneRecipe({ ...recipe, shots: [{ ...shot, entities: [{ ...shot.entities[0], geometryRef: "missing" }] }] })).toThrow("does not identify a declared geometry resource");
    expect(() => readSceneRecipe({ ...recipe, shots: [{ ...shot, checkpoints: shot.checkpoints.map((checkpoint: any) => ({ ...checkpoint, states: checkpoint.states.map((state: any, index: number) => index === 0 ? { ...state, entityId: "wrong" } : state) })) }] })).toThrow("must match the shot entity order exactly");
    const large = fixture(255), baseCheckpoints = large.shots[0]!.checkpoints;
    large.shots[0]!.checkpoints = Array.from({ length: 16 }, (_entry, index) => ({ ...structuredClone(baseCheckpoints[index === 15 ? 1 : 0]!), id: `cp-${String(index).padStart(2, "0")}`, atUs: Math.round(1_000_000 * index / 15) }));
    expect(compileSceneRecipe(large).budget.stateSampleCount).toBe(4_096);
    const smallShot = fixture(0).shots[0]!;
    large.shots.push({ ...smallShot, id: "second", startUs: 1_000_000, endUs: 2_000_000, checkpoints: smallShot.checkpoints.map((checkpoint: any) => ({ ...checkpoint, atUs: checkpoint.atUs + 1_000_000 })) });
    expect(() => compileSceneRecipe(large)).toThrow("4096-state-sample cap");
  });

  it("refuses hostile accessors before semantic reads", () => {
    let reads = 0;
    const recipe = fixture(1);
    Object.defineProperty(recipe, "resources", { enumerable: true, get() { reads += 1; return {}; } });
    expect(() => readSceneRecipe(recipe)).toThrow("must be an enumerable data field");
    expect(reads).toBe(0);
  });

  it("binds sphere quality to three deterministic mesh budgets", () => {
    const expected = { preview: [86, 504], balanced: [362, 2_160], cinematic: [830, 4_968] } as const;
    for (const [quality, counts] of Object.entries(expected)) {
      const recipe = fixture(1); recipe.resources.geometry[0] = { id: "ball", kind: "sphere", radius: 0.2, quality };
      const resource = compileSceneRecipe(recipe).resources.geometry[0]!;
      expect([resource.vertexCount, resource.indexCount]).toEqual(counts);
      expect([...resource.geometry.positions, ...resource.geometry.normals].every((value) => Math.fround(value) === value && !Object.is(value, -0))).toBe(true);
    }
  });

  it("expands variable wall topology and material patterns from recipe data", () => {
    const fifteen = compileSceneRecipe(wallFixture(3, 5, "cycle"));
    expect(fifteen.shots[0]!.entities).toHaveLength(15);
    expect(fifteen.shots[0]!.entities.slice(0, 6).map((entity) => [entity.id, entity.materialRef])).toEqual([
      ["wall.r00.c00", "white"],
      ["wall.r00.c01", "blue"],
      ["wall.r00.c02", "amber"],
      ["wall.r00.c03", "white"],
      ["wall.r00.c04", "blue"],
      ["wall.r01.c00", "amber"],
    ]);
    expect(fifteen.shots[0]!.checkpoints[0]!.states[0]!.position).toEqual([-2.559999942779541, 0.25, 0]);
    expect(fifteen.shots[0]!.checkpoints[0]!.states[5]!.position).toEqual([-1.9199999570846558, 0.75, 0]);
    expect(fifteen.shots[0]!.checkpoints[1]!.states[0]!.position[0]).toBeCloseTo(0.5, 6);
    expect(fifteen.shots[0]!.checkpoints[1]!.states[0]!.position[1]).toBeCloseTo(-3.12, 6);
    expect(fifteen.budget).toMatchObject({ generatorCount: 1, generatedEntityInstanceCount: 15, entityInstanceCount: 15, stateSampleCount: 30 });
    const rowCycle = compileSceneRecipe(wallFixture(5, 9, "row-cycle"));
    expect(rowCycle.budget.generatedEntityInstanceCount).toBe(45);
    expect(rowCycle.shots[0]!.entities.slice(0, 10).map((entity) => entity.materialRef)).toEqual([...Array(9).fill("white"), "blue"]);
    expect(compileSceneRecipe(wallFixture(9, 15, "cycle")).budget.generatedEntityInstanceCount).toBe(135);
  });

  it("refuses generator over-expansion, collisions, non-box geometry, and undeclared palette refs", () => {
    const excessive = wallFixture(64, 64, "cycle");
    expect(() => compileSceneRecipe(excessive)).toThrow("generated-entity cap");
    const collision = wallFixture(3, 5, "cycle");
    collision.shots[0]!.entities = [{ id: "wall.r00.c00", geometryRef: "brick", materialRef: "white" }];
    collision.shots[0]!.checkpoints.forEach((checkpoint: any) => checkpoint.states = [{ entityId: "wall.r00.c00", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 }]);
    expect(() => compileSceneRecipe(collision)).toThrow("explicit and generated entity ids");
    const sphere = wallFixture(3, 5, "cycle");
    sphere.resources.geometry[0] = { id: "brick", kind: "sphere", radius: 0.5, quality: "preview" };
    expect(() => compileSceneRecipe(sphere)).toThrow("must identify box geometry");
    const missing = wallFixture(3, 5, "cycle");
    missing.shots[0]!.generators[0]!.materialPattern.materialRefs = ["missing"];
    expect(() => compileSceneRecipe(missing)).toThrow("undeclared material 'missing'");
    const spatial = wallFixture(1, 3, "cycle");
    spatial.resources.geometry[0].size = [1_000, 1, 1];
    expect(() => compileSceneRecipe(spatial)).toThrow("position exceeds the -1000..1000 scene bound");
  });

  it("keeps the packed-private C7A compiler outside renderer, provider, process, path, and I/O authority", () => {
    const publicRoot = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    const sources = ["scene-recipe-types.ts", "scene-recipe-data.ts", "scene-recipe-read.ts", "scene-recipe-wall.ts", "scene-recipe-compile.ts", "gltf-object-plan-types.ts", "gltf-object-plan.ts", "gltf-object-story-types.ts", "gltf-object-story.ts", "gltf-object-retained-render-authority.ts", "gltf-object-retained-render-types.ts", "gltf-object-retained-render.ts", "physics-bake-admission-types.ts", "physics-bake-admission-read.ts", "physics-bake-admission.ts", "scene-recipe.ts"]
      .map((name) => readFileSync(new URL(name, import.meta.url), "utf8")).join("\n");
    expect(publicRoot).not.toContain("scene-recipe");
    expect(manifest.exports["./internal/scene-recipe"]).toBe("./src/internal/scene-recipe/scene-recipe.ts");
    expect(manifest.publishConfig.exports["./internal/scene-recipe"]).toEqual({ types: "./dist/internal/scene-recipe/scene-recipe.d.ts", default: "./dist/internal/scene-recipe/scene-recipe.js" });
    expect(sources).not.toMatch(/(?:node:fs|node:child_process|packages\/(?:connectors|renderer)|sourcePackageRoot|fetch\(|process\.)/u);
  });
});

function fixture(ballCount: number): any {
  const entities = [
    ...Array.from({ length: ballCount }, (_entry, index) => ({ id: `ball-${String(index).padStart(3, "0")}`, geometryRef: "ball", materialRef: index % 2 === 0 ? "blue" : "white" })),
    { id: "floor", geometryRef: "floor", materialRef: "white" },
  ].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const states = (offset: number) => entities.map((entity, index) => ({ entityId: entity.id, position: [index * 0.25 + offset, entity.id === "floor" ? -1 : 0, 0], rotationDeg: [0, offset * 45, 0], scale: 1 }));
  return {
    schema: SCENE_RECIPE_SCHEMA,
    units: { length: "meter", angle: "degree", time: "microsecond", upAxis: "y", forwardAxis: "-z" },
    resources: {
      geometry: [
        { id: "ball", kind: "sphere", radius: 0.2, quality: "balanced" },
        { id: "floor", kind: "box", size: [10, 0.2, 10] },
      ],
      materials: [
        { id: "blue", kind: "basic", baseColor: "#38BDF8", emissive: 0.1 },
        { id: "white", kind: "basic", baseColor: "#FFFFFF", emissive: 0 },
      ],
    },
    shots: [{
      schema: DIRECTED_SHOT_SCHEMA,
      id: "directed-balls",
      startUs: 0,
      endUs: 1_000_000,
      entities,
      generators: [],
      checkpoints: [
        { id: "start", atUs: 0, states: states(0), generatedStates: [] },
        { id: "end", atUs: 1_000_000, states: states(1), generatedStates: [] },
      ],
      presentation: {
        camera: { position: [0, 1, 6], target: [0, 0, 0], fovDeg: 40, near: 0.1, far: 100 },
        lighting: { ambient: 0.3, direction: [-0.4, -0.8, -0.5], intensity: 1.2, color: "#FFFFFF" },
        backgroundColor: "#050816",
      },
    }],
  };
}

function wallFixture(rows: number, columns: number, materialKind: "cycle" | "row-cycle"): any {
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
        rows,
        columns,
        bond: "running",
        gap: [0.08, 0.05],
        origin: [0, 0.25, 0],
        materialPattern: { kind: materialKind, materialRefs: ["white", "blue", "amber"] },
      }],
      checkpoints: [
        { id: "start", atUs: 0, states: [], generatedStates: [{ generatorId: "wall", translation: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 }] },
        { id: "end", atUs: 1_000_000, states: [], generatedStates: [{ generatorId: "wall", translation: [1, 2, 0], rotationDeg: [0, 0, 90], scale: 2 }] },
      ],
      presentation: {
        camera: { position: [0, 2, 12], target: [0, 2, 0], fovDeg: 40, near: 0.1, far: 100 },
        lighting: { ambient: 0.3, direction: [-0.4, -0.8, -0.5], intensity: 1.2, color: "#ffffff" },
        backgroundColor: "#050816",
      },
    }],
  };
}
