import { createHash } from "node:crypto";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY } from "./gpu-page-scene3d-gltf-pbr-contract";
import { installWebGpuPageSessionScene3dGltfPbrPipeline } from "./gpu-page-scene3d-gltf-pbr-pipeline";
import { renderWebGpuPageSessionScene3dGltfPbrFrame } from "./gpu-page-scene3d-gltf-pbr-frame";
import { GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA, readWebGpuPageSessionScene3dGltfPbrFrame, type GpuPageScene3dGltfPbrReadbackEvidence } from "./gpu-page-scene3d-gltf-pbr-readback";
import {
  prepareWebGpuPageSessionScene3dGltfPbrResources,
  releaseWebGpuPageSessionScene3dGltfPbrResources,
  type GpuPageScene3dGltfPbrReleaseEvidence,
  type GpuPageScene3dGltfPbrResourceInput,
  type GpuPageScene3dGltfPbrResourceMetrics,
} from "./gpu-page-scene3d-gltf-pbr-resources";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";

/** Narrow page boundary for the dormant material-only route; it is not registered as a live frame renderer. */
export interface GpuScene3dGltfPbrPage { evaluate(pageFunction: unknown, argument?: unknown): Promise<unknown> }

type OpaqueRenderPlan = {
  staticPlan: { schema: "shellx-motion/scene3d-gltf-material-render-static@1"; fingerprint: string; source: { sha256: string }; pbr: GpuPageScene3dGltfPbrResourceInput["pbr"]; textures: readonly OpaqueTextureMetadata[]; primitives: readonly OpaquePrimitive[]; budget: GpuPageScene3dGltfPbrResourceInput["budget"] };
  framePlan: { schema: "shellx-motion/scene3d-gltf-material-render-frame@1"; fingerprint: string; staticFingerprint: string; pbrAbi: "shellx-motion/browser-scene3d-gltf-pbr-sdr@1"; camera: GpuPageScene3dGltfPbrResourceInput["camera"]; primitiveBindings: readonly OpaqueBinding[]; resourceFingerprint: string };
  textures: readonly OpaqueTexture[];
};
type OpaqueTexture = { resourceId: string; assetRef: string; encodedSha256: string; decodedRgbaSha256: string; width: number; height: number; decodedRgbaByteLength: number; mipLevelCount: number; mipmappedRgbaByteLength: number; rgba: Buffer };
type OpaqueTextureMetadata = Omit<OpaqueTexture, "rgba">;
type OpaquePrimitive = { id: string; source: { sha256: string }; material: GpuPageScene3dGltfPbrResourceInput["primitives"][number]["material"] & { textureResourceId: string }; vertices: readonly number[]; indices: readonly number[]; vertexCount: number; indexCount: number; vertexBufferSha256: string; vertexBufferByteLength: number; indexBufferSha256: string; indexBufferByteLength: number };
type OpaqueBinding = { primitiveId: string; primitiveFingerprint: string; textureResourceId: string; modelMatrix: readonly number[]; pbrUniformByteLength: 256 };

export function createGpuScene3dGltfPbrResourceInput(value: unknown): GpuPageScene3dGltfPbrResourceInput {
  const plan = value as OpaqueRenderPlan;
  if (!plan?.staticPlan || !plan.framePlan || !sealed(plan.staticPlan) || !sealed(plan.framePlan) || plan.framePlan.staticFingerprint !== plan.staticPlan.fingerprint || plan.framePlan.pbrAbi !== plan.staticPlan.pbr.abi || !hash(plan.staticPlan.source.sha256)) throw new Error("glTF PBR Browser route requires an exact Core static/frame plan pair.");
  if (canonicalJsonSha256(withoutFingerprint(plan.staticPlan)) !== plan.staticPlan.fingerprint || canonicalJsonSha256(withoutFingerprint(plan.framePlan)) !== plan.framePlan.fingerprint) throw new Error("glTF PBR Browser route received a stale Core plan fingerprint.");
  const bindings = new Map(plan.framePlan.primitiveBindings.map((binding) => [binding.primitiveId, binding]));
  if (bindings.size !== plan.staticPlan.primitives.length || [...bindings.values()].some((binding) => binding.pbrUniformByteLength !== 256 || !matrix(binding.modelMatrix))) throw new Error("glTF PBR Browser route frame model bindings are incomplete.");
  const metadataById = new Map(plan.staticPlan.textures.map((texture) => [texture.resourceId, texture]));
  if (metadataById.size !== plan.staticPlan.textures.length || plan.textures.length !== metadataById.size) throw new Error("glTF PBR Browser route texture metadata is incomplete.");
  const textures = plan.textures.map((texture) => {
    const metadata = metadataById.get(texture.resourceId);
    if (!metadata || !sameTexture(metadata, texture) || !identifier(texture.resourceId) || !localRef(texture.assetRef) || !hash(texture.encodedSha256) || !hash(texture.decodedRgbaSha256) || texture.rgba.byteLength !== texture.decodedRgbaByteLength || sha256(texture.rgba) !== texture.decodedRgbaSha256) throw new Error("glTF PBR Browser route texture snapshot identity changed before upload.");
    return Object.freeze({ resourceId: texture.resourceId, assetRef: texture.assetRef, encodedSha256: texture.encodedSha256, decodedRgbaSha256: texture.decodedRgbaSha256, width: texture.width, height: texture.height, decodedRgbaByteLength: texture.decodedRgbaByteLength, mipLevelCount: texture.mipLevelCount, mipmappedRgbaByteLength: texture.mipmappedRgbaByteLength, rgbaBase64: texture.rgba.toString("base64") });
  });
  const primitives = plan.staticPlan.primitives.map((primitive) => {
    const binding = bindings.get(primitive.id); if (!binding || primitive.source.sha256 !== plan.staticPlan.source.sha256 || !hash(primitive.vertexBufferSha256) || !hash(primitive.indexBufferSha256)) throw new Error("glTF PBR Browser route primitive identity changed before upload.");
    const vertexBytes = floatBytes(primitive.vertices), indexBytes = indexBytesFor(primitive.indices);
    if (vertexBytes.byteLength !== primitive.vertexBufferByteLength || indexBytes.byteLength !== primitive.indexBufferByteLength || sha256(vertexBytes) !== primitive.vertexBufferSha256 || sha256(indexBytes) !== primitive.indexBufferSha256 || primitive.vertexCount * 8 !== primitive.vertices.length || primitive.indexCount !== primitive.indices.length || primitive.material.textureResourceId !== binding.textureResourceId) throw new Error("glTF PBR Browser route geometry bytes do not reproduce the Core plan.");
    return Object.freeze({ id: primitive.id, sourceSha256: primitive.source.sha256, textureResourceId: binding.textureResourceId, vertexCount: primitive.vertexCount, indexCount: primitive.indexCount, vertexBufferSha256: primitive.vertexBufferSha256, vertexBufferByteLength: primitive.vertexBufferByteLength, indexBufferSha256: primitive.indexBufferSha256, indexBufferByteLength: primitive.indexBufferByteLength, verticesBase64: vertexBytes.toString("base64"), indicesBase64: indexBytes.toString("base64"), modelMatrix: Object.freeze([...binding.modelMatrix]), material: freezeJson({ ...primitive.material }) });
  });
  if (new Set(textures.map((texture) => texture.resourceId)).size !== textures.length || primitives.some((primitive) => !textures.some((texture) => texture.resourceId === primitive.textureResourceId))) throw new Error("glTF PBR Browser route texture bindings are incomplete.");
  const budget = plan.staticPlan.budget;
  const input = { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-resources@1" as const, staticFingerprint: plan.staticPlan.fingerprint, frameFingerprint: plan.framePlan.fingerprint, sourceSha256: plan.staticPlan.source.sha256, pbr: freezeJson({ ...plan.staticPlan.pbr }), pipeline: GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY, textures: Object.freeze(textures), primitives: Object.freeze(primitives), camera: freezeJson({ ...plan.framePlan.camera, viewport: { ...plan.framePlan.camera.viewport }, position: [...plan.framePlan.camera.position], target: [...plan.framePlan.camera.target], viewProjection: [...plan.framePlan.camera.viewProjection] }), budget: freezeJson({ vertexBufferBytes: budget.vertexBufferBytes, indexBufferBytes: budget.indexBufferBytes, uniformBufferBytes: budget.uniformBufferBytes, decodedTextureBytes: budget.decodedTextureBytes, mipmappedTextureBytes: budget.mipmappedTextureBytes, gpuResourceBytes: budget.gpuResourceBytes, renderTargetBytes: budget.renderTargetBytes, depthTargetBytes: budget.depthTargetBytes, readbackBufferBytes: budget.readbackBufferBytes, frameGpuResourceBytes: budget.frameGpuResourceBytes, peakGpuResourceBytes: budget.peakGpuResourceBytes }) };
  if (canonicalJsonSha256({ textures: plan.staticPlan.textures, budget: plan.staticPlan.budget }) !== plan.framePlan.resourceFingerprint) throw new Error("glTF PBR Browser route resource fingerprint does not match its Core plan.");
  return freezeJson(input) as unknown as GpuPageScene3dGltfPbrResourceInput;
}

export async function prepareGpuScene3dGltfPbrMaterialPage(page: GpuScene3dGltfPbrPage, plan: unknown, signal?: AbortSignal): Promise<{ ok: true; input: GpuPageScene3dGltfPbrResourceInput; metrics: GpuPageScene3dGltfPbrResourceMetrics } | { ok: false; failure: GpuRuntimeFailure; cleanup: GpuPageScene3dGltfPbrReleaseEvidence | null }> {
  if (signal?.aborted) return { ok: false, failure: cancelled(), cleanup: null };
  let input: GpuPageScene3dGltfPbrResourceInput;
  try { input = createGpuScene3dGltfPbrResourceInput(plan); } catch (error) { return { ok: false, failure: { code: "gpu_resource_refused", message: error instanceof Error ? error.message : "The glTF PBR Browser route refused its Core plan." }, cleanup: null }; }
  const installed = await page.evaluate(installWebGpuPageSessionScene3dGltfPbrPipeline, GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY) as { ok: boolean; failure?: GpuRuntimeFailure };
  if (!installed.ok) return { ok: false, failure: installed.failure ?? { code: "gpu_render_failed", message: "The fixed glTF PBR pipeline was not installed." }, cleanup: null };
  if (signal?.aborted) return { ok: false, failure: cancelled(), cleanup: await release(page, "cancelled") };
  const prepared = await page.evaluate(prepareWebGpuPageSessionScene3dGltfPbrResources, input) as { ok: boolean; metrics?: GpuPageScene3dGltfPbrResourceMetrics; failure?: GpuRuntimeFailure };
  if (!prepared.ok) return { ok: false, failure: prepared.failure ?? { code: "gpu_render_failed", message: "The fixed glTF PBR resource preparation failed." }, cleanup: await release(page, "terminal") };
  if (signal?.aborted) return { ok: false, failure: cancelled(), cleanup: await release(page, "cancelled") };
  return { ok: true, input, metrics: prepared.metrics! };
}

export async function releaseGpuScene3dGltfPbrMaterialPage(page: GpuScene3dGltfPbrPage, reason: "terminal" | "cancelled" = "terminal"): Promise<GpuPageScene3dGltfPbrReleaseEvidence | null> { return await release(page, reason); }

/** The only host-side draw entry: it sends no mutable geometry and terminal-releases on cancellation. */
export async function renderGpuScene3dGltfPbrMaterialPage(page: GpuScene3dGltfPbrPage, input: Pick<GpuPageScene3dGltfPbrResourceInput, "staticFingerprint" | "frameFingerprint">, signal?: AbortSignal): Promise<{ ok: true; metrics: GpuPageScene3dGltfPbrResourceMetrics } | { ok: false; failure: GpuRuntimeFailure; cleanup: GpuPageScene3dGltfPbrReleaseEvidence | null }> {
  if (signal?.aborted) return { ok: false, failure: cancelled(), cleanup: await release(page, "cancelled") };
  const frame = await page.evaluate(renderWebGpuPageSessionScene3dGltfPbrFrame, { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-frame@1", staticFingerprint: input.staticFingerprint, frameFingerprint: input.frameFingerprint }) as { ok: boolean; metrics?: GpuPageScene3dGltfPbrResourceMetrics; failure?: GpuRuntimeFailure };
  if (!frame.ok) return { ok: false, failure: frame.failure ?? { code: "gpu_render_failed", message: "The fixed glTF PBR material frame failed." }, cleanup: await release(page, "terminal") };
  if (signal?.aborted) return { ok: false, failure: cancelled(), cleanup: await release(page, "cancelled") };
  return { ok: true, metrics: frame.metrics! };
}

/** Reads one rendered PBR target; the caller must terminal-release the prepared page before success. */
export async function readGpuScene3dGltfPbrMaterialPage(page: GpuScene3dGltfPbrPage, input: Pick<GpuPageScene3dGltfPbrResourceInput, "staticFingerprint" | "frameFingerprint">, signal?: AbortSignal): Promise<{ ok: true; width: 1280; height: 720; bytesPerRow: number; paddedBase64: string; evidence: GpuPageScene3dGltfPbrReadbackEvidence } | { ok: false; failure: GpuRuntimeFailure; cleanup: GpuPageScene3dGltfPbrReleaseEvidence | null }> {
  if (signal?.aborted) return { ok: false, failure: cancelled(), cleanup: await release(page, "cancelled") };
  const readback = await page.evaluate(readWebGpuPageSessionScene3dGltfPbrFrame, { schema: GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA, staticFingerprint: input.staticFingerprint, frameFingerprint: input.frameFingerprint }) as { ok: boolean; width?: 1280; height?: 720; bytesPerRow?: number; paddedBase64?: string; evidence?: GpuPageScene3dGltfPbrReadbackEvidence; failure?: GpuRuntimeFailure };
  if (!readback.ok || readback.width !== 1280 || readback.height !== 720 || typeof readback.bytesPerRow !== "number" || typeof readback.paddedBase64 !== "string" || !readback.evidence) return { ok: false, failure: readback.failure ?? { code: "gpu_render_failed", message: "The fixed glTF PBR material frame did not return its bounded readback." }, cleanup: await release(page, "terminal") };
  if (signal?.aborted) return { ok: false, failure: cancelled(), cleanup: await release(page, "cancelled") };
  return { ok: true, width: readback.width, height: readback.height, bytesPerRow: readback.bytesPerRow, paddedBase64: readback.paddedBase64, evidence: readback.evidence };
}

async function release(page: GpuScene3dGltfPbrPage, reason: "terminal" | "cancelled"): Promise<GpuPageScene3dGltfPbrReleaseEvidence | null> { try { return await page.evaluate(releaseWebGpuPageSessionScene3dGltfPbrResources, reason) as GpuPageScene3dGltfPbrReleaseEvidence; } catch { return null; } }
function withoutFingerprint(value: { fingerprint: string }): Record<string, unknown> { const { fingerprint: _fingerprint, ...base } = value; return base; }
function sealed(value: { fingerprint: string }): boolean { return typeof value.fingerprint === "string" && hash(value.fingerprint); }
function floatBytes(values: readonly number[]): Buffer { if (!Array.isArray(values) || values.some((entry) => !Number.isFinite(entry))) throw new Error("glTF PBR Browser route vertices must be finite."); const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeFloatLE(value, index * 4)); return bytes; }
function indexBytesFor(values: readonly number[]): Buffer { if (!Array.isArray(values) || values.length % 3 !== 0 || values.some((entry) => !Number.isSafeInteger(entry) || entry < 0 || entry > 0xffffffff)) throw new Error("glTF PBR Browser route indices must be bounded triangles."); const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes; }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function sameTexture(left: OpaqueTextureMetadata, right: OpaqueTexture): boolean { return left.resourceId === right.resourceId && left.assetRef === right.assetRef && left.encodedSha256 === right.encodedSha256 && left.decodedRgbaSha256 === right.decodedRgbaSha256 && left.width === right.width && left.height === right.height && left.decodedRgbaByteLength === right.decodedRgbaByteLength && left.mipLevelCount === right.mipLevelCount && left.mipmappedRgbaByteLength === right.mipmappedRgbaByteLength; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function matrix(value: readonly number[]): boolean { return Array.isArray(value) && value.length === 16 && value.every((entry) => Number.isFinite(entry) && entry >= -10_000 && entry <= 10_000); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(value); }
function localRef(value: unknown): value is string { return typeof value === "string" && /^(?:[a-z0-9][a-z0-9._-]{0,127}\/){0,7}[a-z0-9][a-z0-9._-]{0,127}$/.test(value); }
function cancelled(): GpuRuntimeFailure { return { code: "gpu_cancelled", message: "Fixed glTF PBR material preparation was cancelled; the material-only page route was released." }; }
function freezeJson<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child); Object.freeze(value); } return value; }
