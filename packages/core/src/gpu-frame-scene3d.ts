import {
  MAX_SCENE_3D_MESH_INDICES_TOTAL,
  MAX_SCENE_3D_MESH_VERTICES_TOTAL,
  MAX_SCENE_3D_OBJECTS_TOTAL,
} from "./scene-3d";
import type { GpuRgba, GpuScene3dIntent } from "./gpu-frame-intent-types";

type Composite = Pick<GpuScene3dIntent, "blendMode" | "effects" | "mask">;
type Refuse = (message: string) => never;

export interface GpuScene3dTotals {
  scenes: number;
  objects: number;
  vertices: number;
  indices: number;
}

/** Re-admits fixed-data 3D geometry before it contributes to a GPU plan. */
export function readGpuScene3dIntent(
  value: Record<string, unknown>,
  id: string,
  composite: Composite,
  totals: GpuScene3dTotals,
  refuse: Refuse,
): GpuScene3dIntent {
  totals.scenes += 1;
  if (totals.scenes > 4) refuse("GPU frames support at most four scene3d layers.");
  const background = rgba(value.background, `${id}.background`, refuse);
  const opacity = unit(value.opacity, `${id}.opacity`, refuse);
  const viewProjection = matrix(value.viewProjection, `${id}.viewProjection`, refuse);
  const lightDirection = tuple3(value.lightDirection, `${id}.lightDirection`, -1, 1, refuse);
  if (Math.hypot(...lightDirection) < 0.000_001) refuse(`${id}.lightDirection must not be zero.`);
  const lightColor = rgba(value.lightColor, `${id}.lightColor`, refuse);
  const ambient = unit(value.ambient, `${id}.ambient`, refuse);
  const intensity = finite(value.intensity, `${id}.intensity`, 0, 4, refuse);
  if (!Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > 16) refuse(`${id}.objects must contain 1..16 objects.`);
  const objectIds = new Set<string>();
  const objects = value.objects.map((raw, objectIndex) => {
    if (!record(raw)) refuse(`${id}.objects[${objectIndex}] must be an object.`);
    const objectId = safeId(raw.id, `${id}.objects[${objectIndex}].id`, refuse);
    if (objectIds.has(objectId)) refuse(`${id}.objects contains a duplicate id.`); objectIds.add(objectId);
    if (!Array.isArray(raw.vertices) || raw.vertices.length < 18 || raw.vertices.length % 6 !== 0) refuse(`${id}.${objectId}.vertices must contain interleaved position and normal values.`);
    const vertices = raw.vertices.map((entry, index) => finite(entry, `${id}.${objectId}.vertices[${index}]`, index % 6 < 3 ? -10_000 : -1.001, index % 6 < 3 ? 10_000 : 1.001, refuse));
    const vertexCount = vertices.length / 6;
    if (vertexCount > 4_096) refuse(`${id}.${objectId} exceeds the 4096-vertex object limit.`);
    if (!Array.isArray(raw.indices) || raw.indices.length < 3 || raw.indices.length > 24_576 || raw.indices.length % 3 !== 0) refuse(`${id}.${objectId}.indices must contain bounded triangle triples.`);
    const indices = raw.indices.map((entry, index) => integer(entry, `${id}.${objectId}.indices[${index}]`, 0, vertexCount - 1, refuse));
    totals.objects += 1; totals.vertices += vertexCount; totals.indices += indices.length;
    if (totals.objects > MAX_SCENE_3D_OBJECTS_TOTAL || totals.vertices > MAX_SCENE_3D_MESH_VERTICES_TOTAL || totals.indices > MAX_SCENE_3D_MESH_INDICES_TOTAL) refuse("GPU scene3d data exceeds its frame-wide object or geometry budget.");
    return {
      id: objectId,
      vertices,
      indices,
      model: matrix(raw.model, `${id}.${objectId}.model`, refuse),
      color: rgba(raw.color, `${id}.${objectId}.color`, refuse),
      emissive: unit(raw.emissive, `${id}.${objectId}.emissive`, refuse),
    };
  });
  return { kind: "scene3d", id, ...composite, background, opacity, viewProjection, lightDirection, lightColor, ambient, intensity, objects };
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeId(value: unknown, name: string, refuse: Refuse): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) refuse(`${name} is invalid.`); return value; }
function finite(value: unknown, name: string, min: number, max: number, refuse: Refuse): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) refuse(`${name} must be finite in ${min}..${max}.`); return value; }
function integer(value: unknown, name: string, min: number, max: number, refuse: Refuse): number { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) refuse(`${name} must be an integer in ${min}..${max}.`); return Number(value); }
function unit(value: unknown, name: string, refuse: Refuse): number { return finite(value, name, 0, 1, refuse); }
function tuple3(value: unknown, name: string, min: number, max: number, refuse: Refuse): [number, number, number] { if (!Array.isArray(value) || value.length !== 3) refuse(`${name} must contain three numbers.`); return value.map((entry, index) => finite(entry, `${name}[${index}]`, min, max, refuse)) as [number, number, number]; }
function matrix(value: unknown, name: string, refuse: Refuse): number[] { if (!Array.isArray(value) || value.length !== 16) refuse(`${name} must contain 16 matrix values.`); return value.map((entry, index) => finite(entry, `${name}[${index}]`, -1_000_000, 1_000_000, refuse)); }
function rgba(value: unknown, name: string, refuse: Refuse): GpuRgba { if (!record(value)) refuse(`${name} must be RGBA.`); return { r: unit(value.r, `${name}.r`, refuse), g: unit(value.g, `${name}.g`, refuse), b: unit(value.b, `${name}.b`, refuse), a: unit(value.a, `${name}.a`, refuse) }; }
