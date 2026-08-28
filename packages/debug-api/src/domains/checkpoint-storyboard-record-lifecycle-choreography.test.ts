import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileDataRecipeChoreography,
  DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
  DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
  DATA_RECIPE_CHOREOGRAPHY_LIMITS,
  DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
  DATA_RECIPE_CHECKPOINT_ACTION_ID,
  DATA_RECIPE_CHECKPOINT_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_LIMITS,
  DATA_RECIPE_CHECKPOINT_SCHEMA,
} from "@shellx-motion/core/internal/checkpoint-storyboard-data-recipe";
import { CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA } from "../command-metadata-checkpoint-storyboard.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS, dispatchCheckpointStoryboardRecordLifecycleCommand } from "./checkpoint-storyboard-record-lifecycle.js";
import { configureCheckpointStoryboardRecordStore, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function choreographyDescriptor(storyboardSeed = 17, recipeSeed = 23): any {
  return {
    schema: DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
    storyboardSeed,
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
      seed: recipeSeed,
      formulaId: DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
      actionId: DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
      parameters: { centerX: 320, centerY: 180, spatialTangentMode: "auto", scalarEasing: "ease-in-out" },
      limits: { ...DATA_RECIPE_CHOREOGRAPHY_LIMITS },
    },
  };
}
function traceDescriptor(): any {
  return {
    schema: DATA_RECIPE_CHECKPOINT_SCHEMA,
    storyboardSeed: 41,
    requiredCapability: "renderer.gpu",
    target: { objectId: "trace", rootShapeKind: "rect" },
    checkpoints: [{ atUs: 0, state: "present", opacity: 0.75 }, { atUs: 63_000, state: "present", opacity: 0.75 }],
    recipe: {
      seed: 42,
      formulaId: DATA_RECIPE_CHECKPOINT_FORMULA_ID,
      actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID,
      parameters: { centerX: 0, centerY: 0, amplitudeX: 120, amplitudeY: 80, frequencyX: 3, frequencyY: 2, phaseTurnsQ1024: 128, sampleCount: 64, strokeWidth: 2, strokeOpacity: 0.75, luma: 0.5, speedLimit: 10_000 },
      limits: { ...DATA_RECIPE_CHECKPOINT_LIMITS },
    },
  };
}
function rawB1(seed = 51): any {
  return {
    seed,
    capabilityRequirements: ["renderer.browser"],
    objectCatalog: [{ objectId: "raw", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [rawCheckpoint("start", 0, 0), rawCheckpoint("finish", 1_000_000, 100)],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "raw" }], recipeIds: ["scalar", "spatial"] }],
    recipes: [
      { recipeId: "scalar", seed: 52, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "linear", targets: [{ objectId: "raw", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } },
      { recipeId: "spatial", seed: 53, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "raw", tangentMode: "linear" }] } },
    ],
  };
}
function rawCheckpoint(id: string, atUs: number, x: number) {
  return { id, atUs, objects: [{ objectId: "raw", state: "present", properties: [
    { property: "transform.x", value: x }, { property: "transform.y", value: 0 }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 },
  ] }] };
}
async function host() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6d-choreography-"));
  roots.push(root);
  return { root, authority: await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 19) }) };
}
async function call(command: string, args: unknown, authority: CheckpointStoryboardRecordStoreAuthority) {
  return await dispatchCheckpointStoryboardRecordLifecycleCommand(command as never, args, { checkpointStoryboardRecordStore: authority });
}
function succeeded(result: Awaited<ReturnType<typeof call>>) {
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new Error("Expected success.");
  return result.result as { readonly record: { readonly identity: { readonly id: string; readonly sha256: string; readonly revision: number }; readonly storyboard: any; readonly admission: Record<string, unknown> }; readonly replay?: string };
}

describe("C6D multi-object/multi-checkpoint choreography lifecycle", () => {
  it("uses the existing B1 record path for deterministic create, replay, revise, and inspect", async () => {
    const { authority } = await host();
    const descriptor = choreographyDescriptor();
    const expected = compileDataRecipeChoreography(descriptor);
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor }, authority));
    expect(created.record.admission).toEqual({ staticProfileAdmitted: true });
    expect(created.record.storyboard).toEqual(expected.storyboard);
    expect(created).not.toHaveProperty("report");
    expect(created).not.toHaveProperty("descriptor");
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor }, authority))).toMatchObject({ replay: "same-input", record: { identity: created.record.identity } });

    const next = choreographyDescriptor(27, 29);
    next.recipe.parameters.centerX = 400;
    next.checkpoints[1].orbitTurnsQ1024 = 300;
    const nextExpected = compileDataRecipeChoreography(next, expected.storyboard);
    const revised = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: next }, authority));
    expect(revised.record).toMatchObject({ admission: { staticProfileAdmitted: true }, storyboard: { parentRevision: { id: created.record.identity.id, sha256: created.record.identity.sha256 } } });
    expect(revised.record.storyboard).toEqual(nextExpected.storyboard);
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: revised.record.identity }, authority)).record).toEqual(revised.record);
  });

  it("keeps choreography, named trace, and ordinary B1 lineages mutually closed", async () => {
    const { authority } = await host();
    const choreography = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: choreographyDescriptor() }, authority));
    const trace = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: traceDescriptor() }, authority));
    const ordinary = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: rawB1() }, authority));
    for (const [parent, descriptor] of [
      [choreography.record.identity, traceDescriptor()],
      [trace.record.identity, choreographyDescriptor()],
      [choreography.record.identity, rawB1(61)],
      [trace.record.identity, rawTrace(trace.record.storyboard)],
      [ordinary.record.identity, choreographyDescriptor()],
    ] as const) {
      await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
    }
  });

  it("refuses malformed choreography before reopening the parent store", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: choreographyDescriptor() }, authority));
    const records = join(root, ".shellx-motion-c6c-record-store", "records");
    await rename(records, `${records}-replaced`);
    await mkdir(records, { mode: 0o700 });
    const malformed = choreographyDescriptor(31, 32);
    malformed.recipe.parameters.script = "return globalThis";
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: malformed }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
    expect(await readFile(join(`${records}-replaced`, `${created.record.identity.id}.json`), "utf8")).toContain(created.record.identity.sha256);
  });

  it("publishes one closed formula-specific Debug schema alternative", () => {
    const descriptor = CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create].argsSchema.properties.descriptor!;
    const choreography = descriptor.oneOf!.find((candidate) => candidate.properties?.schema?.enum?.[0] === DATA_RECIPE_CHOREOGRAPHY_SCHEMA)!;
    expect(choreography).toMatchObject({ type: "object", additionalProperties: false, required: ["schema", "storyboardSeed", "requiredCapability", "objects", "checkpoints", "recipe"], properties: {
      requiredCapability: { enum: ["renderer.browser"] },
      objects: { type: "array", minItems: 2, maxItems: 8, items: { additionalProperties: false } },
      checkpoints: { type: "array", minItems: 3, maxItems: 8, items: { additionalProperties: false, properties: { atUs: { multipleOf: 1_000 } } } },
      recipe: { additionalProperties: false, properties: { formulaId: { enum: [DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID] }, actionId: { enum: [DATA_RECIPE_CHOREOGRAPHY_ACTION_ID] }, parameters: { additionalProperties: false }, limits: { additionalProperties: false } } },
    } });
    expect(Object.keys(choreography.properties!).sort()).toEqual(["checkpoints", "objects", "recipe", "requiredCapability", "schema", "storyboardSeed"]);
    for (const forbidden of ["expression", "graph", "node", "script", "callback", "path", "url", "asset", "renderer", "package", "store", "output"]) {
      expect(choreography.properties).not.toHaveProperty(forbidden);
      expect(choreography.properties!.recipe!.properties!.parameters!.properties).not.toHaveProperty(forbidden);
    }
  });
});

function rawTrace(storyboard: any): any {
  return {
    seed: storyboard.seed,
    capabilityRequirements: storyboard.capabilityRequirements,
    objectCatalog: storyboard.objectCatalog,
    checkpoints: storyboard.checkpoints,
    edges: storyboard.edges,
    recipes: storyboard.recipes.map((recipe: any) => ({ recipeId: recipe.recipeId, seed: recipe.seed, intent: recipe.intent, exactBaseRequirements: recipe.exactBaseRequirements })),
  };
}
