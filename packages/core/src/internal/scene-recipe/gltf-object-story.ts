import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { exactArray, exactRecord, finite, freeze, rgb, safeId, safeUs, snapshotSceneRecipeData, strictIds, uniqueIds, vec3 } from "./scene-recipe-data";
import { GLTF_OBJECT_PLAN_SCHEMA, type GltfObjectPlan } from "./gltf-object-plan-types";
import {
  GLTF_OBJECT_STORY_CAPS,
  GLTF_OBJECT_STORY_PLAN_SCHEMA,
  GLTF_OBJECT_STORY_SCHEMA,
  type CompiledGltfObjectStoryControl,
  type CompiledGltfObjectStoryState,
  type GltfObjectStory,
  type GltfObjectStoryCheckpoint,
  type GltfObjectStoryControl,
  type GltfObjectStoryMaterial,
  type GltfObjectStoryPlan,
  type GltfObjectStoryState,
} from "./gltf-object-story-types";

/** Resolves exact role-addressed imported-object checkpoints without changing imported topology. */
export function compileGltfObjectStoryPlan(objectPlan: GltfObjectPlan, value: unknown): GltfObjectStoryPlan {
  assertObjectPlan(objectPlan);
  const story = readStory(value, objectPlan);
  const nodeIdByRole = new Map(objectPlan.roles.map((role) => [role.roleId, role.nodeId]));
  const controls = freeze(story.controls.map((control) => freeze({ ...control, nodeId: nodeIdByRole.get(control.roleId)! })) as CompiledGltfObjectStoryControl[]);
  const controlById = new Map(controls.map((control) => [control.id, control]));
  const checkpoints = freeze(story.checkpoints.map((checkpoint) => {
    const states = freeze(checkpoint.states.map((state) => {
      const control = controlById.get(state.controlId)!;
      return freeze({ ...state, nodeId: control.nodeId, primitiveRef: control.kind === "material" ? control.primitiveRef : null }) as CompiledGltfObjectStoryState;
    }));
    return freeze({ id: checkpoint.id, atUs: checkpoint.atUs, states, stateSha256: canonicalJsonSha256(states) });
  }));
  const objectTopologyFingerprint = canonicalJsonSha256({
    roots: objectPlan.rootNodeIds,
    resources: objectPlan.resources.primitives.map((resource) => ({ id: resource.id, meshIndex: resource.meshIndex, primitiveIndex: resource.primitiveIndex, geometrySha256: resource.geometrySha256 })),
    nodes: objectPlan.nodes.map((node) => ({ id: node.id, parentId: node.parentId, childIds: node.childIds, primitiveRefs: node.primitiveRefs })),
  });
  const baseBudget = {
    materialCount: story.materials.length,
    transformControlCount: controls.filter((control) => control.kind === "transform").length,
    materialControlCount: controls.filter((control) => control.kind === "material").length,
    checkpointCount: checkpoints.length,
    stateSampleCount: controls.length * checkpoints.length,
    caps: GLTF_OBJECT_STORY_CAPS,
  };
  const base = {
    schema: GLTF_OBJECT_STORY_PLAN_SCHEMA,
    objectFingerprint: objectPlan.fingerprint,
    objectTopologyFingerprint,
    story,
    storySha256: canonicalJsonSha256(story),
    materials: story.materials,
    controls,
    checkpoints,
    evidence: freeze({
      exactCheckpointStates: true as const,
      explicitRoleAddressing: true as const,
      wrapperTransformsOnly: true as const,
      materialSlotsExplicit: true as const,
      importedTopologyImmutable: true as const,
      importedGeometryImmutable: true as const,
      objectFingerprintBound: true as const,
      rendererInvoked: false as const,
      packageRead: false as const,
      packageWritten: false as const,
    }),
  };
  let planBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, planBytes } }), "utf8");
    if (next === planBytes) break;
    planBytes = next;
  }
  if (planBytes > GLTF_OBJECT_STORY_CAPS.planBytes) throw new Error(`Imported glTF object story plan exceeds the ${GLTF_OBJECT_STORY_CAPS.planBytes}-byte cap.`);
  const payload = { ...base, budget: freeze({ ...baseBudget, planBytes }) };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function assertObjectPlan(plan: GltfObjectPlan): void {
  if (!plan || typeof plan !== "object" || plan.schema !== GLTF_OBJECT_PLAN_SCHEMA || !Object.isFrozen(plan)) throw new Error("Imported-object story requires an immutable compiled glTF object plan.");
  const { fingerprint, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) throw new Error("Compiled glTF object plan fingerprint does not match its contents.");
}

function readStory(value: unknown, objectPlan: GltfObjectPlan): GltfObjectStory {
  const root = exactRecord(snapshotSceneRecipeData(value), ["schema", "objectFingerprint", "startUs", "endUs", "materials", "controls", "checkpoints"], [], "glTF object story");
  if (root.schema !== GLTF_OBJECT_STORY_SCHEMA) throw new Error(`glTF object story.schema must equal ${GLTF_OBJECT_STORY_SCHEMA}.`);
  if (root.objectFingerprint !== objectPlan.fingerprint) throw new Error("glTF object story.objectFingerprint does not match the imported object plan.");
  const startUs = safeUs(root.startUs, "glTF object story.startUs"), endUs = safeUs(root.endUs, "glTF object story.endUs");
  if (endUs <= startUs) throw new Error("glTF object story.endUs must be greater than startUs.");
  const materials = exactArray(root.materials, "glTF object story.materials", 0, GLTF_OBJECT_STORY_CAPS.materials).map(readMaterial);
  strictIds(materials.map((material) => material.id), "glTF object story material ids");
  const materialIds = new Set(materials.map((material) => material.id));
  const controls = readControls(root.controls, objectPlan);
  const checkpoints = exactArray(root.checkpoints, "glTF object story.checkpoints", 2, GLTF_OBJECT_STORY_CAPS.checkpoints).map((checkpoint, index) => readCheckpoint(checkpoint, index, controls, materialIds));
  uniqueIds(checkpoints.map((checkpoint) => checkpoint.id), "glTF object story checkpoint ids");
  if (checkpoints[0]!.atUs !== startUs || checkpoints.at(-1)!.atUs !== endUs) throw new Error("glTF object story checkpoints must include the exact story start and end.");
  for (let index = 1; index < checkpoints.length; index += 1) if (checkpoints[index]!.atUs <= checkpoints[index - 1]!.atUs) throw new Error("glTF object story checkpoint times must be strictly ascending.");
  if (controls.length * checkpoints.length > GLTF_OBJECT_STORY_CAPS.stateSamples) throw new Error(`glTF object story exceeds the ${GLTF_OBJECT_STORY_CAPS.stateSamples}-state-sample cap.`);
  const usedMaterials = new Set(checkpoints.flatMap((checkpoint) => checkpoint.states.flatMap((state, index) => controls[index]!.kind === "material" ? [(state as { value: { materialRef: string } }).value.materialRef] : [])));
  const unused = materials.find((material) => !usedMaterials.has(material.id));
  if (unused) throw new Error(`glTF object story material '${unused.id}' is never used by a checkpoint.`);
  return freeze({ schema: GLTF_OBJECT_STORY_SCHEMA, objectFingerprint: objectPlan.fingerprint, startUs, endUs, materials, controls, checkpoints });
}

function readMaterial(value: unknown, index: number): GltfObjectStoryMaterial {
  const label = `glTF object story.materials[${index}]`, record = exactRecord(value, ["id", "kind", "baseColor", "emissive"], [], label);
  if (record.kind !== "basic") throw new Error(`${label}.kind must equal basic.`);
  return freeze({ id: safeId(record.id, `${label}.id`), kind: "basic", baseColor: rgb(record.baseColor, `${label}.baseColor`), emissive: finite(record.emissive, `${label}.emissive`, 0, 1) });
}

function readControls(value: unknown, objectPlan: GltfObjectPlan): GltfObjectStoryControl[] {
  const roles = new Map(objectPlan.roles.map((role) => [role.roleId, role]));
  const nodes = new Map(objectPlan.nodes.map((node) => [node.id, node]));
  const controls = exactArray(value, "glTF object story.controls", 1, GLTF_OBJECT_STORY_CAPS.controls).map((entry, index) => {
    const label = `glTF object story.controls[${index}]`, record = exactRecord(entry, ["id", "kind", "roleId"], ["primitiveRef"], label);
    const id = safeId(record.id, `${label}.id`), roleId = safeId(record.roleId, `${label}.roleId`), role = roles.get(roleId);
    if (!role) throw new Error(`${label}.roleId does not identify an explicit imported-object role.`);
    if (record.kind === "transform") {
      if (record.primitiveRef !== undefined) throw new Error(`${label} transform control cannot contain primitiveRef.`);
      return freeze({ id, kind: "transform" as const, roleId });
    }
    if (record.kind !== "material") throw new Error(`${label}.kind must equal transform or material.`);
    const primitiveRef = safeId(record.primitiveRef, `${label}.primitiveRef`), node = nodes.get(role.nodeId)!;
    if (!node.primitiveRefs.includes(primitiveRef)) throw new Error(`${label}.primitiveRef is not directly attached to the role-bound node.`);
    return freeze({ id, kind: "material" as const, roleId, primitiveRef });
  });
  strictIds(controls.map((control) => control.id), "glTF object story control ids");
  const authorityKeys = controls.map((control) => {
    const nodeId = roles.get(control.roleId)!.nodeId;
    return control.kind === "transform" ? `transform:${nodeId}` : `material:${nodeId}:${control.primitiveRef}`;
  });
  uniqueIds(authorityKeys, "glTF object story control authorities");
  return controls;
}

function readCheckpoint(value: unknown, index: number, controls: readonly GltfObjectStoryControl[], materialIds: ReadonlySet<string>): GltfObjectStoryCheckpoint {
  const label = `glTF object story.checkpoints[${index}]`, record = exactRecord(value, ["id", "atUs", "states"], [], label);
  const states = exactArray(record.states, `${label}.states`, controls.length, controls.length).map((state, stateIndex) => readState(state, `${label}.states[${stateIndex}]`, controls[stateIndex]!, materialIds));
  return freeze({ id: safeId(record.id, `${label}.id`), atUs: safeUs(record.atUs, `${label}.atUs`), states });
}

function readState(value: unknown, label: string, control: GltfObjectStoryControl, materialIds: ReadonlySet<string>): GltfObjectStoryState {
  const record = exactRecord(value, ["controlId", "value"], [], label);
  if (record.controlId !== control.id) throw new Error(`${label}.controlId must match the control order exactly.`);
  if (control.kind === "transform") {
    const transform = exactRecord(record.value, ["translation", "rotationDeg", "scale"], [], `${label}.value`);
    return freeze({ controlId: control.id, value: freeze({ translation: vec3(transform.translation, `${label}.value.translation`, -1_000, 1_000), rotationDeg: vec3(transform.rotationDeg, `${label}.value.rotationDeg`, -36_000, 36_000), scale: finite(transform.scale, `${label}.value.scale`, 0.001, 100) }) });
  }
  const material = exactRecord(record.value, ["materialRef"], [], `${label}.value`), materialRef = safeId(material.materialRef, `${label}.value.materialRef`);
  if (!materialIds.has(materialRef)) throw new Error(`${label}.value.materialRef does not identify a declared story material.`);
  return freeze({ controlId: control.id, value: freeze({ materialRef }) });
}
