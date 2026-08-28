import { MAX_CHECKPOINT_STORYBOARD_TIME_US } from "./checkpoint-storyboard-types";
import { exactArray, exactRecord, finite, freeze, safeId, snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
import {
  DATA_RECIPE_CHECKPOINT_ACTION_ID,
  DATA_RECIPE_CHECKPOINT_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_LIMITS,
  DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID,
  DATA_RECIPE_CHECKPOINT_SCHEMA,
  type DataRecipeCheckpointDescriptor,
  type DataRecipeCheckpointLineParameters,
  type DataRecipeCheckpointLimits,
  type DataRecipeCheckpointLissajousParameters,
  type DataRecipeCheckpointRoseParameters,
} from "./checkpoint-storyboard-data-recipe-types";

const MAX_COORDINATE = 1_000_000;
const MAX_SPEED_LIMIT = 100_000;

/**
 * Detaches one deliberately small JSON-only descriptor before interpreting a single semantic
 * field. Its recipe has no expression, graph, node, script, callback, path, URL, asset, or
 * renderer escape hatch: unknown fields are refused at every level.
 */
export function readDataRecipeCheckpointDescriptor(value: unknown): DataRecipeCheckpointDescriptor {
  const root = exactRecord(
    snapshotCheckpointStoryboardData(value),
    ["schema", "storyboardSeed", "requiredCapability", "target", "checkpoints", "recipe"],
    [],
    "Data-recipe checkpoint descriptor",
  );
  if (root.schema !== DATA_RECIPE_CHECKPOINT_SCHEMA) throw new Error(`Data-recipe checkpoint descriptor.schema must equal ${DATA_RECIPE_CHECKPOINT_SCHEMA}.`);
  const recipeRecord = exactRecord(root.recipe, ["seed", "formulaId", "actionId", "parameters", "limits"], [], "Data-recipe checkpoint descriptor.recipe");
  const limits = readLimits(recipeRecord.limits);
  const storyboardSeed = uint32(root.storyboardSeed, "Data-recipe checkpoint descriptor.storyboardSeed");
  if (root.requiredCapability !== "renderer.gpu") throw new Error("Data-recipe checkpoint descriptor.requiredCapability must equal renderer.gpu.");
  const target = readTarget(root.target);
  const checkpoints = readCheckpoints(root.checkpoints);
  const seed = uint32(recipeRecord.seed, "Data-recipe checkpoint descriptor.recipe.seed");
  const formulaId = recipeRecord.formulaId;
  if (formulaId !== DATA_RECIPE_CHECKPOINT_FORMULA_ID && formulaId !== DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID) throw new Error(`Data-recipe checkpoint descriptor.recipe.formulaId must equal ${DATA_RECIPE_CHECKPOINT_FORMULA_ID} or ${DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID}.`);
  if (recipeRecord.actionId !== DATA_RECIPE_CHECKPOINT_ACTION_ID) throw new Error(`Data-recipe checkpoint descriptor.recipe.actionId must equal ${DATA_RECIPE_CHECKPOINT_ACTION_ID}.`);
  const recipe = formulaId === DATA_RECIPE_CHECKPOINT_FORMULA_ID
    ? freeze({ seed, formulaId: DATA_RECIPE_CHECKPOINT_FORMULA_ID, actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID, parameters: readLissajousParameters(recipeRecord.parameters, checkpoints[1].atUs), limits })
    : freeze({ seed, formulaId: DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID, actionId: DATA_RECIPE_CHECKPOINT_ACTION_ID, parameters: readRoseParameters(recipeRecord.parameters, checkpoints[1].atUs), limits });
  return freeze({
    schema: DATA_RECIPE_CHECKPOINT_SCHEMA,
    storyboardSeed,
    requiredCapability: "renderer.gpu" as const,
    target,
    checkpoints,
    recipe,
  });
}

function readLimits(value: unknown): DataRecipeCheckpointLimits {
  const record = exactRecord(value, ["maxSamples", "maxVertices", "maxWorkUnits", "maxBytes"], [], "Data-recipe checkpoint descriptor.recipe.limits");
  const expected = DATA_RECIPE_CHECKPOINT_LIMITS;
  if (record.maxSamples !== expected.maxSamples || record.maxVertices !== expected.maxVertices || record.maxWorkUnits !== expected.maxWorkUnits || record.maxBytes !== expected.maxBytes) {
    throw new Error("Data-recipe checkpoint descriptor.recipe.limits must equal the fixed B7 64/64/16384/131072 caps.");
  }
  return freeze({ ...expected }) as DataRecipeCheckpointLimits;
}

function readTarget(value: unknown): DataRecipeCheckpointDescriptor["target"] {
  const record = exactRecord(value, ["objectId", "rootShapeKind"], [], "Data-recipe checkpoint descriptor.target");
  if (record.rootShapeKind !== "rect") throw new Error("Data-recipe checkpoint descriptor.target.rootShapeKind must equal rect.");
  return freeze({ objectId: safeId(record.objectId, "Data-recipe checkpoint descriptor.target.objectId"), rootShapeKind: "rect" as const });
}

function readCheckpoints(value: unknown): DataRecipeCheckpointDescriptor["checkpoints"] {
  const entries = exactArray(value, "Data-recipe checkpoint descriptor.checkpoints", 2, 2);
  const start = readCheckpoint(entries[0], 0), finish = readCheckpoint(entries[1], 1);
  if (start.atUs !== 0) throw new Error("Data-recipe checkpoint descriptor.checkpoints[0].atUs must equal zero.");
  if (finish.atUs <= 0) throw new Error("Data-recipe checkpoint descriptor.checkpoints[1].atUs must be positive.");
  if (start.opacity !== finish.opacity) throw new Error("Data-recipe checkpoint descriptor requires equal present checkpoint opacity.");
  return freeze([
    freeze({ atUs: 0 as const, state: "present" as const, opacity: start.opacity }),
    freeze({ atUs: finish.atUs, state: "present" as const, opacity: finish.opacity }),
  ]) as DataRecipeCheckpointDescriptor["checkpoints"];
}

function readCheckpoint(value: unknown, index: number): { readonly atUs: number; readonly state: "present"; readonly opacity: number } {
  const record = exactRecord(value, ["atUs", "state", "opacity"], [], `Data-recipe checkpoint descriptor.checkpoints[${index}]`);
  if (record.state !== "present") throw new Error(`Data-recipe checkpoint descriptor.checkpoints[${index}].state must equal present.`);
  const atUs = safeDuration(record.atUs, `Data-recipe checkpoint descriptor.checkpoints[${index}].atUs`);
  return freeze({ atUs, state: "present" as const, opacity: finite(record.opacity, `Data-recipe checkpoint descriptor.checkpoints[${index}].opacity`, 0, 1) });
}

function readLissajousParameters(value: unknown, durationUs: number): DataRecipeCheckpointLissajousParameters {
  const record = exactRecord(value, [
    "centerX", "centerY", "amplitudeX", "amplitudeY", "frequencyX", "frequencyY",
    "phaseTurnsQ1024", "sampleCount", "strokeWidth", "strokeOpacity", "luma", "speedLimit",
  ], [], "Data-recipe checkpoint descriptor.recipe.parameters");
  const common = readLineParameters(record, durationUs);
  const amplitudeX = positive(record.amplitudeX, "Data-recipe checkpoint descriptor.recipe.parameters.amplitudeX", MAX_COORDINATE);
  const amplitudeY = positive(record.amplitudeY, "Data-recipe checkpoint descriptor.recipe.parameters.amplitudeY", MAX_COORDINATE);
  if (Math.abs(common.centerX) + amplitudeX > MAX_COORDINATE || Math.abs(common.centerY) + amplitudeY > MAX_COORDINATE) throw new Error(`Data-recipe checkpoint descriptor.recipe.parameters center plus amplitude must remain within +/-${MAX_COORDINATE}.`);
  const frequencyX = integer(record.frequencyX, "Data-recipe checkpoint descriptor.recipe.parameters.frequencyX", 1, 16);
  const frequencyY = integer(record.frequencyY, "Data-recipe checkpoint descriptor.recipe.parameters.frequencyY", 1, 16);
  const phaseTurnsQ1024 = integer(record.phaseTurnsQ1024, "Data-recipe checkpoint descriptor.recipe.parameters.phaseTurnsQ1024", 0, 1_023);
  return freeze({ ...common, amplitudeX, amplitudeY, frequencyX, frequencyY, phaseTurnsQ1024 });
}

function readRoseParameters(value: unknown, durationUs: number): DataRecipeCheckpointRoseParameters {
  const record = exactRecord(value, [
    "centerX", "centerY", "radius", "petals", "rotationTurnsQ1024", "sampleCount",
    "strokeWidth", "strokeOpacity", "luma", "speedLimit",
  ], [], "Data-recipe checkpoint descriptor.recipe.parameters");
  const common = readLineParameters(record, durationUs);
  const radius = positive(record.radius, "Data-recipe checkpoint descriptor.recipe.parameters.radius", MAX_COORDINATE);
  if (Math.abs(common.centerX) + radius > MAX_COORDINATE || Math.abs(common.centerY) + radius > MAX_COORDINATE) throw new Error(`Data-recipe checkpoint descriptor.recipe.parameters center plus radius must remain within +/-${MAX_COORDINATE}.`);
  return freeze({
    ...common,
    radius,
    petals: integer(record.petals, "Data-recipe checkpoint descriptor.recipe.parameters.petals", 2, 16),
    rotationTurnsQ1024: integer(record.rotationTurnsQ1024, "Data-recipe checkpoint descriptor.recipe.parameters.rotationTurnsQ1024", 0, 1_023),
  });
}

function readLineParameters(record: Record<string, unknown>, durationUs: number): DataRecipeCheckpointLineParameters {
  const sampleCount = integer(record.sampleCount, "Data-recipe checkpoint descriptor.recipe.parameters.sampleCount", 2, 64);
  if (durationUs % (sampleCount - 1) !== 0) throw new Error("Data-recipe checkpoint descriptor duration must be divisible by sampleCount - 1.");
  return freeze({
    centerX: finite(record.centerX, "Data-recipe checkpoint descriptor.recipe.parameters.centerX", -MAX_COORDINATE, MAX_COORDINATE),
    centerY: finite(record.centerY, "Data-recipe checkpoint descriptor.recipe.parameters.centerY", -MAX_COORDINATE, MAX_COORDINATE),
    sampleCount,
    strokeWidth: positive(record.strokeWidth, "Data-recipe checkpoint descriptor.recipe.parameters.strokeWidth", MAX_COORDINATE),
    strokeOpacity: positive(record.strokeOpacity, "Data-recipe checkpoint descriptor.recipe.parameters.strokeOpacity", 1),
    luma: finite(record.luma, "Data-recipe checkpoint descriptor.recipe.parameters.luma", 0, 1),
    speedLimit: positive(record.speedLimit, "Data-recipe checkpoint descriptor.recipe.parameters.speedLimit", MAX_SPEED_LIMIT),
  });
}

function safeDuration(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_CHECKPOINT_STORYBOARD_TIME_US) throw new Error(`${label} must be a safe integer microsecond in 0..${MAX_CHECKPOINT_STORYBOARD_TIME_US}.`);
  return Object.is(value, -0) ? 0 : value;
}
function uint32(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${label} must be a uint32.`);
  return Object.is(value, -0) ? 0 : value;
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}
function positive(value: unknown, label: string, maximum: number): number {
  const result = finite(value, label, Number.MIN_VALUE, maximum);
  if (result <= 0) throw new Error(`${label} must be positive.`);
  return result;
}
