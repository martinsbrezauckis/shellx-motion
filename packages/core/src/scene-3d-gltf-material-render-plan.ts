import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { readGltfIndexAccessor, readGltfVec3Accessor } from "./gltf-accessor";
import { generatedGltfNormals, normalizeGltfNormals } from "./gltf-math";
import { preflightGltfCanonicalScene } from "./gltf-lowering";
import { preflightGltfScene } from "./gltf-preflight";
import { deriveGltfTexturedPrimitiveDescriptors } from "./gltf-textured-primitive";
import type { ParsedGltfContainer } from "./gltf-types";
import { gltfArray as array, gltfInteger as integer, gltfRecord as record } from "./gltf-read";
import { hashBuffer } from "./receipts";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";
import { MAX_SCENE_3D_MESH_INDICES_TOTAL, MAX_SCENE_3D_MESH_VERTICES_TOTAL } from "./scene-3d";
import { verifyScene3dGltfMaterialAssets } from "./scene-3d-gltf-material-assets-package";
import { type Scene3dGltfMaterialAssetDeclaration, type Scene3dGltfMaterialAssetsDocument } from "./scene-3d-gltf-material-assets-types";
import { scene3dGltfVerifiedTextureRgba, type Scene3dGltfVerifiedTextureSnapshot } from "./scene-3d-gltf-material-verified-snapshot";
import {
  MAX_SCENE_3D_GLTF_MATERIAL_RENDER_PRIMITIVES,
  MAX_SCENE_3D_GLTF_MATERIAL_RENDER_FRAME_RESOURCE_BYTES,
  MAX_SCENE_3D_GLTF_MATERIAL_RENDER_READBACK_BYTES,
  MAX_SCENE_3D_GLTF_MATERIAL_RENDER_RESOURCE_BYTES,
  MAX_SCENE_3D_GLTF_MATERIAL_RENDER_TEXTURE_STORAGE_BYTES,
  SCENE_3D_GLTF_MATERIAL_RENDER_FRAME_SCHEMA,
  SCENE_3D_GLTF_MATERIAL_RENDER_OUTPUT_TRANSFER,
  SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI,
  SCENE_3D_GLTF_MATERIAL_RENDER_STATIC_SCHEMA,
  SCENE_3D_GLTF_MATERIAL_RENDER_TEXTURE_FORMAT,
  SCENE_3D_GLTF_MATERIAL_RENDER_VERTEX_ABI,
  type Scene3dGltfMaterialRenderPlan,
  type Scene3dGltfMaterialRenderPrimitive,
  type Scene3dGltfMaterialRenderStaticPlan,
  type Scene3dGltfMaterialRenderTexture,
} from "./scene-3d-gltf-material-render-types";

export interface PrepareScene3dGltfMaterialRenderPlanInput {
  readonly packageRoot: string;
  /** Package transaction identity required to prove the reopened sidecar provenance. */
  readonly packageId: string;
  readonly declaration: Scene3dGltfMaterialAssetDeclaration;
  readonly container: ParsedGltfContainer;
}

/**
 * Reopens a verified package sidecar and builds the exact PBR vertex/texture resources a future
 * Browser WebGPU path must consume. It deliberately creates no Motion import or browser work.
 */
export async function prepareScene3dGltfMaterialRenderPlan(input: PrepareScene3dGltfMaterialRenderPlanInput): Promise<Scene3dGltfMaterialRenderPlan> {
  const published = await verifyScene3dGltfMaterialAssets(input.packageRoot, input.declaration, input.packageId);
  const document = published.document;
  if (input.container.sourceSha256 !== document.source.sha256 || input.container.format !== document.source.format) {
    throw new Error("glTF material render plan source does not match the verified sidecar source identity.");
  }
  // Reject selected-scene topology and aggregate geometry before reopening material descriptors.
  preflightGltfCanonicalScene(input.container);
  const descriptors = assertCurrentDescriptors(input.container, document);
  if (descriptors.length > MAX_SCENE_3D_GLTF_MATERIAL_RENDER_PRIMITIVES) {
    throw new Error(`glTF material render plan accepts at most ${MAX_SCENE_3D_GLTF_MATERIAL_RENDER_PRIMITIVES} textured primitives.`);
  }
  const modelMatrices = deriveSceneModelMatrices(input.container, descriptors);
  const textures = prepareTextures(document.textures, published.textureSnapshots);
  const resourcesByTextureIndex = new Map<number, Scene3dGltfMaterialRenderTexture>();
  for (const texture of textures) for (const textureIndex of texture.textureIndices) resourcesByTextureIndex.set(textureIndex, texture);
  const primitives = descriptors.map((descriptor) => preparePrimitive(input.container, descriptor, resourcesByTextureIndex)).sort(comparePrimitive);
  const vertexBufferBytes = primitives.reduce((total, primitive) => total + primitive.vertexBufferByteLength, 0);
  const indexBufferBytes = primitives.reduce((total, primitive) => total + primitive.indexBufferByteLength, 0);
  const vertexCount = primitives.reduce((total, primitive) => total + primitive.vertexCount, 0);
  const indexCount = primitives.reduce((total, primitive) => total + primitive.indexCount, 0);
  if (vertexCount > MAX_SCENE_3D_MESH_VERTICES_TOTAL || indexCount > MAX_SCENE_3D_MESH_INDICES_TOTAL) {
    throw new Error("glTF material render plan exceeds the bounded scene3d mesh geometry budget.");
  }
  const decodedTextureBytes = textures.reduce((total, texture) => total + texture.decodedRgbaByteLength, 0);
  const mipmappedTextureBytes = textures.reduce((total, texture) => total + texture.mipmappedRgbaByteLength, 0);
  const uniformBufferBytes = primitives.length * 256;
  const gpuResourceBytes = vertexBufferBytes + indexBufferBytes + uniformBufferBytes + mipmappedTextureBytes;
  if (mipmappedTextureBytes > MAX_SCENE_3D_GLTF_MATERIAL_RENDER_TEXTURE_STORAGE_BYTES || gpuResourceBytes > MAX_SCENE_3D_GLTF_MATERIAL_RENDER_RESOURCE_BYTES) {
    throw new Error("glTF material render plan exceeds its bounded Browser PBR resource budget.");
  }
  const renderTargetBytes = 1280 * 720 * 4, depthTargetBytes = 1280 * 720 * 4, readbackBufferBytes = 1280 * 720 * 4, frameGpuResourceBytes = gpuResourceBytes + renderTargetBytes + depthTargetBytes, peakGpuResourceBytes = frameGpuResourceBytes + readbackBufferBytes;
  if (readbackBufferBytes > MAX_SCENE_3D_GLTF_MATERIAL_RENDER_READBACK_BYTES || peakGpuResourceBytes > MAX_SCENE_3D_GLTF_MATERIAL_RENDER_FRAME_RESOURCE_BYTES) throw new Error("glTF material render frame exceeds its bounded Browser PBR resource budget.");
  const budget = { primitiveCount: primitives.length, textureCount: textures.length, vertexBufferBytes, indexBufferBytes, uniformBufferBytes, decodedTextureBytes, mipmappedTextureBytes, gpuResourceBytes, renderTargetBytes, depthTargetBytes, readbackBufferBytes, frameGpuResourceBytes, peakGpuResourceBytes, preparationPeakRgbaSnapshotBytes: decodedTextureBytes, cpuSnapshotBytes: decodedTextureBytes };
  const textureRecords = textures.map(textureMetadata);
  const staticBase = {
    schema: SCENE_3D_GLTF_MATERIAL_RENDER_STATIC_SCHEMA,
    source: { format: document.source.format, sha256: document.source.sha256 },
    sidecar: { declaration: { ...published.declaration }, fingerprint: document.fingerprint },
    vertexAbi: SCENE_3D_GLTF_MATERIAL_RENDER_VERTEX_ABI,
    pbr: {
      abi: SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI,
      baseColorTextureFormat: SCENE_3D_GLTF_MATERIAL_RENDER_TEXTURE_FORMAT,
      baseColorTextureTransfer: "srgb-to-linear-hardware" as const,
      factorSpace: "linear-gltf" as const,
      brdf: "ggx-smith-schlick-directional@1" as const,
      ambient: "bounded-diffuse@1" as const,
      directionalLight: {
        direction: [-0.4, -0.8, -0.4] as const,
        color: [1, 1, 1] as const,
        intensity: 1 as const,
        ambientDiffuse: 0.15 as const,
      },
      outputTransfer: SCENE_3D_GLTF_MATERIAL_RENDER_OUTPUT_TRANSFER,
    },
    sampler: { addressModeU: "repeat" as const, addressModeV: "repeat" as const, magFilter: "linear" as const, minFilter: "linear" as const, mipmapFilter: "linear" as const, mipmaps: "required-generated" as const },
    textures: textureRecords,
    primitives,
    budget,
  };
  const staticPlan = freezeJson({ ...staticBase, fingerprint: canonicalJsonSha256(staticBase) }) as Scene3dGltfMaterialRenderStaticPlan;
  const camera = deriveFrameCamera(primitives, modelMatrices);
  const bindings = primitives.map((primitive) => {
    const modelMatrix = modelMatrices.get(primitive.id);
    if (!modelMatrix) throw new Error(`glTF textured primitive ${primitive.id} lost its admitted scene transform.`);
    return Object.freeze({ primitiveId: primitive.id, primitiveFingerprint: primitive.fingerprint, textureResourceId: primitive.material.textureResourceId, modelMatrix: Object.freeze([...modelMatrix]), pbrUniformByteLength: 256 as const });
  });
  const cleanup = {
    textureResourceIds: textures.map((texture) => texture.resourceId), primitiveIds: primitives.map((primitive) => primitive.id),
    renderTargetIds: ["scene3d-gltf-pbr-frame-color", "scene3d-gltf-pbr-frame-depth"] as const,
    cpuSnapshotBytes: budget.cpuSnapshotBytes, gpuResourceBytes: budget.frameGpuResourceBytes,
  };
  const frameBase = {
    schema: SCENE_3D_GLTF_MATERIAL_RENDER_FRAME_SCHEMA,
    staticFingerprint: staticPlan.fingerprint,
    pbrAbi: SCENE_3D_GLTF_MATERIAL_RENDER_SDR_PBR_ABI,
    camera,
    primitiveBindings: bindings,
    resourceFingerprint: canonicalJsonSha256({ textures: textureRecords, budget }),
    cleanup,
    renderer: { target: "browser-webgpu" as const, status: "package-internal" as const, route: "browser.scene3d-gltf-pbr-package-internal@1" as const },
  };
  const framePlan = freezeJson({ ...frameBase, fingerprint: canonicalJsonSha256(frameBase) });
  return freezeJson({ staticPlan, framePlan, textures: Object.freeze(textures) }) as Scene3dGltfMaterialRenderPlan;
}

/**
 * Binds a verified material plan to the canonical source-lowered scene state selected by the
 * direct-final marker. Package-internal one-frame rendering deliberately remains unbound.
 */
export function bindScene3dGltfMaterialRenderPlanSceneState(
  plan: Scene3dGltfMaterialRenderPlan,
  sceneStateSha256: string,
): Scene3dGltfMaterialRenderPlan {
  if (!/^[a-f0-9]{64}$/.test(sceneStateSha256)
    || plan.framePlan.staticFingerprint !== plan.staticPlan.fingerprint
    || (plan.staticPlan.sceneStateSha256 !== undefined && plan.staticPlan.sceneStateSha256 !== sceneStateSha256)
    || (plan.framePlan.sceneStateSha256 !== undefined && plan.framePlan.sceneStateSha256 !== sceneStateSha256)) {
    throw new Error("glTF material render plan cannot bind an invalid or conflicting canonical scene state.");
  }
  const { fingerprint: _staticFingerprint, sceneStateSha256: _staticSceneState, ...staticBase } = plan.staticPlan;
  const boundStaticBase = { ...staticBase, sceneStateSha256 };
  const staticPlan = freezeJson({ ...boundStaticBase, fingerprint: canonicalJsonSha256(boundStaticBase) }) as Scene3dGltfMaterialRenderStaticPlan;
  const { fingerprint: _frameFingerprint, staticFingerprint: _priorStaticFingerprint, sceneStateSha256: _frameSceneState, ...frameBase } = plan.framePlan;
  const boundFrameBase = { ...frameBase, staticFingerprint: staticPlan.fingerprint, sceneStateSha256 };
  const framePlan = freezeJson({ ...boundFrameBase, fingerprint: canonicalJsonSha256(boundFrameBase) });
  return freezeJson({ staticPlan, framePlan, textures: plan.textures }) as Scene3dGltfMaterialRenderPlan;
}

function assertCurrentDescriptors(container: ParsedGltfContainer, document: Scene3dGltfMaterialAssetsDocument) {
  const current = deriveGltfTexturedPrimitiveDescriptors(container);
  if (current.length !== document.texturedPrimitives.length) throw new Error("glTF material render plan primitive count does not match the verified sidecar.");
  const sidecarById = new Map(document.texturedPrimitives.map((descriptor) => [primitiveId(descriptor.meshIndex, descriptor.primitiveIndex), descriptor]));
  if (sidecarById.size !== document.texturedPrimitives.length) throw new Error("verified glTF sidecar contains duplicate textured primitive identities.");
  for (const descriptor of current) {
    const sidecar = sidecarById.get(primitiveId(descriptor.meshIndex, descriptor.primitiveIndex));
    if (!sidecar || sidecar.fingerprint !== descriptor.fingerprint) throw new Error(`glTF textured primitive ${descriptor.meshIndex}:${descriptor.primitiveIndex} does not reproduce the verified sidecar descriptor.`);
  }
  return [...document.texturedPrimitives];
}

function prepareTextures(textures: Scene3dGltfMaterialAssetsDocument["textures"], snapshots: readonly Scene3dGltfVerifiedTextureSnapshot[]): Scene3dGltfMaterialRenderTexture[] {
  const grouped = new Map<string, Scene3dGltfMaterialAssetsDocument["textures"][number][]>();
  for (const texture of textures) grouped.set(texture.assetRef, [...(grouped.get(texture.assetRef) ?? []), texture]);
  const snapshotsByRef = new Map(snapshots.map((snapshot) => [snapshot.assetRef, snapshot]));
  if (snapshotsByRef.size !== grouped.size) throw new Error("verified glTF sidecar texture snapshots do not match its asset references.");
  const prepared: Scene3dGltfMaterialRenderTexture[] = [];
  for (const [assetRef, rows] of grouped) {
    const texture = rows[0]!;
    if (rows.some((row) => !sameTextureIdentity(row, texture))) throw new Error(`glTF textures sharing ${assetRef} do not share one exact image identity.`);
    const snapshot = snapshotsByRef.get(assetRef);
    if (!snapshot || !sameVerifiedTextureIdentity(texture, snapshot)) throw new Error(`scene3d glTF PBR texture ${texture.textureIndex} snapshot does not match the verified sidecar.`);
    prepared.push(ownedTexture({
      resourceId: `scene3d-gltf-pbr-${texture.encodedSha256}`,
      textureIndices: rows.map((row) => row.textureIndex).sort((left, right) => left - right), assetRef,
      encodedSha256: texture.encodedSha256, encodedByteLength: texture.encodedByteLength,
      decodedRgbaSha256: texture.decodedRgbaSha256, decodedRgbaByteLength: texture.decodedRgbaByteLength,
      width: texture.width, height: texture.height, ...mipLevels(texture.width, texture.height), rgba: scene3dGltfVerifiedTextureRgba(snapshot),
    }));
  }
  return prepared.sort((left, right) => compareCodeUnits(left.resourceId, right.resourceId));
}

function preparePrimitive(container: ParsedGltfContainer, descriptor: Scene3dGltfMaterialAssetsDocument["texturedPrimitives"][number], textures: ReadonlyMap<number, Scene3dGltfMaterialRenderTexture>): Scene3dGltfMaterialRenderPrimitive {
  const primitive = sourcePrimitive(container, descriptor.meshIndex, descriptor.primitiveIndex);
  const attributes = record(primitive.attributes, `glTF mesh ${descriptor.meshIndex} primitive ${descriptor.primitiveIndex} attributes`);
  const accessors = array(container.json.accessors, "glTF accessors");
  if (integer(attributes.POSITION, "glTF PBR POSITION accessor", 0, accessors.length - 1) !== descriptor.positionAccessorIndex
    || integer(attributes.TEXCOORD_0, "glTF PBR TEXCOORD_0 accessor", 0, accessors.length - 1) !== descriptor.texCoord0.accessorIndex
    || integer(primitive.material, "glTF PBR material", 0, documentMaterialUpper(container)) !== descriptor.materialIndex) throw new Error(`glTF textured primitive ${descriptor.meshIndex}:${descriptor.primitiveIndex} source binding changed after sidecar verification.`);
  const positions = readGltfVec3Accessor(container, descriptor.positionAccessorIndex, "POSITION");
  const indices = readGltfIndexAccessor(container, primitive.indices, positions.count);
  const normals = attributes.NORMAL === undefined ? generatedGltfNormals(positions.values, indices) : normalizeGltfNormals(readGltfVec3Accessor(container, attributes.NORMAL, "NORMAL").values, positions.count, positions.count);
  const texture = textures.get(descriptor.material.baseColorTexture.textureIndex);
  if (!texture || !texture.textureIndices.includes(descriptor.material.baseColorTexture.textureIndex)) throw new Error(`glTF textured primitive ${descriptor.meshIndex}:${descriptor.primitiveIndex} lost its verified texture resource.`);
  const vertices = interleave(positions.values, normals, descriptor.texCoord0.values);
  const geometry = { positions: positions.values, normals, indices };
  const base = {
    id: primitiveId(descriptor.meshIndex, descriptor.primitiveIndex),
    source: { format: container.format, sha256: container.sourceSha256, meshIndex: descriptor.meshIndex, primitiveIndex: descriptor.primitiveIndex, materialIndex: descriptor.materialIndex, positionAccessorIndex: descriptor.positionAccessorIndex, texCoord0AccessorIndex: descriptor.texCoord0.accessorIndex },
    vertices: Object.freeze(vertices), indices: Object.freeze([...indices]), vertexCount: positions.count, indexCount: indices.length,
    geometrySha256: scene3dMeshGeometrySha256(geometry), vertexBufferSha256: hashFloat32Le(vertices), vertexBufferByteLength: vertices.length * 4,
    indexBufferSha256: hashUint32Le(indices), indexBufferByteLength: indices.length * 4,
    material: Object.freeze({ baseColorFactor: Object.freeze([...descriptor.material.baseColorFactor]), metallicFactor: descriptor.material.metallicFactor, roughnessFactor: descriptor.material.roughnessFactor, emissiveFactor: Object.freeze([...descriptor.material.emissiveFactor]), textureResourceId: texture.resourceId, textureIndex: descriptor.material.baseColorTexture.textureIndex }),
  };
  return freezeJson({ ...base, fingerprint: canonicalJsonSha256(base) }) as Scene3dGltfMaterialRenderPrimitive;
}

function sourcePrimitive(container: ParsedGltfContainer, meshIndex: number, primitiveIndex: number): Record<string, unknown> {
  const meshes = array(container.json.meshes, "glTF meshes"); const mesh = record(meshes[meshIndex], `glTF mesh ${meshIndex}`); const primitives = array(mesh.primitives, `glTF mesh ${meshIndex} primitives`);
  const primitive = record(primitives[primitiveIndex], `glTF mesh ${meshIndex} primitive ${primitiveIndex}`);
  if (primitive.mode !== undefined && primitive.mode !== 4 || primitive.targets !== undefined || primitive.extensions !== undefined) throw new Error(`glTF textured primitive ${meshIndex}:${primitiveIndex} is not an admitted static triangle primitive.`);
  return primitive;
}

/** Reuses the bounded static scene traversal to bind every textured primitive to its true node world transform. */
function deriveSceneModelMatrices(container: ParsedGltfContainer, descriptors: readonly Scene3dGltfMaterialAssetsDocument["texturedPrimitives"][number][]): Map<string, readonly number[]> {
  const nodes = array(container.json.nodes, "glTF nodes"), meshes = array(container.json.meshes, "glTF meshes"), scenes = array(container.json.scenes, "glTF scenes");
  const sceneIndex = container.json.scene === undefined ? 0 : integer(container.json.scene, "glTF scene index", 0, scenes.length - 1);
  const scene = record(scenes[sceneIndex], "glTF scene"), roots = array(scene.nodes, "glTF scene nodes").map((value, index) => integer(value, `glTF scene node ${index}`, 0, nodes.length - 1));
  const plans = preflightGltfScene(container, nodes, meshes, roots).plans;
  const wanted = new Set(descriptors.map((descriptor) => primitiveId(descriptor.meshIndex, descriptor.primitiveIndex)));
  const matrices = new Map<string, readonly number[]>();
  for (const plan of plans) {
    const id = primitiveId(plan.meshIndex, plan.primitiveIndex);
    if (!wanted.has(id)) continue;
    if (matrices.has(id)) {
      throw new Error(`glTF textured primitive ${id} is instanced by multiple selected nodes; the material-only PBR frame ABI does not support mesh reuse.`);
    }
    matrices.set(id, modelMatrix(plan.transform.position, plan.transform.rotation, plan.transform.scale));
  }
  for (const descriptor of descriptors) if (!matrices.has(primitiveId(descriptor.meshIndex, descriptor.primitiveIndex))) throw new Error(`glTF textured primitive ${descriptor.meshIndex}:${descriptor.primitiveIndex} is not reachable from the selected scene.`);
  return matrices;
}

/** Deterministic camera used only by this material-only frame ABI; legacy scene3d cameras remain untouched. */
function deriveFrameCamera(primitives: readonly Scene3dGltfMaterialRenderPrimitive[], models: ReadonlyMap<string, readonly number[]>) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives) {
    const model = models.get(primitive.id); if (!model) throw new Error(`glTF textured primitive ${primitive.id} has no scene model matrix.`);
    for (let index = 0; index < primitive.vertices.length; index += 8) {
      const point = transformPoint(model, primitive.vertices.slice(index, index + 3));
      for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis]!, point[axis]!); max[axis] = Math.max(max[axis]!, point[axis]!); }
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) throw new Error("glTF material frame cannot derive finite scene bounds.");
  const target = min.map((value, axis) => (value + max[axis]!) / 2), radius = Math.max(0.25, ...max.map((value, axis) => (value - min[axis]!) / 2));
  const position = [target[0]! + radius * 2.4, target[1]! + radius * 1.7, target[2]! + radius * 3.2], near = Math.max(0.01, radius / 100), far = Math.min(10_000, radius * 20);
  const viewProjection = multiplyMatrix(perspectiveMatrix(42, 1280 / 720, near, far), lookAtMatrix(position, target));
  return Object.freeze({ viewport: Object.freeze({ width: 1280 as const, height: 720 as const }), projection: "perspective@1" as const, fovDeg: 42 as const, near, far, position: Object.freeze([...position]) as readonly [number, number, number], target: Object.freeze([...target]) as readonly [number, number, number], viewProjection: Object.freeze(viewProjection) });
}

function modelMatrix(position: readonly number[], rotation: readonly number[], scale: number): readonly number[] {
  const [x, y, z, w] = rotation, xx = x! * x! * 2, yy = y! * y! * 2, zz = z! * z! * 2, xy = x! * y! * 2, xz = x! * z! * 2, yz = y! * z! * 2, wx = w! * x! * 2, wy = w! * y! * 2, wz = w! * z! * 2;
  return Object.freeze([(1 - yy - zz) * scale, (xy + wz) * scale, (xz - wy) * scale, 0, (xy - wz) * scale, (1 - xx - zz) * scale, (yz + wx) * scale, 0, (xz + wy) * scale, (yz - wx) * scale, (1 - xx - yy) * scale, 0, position[0]!, position[1]!, position[2]!, 1]);
}
function transformPoint(matrix: readonly number[], point: readonly number[]): number[] { return [matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!, matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!, matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!]; }
function lookAtMatrix(position: readonly number[], target: readonly number[]): number[] { const z = normalize3([position[0]! - target[0]!, position[1]! - target[1]!, position[2]! - target[2]!]), x = normalize3(cross3([0, 1, 0], z)), y = cross3(z, x); return [x[0]!, y[0]!, z[0]!, 0, x[1]!, y[1]!, z[1]!, 0, x[2]!, y[2]!, z[2]!, 0, -dot3(x, position), -dot3(y, position), -dot3(z, position), 1]; }
function perspectiveMatrix(fovDeg: number, aspect: number, near: number, far: number): number[] { const focal = 1 / Math.tan(fovDeg * Math.PI / 360), depth = 1 / (near - far); return [focal / aspect, 0, 0, 0, 0, focal, 0, 0, 0, 0, far * depth, -1, 0, 0, near * far * depth, 0]; }
function multiplyMatrix(left: readonly number[], right: readonly number[]): number[] { const result = Array.from({ length: 16 }, () => 0); for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) for (let offset = 0; offset < 4; offset += 1) result[column * 4 + row]! += left[offset * 4 + row]! * right[column * 4 + offset]!; return result; }
function normalize3(value: readonly number[]): number[] { const length = Math.hypot(...value); if (!Number.isFinite(length) || length < 0.000001) throw new Error("glTF material frame camera basis is invalid."); return value.map((entry) => entry / length); }
function cross3(left: readonly number[], right: readonly number[]): number[] { return [left[1]! * right[2]! - left[2]! * right[1]!, left[2]! * right[0]! - left[0]! * right[2]!, left[0]! * right[1]! - left[1]! * right[0]!]; }
function dot3(left: readonly number[], right: readonly number[]): number { return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!; }

function documentMaterialUpper(container: ParsedGltfContainer): number { return array(container.json.materials ?? [], "glTF materials").length - 1; }
function interleave(positions: readonly number[], normals: readonly number[], uv: readonly number[]): number[] { const values: number[] = []; for (let index = 0; index < positions.length / 3; index += 1) values.push(...positions.slice(index * 3, index * 3 + 3), ...normals.slice(index * 3, index * 3 + 3), ...uv.slice(index * 2, index * 2 + 2)); return values; }
function hashFloat32Le(values: readonly number[]): string { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeFloatLE(value, index * 4)); return hashBuffer(bytes); }
function hashUint32Le(values: readonly number[]): string { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return hashBuffer(bytes); }
function primitiveId(meshIndex: number, primitiveIndex: number): string { return `mesh-${meshIndex}-primitive-${primitiveIndex}`; }
function comparePrimitive(left: Scene3dGltfMaterialRenderPrimitive, right: Scene3dGltfMaterialRenderPrimitive): number { return compareCodeUnits(left.id, right.id); }
function sameTextureIdentity(left: Scene3dGltfMaterialAssetsDocument["textures"][number], right: Scene3dGltfMaterialAssetsDocument["textures"][number]): boolean { return left.encodedSha256 === right.encodedSha256 && left.encodedByteLength === right.encodedByteLength && left.decodedRgbaSha256 === right.decodedRgbaSha256 && left.decodedRgbaByteLength === right.decodedRgbaByteLength && left.width === right.width && left.height === right.height; }
function sameVerifiedTextureIdentity(texture: Scene3dGltfMaterialAssetsDocument["textures"][number], snapshot: Scene3dGltfVerifiedTextureSnapshot): boolean { return texture.assetRef === snapshot.assetRef && texture.encodedSha256 === snapshot.encodedSha256 && texture.encodedByteLength === snapshot.encodedByteLength && texture.decodedRgbaSha256 === snapshot.decodedRgbaSha256 && texture.decodedRgbaByteLength === snapshot.decodedRgbaByteLength && texture.width === snapshot.width && texture.height === snapshot.height; }
function mipLevels(width: number, height: number): { mipLevelCount: number; mipmappedRgbaByteLength: number } { let levels = 0, bytes = 0, currentWidth = width, currentHeight = height; while (true) { levels += 1; bytes += currentWidth * currentHeight * 4; if (currentWidth === 1 && currentHeight === 1) return { mipLevelCount: levels, mipmappedRgbaByteLength: bytes }; currentWidth = Math.max(1, Math.floor(currentWidth / 2)); currentHeight = Math.max(1, Math.floor(currentHeight / 2)); } }
function textureMetadata(texture: Scene3dGltfMaterialRenderTexture): Omit<Scene3dGltfMaterialRenderTexture, "rgba"> { const { resourceId, textureIndices, assetRef, encodedSha256, encodedByteLength, decodedRgbaSha256, decodedRgbaByteLength, width, height, mipLevelCount, mipmappedRgbaByteLength } = texture; return { resourceId, textureIndices, assetRef, encodedSha256, encodedByteLength, decodedRgbaSha256, decodedRgbaByteLength, width, height, mipLevelCount, mipmappedRgbaByteLength }; }
function ownedTexture(value: Scene3dGltfMaterialRenderTexture): Scene3dGltfMaterialRenderTexture { const snapshot = value.rgba; const texture = { ...textureMetadata(value) }; Object.defineProperty(texture, "rgba", { enumerable: true, get: () => Buffer.from(snapshot) }); return Object.freeze(texture) as Scene3dGltfMaterialRenderTexture; }
function freezeJson<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child); Object.freeze(value); } return value; }
