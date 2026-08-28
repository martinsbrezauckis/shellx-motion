import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { compileMotionParametricTracePlan } from "../../motion-parametric-trace-plan";
import { MOTION_PARAMETRIC_TRACE_SCHEMA, type MotionParametricTraceDescriptor, type MotionParametricTraceGraphNode } from "../../motion-parametric-trace-types";
import { admitCheckpointStoryboardRetainedTraceRecordProfile } from "./checkpoint-storyboard-retained-trace-profile";
import { createCheckpointStoryboard, compileCheckpointStoryboardPlan } from "./checkpoint-storyboard-records";
import { createTransitionRecipe } from "./checkpoint-storyboard-recipes";
import { freeze } from "./checkpoint-storyboard-data";
import type { CheckpointStoryboard } from "./checkpoint-storyboard-types";
import {
  DATA_RECIPE_CHECKPOINT_ACTION_ID,
  DATA_RECIPE_CHECKPOINT_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_LIMITS,
  DATA_RECIPE_CHECKPOINT_REPORT_SCHEMA,
  DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID,
  type DataRecipeCheckpointDescriptor,
  type DataRecipeCheckpointFormulaId,
  type DataRecipeCheckpointLissajousParameters,
  type DataRecipeCheckpointReport,
  type DataRecipeCheckpointRoseParameters,
} from "./checkpoint-storyboard-data-recipe-types";
import { readDataRecipeCheckpointDescriptor } from "./checkpoint-storyboard-data-recipe-read";

const LISSAJOUS_RECIPE_ID = "data-recipe-lissajous-line";
const ROSE_RECIPE_ID = "data-recipe-rose-curve-line";
const EDGE_ID = "data-recipe-checkpoint-edge";
const DRAWER_ID = "data-recipe-line";
const TWO_PI = Math.PI * 2;

/**
 * Compiles one closed named formula/action descriptor into the existing sealed C6A/B7
 * retained-trace record. This is data planning only: it owns no package or host authority.
 */
export function compileDataRecipeCheckpoint(value: unknown, parentStoryboard?: unknown): DataRecipeCheckpointReport {
  const descriptor = readDataRecipeCheckpointDescriptor(value);
  const parent = parentStoryboard === undefined ? undefined : readCompatibleParent(parentStoryboard, descriptor);
  const storyboard = buildStoryboard(descriptor, parent);
  const admitted = admitCheckpointStoryboardRetainedTraceRecordProfile(storyboard);
  const trace = admitted.recipes[0]!.intent;
  if (trace.kind !== "parametric-trace") throw new Error("Data-recipe checkpoint compiler produced a non-trace recipe.");
  const traceResult = compileMotionParametricTracePlan(trace.trace);
  if (!traceResult.ok) throw new Error(`Data-recipe checkpoint C4C planning refused: ${traceResult.message}`);
  const c6aPlan = compileCheckpointStoryboardPlan(admitted);
  const lineage = readLineage(admitted);
  const payload = {
    schema: DATA_RECIPE_CHECKPOINT_REPORT_SCHEMA,
    descriptorSha256: canonicalJsonSha256(descriptor),
    formulaId: descriptor.recipe.formulaId,
    actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID,
    storyboard: admitted,
    c6aPlan,
    tracePlan: traceResult.plan,
    lineage,
    evidence: freeze({
      b7RetainedTraceAdmitted: true as const,
      exactFixedCaps: true as const,
      codeOwnedGraph: true as const,
      noIO: true as const,
      noStore: true as const,
      noRenderer: true as const,
      noDebug: true as const,
      noCli: true as const,
      noSdk: true as const,
      noAction: true as const,
      noConnector: true as const,
      noPublicCoreRoot: true as const,
    }),
  };
  const sha256 = canonicalJsonSha256(payload);
  return freeze({ ...payload, sha256, fingerprint: sha256 });
}

/** Used by the host to prevent a named trace formula lineage from escaping into raw C6A revision. */
export function isDataRecipeCheckpointStoryboard(value: unknown): boolean {
  try {
    const storyboard = admitCheckpointStoryboardRetainedTraceRecordProfile(value);
    const recipe = storyboard.recipes[0]!;
    const formulaId = recipe.recipeId === LISSAJOUS_RECIPE_ID
      ? DATA_RECIPE_CHECKPOINT_FORMULA_ID
      : recipe.recipeId === ROSE_RECIPE_ID
        ? DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID
        : undefined;
    if (!formulaId || storyboard.checkpoints[0]!.id !== "data-recipe-start" || storyboard.checkpoints[1]!.id !== "data-recipe-finish" || storyboard.edges[0]!.id !== EDGE_ID || recipe.intent.kind !== "parametric-trace") return false;
    assertDataRecipeTraceShape(recipe.intent.trace, formulaId);
    return true;
  } catch {
    return false;
  }
}

function buildStoryboard(descriptor: DataRecipeCheckpointDescriptor, parent?: CheckpointStoryboard): CheckpointStoryboard {
  const recipeId = recipeIdForFormula(descriptor.recipe.formulaId);
  const recipe = createTransitionRecipe({
    recipeId,
    seed: descriptor.recipe.seed,
    intent: {
      kind: "parametric-trace",
      outputObjectId: descriptor.target.objectId,
      trace: buildTrace(descriptor),
    },
    exactBaseRequirements: [],
    ...(parent ? { parent: parent.recipes[0]! } : {}),
  });
  const [start, finish] = descriptor.checkpoints;
  return createCheckpointStoryboard({
    seed: descriptor.storyboardSeed,
    capabilityRequirements: [descriptor.requiredCapability],
    objectCatalog: [{ objectId: descriptor.target.objectId, rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [
      { id: "data-recipe-start", atUs: start.atUs, objects: [{ objectId: descriptor.target.objectId, state: start.state, properties: [{ property: "opacity", value: start.opacity }] }] },
      { id: "data-recipe-finish", atUs: finish.atUs, objects: [{ objectId: descriptor.target.objectId, state: finish.state, properties: [{ property: "opacity", value: finish.opacity }] }] },
    ],
    edges: [{ id: EDGE_ID, fromCheckpointId: "data-recipe-start", toCheckpointId: "data-recipe-finish", lifecycle: [{ kind: "preserve", objectId: descriptor.target.objectId }], recipeIds: [recipeId] }],
    recipes: [recipe],
    ...(parent ? { parent } : {}),
  });
}

function buildTrace(descriptor: DataRecipeCheckpointDescriptor) {
  const parameters = descriptor.recipe.parameters;
  const durationUs = descriptor.checkpoints[1].atUs;
  return {
    schema: MOTION_PARAMETRIC_TRACE_SCHEMA,
    clip: { durationUs, sampleIntervalUs: durationUs / (parameters.sampleCount - 1) },
    drawers: [{
      id: DRAWER_ID,
      driver: {
        kind: "parametric-graph",
        graph: {
          nodes: descriptor.recipe.formulaId === DATA_RECIPE_CHECKPOINT_FORMULA_ID
            ? buildLissajousNodes(descriptor.recipe.parameters, durationUs)
            : buildRoseNodes(descriptor.recipe.parameters, durationUs),
          output: { x: "x", y: "y", z: "zero" },
        },
      },
      retention: { kind: "full-clip", maxSamples: parameters.sampleCount },
      output: {
        mode: "line",
        width: { source: "constant", from: parameters.strokeWidth, to: parameters.strokeWidth },
        colour: { source: "constant", from: parameters.luma, to: parameters.luma },
        opacity: { source: "constant", from: parameters.strokeOpacity, to: parameters.strokeOpacity },
        speedLimit: parameters.speedLimit,
      },
    }],
    caps: { perDrawer: { ...DATA_RECIPE_CHECKPOINT_LIMITS }, aggregate: { ...DATA_RECIPE_CHECKPOINT_LIMITS } },
  };
}

function buildLissajousNodes(parameters: DataRecipeCheckpointLissajousParameters, durationUs: number): MotionParametricTraceGraphNode[] {
  return [
    { id: "time", kind: "time-us" },
    { id: "x", kind: "lissajous-axis-q1024", time: "time", durationUs, frequency: parameters.frequencyX, phaseTurnsQ1024: parameters.phaseTurnsQ1024, center: parameters.centerX, amplitude: parameters.amplitudeX },
    { id: "y", kind: "lissajous-axis-q1024", time: "time", durationUs, frequency: parameters.frequencyY, phaseTurnsQ1024: 0, center: parameters.centerY, amplitude: parameters.amplitudeY },
    { id: "zero", kind: "constant", value: 0 },
  ];
}

function buildRoseNodes(parameters: DataRecipeCheckpointRoseParameters, durationUs: number): MotionParametricTraceGraphNode[] {
  return [
    { id: "time", kind: "time-us" },
    { id: "radius-wave", kind: "lissajous-axis-q1024", time: "time", durationUs, frequency: parameters.petals, phaseTurnsQ1024: 0, center: 0, amplitude: parameters.radius },
    { id: "x-unit", kind: "lissajous-axis-q1024", time: "time", durationUs, frequency: 1, phaseTurnsQ1024: (parameters.rotationTurnsQ1024 + 256) % 1_024, center: 0, amplitude: 1 },
    { id: "y-unit", kind: "lissajous-axis-q1024", time: "time", durationUs, frequency: 1, phaseTurnsQ1024: parameters.rotationTurnsQ1024, center: 0, amplitude: 1 },
    { id: "x-offset", kind: "multiply", left: "radius-wave", right: "x-unit" },
    { id: "y-offset", kind: "multiply", left: "radius-wave", right: "y-unit" },
    { id: "x-center", kind: "constant", value: parameters.centerX },
    { id: "y-center", kind: "constant", value: parameters.centerY },
    { id: "x", kind: "add", left: "x-center", right: "x-offset" },
    { id: "y", kind: "add", left: "y-center", right: "y-offset" },
    { id: "zero", kind: "constant", value: 0 },
  ];
}

function recipeIdForFormula(formulaId: DataRecipeCheckpointFormulaId): string {
  return formulaId === DATA_RECIPE_CHECKPOINT_FORMULA_ID ? LISSAJOUS_RECIPE_ID : ROSE_RECIPE_ID;
}

function readCompatibleParent(value: unknown, descriptor: DataRecipeCheckpointDescriptor): CheckpointStoryboard {
  const parent = admitCheckpointStoryboardRetainedTraceRecordProfile(value);
  const recipe = parent.recipes[0]!;
  const recipeId = recipeIdForFormula(descriptor.recipe.formulaId);
  if (
    parent.objectCatalog[0]!.objectId !== descriptor.target.objectId
    || parent.checkpoints[0]!.id !== "data-recipe-start"
    || parent.checkpoints[1]!.id !== "data-recipe-finish"
    || parent.edges[0]!.id !== EDGE_ID
    || recipe.recipeId !== recipeId
  ) throw new Error("Data-recipe checkpoint parent is B7-admitted but not a code-owned data-recipe lineage for this target object.");
  if (recipe.intent.kind !== "parametric-trace") throw new Error("Data-recipe checkpoint parent is not a parametric-trace data-recipe lineage.");
  assertDataRecipeTraceShape(recipe.intent.trace, descriptor.recipe.formulaId);
  return parent;
}

/** Verifies code-owned graph topology while allowing a prior closed recipe's scalar values to differ. */
function assertDataRecipeTraceShape(trace: MotionParametricTraceDescriptor, formulaId: DataRecipeCheckpointFormulaId): void {
  const durationUs = trace.clip.durationUs, intervalUs = trace.clip.sampleIntervalUs;
  if (!Number.isSafeInteger(durationUs) || durationUs < 1 || !Number.isSafeInteger(intervalUs) || intervalUs < 1 || durationUs % intervalUs !== 0) throw new Error("Data-recipe checkpoint parent must retain a divisible fixed sample interval.");
  const sampleCount = durationUs / intervalUs + 1;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 2 || sampleCount > DATA_RECIPE_CHECKPOINT_LIMITS.maxSamples) throw new Error("Data-recipe checkpoint parent must retain 2..64 samples.");
  if (trace.drawers.length !== 1 || trace.drawers[0]!.id !== DRAWER_ID || trace.drawers[0]!.retention.kind !== "full-clip" || trace.drawers[0]!.retention.maxSamples !== sampleCount) throw new Error("Data-recipe checkpoint parent must retain the code-owned full-clip drawer.");
  if (canonicalJson(trace.caps.perDrawer) !== canonicalJson(DATA_RECIPE_CHECKPOINT_LIMITS) || canonicalJson(trace.caps.aggregate) !== canonicalJson(DATA_RECIPE_CHECKPOINT_LIMITS)) throw new Error("Data-recipe checkpoint parent must retain the exact B7 caps.");
  const drawer = trace.drawers[0]!;
  if (drawer.driver.kind !== "parametric-graph" || drawer.output.mode !== "line" || !constantPositive(drawer.output.width, 1_000_000) || !constantPositive(drawer.output.opacity, 1) || !constantRange(drawer.output.colour, 0, 1) || !positive(drawer.output.speedLimit, 100_000)) throw new Error("Data-recipe checkpoint parent must retain the code-owned full-clip line action.");
  const graph = drawer.driver.graph;
  if (canonicalJson(graph.output) !== canonicalJson({ x: "x", y: "y", z: "zero" })) throw new Error("Data-recipe checkpoint parent graph output is not code-owned 2D formula data.");
  const nodes = graph.nodes;
  if (formulaId === DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID) return assertRoseDataRecipeGraph(nodes, durationUs);
  if (nodes.length === 4) return assertCurrentDataRecipeGraph(nodes, durationUs);
  if (nodes.length === 18) return assertLegacyDataRecipeGraph(nodes, durationUs);
  throw new Error("Data-recipe checkpoint parent graph must contain one exact code-owned Lissajous topology.");
}

/** The current compact topology is the only graph this compiler writes. */
function assertCurrentDataRecipeGraph(nodes: readonly unknown[], durationUs: number): void {
  exactNode(nodes[0], { id: "time", kind: "time-us" });
  assertLissajousAxisNode(nodes[1], "x", durationUs, false);
  assertLissajousAxisNode(nodes[2], "y", durationUs, true);
  exactNode(nodes[3], { id: "zero", kind: "constant", value: 0 });
}

function assertRoseDataRecipeGraph(nodes: readonly unknown[], durationUs: number): void {
  if (nodes.length !== 11) throw new Error("Data-recipe checkpoint parent graph must contain the exact code-owned rose-curve topology.");
  exactNode(nodes[0], { id: "time", kind: "time-us" });
  const radial = axisNode(nodes[1], "radius-wave", durationUs);
  const xUnit = axisNode(nodes[2], "x-unit", durationUs);
  const yUnit = axisNode(nodes[3], "y-unit", durationUs);
  if (radial.frequency < 2 || radial.phaseTurnsQ1024 !== 0 || radial.center !== 0 || xUnit.frequency !== 1 || xUnit.center !== 0 || xUnit.amplitude !== 1 || yUnit.frequency !== 1 || yUnit.center !== 0 || yUnit.amplitude !== 1 || xUnit.phaseTurnsQ1024 !== (yUnit.phaseTurnsQ1024 + 256) % 1_024) throw new Error("Data-recipe checkpoint parent graph is not an exact code-owned rose-curve formula.");
  exactNode(nodes[4], { id: "x-offset", kind: "multiply", left: "radius-wave", right: "x-unit" });
  exactNode(nodes[5], { id: "y-offset", kind: "multiply", left: "radius-wave", right: "y-unit" });
  const centerX = constantNode(nodes[6], "x-center"), centerY = constantNode(nodes[7], "y-center");
  exactNode(nodes[8], { id: "x", kind: "add", left: "x-center", right: "x-offset" });
  exactNode(nodes[9], { id: "y", kind: "add", left: "y-center", right: "y-offset" });
  exactNode(nodes[10], { id: "zero", kind: "constant", value: 0 });
  if (!coordinates(centerX, radial.amplitude) || !coordinates(centerY, radial.amplitude)) throw new Error("Data-recipe checkpoint parent graph rose-curve coordinates exceed the code-owned bounds.");
}

/**
 * Accept the one historical 18-node expansion emitted before the compact modular-turns node
 * existed. This is parent-read compatibility only: all descendants are re-emitted as four nodes.
 */
function assertLegacyDataRecipeGraph(nodes: readonly unknown[], durationUs: number): void {
  exactNode(nodes[0], { id: "time", kind: "time-us" });
  const xRate = constantNode(nodes[1], "x-rate"), phase = constantNode(nodes[3], "phase"), xAmplitude = constantNode(nodes[6], "x-amplitude"), xCenter = constantNode(nodes[8], "x-center");
  exactNode(nodes[2], { id: "x-time", kind: "multiply", left: "time", right: "x-rate" });
  exactNode(nodes[4], { id: "x-angle", kind: "add", left: "x-time", right: "phase" });
  exactNode(nodes[5], { id: "x-sine", kind: "sin", input: "x-angle" });
  exactNode(nodes[7], { id: "x-offset", kind: "multiply", left: "x-sine", right: "x-amplitude" });
  exactNode(nodes[9], { id: "x", kind: "add", left: "x-center", right: "x-offset" });
  const yRate = constantNode(nodes[10], "y-rate"), yAmplitude = constantNode(nodes[13], "y-amplitude"), yCenter = constantNode(nodes[15], "y-center");
  exactNode(nodes[11], { id: "y-time", kind: "multiply", left: "time", right: "y-rate" });
  exactNode(nodes[12], { id: "y-sine", kind: "sin", input: "y-time" });
  exactNode(nodes[14], { id: "y-offset", kind: "multiply", left: "y-sine", right: "y-amplitude" });
  exactNode(nodes[16], { id: "y", kind: "add", left: "y-center", right: "y-offset" });
  exactNode(nodes[17], { id: "zero", kind: "constant", value: 0 });
  if (!matchesFrequency(xRate, durationUs) || !matchesFrequency(yRate, durationUs) || !matchesPhase(phase) || !coordinates(xCenter, xAmplitude) || !coordinates(yCenter, yAmplitude)) throw new Error("Data-recipe checkpoint parent graph is not an exact legacy code-owned Lissajous formula.");
}

function exactNode(value: unknown, expected: Record<string, unknown>): void {
  if (canonicalJson(value) !== canonicalJson(expected)) throw new Error("Data-recipe checkpoint parent graph node is not code-owned.");
}
function constantNode(value: unknown, id: string): number {
  if (!value || typeof value !== "object" || canonicalJson({ ...(value as Record<string, unknown>), value: 0 }) !== canonicalJson({ id, kind: "constant", value: 0 })) throw new Error(`Data-recipe checkpoint parent graph node '${id}' is not an exact constant.`);
  const constant = (value as { readonly value?: unknown }).value;
  if (typeof constant !== "number" || !Number.isFinite(constant) || Object.is(constant, -0)) throw new Error(`Data-recipe checkpoint parent graph node '${id}' is not a canonical finite constant.`);
  return constant;
}
function assertLissajousAxisNode(value: unknown, id: "x" | "y", durationUs: number, zeroPhase: boolean): void {
  const node = axisNode(value, id, durationUs);
  if ((zeroPhase && node.phaseTurnsQ1024 !== 0) || !coordinates(node.center, node.amplitude)) throw new Error("Data-recipe checkpoint parent graph is not an exact code-owned Lissajous formula.");
}
function axisNode(value: unknown, id: string, durationUs: number): { frequency: number; phaseTurnsQ1024: number; center: number; amplitude: number } {
  if (!value || typeof value !== "object") throw new Error(`Data-recipe checkpoint parent graph node '${id}' is not code-owned.`);
  const node = value as Record<string, unknown>;
  if (canonicalJson({ ...node, durationUs: 0, frequency: 0, phaseTurnsQ1024: 0, center: 0, amplitude: 0 }) !== canonicalJson({ id, kind: "lissajous-axis-q1024", time: "time", durationUs: 0, frequency: 0, phaseTurnsQ1024: 0, center: 0, amplitude: 0 })) throw new Error(`Data-recipe checkpoint parent graph node '${id}' is not code-owned.`);
  if (node.durationUs !== durationUs || typeof node.frequency !== "number" || !Number.isSafeInteger(node.frequency) || node.frequency < 1 || node.frequency > 16 || typeof node.phaseTurnsQ1024 !== "number" || !Number.isSafeInteger(node.phaseTurnsQ1024) || node.phaseTurnsQ1024 < 0 || node.phaseTurnsQ1024 > 1_023 || typeof node.center !== "number" || typeof node.amplitude !== "number" || Object.is(node.center, -0) || !coordinates(node.center, node.amplitude)) throw new Error(`Data-recipe checkpoint parent graph node '${id}' is outside the code-owned axis bounds.`);
  return { frequency: node.frequency, phaseTurnsQ1024: node.phaseTurnsQ1024, center: node.center, amplitude: node.amplitude };
}
function matchesFrequency(rate: number, durationUs: number): boolean {
  for (let frequency = 1; frequency <= 16; frequency += 1) if (TWO_PI * frequency / durationUs === rate) return true;
  return false;
}
function matchesPhase(phase: number): boolean {
  for (let phaseTurnsQ1024 = 0; phaseTurnsQ1024 <= 1_023; phaseTurnsQ1024 += 1) if (TWO_PI * phaseTurnsQ1024 / 1_024 === phase) return true;
  return false;
}
function coordinates(center: number, amplitude: number): boolean { return Number.isFinite(center) && !Object.is(center, -0) && positive(amplitude, 1_000_000) && Math.abs(center) + amplitude <= 1_000_000; }
function constantPositive(value: { readonly source: string; readonly from: number; readonly to: number }, maximum: number): boolean { return value.source === "constant" && value.from === value.to && positive(value.from, maximum); }
function constantRange(value: { readonly source: string; readonly from: number; readonly to: number }, minimum: number, maximum: number): boolean { return value.source === "constant" && value.from === value.to && Number.isFinite(value.from) && !Object.is(value.from, -0) && value.from >= minimum && value.from <= maximum; }
function positive(value: number, maximum: number): boolean { return Number.isFinite(value) && value > 0 && value <= maximum; }

function readLineage(storyboard: CheckpointStoryboard): DataRecipeCheckpointReport["lineage"] {
  const recipe = storyboard.recipes[0]!;
  return freeze({
    storyboard: freeze({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision, ...(storyboard.parentRevision ? { parentRevision: freeze({ ...storyboard.parentRevision }) } : {}) }),
    transitionRecipe: freeze({ id: recipe.id, sha256: recipe.sha256, revision: recipe.revision, ...(recipe.parentRevision ? { parentRevision: freeze({ ...recipe.parentRevision }) } : {}) }),
  });
}
