import type { MotionScene3DMeshGeometry } from "../../scene-3d-types";

export const SCENE_RECIPE_SCHEMA = "shellx-motion/scene-recipe@1" as const;
export const DIRECTED_SHOT_SCHEMA = "shellx-motion/directed-shot@1" as const;
export const WALL_GENERATOR_SCHEMA = "shellx-motion/wall-generator@1" as const;
export const SCENE_RECIPE_PLAN_SCHEMA = "shellx-motion/private-scene-recipe-plan@1" as const;

export const SCENE_RECIPE_CAPS = Object.freeze({
  geometries: 32,
  materials: 32,
  shots: 16,
  entitiesPerShot: 256,
  generatorsPerShot: 16,
  checkpointsPerShot: 16,
  stateSamples: 4_096,
  planBytes: 2 * 1024 * 1024,
});

export type SceneRecipeVec3 = readonly [number, number, number];
export type SceneRecipeVec2 = readonly [number, number];
export type SceneRecipeSphereQuality = "preview" | "balanced" | "cinematic";

export type SceneRecipeGeometryResource =
  | Readonly<{ id: string; kind: "sphere"; radius: number; quality: SceneRecipeSphereQuality }>
  | Readonly<{ id: string; kind: "box"; size: SceneRecipeVec3 }>;

export interface SceneRecipeMaterialResource {
  readonly id: string;
  readonly kind: "basic";
  readonly baseColor: string;
  readonly emissive: number;
}

export interface SceneRecipeEntity {
  readonly id: string;
  readonly geometryRef: string;
  readonly materialRef: string;
}

export interface SceneRecipeEntityState {
  readonly entityId: string;
  readonly position: SceneRecipeVec3;
  readonly rotationDeg: SceneRecipeVec3;
  readonly scale: number;
}

export interface SceneRecipeWallGenerator {
  readonly schema: typeof WALL_GENERATOR_SCHEMA;
  readonly id: string;
  readonly geometryRef: string;
  readonly rows: number;
  readonly columns: number;
  readonly bond: "stack" | "running";
  readonly gap: SceneRecipeVec2;
  readonly origin: SceneRecipeVec3;
  readonly materialPattern: Readonly<{
    kind: "cycle" | "row-cycle";
    materialRefs: readonly string[];
  }>;
}

export interface SceneRecipeGeneratedState {
  readonly generatorId: string;
  readonly translation: SceneRecipeVec3;
  readonly rotationDeg: SceneRecipeVec3;
  readonly scale: number;
}

export interface SceneRecipeCheckpoint {
  readonly id: string;
  readonly atUs: number;
  readonly states: readonly SceneRecipeEntityState[];
  readonly generatedStates: readonly SceneRecipeGeneratedState[];
}

export interface SceneRecipePresentation {
  readonly camera: Readonly<{
    position: SceneRecipeVec3;
    target: SceneRecipeVec3;
    fovDeg: number;
    near: number;
    far: number;
  }>;
  readonly lighting: Readonly<{
    ambient: number;
    direction: SceneRecipeVec3;
    intensity: number;
    color: string;
  }>;
  readonly backgroundColor: string;
}

export interface DirectedSceneRecipeShot {
  readonly schema: typeof DIRECTED_SHOT_SCHEMA;
  readonly id: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly entities: readonly SceneRecipeEntity[];
  readonly generators: readonly SceneRecipeWallGenerator[];
  readonly checkpoints: readonly SceneRecipeCheckpoint[];
  readonly presentation: SceneRecipePresentation;
}

export interface SceneRecipe {
  readonly schema: typeof SCENE_RECIPE_SCHEMA;
  readonly units: Readonly<{
    length: "meter";
    angle: "degree";
    time: "microsecond";
    upAxis: "y";
    forwardAxis: "-z";
  }>;
  readonly resources: Readonly<{
    geometry: readonly SceneRecipeGeometryResource[];
    materials: readonly SceneRecipeMaterialResource[];
  }>;
  readonly shots: readonly DirectedSceneRecipeShot[];
}

export interface CompiledSceneGeometryResource {
  readonly id: string;
  readonly definitionSha256: string;
  readonly geometrySha256: string;
  readonly geometry: MotionScene3DMeshGeometry;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly byteLength: number;
}

export interface CompiledSceneMaterialResource extends SceneRecipeMaterialResource {
  readonly definitionSha256: string;
}

export interface CompiledSceneRecipeResources {
  readonly geometry: readonly CompiledSceneGeometryResource[];
  readonly materials: readonly CompiledSceneMaterialResource[];
  readonly fingerprint: string;
}

export interface CompiledSceneRecipeCheckpoint {
  readonly id: string;
  readonly atUs: number;
  readonly states: readonly SceneRecipeEntityState[];
}

export interface CompiledDirectedSceneShot {
  readonly schema: typeof DIRECTED_SHOT_SCHEMA;
  readonly id: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly entities: readonly SceneRecipeEntity[];
  readonly checkpoints: readonly CompiledSceneRecipeCheckpoint[];
  readonly presentation: SceneRecipePresentation;
  readonly generatorCount: number;
  readonly generatedEntityCount: number;
  readonly generatorFingerprint: string;
  readonly entityOrderSha256: string;
  readonly checkpointStateSha256: string;
  readonly fingerprint: string;
}

export interface SceneRecipePlan {
  readonly schema: typeof SCENE_RECIPE_PLAN_SCHEMA;
  readonly recipe: SceneRecipe;
  readonly recipeSha256: string;
  readonly resources: CompiledSceneRecipeResources;
  readonly shots: readonly CompiledDirectedSceneShot[];
  readonly budget: Readonly<{
    geometryResourceCount: number;
    materialResourceCount: number;
    shotCount: number;
    entityInstanceCount: number;
    generatorCount: number;
    generatedEntityInstanceCount: number;
    checkpointCount: number;
    stateSampleCount: number;
    uniqueGeometryBytes: number;
    expandedGeometryBytes: number;
    reusedGeometryInstanceCount: number;
    planBytes: number;
    caps: typeof SCENE_RECIPE_CAPS;
  }>;
  readonly evidence: Readonly<{
    directedShotsOnly: true;
    strictShotUnion: true;
    sharedGeometryResources: true;
    sharedMaterialResources: true;
    exactCheckpointStates: true;
    generatedTopology: true;
    generatedMaterialAssignment: true;
    physicsFieldsAccepted: false;
    rendererInvoked: false;
    packageRead: false;
    packageWritten: false;
    providerSelected: false;
  }>;
  readonly fingerprint: string;
}
