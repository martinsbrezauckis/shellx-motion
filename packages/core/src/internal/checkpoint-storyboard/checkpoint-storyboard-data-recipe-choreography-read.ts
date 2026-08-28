import { exactArray, exactRecord, finite, freeze, safeId, snapshotCheckpointStoryboardData, strictIds } from "./checkpoint-storyboard-data";
import { MAX_CHECKPOINT_STORYBOARD_TIME_US } from "./checkpoint-storyboard-types";
import {
  DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
  DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
  DATA_RECIPE_CHOREOGRAPHY_LIMITS,
  DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
  type DataRecipeChoreographyCheckpoint,
  type DataRecipeChoreographyDescriptor,
  type DataRecipeChoreographyLimits,
  type DataRecipeChoreographyObject,
} from "./checkpoint-storyboard-data-recipe-choreography-types";

const MAX_COORDINATE = 1_000_000;

/** Reads one closed multi-object/multi-checkpoint formula descriptor before any store access. */
export function readDataRecipeChoreographyDescriptor(value: unknown): DataRecipeChoreographyDescriptor {
  const root = exactRecord(
    snapshotCheckpointStoryboardData(value),
    ["schema", "storyboardSeed", "requiredCapability", "objects", "checkpoints", "recipe"],
    [],
    "Data-recipe choreography descriptor",
  );
  if (root.schema !== DATA_RECIPE_CHOREOGRAPHY_SCHEMA) throw new Error(`Data-recipe choreography descriptor.schema must equal ${DATA_RECIPE_CHOREOGRAPHY_SCHEMA}.`);
  if (root.requiredCapability !== "renderer.browser") throw new Error("Data-recipe choreography descriptor.requiredCapability must equal renderer.browser.");
  const objects = readObjects(root.objects);
  const checkpoints = readCheckpoints(root.checkpoints);
  const recipe = readRecipe(root.recipe);
  assertCoordinateBounds(objects, checkpoints, recipe.parameters.centerX, recipe.parameters.centerY);
  return freeze({
    schema: DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
    storyboardSeed: uint32(root.storyboardSeed, "Data-recipe choreography descriptor.storyboardSeed"),
    requiredCapability: "renderer.browser" as const,
    objects,
    checkpoints,
    recipe,
  });
}

function readObjects(value: unknown): readonly DataRecipeChoreographyObject[] {
  const objects = exactArray(value, "Data-recipe choreography descriptor.objects", DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxObjects, 2).map((item, index) => {
    const label = `Data-recipe choreography descriptor.objects[${index}]`;
    const record = exactRecord(item, ["objectId", "rootShapeKind", "orbitRadius", "phaseTurnsQ1024"], [], label);
    if (record.rootShapeKind !== "rect" && record.rootShapeKind !== "ellipse") throw new Error(`${label}.rootShapeKind must equal rect or ellipse.`);
    return freeze({
      objectId: safeId(record.objectId, `${label}.objectId`),
      rootShapeKind: record.rootShapeKind as "rect" | "ellipse",
      orbitRadius: positive(record.orbitRadius, `${label}.orbitRadius`, MAX_COORDINATE),
      phaseTurnsQ1024: integer(record.phaseTurnsQ1024, `${label}.phaseTurnsQ1024`, 0, 1_023),
    });
  });
  strictIds(objects.map((object) => object.objectId), "Data-recipe choreography object ids");
  return freeze(objects);
}

function readCheckpoints(value: unknown): readonly DataRecipeChoreographyCheckpoint[] {
  const checkpoints = exactArray(value, "Data-recipe choreography descriptor.checkpoints", DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxCheckpoints, 3).map((item, index) => {
    const label = `Data-recipe choreography descriptor.checkpoints[${index}]`;
    const record = exactRecord(item, ["atUs", "orbitTurnsQ1024", "radiusScaleQ1024", "scaleQ1024", "opacityQ1024"], [], label);
    const atUs = safeUs(record.atUs, `${label}.atUs`);
    if (atUs % 1_000 !== 0) throw new Error(`${label}.atUs must be whole-millisecond microseconds.`);
    return freeze({
      atUs,
      orbitTurnsQ1024: integer(record.orbitTurnsQ1024, `${label}.orbitTurnsQ1024`, -16_384, 16_384),
      radiusScaleQ1024: integer(record.radiusScaleQ1024, `${label}.radiusScaleQ1024`, 1, 4_096),
      scaleQ1024: integer(record.scaleQ1024, `${label}.scaleQ1024`, 2, 4_096),
      opacityQ1024: integer(record.opacityQ1024, `${label}.opacityQ1024`, 0, 1_024),
    });
  });
  if (checkpoints[0]!.atUs !== 0) throw new Error("Data-recipe choreography descriptor.checkpoints[0].atUs must equal zero.");
  if (checkpoints.some((checkpoint, index) => index > 0 && checkpoints[index - 1]!.atUs >= checkpoint.atUs)) throw new Error("Data-recipe choreography checkpoints must be strictly time-ordered.");
  return freeze(checkpoints);
}

function readRecipe(value: unknown): DataRecipeChoreographyDescriptor["recipe"] {
  const record = exactRecord(value, ["seed", "formulaId", "actionId", "parameters", "limits"], [], "Data-recipe choreography descriptor.recipe");
  if (record.formulaId !== DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID) throw new Error(`Data-recipe choreography descriptor.recipe.formulaId must equal ${DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID}.`);
  if (record.actionId !== DATA_RECIPE_CHOREOGRAPHY_ACTION_ID) throw new Error(`Data-recipe choreography descriptor.recipe.actionId must equal ${DATA_RECIPE_CHOREOGRAPHY_ACTION_ID}.`);
  const parameters = exactRecord(record.parameters, ["centerX", "centerY", "spatialTangentMode", "scalarEasing"], [], "Data-recipe choreography descriptor.recipe.parameters");
  if (parameters.spatialTangentMode !== "linear" && parameters.spatialTangentMode !== "auto") throw new Error("Data-recipe choreography descriptor.recipe.parameters.spatialTangentMode must equal linear or auto.");
  if (parameters.scalarEasing !== "linear" && parameters.scalarEasing !== "ease-in" && parameters.scalarEasing !== "ease-out" && parameters.scalarEasing !== "ease-in-out") throw new Error("Data-recipe choreography descriptor.recipe.parameters.scalarEasing is not admitted.");
  return freeze({
    seed: uint32(record.seed, "Data-recipe choreography descriptor.recipe.seed"),
    formulaId: DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
    actionId: DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
    parameters: freeze({
      centerX: finite(parameters.centerX, "Data-recipe choreography descriptor.recipe.parameters.centerX", -MAX_COORDINATE, MAX_COORDINATE),
      centerY: finite(parameters.centerY, "Data-recipe choreography descriptor.recipe.parameters.centerY", -MAX_COORDINATE, MAX_COORDINATE),
      spatialTangentMode: parameters.spatialTangentMode,
      scalarEasing: parameters.scalarEasing,
    }),
    limits: readLimits(record.limits),
  });
}

function readLimits(value: unknown): DataRecipeChoreographyLimits {
  const record = exactRecord(value, ["maxObjects", "maxCheckpoints", "maxRecipes", "maxWorkUnits", "maxBytes"], [], "Data-recipe choreography descriptor.recipe.limits");
  const expected = DATA_RECIPE_CHOREOGRAPHY_LIMITS;
  if (record.maxObjects !== expected.maxObjects || record.maxCheckpoints !== expected.maxCheckpoints || record.maxRecipes !== expected.maxRecipes || record.maxWorkUnits !== expected.maxWorkUnits || record.maxBytes !== expected.maxBytes) throw new Error("Data-recipe choreography descriptor.recipe.limits must equal the fixed 8/8/14/16384/262144 caps.");
  return freeze({ ...expected }) as DataRecipeChoreographyLimits;
}

function assertCoordinateBounds(objects: readonly DataRecipeChoreographyObject[], checkpoints: readonly DataRecipeChoreographyCheckpoint[], centerX: number, centerY: number): void {
  for (const object of objects) for (const checkpoint of checkpoints) {
    const radius = object.orbitRadius * checkpoint.radiusScaleQ1024 / 1_024;
    if (!Number.isFinite(radius) || Math.abs(centerX) + radius > MAX_COORDINATE || Math.abs(centerY) + radius > MAX_COORDINATE) throw new Error(`Data-recipe choreography object '${object.objectId}' exceeds the coordinate bounds at ${checkpoint.atUs}us.`);
  }
}

function safeUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_CHECKPOINT_STORYBOARD_TIME_US) throw new Error(`${label} must be a safe integer microsecond in 0..${MAX_CHECKPOINT_STORYBOARD_TIME_US}.`);
  return Object.is(value, -0) ? 0 : value;
}
function uint32(value: unknown, label: string): number { return integer(value, label, 0, 0xffff_ffff); }
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}
function positive(value: unknown, label: string, maximum: number): number {
  const result = finite(value, label, Number.MIN_VALUE, maximum);
  if (result <= 0) throw new Error(`${label} must be positive.`);
  return result;
}
