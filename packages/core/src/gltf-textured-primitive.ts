import { canonicalJsonSha256 } from "./canonical-json";
import { inspectGltfVec3Accessor } from "./gltf-accessor";
import { extractGltfMaterialLibrary } from "./gltf-material";
import type { GltfBaseColorTexture, GltfPbrMaterial } from "./gltf-material";
import { gltfArray as array, gltfInteger as integer, gltfRecord as record } from "./gltf-read";
import type { ParsedGltfContainer } from "./gltf-types";
import { MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT, MAX_SCENE_3D_OBJECTS_PER_LAYER } from "./scene-3d";

export const GLTF_TEXTURED_PRIMITIVE_SCHEMA = "shellx-motion/gltf-textured-primitive@1" as const;
export const GLTF_TEXCOORD_0_SCHEMA = "shellx-motion/gltf-texcoord0@1" as const;
export const MAX_GLTF_TEXCOORD_0_SOURCE_SPAN_BYTES = 1024 * 1024;
export const MAX_GLTF_TEXCOORD_0_DECODED_BYTES = MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT * 2 * 4;

export type GltfTexCoord0Format = "float32" | "unorm8" | "unorm16";

export interface GltfTexCoord0Descriptor {
  readonly schema: typeof GLTF_TEXCOORD_0_SCHEMA;
  readonly accessorIndex: number;
  readonly format: GltfTexCoord0Format;
  readonly count: number;
  readonly sourceSpanBytes: number;
  readonly decodedByteLength: number;
  readonly values: readonly number[];
  readonly valuesSha256: string;
}

export interface GltfTexturedPrimitiveDescriptor {
  readonly schema: typeof GLTF_TEXTURED_PRIMITIVE_SCHEMA;
  readonly sourceSha256: string;
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly materialIndex: number;
  readonly positionAccessorIndex: number;
  readonly vertexCount: number;
  readonly material: {
    readonly baseColorFactor: readonly [number, number, number, number];
    readonly metallicFactor: number;
    readonly roughnessFactor: number;
    readonly emissiveFactor: readonly [number, number, number];
    readonly baseColorTexture: Omit<GltfBaseColorTexture, "bytes">;
  };
  readonly texCoord0: GltfTexCoord0Descriptor;
  readonly fingerprint: string;
}

/**
 * Produces only static base-color-textured primitive descriptors for a future scene/material ABI.
 * The live glTF lowerer deliberately does not call this function and still refuses textures.
 */
export function deriveGltfTexturedPrimitiveDescriptors(container: ParsedGltfContainer): readonly GltfTexturedPrimitiveDescriptor[] {
  const materials = extractGltfMaterialLibrary(container).materials;
  const meshes = array(container.json.meshes, "glTF meshes");
  const descriptors: GltfTexturedPrimitiveDescriptor[] = [];
  for (const [meshIndex, meshValue] of meshes.entries()) {
    const mesh = record(meshValue, `glTF mesh ${meshIndex}`);
    const primitives = array(mesh.primitives, `glTF mesh ${meshIndex} primitives`);
    for (const [primitiveIndex, primitiveValue] of primitives.entries()) {
      const primitive = record(primitiveValue, `glTF mesh ${meshIndex} primitive ${primitiveIndex}`);
      if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error("glTF textured primitive descriptor supports TRIANGLES mode only.");
      if (primitive.targets !== undefined || primitive.extensions !== undefined) throw new Error("glTF textured primitive morph targets and extensions are not supported.");
      if (primitive.material === undefined) continue;
      const materialIndex = integer(primitive.material, `glTF mesh ${meshIndex} primitive ${primitiveIndex} material`, 0, materials.length - 1);
      const material = materials[materialIndex];
      if (!material.baseColorTexture) continue;
      // Bound descriptor multiplicity before TEXCOORD_0 is decoded into a fresh number array.
      // Selected-scene preflight applies the same object ceiling, while this guard also contains
      // unselected meshes that the immutable material sidecar deliberately inventories.
      if (descriptors.length >= MAX_SCENE_3D_OBJECTS_PER_LAYER) {
        throw new Error(`glTF textured primitive descriptors exceed ${MAX_SCENE_3D_OBJECTS_PER_LAYER} primitives.`);
      }
      descriptors.push(texturedPrimitiveDescriptor(container, primitive, meshIndex, primitiveIndex, materialIndex, material));
    }
  }
  return Object.freeze(descriptors);
}

function texturedPrimitiveDescriptor(
  container: ParsedGltfContainer,
  primitive: Record<string, unknown>,
  meshIndex: number,
  primitiveIndex: number,
  materialIndex: number,
  material: GltfPbrMaterial,
): GltfTexturedPrimitiveDescriptor {
  const attributes = record(primitive.attributes, `glTF mesh ${meshIndex} primitive ${primitiveIndex} attributes`);
  const positionAccessorIndex = accessorIndex(container, attributes.POSITION, `glTF mesh ${meshIndex} primitive ${primitiveIndex} POSITION`);
  const positionAccessor = record(array(container.json.accessors, "glTF accessors")[positionAccessorIndex], `glTF mesh ${meshIndex} primitive ${primitiveIndex} POSITION accessor`);
  if (positionAccessor.extensions !== undefined) throw new Error(`glTF mesh ${meshIndex} primitive ${primitiveIndex} POSITION accessor extensions are not supported.`);
  const vertexCount = inspectGltfVec3Accessor(container, positionAccessorIndex, "POSITION").count;
  if (attributes.TEXCOORD_0 === undefined) throw new Error(`glTF mesh ${meshIndex} primitive ${primitiveIndex} textured material requires TEXCOORD_0.`);
  const texCoord0 = readGltfTexCoord0(container, attributes.TEXCOORD_0, meshIndex, primitiveIndex);
  if (texCoord0.count !== vertexCount) throw new Error(`glTF mesh ${meshIndex} primitive ${primitiveIndex} TEXCOORD_0 count must equal POSITION vertex count.`);
  const base = {
    schema: GLTF_TEXTURED_PRIMITIVE_SCHEMA,
    sourceSha256: container.sourceSha256,
    meshIndex,
    primitiveIndex,
    materialIndex,
    positionAccessorIndex,
    vertexCount,
    material: materialIdentity(material),
    texCoord0,
  } as const;
  return Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) });
}

function materialIdentity(material: GltfPbrMaterial): GltfTexturedPrimitiveDescriptor["material"] {
  const source = material.baseColorTexture!;
  const baseColorTexture = Object.freeze({
    textureIndex: source.textureIndex,
    imageIndex: source.imageIndex,
    texCoord: source.texCoord,
    mimeType: source.mimeType,
    width: source.width,
    height: source.height,
    byteLength: source.byteLength,
    derivedRgbaByteLength: source.derivedRgbaByteLength,
    sha256: source.sha256,
  });
  return Object.freeze({
    baseColorFactor: freezeFactor4(material.baseColorFactor),
    metallicFactor: material.metallicFactor,
    roughnessFactor: material.roughnessFactor,
    emissiveFactor: freezeFactor3(material.emissiveFactor),
    baseColorTexture,
  });
}

function readGltfTexCoord0(container: ParsedGltfContainer, value: unknown, meshIndex: number, primitiveIndex: number): GltfTexCoord0Descriptor {
  const label = `glTF mesh ${meshIndex} primitive ${primitiveIndex} TEXCOORD_0`;
  const index = accessorIndex(container, value, `${label} accessor`);
  const accessors = array(container.json.accessors, "glTF accessors");
  const accessor = record(accessors[index], label);
  if (accessor.sparse !== undefined || accessor.extensions !== undefined) throw new Error(`${label} sparse accessors and extensions are not supported.`);
  const format = texCoordFormat(accessor, label);
  const count = integer(accessor.count, `${label} count`, 3, MAX_SCENE_3D_MESH_VERTICES_PER_OBJECT);
  const layout = texCoordLayout(container, accessor, format, count, label);
  const values: number[] = [];
  for (let item = 0; item < count; item += 1) {
    const offset = layout.offset + item * layout.stride;
    values.push(normalizedCoordinate(layout.data, offset, format, label), normalizedCoordinate(layout.data, offset + layout.componentBytes, format, label));
  }
  const base = {
    schema: GLTF_TEXCOORD_0_SCHEMA,
    accessorIndex: index,
    format,
    count,
    sourceSpanBytes: layout.sourceSpanBytes,
    decodedByteLength: values.length * 4,
    values: Object.freeze(values),
  };
  if (base.decodedByteLength > MAX_GLTF_TEXCOORD_0_DECODED_BYTES) throw new Error(`${label} decoded bytes exceed ${MAX_GLTF_TEXCOORD_0_DECODED_BYTES}.`);
  return Object.freeze({ ...base, valuesSha256: canonicalJsonSha256(base) });
}

function texCoordFormat(accessor: Record<string, unknown>, label: string): GltfTexCoord0Format {
  if (accessor.type !== "VEC2") throw new Error(`${label} accessor must use VEC2 values.`);
  if (accessor.componentType === 5126 && (accessor.normalized === undefined || accessor.normalized === false)) return "float32";
  if (accessor.componentType === 5121 && accessor.normalized === true) return "unorm8";
  if (accessor.componentType === 5123 && accessor.normalized === true) return "unorm16";
  throw new Error(`${label} accessor must use FLOAT VEC2 or normalized UNSIGNED_BYTE/UNSIGNED_SHORT VEC2 values.`);
}

function texCoordLayout(
  container: ParsedGltfContainer,
  accessor: Record<string, unknown>,
  format: GltfTexCoord0Format,
  count: number,
  label: string,
): { data: DataView; offset: number; stride: number; componentBytes: number; sourceSpanBytes: number } {
  const componentBytes = format === "float32" ? 4 : format === "unorm16" ? 2 : 1;
  const itemBytes = componentBytes * 2;
  const views = array(container.json.bufferViews, "glTF bufferViews");
  const viewIndex = integer(accessor.bufferView, `${label} bufferView`, 0, views.length - 1);
  const view = record(views[viewIndex], `${label} bufferView`);
  if (view.extensions !== undefined) throw new Error(`${label} bufferView extensions are not supported.`);
  const bufferIndex = integer(view.buffer, `${label} bufferView buffer`, 0, container.buffers.length - 1);
  const bytes = container.buffers[bufferIndex];
  const viewOffset = view.byteOffset === undefined ? 0 : integer(view.byteOffset, `${label} bufferView.byteOffset`, 0, bytes.byteLength);
  const viewLength = integer(view.byteLength, `${label} bufferView.byteLength`, 1, bytes.byteLength);
  const accessorOffset = accessor.byteOffset === undefined ? 0 : integer(accessor.byteOffset, `${label} accessor.byteOffset`, 0, viewLength);
  const stride = view.byteStride === undefined ? itemBytes : integer(view.byteStride, `${label} bufferView.byteStride`, Math.max(4, itemBytes), 252);
  if (viewOffset % 4 !== 0 || accessorOffset % componentBytes !== 0 || stride % componentBytes !== 0) throw new Error(`${label} bufferView/accessor offsets and stride are not aligned for its component format.`);
  if (stride % 4 !== 0) throw new Error(`${label} vertex byteStride must be a multiple of 4.`);
  const sourceSpanBytes = itemBytes + (count - 1) * stride;
  if (sourceSpanBytes > MAX_GLTF_TEXCOORD_0_SOURCE_SPAN_BYTES) throw new Error(`${label} source span exceeds ${MAX_GLTF_TEXCOORD_0_SOURCE_SPAN_BYTES} bytes.`);
  if (viewOffset + viewLength > bytes.byteLength || viewOffset + accessorOffset + sourceSpanBytes > viewOffset + viewLength) throw new Error(`${label} accessor exceeds its bounded bufferView.`);
  return { data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: viewOffset + accessorOffset, stride, componentBytes, sourceSpanBytes };
}

function normalizedCoordinate(data: DataView, offset: number, format: GltfTexCoord0Format, label: string): number {
  const value = format === "float32" ? data.getFloat32(offset, true)
    : format === "unorm16" ? data.getUint16(offset, true) / 0xffff
      : data.getUint8(offset) / 0xff;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} values must be finite normalized coordinates from 0 to 1.`);
  return Object.is(value, -0) ? 0 : value;
}

function accessorIndex(container: ParsedGltfContainer, value: unknown, label: string): number {
  return integer(value, label, 0, array(container.json.accessors, "glTF accessors").length - 1);
}

function freezeFactor4(value: readonly [number, number, number, number]): readonly [number, number, number, number] {
  return Object.freeze([...value]) as unknown as readonly [number, number, number, number];
}

function freezeFactor3(value: readonly [number, number, number]): readonly [number, number, number] {
  return Object.freeze([...value]) as unknown as readonly [number, number, number];
}
