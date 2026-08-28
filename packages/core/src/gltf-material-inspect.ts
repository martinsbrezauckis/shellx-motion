import type { ParsedGltfContainer } from "./gltf-types";
import type { GltfTextureSource } from "./gltf-material-images";
import {
  GLTF_PBR_MATERIAL_SCHEMA,
  type GltfBaseColorTexture,
  type GltfLegacyScene3dLoss,
  type GltfPbrMaterial,
} from "./gltf-material-types";
import {
  gltfArray as array,
  gltfColorFactor as colorFactor,
  gltfInteger as integer,
  gltfRecord as record,
  gltfTuple as tuple,
} from "./gltf-read";

export function rejectGltfMaterialDocumentFeatures(container: ParsedGltfContainer): void {
  const json = container.json;
  if (json.extensions !== undefined || json.extras !== undefined) throw new Error("glTF document extensions and extras are not supported by the bounded material extractor.");
  for (const field of ["extensionsUsed", "extensionsRequired"] as const) {
    if (json[field] !== undefined && (!Array.isArray(json[field]) || json[field].length > 0)) throw new Error(`glTF ${field} must be empty; compressed or executable extensions are not accepted.`);
  }
}

export function extractGltfPbrMaterials(container: ParsedGltfContainer, textures: readonly GltfTextureSource[]): readonly GltfPbrMaterial[] {
  return Object.freeze(array(container.json.materials ?? [], "glTF materials").map((value, materialIndex) => extractMaterial(value, materialIndex, textures)));
}

function extractMaterial(value: unknown, materialIndex: number, textures: readonly GltfTextureSource[]): GltfPbrMaterial {
  const material = record(value, `glTF material ${materialIndex}`);
  rejectUnknownKeys(material, ["name", "pbrMetallicRoughness", "emissiveFactor", "alphaMode", "doubleSided"], `glTF material ${materialIndex}`);
  if (material.alphaMode !== undefined && material.alphaMode !== "OPAQUE") throw new Error(`glTF material ${materialIndex} alphaMode must be OPAQUE.`);
  if (material.doubleSided !== undefined && material.doubleSided !== false) throw new Error(`glTF material ${materialIndex} doubleSided is not representable by the current scene3d renderer.`);
  const pbr = material.pbrMetallicRoughness === undefined ? {} : record(material.pbrMetallicRoughness, `glTF material ${materialIndex} PBR`);
  if ("metallicRoughnessTexture" in pbr) throw new Error(`glTF material ${materialIndex} metallicRoughnessTexture is not supported by the bounded importer.`);
  rejectUnknownKeys(pbr, ["baseColorFactor", "metallicFactor", "roughnessFactor", "baseColorTexture"], `glTF material ${materialIndex} PBR`);
  const baseColorFactor = colorFactor(pbr.baseColorFactor, [1, 1, 1, 1], `glTF material ${materialIndex} baseColorFactor`);
  if (baseColorFactor[3] !== 1) throw new Error(`glTF material ${materialIndex} baseColorFactor alpha must be 1.`);
  const metallicFactor = factor(pbr.metallicFactor, 1, `glTF material ${materialIndex} metallicFactor`);
  const roughnessFactor = factor(pbr.roughnessFactor, 1, `glTF material ${materialIndex} roughnessFactor`);
  const emissiveFactor = tuple(material.emissiveFactor, [0, 0, 0], 0, 1, `glTF material ${materialIndex} emissiveFactor`);
  const texture = pbr.baseColorTexture === undefined ? undefined : baseColorTexture(pbr.baseColorTexture, materialIndex, textures);
  const legacyBaseColorFactor = colorFactor(pbr.baseColorFactor, [0.8, 0.84, 0.88, 1], `glTF material ${materialIndex} baseColorFactor`);
  const legacyColor = legacyBaseColorFactor.slice(0, 3).map((entry) => Math.round(entry * 255).toString(16).padStart(2, "0")).join("");
  const losses = legacyLosses(baseColorFactor, legacyBaseColorFactor, metallicFactor, roughnessFactor, emissiveFactor, texture);
  const materialValue = {
    schema: GLTF_PBR_MATERIAL_SCHEMA,
    materialIndex,
    baseColorFactor: freezeFactor4(baseColorFactor),
    metallicFactor,
    roughnessFactor,
    emissiveFactor: freezeFactor3(emissiveFactor),
    legacyScene3d: Object.freeze({ color: `#${legacyColor}`, emissive: Math.max(...emissiveFactor), exact: losses.length === 0, losses: Object.freeze([...losses]) }),
    ...(texture ? { baseColorTexture: texture } : {}),
  };
  return Object.freeze(materialValue) as GltfPbrMaterial;
}

function baseColorTexture(value: unknown, materialIndex: number, textures: readonly GltfTextureSource[]): GltfBaseColorTexture {
  const texture = record(value, `glTF material ${materialIndex} baseColorTexture`);
  rejectUnknownKeys(texture, ["index", "texCoord"], `glTF material ${materialIndex} baseColorTexture`);
  if (texture.texCoord !== undefined && texture.texCoord !== 0) throw new Error(`glTF material ${materialIndex} baseColorTexture texCoord must be 0.`);
  const textureIndex = integer(texture.index, `glTF material ${materialIndex} baseColorTexture index`, 0, textures.length - 1);
  const image = textures[textureIndex].image;
  const result = {
    textureIndex, imageIndex: image.imageIndex, texCoord: 0 as const, mimeType: image.mimeType,
    width: image.width, height: image.height, byteLength: image.byteLength,
    derivedRgbaByteLength: image.derivedRgbaByteLength, sha256: image.sha256,
  };
  Object.defineProperty(result, "bytes", { enumerable: true, get: () => image.bytes });
  return Object.freeze(result) as GltfBaseColorTexture;
}

function legacyLosses(
  sourceBaseColor: readonly [number, number, number, number],
  legacyBaseColor: readonly [number, number, number, number],
  metallicFactor: number,
  roughnessFactor: number,
  emissiveFactor: readonly [number, number, number],
  texture: GltfBaseColorTexture | undefined,
): GltfLegacyScene3dLoss[] {
  const losses: GltfLegacyScene3dLoss[] = [];
  if (!sameFactor(sourceBaseColor, legacyBaseColor) || !hexExact(legacyBaseColor)) losses.push("baseColorFactor");
  // scene3d@2 has no PBR material fields; no fixed-shader equivalence is currently qualified.
  losses.push("metallicFactor", "roughnessFactor");
  if (!uniformEmissive(emissiveFactor)) losses.push("emissiveFactor");
  if (texture) losses.push("baseColorTexture");
  return losses;
}

function factor(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number from 0 to 1.`);
  return Object.is(value, -0) ? 0 : value;
}

function sameFactor(left: readonly number[], right: readonly number[]): boolean { return left.every((value, index) => value === right[index]); }
function uniformEmissive([red, green, blue]: readonly [number, number, number]): boolean { return red === green && green === blue; }
function hexExact([red, green, blue]: readonly [number, number, number, number]): boolean { return [red, green, blue].every((value) => Number.isInteger(value * 255)); }
function freezeFactor4(value: [number, number, number, number]): readonly [number, number, number, number] { return Object.freeze([...value]) as unknown as readonly [number, number, number, number]; }
function freezeFactor3(value: [number, number, number]): readonly [number, number, number] { return Object.freeze([...value]) as unknown as readonly [number, number, number]; }
function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`${label} contains unsupported ${unsupported}.`);
}
