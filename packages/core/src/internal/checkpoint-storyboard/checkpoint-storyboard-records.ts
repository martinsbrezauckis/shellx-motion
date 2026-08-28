import { RENDERER_CAPABILITY_CARDS } from "../../capability-cards";
import { canonicalJsonSha256 } from "../../canonical-json";
import { evaluateMotionShapeGeometryKeyframes, readMotionShapeGeometryKeyframe } from "../../motion-shape-geometry-keyframes";
import {
  CHECKPOINT_ROOT_SHAPE_KINDS, CHECKPOINT_STORYBOARD_BUDGET, CHECKPOINT_STORYBOARD_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_SHAPE_CREATION_SCHEMA,
  CHECKPOINT_STORYBOARD_SCHEMA, MAX_CHECKPOINT_STORYBOARD_CHECKPOINTS, MAX_CHECKPOINT_STORYBOARD_EDGES,
  MAX_CHECKPOINT_STORYBOARD_OBJECTS, MAX_CHECKPOINT_STORYBOARD_RECIPES, MAX_CHECKPOINT_STORYBOARD_SEED,
  MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES, MAX_CHECKPOINT_STORYBOARD_TIME_US, MAX_CHECKPOINT_STORYBOARD_WORK_UNITS,
  type Checkpoint, type CheckpointEdge, type CheckpointGeometryObjectState, type CheckpointLifecycleMapping, type CheckpointObjectState, type CheckpointProperty,
  type CheckpointObjectCatalogEntry, type CheckpointStoryboard, type CheckpointStoryboardDescriptor, type CheckpointStoryboardPlan,
  type TransitionRecipe,
} from "./checkpoint-storyboard-types";
import { readTransitionRecipe } from "./checkpoint-storyboard-recipes";
import {
  assertSealed, exactArray, exactRecord, finite, freeze, safeId, sealed, snapshotCheckpointStoryboardData,
  storageBytes, strictIds,
} from "./checkpoint-storyboard-data";

const PROPERTY_ORDER: readonly CheckpointProperty[] = ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"];
const PROPERTY_SET = new Set<CheckpointProperty>(PROPERTY_ORDER);
const CAPABILITY_IDS = new Set(RENDERER_CAPABILITY_CARDS.map((card) => card.id));

export function createCheckpointStoryboard(value: unknown): CheckpointStoryboard {
  const descriptor = readCheckpointStoryboardDescriptor(value), parent = descriptor.parent ? readCheckpointStoryboard(descriptor.parent) : undefined;
  const revisionValue = parent ? parent.revision + 1 : 1;
  if (revisionValue > 1_000_000) throw new Error("CheckpointStoryboard revision exceeds the 1000000-revision limit.");
  const base = basePayload(descriptor, parent, revisionValue), budget = storyboardBudget(base);
  const identity = sealed("checkpoint_storyboard", { ...base, budget });
  return freeze({ ...base, budget, ...identity }) as CheckpointStoryboard;
}

export function readCheckpointStoryboard(value: unknown): CheckpointStoryboard {
  const record = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "id", "sha256", "revision", "seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes", "budget"], ["parentRevision"], "CheckpointStoryboard");
  if (record.schema !== CHECKPOINT_STORYBOARD_SCHEMA) throw new Error(`CheckpointStoryboard.schema must equal ${CHECKPOINT_STORYBOARD_SCHEMA}.`);
  const descriptor = readDescriptorRecord(record), revisionValue = revision(record.revision, "CheckpointStoryboard.revision"), parentRevision = Object.hasOwn(record, "parentRevision") ? readStoryboardIdentity(record.parentRevision, "CheckpointStoryboard.parentRevision") : undefined;
  if (revisionValue === 1 && parentRevision) throw new Error("CheckpointStoryboard revision 1 must not declare parentRevision.");
  if (revisionValue > 1 && !parentRevision) throw new Error("CheckpointStoryboard revision greater than 1 requires parentRevision.");
  const base = basePayload(descriptor, undefined, revisionValue, parentRevision), expectedBudget = storyboardBudget(base);
  if (!sameBudget(record.budget, expectedBudget)) throw new Error("CheckpointStoryboard.budget is stale.");
  assertSealed("checkpoint_storyboard", record, { ...base, budget: expectedBudget });
  return freeze({ ...base, budget: expectedBudget, id: record.id as string, sha256: record.sha256 as string }) as CheckpointStoryboard;
}

export function readCheckpointStoryboardDescriptor(value: unknown): CheckpointStoryboardDescriptor {
  const record = exactRecord(snapshotCheckpointStoryboardData(value), ["seed", "capabilityRequirements", "objectCatalog", "checkpoints", "edges", "recipes"], ["parent"], "CheckpointStoryboardDescriptor");
  const descriptor = readDescriptorRecord(record);
  return freeze({ ...descriptor, ...(Object.hasOwn(record, "parent") ? { parent: readCheckpointStoryboard(record.parent) } : {}) });
}

/** Binds only immutable C6A records. It never dereferences a package, provider, renderer, or model. */
export function compileCheckpointStoryboardPlan(value: unknown): CheckpointStoryboardPlan {
  const storyboard = readCheckpointStoryboard(value);
  const edges = storyboard.edges.map((edge) => freeze({
    id: edge.id, fromCheckpointId: edge.fromCheckpointId, toCheckpointId: edge.toCheckpointId,
    recipeIds: edge.recipeIds, workUnits: edge.recipeIds.reduce((total, recipeId) => total + storyboard.recipes.find((recipe) => recipe.recipeId === recipeId)!.budget.workUnits, 0),
  }));
  const budget = freeze({
    checkpointCount: storyboard.checkpoints.length,
    objectStateCount: storyboard.checkpoints.reduce((total, checkpoint) => total + checkpoint.objects.length, 0),
    edgeCount: storyboard.edges.length, recipeCount: storyboard.recipes.length,
    workUnits: edges.reduce((total, edge) => total + edge.workUnits, 0), storageBytes: storyboard.budget.storageBytes,
    limits: CHECKPOINT_STORYBOARD_BUDGET,
  });
  const exactBaseRequirements = freeze(storyboard.recipes.flatMap((recipe) => recipe.exactBaseRequirements));
  const payload = {
    schema: CHECKPOINT_STORYBOARD_PLAN_SCHEMA, storyboard: freeze({ id: storyboard.id, sha256: storyboard.sha256 }),
    capabilityRequirements: storyboard.capabilityRequirements, exactBaseRequirements, edges: freeze(edges), budget,
    evidence: freeze({ noRenderer: true as const, noArbitraryTimeEvaluation: true as const, unresolvedExactBaseRequirements: true as const }),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function readDescriptorRecord(record: Record<string, unknown>): CheckpointStoryboardDescriptor {
  if (typeof record.seed !== "number" || !Number.isSafeInteger(record.seed) || record.seed < 0 || record.seed > MAX_CHECKPOINT_STORYBOARD_SEED) throw new Error(`CheckpointStoryboard.seed must be a safe integer in 0..${MAX_CHECKPOINT_STORYBOARD_SEED}.`);
  const capabilityRequirements = exactArray(record.capabilityRequirements, "CheckpointStoryboard.capabilityRequirements", 16).map((item, index) => {
    if (typeof item !== "string" || !CAPABILITY_IDS.has(item)) throw new Error(`CheckpointStoryboard.capabilityRequirements[${index}] must be a canonical capability-card id.`);
    return item;
  });
  strictIds(capabilityRequirements, "CheckpointStoryboard.capabilityRequirements");
  const objectCatalog = readObjectCatalog(record.objectCatalog), checkpoints = readCheckpoints(record.checkpoints, objectCatalog), recipes = readRecipes(record.recipes), edges = readEdges(record.edges);
  validateEdges(checkpoints, recipes, edges);
  const totalWork = edges.reduce((total, edge) => total + edge.recipeIds.reduce((sum, recipeId) => sum + recipes.find((recipe) => recipe.recipeId === recipeId)!.budget.workUnits, 0), 0);
  if (!Number.isSafeInteger(totalWork) || totalWork > MAX_CHECKPOINT_STORYBOARD_WORK_UNITS) throw new Error(`CheckpointStoryboard exceeds the ${MAX_CHECKPOINT_STORYBOARD_WORK_UNITS}-work-unit limit.`);
  return freeze({ seed: record.seed, capabilityRequirements: freeze(capabilityRequirements), objectCatalog, checkpoints, edges, recipes });
}

function readObjectCatalog(value: unknown): readonly CheckpointObjectCatalogEntry[] {
  const catalog = exactArray(value, "CheckpointStoryboard.objectCatalog", MAX_CHECKPOINT_STORYBOARD_OBJECTS, 1).map((item, index) => {
    const label = `CheckpointStoryboard.objectCatalog[${index}]`;
    const record = exactRecord(item, ["objectId", "rootShapeKind", "propertyMask"], ["creation"], label);
    if (typeof record.rootShapeKind !== "string" || !CHECKPOINT_ROOT_SHAPE_KINDS.includes(record.rootShapeKind as never)) throw new Error(`CheckpointStoryboard.objectCatalog[${index}].rootShapeKind is not an admitted root-shape kind.`);
    const objectId = safeId(record.objectId, `${label}.objectId`);
    if (record.rootShapeKind === "geometry") {
      if (Object.hasOwn(record, "creation")) throw new Error(`${label}.geometry catalog entries do not admit scalar shape creation facts.`);
      const propertyMask = readMask(record.propertyMask, `${label}.propertyMask`, 0);
      if (propertyMask.length !== 0) throw new Error(`${label}.geometry catalog entries require an empty scalar propertyMask.`);
      return freeze({ objectId, rootShapeKind: "geometry" as const, propertyMask: freeze([]) as [] });
    }
    const creation = Object.hasOwn(record, "creation") ? readCreation(record.creation, `${label}.creation`) : undefined;
    return freeze({ objectId, rootShapeKind: record.rootShapeKind as Exclude<CheckpointObjectCatalogEntry["rootShapeKind"], "geometry">, propertyMask: readMask(record.propertyMask, `${label}.propertyMask`, 1), ...(creation ? { creation } : {}) });
  });
  strictIds(catalog.map((object) => object.objectId), "CheckpointStoryboard.objectCatalog object ids"); return freeze(catalog);
}

function readCreation(value: unknown, label: string) {
  const record = exactRecord(value, ["schema", "fill", "width", "height"], [], label);
  if (record.schema !== CHECKPOINT_STORYBOARD_SHAPE_CREATION_SCHEMA) throw new Error(`${label}.schema must equal ${CHECKPOINT_STORYBOARD_SHAPE_CREATION_SCHEMA}.`);
  if (typeof record.fill !== "string" || !/^#[0-9a-f]{6}$/.test(record.fill)) throw new Error(`${label}.fill must be lowercase #rrggbb.`);
  return freeze({ schema: CHECKPOINT_STORYBOARD_SHAPE_CREATION_SCHEMA, fill: record.fill, width: finite(record.width, `${label}.width`, 1, 1_000_000), height: finite(record.height, `${label}.height`, 1, 1_000_000) });
}

function readCheckpoints(value: unknown, catalog: readonly CheckpointObjectCatalogEntry[]): readonly Checkpoint[] {
  const checkpoints = exactArray(value, "CheckpointStoryboard.checkpoints", MAX_CHECKPOINT_STORYBOARD_CHECKPOINTS, 2).map((item, index) => {
    const record = exactRecord(item, ["id", "atUs", "objects"], [], `CheckpointStoryboard.checkpoints[${index}]`), objects = readObjects(record.objects, index, catalog);
    return freeze({ id: safeId(record.id, `CheckpointStoryboard.checkpoints[${index}].id`), atUs: safeUs(record.atUs, `CheckpointStoryboard.checkpoints[${index}].atUs`), objects });
  });
  const ids = checkpoints.map((checkpoint) => checkpoint.id); if (new Set(ids).size !== ids.length) throw new Error("CheckpointStoryboard checkpoint ids must be unique.");
  if (checkpoints.some((checkpoint, index) => index > 0 && checkpoints[index - 1]!.atUs >= checkpoint.atUs)) throw new Error("CheckpointStoryboard checkpoints must be in strictly increasing safe-integer microsecond time.");
  return freeze(checkpoints);
}

function readObjects(value: unknown, checkpointIndex: number, catalog: readonly CheckpointObjectCatalogEntry[]) {
  const objects = exactArray(value, `CheckpointStoryboard.checkpoints[${checkpointIndex}].objects`, MAX_CHECKPOINT_STORYBOARD_OBJECTS, catalog.length).map((item, index) => {
    const label = `CheckpointStoryboard.checkpoints[${checkpointIndex}].objects[${index}]`;
    const expected = catalog[index];
    if (!expected) throw new Error(`${label}.objectId must follow the complete sorted object catalog.`);
    const record = exactRecord(item, ["objectId", "state", "properties"], expected.rootShapeKind === "geometry" ? ["geometry"] : [], label);
    if (!expected || record.objectId !== expected.objectId) throw new Error(`${label}.objectId must follow the complete sorted object catalog.`);
    const state = record.state;
    if (state !== "present" && state !== "absent") throw new Error(`${label}.state must be present or absent.`);
    if (state === "absent") {
      exactRecord(item, ["objectId", "state", "properties"], [], label);
      const properties = exactArray(record.properties, `${label}.properties`, 0, 0);
      return freeze({ objectId: expected.objectId, state: "absent" as const, properties: freeze(properties) as [] });
    }
    if (expected.rootShapeKind === "geometry") {
      const geometryRecord = exactRecord(item, ["objectId", "state", "properties", "geometry"], [], label);
      const properties = exactArray(geometryRecord.properties, `${label}.properties`, 0, 0);
      return freeze({ objectId: expected.objectId, state: "present" as const, properties: freeze(properties) as [], geometry: readCheckpointGeometry(geometryRecord.geometry, `${label}.geometry`) });
    }
    exactRecord(item, ["objectId", "state", "properties"], [], label);
    const rawProperties = exactArray(record.properties, `${label}.properties`, PROPERTY_ORDER.length);
    if (rawProperties.length !== expected.propertyMask.length) throw new Error(`${label}.properties must exactly follow the fixed catalog propertyMask.`);
    const properties = rawProperties.map((property, propertyIndex) => {
      const entry = exactRecord(property, ["property", "value"], [], `${label}.properties[${propertyIndex}]`);
      if (entry.property !== expected.propertyMask[propertyIndex]) throw new Error(`${label}.properties must exactly follow the fixed catalog propertyMask.`);
      return freeze({ property: entry.property as CheckpointProperty, value: propertyValue(entry.property as CheckpointProperty, entry.value, `${label}.properties[${propertyIndex}].value`) });
    });
    return freeze({ objectId: expected.objectId, state: "present" as const, properties: freeze(properties) });
  });
  if (objects.length !== catalog.length) throw new Error(`CheckpointStoryboard.checkpoints[${checkpointIndex}] must contain one row for every catalog object.`);
  return freeze(objects);
}

function readCheckpointGeometry(value: unknown, label: string) {
  try {
    return readMotionShapeGeometryKeyframe({ atUs: 0, geometry: value }).geometry;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid geometry";
    throw new Error(`${label} is not a closed MotionShapeGeometry: ${detail}`);
  }
}

function readRecipes(value: unknown): readonly TransitionRecipe[] {
  const recipes = exactArray(value, "CheckpointStoryboard.recipes", MAX_CHECKPOINT_STORYBOARD_RECIPES).map((item) => readTransitionRecipe(item));
  strictIds(recipes.map((recipe) => recipe.recipeId), "CheckpointStoryboard recipe ids"); return freeze(recipes);
}

function readEdges(value: unknown): readonly CheckpointEdge[] {
  const edges = exactArray(value, "CheckpointStoryboard.edges", MAX_CHECKPOINT_STORYBOARD_EDGES, 1).map((item, index) => {
    const label = `CheckpointStoryboard.edges[${index}]`, record = exactRecord(item, ["id", "fromCheckpointId", "toCheckpointId", "lifecycle", "recipeIds"], [], label);
    const lifecycle = exactArray(record.lifecycle, `${label}.lifecycle`, MAX_CHECKPOINT_STORYBOARD_OBJECTS).map((entry, mappingIndex) => readLifecycle(entry, `${label}.lifecycle[${mappingIndex}]`));
    strictIds(lifecycle.map((mapping) => mapping.objectId), `${label}.lifecycle object ids`);
    const recipeIds = exactArray(record.recipeIds, `${label}.recipeIds`, MAX_CHECKPOINT_STORYBOARD_RECIPES).map((entry, recipeIndex) => safeId(entry, `${label}.recipeIds[${recipeIndex}]`));
    strictIds(recipeIds, `${label}.recipeIds`);
    return freeze({ id: safeId(record.id, `${label}.id`), fromCheckpointId: safeId(record.fromCheckpointId, `${label}.fromCheckpointId`), toCheckpointId: safeId(record.toCheckpointId, `${label}.toCheckpointId`), lifecycle: freeze(lifecycle), recipeIds: freeze(recipeIds) });
  });
  strictIds(edges.map((edge) => edge.id), "CheckpointStoryboard edge ids"); return freeze(edges);
}

function readLifecycle(value: unknown, label: string): CheckpointLifecycleMapping {
  const start = exactRecord(value, ["kind"], ["objectId"], label);
  if (start.kind === "morph") throw new Error("C6A explicitly refuses morph because no closed compatible-geometry rule exists.");
  const record = exactRecord(value, ["kind", "objectId"], [], label), objectId = safeId(record.objectId, `${label}.objectId`);
  if (record.kind !== "preserve" && record.kind !== "create" && record.kind !== "remove") throw new Error(`${label}.kind must be preserve, create, or remove.`);
  return freeze({ kind: record.kind, objectId }) as CheckpointLifecycleMapping;
}

function validateEdges(checkpoints: readonly Checkpoint[], recipes: readonly TransitionRecipe[], edges: readonly CheckpointEdge[]): void {
  const recipeById = new Map(recipes.map((recipe) => [recipe.recipeId, recipe]));
  if (edges.length !== checkpoints.length - 1) throw new Error("CheckpointStoryboard requires exactly checkpoints.length - 1 consecutive edges.");
  assertNoRecreate(checkpoints);
  const assignedRecipeIds = new Set<string>();
  for (const [index, edge] of edges.entries()) {
    const from = checkpoints[index]!, to = checkpoints[index + 1]!;
    if (edge.fromCheckpointId !== from.id || edge.toCheckpointId !== to.id) throw new Error(`Checkpoint edge '${edge.id}' must uniquely bind consecutive checkpoint ${index} to ${index + 1}.`);
    if (edge.recipeIds.some((id) => !recipeById.has(id))) throw new Error(`Checkpoint edge '${edge.id}' references an unknown recipe id.`);
    if (edge.recipeIds.some((id) => assignedRecipeIds.has(id))) throw new Error(`Checkpoint edge '${edge.id}' reuses a recipe across edges before recipe identity binds an edge.`);
    edge.recipeIds.forEach((id) => assignedRecipeIds.add(id));
    const expected = lifecycleFor(from, to);
    if (edge.lifecycle.length !== expected.length || edge.lifecycle.some((mapping, index) => mapping.kind !== expected[index]!.kind || mapping.objectId !== expected[index]!.objectId)) throw new Error(`Checkpoint edge '${edge.id}' lifecycle must explicitly and exactly map preserve/create/remove object ids.`);
    const writes = new Set<string>(), geometryWrites = new Set<string>();
    for (const recipeId of edge.recipeIds) validateRecipeForEdge(recipeById.get(recipeId)!, from, to, writes, geometryWrites, edge.id);
    for (const source of from.objects) {
      const destination = to.objects.find((object) => object.objectId === source.objectId)!;
      if (source.state !== "present" || destination.state !== "present") continue;
      for (const property of source.properties) if (property.value !== destination.properties.find((candidate) => candidate.property === property.property)!.value && !writes.has(`${source.objectId}\u0000${property.property}`)) throw new Error(`Checkpoint edge '${edge.id}' changes ${source.objectId}.${property.property} without exactly one owning recipe.`);
      if (isGeometryObjectState(source) || isGeometryObjectState(destination)) {
        if (!isGeometryObjectState(source) || !isGeometryObjectState(destination)) throw new Error(`Checkpoint edge '${edge.id}' must preserve the geometry state shape for '${source.objectId}'.`);
        if (canonicalJsonSha256(source.geometry) !== canonicalJsonSha256(destination.geometry) && !geometryWrites.has(source.objectId)) throw new Error(`Checkpoint edge '${edge.id}' changes ${source.objectId}.geometry without exactly one owning geometry recipe.`);
      }
    }
  }
  if (assignedRecipeIds.size !== recipes.length) throw new Error("CheckpointStoryboard requires every recipe to be assigned to exactly one edge.");
}

function lifecycleFor(from: Checkpoint, to: Checkpoint): readonly CheckpointLifecycleMapping[] {
  return freeze(from.objects.map((source, index) => {
    const target = to.objects[index]!;
    return freeze({ kind: source.state === "present" ? target.state === "present" ? "preserve" : "remove" : target.state === "present" ? "create" : "preserve", objectId: source.objectId }) as CheckpointLifecycleMapping;
  }));
}

function validateRecipeForEdge(recipe: TransitionRecipe, from: Checkpoint, to: Checkpoint, writes: Set<string>, geometryWrites: Set<string>, edgeId: string): void {
  const both = new Map(from.objects.filter((object, index) => object.state === "present" && to.objects[index]!.state === "present").map((object) => [object.objectId, object]));
  const target = new Map(to.objects.filter((object) => object.state === "present").map((object) => [object.objectId, object]));
  const requireBoth = (objectId: string, mask: readonly CheckpointProperty[]) => {
    const source = both.get(objectId), destination = to.objects.find((object) => object.objectId === objectId);
    if (!source || !destination || mask.some((property) => !source.properties.some((entry) => entry.property === property) || !destination.properties.some((entry) => entry.property === property))) throw new Error(`Recipe '${recipe.recipeId}' requires preserved object '${objectId}' with its declared property mask on edge '${edgeId}'.`);
    for (const property of mask) { const key = `${objectId}\u0000${property}`; if (writes.has(key)) throw new Error(`Recipe '${recipe.recipeId}' conflicts with another recipe on ${objectId}.${property} in edge '${edgeId}'.`); writes.add(key); }
  };
  const requireGeometryBoth = (objectId: string) => {
    const source = both.get(objectId), destination = to.objects.find((object) => object.objectId === objectId);
    if (!source || !destination || !isGeometryObjectState(source) || !isGeometryObjectState(destination)) throw new Error(`Geometry recipe '${recipe.recipeId}' requires preserved geometry object '${objectId}' on edge '${edgeId}'.`);
    const compatibility = evaluateMotionShapeGeometryKeyframes({
      schema: "shellx-motion/shape-geometry-keyframes@1",
      atUs: from.atUs,
      keyframes: [
        { atUs: from.atUs, geometry: source.geometry, easing: "linear" },
        { atUs: to.atUs, geometry: destination.geometry },
      ],
    });
    if (!compatibility.ok) throw new Error(`Geometry recipe '${recipe.recipeId}' requires compatible fixed-topology geometry for '${objectId}' on edge '${edgeId}': ${compatibility.message}`);
    if (geometryWrites.has(objectId)) throw new Error(`Geometry recipe '${recipe.recipeId}' conflicts with another geometry recipe on ${objectId} in edge '${edgeId}'.`);
    geometryWrites.add(objectId);
  };
  const intent = recipe.intent;
  if (intent.kind === "checkpoint-keyframe") return void (requireMillisecondResolution(recipe, from, to), intent.targets.forEach((item) => requireBoth(item.objectId, item.propertyMask)));
  if (intent.kind === "checkpoint-spatial-path") return void (requireMillisecondResolution(recipe, from, to), intent.targets.forEach((item) => requireBoth(item.objectId, ["transform.x", "transform.y"])));
  if (intent.kind === "checkpoint-geometry-morph") return void intent.targets.forEach((item) => requireGeometryBoth(item.objectId));
  if (intent.kind === "transform-behavior") return requireBoth(intent.targetObjectId, intent.behavior.kind === "gravity" ? ["transform.x", "transform.y"] : ["transform.y"]);
  if (intent.kind === "relation") return void (requireMillisecondResolution(recipe, from, to), [intent.sourceObjectId, intent.targetObjectId].forEach((objectId) => { if (!both.has(objectId)) throw new Error(`Relation recipe '${recipe.recipeId}' requires preserved object '${objectId}' on edge '${edgeId}'.`); }), requireBoth(intent.targetObjectId, intent.relationKind === "aim" ? ["transform.rotation"] : intent.relationKind === "follow" ? ["transform.x", "transform.y"] : ["transform.x", "transform.y", "transform.rotation", "transform.scale"]));
  if (intent.kind === "relation-action") return void (requireMillisecondResolution(recipe, from, to), intent.roleBindings.forEach((binding) => { if (!both.has(binding.objectId)) throw new Error(`Relation-action recipe '${recipe.recipeId}' has non-preserved role object '${binding.objectId}' on edge '${edgeId}'.`); }), intent.declaredWrites.forEach((item) => requireBoth(item.objectId, item.propertyMask)));
  if (!target.has(intent.outputObjectId)) throw new Error(`Parametric-trace recipe '${recipe.recipeId}' requires output object '${intent.outputObjectId}' in the destination checkpoint.`);
}

function isGeometryObjectState(value: CheckpointObjectState): value is CheckpointGeometryObjectState {
  return value.state === "present" && Object.hasOwn(value, "geometry");
}

function assertNoRecreate(checkpoints: readonly Checkpoint[]): void {
  for (let objectIndex = 0; objectIndex < checkpoints[0]!.objects.length; objectIndex += 1) {
    let removed = false;
    for (let checkpointIndex = 0; checkpointIndex < checkpoints.length; checkpointIndex += 1) {
      const checkpoint = checkpoints[checkpointIndex]!;
      const state = checkpoint.objects[objectIndex]!.state;
      if (removed && state === "present") throw new Error(`CheckpointStoryboard forbids recreate after removal for '${checkpoint.objects[objectIndex]!.objectId}'.`);
      if (checkpointIndex > 0 && state === "absent" && checkpoints[checkpointIndex - 1]!.objects[objectIndex]!.state === "present") removed = true;
    }
  }
}

function requireMillisecondResolution(recipe: TransitionRecipe, from: Checkpoint, to: Checkpoint): void {
  if (from.atUs % 1_000 !== 0 || to.atUs % 1_000 !== 0) throw new Error(`time_resolution_unavailable: recipe '${recipe.recipeId}' requires millisecond-representable edge endpoints.`);
}

function basePayload(
  descriptor: CheckpointStoryboardDescriptor,
  parent?: CheckpointStoryboard,
  revisionValue?: number,
  parentRevision?: { readonly id: string; readonly sha256: string },
) {
  const revision = revisionValue ?? (parent ? parent.revision + 1 : 1), lineage = parentRevision ?? (parent ? freeze({ id: parent.id, sha256: parent.sha256 }) : undefined);
  return {
    schema: CHECKPOINT_STORYBOARD_SCHEMA, revision, ...(lineage ? { parentRevision: lineage } : {}), seed: descriptor.seed,
    capabilityRequirements: descriptor.capabilityRequirements, objectCatalog: descriptor.objectCatalog,
    checkpoints: descriptor.checkpoints, edges: descriptor.edges, recipes: descriptor.recipes,
  };
}
function storyboardBudget(base: ReturnType<typeof basePayload>) {
  const workUnits = base.edges.reduce((total, edge) => total + edge.recipeIds.reduce((sum, recipeId) => sum + base.recipes.find((recipe) => recipe.recipeId === recipeId)!.budget.workUnits, 0), 0);
  let storage = 0;
  for (let index = 0; index < 4; index += 1) { const next = storageBytes({ ...base, budget: { ...CHECKPOINT_STORYBOARD_BUDGET, workUnits, storageBytes: storage } }); if (next === storage) break; storage = next; }
  if (storage > MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES) throw new Error(`CheckpointStoryboard exceeds the ${MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES}-byte storage limit.`);
  return freeze({ ...CHECKPOINT_STORYBOARD_BUDGET, workUnits, storageBytes: storage });
}
function sameBudget(value: unknown, expected: ReturnType<typeof storyboardBudget>): boolean {
  const record = exactRecord(value, ["checkpoints", "objects", "edges", "recipes", "workUnits", "storageBytes"], [], "CheckpointStoryboard.budget");
  return Object.entries(expected).every(([key, item]) => record[key] === item);
}
function readMask(value: unknown, label: string, minimum: number): readonly CheckpointProperty[] {
  const mask = exactArray(value, label, PROPERTY_ORDER.length, minimum).map((item, index) => { if (typeof item !== "string" || !PROPERTY_SET.has(item as CheckpointProperty)) throw new Error(`${label}[${index}] is not an admitted property.`); return item as CheckpointProperty; });
  if (mask.some((property, index) => index > 0 && PROPERTY_ORDER.indexOf(mask[index - 1]!) >= PROPERTY_ORDER.indexOf(property))) throw new Error(`${label} must follow canonical property order without duplicates.`);
  return freeze(mask);
}
function propertyValue(property: CheckpointProperty, value: unknown, label: string): number {
  if (property === "transform.x" || property === "transform.y") return finite(value, label, -1_000_000, 1_000_000);
  if (property === "transform.rotation") return finite(value, label, -360_000, 360_000);
  if (property === "transform.scale") return finite(value, label, 0.001, 64);
  return finite(value, label, 0, 1);
}
function safeUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_CHECKPOINT_STORYBOARD_TIME_US) {
    throw new Error(`${label} must be a safe integer microsecond in 0..${MAX_CHECKPOINT_STORYBOARD_TIME_US}.`);
  }
  return value;
}
function revision(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`${label} must be a positive safe integer revision.`); return value; }
function readStoryboardIdentity(value: unknown, label: string) {
  const record = exactRecord(value, ["id", "sha256"], [], label);
  if (typeof record.id !== "string" || !/^checkpoint_storyboard_[a-f0-9]{32}$/.test(record.id) || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`${label} must be an exact checkpoint storyboard identity.`);
  if (record.id !== `checkpoint_storyboard_${record.sha256.slice(0, 32)}`) throw new Error(`${label}.id must match the supplied sha256 prefix.`);
  return freeze({ id: record.id, sha256: record.sha256 });
}
