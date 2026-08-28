import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { exactArray, exactRecord, finite, freeze, integer, rgb, snapshotSceneRecipeData, vec3 } from "./scene-recipe-data";
import { mintGltfObjectRetainedRenderFramePlan, mintGltfObjectRetainedRenderStaticPlan, requireGltfObjectRetainedRenderFramePlan, requireGltfObjectRetainedRenderStaticPlan } from "./gltf-object-retained-render-authority";
import {
  GLTF_OBJECT_RETAINED_RENDER_CAPS,
  GLTF_OBJECT_RETAINED_RENDER_FRAME_SCHEMA,
  GLTF_OBJECT_RETAINED_RENDER_SCHEMA,
  GLTF_OBJECT_RETAINED_RENDER_STATIC_SCHEMA,
  type GltfObjectRetainedRenderFramePlan,
  type GltfObjectRetainedRenderFrameSource,
  type GltfObjectRetainedRenderFrameUpload,
  type GltfObjectRetainedRenderRecipe,
  type GltfObjectRetainedRenderSourceMaterial,
  type GltfObjectRetainedRenderStaticPlan,
  type GltfObjectRetainedRenderStaticUpload,
} from "./gltf-object-retained-render-types";
import { requireGltfObjectSceneEvaluationPlan, requireGltfObjectSceneFrame } from "./gltf-object-scene-evaluation-authority";
import { GLTF_OBJECT_SCENE_FRAME_SCHEMA, type GltfObjectSceneFrame } from "./gltf-object-scene-evaluation-types";
import { compileRetainedMeshGeometry, retainedMeshColor, retainedMeshFloatBytes, retainedMeshIndexBytes, retainedMeshViewProjection } from "./retained-mesh-render";

/** Compiles the one retained geometry/instance allocation envelope for an evaluated object scene. */
export function compileGltfObjectRetainedRenderStaticPlan(evaluationValue: unknown, recipeValue: unknown): GltfObjectRetainedRenderStaticPlan {
  const evaluation = requireGltfObjectSceneEvaluationPlan(evaluationValue);
  const { objectPlan, storyPlan, scenePlan } = evaluation.authority;
  const recipe = readRecipe(recipeValue, evaluation.plan.fingerprint, objectPlan.resources.primitives.map((primitive) => primitive.materialIndex));
  const geometries = freeze(objectPlan.resources.primitives.map((primitive) => compileRetainedMeshGeometry(primitive)));
  const first = scenePlan.checkpoints[0]!;
  const instanceSlots = freeze(first.primitiveInstances.map((instance) => freeze({ instanceId: instance.id, primitiveRef: instance.primitiveRef })));
  const vertexBufferBytes = geometries.reduce((sum, item) => sum + item.vertexBufferBytes, 0);
  const indexBufferBytes = geometries.reduce((sum, item) => sum + item.indexBufferBytes, 0);
  const uniformBufferBytes = instanceSlots.length * 256;
  const renderTargetBytes = recipe.viewport.width * recipe.viewport.height * 4;
  const depthTargetBytes = renderTargetBytes;
  const bytesPerRow = Math.ceil((recipe.viewport.width * 4) / 256) * 256;
  const readbackBufferBytes = bytesPerRow * recipe.viewport.height;
  const baseBudget = {
    geometryResourceCount: geometries.length,
    instanceSlotCount: instanceSlots.length,
    reusedInstanceCount: instanceSlots.length - new Set(instanceSlots.map((slot) => slot.primitiveRef)).size,
    vertexBufferBytes,
    indexBufferBytes,
    uniformBufferBytes,
    renderTargetBytes,
    depthTargetBytes,
    readbackBufferBytes,
    retainedGpuBytes: vertexBufferBytes + indexBufferBytes + uniformBufferBytes + renderTargetBytes + depthTargetBytes + readbackBufferBytes,
    caps: GLTF_OBJECT_RETAINED_RENDER_CAPS,
  };
  const base = {
    schema: GLTF_OBJECT_RETAINED_RENDER_STATIC_SCHEMA,
    recipe,
    evaluationFingerprint: evaluation.plan.fingerprint,
    objectFingerprint: objectPlan.fingerprint,
    sceneFingerprint: scenePlan.fingerprint,
    geometries,
    instanceSlots,
    evidence: freeze({
      sharedGeometryRetainedOnce: true as const,
      stableInstanceUniformSlots: true as const,
      exactEvaluatedFramesOnly: true as const,
      perFrameGpuAllocations: 0 as const,
      explicitTerminalReleaseRequired: true as const,
      rendererInvoked: false as const,
      packageRead: false as const,
      packageWritten: false as const,
      physicsInvoked: false as const,
    }),
  };
  let staticPlanBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, staticPlanBytes } }), "utf8");
    if (next === staticPlanBytes) break;
    staticPlanBytes = next;
  }
  enforceBudget(baseBudget, staticPlanBytes);
  const payload = { ...base, budget: freeze({ ...baseBudget, staticPlanBytes }) };
  const plan = freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
  mintGltfObjectRetainedRenderStaticPlan(plan, { evaluationPlan: evaluation.plan, objectPlan, storyPlan, scenePlan });
  return plan;
}

/** Lowers one exact evaluator-issued frame into dynamic bindings over the retained allocation. */
export function compileGltfObjectRetainedRenderFramePlan(staticValue: unknown, frameValue: unknown): GltfObjectRetainedRenderFramePlan {
  const { plan, authority } = requireGltfObjectRetainedRenderStaticPlan(staticValue);
  const frame = assertFrame(frameValue, plan, authority);
  const instances = frame.scene.primitiveInstances;
  if (instances.length !== plan.instanceSlots.length || instances.some((instance, index) => instance.id !== plan.instanceSlots[index]!.instanceId || instance.primitiveRef !== plan.instanceSlots[index]!.primitiveRef)) throw new Error("Imported-object retained frame topology does not match its static instance slots.");
  const matrices = new Map(frame.scene.nodeStates.map((state) => [state.nodeId, state.worldMatrix]));
  const storyMaterials = new Map(authority.storyPlan.materials.map((material) => [material.id, material]));
  const sourceMaterials = new Map(plan.recipe.sourceMaterials.map((material) => [material.materialIndex, material]));
  const bindings = freeze(instances.map((instance) => {
    const matrix = matrices.get(instance.nodeId);
    if (!matrix) throw new Error(`Imported-object retained frame is missing matrix for '${instance.nodeId}'.`);
    const material = instance.material.kind === "story" ? storyMaterials.get(instance.material.materialRef) : sourceMaterials.get(instance.material.materialIndex);
    if (!material) throw new Error(`Imported-object retained frame material for '${instance.id}' is unavailable.`);
    return freeze({ instanceId: instance.id, primitiveRef: instance.primitiveRef, modelMatrix: matrix, color: retainedMeshColor(material.baseColor), emissive: material.emissive });
  }));
  const camera = frame.scene.camera;
  const viewProjection = retainedMeshViewProjection(camera, plan.recipe.viewport);
  const payload = {
    schema: GLTF_OBJECT_RETAINED_RENDER_FRAME_SCHEMA,
    staticFingerprint: plan.fingerprint,
    evaluationFingerprint: plan.evaluationFingerprint,
    sourceFrameFingerprint: frame.fingerprint,
    atUs: frame.atUs,
    viewport: plan.recipe.viewport,
    background: retainedMeshColor(plan.recipe.backgroundColor),
    viewProjection,
    lighting: freeze({ direction: plan.recipe.lighting.direction, color: retainedMeshColor(plan.recipe.lighting.color), ambient: plan.recipe.lighting.ambient, intensity: plan.recipe.lighting.intensity }),
    bindings,
  };
  const framePlan = freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
  mintGltfObjectRetainedRenderFramePlan(framePlan, plan);
  return framePlan;
}

/** Issues only compiler-minted static bytes to the private renderer adapter. */
export function readGltfObjectRetainedRenderStaticUpload(value: unknown): GltfObjectRetainedRenderStaticUpload {
  const { plan } = requireGltfObjectRetainedRenderStaticPlan(value);
  return freeze({
    schema: "shellx-motion/private-gltf-object-retained-render-static-upload@1",
    staticFingerprint: plan.fingerprint,
    width: plan.recipe.viewport.width,
    height: plan.recipe.viewport.height,
    geometries: plan.geometries.map((item) => freeze({
      id: item.id,
      vertexCount: item.vertexCount,
      indexCount: item.indexCount,
      vertexBufferSha256: item.vertexBufferSha256,
      indexBufferSha256: item.indexBufferSha256,
      vertexBufferBytes: item.vertexBufferBytes,
      indexBufferBytes: item.indexBufferBytes,
      verticesBase64: retainedMeshFloatBytes(item.vertices).toString("base64"),
      indicesBase64: retainedMeshIndexBytes(item.indices).toString("base64"),
    })),
    instanceSlots: plan.instanceSlots,
    budget: plan.budget,
  });
}

export function readGltfObjectRetainedRenderFrameUpload(staticValue: unknown, frameValue: unknown): GltfObjectRetainedRenderFrameUpload {
  const { plan } = requireGltfObjectRetainedRenderStaticPlan(staticValue);
  const frame = requireGltfObjectRetainedRenderFramePlan(frameValue, plan);
  if (frame.schema !== GLTF_OBJECT_RETAINED_RENDER_FRAME_SCHEMA) throw new Error("Imported-object retained rendering requires an immutable compiled frame plan.");
  const { fingerprint, ...payload } = frame;
  if (canonicalJsonSha256(payload) !== fingerprint || frame.staticFingerprint !== plan.fingerprint) throw new Error("Imported-object retained frame fingerprint or static binding does not match.");
  return freeze({ ...frame, schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1" });
}

function readRecipe(value: unknown, evaluationFingerprint: string, materialIndices: readonly (number | null)[]): GltfObjectRetainedRenderRecipe {
  const root = exactRecord(snapshotSceneRecipeData(value), ["schema", "evaluationFingerprint", "viewport", "backgroundColor", "lighting", "sourceMaterials"], [], "glTF object retained render recipe");
  if (root.schema !== GLTF_OBJECT_RETAINED_RENDER_SCHEMA) throw new Error(`glTF object retained render recipe.schema must equal ${GLTF_OBJECT_RETAINED_RENDER_SCHEMA}.`);
  if (root.evaluationFingerprint !== evaluationFingerprint) throw new Error("glTF object retained render recipe evaluation fingerprint does not match.");
  const viewport = exactRecord(root.viewport, ["width", "height"], [], "glTF object retained render recipe.viewport");
  const lighting = exactRecord(root.lighting, ["direction", "color", "ambient", "intensity"], [], "glTF object retained render recipe.lighting");
  const sourceMaterials = exactArray(root.sourceMaterials, "glTF object retained render recipe.sourceMaterials", 1, 32).map((entry, index) => readSourceMaterial(entry, index));
  const slots = [...new Set(materialIndices)].sort((left, right) => left === null ? -1 : right === null ? 1 : left - right);
  if (sourceMaterials.length !== slots.length || sourceMaterials.some((material, index) => material.materialIndex !== slots[index])) throw new Error("glTF object retained render sourceMaterials must exactly cover source material slots in ascending order.");
  return freeze({
    schema: GLTF_OBJECT_RETAINED_RENDER_SCHEMA,
    evaluationFingerprint,
    viewport: freeze({ width: integer(viewport.width, "viewport.width", 1, GLTF_OBJECT_RETAINED_RENDER_CAPS.width), height: integer(viewport.height, "viewport.height", 1, GLTF_OBJECT_RETAINED_RENDER_CAPS.height) }),
    backgroundColor: rgb(root.backgroundColor, "backgroundColor"),
    lighting: freeze({ direction: vec3(lighting.direction, "lighting.direction", -1, 1), color: rgb(lighting.color, "lighting.color"), ambient: finite(lighting.ambient, "lighting.ambient", 0, 1), intensity: finite(lighting.intensity, "lighting.intensity", 0, 4) }),
    sourceMaterials: freeze(sourceMaterials),
  });
}

function readSourceMaterial(value: unknown, index: number): GltfObjectRetainedRenderSourceMaterial {
  const record = exactRecord(value, ["materialIndex", "baseColor", "emissive"], [], `sourceMaterials[${index}]`);
  const materialIndex = record.materialIndex === null ? null : integer(record.materialIndex, `sourceMaterials[${index}].materialIndex`, 0, 4_095);
  return freeze({ materialIndex, baseColor: rgb(record.baseColor, `sourceMaterials[${index}].baseColor`), emissive: finite(record.emissive, `sourceMaterials[${index}].emissive`, 0, 1) });
}

function assertFrame(value: unknown, plan: GltfObjectRetainedRenderStaticPlan, authority: import("./gltf-object-retained-render-authority").GltfObjectRetainedRenderAuthority): GltfObjectSceneFrame {
  if (!value || typeof value !== "object" || (value as GltfObjectSceneFrame).schema !== GLTF_OBJECT_SCENE_FRAME_SCHEMA || !Object.isFrozen(value)) throw new Error("Imported-object retained rendering requires an immutable evaluated scene frame.");
  const frame = requireGltfObjectSceneFrame(value, authority.evaluationPlan, authority.scenePlan) as GltfObjectRetainedRenderFrameSource;
  const { fingerprint, ...payload } = frame;
  if (canonicalJsonSha256(payload) !== fingerprint || frame.evaluationFingerprint !== plan.evaluationFingerprint || frame.sceneFingerprint !== plan.sceneFingerprint) throw new Error("Imported-object retained frame identity does not match its static plan.");
  return frame;
}

function enforceBudget(budget: { geometryResourceCount: number; instanceSlotCount: number; vertexBufferBytes: number; indexBufferBytes: number }, planBytes: number): void {
  if (budget.geometryResourceCount > GLTF_OBJECT_RETAINED_RENDER_CAPS.geometryResources || budget.instanceSlotCount > GLTF_OBJECT_RETAINED_RENDER_CAPS.instanceSlots || budget.vertexBufferBytes > GLTF_OBJECT_RETAINED_RENDER_CAPS.vertexBytes || budget.indexBufferBytes > GLTF_OBJECT_RETAINED_RENDER_CAPS.indexBytes || planBytes > GLTF_OBJECT_RETAINED_RENDER_CAPS.staticPlanBytes) throw new Error("Imported-object retained render plan exceeds its fixed resource caps.");
}
