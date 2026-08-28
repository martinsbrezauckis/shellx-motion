import {
  MAX_SCENE_3D_LAYERS,
  MAX_SCENE_3D_MESH_INDICES_PER_OBJECT,
  MAX_SCENE_3D_MESH_INDICES_TOTAL,
  MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT,
  MAX_SCENE_3D_MESH_VERTICES_TOTAL,
  MAX_SCENE_3D_OBJECTS_PER_LAYER,
  MAX_SCENE_3D_OBJECTS_TOTAL,
  SCENE_3D_CONTROL_BOUNDS,
  SCENE_3D_MESH_SCHEMA,
  SCENE_3D_PRIMITIVES,
  SCENE_3D_SCHEMA,
  SCENE_3D_SCHEMAS,
} from "./scene-3d";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";

export interface Scene3DValidationError { path: string; message: string }

export function validateScene3DLayers(layers: unknown[], errors: Scene3DValidationError[]): void {
  const sceneLayers = layers.map((value, index) => ({ layer: record(value), index })).filter((entry) => entry.layer?.type === "scene3d");
  for (const { index } of sceneLayers.slice(MAX_SCENE_3D_LAYERS)) {
    errors.push({ path: `/layers/${index}/type`, message: `at most ${MAX_SCENE_3D_LAYERS} scene3d layers are supported` });
  }
  const totals = { objects: 0, meshVertices: 0, meshIndices: 0 };
  for (const { layer, index } of sceneLayers) {
    if (!layer) continue;
    validateSceneLayer(layer, `/layers/${index}`, totals, errors);
  }
  if (totals.objects > MAX_SCENE_3D_OBJECTS_TOTAL) {
    errors.push({ path: "/layers", message: `scene3d layers may contain at most ${MAX_SCENE_3D_OBJECTS_TOTAL} objects in total` });
  }
  if (totals.meshVertices > MAX_SCENE_3D_MESH_VERTICES_TOTAL) {
    errors.push({ path: "/layers", message: `scene3d layers may contain at most ${MAX_SCENE_3D_MESH_VERTICES_TOTAL} mesh vertices in total` });
  }
  if (totals.meshIndices > MAX_SCENE_3D_MESH_INDICES_TOTAL) {
    errors.push({ path: "/layers", message: `scene3d layers may contain at most ${MAX_SCENE_3D_MESH_INDICES_TOTAL} mesh indices in total` });
  }
}

function validateSceneLayer(
  layer: Record<string, unknown>,
  path: string,
  totals: { objects: number; meshVertices: number; meshIndices: number },
  errors: Scene3DValidationError[],
): void {
  const scene = record(layer.scene3d);
  if (!scene) {
    errors.push({ path: `${path}/scene3d`, message: "must be an object" });
    return;
  }
  const schema = scene.schema;
  if (!(SCENE_3D_SCHEMAS as readonly unknown[]).includes(schema)) {
    errors.push({ path: `${path}/scene3d/schema`, message: `must be ${SCENE_3D_SCHEMA} or ${SCENE_3D_MESH_SCHEMA}` });
  }
  if (!hexColor(scene.backgroundColor)) errors.push({ path: `${path}/scene3d/backgroundColor`, message: "must be a #RRGGBB color" });
  validateCamera(scene.camera, `${path}/scene3d/camera`, errors);
  validateLighting(scene.lighting, `${path}/scene3d/lighting`, errors);
  if (!Array.isArray(scene.objects) || scene.objects.length === 0) {
    errors.push({ path: `${path}/scene3d/objects`, message: "must contain at least one object" });
  } else {
    totals.objects += scene.objects.length;
    if (scene.objects.length > MAX_SCENE_3D_OBJECTS_PER_LAYER) {
      errors.push({ path: `${path}/scene3d/objects`, message: `must contain at most ${MAX_SCENE_3D_OBJECTS_PER_LAYER} objects` });
    }
    const ids = new Set<string>();
    scene.objects.forEach((value, objectIndex) => validateObject(
      value,
      `${path}/scene3d/objects/${objectIndex}`,
      ids,
      schema === SCENE_3D_MESH_SCHEMA,
      totals,
      errors,
    ));
  }
  for (const field of ["text", "shape", "fill", "source", "src", "assetId", "assetRef", "label", "gradient", "emitter", "shader"] as const) {
    if (field in layer) errors.push({ path: `${path}/${field}`, message: "is not supported on scene3d layers" });
  }
}

function validateObject(
  value: unknown,
  path: string,
  ids: Set<string>,
  meshAllowed: boolean,
  totals: { meshVertices: number; meshIndices: number },
  errors: Scene3DValidationError[],
): void {
  const object = record(value);
  if (!object) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const id = string(object.id);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) errors.push({ path: `${path}/id`, message: "must be a safe object id" });
  else if (ids.has(id)) errors.push({ path: `${path}/id`, message: "must be unique within the scene" });
  else ids.add(id);
  const fixed = (SCENE_3D_PRIMITIVES as readonly unknown[]).includes(object.primitive);
  if (object.primitive === "mesh" && meshAllowed) validateMesh(object, path, totals, errors);
  else if (!fixed) errors.push({ path: `${path}/primitive`, message: meshAllowed ? "must be box, pyramid, plane, or mesh" : "must be box, pyramid, plane" });
  vector(object.position, `${path}/position`, ...SCENE_3D_CONTROL_BOUNDS.position, errors);
  vector(object.rotationDeg, `${path}/rotationDeg`, ...SCENE_3D_CONTROL_BOUNDS.rotationDeg, errors);
  if (object.spinDegPerSecond !== undefined) vector(object.spinDegPerSecond, `${path}/spinDegPerSecond`, ...SCENE_3D_CONTROL_BOUNDS.angularVelocity, errors);
  number(object.scale, `${path}/scale`, ...SCENE_3D_CONTROL_BOUNDS.scale, errors);
  if (!hexColor(object.color)) errors.push({ path: `${path}/color`, message: "must be a #RRGGBB color" });
  if (object.emissive !== undefined) number(object.emissive, `${path}/emissive`, ...SCENE_3D_CONTROL_BOUNDS.emissive, errors);
}

function validateMesh(
  object: Record<string, unknown>,
  path: string,
  totals: { meshVertices: number; meshIndices: number },
  errors: Scene3DValidationError[],
): void {
  const geometry = record(object.geometry);
  if (!geometry) {
    errors.push({ path: `${path}/geometry`, message: "must be an object" });
    return;
  }
  const positions = geometry.positions;
  const normals = geometry.normals;
  const indices = geometry.indices;
  const validPositions = finiteArray(
    positions,
    9,
    MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT * 3,
    3,
    -10_000,
    10_000,
  );
  if (!validPositions) {
    errors.push({
      path: `${path}/geometry/positions`,
      message: `must contain 3-${MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT} finite vec3 vertices`,
    });
  }
  const boundedNormals = finiteArray(
    normals,
    9,
    MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT * 3,
    3,
    -1.001,
    1.001,
  );
  const matchingNormals = Array.isArray(positions) && Array.isArray(normals) && positions.length === normals.length;
  if (!boundedNormals || !matchingNormals) {
    errors.push({ path: `${path}/geometry/normals`, message: "must contain one bounded normal per position" });
  }
  const vertexCount = validPositions && Array.isArray(positions) ? positions.length / 3 : 0;
  const validIndices = integerArray(indices, 3, MAX_SCENE_3D_MESH_INDICES_PER_OBJECT, 3, vertexCount);
  if (!validIndices) {
    errors.push({
      path: `${path}/geometry/indices`,
      message: `must contain bounded triangle indices within the ${MAX_SCENE_3D_MESH_INDICES_PER_OBJECT} index limit`,
    });
  }
  totals.meshVertices += vertexCount;
  totals.meshIndices += validIndices && Array.isArray(indices) ? indices.length : 0;
  const source = record(object.source);
  const validSource = source
    && ["gltf", "glb"].includes(String(source.format))
    && integer(source.meshIndex)
    && integer(source.primitiveIndex)
    && (source.materialIndex === undefined || integer(source.materialIndex))
    && typeof source.geometrySha256 === "string"
    && /^[a-f0-9]{64}$/.test(source.geometrySha256);
  if (!validSource) {
    errors.push({ path: `${path}/source`, message: "must identify bounded glTF mesh, primitive, optional material indices, and exact geometry SHA-256" });
  } else if (validPositions && boundedNormals && matchingNormals && validIndices && Array.isArray(positions) && Array.isArray(normals) && Array.isArray(indices)
    && scene3dMeshGeometrySha256({ positions, normals, indices }) !== source.geometrySha256) {
    errors.push({ path: `${path}/source/geometrySha256`, message: "must match the exact bounded glTF geometry payload" });
  }
}

function validateCamera(value: unknown, path: string, errors: Scene3DValidationError[]): void {
  const camera = record(value);
  if (!camera) { errors.push({ path, message: "must be an object" }); return; }
  vector(camera.position, `${path}/position`, ...SCENE_3D_CONTROL_BOUNDS.position, errors);
  vector(camera.target, `${path}/target`, ...SCENE_3D_CONTROL_BOUNDS.position, errors);
  if (Array.isArray(camera.position) && Array.isArray(camera.target) && camera.position.length === 3 && camera.target.length === 3) {
    const target = camera.target;
    const view = camera.position.map((entry, axis) => Number(entry) - Number(target[axis]));
    const invalidView = Math.hypot(...view) < 0.000_001 || Math.hypot(view[0], view[2]) < 0.000_001;
    if (view.every(Number.isFinite) && invalidView) {
      errors.push({ path: `${path}/position`, message: "must define a non-vertical view distinct from target" });
    }
  }
  number(camera.fovDeg, `${path}/fovDeg`, ...SCENE_3D_CONTROL_BOUNDS.cameraFovDeg, errors);
  number(camera.near, `${path}/near`, ...SCENE_3D_CONTROL_BOUNDS.cameraNear, errors);
  const near = finite(camera.near) ?? 0;
  const far = finite(camera.far);
  if (far === null || far < SCENE_3D_CONTROL_BOUNDS.cameraFar[0] || far <= near || far > SCENE_3D_CONTROL_BOUNDS.cameraFar[1]) {
    errors.push({ path: `${path}/far`, message: "must be greater than near and at most 10000" });
  }
  if (camera.orbitDegPerSecond !== undefined) number(camera.orbitDegPerSecond, `${path}/orbitDegPerSecond`, ...SCENE_3D_CONTROL_BOUNDS.angularVelocity, errors);
}

function validateLighting(value: unknown, path: string, errors: Scene3DValidationError[]): void {
  const lighting = record(value);
  if (!lighting) { errors.push({ path, message: "must be an object" }); return; }
  number(lighting.ambient, `${path}/ambient`, ...SCENE_3D_CONTROL_BOUNDS.lightingAmbient, errors);
  number(lighting.intensity, `${path}/intensity`, ...SCENE_3D_CONTROL_BOUNDS.lightingIntensity, errors);
  vector(lighting.direction, `${path}/direction`, ...SCENE_3D_CONTROL_BOUNDS.lightingDirection, errors, true);
  if (!hexColor(lighting.color)) errors.push({ path: `${path}/color`, message: "must be a #RRGGBB color" });
}

function vector(value: unknown, path: string, min: number, max: number, errors: Scene3DValidationError[], nonZero = false): void {
  if (!finiteArray(value, 3, 3, 1, min, max)) { errors.push({ path, message: `must contain three finite numbers between ${min} and ${max}` }); return; }
  if (nonZero && (value as number[]).every((entry) => entry === 0)) errors.push({ path, message: "must not be the zero vector" });
}

function number(value: unknown, path: string, min: number, max: number, errors: Scene3DValidationError[]): void {
  const parsed = finite(value);
  if (parsed === null || parsed < min || parsed > max) errors.push({ path, message: `must be between ${min} and ${max}` });
}

function finiteArray(value: unknown, minLength: number, maxLength: number, multiple: number, min: number, max: number): value is number[] {
  return Array.isArray(value) && value.length >= minLength && value.length <= maxLength && value.length % multiple === 0
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= min && entry <= max);
}

function integerArray(value: unknown, minLength: number, maxLength: number, multiple: number, upper: number): value is number[] {
  return Array.isArray(value) && value.length >= minLength && value.length <= maxLength && value.length % multiple === 0
    && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry < upper);
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return Object.getOwnPropertyDescriptors(value) && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function integer(value: unknown): boolean { return Number.isInteger(value) && Number(value) >= 0; }
function hexColor(value: unknown): boolean { return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value); }
