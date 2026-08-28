import { readVerifiedPackageAsset } from "./package-asset-read";
import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { decodePngRgba } from "./png-rgba-decode";
import { hashBuffer } from "./receipts";
import { readBoundedStableFile, writeVerifiedBoundedFile } from "./stable-file-read";
import { ownScene3dGltfVerifiedTextureSnapshot, type Scene3dGltfVerifiedTextureSnapshot } from "./scene-3d-gltf-material-verified-snapshot";
import {
  GLTF_SCENE_3D_MATERIAL_ASSET_RECEIPT_REF,
  GLTF_SCENE_3D_MATERIAL_ASSET_SIDECAR_REF,
  MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES,
  MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES_TOTAL,
  MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES,
  MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES_TOTAL,
  SCENE_3D_GLTF_MATERIAL_ASSET_DECLARATION_SCHEMA,
  SCENE_3D_GLTF_MATERIAL_ASSETS_SCHEMA,
  SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS,
  SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION,
  type Scene3dGltfMaterialAssetDeclaration,
  type Scene3dGltfMaterialAssetFile,
  type Scene3dGltfMaterialAssetPlan,
  type Scene3dGltfMaterialAssetsDocument,
  type Scene3dGltfTextureAsset,
} from "./scene-3d-gltf-material-assets-types";

export interface PublishedScene3dGltfMaterialAssets {
  readonly document: Scene3dGltfMaterialAssetsDocument;
  readonly declaration: Scene3dGltfMaterialAssetDeclaration;
  /** One owned decoded RGBA snapshot per unique verified PNG asset; `rgba` reads are defensive. */
  readonly textureSnapshots: readonly Scene3dGltfVerifiedTextureSnapshot[];
}

/** Writes only the plan's copied bytes, no-follow and idempotently, then reopens every identity. */
export async function publishScene3dGltfMaterialAssets(
  packageRoot: string,
  plan: Scene3dGltfMaterialAssetPlan,
): Promise<PublishedScene3dGltfMaterialAssets> {
  assertPlan(plan);
  for (const file of plan.files) await writeOrVerify(packageRoot, file);
  return await verifyScene3dGltfMaterialAssets(packageRoot, plan.declaration, plan.declaration.packageId);
}

/** Reopens the declaration-bound sidecar, receipt, encoded PNG snapshots, and decoded RGBA identities. */
export async function verifyScene3dGltfMaterialAssets(
  packageRoot: string,
  declaration: Scene3dGltfMaterialAssetDeclaration,
  expectedPackageId: string,
): Promise<PublishedScene3dGltfMaterialAssets> {
  assertDeclaration(declaration);
  assertPackageId(expectedPackageId, "expected scene3d glTF material packageId");
  if (declaration.packageId !== expectedPackageId) throw new Error("scene3d glTF material declaration does not match the expected package identity.");
  const sidecar = await readVerifiedPackageAsset({ root: packageRoot }, declaration.sidecarRef, {
    label: "scene3d glTF material sidecar", maxBytes: 1024 * 1024,
  });
  if (sidecar.sha256 !== declaration.sidecarSha256) throw new Error("scene3d glTF material sidecar hash does not match its declaration.");
  const document = parseDocument(sidecar.bytes);
  if (document.packageId !== expectedPackageId) throw new Error("scene3d glTF material sidecar does not match the expected package identity.");
  if (document.fingerprint !== declaration.fingerprint) throw new Error("scene3d glTF material sidecar fingerprint does not match its declaration.");
  if (canonicalJsonSha256(document.admission) !== declaration.admissionFingerprint) {
    throw new Error("scene3d glTF material sidecar direct-final admission does not match its declaration.");
  }
  const textureSnapshots = await verifyTextureSnapshots(packageRoot, document.textures);
  const receipt = await readVerifiedPackageAsset({ root: packageRoot }, declaration.receiptRef, {
    label: "scene3d glTF material assets receipt", maxBytes: 1024 * 1024,
  });
  if (receipt.sha256 !== declaration.receiptSha256) throw new Error("scene3d glTF material assets receipt hash does not match its declaration.");
  verifyReceipt(receipt.bytes, declaration, document, expectedPackageId);
  return Object.freeze({ document, declaration: Object.freeze({ ...declaration }), textureSnapshots: Object.freeze(textureSnapshots) });
}

/** Manifest-ready adapter metadata; a future renderer-qualified importer may merge it atomically. */
export function scene3dGltfMaterialAssetManifestData(plan: Scene3dGltfMaterialAssetPlan): Readonly<{ scene3dMaterialAssets: Scene3dGltfMaterialAssetDeclaration }> {
  assertPlan(plan);
  return Object.freeze({ scene3dMaterialAssets: Object.freeze({ ...plan.declaration }) });
}

async function writeOrVerify(packageRoot: string, file: Scene3dGltfMaterialAssetFile): Promise<void> {
  const bytes = file.bytes;
  if (bytes.byteLength !== file.byteLength || hashBuffer(bytes) !== file.sha256) throw new Error(`scene3d glTF material plan file ${file.path} identity changed before publication.`);
  try {
    await writeVerifiedBoundedFile(`${packageRoot}/${file.path}`, bytes, {
      label: `scene3d glTF material asset ${file.path}`,
      maxBytes: file.path.startsWith("assets/") ? MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES : 1024 * 1024,
      withinRoot: packageRoot,
      expectedSha256: file.sha256,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const present = await readBoundedStableFile(`${packageRoot}/${file.path}`, {
      label: `scene3d glTF material asset ${file.path}`,
      maxBytes: file.path.startsWith("assets/") ? MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES : 1024 * 1024,
      withinRoot: packageRoot,
    });
    if (present.byteLength !== file.byteLength || present.sha256 !== file.sha256 || !present.bytes.equals(bytes)) {
      throw new Error(`scene3d glTF material asset ${file.path} already exists with different bytes.`);
    }
  }
}

function assertPlan(plan: Scene3dGltfMaterialAssetPlan): void {
  assertDeclaration(plan.declaration);
  if (plan.document.packageId !== plan.declaration.packageId || plan.receipt.packageId !== plan.declaration.packageId
    || record(plan.receipt.output, "scene3d glTF material plan receipt output").packageId !== plan.declaration.packageId) {
    throw new Error("scene3d glTF material plan package identity is inconsistent.");
  }
  if (plan.document.rendererStatus !== SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS
    || canonicalJsonSha256(plan.document.admission) !== plan.declaration.admissionFingerprint
    || !sameDirectFinalAdmission(plan.document.admission)) {
    throw new Error("scene3d glTF material plan does not carry the admitted direct-final contract.");
  }
  const files = new Map(plan.files.map((file) => [file.path, file]));
  const sidecar = files.get(plan.declaration.sidecarRef);
  const receipt = files.get(plan.declaration.receiptRef);
  if (!sidecar || !receipt || sidecar.sha256 !== plan.declaration.sidecarSha256 || receipt.sha256 !== plan.declaration.receiptSha256) {
    throw new Error("scene3d glTF material plan sidecar or receipt does not match its declaration.");
  }
  if (new Set(plan.files.map((file) => file.path)).size !== plan.files.length) throw new Error("scene3d glTF material plan contains duplicate package paths.");
  if (canonicalJsonSha256(omit(plan.document as unknown as Record<string, unknown>, "fingerprint")) !== plan.document.fingerprint) throw new Error("scene3d glTF material plan fingerprint is invalid.");
}

function assertDeclaration(value: unknown): asserts value is Scene3dGltfMaterialAssetDeclaration {
  const declaration = record(value, "scene3d glTF material declaration");
  const allowed = ["schema", "packageId", "sidecarRef", "sidecarSha256", "receiptRef", "receiptSha256", "fingerprint", "admissionFingerprint"];
  if (Object.keys(declaration).some((key) => !allowed.includes(key))
    || declaration.schema !== SCENE_3D_GLTF_MATERIAL_ASSET_DECLARATION_SCHEMA
    || declaration.sidecarRef !== GLTF_SCENE_3D_MATERIAL_ASSET_SIDECAR_REF
    || declaration.receiptRef !== GLTF_SCENE_3D_MATERIAL_ASSET_RECEIPT_REF) throw new Error("scene3d glTF material declaration is invalid.");
  assertPackageId(declaration.packageId, "scene3d glTF material declaration packageId");
  sha(declaration.sidecarSha256, "scene3d glTF material declaration sidecarSha256");
  sha(declaration.receiptSha256, "scene3d glTF material declaration receiptSha256");
  sha(declaration.fingerprint, "scene3d glTF material declaration fingerprint");
  sha(declaration.admissionFingerprint, "scene3d glTF material declaration admissionFingerprint");
}

function parseDocument(bytes: Buffer): Scene3dGltfMaterialAssetsDocument {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("scene3d glTF material sidecar is not valid JSON."); }
  const document = record(value, "scene3d glTF material sidecar");
  const allowed = ["schema", "packageId", "rendererStatus", "admission", "source", "materials", "textures", "texturedPrimitives", "legacyProjectionLosses", "fingerprint"];
  if (Object.keys(document).some((key) => !allowed.includes(key)) || document.schema !== SCENE_3D_GLTF_MATERIAL_ASSETS_SCHEMA || document.rendererStatus !== SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS || !sameDirectFinalAdmission(document.admission)) {
    throw new Error("scene3d glTF material sidecar schema or renderer status is invalid.");
  }
  assertPackageId(document.packageId, "scene3d glTF material sidecar packageId");
  const source = record(document.source, "scene3d glTF material source");
  if ((source.format !== "gltf" && source.format !== "glb")) throw new Error("scene3d glTF material source format is invalid.");
  sha(source.sha256, "scene3d glTF material source sha256");
  if (!Array.isArray(document.materials) || !Array.isArray(document.textures) || !Array.isArray(document.texturedPrimitives) || !Array.isArray(document.legacyProjectionLosses)) {
    throw new Error("scene3d glTF material sidecar arrays are invalid.");
  }
  document.materials.forEach((material, index) => verifyMaterial(record(material, `scene3d glTF material ${index}`), index));
  const textures = document.textures.map((texture, index) => verifyTexture(record(texture, `scene3d glTF texture ${index}`), index));
  verifyMaterialTextureBindings(document.materials, textures);
  verifyPrimitiveIdentities(document.texturedPrimitives, document.materials, textures, source.sha256 as string);
  verifyLegacyProjectionLosses(document.legacyProjectionLosses, document.materials);
  sha(document.fingerprint, "scene3d glTF material fingerprint");
  if (canonicalJsonSha256(omit(document, "fingerprint")) !== document.fingerprint) throw new Error("scene3d glTF material sidecar fingerprint is invalid.");
  return freezeJson(document) as unknown as Scene3dGltfMaterialAssetsDocument;
}

function verifyMaterial(material: Record<string, unknown>, index: number): void {
  const allowed = ["materialIndex", "baseColorFactor", "metallicFactor", "roughnessFactor", "emissiveFactor", "legacyScene3d", "baseColorTexture"];
  if (Object.keys(material).some((key) => !allowed.includes(key)) || material.materialIndex !== index) throw new Error(`scene3d glTF material ${index} is invalid.`);
  factorArray(material.baseColorFactor, 4, `scene3d glTF material ${index} baseColorFactor`);
  if ((material.baseColorFactor as number[])[3] !== 1) throw new Error(`scene3d glTF material ${index} baseColorFactor alpha must be one.`);
  factor(material.metallicFactor, `scene3d glTF material ${index} metallicFactor`); factor(material.roughnessFactor, `scene3d glTF material ${index} roughnessFactor`);
  factorArray(material.emissiveFactor, 3, `scene3d glTF material ${index} emissiveFactor`);
  const legacy = record(material.legacyScene3d, `scene3d glTF material ${index} legacyScene3d`);
  if (!/^#[a-f0-9]{6}$/.test(String(legacy.color)) || !Array.isArray(legacy.losses) || typeof legacy.exact !== "boolean") throw new Error(`scene3d glTF material ${index} legacy diagnostics are invalid.`);
  factor(legacy.emissive, `scene3d glTF material ${index} legacy emissive`);
  legacy.losses.forEach((loss) => { if (!["baseColorFactor", "metallicFactor", "roughnessFactor", "emissiveFactor", "baseColorTexture"].includes(String(loss))) throw new Error(`scene3d glTF material ${index} legacy loss is invalid.`); });
}

function verifyTexture(texture: Record<string, unknown>, index: number): Scene3dGltfTextureAsset {
  const allowed = ["textureIndex", "imageIndex", "texCoord", "assetRef", "mimeType", "width", "height", "encodedByteLength", "encodedSha256", "decodedRgbaByteLength", "decodedRgbaSha256"];
  const textureIndex = nonNegativeInteger(texture.textureIndex); const imageIndex = nonNegativeInteger(texture.imageIndex);
  if (Object.keys(texture).some((key) => !allowed.includes(key)) || textureIndex === null || imageIndex === null || texture.texCoord !== 0 || texture.mimeType !== "image/png") throw new Error(`scene3d glTF texture ${index} is invalid.`);
  sha(texture.encodedSha256, `scene3d glTF texture ${index} encodedSha256`); sha(texture.decodedRgbaSha256, `scene3d glTF texture ${index} decodedRgbaSha256`);
  if (texture.assetRef !== `assets/scene3d/gltf-textures/${texture.encodedSha256}.png` || !positive(texture.width) || !positive(texture.height)
    || !positive(texture.encodedByteLength) || texture.encodedByteLength > MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES
    || texture.decodedRgbaByteLength !== texture.width * texture.height * 4 || texture.decodedRgbaByteLength > MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES) throw new Error(`scene3d glTF texture ${index} bounds are invalid.`);
  return texture as unknown as Scene3dGltfTextureAsset;
}

function verifyMaterialTextureBindings(materials: unknown[], textures: Scene3dGltfTextureAsset[]): void {
  const byIndex = new Map(textures.map((texture) => [texture.textureIndex, texture]));
  if (byIndex.size !== textures.length) throw new Error("scene3d glTF texture indices must be unique.");
  materials.forEach((value, index) => {
    const texture = record(value, `scene3d glTF material ${index}`).baseColorTexture;
    if (texture === undefined) return;
    const binding = record(texture, `scene3d glTF material ${index} baseColorTexture`);
    const target = byIndex.get(Number(binding.textureIndex));
    if (!target || binding.imageIndex !== target.imageIndex || binding.assetRef !== target.assetRef) throw new Error(`scene3d glTF material ${index} texture binding is invalid.`);
  });
}

function verifyPrimitiveIdentities(primitives: unknown[], materials: unknown[], textures: Scene3dGltfTextureAsset[], documentSourceSha256: string): void {
  const byIndex = new Map(textures.map((texture) => [texture.textureIndex, texture]));
  primitives.forEach((value, index) => {
    const primitive = record(value, `scene3d glTF textured primitive ${index}`);
    const primitiveAllowed = ["schema", "sourceSha256", "meshIndex", "primitiveIndex", "materialIndex", "positionAccessorIndex", "vertexCount", "material", "texCoord0", "fingerprint"];
    const { fingerprint, ...base } = primitive;
    const primitiveMaterialIndex = nonNegativeInteger(primitive.materialIndex);
    if (Object.keys(primitive).some((key) => !primitiveAllowed.includes(key)) || primitive.schema !== "shellx-motion/gltf-textured-primitive@1" || primitiveMaterialIndex === null || primitiveMaterialIndex >= materials.length
      || nonNegativeInteger(primitive.meshIndex) === null || nonNegativeInteger(primitive.primitiveIndex) === null || nonNegativeInteger(primitive.positionAccessorIndex) === null || !positive(primitive.vertexCount)
      || canonicalJsonSha256(base) !== fingerprint) throw new Error(`scene3d glTF textured primitive ${index} fingerprint is invalid.`);
    sha(primitive.sourceSha256, `scene3d glTF textured primitive ${index} sourceSha256`);
    if (primitive.sourceSha256 !== documentSourceSha256) throw new Error(`scene3d glTF textured primitive ${index} source identity does not match the sidecar source.`);
    const texCoord0 = record(primitive.texCoord0, `scene3d glTF textured primitive ${index} TEXCOORD_0`);
    const texCoordAllowed = ["schema", "accessorIndex", "format", "count", "sourceSpanBytes", "decodedByteLength", "values", "valuesSha256"];
    const { valuesSha256, ...texCoordBase } = texCoord0;
    if (Object.keys(texCoord0).some((key) => !texCoordAllowed.includes(key)) || texCoord0.schema !== "shellx-motion/gltf-texcoord0@1" || !Array.isArray(texCoord0.values)
      || !["float32", "unorm8", "unorm16"].includes(String(texCoord0.format)) || nonNegativeInteger(texCoord0.accessorIndex) === null || !positive(texCoord0.count)
      || !positive(texCoord0.sourceSpanBytes) || texCoord0.decodedByteLength !== texCoord0.values.length * 4 || texCoord0.values.length !== texCoord0.count * 2
      || !texCoord0.values.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)
      || canonicalJsonSha256(texCoordBase) !== valuesSha256) throw new Error(`scene3d glTF textured primitive ${index} TEXCOORD_0 identity is invalid.`);
    const primitiveMaterial = record(primitive.material, `scene3d glTF textured primitive ${index} material`);
    const primitiveMaterialAllowed = ["baseColorFactor", "metallicFactor", "roughnessFactor", "emissiveFactor", "baseColorTexture"];
    if (Object.keys(primitiveMaterial).some((key) => !primitiveMaterialAllowed.includes(key))) throw new Error(`scene3d glTF textured primitive ${index} material is invalid.`);
    const texture = record(primitiveMaterial.baseColorTexture, `scene3d glTF textured primitive ${index} texture`);
    const textureAllowed = ["textureIndex", "imageIndex", "texCoord", "mimeType", "width", "height", "byteLength", "derivedRgbaByteLength", "sha256"];
    if (Object.keys(texture).some((key) => !textureAllowed.includes(key)) || texture.texCoord !== 0) throw new Error(`scene3d glTF textured primitive ${index} texture is invalid.`);
    const textureIndex = nonNegativeInteger(texture.textureIndex);
    const materialIndex = primitiveMaterialIndex;
    const target = textureIndex === null ? undefined : byIndex.get(textureIndex);
    const material = materialIndex === null ? undefined : record(materials[materialIndex], `scene3d glTF material ${materialIndex}`);
    if (!target || !material || target.encodedSha256 !== texture.sha256 || texture.imageIndex !== target.imageIndex || texture.mimeType !== target.mimeType
      || texture.width !== target.width || texture.height !== target.height || texture.byteLength !== target.encodedByteLength || texture.derivedRgbaByteLength !== target.decodedRgbaByteLength
      || canonicalJsonSha256(primitiveMaterial.baseColorFactor) !== canonicalJsonSha256(material.baseColorFactor)
      || primitiveMaterial.metallicFactor !== material.metallicFactor || primitiveMaterial.roughnessFactor !== material.roughnessFactor
      || canonicalJsonSha256(primitiveMaterial.emissiveFactor) !== canonicalJsonSha256(material.emissiveFactor)) throw new Error(`scene3d glTF textured primitive ${index} material texture identity is invalid.`);
  });
}

function verifyLegacyProjectionLosses(entries: unknown[], materials: unknown[]): void {
  if (entries.length !== materials.length) throw new Error("scene3d glTF material legacy-loss entries are incomplete.");
  entries.forEach((value, index) => {
    const entry = record(value, `scene3d glTF material legacy loss ${index}`); const material = record(materials[index], `scene3d glTF material ${index}`); const legacy = record(material.legacyScene3d, "legacy");
    if (entry.materialIndex !== index || JSON.stringify(entry.losses) !== JSON.stringify(legacy.losses)) throw new Error(`scene3d glTF material ${index} legacy losses do not match material diagnostics.`);
  });
}

async function verifyTextureSnapshots(packageRoot: string, textures: readonly Scene3dGltfTextureAsset[]): Promise<Scene3dGltfVerifiedTextureSnapshot[]> {
  let encodedTotal = 0; let decodedTotal = 0;
  const snapshots = new Map<string, { readonly bytes: Buffer; readonly byteLength: number; readonly sha256: string; readonly decoded?: ReturnType<typeof decodePngRgba> }>();
  const verified = new Map<string, Scene3dGltfVerifiedTextureSnapshot>();
  for (const texture of textures) {
    encodedTotal += texture.encodedByteLength; decodedTotal += texture.decodedRgbaByteLength;
    if (encodedTotal > MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES_TOTAL || decodedTotal > MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES_TOTAL) throw new Error("scene3d glTF texture aggregate bounds are exceeded.");
    let snapshot = snapshots.get(texture.assetRef);
    if (!snapshot) {
      const file = await readVerifiedPackageAsset({ root: packageRoot }, texture.assetRef, { label: `scene3d glTF texture ${texture.textureIndex}`, maxBytes: MAX_SCENE_3D_GLTF_TEXTURE_ASSET_BYTES });
      snapshot = { bytes: Buffer.from(file.bytes), byteLength: file.byteLength, sha256: file.sha256 };
      snapshots.set(texture.assetRef, snapshot);
    }
    if (snapshot.byteLength !== texture.encodedByteLength || snapshot.sha256 !== texture.encodedSha256) throw new Error(`scene3d glTF texture ${texture.textureIndex} encoded identity mismatch.`);
    const decoded = snapshot.decoded ?? decodePngRgba(snapshot.bytes, { maxRgbaByteLength: MAX_SCENE_3D_GLTF_TEXTURE_RGBA_BYTES });
    if (!snapshot.decoded) snapshots.set(texture.assetRef, { ...snapshot, decoded });
    if (decoded.width !== texture.width || decoded.height !== texture.height || decoded.rgba.byteLength !== texture.decodedRgbaByteLength || hashBuffer(decoded.rgba) !== texture.decodedRgbaSha256) throw new Error(`scene3d glTF texture ${texture.textureIndex} decoded RGBA identity mismatch.`);
    if (!verified.has(texture.assetRef)) verified.set(texture.assetRef, ownScene3dGltfVerifiedTextureSnapshot({
      assetRef: texture.assetRef, encodedSha256: texture.encodedSha256, encodedByteLength: texture.encodedByteLength,
      decodedRgbaSha256: texture.decodedRgbaSha256, decodedRgbaByteLength: texture.decodedRgbaByteLength,
      width: texture.width, height: texture.height,
    }, decoded.rgba));
  }
  return [...verified.values()].sort((left, right) => compareCodeUnits(left.assetRef, right.assetRef));
}

function verifyReceipt(bytes: Buffer, declaration: Scene3dGltfMaterialAssetDeclaration, document: Scene3dGltfMaterialAssetsDocument, expectedPackageId: string): void {
  let value: unknown; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("scene3d glTF material assets receipt is not valid JSON."); }
  const receipt = record(value, "scene3d glTF material assets receipt"); const output = record(receipt.output, "scene3d glTF material assets receipt output");
  const outputAllowed = ["schema", "packageId", "sidecarRef", "sidecarSha256", "fingerprint", "admission", "admissionFingerprint", "materialCount", "textureCount", "texturedPrimitiveCount", "rendererStatus", "legacyProjectionLosses"];
  if (Object.keys(output).some((key) => !outputAllowed.includes(key))
    || receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== "adapter.gltf.scene3d-material-assets.direct-final" || receipt.status !== "passed" || receipt.lane !== "gpu" || !Array.isArray(receipt.warnings) || receipt.warnings.length !== 0 || receipt.packageId !== expectedPackageId || declaration.packageId !== expectedPackageId || document.packageId !== expectedPackageId || receipt.id !== `adapter-gltf-scene3d-material-assets-direct-final-${declaration.sidecarSha256.slice(0, 16)}`
    || !sameHashRecord(receipt.inputHashes, receiptInputHashes(document))
    || output.schema !== document.schema || output.packageId !== expectedPackageId || output.sidecarRef !== declaration.sidecarRef || output.sidecarSha256 !== declaration.sidecarSha256 || output.fingerprint !== document.fingerprint
    || output.rendererStatus !== SCENE_3D_GLTF_MATERIAL_RENDERER_STATUS || output.admissionFingerprint !== declaration.admissionFingerprint || canonicalJsonSha256(output.admission) !== declaration.admissionFingerprint || canonicalJsonSha256(output.admission) !== canonicalJsonSha256(document.admission)
    || canonicalJsonSha256(output.legacyProjectionLosses) !== canonicalJsonSha256(document.legacyProjectionLosses)
    || output.materialCount !== document.materials.length || output.textureCount !== document.textures.length || output.texturedPrimitiveCount !== document.texturedPrimitives.length) throw new Error("scene3d glTF material assets receipt does not bind the admitted direct-final sidecar identity.");
}

function sameDirectFinalAdmission(value: unknown): boolean {
  return canonicalJsonSha256(value) === canonicalJsonSha256(SCENE_3D_GLTF_PBR_DIRECT_FINAL_ADMISSION);
}

function receiptInputHashes(document: Scene3dGltfMaterialAssetsDocument): Record<string, string> {
  const hashes: Record<string, string> = { source: document.source.sha256 };
  document.textures.forEach((texture) => { hashes[`texture${texture.textureIndex}`] = texture.encodedSha256; });
  return hashes;
}

function sameHashRecord(value: unknown, expected: Record<string, string>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = value as Record<string, unknown>;
  const actualKeys = Object.keys(actual).sort(); const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function factor(value: unknown, label: string): void { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite factor from zero to one.`); }
function factorArray(value: unknown, length: number, label: string): void { if (!Array.isArray(value) || value.length !== length) throw new Error(`${label} has invalid length.`); value.forEach((item) => factor(item, label)); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nonNegativeInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function sha(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256.`); }
function assertPackageId(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a bounded lowercase package identity.`); }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function omit(value: Record<string, unknown>, key: string): Record<string, unknown> { const { [key]: _removed, ...rest } = value; return rest; }
function freezeJson<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child); Object.freeze(value); } return value; }
