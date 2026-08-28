import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { scene3dMeshGeometrySha256 } from "../../scene-3d-geometry";
import type { MotionScene3DMeshGeometry, MotionVec3 } from "../../scene-3d-types";
import { freeze } from "./scene-recipe-data";
import { readSceneRecipe, readSceneRecipeResources } from "./scene-recipe-read";
import {
  SCENE_RECIPE_CAPS,
  SCENE_RECIPE_PLAN_SCHEMA,
  type CompiledDirectedSceneShot,
  type CompiledSceneRecipeResources,
  type CompiledSceneGeometryResource,
  type DirectedSceneRecipeShot,
  type SceneRecipeGeometryResource,
  type SceneRecipePlan,
} from "./scene-recipe-types";
import { expandWallGenerator, transformGeneratedState } from "./scene-recipe-wall";

export function compileSceneRecipe(value: unknown): SceneRecipePlan {
  const recipe = readSceneRecipe(value);
  const resources = compileSceneRecipeResources(recipe.resources), { geometry, materials } = resources;
  const sourceGeometryById = new Map(recipe.resources.geometry.map((resource) => [resource.id, resource]));
  const shots = recipe.shots.map((shot) => compileShot(shot, sourceGeometryById));
  const geometryById = new Map(geometry.map((resource) => [resource.id, resource]));
  const entityInstanceCount = shots.reduce((sum, shot) => sum + shot.entities.length, 0);
  const generatorCount = shots.reduce((sum, shot) => sum + shot.generatorCount, 0);
  const generatedEntityInstanceCount = shots.reduce((sum, shot) => sum + shot.generatedEntityCount, 0);
  const checkpointCount = shots.reduce((sum, shot) => sum + shot.checkpoints.length, 0);
  const stateSampleCount = shots.reduce((sum, shot) => sum + shot.entities.length * shot.checkpoints.length, 0);
  if (stateSampleCount > SCENE_RECIPE_CAPS.stateSamples) throw new Error(`Scene recipe exceeds the ${SCENE_RECIPE_CAPS.stateSamples}-state-sample cap.`);
  const uniqueGeometryBytes = geometry.reduce((sum, resource) => sum + resource.byteLength, 0);
  const expandedGeometryBytes = shots.reduce((sum, shot) => sum + shot.entities.reduce((shotSum, entity) => shotSum + geometryById.get(entity.geometryRef)!.byteLength, 0), 0);
  const reusedGeometryInstanceCount = entityInstanceCount - new Set(shots.flatMap((shot) => shot.entities.map((entity) => entity.geometryRef))).size;
  const baseBudget = {
    geometryResourceCount: geometry.length,
    materialResourceCount: materials.length,
    shotCount: shots.length,
    entityInstanceCount,
    generatorCount,
    generatedEntityInstanceCount,
    checkpointCount,
    stateSampleCount,
    uniqueGeometryBytes,
    expandedGeometryBytes,
    reusedGeometryInstanceCount,
    caps: SCENE_RECIPE_CAPS,
  };
  const base = {
    schema: SCENE_RECIPE_PLAN_SCHEMA,
    recipe,
    recipeSha256: canonicalJsonSha256(recipe),
    resources,
    shots,
    evidence: freeze({
      directedShotsOnly: true as const,
      strictShotUnion: true as const,
      sharedGeometryResources: true as const,
      sharedMaterialResources: true as const,
      exactCheckpointStates: true as const,
      generatedTopology: true as const,
      generatedMaterialAssignment: true as const,
      physicsFieldsAccepted: false as const,
      rendererInvoked: false as const,
      packageRead: false as const,
      packageWritten: false as const,
      providerSelected: false as const,
    }),
  };
  let planBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, planBytes } }), "utf8");
    if (next === planBytes) break;
    planBytes = next;
  }
  if (planBytes > SCENE_RECIPE_CAPS.planBytes) throw new Error(`Scene recipe plan exceeds the ${SCENE_RECIPE_CAPS.planBytes}-byte cap.`);
  const payload = { ...base, budget: freeze({ ...baseBudget, planBytes }) };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/** Compiles the shared C7A visual resource grammar without requiring a directed shot. */
export function compileSceneRecipeResources(value: unknown): CompiledSceneRecipeResources {
  const resources = readSceneRecipeResources(value);
  const geometry = resources.geometry.map(compileGeometry);
  const materials = resources.materials.map((material) => freeze({ ...material, definitionSha256: canonicalJsonSha256(material) }));
  return freeze({ geometry, materials, fingerprint: canonicalJsonSha256({ geometry: geometry.map(resourceEvidence), materials }) });
}

function compileShot(shot: DirectedSceneRecipeShot, geometryById: ReadonlyMap<string, SceneRecipeGeometryResource>): CompiledDirectedSceneShot {
  const expandedGenerators = shot.generators.map((generator) => expandWallGenerator(generator, geometryById.get(generator.geometryRef)!));
  const entities = freeze([...shot.entities, ...expandedGenerators.flatMap((expanded) => expanded.map((entry) => entry.entity))]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const checkpoints = freeze(shot.checkpoints.map((checkpoint) => {
    const generatedStates = expandedGenerators.flatMap((expanded, generatorIndex) => expanded.map((entry) => transformGeneratedState(entry.baseState, checkpoint.generatedStates[generatorIndex]!)));
    const states = freeze([...checkpoint.states, ...generatedStates]
      .sort((left, right) => left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0));
    if (states.length !== entities.length || states.some((state, index) => state.entityId !== entities[index]!.id)) throw new Error(`Compiled shot '${shot.id}' state expansion does not match entity order.`);
    return freeze({ id: checkpoint.id, atUs: checkpoint.atUs, states });
  }));
  const generatorFingerprint = canonicalJsonSha256(shot.generators);
  const payload = {
    schema: shot.schema,
    id: shot.id,
    startUs: shot.startUs,
    endUs: shot.endUs,
    entities,
    checkpoints,
    presentation: shot.presentation,
    generatorCount: shot.generators.length,
    generatedEntityCount: expandedGenerators.reduce((sum, expanded) => sum + expanded.length, 0),
    generatorFingerprint,
    entityOrderSha256: canonicalJsonSha256(entities.map((entity) => entity.id)),
    checkpointStateSha256: canonicalJsonSha256(checkpoints.map((checkpoint) => ({ id: checkpoint.id, atUs: checkpoint.atUs, states: checkpoint.states }))),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function compileGeometry(resource: SceneRecipeGeometryResource): CompiledSceneGeometryResource {
  const geometry = resource.kind === "sphere" ? sphereGeometry(resource.radius, resource.quality) : boxGeometry(resource.size);
  const vertexCount = geometry.positions.length / 3, indexCount = geometry.indices.length;
  return freeze({
    id: resource.id,
    definitionSha256: canonicalJsonSha256(resource),
    geometrySha256: scene3dMeshGeometrySha256(geometry),
    geometry,
    vertexCount,
    indexCount,
    byteLength: 16 + vertexCount * 24 + indexCount * 4,
  });
}

function sphereGeometry(radius: number, quality: "preview" | "balanced" | "cinematic"): MotionScene3DMeshGeometry {
  const [latitudeSegments, longitudeSegments] = quality === "preview" ? [8, 12] : quality === "balanced" ? [16, 24] : [24, 36];
  const meshRadius = meshFloat(radius);
  const positions: number[] = [0, meshRadius, 0], normals: number[] = [0, 1, 0], indices: number[] = [];
  for (let latitude = 1; latitude < latitudeSegments; latitude += 1) {
    const theta = Math.PI * latitude / latitudeSegments;
    for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
      const phi = Math.PI * 2 * longitude / longitudeSegments;
      const normal: MotionVec3 = [
        meshFloat(Math.sin(theta) * Math.cos(phi)),
        meshFloat(Math.cos(theta)),
        meshFloat(Math.sin(theta) * Math.sin(phi)),
      ];
      normals.push(...normal);
      positions.push(meshFloat(normal[0] * meshRadius), meshFloat(normal[1] * meshRadius), meshFloat(normal[2] * meshRadius));
    }
  }
  const bottom = positions.length / 3; positions.push(0, meshFloat(-meshRadius), 0); normals.push(0, -1, 0);
  const ring = (latitude: number, longitude: number): number => 1 + (latitude - 1) * longitudeSegments + longitude % longitudeSegments;
  for (let longitude = 0; longitude < longitudeSegments; longitude += 1) indices.push(0, ring(1, longitude + 1), ring(1, longitude));
  for (let latitude = 1; latitude < latitudeSegments - 1; latitude += 1) for (let longitude = 0; longitude < longitudeSegments; longitude += 1) {
    const a = ring(latitude, longitude), b = ring(latitude, longitude + 1), c = ring(latitude + 1, longitude), d = ring(latitude + 1, longitude + 1);
    indices.push(a, b, c, b, d, c);
  }
  for (let longitude = 0; longitude < longitudeSegments; longitude += 1) indices.push(bottom, ring(latitudeSegments - 1, longitude), ring(latitudeSegments - 1, longitude + 1));
  return freeze({ positions, normals, indices });
}

function boxGeometry(size: readonly [number, number, number]): MotionScene3DMeshGeometry {
  const half: MotionVec3 = [meshFloat(size[0] / 2), meshFloat(size[1] / 2), meshFloat(size[2] / 2)], positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const [x, y, z] = half;
  const quad = (a: MotionVec3, b: MotionVec3, c: MotionVec3, d: MotionVec3, normal: MotionVec3): void => {
    const offset = positions.length / 3; positions.push(...a, ...b, ...c, ...d); normals.push(...normal, ...normal, ...normal, ...normal); indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  };
  quad([-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z],[0,0,1]); quad([x,-y,-z],[-x,-y,-z],[-x,y,-z],[x,y,-z],[0,0,-1]);
  quad([-x,y,z],[x,y,z],[x,y,-z],[-x,y,-z],[0,1,0]); quad([-x,-y,-z],[x,-y,-z],[x,-y,z],[-x,-y,z],[0,-1,0]);
  quad([x,-y,z],[x,-y,-z],[x,y,-z],[x,y,z],[1,0,0]); quad([-x,-y,-z],[-x,-y,z],[-x,y,z],[-x,y,-z],[-1,0,0]);
  return freeze({ positions, normals, indices });
}

/** Persist the exact float32 values consumed and attested by the current scene3d ABI. */
function meshFloat(value: number): number {
  const normalized = Math.abs(value) < 1e-7 ? 0 : Math.fround(value);
  return Object.is(normalized, -0) ? 0 : normalized;
}

function resourceEvidence(resource: CompiledSceneGeometryResource) {
  return { id: resource.id, definitionSha256: resource.definitionSha256, geometrySha256: resource.geometrySha256, vertexCount: resource.vertexCount, indexCount: resource.indexCount, byteLength: resource.byteLength };
}
