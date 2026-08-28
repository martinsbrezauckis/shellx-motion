/** Source-only C7A scene-resource and directed-shot recipe foundation. */
export {
  DIRECTED_SHOT_SCHEMA,
  SCENE_RECIPE_CAPS,
  SCENE_RECIPE_PLAN_SCHEMA,
  SCENE_RECIPE_SCHEMA,
  WALL_GENERATOR_SCHEMA,
  type CompiledDirectedSceneShot,
  type CompiledSceneGeometryResource,
  type CompiledSceneMaterialResource,
  type CompiledSceneRecipeResources,
  type CompiledSceneRecipeCheckpoint,
  type DirectedSceneRecipeShot,
  type SceneRecipe,
  type SceneRecipeCheckpoint,
  type SceneRecipeEntity,
  type SceneRecipeEntityState,
  type SceneRecipeGeometryResource,
  type SceneRecipeGeneratedState,
  type SceneRecipeMaterialResource,
  type SceneRecipePlan,
  type SceneRecipePresentation,
  type SceneRecipeSphereQuality,
  type SceneRecipeVec3,
  type SceneRecipeVec2,
  type SceneRecipeWallGenerator,
} from "./scene-recipe-types";
export { readSceneRecipe, readSceneRecipeResources } from "./scene-recipe-read";
export { snapshotSceneRecipeData } from "./scene-recipe-data";
export { compileSceneRecipe, compileSceneRecipeResources } from "./scene-recipe-compile";
export {
  compileRetainedMeshGeometry,
  retainedMeshColor,
  retainedMeshFloatBytes,
  retainedMeshIndexBytes,
  retainedMeshModelMatrixFromQuaternion,
  retainedMeshModelMatrixFromQuaternionScale,
  retainedMeshViewProjection,
  type RetainedMeshCamera,
} from "./retained-mesh-render";
export {
  GLTF_OBJECT_DECLARATION_SCHEMA,
  GLTF_OBJECT_PLAN_CAPS,
  GLTF_OBJECT_PLAN_SCHEMA,
  type GltfObjectDeclaration,
  type GltfObjectLocalTransform,
  type GltfObjectNode,
  type GltfObjectPlan,
  type GltfObjectPrimitiveResource,
  type GltfObjectRoleBinding,
  type GltfObjectRoleDeclaration,
} from "./gltf-object-plan-types";
export { compileGltfObjectPlan } from "./gltf-object-plan";
export {
  GLTF_OBJECT_STORY_CAPS,
  GLTF_OBJECT_STORY_PLAN_SCHEMA,
  GLTF_OBJECT_STORY_SCHEMA,
  type CompiledGltfObjectStoryCheckpoint,
  type CompiledGltfObjectStoryControl,
  type CompiledGltfObjectStoryState,
  type GltfObjectStory,
  type GltfObjectStoryCheckpoint,
  type GltfObjectStoryControl,
  type GltfObjectStoryMaterial,
  type GltfObjectStoryPlan,
  type GltfObjectStoryState,
} from "./gltf-object-story-types";
export { compileGltfObjectStoryPlan } from "./gltf-object-story";
export {
  GLTF_OBJECT_SCENE_CAPS,
  GLTF_OBJECT_SCENE_PLAN_SCHEMA,
  GLTF_OBJECT_SCENE_SCHEMA,
  type GltfObjectSceneAssembly,
  type GltfObjectSceneBounds,
  type GltfObjectSceneCamera,
  type GltfObjectSceneCheckpoint,
  type GltfObjectSceneMaterialAssignment,
  type GltfObjectSceneNodeState,
  type GltfObjectScenePlan,
  type GltfObjectScenePrimitiveInstance,
  type GltfObjectSceneVec3,
} from "./gltf-object-scene-types";
export { compileGltfObjectScenePlan } from "./gltf-object-scene";
export {
  GLTF_OBJECT_SCENE_EVALUATION_CAPS,
  GLTF_OBJECT_SCENE_EVALUATION_PLAN_SCHEMA,
  GLTF_OBJECT_SCENE_EVALUATION_SCHEMA,
  GLTF_OBJECT_SCENE_FRAME_SCHEMA,
  type CompiledGltfObjectSceneEvaluationControl,
  type CompiledGltfObjectSceneEvaluationSegment,
  type GltfObjectSceneEvaluation,
  type GltfObjectSceneEvaluationControl,
  type GltfObjectSceneEvaluationPlan,
  type GltfObjectSceneEvaluationSegment,
  type GltfObjectSceneFrame,
  type GltfObjectSceneFrameResult,
  type GltfObjectSceneTransformInterpolation,
} from "./gltf-object-scene-evaluation-types";
export { compileGltfObjectSceneEvaluationPlan } from "./gltf-object-scene-evaluation";
export { evaluateGltfObjectSceneAtUs } from "./gltf-object-scene-evaluate";
export {
  GLTF_OBJECT_RETAINED_RENDER_CAPS,
  GLTF_OBJECT_RETAINED_RENDER_FRAME_SCHEMA,
  GLTF_OBJECT_RETAINED_RENDER_SCHEMA,
  GLTF_OBJECT_RETAINED_RENDER_STATIC_SCHEMA,
  type GltfObjectRetainedRenderBinding,
  type GltfObjectRetainedRenderFramePlan,
  type GltfObjectRetainedRenderFrameUpload,
  type GltfObjectRetainedRenderGeometry,
  type GltfObjectRetainedRenderRecipe,
  type GltfObjectRetainedRenderSourceMaterial,
  type GltfObjectRetainedRenderStaticPlan,
  type GltfObjectRetainedRenderStaticUpload,
} from "./gltf-object-retained-render-types";
export {
  compileGltfObjectRetainedRenderFramePlan,
  compileGltfObjectRetainedRenderStaticPlan,
  readGltfObjectRetainedRenderFrameUpload,
  readGltfObjectRetainedRenderStaticUpload,
} from "./gltf-object-retained-render";
export {
  PHYSICS_BAKE_ADMISSION_CAPS,
  PHYSICS_BAKE_ADMISSION_PLAN_SCHEMA,
  PHYSICS_BAKE_SCHEMA,
  type PhysicsBakeAction,
  type PhysicsBakeAdmissionPlan,
  type PhysicsBakeBody,
  type PhysicsBakeCollider,
  type PhysicsBakeCollisionEvent,
  type PhysicsBakeDistanceConstraint,
  type PhysicsBakeMaterial,
  type PhysicsBakeObservation,
  type PhysicsBakeQuaternion,
  type PhysicsBakeRecipe,
  type PhysicsBakeVec3,
} from "./physics-bake-admission-types";
export { readPhysicsBakeRecipe } from "./physics-bake-admission-read";
export { compilePhysicsBakeAdmissionPlan, readPhysicsBakeAdmissionPlan } from "./physics-bake-admission";
