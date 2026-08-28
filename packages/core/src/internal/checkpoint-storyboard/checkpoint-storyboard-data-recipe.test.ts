import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { admitCheckpointStoryboardRetainedTraceRecordProfile } from "./checkpoint-storyboard-retained-trace-profile";
import { CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS } from "./checkpoint-storyboard-retained-trace-profile-types";
import { createCheckpointStoryboard } from "./checkpoint-storyboard-records";
import { createTransitionRecipe } from "./checkpoint-storyboard-recipes";
import {
  DATA_RECIPE_CHECKPOINT_ACTION_ID,
  DATA_RECIPE_CHECKPOINT_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_LIMITS,
  DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_SCHEMA,
} from "./checkpoint-storyboard-data-recipe-types";
import { compileDataRecipeCheckpoint } from "./checkpoint-storyboard-data-recipe-compile";
import { readDataRecipeCheckpointDescriptor } from "./checkpoint-storyboard-data-recipe-read";

function descriptor(): any {
  return {
    schema: DATA_RECIPE_CHECKPOINT_SCHEMA,
    storyboardSeed: 7,
    requiredCapability: "renderer.gpu",
    target: { objectId: "lissajous-anchor", rootShapeKind: "rect" },
    checkpoints: [
      { atUs: 0, state: "present", opacity: 0.75 },
      { atUs: 63_000, state: "present", opacity: 0.75 },
    ],
    recipe: {
      seed: 11,
      formulaId: DATA_RECIPE_CHECKPOINT_FORMULA_ID,
      actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID,
      parameters: {
        centerX: 320,
        centerY: 180,
        amplitudeX: 120,
        amplitudeY: 80,
        frequencyX: 3,
        frequencyY: 2,
        phaseTurnsQ1024: 256,
        sampleCount: 64,
        strokeWidth: 2,
        strokeOpacity: 0.8,
        luma: 0.6,
        speedLimit: 1_000,
      },
      limits: { ...DATA_RECIPE_CHECKPOINT_LIMITS },
    },
  };
}

function roseDescriptor(): any {
  const source = descriptor();
  source.target.objectId = "rose-anchor";
  source.recipe.formulaId = DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID;
  source.recipe.parameters = {
    centerX: 320,
    centerY: 180,
    radius: 120,
    petals: 5,
    rotationTurnsQ1024: 128,
    sampleCount: 64,
    strokeWidth: 2,
    strokeOpacity: 0.8,
    luma: 0.6,
    speedLimit: 1_000,
  };
  return source;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** Exact graph written by C6D before the compact modular-turns topology. */
function legacyParent(mutator?: (trace: any) => void) {
  const source = descriptor(), current = compileDataRecipeCheckpoint(source);
  const intent = current.storyboard.recipes[0]!.intent;
  if (intent.kind !== "parametric-trace") throw new Error("Test fixture requires a parametric trace.");
  const trace = clone(intent.trace), durationUs = trace.clip.durationUs, parameters = source.recipe.parameters, phaseRadians = Math.PI * 2 * parameters.phaseTurnsQ1024 / 1_024;
  if (trace.drawers[0]!.driver.kind !== "parametric-graph") throw new Error("Test fixture requires a parametric graph.");
  trace.drawers[0].driver.graph.nodes = [
    { id: "time", kind: "time-us" },
    { id: "x-rate", kind: "constant", value: Math.PI * 2 * parameters.frequencyX / durationUs },
    { id: "x-time", kind: "multiply", left: "time", right: "x-rate" },
    { id: "phase", kind: "constant", value: phaseRadians },
    { id: "x-angle", kind: "add", left: "x-time", right: "phase" },
    { id: "x-sine", kind: "sin", input: "x-angle" },
    { id: "x-amplitude", kind: "constant", value: parameters.amplitudeX },
    { id: "x-offset", kind: "multiply", left: "x-sine", right: "x-amplitude" },
    { id: "x-center", kind: "constant", value: parameters.centerX },
    { id: "x", kind: "add", left: "x-center", right: "x-offset" },
    { id: "y-rate", kind: "constant", value: Math.PI * 2 * parameters.frequencyY / durationUs },
    { id: "y-time", kind: "multiply", left: "time", right: "y-rate" },
    { id: "y-sine", kind: "sin", input: "y-time" },
    { id: "y-amplitude", kind: "constant", value: parameters.amplitudeY },
    { id: "y-offset", kind: "multiply", left: "y-sine", right: "y-amplitude" },
    { id: "y-center", kind: "constant", value: parameters.centerY },
    { id: "y", kind: "add", left: "y-center", right: "y-offset" },
    { id: "zero", kind: "constant", value: 0 },
  ] as any;
  mutator?.(trace);
  const recipe = createTransitionRecipe({ recipeId: "data-recipe-lissajous-line", seed: source.recipe.seed, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: source.target.objectId, trace } });
  return createCheckpointStoryboard({
    seed: source.storyboardSeed,
    capabilityRequirements: ["renderer.gpu"],
    objectCatalog: current.storyboard.objectCatalog,
    checkpoints: current.storyboard.checkpoints,
    edges: [{ id: "data-recipe-checkpoint-edge", fromCheckpointId: "data-recipe-start", toCheckpointId: "data-recipe-finish", lifecycle: [{ kind: "preserve", objectId: source.target.objectId }], recipeIds: ["data-recipe-lissajous-line"] }],
    recipes: [recipe],
  });
}

describe("private C6D-A data-recipe checkpoint compiler", () => {
  it("detaches, seals, fingerprints, and revisions one deterministic descriptor", () => {
    const input = descriptor();
    const before = canonicalJson(input);
    const read = readDataRecipeCheckpointDescriptor(input);
    const first = compileDataRecipeCheckpoint(input);
    const replay = compileDataRecipeCheckpoint(clone(input));
    const revised = compileDataRecipeCheckpoint(input, first.storyboard);

    expect(canonicalJson(input)).toBe(before);
    expect(read).toEqual(input);
    expect(replay).toEqual(first);
    expect(first.descriptorSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sha256).toBe(first.fingerprint);
    expect(first.storyboard.revision).toBe(1);
    expect(first.storyboard.recipes[0]!.revision).toBe(1);
    expect(revised.storyboard.revision).toBe(2);
    expect(revised.storyboard.parentRevision).toEqual({ id: first.storyboard.id, sha256: first.storyboard.sha256 });
    expect(revised.storyboard.recipes[0]!.parentRevision).toEqual({ id: first.storyboard.recipes[0]!.id, sha256: first.storyboard.recipes[0]!.sha256 });
    expect(revised.lineage.storyboard.revision).toBe(2);
    expect(revised.lineage.transitionRecipe.revision).toBe(2);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.storyboard.recipes)).toBe(true);
    expect(Object.isFrozen(first.tracePlan.schedule)).toBe(true);
    expect(Object.isFrozen(first.tracePlan.drawers[0]!.samples)).toBe(true);
  });

  it("owns the exact Lissajous graph, full-clip schedule, fixed caps, and B7 admission", () => {
    const report = compileDataRecipeCheckpoint(descriptor());
    expect(DATA_RECIPE_CHECKPOINT_LIMITS).toEqual(CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS);
    const recipe = report.storyboard.recipes[0]!;
    const trace = recipe.intent.kind === "parametric-trace" ? recipe.intent.trace : undefined;
    expect(trace).toMatchObject({
      schema: "shellx-motion/private-parametric-trace@1",
      clip: { durationUs: 63_000, sampleIntervalUs: 1_000 },
      caps: { perDrawer: DATA_RECIPE_CHECKPOINT_LIMITS, aggregate: DATA_RECIPE_CHECKPOINT_LIMITS },
      drawers: [{
        id: "data-recipe-line",
        driver: { kind: "parametric-graph", graph: { output: { x: "x", y: "y", z: "zero" } } },
        retention: { kind: "full-clip", maxSamples: 64 },
        output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.6, to: 0.6 }, opacity: { source: "constant", from: 0.8, to: 0.8 }, speedLimit: 1_000 },
      }],
    });
    expect(trace?.drawers[0]!.driver.kind).toBe("parametric-graph");
    if (trace?.drawers[0]!.driver.kind === "parametric-graph") {
      expect(trace.drawers[0].driver.graph.nodes).toEqual([
        { id: "time", kind: "time-us" },
        { id: "x", kind: "lissajous-axis-q1024", time: "time", durationUs: 63_000, frequency: 3, phaseTurnsQ1024: 256, center: 320, amplitude: 120 },
        { id: "y", kind: "lissajous-axis-q1024", time: "time", durationUs: 63_000, frequency: 2, phaseTurnsQ1024: 0, center: 180, amplitude: 80 },
        { id: "zero", kind: "constant", value: 0 },
      ]);
    }
    expect(report.tracePlan.schedule).toEqual(Array.from({ length: 64 }, (_item, index) => index * 1_000));
    expect(report.tracePlan.drawers[0]!.windows.at(-1)).toMatchObject({ firstSampleIndex: 0, sampleCount: 64, vertexCount: 64 });
    expect(report.tracePlan.budget.limits).toEqual({ perDrawer: DATA_RECIPE_CHECKPOINT_LIMITS, aggregate: DATA_RECIPE_CHECKPOINT_LIMITS });
    expect(report.tracePlan.budget.compileWorkUnits).toBeLessThanOrEqual(DATA_RECIPE_CHECKPOINT_LIMITS.maxWorkUnits);
    expect(report.tracePlan.budget.peakBytes).toBeLessThanOrEqual(DATA_RECIPE_CHECKPOINT_LIMITS.maxBytes);
    expect(report.tracePlan.evidence.trigonometry).toBe("exact-modular-turns@1");
    expect(admitCheckpointStoryboardRetainedTraceRecordProfile(report.storyboard)).toEqual(report.storyboard);
    expect(report.c6aPlan).toMatchObject({ capabilityRequirements: ["renderer.gpu"], budget: { checkpointCount: 2, objectStateCount: 2, edgeCount: 1, recipeCount: 1 } });
    expect(report.evidence).toEqual({ b7RetainedTraceAdmitted: true, exactFixedCaps: true, codeOwnedGraph: true, noIO: true, noStore: true, noRenderer: true, noDebug: true, noCli: true, noSdk: true, noAction: true, noConnector: true, noPublicCoreRoot: true });

    const capped = descriptor();
    capped.recipe.parameters.speedLimit = 1;
    const cappedReport = compileDataRecipeCheckpoint(capped);
    expect(cappedReport.tracePlan.drawers[0]!.output.speedLimit).toBe(1);
    expect(cappedReport.tracePlan.drawers[0]!.samples.some((sample) => sample.speed === 1)).toBe(true);
  });

  it("owns a second deterministic rose-curve formula without opening the graph grammar", () => {
    const input = roseDescriptor();
    const report = compileDataRecipeCheckpoint(input);
    const replay = compileDataRecipeCheckpoint(clone(input));
    const revisedInput = roseDescriptor();
    revisedInput.recipe.parameters = { ...revisedInput.recipe.parameters, petals: 7, rotationTurnsQ1024: 511 };
    const revised = compileDataRecipeCheckpoint(revisedInput, report.storyboard);
    expect(readDataRecipeCheckpointDescriptor(input)).toEqual(input);
    expect(replay).toEqual(report);
    expect(report).toMatchObject({ formulaId: DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID, actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID });
    expect(report.storyboard.recipes[0]!.recipeId).toBe("data-recipe-rose-curve-line");
    expect(revised.storyboard.revision).toBe(2);
    const intent = report.storyboard.recipes[0]!.intent;
    if (intent.kind !== "parametric-trace" || intent.trace.drawers[0]!.driver.kind !== "parametric-graph") throw new Error("Rose fixture requires a parametric graph.");
    expect(intent.trace.drawers[0].driver.graph.nodes).toEqual([
      { id: "time", kind: "time-us" },
      { id: "radius-wave", kind: "lissajous-axis-q1024", time: "time", durationUs: 63_000, frequency: 5, phaseTurnsQ1024: 0, center: 0, amplitude: 120 },
      { id: "x-unit", kind: "lissajous-axis-q1024", time: "time", durationUs: 63_000, frequency: 1, phaseTurnsQ1024: 384, center: 0, amplitude: 1 },
      { id: "y-unit", kind: "lissajous-axis-q1024", time: "time", durationUs: 63_000, frequency: 1, phaseTurnsQ1024: 128, center: 0, amplitude: 1 },
      { id: "x-offset", kind: "multiply", left: "radius-wave", right: "x-unit" },
      { id: "y-offset", kind: "multiply", left: "radius-wave", right: "y-unit" },
      { id: "x-center", kind: "constant", value: 320 },
      { id: "y-center", kind: "constant", value: 180 },
      { id: "x", kind: "add", left: "x-center", right: "x-offset" },
      { id: "y", kind: "add", left: "y-center", right: "y-offset" },
      { id: "zero", kind: "constant", value: 0 },
    ]);
    const samples = report.tracePlan.drawers[0]!.samples;
    expect(samples.at(-1)!.position).toEqual(samples[0]!.position);
    expect(new Set(samples.map((sample) => canonicalJson(sample.position))).size).toBeGreaterThan(32);
    expect(report.tracePlan.evidence.trigonometry).toBe("exact-modular-turns@1");
    expect(admitCheckpointStoryboardRetainedTraceRecordProfile(report.storyboard)).toEqual(report.storyboard);
  });

  it("evaluates the named cycles over the full admitted duration instead of quantizing long rates to a static trace", () => {
    const long = descriptor();
    long.checkpoints[1].atUs = 3_600_000_000;
    long.recipe.parameters = { ...long.recipe.parameters, centerX: 0, centerY: 0, amplitudeX: 100, amplitudeY: 100, frequencyX: 1, frequencyY: 1, phaseTurnsQ1024: 0, sampleCount: 5, speedLimit: 100_000 };
    const samples = compileDataRecipeCheckpoint(long).tracePlan.drawers[0]!.samples;
    expect(samples.map((sample) => sample.position)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 100, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: -100, y: -100, z: 0 },
      { x: 0, y: 0, z: 0 },
    ]);

    for (const phaseTurnsQ1024 of [0, 1, 255, 256, 512, 1_023]) {
      const maximum = descriptor();
      maximum.checkpoints[1].atUs = 3_599_999_991;
      maximum.recipe.parameters = { ...maximum.recipe.parameters, centerX: 0, centerY: 0, amplitudeX: 100, amplitudeY: 100, frequencyX: 16, frequencyY: 1, phaseTurnsQ1024, sampleCount: 64, speedLimit: 100_000 };
      const maximumSamples = compileDataRecipeCheckpoint(maximum).tracePlan.drawers[0]!.samples;
      expect(maximumSamples.at(-1)!.position, `phase ${phaseTurnsQ1024} closure`).toEqual(maximumSamples[0]!.position);
      expect(new Set(maximumSamples.map((sample) => canonicalJson(sample.position))).size, `phase ${phaseTurnsQ1024} path`).toBeGreaterThan(16);
    }
  });

  it("covers closed numeric and structural boundaries before compiling a C6 record", () => {
    const minimum = descriptor();
    minimum.storyboardSeed = 0;
    minimum.checkpoints[1].atUs = 1;
    minimum.recipe.seed = 0;
    minimum.recipe.parameters = { ...minimum.recipe.parameters, centerX: 0, centerY: 0, amplitudeX: Number.MIN_VALUE, amplitudeY: Number.MIN_VALUE, frequencyX: 1, frequencyY: 1, phaseTurnsQ1024: 0, sampleCount: 2, strokeWidth: Number.MIN_VALUE, strokeOpacity: Number.MIN_VALUE, luma: 0, speedLimit: Number.MIN_VALUE };
    expect(readDataRecipeCheckpointDescriptor(minimum)).toMatchObject({ storyboardSeed: 0, checkpoints: [{ atUs: 0 }, { atUs: 1 }], recipe: { seed: 0, parameters: { sampleCount: 2 } } });

    const maximum = descriptor();
    maximum.storyboardSeed = 0xffff_ffff;
    maximum.checkpoints[1].atUs = 3_599_999_991;
    maximum.recipe.seed = 0xffff_ffff;
    maximum.recipe.parameters = { ...maximum.recipe.parameters, centerX: 0, centerY: 0, amplitudeX: 1_000_000, amplitudeY: 1_000_000, frequencyX: 16, frequencyY: 16, phaseTurnsQ1024: 1_023, sampleCount: 64, strokeWidth: 1_000_000, strokeOpacity: 1, luma: 1, speedLimit: 100_000 };
    expect(readDataRecipeCheckpointDescriptor(maximum)).toMatchObject({ storyboardSeed: 0xffff_ffff, checkpoints: [{ atUs: 0 }, { atUs: 3_599_999_991 }], recipe: { seed: 0xffff_ffff, parameters: { sampleCount: 64, phaseTurnsQ1024: 1_023 } } });

    const signedZero = descriptor();
    signedZero.storyboardSeed = -0;
    signedZero.recipe.seed = -0;
    signedZero.recipe.parameters.phaseTurnsQ1024 = -0;
    const normalized = readDataRecipeCheckpointDescriptor(signedZero);
    expect(Object.is(normalized.storyboardSeed, -0)).toBe(false);
    expect(Object.is(normalized.recipe.seed, -0)).toBe(false);
    expect(normalized.recipe.formulaId).toBe(DATA_RECIPE_CHECKPOINT_FORMULA_ID);
    if (normalized.recipe.formulaId !== DATA_RECIPE_CHECKPOINT_FORMULA_ID) throw new Error("Test fixture requires the Lissajous recipe.");
    expect(Object.is(normalized.recipe.parameters.phaseTurnsQ1024, -0)).toBe(false);

    const cases: readonly [string, (draft: any) => void][] = [
      ["storyboard seed", (draft) => { draft.storyboardSeed = -1; }],
      ["required capability", (draft) => { draft.requiredCapability = "renderer.native"; }],
      ["root shape", (draft) => { draft.target.rootShapeKind = "ellipse"; }],
      ["checkpoint count", (draft) => { draft.checkpoints.pop(); }],
      ["start time", (draft) => { draft.checkpoints[0].atUs = 1; }],
      ["end time", (draft) => { draft.checkpoints[1].atUs = 0; }],
      ["checkpoint opacity", (draft) => { draft.checkpoints[1].opacity = 0.5; }],
      ["recipe seed", (draft) => { draft.recipe.seed = 0x1_0000_0000; }],
      ["center plus amplitude", (draft) => { draft.recipe.parameters.centerX = 1_000_000; draft.recipe.parameters.amplitudeX = 1; }],
      ["zero amplitude", (draft) => { draft.recipe.parameters.amplitudeY = 0; }],
      ["frequency", (draft) => { draft.recipe.parameters.frequencyX = 17; }],
      ["phase", (draft) => { draft.recipe.parameters.phaseTurnsQ1024 = 1_024; }],
      ["sample count", (draft) => { draft.recipe.parameters.sampleCount = 1; }],
      ["sample divisibility", (draft) => { draft.recipe.parameters.sampleCount = 63; }],
      ["stroke width", (draft) => { draft.recipe.parameters.strokeWidth = 0; }],
      ["stroke opacity", (draft) => { draft.recipe.parameters.strokeOpacity = 0; }],
      ["luma", (draft) => { draft.recipe.parameters.luma = 1.1; }],
      ["speed", (draft) => { draft.recipe.parameters.speedLimit = 0; }],
      ["fixed cap", (draft) => { draft.recipe.limits.maxBytes = 1; }],
    ];
    for (const [label, mutate] of cases) {
      const draft = descriptor();
      mutate(draft);
      expect(() => readDataRecipeCheckpointDescriptor(draft), label).toThrow();
    }

    for (const [label, mutate] of [
      ["rose radius", (draft: any) => { draft.recipe.parameters.radius = 0; }],
      ["rose extent", (draft: any) => { draft.recipe.parameters.centerY = 1_000_000; draft.recipe.parameters.radius = 1; }],
      ["rose petals", (draft: any) => { draft.recipe.parameters.petals = 1; }],
      ["rose rotation", (draft: any) => { draft.recipe.parameters.rotationTurnsQ1024 = 1_024; }],
    ] as const) {
      const draft = roseDescriptor();
      mutate(draft);
      expect(() => readDataRecipeCheckpointDescriptor(draft), label).toThrow();
    }
  });

  it("refuses formula/action mismatches, arbitrary-code-shaped fields, hostile objects, and incompatible parent lineages", () => {
    for (const [label, mutate, expected] of [
      ["formula", (draft: any) => { draft.recipe.formulaId = "formula.expression@1"; }, "formulaId"],
      ["action", (draft: any) => { draft.recipe.actionId = "trace.ribbon@1"; }, "actionId"],
      ["expression", (draft: any) => { draft.recipe.expression = "return globalThis.process"; }, "unknown field"],
      ["graph", (draft: any) => { draft.recipe.graph = { nodes: [] }; }, "unknown field"],
      ["node", (draft: any) => { draft.recipe.parameters.node = { kind: "script" }; }, "unknown field"],
      ["script", (draft: any) => { draft.script = "alert(1)"; }, "unknown field"],
      ["callback", (draft: any) => { draft.recipe.callback = "callback"; }, "unknown field"],
      ["path", (draft: any) => { draft.target.path = "../../escape"; }, "unknown field"],
      ["url", (draft: any) => { draft.recipe.url = "https://example.invalid"; }, "unknown field"],
      ["asset", (draft: any) => { draft.asset = "trace.png"; }, "unknown field"],
      ["renderer", (draft: any) => { draft.renderer = "gpu"; }, "unknown field"],
    ] as const) {
      const draft = descriptor();
      mutate(draft);
      expect(() => readDataRecipeCheckpointDescriptor(draft), label).toThrow(expected);
    }

    const functionValue = descriptor(); functionValue.recipe.callback = () => 1;
    expect(() => readDataRecipeCheckpointDescriptor(functionValue)).toThrow("only JSON values");

    const hostile = descriptor();
    let getterCalls = 0;
    Object.defineProperty(hostile, "recipe", { enumerable: true, get() { getterCalls += 1; return descriptor().recipe; } });
    expect(() => readDataRecipeCheckpointDescriptor(hostile)).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);
    const cyclic = descriptor(); cyclic.recipe.parameters.self = cyclic;
    expect(() => readDataRecipeCheckpointDescriptor(cyclic)).toThrow("cycles");
    const customPrototype = Object.create({ inherited: true }); Object.assign(customPrototype, descriptor());
    expect(() => readDataRecipeCheckpointDescriptor(customPrototype)).toThrow("plain objects");
    const sparse = descriptor(); sparse.checkpoints.length = 3;
    expect(() => readDataRecipeCheckpointDescriptor(sparse)).toThrow("dense");
    let ownKeys = 0;
    const oversized = new Proxy({}, { ownKeys() { ownKeys += 1; return Array.from({ length: 10_000 }, (_item, index) => `field${index}`); } });
    expect(() => readDataRecipeCheckpointDescriptor(oversized)).toThrow("24-field record limit");
    expect(ownKeys).toBe(1);

    const first = compileDataRecipeCheckpoint(descriptor());
    const changed = descriptor();
    changed.storyboardSeed = 99;
    changed.checkpoints[1].atUs = 30_000;
    changed.recipe.seed = 23;
    changed.recipe.parameters = { ...changed.recipe.parameters, centerX: 12, amplitudeY: 72, frequencyX: 4, frequencyY: 5, phaseTurnsQ1024: 512, sampleCount: 31, strokeWidth: 3, strokeOpacity: 0.4, luma: 0.2, speedLimit: 17 };
    const changedParent = compileDataRecipeCheckpoint(changed);
    const revised = compileDataRecipeCheckpoint(descriptor(), changedParent.storyboard);
    expect(revised.storyboard.revision).toBe(2);
    expect(revised.storyboard.parentRevision).toEqual({ id: changedParent.storyboard.id, sha256: changedParent.storyboard.sha256 });
    expect(revised.storyboard.recipes[0]!.parentRevision).toEqual({ id: changedParent.storyboard.recipes[0]!.id, sha256: changedParent.storyboard.recipes[0]!.sha256 });

    const legacy = legacyParent();
    expect(admitCheckpointStoryboardRetainedTraceRecordProfile(legacy)).toEqual(legacy);
    const legacyChanged = descriptor();
    legacyChanged.storyboardSeed = 98;
    legacyChanged.recipe.seed = 22;
    legacyChanged.recipe.parameters = { ...legacyChanged.recipe.parameters, centerX: 12, amplitudeY: 72, frequencyX: 4, frequencyY: 5, phaseTurnsQ1024: 512, sampleCount: 64 };
    const legacyRevision = compileDataRecipeCheckpoint(legacyChanged, legacy);
    expect(legacyRevision.storyboard.revision).toBe(2);
    expect(legacyRevision.storyboard.parentRevision).toEqual({ id: legacy.id, sha256: legacy.sha256 });
    expect(legacyRevision.storyboard.recipes[0]!.parentRevision).toEqual({ id: legacy.recipes[0]!.id, sha256: legacy.recipes[0]!.sha256 });
    expect(legacyRevision.tracePlan.evidence.trigonometry).toBe("exact-modular-turns@1");
    const legacyTrace = legacyRevision.storyboard.recipes[0]!.intent;
    if (legacyTrace.kind === "parametric-trace" && legacyTrace.trace.drawers[0]!.driver.kind === "parametric-graph") expect(legacyTrace.trace.drawers[0].driver.graph.nodes).toHaveLength(4);

    const hostileLegacyNearMiss = legacyParent((trace) => { trace.drawers[0]!.driver.graph.nodes[7]!.left = "x-angle"; });
    expect(admitCheckpointStoryboardRetainedTraceRecordProfile(hostileLegacyNearMiss)).toEqual(hostileLegacyNearMiss);
    expect(() => compileDataRecipeCheckpoint(descriptor(), hostileLegacyNearMiss)).toThrow("code-owned");

    const rawRecipe = createTransitionRecipe({ recipeId: "raw-line", seed: 1, exactBaseRequirements: [], intent: first.storyboard.recipes[0]!.intent });
    const rawParent = createCheckpointStoryboard({
      seed: 1,
      capabilityRequirements: ["renderer.gpu"],
      objectCatalog: first.storyboard.objectCatalog,
      checkpoints: first.storyboard.checkpoints,
      edges: [{ id: "raw-edge", fromCheckpointId: "data-recipe-start", toCheckpointId: "data-recipe-finish", lifecycle: [{ kind: "preserve", objectId: "lissajous-anchor" }], recipeIds: ["raw-line"] }],
      recipes: [rawRecipe],
    });
    expect(admitCheckpointStoryboardRetainedTraceRecordProfile(rawParent)).toEqual(rawParent);
    expect(() => compileDataRecipeCheckpoint(descriptor(), rawParent)).toThrow("data-recipe lineage");
    const roseOnLissajous = roseDescriptor(); roseOnLissajous.target.objectId = descriptor().target.objectId;
    expect(() => compileDataRecipeCheckpoint(roseOnLissajous, first.storyboard)).toThrow("data-recipe lineage");
    const rose = compileDataRecipeCheckpoint(roseOnLissajous);
    expect(() => compileDataRecipeCheckpoint(descriptor(), rose.storyboard)).toThrow("data-recipe lineage");
    expect(() => compileDataRecipeCheckpoint(descriptor(), { schema: "no" })).toThrow();
    expect(first.storyboard.parentRevision).toBeUndefined();
  });

  it("contains no I/O or public Core-root route and exposes only its closed package subpath", () => {
    const source = [
      readFileSync(new URL("./checkpoint-storyboard-data-recipe.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-data-recipe-read.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-data-recipe-compile.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-data-recipe-choreography-types.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-data-recipe-choreography-read.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-data-recipe-choreography-compile.ts", import.meta.url), "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:debug-server|\/cli|\/sdk|\/actions|connectors?|renderer-)/i);
    const root = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(root).not.toContain("checkpoint-storyboard-data-recipe");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.exports["./internal/checkpoint-storyboard-data-recipe"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-data-recipe.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-data-recipe"]).toEqual({ types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-data-recipe.d.ts", default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-data-recipe.js" });
  });
});
