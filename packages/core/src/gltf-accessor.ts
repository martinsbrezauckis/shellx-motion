import {
  MAX_SCENE_3D_MESH_INDICES_PER_OBJECT,
  MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT,
} from "./scene-3d";
import type { GltfAccessorData, ParsedGltfContainer } from "./gltf-types";

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

export function readGltfVec3Accessor(
  container: ParsedGltfContainer,
  accessorIndex: unknown,
  semantic: "POSITION" | "NORMAL",
): GltfAccessorData {
  const { count, view } = prepareGltfVec3Accessor(container, accessorIndex, semantic);
  const values: number[] = [];
  for (let item = 0; item < count; item += 1) {
    for (let component = 0; component < 3; component += 1) {
      const value = view.data.getFloat32(view.offset + item * view.stride + component * 4, true);
      const bound = semantic === "NORMAL" ? 1.001 : 10_000;
      if (!Number.isFinite(value) || value < -bound || value > bound) throw new Error(`glTF ${semantic} accessor contains an out-of-range value.`);
      values.push(Object.is(value, -0) ? 0 : value);
    }
  }
  return { values, count, componentCount: 3 };
}

/** Validates vec3 accessor metadata and bounds without allocating its numeric array. */
export function inspectGltfVec3Accessor(
  container: ParsedGltfContainer,
  accessorIndex: unknown,
  semantic: "POSITION" | "NORMAL",
): { count: number } {
  return { count: prepareGltfVec3Accessor(container, accessorIndex, semantic).count };
}

function prepareGltfVec3Accessor(
  container: ParsedGltfContainer,
  accessorIndex: unknown,
  semantic: "POSITION" | "NORMAL",
): { count: number; view: ReturnType<typeof accessorView> } {
  const accessor = accessorRecord(container, accessorIndex, semantic);
  if (accessor.componentType !== FLOAT || accessor.type !== "VEC3" || accessor.normalized === true) {
    throw new Error(`glTF ${semantic} accessor must use non-normalized FLOAT VEC3 data.`);
  }
  const count = integer(accessor.count, `glTF ${semantic} accessor count`, 3, MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT);
  const view = accessorView(container, accessor, 12, semantic);
  return { count, view };
}

export function readGltfIndexAccessor(
  container: ParsedGltfContainer,
  accessorIndex: unknown,
  vertexCount: number,
): number[] {
  if (accessorIndex === undefined) {
    if (vertexCount % 3 !== 0) throw new Error("Non-indexed glTF triangle positions must contain a multiple of three vertices.");
    return Array.from({ length: vertexCount }, (_value, index) => index);
  }
  const prepared = prepareGltfIndexAccessor(container, accessorIndex);
  const values: number[] = [];
  for (let item = 0; item < prepared.count; item += 1) {
    const offset = prepared.view.offset + item * prepared.view.stride;
    const value = prepared.bytesPerComponent === 1 ? prepared.view.data.getUint8(offset)
      : prepared.bytesPerComponent === 2 ? prepared.view.data.getUint16(offset, true)
        : prepared.view.data.getUint32(offset, true);
    if (value >= vertexCount) throw new Error("glTF index references a vertex outside the POSITION accessor.");
    values.push(value);
  }
  return values;
}

/** Validates index accessor metadata and bounds without allocating its numeric array. */
export function inspectGltfIndexAccessor(
  container: ParsedGltfContainer,
  accessorIndex: unknown,
  vertexCount: number,
): { count: number } {
  if (accessorIndex === undefined) {
    if (vertexCount % 3 !== 0) throw new Error("Non-indexed glTF triangle positions must contain a multiple of three vertices.");
    return { count: vertexCount };
  }
  return { count: prepareGltfIndexAccessor(container, accessorIndex).count };
}

function prepareGltfIndexAccessor(
  container: ParsedGltfContainer,
  accessorIndex: unknown,
): { count: number; bytesPerComponent: number; view: ReturnType<typeof accessorView> } {
  const accessor = accessorRecord(container, accessorIndex, "indices");
  if (accessor.type !== "SCALAR" || ![UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT].includes(Number(accessor.componentType)) || accessor.normalized === true) {
    throw new Error("glTF indices accessor must use non-normalized unsigned SCALAR data.");
  }
  const count = integer(accessor.count, "glTF indices accessor count", 3, MAX_SCENE_3D_MESH_INDICES_PER_OBJECT);
  if (count % 3 !== 0) throw new Error("glTF triangle indices count must be a multiple of three.");
  const bytesPerComponent = accessor.componentType === UNSIGNED_BYTE ? 1 : accessor.componentType === UNSIGNED_SHORT ? 2 : 4;
  const view = accessorView(container, accessor, bytesPerComponent, "indices");
  return { count, bytesPerComponent, view };
}

function accessorRecord(container: ParsedGltfContainer, indexValue: unknown, label: string): Record<string, unknown> {
  const accessors = array(container.json.accessors, "glTF accessors");
  const index = integer(indexValue, `glTF ${label} accessor index`, 0, accessors.length - 1);
  const accessor = record(accessors[index], `glTF ${label} accessor`);
  if (accessor.sparse !== undefined) throw new Error(`glTF ${label} sparse accessors are not supported.`);
  return accessor;
}

function accessorView(
  container: ParsedGltfContainer,
  accessor: Record<string, unknown>,
  itemBytes: number,
  label: string,
): { data: DataView; offset: number; stride: number } {
  const views = array(container.json.bufferViews, "glTF bufferViews");
  const viewIndex = integer(accessor.bufferView, `glTF ${label} bufferView index`, 0, views.length - 1);
  const view = record(views[viewIndex], `glTF ${label} bufferView`);
  const bufferIndex = integer(view.buffer, `glTF ${label} buffer index`, 0, container.buffers.length - 1);
  const bytes = container.buffers[bufferIndex];
  const viewOffset = optionalInteger(view.byteOffset, `glTF ${label} bufferView.byteOffset`, 0, bytes.byteLength);
  const viewLength = integer(view.byteLength, `glTF ${label} bufferView.byteLength`, 1, bytes.byteLength);
  const accessorOffset = optionalInteger(accessor.byteOffset, `glTF ${label} accessor.byteOffset`, 0, viewLength);
  const stride = view.byteStride === undefined ? itemBytes : integer(view.byteStride, `glTF ${label} byteStride`, itemBytes, 252);
  const count = Number(accessor.count);
  const lastByte = viewOffset + accessorOffset + (count - 1) * stride + itemBytes;
  if (viewOffset + viewLength > bytes.byteLength || lastByte > viewOffset + viewLength) {
    throw new Error(`glTF ${label} accessor exceeds its bounded bufferView.`);
  }
  return {
    data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: viewOffset + accessorOffset,
    stride,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array.`); return value; }
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return Number(value);
}
function optionalInteger(value: unknown, label: string, min: number, max: number): number { return value === undefined ? 0 : integer(value, label, min, max); }
