import type { ParsedGltfContainer } from "./gltf-types";
import { extractGltfImages, extractGltfTextureSources } from "./gltf-material-images";
import { extractGltfPbrMaterials, rejectGltfMaterialDocumentFeatures } from "./gltf-material-inspect";
import { GLTF_MATERIAL_LIBRARY_SCHEMA, type GltfMaterialLibrary } from "./gltf-material-types";

export {
  GLTF_MATERIAL_LIBRARY_SCHEMA,
  GLTF_PBR_MATERIAL_SCHEMA,
  MAX_GLTF_IMAGE_BYTES,
  MAX_GLTF_IMAGE_BYTES_TOTAL,
  MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES,
  MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES_TOTAL,
} from "./gltf-material-types";
export type {
  GltfBaseColorTexture,
  GltfEmbeddedImage,
  GltfImageMimeType,
  GltfLegacyScene3dLoss,
  GltfMaterialLibrary,
  GltfPbrMaterial,
} from "./gltf-material-types";

/**
 * Extracts the closed glTF 2.0 PBR material subset and contained base-color image bytes.
 *
 * This is intentionally separate from live scene3d lowering. It provides the exact bounded
 * contract a later package/renderer material ABI must carry, while callers that produce a
 * Motion package still fail closed rather than discarding factors or textures.
 */
export function extractGltfMaterialLibrary(container: ParsedGltfContainer): GltfMaterialLibrary {
  rejectGltfMaterialDocumentFeatures(container);
  const images = extractGltfImages(container);
  const textures = extractGltfTextureSources(container, images);
  const materials = extractGltfPbrMaterials(container, textures);
  return Object.freeze({
    schema: GLTF_MATERIAL_LIBRARY_SCHEMA,
    materials: Object.freeze([...materials]),
    images: Object.freeze([...images]),
    textureCount: textures.length,
    derivedRgbaByteLength: images.reduce((total, image) => total + image.derivedRgbaByteLength, 0),
  }) as GltfMaterialLibrary;
}

/** Refuses material/image values that scene3d@2 cannot serialize or render exactly. */
export function assertGltfMaterialLibraryLegacyLowerable(library: GltfMaterialLibrary): void {
  for (const material of library.materials) {
    const loss = material.legacyScene3d.losses[0];
    if (loss === "metallicFactor") {
      throw new Error(`glTF material ${material.materialIndex} metallicFactor is not representable by the current scene3d renderer.`);
    }
    if (loss === "baseColorFactor") {
      throw new Error(`glTF material ${material.materialIndex} baseColorFactor is not exactly representable by the current hex scene3d renderer.`);
    }
    if (loss === "roughnessFactor") {
      throw new Error(`glTF material ${material.materialIndex} roughnessFactor is not representable by the current scene3d renderer.`);
    }
    if (loss === "emissiveFactor") {
      throw new Error(`glTF material ${material.materialIndex} emissiveFactor is not representable by the current scalar scene3d renderer.`);
    }
    if (loss === "baseColorTexture") {
      throw new Error(`glTF material ${material.materialIndex} baseColorTexture is not representable by the current scene3d asset/material ABI.`);
    }
  }
  if (library.textureCount > 0 || library.images.length > 0) {
    throw new Error("glTF contained images or textures are not representable by the current scene3d asset/material ABI.");
  }
}
