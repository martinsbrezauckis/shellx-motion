import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileDataRecipeCheckpoint,
  DATA_RECIPE_CHECKPOINT_ACTION_ID,
  DATA_RECIPE_CHECKPOINT_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_LIMITS,
  DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_SCHEMA,
} from "@shellx-motion/core/internal/checkpoint-storyboard-data-recipe";
import { DEBUG_COMMANDS } from "../command-registry.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA } from "../command-metadata-checkpoint-storyboard.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS, dispatchCheckpointStoryboardRecordLifecycleCommand } from "./checkpoint-storyboard-record-lifecycle.js";
import { initializeMaterializationStateHead } from "./checkpoint-storyboard-materialization-bindings.js";
import { initializeRetainedTraceStateHead } from "./checkpoint-storyboard-retained-trace-resolution-journal.js";
import { checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { configureCheckpointStoryboardRecordStore, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store.js";

const roots: string[] = [];
const CAPS = { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 };

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function scalarDescriptor(seed = 1) {
  return {
    seed, capabilityRequirements: ["renderer.native"],
    objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [checkpoint("start", 0, 0, 0), checkpoint("finish", 1_000_000, 100, 50)],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }],
    recipes: [
      { recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } },
      { recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } },
    ],
  };
}
function retainedTraceDescriptor(seed = 1) {
  const durationUs = 4_000, sampleIntervalUs = 1_000;
  return {
    seed, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
      { id: "finish", atUs: durationUs, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }],
    recipes: [{ recipeId: "retained-line", seed: 2, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace: {
      schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs, sampleIntervalUs },
      drawers: [{ id: "line", driver: { kind: "parametric-graph", graph: { nodes: [
        { id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 },
      ], output: { x: "x", y: "zero", z: "zero" } } }, retention: { kind: "full-clip", maxSamples: 5 }, output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }],
      caps: { perDrawer: { ...CAPS }, aggregate: { ...CAPS } },
    } } }],
  };
}
function dataRecipeDescriptor(storyboardSeed = 11, recipeSeed = 12) {
  return {
    schema: DATA_RECIPE_CHECKPOINT_SCHEMA,
    storyboardSeed,
    requiredCapability: "renderer.gpu",
    target: { objectId: "lissajous-trace", rootShapeKind: "rect" },
    checkpoints: [
      { atUs: 0, state: "present", opacity: 0.75 },
      { atUs: 63_000, state: "present", opacity: 0.75 },
    ],
    recipe: {
      seed: recipeSeed,
      formulaId: DATA_RECIPE_CHECKPOINT_FORMULA_ID,
      actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID,
      parameters: {
        centerX: 0, centerY: 0, amplitudeX: 240, amplitudeY: 160,
        frequencyX: 3, frequencyY: 2, phaseTurnsQ1024: 128, sampleCount: 64,
        strokeWidth: 4, strokeOpacity: 0.75, luma: 0.5, speedLimit: 10_000,
      },
      limits: { ...DATA_RECIPE_CHECKPOINT_LIMITS },
    },
  };
}
function roseDataRecipeDescriptor(storyboardSeed = 31, recipeSeed = 32) {
  const descriptor: any = dataRecipeDescriptor(storyboardSeed, recipeSeed);
  descriptor.target.objectId = "rose-trace";
  descriptor.recipe.formulaId = DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID;
  descriptor.recipe.parameters = {
    centerX: 0, centerY: 0, radius: 240, petals: 5, rotationTurnsQ1024: 128,
    sampleCount: 64, strokeWidth: 4, strokeOpacity: 0.75, luma: 0.5, speedLimit: 10_000,
  };
  return descriptor;
}
function checkpoint(id: string, atUs: number, x: number, y: number) {
  return { id, atUs, objects: [{ objectId: "orb", state: "present", properties: [
    { property: "transform.x", value: x }, { property: "transform.y", value: y }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 },
  ] }] };
}
async function host() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-b7-record-"));
  roots.push(root);
  return { root, authority: await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 7) }) };
}
async function call(command: string, args: unknown, authority: CheckpointStoryboardRecordStoreAuthority) {
  return await dispatchCheckpointStoryboardRecordLifecycleCommand(command as never, args, { checkpointStoryboardRecordStore: authority });
}
function succeeded(result: Awaited<ReturnType<typeof call>>) {
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new Error("Expected success.");
  return result.result as { readonly record: { readonly identity: { readonly id: string; readonly sha256: string; readonly revision: number }; readonly storyboard: unknown; readonly admission: Record<string, unknown> }; readonly replay?: string };
}

describe("C6C B7 checkpoint storyboard retained-trace record-store partition", () => {
  it("seals B7 admission, creates only its B7 state head, and keeps revisions partitioned", async () => {
    const { root, authority } = await host();
    const b1 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, authority));
    const b7 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: retainedTraceDescriptor() }, authority));
    expect(b7.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" });

    const statePath = (identity: { readonly id: string }) => join(root, ".shellx-motion-c6c-record-store", "retained-trace-resolutions", `${identity.id}.state.json`);
    expect(JSON.parse(await readFile(statePath(b7.record.identity), "utf8"))).toMatchObject({ payload: { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-resolution-state@1", identity: b7.record.identity, state: "unbound", active: 0 } });
    await expect(readFile(statePath(b1.record.identity), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const replay = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: retainedTraceDescriptor() }, authority));
    expect(replay).toMatchObject({ replay: "same-input", record: { identity: b7.record.identity } });
    const revised = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b7.record.identity, descriptor: retainedTraceDescriptor(2) }, authority));
    expect(revised.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b7.record.identity, descriptor: scalarDescriptor() }, authority)).resolves.toMatchObject({ ok: false, error: { code: "record_identity_conflict" } });
  });

  it("rejects B7 evidence on a non-B7 profile and legacy B1 evidence on B7", async () => {
    const { authority } = await host();
    const b1 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, authority));
    const b7 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: retainedTraceDescriptor() }, authority));
    const facts = checkedAuthority(authority);
    await initializeRetainedTraceStateHead(facts, b1.record.identity, b1.record.identity);
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: b1.record.identity }, authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await initializeMaterializationStateHead(facts, b7.record.identity, b7.record.identity);
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: b7.record.identity }, authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("scans the complete B7 namespace before destructive operations", async () => {
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const removal = await host();
    const removalRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, removal.authority));
    await writeFile(join(removal.root, ".shellx-motion-c6c-record-store", "retained-trace-resolutions", `orphan.${uuid}.tmp`), "foreign B7 residue", { mode: 0o600 });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: removalRecord.record.identity }, removal.authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const archive = await host();
    const archiveRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, archive.authority));
    await writeFile(join(archive.root, ".shellx-motion-c6c-record-store", "retained-trace-resolutions", `orphan.${uuid}.tmp`), "foreign B7 residue", { mode: 0o600 });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: archiveRecord.record.identity }, archive.authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("recovers only B7 grammar-valid stages and refuses a replaced B7 authority child", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: retainedTraceDescriptor() }, authority));
    const journal = join(root, ".shellx-motion-c6c-record-store", "retained-trace-resolutions");
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const recognized = join(journal, `${created.record.identity.id}.state.json.${uuid}.tmp`);
    const unrelated = join(journal, `orphan.${uuid}.tmp`);
    await writeFile(recognized, "private stage", { mode: 0o600 });
    await writeFile(unrelated, "must not be selected", { mode: 0o600 });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    await expect(readFile(recognized, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("must not be selected");

    await rename(journal, `${journal}-replaced`);
    await mkdir(journal, { mode: 0o700 });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).resolves.toMatchObject({ ok: false, error: { code: "store_authority_refused" } });
  });

  it("lowers a closed data recipe into the existing B7 record path for create, replay, revise, and inspect", async () => {
    const { root, authority } = await host();
    const descriptor = dataRecipeDescriptor();
    const expected = compileDataRecipeCheckpoint(descriptor);
    expect(expected).toMatchObject({ formulaId: DATA_RECIPE_CHECKPOINT_FORMULA_ID, actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID, storyboard: {
      capabilityRequirements: ["renderer.gpu"],
      objectCatalog: [{ objectId: "lissajous-trace", rootShapeKind: "rect", propertyMask: ["opacity"] }],
      checkpoints: [
        { atUs: 0, objects: [{ objectId: "lissajous-trace", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
        { atUs: 63_000, objects: [{ objectId: "lissajous-trace", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
      ],
    } });

    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor }, authority));
    expect(created.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" });
    expect(created.record.storyboard).toEqual(expected.storyboard);
    expect(created).not.toHaveProperty("report");
    expect(created).not.toHaveProperty("descriptor");
    expect(JSON.stringify(created)).not.toContain(root);

    const replay = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor }, authority));
    expect(replay).toMatchObject({ replay: "same-input", record: { identity: created.record.identity } });

    const revisedDescriptor = dataRecipeDescriptor(21, 22);
    const revisedExpected = compileDataRecipeCheckpoint(revisedDescriptor, expected.storyboard);
    const revised = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: revisedDescriptor }, authority));
    expect(revised.record).toMatchObject({
      admission: { staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" },
      storyboard: { parentRevision: { id: created.record.identity.id, sha256: created.record.identity.sha256 } },
    });
    expect(revised.record.storyboard).toEqual(revisedExpected.storyboard);
    const revisedReplay = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: revisedDescriptor }, authority));
    expect(revisedReplay).toMatchObject({ replay: "same-input", record: { identity: revised.record.identity } });

    const inspected = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: revised.record.identity }, authority));
    expect(inspected.record).toMatchObject({ identity: revised.record.identity, storyboard: revisedExpected.storyboard, admission: revised.record.admission });
  });

  it("routes the closed rose formula through B7 while refusing cross-formula revisions", async () => {
    const { authority } = await host();
    const descriptor = roseDataRecipeDescriptor();
    const expected = compileDataRecipeCheckpoint(descriptor);
    expect(expected).toMatchObject({ formulaId: DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID, actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID, storyboard: { objectCatalog: [{ objectId: "rose-trace" }], recipes: [{ recipeId: "data-recipe-rose-curve-line" }] } });
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor }, authority));
    expect(created.record).toMatchObject({ admission: { staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" }, storyboard: expected.storyboard });
    const revisedDescriptor = roseDataRecipeDescriptor(33, 34);
    const revised = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: revisedDescriptor }, authority));
    expect(revised.record.storyboard).toEqual(compileDataRecipeCheckpoint(revisedDescriptor, expected.storyboard).storyboard);

    const switched = dataRecipeDescriptor(35, 36);
    switched.target.objectId = "rose-trace";
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: switched }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
  });

  it("refuses malformed data recipes before record admission and keeps formula/action/limits/code-shaped inputs closed", async () => {
    const { root, authority } = await host();
    const records = join(root, ".shellx-motion-c6c-record-store", "records");
    const base = dataRecipeDescriptor();
    const variants = [
      { ...base, recipe: { ...base.recipe, formulaId: "formula.expression@1" } },
      { ...base, recipe: { ...base.recipe, actionId: "trace.script-line@1" } },
      { ...base, recipe: { ...base.recipe, limits: { ...base.recipe.limits, maxSamples: 63 } } },
      { ...base, recipe: { ...base.recipe, parameters: { ...base.recipe.parameters, script: "return process.env" } } },
    ];
    for (const descriptor of variants) {
      await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
    }
    expect(await readdir(records)).toEqual([]);
  });

  it("refuses malformed high-level and raw B7 revisions before any parent-store read", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: dataRecipeDescriptor() }, authority));
    const records = join(root, ".shellx-motion-c6c-record-store", "records");
    await rename(records, `${records}-replaced`);
    await mkdir(records, { mode: 0o700 });

    const highLevel: any = dataRecipeDescriptor(41, 42);
    highLevel.recipe = { ...highLevel.recipe, actionId: "trace.callback-line@1" };
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: highLevel }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });

    const rawB7 = { ...retainedTraceDescriptor(), parent: created.record.storyboard };
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: rawB7 }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
  });

  it("refuses data-recipe revisions across scalar-profile and ordinary-B7 lineage boundaries", async () => {
    const { authority } = await host();
    const dataRecipe = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: dataRecipeDescriptor() }, authority));
    const scalar = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, authority));
    const ordinaryB7 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: retainedTraceDescriptor() }, authority));
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: dataRecipe.record.identity, descriptor: scalarDescriptor() }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: ordinaryB7.record.identity, descriptor: dataRecipeDescriptor() }, authority)).resolves.toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
  });

  it("keeps raw B1 and B7 descriptors on their pre-existing sealed create, replay, and revision paths", async () => {
    const { authority } = await host();
    const b1 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, authority));
    const b7 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: retainedTraceDescriptor() }, authority));
    expect(b1.record.admission).toEqual({ staticProfileAdmitted: true });
    expect(b7.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, authority))).toMatchObject({ replay: "same-input", record: { identity: b1.record.identity } });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: retainedTraceDescriptor() }, authority))).toMatchObject({ replay: "same-input", record: { identity: b7.record.identity } });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b1.record.identity, descriptor: scalarDescriptor(3) }, authority))).toMatchObject({ record: { admission: { staticProfileAdmitted: true }, storyboard: { parentRevision: { id: b1.record.identity.id, sha256: b1.record.identity.sha256 } } } });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b7.record.identity, descriptor: retainedTraceDescriptor(3) }, authority))).toMatchObject({ record: { admission: { staticProfileAdmitted: true, profile: "c6b7-retained-trace@1" }, storyboard: { parentRevision: { id: b7.record.identity.id, sha256: b7.record.identity.sha256 } } } });
  });

  it("keeps data recipes on the existing Debug/MCP verbs with no new command or CLI route", async () => {
    const checkpointCommands = DEBUG_COMMANDS.filter((command) => command.startsWith("motion.timeline.checkpoint-storyboard."));
    expect(checkpointCommands.slice().sort()).toEqual(Object.values(CHECKPOINT_STORYBOARD_RECORD_COMMANDS).slice().sort());
    const descriptor = CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create].argsSchema.properties.descriptor!;
    const dataRecipe = descriptor.oneOf!.find((candidate) => candidate.properties?.schema?.enum?.[0] === DATA_RECIPE_CHECKPOINT_SCHEMA);
    expect(dataRecipe).toBeDefined();
    expect(dataRecipe).toMatchObject({ type: "object", additionalProperties: false, required: ["schema", "storyboardSeed", "requiredCapability", "target", "checkpoints", "recipe"], properties: {
      schema: { type: "string", enum: [DATA_RECIPE_CHECKPOINT_SCHEMA] },
      storyboardSeed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 },
      requiredCapability: { type: "string", enum: ["renderer.gpu"] },
      target: { type: "object", additionalProperties: false, required: ["objectId", "rootShapeKind"], properties: { rootShapeKind: { enum: ["rect"] } } },
      checkpoints: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", additionalProperties: false, required: ["atUs", "state", "opacity"], properties: { atUs: { minimum: 0, maximum: 3_600_000_000, multipleOf: 1 }, state: { enum: ["present"] }, opacity: { minimum: 0, maximum: 1 } } } },
      recipe: { type: "object", oneOf: expect.any(Array) },
    } });
    expect(Object.keys(dataRecipe!.properties!).sort()).toEqual(["checkpoints", "recipe", "requiredCapability", "schema", "storyboardSeed", "target"]);
    const recipes = dataRecipe!.properties!.recipe!.oneOf!;
    const lissajous = recipes.find((candidate) => candidate.properties?.formulaId?.enum?.[0] === DATA_RECIPE_CHECKPOINT_FORMULA_ID)!;
    const rose = recipes.find((candidate) => candidate.properties?.formulaId?.enum?.[0] === DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID)!;
    expect(recipes).toHaveLength(2);
    for (const candidate of [lissajous, rose]) expect(candidate).toMatchObject({ type: "object", additionalProperties: false, required: ["seed", "formulaId", "actionId", "parameters", "limits"], properties: {
      seed: { type: "number", minimum: 0, maximum: 4_294_967_295, multipleOf: 1 },
      actionId: { enum: [DATA_RECIPE_CHECKPOINT_ACTION_ID] },
      limits: { type: "object", additionalProperties: false, required: ["maxSamples", "maxVertices", "maxWorkUnits", "maxBytes"], properties: {
        maxSamples: { minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxSamples, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxSamples, multipleOf: 1 },
        maxVertices: { minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxVertices, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxVertices, multipleOf: 1 },
        maxWorkUnits: { minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxWorkUnits, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxWorkUnits, multipleOf: 1 },
        maxBytes: { minimum: DATA_RECIPE_CHECKPOINT_LIMITS.maxBytes, maximum: DATA_RECIPE_CHECKPOINT_LIMITS.maxBytes, multipleOf: 1 },
      } },
    } });
    expect(Object.keys(lissajous.properties!.parameters!.properties!).sort()).toEqual(["amplitudeX", "amplitudeY", "centerX", "centerY", "frequencyX", "frequencyY", "luma", "phaseTurnsQ1024", "sampleCount", "speedLimit", "strokeOpacity", "strokeWidth"]);
    expect(Object.keys(rose.properties!.parameters!.properties!).sort()).toEqual(["centerX", "centerY", "luma", "petals", "radius", "rotationTurnsQ1024", "sampleCount", "speedLimit", "strokeOpacity", "strokeWidth"]);
    for (const forbidden of ["expression", "graph", "node", "script", "callback", "path", "url", "asset", "renderer", "package", "store", "output"]) {
      expect(dataRecipe!.properties, forbidden).not.toHaveProperty(forbidden);
      for (const candidate of recipes) {
        expect(candidate.properties, forbidden).not.toHaveProperty(forbidden);
        expect(candidate.properties!.parameters!.properties, forbidden).not.toHaveProperty(forbidden);
      }
    }
    const cli = await readFile(new URL("../../../cli/src/debug-subcommands.ts", import.meta.url), "utf8");
    const boundary = cli.indexOf("export const CLI_NAMED_DEBUG_NO_ROUTE"), named = cli.slice(boundary);
    for (const command of [CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise]) expect(named).toContain(command);
    expect(cli.slice(0, boundary)).not.toContain("checkpoint-storyboard.create");
    expect(cli.slice(0, boundary)).not.toContain("checkpoint-storyboard.revise");
  });
});
