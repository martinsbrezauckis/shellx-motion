export const GLTF_PBR_MATERIAL_SCHEMA = "shellx-motion/gltf-pbr-material@1" as const;
export const GLTF_MATERIAL_LIBRARY_SCHEMA = "shellx-motion/gltf-material-library@1" as const;
export const MAX_GLTF_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_GLTF_IMAGE_BYTES_TOTAL = 8 * 1024 * 1024;
export const MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES = 16 * 1024 * 1024;
export const MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES_TOTAL = 32 * 1024 * 1024;

export type GltfImageMimeType = "image/png" | "image/jpeg";
export type GltfLegacyScene3dLoss = "baseColorFactor" | "metallicFactor" | "roughnessFactor" | "emissiveFactor" | "baseColorTexture";

export interface GltfEmbeddedImage {
  readonly imageIndex: number;
  readonly mimeType: GltfImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  /** Header-derived RGBA expansion ceiling; this extractor does not decode image pixels. */
  readonly derivedRgbaByteLength: number;
  readonly sha256: string;
  /** A defensive copy of the owned hash-bound byte snapshot is returned on every read. */
  readonly bytes: Buffer;
}

export interface GltfBaseColorTexture {
  readonly textureIndex: number;
  readonly imageIndex: number;
  /** The extracted material accepts only texCoord 0; primitive accessor validation is a later ABI join. */
  readonly texCoord: 0;
  readonly mimeType: GltfImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly derivedRgbaByteLength: number;
  readonly sha256: string;
  /** A defensive copy of the owned image snapshot; no path, URI, decoder, or sampler is selected. */
  readonly bytes: Buffer;
}

export interface GltfPbrMaterial {
  readonly schema: typeof GLTF_PBR_MATERIAL_SCHEMA;
  readonly materialIndex: number;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: readonly [number, number, number];
  /** Existing scene3d@2 scalar mapping and every source semantic it cannot preserve exactly. */
  readonly legacyScene3d: { readonly color: string; readonly emissive: number; readonly exact: boolean; readonly losses: readonly GltfLegacyScene3dLoss[] };
  readonly baseColorTexture?: GltfBaseColorTexture;
}

export interface GltfMaterialLibrary {
  readonly schema: typeof GLTF_MATERIAL_LIBRARY_SCHEMA;
  readonly materials: readonly GltfPbrMaterial[];
  readonly images: readonly GltfEmbeddedImage[];
  readonly textureCount: number;
  readonly derivedRgbaByteLength: number;
}
