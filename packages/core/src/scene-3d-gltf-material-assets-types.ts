import type { GltfSourceFormat } from "./gltf-types";
import type { OperationReceipt } from "./types";

export const SCENE_3D_GLTF_MATERIAL_ASSETS_SCHEMA = "shellx-motion/scene3d-gltf-material-assets@2" as const;
export const SCENE_3D_GLTF_MATERIAL_ASSET_DECLARATION_SCHEMA = "shellx-motion/scene3d-gltf-material-asset-declaration@2" as const;
export const SCENE_3D_GLTF_MATERIAL_ASSET_PLAN_SCHEMA = "shellx-motion/scene3d-gltf-material-asset-plan@2" as const;
export const SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION_SCHEMA = "shellx-motion/scene3d-gltf-pbr-direct-final-admission@1" as const;
export const SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS = "admitted-gpu-direct-final" as const;
export const GLTF_SCENE_3D_MATERIAL_ASSET_SIDECAR_REF = "scene3d/gltf-material-assets.json";
export const GLTF_SCENE_3D_MATERIAL_ASSET_RECEIPT_REF = "receipts/adapter-gltf-scene3d-material-assets.receipt.json";
export const MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES_TOTAL = 8 * 1024 * 1024;
export const MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES = 16 * 1024 * 1024;
export const MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES_TOTAL = 32 * 1024 * 1024;

/**
 * Immutable route contract jointly bound by the sidecar, Browser-only PBR catalog, and receipt.
 * It is intentionally not the legacy/global GPU capability card.
 */
export const SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION = Object.freeze({
  schema: SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION_SCHEMA,
  frameLane: "gpu",
  delivery: "ffmpeg-direct-final",
  viewport: Object.freeze({ width: 1280, height: 720 }),
  scene: "static-immutable-canonical-source-projection",
  material: "contained-png-srgb-TEXCOORD_0-linear-pbr-factors",
  limits: Object.freeze({
    maxPrimitives: 16,
    maxTextures: 16,
    maxEncodedTextureBytesEach: MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES,
    maxEncodedTextureBytesTotal: MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES_TOTAL,
    maxDecodedTextureBytesEach: MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES,
    maxDecodedTextureBytesTotal: MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES_TOTAL,
    maxGpuResourceBytes: 48 * 1024 * 1024,
    maxReadbackBytes: 4 * 1024 * 1024,
  }),
  refusals: Object.freeze([
    "browser-preview", "native-preview", "segmented-or-resume-final", "jpeg", "external-uri", "sampler",
    "extensions", "compression", "skins", "animations", "morph-targets", "sparse-accessors", "matrix-transforms", "nonuniform-scale",
  ]),
} as const);

export type Scene3dGltfPbrDirectFinalAdmission = typeof SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION;

export type Scene3dGltfLegacyLoss = "baseColorFactor" | "metallicFactor" | "roughnessFactor" | "emissiveFactor" | "baseColorTexture";

export interface Scene3dGltfPbrMaterial {
  readonly materialIndex: number;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly legacyScene3d: {
    readonly color: string;
    readonly emissive: number;
    readonly exact: boolean;
    readonly losses: readonly Scene3dGltfLegacyLoss[];
  };
  readonly baseColorTexture?: { readonly textureIndex: number; readonly imageIndex: number; readonly assetRef: string };
}

export interface Scene3dGltfTextureAsset {
  readonly textureIndex: number;
  readonly imageIndex: number;
  readonly texCoord: 0;
  readonly assetRef: string;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly encodedByteLength: number;
  readonly encodedSha256: string;
  readonly decodedRgbaByteLength: number;
  readonly decodedRgbaSha256: string;
}

export interface Scene3dGltfTexCoord0 {
  readonly schema: "shellx-motion/gltf-texcoord0@1";
  readonly accessorIndex: number;
  readonly format: "float32" | "unorm8" | "unorm16";
  readonly count: number;
  readonly sourceSpanBytes: number;
  readonly decodedByteLength: number;
  readonly values: readonly number[];
  readonly valuesSha256: string;
}

export interface Scene3dGltfTexturedPrimitive {
  readonly schema: "shellx-motion/gltf-textured-primitive@1";
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
    readonly baseColorTexture: {
      readonly textureIndex: number;
      readonly imageIndex: number;
      readonly texCoord: 0;
      readonly mimeType: "image/png" | "image/jpeg";
      readonly width: number;
      readonly height: number;
      readonly byteLength: number;
      readonly derivedRgbaByteLength: number;
      readonly sha256: string;
    };
  };
  readonly texCoord0: Scene3dGltfTexCoord0;
  readonly fingerprint: string;
}

export interface Scene3dGltfMaterialAssetsDocument {
  readonly schema: typeof SCENE_3D_GLTF_MATERIAL_ASSETS_SCHEMA;
  /** Logical package identity supplied by the package transaction owner. */
  readonly packageId: string;
  readonly rendererStatus: typeof SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS;
  readonly admission: Scene3dGltfPbrDirectFinalAdmission;
  readonly source: { readonly format: GltfSourceFormat; readonly sha256: string };
  readonly materials: readonly Scene3dGltfPbrMaterial[];
  readonly textures: readonly Scene3dGltfTextureAsset[];
  readonly texturedPrimitives: readonly Scene3dGltfTexturedPrimitive[];
  /** Losses in the separate legacy scene3d compatibility projection, not the admitted PBR route. */
  readonly legacyProjectionLosses: readonly { readonly materialIndex: number; readonly losses: readonly Scene3dGltfLegacyLoss[] }[];
  readonly fingerprint: string;
}

export interface Scene3dGltfMaterialAssetDeclaration {
  readonly schema: typeof SCENE_3D_GLTF_MATERIAL_ASSET_DECLARATION_SCHEMA;
  /** Must be supplied again at reopen; package roots are not provenance. */
  readonly packageId: string;
  readonly sidecarRef: typeof GLTF_SCENE_3D_MATERIAL_ASSET_SIDECAR_REF;
  readonly sidecarSha256: string;
  readonly receiptRef: typeof GLTF_SCENE_3D_MATERIAL_ASSET_RECEIPT_REF;
  readonly receiptSha256: string;
  readonly fingerprint: string;
  readonly admissionFingerprint: string;
}

/** A fresh defensive Buffer copy is returned for every read. */
export interface Scene3dGltfMaterialAssetFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly bytes: Buffer;
}

export interface Scene3dGltfMaterialAssetPlan {
  readonly schema: typeof SCENE_3D_GLTF_MATERIAL_ASSET_PLAN_SCHEMA;
  readonly document: Scene3dGltfMaterialAssetsDocument;
  readonly declaration: Scene3dGltfMaterialAssetDeclaration;
  readonly receipt: OperationReceipt;
  readonly files: readonly Scene3dGltfMaterialAssetFile[];
  readonly manifestAssets: readonly string[];
}
