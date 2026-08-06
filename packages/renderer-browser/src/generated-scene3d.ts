import {
  assertLocalMotionFrameBudget,
  compareCodeUnits,
  MAX_SCENE_3D_LAYERS,
  MAX_SCENE_3D_MESH_INDICES_PER_OBJECT,
  MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT,
  MAX_SCENE_3D_OBJECTS_PER_LAYER,
  MAX_SCENE_3D_OBJECTS_TOTAL,
  MAX_SCENE_3D_VERTICES_PER_OBJECT,
  SCENE_3D_MESH_SCHEMA,
  SCENE_3D_PRIMITIVES,
  SCENE_3D_SCHEMA,
  type MotionLayer,
} from "@shellx-motion/core";

export interface BrowserScene3DEvidence {
  policy: "fixed-data-webgl";
  maxLayers: number;
  maxObjectsPerLayer: number;
  maxVerticesPerObject: number;
  maxMeshVerticesPerObject: number;
  maxMeshIndicesPerObject: number;
  network: "denied";
  clock: "frame-time";
  code: "host-fixed";
  layers: BrowserScene3DLayerEvidence[];
}

export interface BrowserScene3DLayerEvidence {
  layerId: string;
  objectCount: number;
  meshObjectCount: number;
  meshVertexCount: number;
  triangleCount: number;
  primitives: string[];
  sourceFormats: string[];
  orbitDegPerSecond: number;
}

export interface GeneratedScene3DRenderInput {
  layer: MotionLayer;
  atMs: number;
  width: number;
  height: number;
  style: string;
  layers: Map<string, BrowserScene3DLayerEvidence>;
}

interface RenderScene3DObjectBase {
  id: string;
  position: [number, number, number];
  rotationDeg: [number, number, number];
  scale: number;
  spinDegPerSecond: [number, number, number];
  color: string;
  emissive: number;
}

interface RenderScene3DMesh extends RenderScene3DObjectBase {
  primitive: "mesh";
  geometry: {
    positions: number[];
    normals: number[];
    indices: number[];
  };
  source: { format: "gltf" | "glb" };
}

interface RenderScene3DFixedObject extends RenderScene3DObjectBase {
  primitive: Exclude<(typeof SCENE_3D_PRIMITIVES)[number], "mesh">;
}

type RenderScene3DObject = RenderScene3DMesh | RenderScene3DFixedObject;

export function renderGeneratedScene3D(input: GeneratedScene3DRenderInput): string {
  const { layer } = input;
  const scene = record(layer.scene3d);
  const supportedSchemas: readonly string[] = [SCENE_3D_SCHEMA, SCENE_3D_MESH_SCHEMA];
  if (!supportedSchemas.includes(String(scene.schema))) {
    throw new Error(`Scene3d layer ${layer.id} requires a supported versioned schema.`);
  }
  if (input.layers.size >= MAX_SCENE_3D_LAYERS && !input.layers.has(layer.id)) {
    throw new Error(`Generated browser render supports at most ${MAX_SCENE_3D_LAYERS} scene3d layers.`);
  }
  const rawObjects = array(scene.objects);
  if (rawObjects.length === 0 || rawObjects.length > MAX_SCENE_3D_OBJECTS_PER_LAYER) {
    throw new Error(`Scene3d layer ${layer.id} must contain 1-${MAX_SCENE_3D_OBJECTS_PER_LAYER} objects.`);
  }
  const label = `Scene3d layer ${layer.id}`;
  const objectIds = new Set<string>();
  const objects = rawObjects.map((value) => sceneObject(value, label, scene.schema === SCENE_3D_MESH_SCHEMA, objectIds));
  const camera = sceneCamera(scene.camera, label);
  const sceneData = {
    camera,
    lighting: sceneLighting(scene.lighting, label),
    backgroundColor: hexColor(scene.backgroundColor, `${label} backgroundColor`),
    objects,
  };
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  assertLocalMotionFrameBudget({ width, height });
  const previousCount = input.layers.get(layer.id)?.objectCount ?? 0;
  const totalCount = [...input.layers.values()].reduce((total, item) => total + item.objectCount, 0)
    - previousCount + objects.length;
  if (totalCount > MAX_SCENE_3D_OBJECTS_TOTAL) {
    throw new Error(`Generated browser render supports at most ${MAX_SCENE_3D_OBJECTS_TOTAL} scene3d objects in total.`);
  }
  input.layers.set(layer.id, sceneEvidence(layer.id, objects, camera.orbitDegPerSecond));
  const config = Buffer.from(JSON.stringify(sceneData)).toString("base64");
  const seconds = formatNumber(Math.max(0, input.atMs - layer.startMs) / 1000);
  return [
    `<canvas data-layer-id="${escapeAttr(layer.id)}"`,
    'data-motion-scene3d="true"',
    'data-motion-scene3d-state="pending"',
    `data-motion-scene3d-config="${config}"`,
    `data-motion-scene3d-time="${seconds}"`,
    `width="${width}" height="${height}"`,
    `data-start="${layer.startMs}" data-duration="${layer.durationMs}"`,
    `style="${input.style}display:block;background:${escapeAttr(sceneData.backgroundColor)}"></canvas>`,
  ].join(" ");
}

export function scene3dEvidence(layers: Map<string, BrowserScene3DLayerEvidence>): BrowserScene3DEvidence | undefined {
  if (layers.size === 0) return undefined;
  return {
    policy: "fixed-data-webgl",
    maxLayers: MAX_SCENE_3D_LAYERS,
    maxObjectsPerLayer: MAX_SCENE_3D_OBJECTS_PER_LAYER,
    maxVerticesPerObject: MAX_SCENE_3D_VERTICES_PER_OBJECT,
    maxMeshVerticesPerObject: MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT,
    maxMeshIndicesPerObject: MAX_SCENE_3D_MESH_INDICES_PER_OBJECT,
    network: "denied",
    clock: "frame-time",
    code: "host-fixed",
    // Code-unit order, not localeCompare: scene3d evidence is hashed into the render receipt.
    layers: [...layers.values()].sort((left, right) => compareCodeUnits(left.layerId, right.layerId)),
  };
}

function sceneObject(value: unknown, label: string, meshAllowed: boolean, ids: Set<string>): RenderScene3DObject {
  const object = record(value);
  const id = text(object.id);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || ids.has(id)) {
    throw new Error(`${label} contains an invalid or duplicate object id.`);
  }
  ids.add(id);
  const primitive = text(object.primitive);
  const common = {
    id,
    position: vec3(object.position, -1_000, 1_000, `${label} object.position`),
    rotationDeg: vec3(object.rotationDeg, -36_000, 36_000, `${label} object.rotationDeg`),
    scale: number(object.scale, 0.001, 100, `${label} object.scale`),
    spinDegPerSecond: object.spinDegPerSecond === undefined
      ? [0, 0, 0] as [number, number, number]
      : vec3(object.spinDegPerSecond, -720, 720, `${label} object.spinDegPerSecond`),
    color: hexColor(object.color, `${label} object.color`),
    emissive: object.emissive === undefined ? 0 : number(object.emissive, 0, 1, `${label} object.emissive`),
  };
  if (primitive === "mesh" && meshAllowed) {
    const geometry = record(object.geometry);
    const positions = numericArray(geometry.positions, 9, MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT * 3, -10_000, 10_000, `${label} mesh positions`);
    const normals = numericArray(geometry.normals, positions.length, positions.length, -1.001, 1.001, `${label} mesh normals`);
    const indices = indexArray(geometry.indices, positions.length / 3, `${label} mesh indices`);
    const source = record(object.source);
    const format = meshFormat(source.format);
    if (!format) throw new Error(`${label} mesh source format is invalid.`);
    return { ...common, primitive, geometry: { positions, normals, indices }, source: { format } };
  }
  if (!primitive || primitive === "mesh" || !(SCENE_3D_PRIMITIVES as readonly string[]).includes(primitive)) {
    throw new Error(`${label} contains an unsupported primitive.`);
  }
  return {
    ...common,
    primitive: primitive as RenderScene3DFixedObject["primitive"],
  };
}

function sceneCamera(value: unknown, label: string) {
  const camera = record(value);
  const position = vec3(camera.position, -1_000, 1_000, `${label} camera.position`);
  const target = vec3(camera.target, -1_000, 1_000, `${label} camera.target`);
  const view = position.map((entry, axis) => entry - target[axis]);
  if (Math.hypot(...view) < 0.000_001 || Math.hypot(view[0], view[2]) < 0.000_001) {
    throw new Error(`${label} camera must define a non-vertical view distinct from its target.`);
  }
  const near = number(camera.near, 0.01, 100, `${label} camera.near`);
  const far = number(camera.far, near, 10_000, `${label} camera.far`, false);
  if (far <= near) throw new Error(`${label} camera.far must be greater than camera.near.`);
  return {
    position,
    target,
    fovDeg: number(camera.fovDeg, 10, 120, `${label} camera.fovDeg`),
    near,
    far,
    orbitDegPerSecond: camera.orbitDegPerSecond === undefined
      ? 0
      : number(camera.orbitDegPerSecond, -720, 720, `${label} camera.orbitDegPerSecond`),
  };
}

function sceneLighting(value: unknown, label: string) {
  const lighting = record(value);
  return {
    ambient: number(lighting.ambient, 0, 1, `${label} lighting.ambient`),
    direction: vec3(lighting.direction, -1, 1, `${label} lighting.direction`, true),
    intensity: number(lighting.intensity, 0, 4, `${label} lighting.intensity`),
    color: hexColor(lighting.color, `${label} lighting.color`),
  };
}

function sceneEvidence(
  layerId: string,
  objects: RenderScene3DObject[],
  orbitDegPerSecond: number,
): BrowserScene3DLayerEvidence {
  const meshes = objects.filter((object): object is RenderScene3DMesh => object.primitive === "mesh");
  return {
    layerId,
    objectCount: objects.length,
    meshObjectCount: meshes.length,
    meshVertexCount: meshes.reduce((total, object) => total + object.geometry.positions.length / 3, 0),
    triangleCount: meshes.reduce((total, object) => total + object.geometry.indices.length / 3, 0),
    primitives: [...new Set(objects.map((object) => object.primitive))].sort(),
    sourceFormats: [...new Set(meshes.map((object) => object.source.format))].sort(),
    orbitDegPerSecond,
  };
}

function vec3(value: unknown, min: number, max: number, label: string, nonZero = false): [number, number, number] {
  const values = numericArray(value, 3, 3, min, max, label);
  const tuple: [number, number, number] = [values[0], values[1], values[2]];
  if (nonZero && tuple.every((entry) => entry === 0)) throw new Error(`${label} must not be the zero vector.`);
  return tuple;
}

function numericArray(
  value: unknown,
  minLength: number,
  maxLength: number,
  min: number,
  max: number,
  label: string,
): number[] {
  const invalidNumber = (item: unknown) => (
    typeof item !== "number" || !Number.isFinite(item) || item < min || item > max
  );
  if (
    !Array.isArray(value)
    || value.length < minLength
    || value.length > maxLength
    || value.some(invalidNumber)
  ) {
    throw new Error(`${label} contains invalid or out-of-range numbers.`);
  }
  return [...value];
}

function indexArray(value: unknown, vertexCount: number, label: string): number[] {
  const invalidIndex = (item: unknown) => (
    typeof item !== "number" || !Number.isInteger(item) || item < 0 || item >= vertexCount
  );
  if (
    !Array.isArray(value)
    || value.length < 3
    || value.length > MAX_SCENE_3D_MESH_INDICES_PER_OBJECT
    || value.length % 3 !== 0
    || value.some(invalidIndex)
  ) {
    throw new Error(`${label} contains invalid triangle indices.`);
  }
  return [...value] as number[];
}

function number(value: unknown, min: number, max: number, label: string, inclusiveMin = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (inclusiveMin ? value < min : value <= min) || value > max) {
    throw new Error(`${label} is out of range.`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Scene3d value must be a plain object.");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Scene3d objects must be an array.");
  return value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function meshFormat(value: unknown): "gltf" | "glb" | null {
  return value === "gltf" || value === "glb" ? value : null;
}

function hexColor(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new Error(`${label} must be a #RRGGBB color.`);
  }
  return value;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
