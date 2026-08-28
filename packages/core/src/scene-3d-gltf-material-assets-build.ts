import { canonicalJsonSha256 } from "./canonical-json";
import { assertGltfContainedPbrStaticFeatureSubset } from "./gltf-contained-pbr-validation";
import { preflightGltfCanonicalScene } from "./gltf-lowering";
import { deriveGltfTexturedPrimitiveDescriptors } from "./gltf-textured-primitive";
import { extractGltfMaterialLibrary } from "./gltf-material";
import type { GltfBaseColorTexture, GltfPbrMaterial } from "./gltf-material-types";
import type { ParsedGltfContainer } from "./gltf-types";
import { decodePngRgba } from "./png-rgba-decode";
import { hashBuffer } from "./receipts";
import {
  GLTF_SCENE_3D_MATERIAL_ASSET_RECEIPT_REF,
  GLTF_SCENE_3D_MATERIAL_ASSET_SIDECAR_REF,
  MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES,
  MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES_TOTAL,
  MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES,
  MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES_TOTAL,
  SCENE_3D_GLTF_MATERIAL_ASSET_DECLARATION_SCHEMA,
  SCENE_3D_GLTF_MATERIAL_ASSET_PLAN_SCHEMA,
  SCENE_3D_GLTF_MATERIAL_ASSETS_SCHEMA,
  SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS,
  SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION,
  type Scene3dGltfMaterialAssetFile,
  type Scene3dGltfMaterialAssetPlan,
  type Scene3dGltfMaterialAssetsDocument,
  type Scene3dGltfTextureAsset,
} from "./scene-3d-gltf-material-assets-types";

export interface BuildScene3dGltfMaterialAssetPlanInput {
  readonly container: ParsedGltfContainer;
  readonly packageId: string;
  readonly createdAt?: string;
}

/**
 * Produces an immutable sidecar admitted solely to the fixed GPU-to-FFmpeg direct-final PBR lane.
 */
export function buildScene3dGltfMaterialAssetPlan(input: BuildScene3dGltfMaterialAssetPlanInput): Scene3dGltfMaterialAssetPlan {
  assertPackageId(input.packageId);
  assertGltfContainedPbrStaticFeatureSubset(input.container);
  // Enforce selected-scene object and aggregate geometry ceilings before material snapshots or
  // primitive descriptors allocate expanded arrays. This builder is also a callable shared route.
  preflightGltfCanonicalScene(input.container);
  const library = extractGltfMaterialLibrary(input.container);
  const textureSnapshots = materialTextureSnapshots(library.materials);
  const descriptors = deriveGltfTexturedPrimitiveDescriptors(input.container);
  const documentBase = {
    schema: SCENE_3D_GLTF_MATERIAL_ASSETS_SCHEMA,
    packageId: input.packageId,
    rendererStatus: SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS,
    admission: SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION,
    source: { format: input.container.format, sha256: input.container.sourceSha256 },
    materials: Object.freeze(library.materials.map((material) => materialIdentity(material, textureSnapshots))),
    textures: Object.freeze([...textureSnapshots.values()].map((snapshot) => snapshot.texture)),
    texturedPrimitives: Object.freeze(descriptors.map((descriptor) => freezeJson(descriptor))),
    legacyProjectionLosses: Object.freeze(library.materials.map((material) => Object.freeze({
      materialIndex: material.materialIndex,
      losses: Object.freeze([...material.legacyScene3d.losses]),
    }))),
  };
  const document = freezeJson({ ...documentBase, fingerprint: canonicalJsonSha256(documentBase) }) as Scene3dGltfMaterialAssetsDocument;
  const sidecar = fileSnapshot(GLTF_SCENE_3D_MATERIAL_ASSET_SIDECAR_REF, jsonBytes(document));
  const admissionFingerprint = canonicalJsonSha256(document.admission);
  const inputHashes: Record<string, string> = { source: input.container.sourceSha256 };
  document.textures.forEach((texture) => { inputHashes[`texture${texture.textureIndex}`] = texture.encodedSha256; });
  const receipt = freezeJson({
    schema: "shellx-motion/receipt@1" as const,
    id: `adapter-gltf-scene3d-material-assets-direct-final-${sidecar.sha256.slice(0, 16)}`,
    operation: "adapter.gltf.scene3d-material-assets.direct-final",
    status: "passed" as const,
    packageId: input.packageId,
    inputHashes,
    createdAt: input.createdAt ?? new Date().toISOString(),
    lane: "gpu",
    output: {
      schema: document.schema,
      packageId: input.packageId,
      sidecarRef: sidecar.path,
      sidecarSha256: sidecar.sha256,
      fingerprint: document.fingerprint,
      admission: document.admission,
      admissionFingerprint,
      materialCount: document.materials.length,
      textureCount: document.textures.length,
      texturedPrimitiveCount: document.texturedPrimitives.length,
      rendererStatus: document.rendererStatus,
      legacyProjectionLosses: document.legacyProjectionLosses,
    },
    warnings: [],
  });
  const receiptFile = fileSnapshot(GLTF_SCENE_3D_MATERIAL_ASSET_RECEIPT_REF, jsonBytes(receipt));
  const declaration = freezeJson({
    schema: SCENE_3D_GLTF_MATERIAL_ASSET_DECLARATION_SCHEMA,
    packageId: input.packageId,
    sidecarRef: GLTF_SCENE_3D_MATERIAL_ASSET_SIDECAR_REF,
    sidecarSha256: sidecar.sha256,
    receiptRef: GLTF_SCENE_3D_MATERIAL_ASSET_RECEIPT_REF,
    receiptSha256: receiptFile.sha256,
    fingerprint: document.fingerprint,
    admissionFingerprint,
  });
  const assets = [...new Map([...textureSnapshots.values()].map((snapshot) => [snapshot.file.path, snapshot.file])).values()];
  return freezeJson({
    schema: SCENE_3D_GLTF_MATERIAL_ASSET_PLAN_SCHEMA,
    document,
    declaration,
    receipt,
    files: Object.freeze([...assets, sidecar, receiptFile]),
    manifestAssets: Object.freeze([...new Set(document.textures.map((texture) => texture.assetRef))].sort()),
  }) as Scene3dGltfMaterialAssetPlan;
}

interface TextureSnapshot { texture: Scene3dGltfTextureAsset; file: Scene3dGltfMaterialAssetFile }

function materialTextureSnapshots(materials: readonly GltfPbrMaterial[]): Map<number, TextureSnapshot> {
  const snapshots = new Map<number, TextureSnapshot>();
  let encodedTotal = 0;
  let decodedTotal = 0;
  for (const material of materials) {
    if (!material.baseColorTexture || snapshots.has(material.baseColorTexture.textureIndex)) continue;
    const source = material.baseColorTexture;
    if (source.mimeType !== "image/png") throw new Error(`glTF material ${material.materialIndex} baseColorTexture ${source.textureIndex} requires PNG; JPEG has no bounded decoded-RGBA ABI yet.`);
    const encoded = source.bytes;
    if (encoded.byteLength !== source.byteLength || encoded.byteLength > MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES) throw new Error(`glTF material ${material.materialIndex} texture bytes exceed the package asset ceiling.`);
    encodedTotal += encoded.byteLength;
    if (encodedTotal > MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES_TOTAL) throw new Error(`glTF texture assets exceed ${MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES_TOTAL} encoded bytes.`);
    const decoded = decodePngRgba(encoded, { maxRgbaByteLength: MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES });
    if (decoded.width !== source.width || decoded.height !== source.height || decoded.rgba.byteLength > MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES) throw new Error(`glTF material ${material.materialIndex} PNG decode does not satisfy the bounded texture ABI.`);
    decodedTotal += decoded.rgba.byteLength;
    if (decodedTotal > MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES_TOTAL) throw new Error(`glTF texture assets exceed ${MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES_TOTAL} decoded RGBA bytes.`);
    const assetRef = `assets/scene3d/gltf-textures/${source.sha256}.png`;
    const texture = freezeJson({
      textureIndex: source.textureIndex, imageIndex: source.imageIndex, texCoord: source.texCoord, assetRef,
      mimeType: source.mimeType, width: source.width, height: source.height,
      encodedByteLength: encoded.byteLength, encodedSha256: source.sha256,
      decodedRgbaByteLength: decoded.rgba.byteLength, decodedRgbaSha256: hashBuffer(decoded.rgba),
    }) as Scene3dGltfTextureAsset;
    snapshots.set(source.textureIndex, { texture, file: fileSnapshot(assetRef, encoded) });
  }
  return snapshots;
}

function materialIdentity(material: GltfPbrMaterial, snapshots: Map<number, TextureSnapshot>): object {
  const texture = material.baseColorTexture;
  return freezeJson({
    materialIndex: material.materialIndex,
    baseColorFactor: Object.freeze([...material.baseColorFactor]), metallicFactor: material.metallicFactor,
    roughnessFactor: material.roughnessFactor, emissiveFactor: Object.freeze([...material.emissiveFactor]),
    legacyScene3d: freezeJson({ ...material.legacyScene3d, losses: Object.freeze([...material.legacyScene3d.losses]) }),
    ...(texture ? { baseColorTexture: textureIdentity(texture, snapshots) } : {}),
  });
}

function textureIdentity(texture: GltfBaseColorTexture, snapshots: Map<number, TextureSnapshot>): object {
  const snapshot = snapshots.get(texture.textureIndex);
  if (!snapshot) throw new Error(`glTF material texture ${texture.textureIndex} was not retained by the package asset plan.`);
  return freezeJson({ textureIndex: texture.textureIndex, imageIndex: texture.imageIndex, assetRef: snapshot.texture.assetRef });
}

function fileSnapshot(path: string, bytes: Buffer): Scene3dGltfMaterialAssetFile {
  const snapshot = Buffer.from(bytes);
  const file = { path, sha256: hashBuffer(snapshot), byteLength: snapshot.byteLength };
  Object.defineProperty(file, "bytes", { enumerable: true, get: () => Buffer.from(snapshot) });
  return Object.freeze(file) as Scene3dGltfMaterialAssetFile;
}

function jsonBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function assertPackageId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("scene3d glTF material packageId must be a bounded lowercase package identity.");
  }
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
