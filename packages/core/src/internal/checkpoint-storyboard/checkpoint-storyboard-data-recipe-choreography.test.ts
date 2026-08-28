import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { admitCheckpointStoryboardScalarSpatialRecordProfile } from "./checkpoint-storyboard-scalar-spatial";
import {
  compileDataRecipeChoreography,
  isDataRecipeChoreographyStoryboard,
} from "./checkpoint-storyboard-data-recipe-choreography-compile";
import { readDataRecipeChoreographyDescriptor } from "./checkpoint-storyboard-data-recipe-choreography-read";
import {
  DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
  DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
  DATA_RECIPE_CHOREOGRAPHY_LIMITS,
  DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
} from "./checkpoint-storyboard-data-recipe-choreography-types";

function descriptor(): any {
  return {
    schema: DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
    storyboardSeed: 17,
    requiredCapability: "renderer.browser",
    objects: [
      { objectId: "orb-a", rootShapeKind: "ellipse", orbitRadius: 100, phaseTurnsQ1024: 0 },
      { objectId: "orb-b", rootShapeKind: "rect", orbitRadius: 160, phaseTurnsQ1024: 341 },
      { objectId: "orb-c", rootShapeKind: "ellipse", orbitRadius: 220, phaseTurnsQ1024: 682 },
    ],
    checkpoints: [
      { atUs: 0, orbitTurnsQ1024: 0, radiusScaleQ1024: 1_024, scaleQ1024: 1_024, opacityQ1024: 1_024 },
      { atUs: 1_000_000, orbitTurnsQ1024: 256, radiusScaleQ1024: 1_024, scaleQ1024: 768, opacityQ1024: 768 },
      { atUs: 2_000_000, orbitTurnsQ1024: 512, radiusScaleQ1024: 512, scaleQ1024: 1_280, opacityQ1024: 512 },
      { atUs: 3_000_000, orbitTurnsQ1024: 1_024, radiusScaleQ1024: 1_024, scaleQ1024: 1_024, opacityQ1024: 1_024 },
    ],
    recipe: {
      seed: 23,
      formulaId: DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
      actionId: DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
      parameters: { centerX: 320, centerY: 180, spatialTangentMode: "auto", scalarEasing: "ease-in-out" },
      limits: { ...DATA_RECIPE_CHOREOGRAPHY_LIMITS },
    },
  };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe("private C6D multi-checkpoint choreography recipe", () => {
  it("detaches and deterministically lowers several objects and checkpoints into ordinary B1 data", () => {
    const input = descriptor(), before = canonicalJson(input);
    const read = readDataRecipeChoreographyDescriptor(input);
    const report = compileDataRecipeChoreography(input);
    expect(canonicalJson(input)).toBe(before);
    expect(read).toEqual(input);
    expect(compileDataRecipeChoreography(clone(input))).toEqual(report);
    expect(report).toMatchObject({
      formulaId: DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
      actionId: DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
      c6aPlan: { budget: { checkpointCount: 4, objectStateCount: 12, edgeCount: 3, recipeCount: 6 } },
      evidence: { c6b1ScalarSpatialAdmitted: true, exactFixedCaps: true, codeOwnedFormula: true, noIO: true, noStore: true, noRenderer: true, noPublicCoreRoot: true },
    });
    expect(report.sha256).toBe(report.fingerprint);
    expect(report.storyboard.capabilityRequirements).toEqual(["renderer.browser"]);
    expect(report.storyboard.objectCatalog.map((object) => object.objectId)).toEqual(["orb-a", "orb-b", "orb-c"]);
    expect(report.storyboard.checkpoints).toHaveLength(4);
    expect(report.storyboard.edges).toHaveLength(3);
    expect(report.storyboard.recipes.map((recipe) => recipe.recipeId)).toEqual([
      "data-recipe-orbit-00-scalar", "data-recipe-orbit-00-spatial",
      "data-recipe-orbit-01-scalar", "data-recipe-orbit-01-spatial",
      "data-recipe-orbit-02-scalar", "data-recipe-orbit-02-spatial",
    ]);
    expect(admitCheckpointStoryboardScalarSpatialRecordProfile(report.storyboard)).toEqual(report.storyboard);
    expect(isDataRecipeChoreographyStoryboard(report.storyboard)).toBe(true);
    expect(Object.isFrozen(report.storyboard.checkpoints[0]!.objects)).toBe(true);
  });

  it("evaluates the closed orbit formula at every explicit checkpoint", () => {
    const report = compileDataRecipeChoreography(descriptor());
    const values = (checkpointIndex: number) => Object.fromEntries(report.storyboard.checkpoints[checkpointIndex]!.objects[0]!.properties.map((entry) => [entry.property, entry.value]));
    expect(values(0)).toEqual({ "transform.x": 420, "transform.y": 180, "transform.rotation": 0, "transform.scale": 1, opacity: 1 });
    expect(values(1)).toEqual({ "transform.x": 320, "transform.y": 280, "transform.rotation": 90, "transform.scale": 0.75, opacity: 0.75 });
    expect(values(2)).toEqual({ "transform.x": 270, "transform.y": 180, "transform.rotation": 180, "transform.scale": 1.25, opacity: 0.5 });
    expect(values(3)).toEqual({ "transform.x": 420, "transform.y": 180, "transform.rotation": 360, "transform.scale": 1, opacity: 1 });
    for (const checkpoint of report.storyboard.checkpoints) for (const object of checkpoint.objects) {
      expect(object.state).toBe("present");
      expect(object.properties.map((entry) => entry.property)).toEqual(["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"]);
    }
  });

  it("revises values inside one exact object/checkpoint topology and refuses topology changes", () => {
    const first = compileDataRecipeChoreography(descriptor());
    const next = descriptor();
    next.storyboardSeed = 99;
    next.recipe.seed = 100;
    next.recipe.parameters = { ...next.recipe.parameters, centerX: 400, spatialTangentMode: "linear", scalarEasing: "linear" };
    next.objects = next.objects.map((object: any, index: number) => ({ ...object, orbitRadius: object.orbitRadius + index + 1, phaseTurnsQ1024: object.phaseTurnsQ1024 + 1 }));
    next.checkpoints[1] = { ...next.checkpoints[1], atUs: 1_250_000, orbitTurnsQ1024: 300 };
    const revised = compileDataRecipeChoreography(next, first.storyboard);
    expect(revised.storyboard.revision).toBe(2);
    expect(revised.storyboard.parentRevision).toEqual({ id: first.storyboard.id, sha256: first.storyboard.sha256 });
    expect(revised.storyboard.recipes.every((recipe) => recipe.revision === 2 && recipe.parentRevision)).toBe(true);
    expect(revised.lineage.transitionRecipes).toHaveLength(6);

    const fewerObjects = descriptor(); fewerObjects.objects.pop();
    expect(() => compileDataRecipeChoreography(fewerObjects, first.storyboard)).toThrow("topology");
    const fewerCheckpoints = descriptor(); fewerCheckpoints.checkpoints.pop();
    expect(() => compileDataRecipeChoreography(fewerCheckpoints, first.storyboard)).toThrow("topology");
    const renamed = descriptor(); renamed.objects[0].objectId = "orb-0";
    expect(() => compileDataRecipeChoreography(renamed, first.storyboard)).toThrow("object catalog");
  });

  it("enforces closed fields, order, bounds, millisecond time, literal formula/action, and fixed limits", () => {
    for (const [label, mutate] of [
      ["objects minimum", (draft: any) => { draft.objects.length = 1; }],
      ["objects order", (draft: any) => { draft.objects.reverse(); }],
      ["shape", (draft: any) => { draft.objects[0].rootShapeKind = "path"; }],
      ["radius", (draft: any) => { draft.objects[0].orbitRadius = 0; }],
      ["phase", (draft: any) => { draft.objects[0].phaseTurnsQ1024 = 1_024; }],
      ["checkpoints minimum", (draft: any) => { draft.checkpoints.length = 2; }],
      ["first time", (draft: any) => { draft.checkpoints[0].atUs = 1_000; }],
      ["time order", (draft: any) => { draft.checkpoints[2].atUs = draft.checkpoints[1].atUs; }],
      ["time resolution", (draft: any) => { draft.checkpoints[1].atUs += 1; }],
      ["turns", (draft: any) => { draft.checkpoints[1].orbitTurnsQ1024 = 16_385; }],
      ["radius scale", (draft: any) => { draft.checkpoints[1].radiusScaleQ1024 = 0; }],
      ["scale", (draft: any) => { draft.checkpoints[1].scaleQ1024 = 1; }],
      ["opacity", (draft: any) => { draft.checkpoints[1].opacityQ1024 = 1_025; }],
      ["extent", (draft: any) => { draft.recipe.parameters.centerX = 1_000_000; }],
      ["tangent", (draft: any) => { draft.recipe.parameters.spatialTangentMode = "broken"; }],
      ["easing", (draft: any) => { draft.recipe.parameters.scalarEasing = "spring"; }],
      ["formula", (draft: any) => { draft.recipe.formulaId = "formula.callback@1"; }],
      ["action", (draft: any) => { draft.recipe.actionId = "transform.script@1"; }],
      ["limits", (draft: any) => { draft.recipe.limits.maxObjects = 9; }],
      ["script", (draft: any) => { draft.recipe.parameters.script = "return process.env"; }],
    ] as const) {
      const draft = descriptor(); mutate(draft);
      expect(() => readDataRecipeChoreographyDescriptor(draft), label).toThrow();
    }
    const signedZero = descriptor(); signedZero.storyboardSeed = -0; signedZero.recipe.seed = -0; signedZero.checkpoints[0].orbitTurnsQ1024 = -0;
    const normalized = readDataRecipeChoreographyDescriptor(signedZero);
    expect(Object.is(normalized.storyboardSeed, -0)).toBe(false);
    expect(Object.is(normalized.recipe.seed, -0)).toBe(false);
    expect(Object.is(normalized.checkpoints[0]!.orbitTurnsQ1024, -0)).toBe(false);
  });
});
