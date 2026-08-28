import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { exactRecord, finite, freeze, safeId, snapshotSceneRecipeData, vec3 } from "./scene-recipe-data";
import {
  GLTF_OBJECT_PLAN_SCHEMA,
  type GltfObjectLocalTransform,
  type GltfObjectNode,
  type GltfObjectPlan,
  type GltfObjectPrimitiveResource,
} from "./gltf-object-plan-types";
import {
  GLTF_OBJECT_STORY_PLAN_SCHEMA,
  type CompiledGltfObjectStoryCheckpoint,
  type CompiledGltfObjectStoryState,
  type GltfObjectStoryPlan,
} from "./gltf-object-story-types";
import {
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

type Matrix4 = readonly number[];

interface LocalBounds {
  readonly min: GltfObjectSceneVec3;
  readonly max: GltfObjectSceneVec3;
}

/** Assembles immutable imported-object and story plans into exact directed-scene checkpoints. */
export function compileGltfObjectScenePlan(
  objectPlan: GltfObjectPlan,
  storyPlan: GltfObjectStoryPlan,
  value: unknown,
): GltfObjectScenePlan {
  assertGltfObjectPlanForScene(objectPlan);
  assertGltfObjectStoryPlanForScene(storyPlan, objectPlan);
  const assembly = readAssembly(value, objectPlan, storyPlan);
  const primitiveById = new Map(objectPlan.resources.primitives.map((primitive) => [primitive.id, primitive]));
  const localBoundsByPrimitive = new Map(objectPlan.resources.primitives.map((primitive) => [primitive.id, primitiveBounds(primitive)]));
  const primitiveInstanceCount = objectPlan.nodes.reduce((sum, node) => sum + node.primitiveRefs.length, 0);
  const nodeStateSampleCount = objectPlan.nodes.length * storyPlan.checkpoints.length;
  const primitiveInstanceSampleCount = primitiveInstanceCount * storyPlan.checkpoints.length;
  const transformedBoundsCornerCount = primitiveInstanceSampleCount * 8;
  enforceAggregateCaps(nodeStateSampleCount, primitiveInstanceSampleCount, transformedBoundsCornerCount);
  const checkpoints = freeze(storyPlan.checkpoints.map((checkpoint) => compileCheckpoint(
    objectPlan.nodes,
    primitiveById,
    localBoundsByPrimitive,
    checkpoint,
    assembly,
  )));
  const baseBudget = {
    nodeCount: objectPlan.nodes.length,
    primitiveResourceCount: objectPlan.resources.primitives.length,
    primitiveInstanceCount,
    checkpointCount: checkpoints.length,
    nodeStateSampleCount,
    primitiveInstanceSampleCount,
    transformedBoundsCornerCount,
    caps: GLTF_OBJECT_SCENE_CAPS,
  };
  const base = {
    schema: GLTF_OBJECT_SCENE_PLAN_SCHEMA,
    assembly,
    assemblySha256: canonicalJsonSha256(assembly),
    objectFingerprint: objectPlan.fingerprint,
    storyFingerprint: storyPlan.fingerprint,
    objectTopologyFingerprint: storyPlan.objectTopologyFingerprint,
    resources: objectPlan.resources,
    materials: storyPlan.materials,
    checkpoints,
    evidence: freeze({
      commonDirectedScene: true as const,
      exactCheckpointComposition: true as const,
      importedLocalThenWrapper: true as const,
      parentWorldComposition: true as const,
      sharedGeometryResources: true as const,
      exactPrimitiveMaterialAssignment: true as const,
      aggregateTransformedBounds: true as const,
      boundedCameraFraming: true as const,
      importedTopologyImmutable: true as const,
      objectAndStoryFingerprintsBound: true as const,
      interpolationPerformed: false as const,
      physicsFieldsAccepted: false as const,
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
  if (planBytes > GLTF_OBJECT_SCENE_CAPS.planBytes) throw new Error(`Imported-object scene plan exceeds the ${GLTF_OBJECT_SCENE_CAPS.planBytes}-byte cap.`);
  const payload = { ...base, budget: freeze({ ...baseBudget, planBytes }) };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function readAssembly(value: unknown, objectPlan: GltfObjectPlan, storyPlan: GltfObjectStoryPlan): GltfObjectSceneAssembly {
  const root = exactRecord(snapshotSceneRecipeData(value), ["schema", "id", "objectFingerprint", "storyFingerprint", "camera"], [], "glTF object scene assembly");
  if (root.schema !== GLTF_OBJECT_SCENE_SCHEMA) throw new Error(`glTF object scene assembly.schema must equal ${GLTF_OBJECT_SCENE_SCHEMA}.`);
  if (root.objectFingerprint !== objectPlan.fingerprint) throw new Error("glTF object scene assembly.objectFingerprint does not match the imported object plan.");
  if (root.storyFingerprint !== storyPlan.fingerprint) throw new Error("glTF object scene assembly.storyFingerprint does not match the imported object story plan.");
  const camera = exactRecord(root.camera, ["viewDirection", "fovDeg", "padding"], [], "glTF object scene assembly.camera");
  const viewDirection = vec3(camera.viewDirection, "glTF object scene assembly.camera.viewDirection", -1_000, 1_000);
  if (vectorLength(viewDirection) < 0.000_001) throw new Error("glTF object scene assembly.camera.viewDirection must be non-zero.");
  return freeze({
    schema: GLTF_OBJECT_SCENE_SCHEMA,
    id: safeId(root.id, "glTF object scene assembly.id"),
    objectFingerprint: objectPlan.fingerprint,
    storyFingerprint: storyPlan.fingerprint,
    camera: freeze({
      viewDirection,
      fovDeg: finite(camera.fovDeg, "glTF object scene assembly.camera.fovDeg", 10, 120),
      padding: finite(camera.padding, "glTF object scene assembly.camera.padding", 1, 4),
    }),
  });
}

export function assertGltfObjectPlanForScene(plan: GltfObjectPlan): void {
  if (!plan || typeof plan !== "object" || plan.schema !== GLTF_OBJECT_PLAN_SCHEMA || !Object.isFrozen(plan)) throw new Error("Imported-object scene assembly requires an immutable compiled glTF object plan.");
  const { fingerprint, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) throw new Error("Compiled glTF object plan fingerprint does not match its contents.");
}

export function assertGltfObjectStoryPlanForScene(plan: GltfObjectStoryPlan, objectPlan: GltfObjectPlan): void {
  if (!plan || typeof plan !== "object" || plan.schema !== GLTF_OBJECT_STORY_PLAN_SCHEMA || !Object.isFrozen(plan)) throw new Error("Imported-object scene assembly requires an immutable compiled glTF object story plan.");
  const { fingerprint, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) throw new Error("Compiled glTF object story plan fingerprint does not match its contents.");
  if (plan.objectFingerprint !== objectPlan.fingerprint) throw new Error("Compiled glTF object story plan is bound to a different imported object plan.");
  const topologyFingerprint = canonicalJsonSha256({
    roots: objectPlan.rootNodeIds,
    resources: objectPlan.resources.primitives.map((resource) => ({ id: resource.id, meshIndex: resource.meshIndex, primitiveIndex: resource.primitiveIndex, geometrySha256: resource.geometrySha256 })),
    nodes: objectPlan.nodes.map((node) => ({ id: node.id, parentId: node.parentId, childIds: node.childIds, primitiveRefs: node.primitiveRefs })),
  });
  if (plan.objectTopologyFingerprint !== topologyFingerprint) throw new Error("Compiled glTF object story topology fingerprint does not match the imported object plan.");
}

function enforceAggregateCaps(nodeStates: number, instances: number, corners: number): void {
  if (nodeStates > GLTF_OBJECT_SCENE_CAPS.nodeStateSamples) throw new Error(`Imported-object scene exceeds the ${GLTF_OBJECT_SCENE_CAPS.nodeStateSamples}-node-state-sample cap.`);
  if (instances > GLTF_OBJECT_SCENE_CAPS.primitiveInstanceSamples) throw new Error(`Imported-object scene exceeds the ${GLTF_OBJECT_SCENE_CAPS.primitiveInstanceSamples}-primitive-instance-sample cap.`);
  if (corners > GLTF_OBJECT_SCENE_CAPS.transformedBoundsCorners) throw new Error(`Imported-object scene exceeds the ${GLTF_OBJECT_SCENE_CAPS.transformedBoundsCorners}-transformed-bounds-corner cap.`);
}

export function assembleGltfObjectSceneCheckpoint(objectPlan: GltfObjectPlan, checkpoint: CompiledGltfObjectStoryCheckpoint, assembly: GltfObjectSceneAssembly): GltfObjectSceneCheckpoint {
  const primitiveById = new Map(objectPlan.resources.primitives.map((primitive) => [primitive.id, primitive]));
  const localBounds = new Map(objectPlan.resources.primitives.map((primitive) => [primitive.id, primitiveBounds(primitive)]));
  return compileCheckpoint(objectPlan.nodes, primitiveById, localBounds, checkpoint, assembly);
}

function compileCheckpoint(
  nodes: readonly GltfObjectNode[],
  primitiveById: ReadonlyMap<string, GltfObjectPrimitiveResource>,
  localBoundsByPrimitive: ReadonlyMap<string, LocalBounds>,
  checkpoint: CompiledGltfObjectStoryCheckpoint,
  assembly: GltfObjectSceneAssembly,
): GltfObjectSceneCheckpoint {
  const transformByNode = new Map<string, CompiledGltfObjectStoryState>();
  const materialByAuthority = new Map<string, string>();
  for (const state of checkpoint.states) {
    if (state.primitiveRef === null) {
      if (transformByNode.has(state.nodeId)) throw new Error(`Imported-object scene checkpoint '${checkpoint.id}' contains competing transform authority for node '${state.nodeId}'.`);
      transformByNode.set(state.nodeId, state);
    } else {
      const authority = `${state.nodeId}\u0000${state.primitiveRef}`;
      if (materialByAuthority.has(authority)) throw new Error(`Imported-object scene checkpoint '${checkpoint.id}' contains competing material authority for node '${state.nodeId}' primitive '${state.primitiveRef}'.`);
      materialByAuthority.set(authority, (state.value as { materialRef: string }).materialRef);
    }
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const localById = new Map<string, Matrix4>();
  const worldById = new Map<string, Matrix4>();
  const active = new Set<string>();
  const worldFor = (node: GltfObjectNode): Matrix4 => {
    const cached = worldById.get(node.id);
    if (cached) return cached;
    if (active.has(node.id)) throw new Error("Imported-object scene hierarchy contains a cycle.");
    active.add(node.id);
    const importedLocal = importedLocalMatrix(node.localTransform);
    assertMatrixBound(importedLocal, `Imported-object scene node '${node.id}' imported matrix`);
    const state = transformByNode.get(node.id);
    const wrapper = state ? storyWrapperMatrix(state) : null;
    if (wrapper) assertMatrixBound(wrapper, `Imported-object scene node '${node.id}' story wrapper matrix`);
    const local = wrapper ? multiplyMatrix(importedLocal, wrapper) : importedLocal;
    const world = node.parentId === null ? local : multiplyMatrix(worldFor(requiredNode(nodeById, node.parentId)), local);
    active.delete(node.id);
    assertMatrixBound(local, `Imported-object scene node '${node.id}' local matrix`);
    assertMatrixBound(world, `Imported-object scene node '${node.id}' world matrix`);
    localById.set(node.id, local);
    worldById.set(node.id, world);
    return world;
  };
  for (const node of nodes) worldFor(node);
  const nodeStates = freeze(nodes.map((node): GltfObjectSceneNodeState => {
    const localMatrix = localById.get(node.id)!, worldMatrix = worldById.get(node.id)!;
    return freeze({ nodeId: node.id, localMatrix, localMatrixSha256: canonicalJsonSha256(localMatrix), worldMatrix, worldMatrixSha256: canonicalJsonSha256(worldMatrix) });
  }));
  const primitiveInstances = freeze(nodes.flatMap((node) => node.primitiveRefs.map((primitiveRef, index): GltfObjectScenePrimitiveInstance => {
    const primitive = primitiveById.get(primitiveRef);
    if (!primitive) throw new Error(`Imported-object scene node '${node.id}' references unknown primitive '${primitiveRef}'.`);
    const materialRef = materialByAuthority.get(`${node.id}\u0000${primitiveRef}`);
    const material: GltfObjectSceneMaterialAssignment = materialRef === undefined
      ? freeze({ kind: "source" as const, materialIndex: primitive.materialIndex })
      : freeze({ kind: "story" as const, materialRef });
    return freeze({ id: `${node.id}.instance.${String(index).padStart(2, "0")}`, nodeId: node.id, primitiveRef, material });
  })));
  const bounds = sceneBounds(primitiveInstances, worldById, localBoundsByPrimitive);
  const camera = fittedCamera(bounds, assembly.camera);
  const statePayload = { nodeStates, primitiveInstances, bounds, camera };
  const payload = { id: checkpoint.id, atUs: checkpoint.atUs, ...statePayload, stateSha256: canonicalJsonSha256(statePayload) };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function requiredNode(nodes: ReadonlyMap<string, GltfObjectNode>, id: string): GltfObjectNode {
  const node = nodes.get(id);
  if (!node) throw new Error(`Imported-object scene hierarchy references unknown parent '${id}'.`);
  return node;
}

function importedLocalMatrix(transform: GltfObjectLocalTransform): Matrix4 {
  if (transform.kind === "matrix") return normalizedMatrix(transform.matrix);
  const [x, y, z, w] = transform.rotation, [sx, sy, sz] = transform.scale;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return normalizedMatrix([
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    transform.translation[0], transform.translation[1], transform.translation[2], 1,
  ]);
}

function storyWrapperMatrix(state: CompiledGltfObjectStoryState): Matrix4 {
  const value = state.value as { translation: readonly [number, number, number]; rotationDeg: readonly [number, number, number]; scale: number };
  const [rx, ry, rz] = value.rotationDeg.map(stableRadians), [tx, ty, tz] = value.translation, scale = value.scale;
  const cx = stableTrig(Math.cos(rx)), sx = stableTrig(Math.sin(rx));
  const cy = stableTrig(Math.cos(ry)), sy = stableTrig(Math.sin(ry));
  const cz = stableTrig(Math.cos(rz)), sz = stableTrig(Math.sin(rz));
  const rotationX = normalizedMatrix([1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]);
  const rotationY = normalizedMatrix([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const rotationZ = normalizedMatrix([cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const scaling = normalizedMatrix([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
  const translation = normalizedMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]);
  return multiplyMatrix(translation, multiplyMatrix(rotationZ, multiplyMatrix(rotationY, multiplyMatrix(rotationX, scaling))));
}

function multiplyMatrix(left: Matrix4, right: Matrix4): Matrix4 {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1) value += left[inner * 4 + row]! * right[column * 4 + inner]!;
      result[column * 4 + row] = sceneFloat(value);
    }
  }
  return freeze(result);
}

function primitiveBounds(primitive: GltfObjectPrimitiveResource): LocalBounds {
  const positions = primitive.geometry.positions;
  if (positions.length < 3 || positions.length % 3 !== 0) throw new Error(`Imported-object primitive '${primitive.id}' has invalid position geometry.`);
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis]!;
      if (!Number.isFinite(value)) throw new Error(`Imported-object primitive '${primitive.id}' contains a non-finite position.`);
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return freeze({ min: tuple3(min), max: tuple3(max) });
}

function sceneBounds(
  instances: readonly GltfObjectScenePrimitiveInstance[],
  worldById: ReadonlyMap<string, Matrix4>,
  localBoundsByPrimitive: ReadonlyMap<string, LocalBounds>,
): GltfObjectSceneBounds {
  if (instances.length === 0) throw new Error("Imported-object scene requires at least one primitive instance for camera framing.");
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const instance of instances) {
    const world = worldById.get(instance.nodeId)!, local = localBoundsByPrimitive.get(instance.primitiveRef)!;
    for (const x of [local.min[0], local.max[0]]) for (const y of [local.min[1], local.max[1]]) for (const z of [local.min[2], local.max[2]]) {
      const point = transformPoint(world, [x, y, z]);
      for (let axis = 0; axis < 3; axis += 1) {
        if (Math.abs(point[axis]!) > GLTF_OBJECT_SCENE_CAPS.boundsCoordinateMagnitude) throw new Error(`Imported-object scene bounds exceed the ${GLTF_OBJECT_SCENE_CAPS.boundsCoordinateMagnitude}-coordinate cap.`);
        min[axis] = Math.min(min[axis]!, point[axis]!);
        max[axis] = Math.max(max[axis]!, point[axis]!);
      }
    }
  }
  const center = tuple3(min.map((value, axis) => sceneFloat((value + max[axis]!) / 2)));
  const radius = sceneFloat(Math.sqrt(max.reduce((sum, value, axis) => sum + (value - center[axis]!) ** 2, 0)));
  return freeze({ min: tuple3(min), max: tuple3(max), center, radius });
}

function fittedCamera(bounds: GltfObjectSceneBounds, declaration: GltfObjectSceneAssembly["camera"]): GltfObjectSceneCamera {
  const length = vectorLength(declaration.viewDirection);
  const direction = tuple3(declaration.viewDirection.map((value) => sceneFloat(value / length)));
  const paddedRadius = Math.max(0.001, bounds.radius * declaration.padding);
  const distance = sceneFloat(paddedRadius / Math.sin(stableRadians(declaration.fovDeg / 2)));
  if (!Number.isFinite(distance) || distance > GLTF_OBJECT_SCENE_CAPS.cameraDistance) throw new Error(`Imported-object fitted camera exceeds the ${GLTF_OBJECT_SCENE_CAPS.cameraDistance}-distance cap.`);
  const position = tuple3(bounds.center.map((value, axis) => sceneFloat(value - direction[axis]! * distance)));
  const clipRadius = paddedRadius * 1.25;
  const near = sceneFloat(Math.max(0.001, distance - clipRadius));
  const far = sceneFloat(Math.max(near + 0.001, distance + clipRadius));
  return freeze({ position, target: bounds.center, viewDirection: direction, fovDeg: declaration.fovDeg, near, far, padding: declaration.padding });
}

function transformPoint(matrix: Matrix4, point: GltfObjectSceneVec3): GltfObjectSceneVec3 {
  return tuple3([
    sceneFloat(matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!),
    sceneFloat(matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!),
    sceneFloat(matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!),
  ]);
}

function assertMatrixBound(matrix: Matrix4, label: string): void {
  const invalidIndex = matrix.findIndex((value) => !Number.isFinite(value) || Math.abs(value) > GLTF_OBJECT_SCENE_CAPS.matrixComponentMagnitude);
  if (matrix.length !== 16 || invalidIndex >= 0) throw new Error(`${label} exceeds the finite ${GLTF_OBJECT_SCENE_CAPS.matrixComponentMagnitude}-component cap at index ${invalidIndex}: ${String(matrix[invalidIndex])}.`);
}

function normalizedMatrix(values: readonly number[]): Matrix4 {
  if (values.length !== 16) throw new Error("Imported-object scene internal matrix must contain exactly 16 components.");
  return freeze(values.map(sceneFloat));
}
function tuple3(values: readonly number[]): GltfObjectSceneVec3 { return freeze(values.map(sceneFloat)) as unknown as GltfObjectSceneVec3; }
function vectorLength(value: GltfObjectSceneVec3): number { return Math.sqrt(value.reduce((sum, entry) => sum + entry * entry, 0)); }
function stableRadians(degrees: number): number { return ((degrees % 360) * Math.PI) / 180; }
function stableTrig(value: number): number { return Math.round(value * 10_000_000) / 10_000_000; }
function sceneFloat(value: number): number { const normalized = Math.abs(value) < 1e-7 ? 0 : Math.fround(value); return Object.is(normalized, -0) ? 0 : normalized; }
