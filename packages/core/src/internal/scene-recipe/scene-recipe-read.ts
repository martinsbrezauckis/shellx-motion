import {
  DIRECTED_SHOT_SCHEMA,
  SCENE_RECIPE_CAPS,
  SCENE_RECIPE_SCHEMA,
  type DirectedSceneRecipeShot,
  type SceneRecipe,
  type SceneRecipeCheckpoint,
  type SceneRecipeEntity,
  type SceneRecipeGeneratedState,
  type SceneRecipeGeometryResource,
  type SceneRecipeMaterialResource,
  type SceneRecipePresentation,
  type SceneRecipeWallGenerator,
  WALL_GENERATOR_SCHEMA,
} from "./scene-recipe-types";
import { exactArray, exactRecord, finite, freeze, integer, rgb, safeId, safeUs, snapshotSceneRecipeData, strictIds, uniqueIds, vec2, vec3 } from "./scene-recipe-data";
import { wallEntityId } from "./scene-recipe-wall";

export function readSceneRecipe(value: unknown): SceneRecipe {
  const root = exactRecord(snapshotSceneRecipeData(value), ["schema", "units", "resources", "shots"], [], "Scene recipe");
  if (root.schema !== SCENE_RECIPE_SCHEMA) throw new Error(`Scene recipe.schema must equal ${SCENE_RECIPE_SCHEMA}.`);
  const units = readUnits(root.units);
  const resources = readSceneRecipeResources(root.resources);
  const geometryById = new Map(resources.geometry.map((resource) => [resource.id, resource]));
  const materialIds = new Set(resources.materials.map((resource) => resource.id));
  const shots = exactArray(root.shots, "Scene recipe.shots", 1, SCENE_RECIPE_CAPS.shots).map((shot, index) => readShot(shot, index, geometryById, materialIds));
  uniqueIds(shots.map((shot) => shot.id), "Scene recipe shot ids");
  for (let index = 1; index < shots.length; index += 1) if (shots[index]!.startUs < shots[index - 1]!.endUs) throw new Error("Scene recipe shots must use ordered non-overlapping intervals.");
  return freeze({ schema: SCENE_RECIPE_SCHEMA, units, resources, shots });
}

function readUnits(value: unknown): SceneRecipe["units"] {
  const record = exactRecord(value, ["length", "angle", "time", "upAxis", "forwardAxis"], [], "Scene recipe.units");
  if (record.length !== "meter" || record.angle !== "degree" || record.time !== "microsecond" || record.upAxis !== "y" || record.forwardAxis !== "-z") throw new Error("Scene recipe.units must equal meter/degree/microsecond/y/-z.");
  return freeze({ length: "meter" as const, angle: "degree" as const, time: "microsecond" as const, upAxis: "y" as const, forwardAxis: "-z" as const });
}

/** Reads the shared C7A visual geometry/material grammar without admitting a directed shot. */
export function readSceneRecipeResources(value: unknown): SceneRecipe["resources"] {
  const record = exactRecord(value, ["geometry", "materials"], [], "Scene recipe.resources");
  const geometry = exactArray(record.geometry, "Scene recipe.resources.geometry", 1, SCENE_RECIPE_CAPS.geometries).map(readGeometry);
  const materials = exactArray(record.materials, "Scene recipe.resources.materials", 1, SCENE_RECIPE_CAPS.materials).map(readMaterial);
  strictIds(geometry.map((resource) => resource.id), "Scene recipe geometry ids");
  strictIds(materials.map((resource) => resource.id), "Scene recipe material ids");
  return freeze({ geometry, materials });
}

function readGeometry(value: unknown, index: number): SceneRecipeGeometryResource {
  const base = exactRecord(value, ["id", "kind"], ["radius", "quality", "size"], `Scene recipe geometry[${index}]`);
  const id = safeId(base.id, `Scene recipe geometry[${index}].id`);
  if (base.kind === "sphere") {
    const record = exactRecord(base, ["id", "kind", "radius", "quality"], [], `Scene recipe geometry[${index}]`);
    if (record.quality !== "preview" && record.quality !== "balanced" && record.quality !== "cinematic") throw new Error(`Scene recipe geometry[${index}].quality must equal preview, balanced, or cinematic.`);
    return freeze({ id, kind: "sphere" as const, radius: finite(record.radius, `Scene recipe geometry[${index}].radius`, 0.001, 1_000), quality: record.quality });
  }
  if (base.kind === "box") {
    const record = exactRecord(base, ["id", "kind", "size"], [], `Scene recipe geometry[${index}]`);
    const size = vec3(record.size, `Scene recipe geometry[${index}].size`, 0.001, 2_000);
    return freeze({ id, kind: "box" as const, size });
  }
  throw new Error(`Scene recipe geometry[${index}].kind must equal sphere or box.`);
}

function readMaterial(value: unknown, index: number): SceneRecipeMaterialResource {
  const record = exactRecord(value, ["id", "kind", "baseColor", "emissive"], [], `Scene recipe material[${index}]`);
  if (record.kind !== "basic") throw new Error(`Scene recipe material[${index}].kind must equal basic.`);
  return freeze({ id: safeId(record.id, `Scene recipe material[${index}].id`), kind: "basic" as const, baseColor: rgb(record.baseColor, `Scene recipe material[${index}].baseColor`), emissive: finite(record.emissive, `Scene recipe material[${index}].emissive`, 0, 1) });
}

function readShot(value: unknown, index: number, geometryById: ReadonlyMap<string, SceneRecipeGeometryResource>, materialIds: ReadonlySet<string>): DirectedSceneRecipeShot {
  const label = `Scene recipe.shots[${index}]`, record = exactRecord(value, ["schema", "id", "startUs", "endUs", "entities", "generators", "checkpoints", "presentation"], [], label);
  if (record.schema !== DIRECTED_SHOT_SCHEMA) throw new Error(`${label}.schema must equal ${DIRECTED_SHOT_SCHEMA}; simulated shots are not admitted by C7A.`);
  const id = safeId(record.id, `${label}.id`), startUs = safeUs(record.startUs, `${label}.startUs`), endUs = safeUs(record.endUs, `${label}.endUs`);
  if (endUs <= startUs) throw new Error(`${label}.endUs must be greater than startUs.`);
  const geometryIds = new Set(geometryById.keys());
  const entities = exactArray(record.entities, `${label}.entities`, 0, SCENE_RECIPE_CAPS.entitiesPerShot).map((entity, entityIndex) => readEntity(entity, `${label}.entities[${entityIndex}]`, geometryIds, materialIds));
  strictIds(entities.map((entity) => entity.id), `${label} entity ids`);
  const generators = exactArray(record.generators, `${label}.generators`, 0, SCENE_RECIPE_CAPS.generatorsPerShot).map((generator, generatorIndex) => readWallGenerator(generator, `${label}.generators[${generatorIndex}]`, geometryById, materialIds));
  strictIds(generators.map((generator) => generator.id), `${label} generator ids`);
  const generatedIds = generators.flatMap((generator) => Array.from({ length: generator.rows }, (_row, row) => Array.from({ length: generator.columns }, (_column, column) => wallEntityId(generator.id, row, column))).flat());
  if (entities.length + generatedIds.length < 1 || entities.length + generatedIds.length > SCENE_RECIPE_CAPS.entitiesPerShot) throw new Error(`${label} must expand to 1..${SCENE_RECIPE_CAPS.entitiesPerShot} entities.`);
  uniqueIds([...entities.map((entity) => entity.id), ...generatedIds], `${label} explicit and generated entity ids`);
  const checkpoints = exactArray(record.checkpoints, `${label}.checkpoints`, 2, SCENE_RECIPE_CAPS.checkpointsPerShot).map((checkpoint, checkpointIndex) => readCheckpoint(checkpoint, `${label}.checkpoints[${checkpointIndex}]`, entities, generators));
  uniqueIds(checkpoints.map((checkpoint) => checkpoint.id), `${label} checkpoint ids`);
  if (checkpoints[0]!.atUs !== startUs || checkpoints.at(-1)!.atUs !== endUs) throw new Error(`${label} checkpoints must include the exact shot start and end.`);
  for (let checkpointIndex = 1; checkpointIndex < checkpoints.length; checkpointIndex += 1) if (checkpoints[checkpointIndex]!.atUs <= checkpoints[checkpointIndex - 1]!.atUs) throw new Error(`${label} checkpoint times must be strictly ascending.`);
  return freeze({ schema: DIRECTED_SHOT_SCHEMA, id, startUs, endUs, entities, generators, checkpoints, presentation: readPresentation(record.presentation, `${label}.presentation`) });
}

function readWallGenerator(value: unknown, label: string, geometryById: ReadonlyMap<string, SceneRecipeGeometryResource>, materialIds: ReadonlySet<string>): SceneRecipeWallGenerator {
  const record = exactRecord(value, ["schema", "id", "geometryRef", "rows", "columns", "bond", "gap", "origin", "materialPattern"], [], label);
  if (record.schema !== WALL_GENERATOR_SCHEMA) throw new Error(`${label}.schema must equal ${WALL_GENERATOR_SCHEMA}.`);
  const id = safeId(record.id, `${label}.id`);
  if (id.length > 48) throw new Error(`${label}.id must contain at most 48 characters so generated entity ids stay bounded.`);
  const geometryRef = safeId(record.geometryRef, `${label}.geometryRef`), geometry = geometryById.get(geometryRef);
  if (!geometry) throw new Error(`${label}.geometryRef does not identify a declared geometry resource.`);
  if (geometry.kind !== "box") throw new Error(`${label}.geometryRef must identify box geometry.`);
  if (record.bond !== "stack" && record.bond !== "running") throw new Error(`${label}.bond must equal stack or running.`);
  const rows = integer(record.rows, `${label}.rows`, 1, 64), columns = integer(record.columns, `${label}.columns`, 1, 64);
  if (rows * columns > SCENE_RECIPE_CAPS.entitiesPerShot) throw new Error(`${label} exceeds the ${SCENE_RECIPE_CAPS.entitiesPerShot}-generated-entity cap.`);
  return freeze({
    schema: WALL_GENERATOR_SCHEMA,
    id,
    geometryRef,
    rows,
    columns,
    bond: record.bond,
    gap: vec2(record.gap, `${label}.gap`, 0, 100),
    origin: vec3(record.origin, `${label}.origin`, -1_000, 1_000),
    materialPattern: readMaterialPattern(record.materialPattern, `${label}.materialPattern`, materialIds),
  });
}

function readMaterialPattern(value: unknown, label: string, materialIds: ReadonlySet<string>): SceneRecipeWallGenerator["materialPattern"] {
  const record = exactRecord(value, ["kind", "materialRefs"], [], label);
  if (record.kind !== "cycle" && record.kind !== "row-cycle") throw new Error(`${label}.kind must equal cycle or row-cycle.`);
  const materialRefs = exactArray(record.materialRefs, `${label}.materialRefs`, 1, 16).map((entry, index) => safeId(entry, `${label}.materialRefs[${index}]`));
  uniqueIds(materialRefs, `${label}.materialRefs`);
  const missing = materialRefs.find((materialRef) => !materialIds.has(materialRef));
  if (missing) throw new Error(`${label}.materialRefs contains undeclared material '${missing}'.`);
  return freeze({ kind: record.kind, materialRefs });
}

function readEntity(value: unknown, label: string, geometryIds: ReadonlySet<string>, materialIds: ReadonlySet<string>): SceneRecipeEntity {
  const record = exactRecord(value, ["id", "geometryRef", "materialRef"], [], label);
  const id = safeId(record.id, `${label}.id`), geometryRef = safeId(record.geometryRef, `${label}.geometryRef`), materialRef = safeId(record.materialRef, `${label}.materialRef`);
  if (!geometryIds.has(geometryRef)) throw new Error(`${label}.geometryRef does not identify a declared geometry resource.`);
  if (!materialIds.has(materialRef)) throw new Error(`${label}.materialRef does not identify a declared material resource.`);
  return freeze({ id, geometryRef, materialRef });
}

function readCheckpoint(value: unknown, label: string, entities: readonly SceneRecipeEntity[], generators: readonly SceneRecipeWallGenerator[]): SceneRecipeCheckpoint {
  const record = exactRecord(value, ["id", "atUs", "states", "generatedStates"], [], label);
  const states = exactArray(record.states, `${label}.states`, entities.length, entities.length).map((state, stateIndex) => {
    const stateLabel = `${label}.states[${stateIndex}]`, entry = exactRecord(state, ["entityId", "position", "rotationDeg", "scale"], [], stateLabel);
    const entityId = safeId(entry.entityId, `${stateLabel}.entityId`);
    if (entityId !== entities[stateIndex]!.id) throw new Error(`${label}.states must match the shot entity order exactly.`);
    return freeze({ entityId, position: vec3(entry.position, `${stateLabel}.position`, -1_000, 1_000), rotationDeg: vec3(entry.rotationDeg, `${stateLabel}.rotationDeg`, -36_000, 36_000), scale: finite(entry.scale, `${stateLabel}.scale`, 0.001, 100) });
  });
  const generatedStates = exactArray(record.generatedStates, `${label}.generatedStates`, generators.length, generators.length).map((state, stateIndex) => readGeneratedState(state, `${label}.generatedStates[${stateIndex}]`, generators[stateIndex]!.id));
  return freeze({ id: safeId(record.id, `${label}.id`), atUs: safeUs(record.atUs, `${label}.atUs`), states, generatedStates });
}

function readGeneratedState(value: unknown, label: string, expectedGeneratorId: string): SceneRecipeGeneratedState {
  const record = exactRecord(value, ["generatorId", "translation", "rotationDeg", "scale"], [], label);
  const generatorId = safeId(record.generatorId, `${label}.generatorId`);
  if (generatorId !== expectedGeneratorId) throw new Error(`${label}.generatorId must match the shot generator order exactly.`);
  return freeze({
    generatorId,
    translation: vec3(record.translation, `${label}.translation`, -1_000, 1_000),
    rotationDeg: vec3(record.rotationDeg, `${label}.rotationDeg`, -36_000, 36_000),
    scale: finite(record.scale, `${label}.scale`, 0.001, 100),
  });
}

function readPresentation(value: unknown, label: string): SceneRecipePresentation {
  const record = exactRecord(value, ["camera", "lighting", "backgroundColor"], [], label);
  const camera = exactRecord(record.camera, ["position", "target", "fovDeg", "near", "far"], [], `${label}.camera`);
  const near = finite(camera.near, `${label}.camera.near`, 0.01, 100), far = finite(camera.far, `${label}.camera.far`, 0.01, 10_000);
  if (far <= near) throw new Error(`${label}.camera.far must exceed near.`);
  const lighting = exactRecord(record.lighting, ["ambient", "direction", "intensity", "color"], [], `${label}.lighting`);
  return freeze({
    camera: freeze({ position: vec3(camera.position, `${label}.camera.position`, -1_000, 1_000), target: vec3(camera.target, `${label}.camera.target`, -1_000, 1_000), fovDeg: finite(camera.fovDeg, `${label}.camera.fovDeg`, 10, 120), near, far }),
    lighting: freeze({ ambient: finite(lighting.ambient, `${label}.lighting.ambient`, 0, 1), direction: vec3(lighting.direction, `${label}.lighting.direction`, -1, 1), intensity: finite(lighting.intensity, `${label}.lighting.intensity`, 0, 4), color: rgb(lighting.color, `${label}.lighting.color`) }),
    backgroundColor: rgb(record.backgroundColor, `${label}.backgroundColor`),
  });
}
