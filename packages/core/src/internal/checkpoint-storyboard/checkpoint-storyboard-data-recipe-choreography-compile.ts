import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { quantizeMotionProceduralValue } from "../../procedural-relationship-evaluate";
import { freeze } from "./checkpoint-storyboard-data";
import { createCheckpointStoryboard, compileCheckpointStoryboardPlan } from "./checkpoint-storyboard-records";
import { createTransitionRecipe } from "./checkpoint-storyboard-recipes";
import { admitCheckpointStoryboardScalarSpatialRecordProfile } from "./checkpoint-storyboard-scalar-spatial";
import type { CheckpointStoryboard, TransitionRecipe } from "./checkpoint-storyboard-types";
import { readDataRecipeChoreographyDescriptor } from "./checkpoint-storyboard-data-recipe-choreography-read";
import {
  DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
  DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
  DATA_RECIPE_CHOREOGRAPHY_LIMITS,
  DATA_RECIPE_CHOREOGRAPHY_REPORT_SCHEMA,
  type DataRecipeChoreographyCheckpoint,
  type DataRecipeChoreographyDescriptor,
  type DataRecipeChoreographyObject,
  type DataRecipeChoreographyReport,
} from "./checkpoint-storyboard-data-recipe-choreography-types";

const FULL_MASK = ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] as const;
const SCALAR_MASK = ["transform.rotation", "transform.scale", "opacity"] as const;
const TWO_PI = Math.PI * 2;

/** Lowers one closed orbit choreography into ordinary C6B1 scalar/spatial storyboard data. */
export function compileDataRecipeChoreography(value: unknown, parentStoryboard?: unknown): DataRecipeChoreographyReport {
  const descriptor = readDataRecipeChoreographyDescriptor(value);
  const parent = parentStoryboard === undefined ? undefined : readCompatibleParent(parentStoryboard, descriptor);
  const storyboard = admitCheckpointStoryboardScalarSpatialRecordProfile(buildStoryboard(descriptor, parent));
  const c6aPlan = compileCheckpointStoryboardPlan(storyboard);
  const lineage = readLineage(storyboard);
  const payload = {
    schema: DATA_RECIPE_CHOREOGRAPHY_REPORT_SCHEMA,
    descriptorSha256: canonicalJsonSha256(descriptor),
    formulaId: DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID,
    actionId: DATA_RECIPE_CHOREOGRAPHY_ACTION_ID,
    storyboard,
    c6aPlan,
    lineage,
    evidence: freeze({
      c6b1ScalarSpatialAdmitted: true as const,
      exactFixedCaps: true as const,
      codeOwnedFormula: true as const,
      noIO: true as const,
      noStore: true as const,
      noRenderer: true as const,
      noPublicCoreRoot: true as const,
    }),
  };
  const sha256 = canonicalJsonSha256(payload);
  return freeze({ ...payload, sha256, fingerprint: sha256 });
}

/** Used by the host to prevent a named choreography lineage from escaping into raw C6A revision. */
export function isDataRecipeChoreographyStoryboard(value: unknown): boolean {
  try {
    assertCodeOwnedChoreography(admitCheckpointStoryboardScalarSpatialRecordProfile(value));
    return true;
  } catch {
    return false;
  }
}

function buildStoryboard(descriptor: DataRecipeChoreographyDescriptor, parent?: CheckpointStoryboard): CheckpointStoryboard {
  const parentRecipes = new Map(parent?.recipes.map((recipe) => [recipe.recipeId, recipe]) ?? []);
  const recipes: TransitionRecipe[] = [];
  for (let edgeIndex = 0; edgeIndex < descriptor.checkpoints.length - 1; edgeIndex += 1) {
    const scalarId = recipeId(edgeIndex, "scalar"), spatialId = recipeId(edgeIndex, "spatial");
    recipes.push(createTransitionRecipe({
      recipeId: scalarId,
      seed: derivedSeed(descriptor.recipe.seed, edgeIndex * 2),
      intent: { kind: "checkpoint-keyframe", easing: descriptor.recipe.parameters.scalarEasing, targets: descriptor.objects.map((object) => ({ objectId: object.objectId, propertyMask: SCALAR_MASK })) },
      exactBaseRequirements: [],
      ...(parent ? { parent: parentRecipes.get(scalarId)! } : {}),
    }));
    recipes.push(createTransitionRecipe({
      recipeId: spatialId,
      seed: derivedSeed(descriptor.recipe.seed, edgeIndex * 2 + 1),
      intent: { kind: "checkpoint-spatial-path", targets: descriptor.objects.map((object) => ({ objectId: object.objectId, tangentMode: descriptor.recipe.parameters.spatialTangentMode })) },
      exactBaseRequirements: [],
      ...(parent ? { parent: parentRecipes.get(spatialId)! } : {}),
    }));
  }
  const checkpoints = descriptor.checkpoints.map((checkpoint, index) => ({
    id: checkpointId(index),
    atUs: checkpoint.atUs,
    objects: descriptor.objects.map((object) => objectState(object, checkpoint, descriptor.recipe.parameters.centerX, descriptor.recipe.parameters.centerY)),
  }));
  const edges = descriptor.checkpoints.slice(0, -1).map((_checkpoint, index) => ({
    id: edgeId(index),
    fromCheckpointId: checkpointId(index),
    toCheckpointId: checkpointId(index + 1),
    lifecycle: descriptor.objects.map((object) => ({ kind: "preserve" as const, objectId: object.objectId })),
    recipeIds: [recipeId(index, "scalar"), recipeId(index, "spatial")],
  }));
  return createCheckpointStoryboard({
    seed: descriptor.storyboardSeed,
    capabilityRequirements: [descriptor.requiredCapability],
    objectCatalog: descriptor.objects.map((object) => ({ objectId: object.objectId, rootShapeKind: object.rootShapeKind, propertyMask: FULL_MASK })),
    checkpoints,
    edges,
    recipes,
    ...(parent ? { parent } : {}),
  });
}

function objectState(object: DataRecipeChoreographyObject, checkpoint: DataRecipeChoreographyCheckpoint, centerX: number, centerY: number) {
  const turns = object.phaseTurnsQ1024 + checkpoint.orbitTurnsQ1024;
  const radians = TWO_PI * modulo(turns, 1_024) / 1_024;
  const radius = object.orbitRadius * checkpoint.radiusScaleQ1024 / 1_024;
  const values = [
    centerX + radius * Math.cos(radians),
    centerY + radius * Math.sin(radians),
    turns * 360 / 1_024,
    checkpoint.scaleQ1024 / 1_024,
    checkpoint.opacityQ1024 / 1_024,
  ].map(quantizeMotionProceduralValue);
  return {
    objectId: object.objectId,
    state: "present" as const,
    properties: FULL_MASK.map((property, index) => ({ property, value: values[index]! })),
  };
}

function readCompatibleParent(value: unknown, descriptor: DataRecipeChoreographyDescriptor): CheckpointStoryboard {
  const parent = admitCheckpointStoryboardScalarSpatialRecordProfile(value);
  assertCodeOwnedChoreography(parent, descriptor);
  return parent;
}

function assertCodeOwnedChoreography(storyboard: CheckpointStoryboard, descriptor?: DataRecipeChoreographyDescriptor): void {
  const catalog = storyboard.objectCatalog;
  if (canonicalJson(storyboard.capabilityRequirements) !== canonicalJson(["renderer.browser"]) || catalog.length < 2 || catalog.length > DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxObjects || storyboard.checkpoints.length < 3 || storyboard.checkpoints.length > DATA_RECIPE_CHOREOGRAPHY_LIMITS.maxCheckpoints) throw new Error("Data-recipe choreography parent is not the code-owned bounded profile.");
  if (descriptor && (catalog.length !== descriptor.objects.length || storyboard.checkpoints.length !== descriptor.checkpoints.length)) throw new Error("Data-recipe choreography parent cannot change object or checkpoint topology.");
  if (catalog.some((object, index) => (object.rootShapeKind !== "rect" && object.rootShapeKind !== "ellipse") || canonicalJson(object.propertyMask) !== canonicalJson(FULL_MASK) || (descriptor && (object.objectId !== descriptor.objects[index]?.objectId || object.rootShapeKind !== descriptor.objects[index]?.rootShapeKind)))) throw new Error("Data-recipe choreography parent object catalog is not code-owned for this lineage.");
  const targets = catalog.map((object) => ({ objectId: object.objectId, propertyMask: SCALAR_MASK }));
  for (const [index, checkpoint] of storyboard.checkpoints.entries()) {
    if (checkpoint.id !== checkpointId(index) || checkpoint.objects.some((object) => object.state !== "present" || canonicalJson(object.properties.map((entry) => entry.property)) !== canonicalJson(FULL_MASK))) throw new Error("Data-recipe choreography parent checkpoint topology is not code-owned.");
  }
  const recipeById = new Map(storyboard.recipes.map((recipe) => [recipe.recipeId, recipe]));
  if (storyboard.recipes.length !== (storyboard.checkpoints.length - 1) * 2) throw new Error("Data-recipe choreography parent recipe count is not code-owned.");
  for (let index = 0; index < storyboard.edges.length; index += 1) {
    const edge = storyboard.edges[index]!, scalarId = recipeId(index, "scalar"), spatialId = recipeId(index, "spatial");
    if (edge.id !== edgeId(index) || edge.fromCheckpointId !== checkpointId(index) || edge.toCheckpointId !== checkpointId(index + 1) || canonicalJson(edge.lifecycle) !== canonicalJson(catalog.map((object) => ({ kind: "preserve", objectId: object.objectId }))) || canonicalJson(edge.recipeIds) !== canonicalJson([scalarId, spatialId])) throw new Error("Data-recipe choreography parent edge topology is not code-owned.");
    const scalar = recipeById.get(scalarId), spatial = recipeById.get(spatialId);
    if (!scalar || scalar.intent.kind !== "checkpoint-keyframe" || canonicalJson(scalar.intent.targets) !== canonicalJson(targets) || !spatial || spatial.intent.kind !== "checkpoint-spatial-path" || spatial.intent.targets.some((target, objectIndex) => target.objectId !== catalog[objectIndex]!.objectId || (target.tangentMode !== "linear" && target.tangentMode !== "auto"))) throw new Error("Data-recipe choreography parent recipe topology is not code-owned.");
  }
}

function checkpointId(index: number): string { return `data-recipe-orbit-checkpoint-${String(index).padStart(2, "0")}`; }
function edgeId(index: number): string { return `data-recipe-orbit-edge-${String(index).padStart(2, "0")}`; }
function recipeId(index: number, kind: "scalar" | "spatial"): string { return `data-recipe-orbit-${String(index).padStart(2, "0")}-${kind}`; }
function derivedSeed(seed: number, ordinal: number): number { return (seed + ordinal) % 0x1_0000_0000; }
function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }

function readLineage(storyboard: CheckpointStoryboard): DataRecipeChoreographyReport["lineage"] {
  return freeze({
    storyboard: freeze({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision, ...(storyboard.parentRevision ? { parentRevision: freeze({ ...storyboard.parentRevision }) } : {}) }),
    transitionRecipes: freeze(storyboard.recipes.map((recipe) => freeze({ id: recipe.id, sha256: recipe.sha256, revision: recipe.revision, recipeId: recipe.recipeId, ...(recipe.parentRevision ? { parentRevision: freeze({ ...recipe.parentRevision }) } : {}) }))),
  });
}
