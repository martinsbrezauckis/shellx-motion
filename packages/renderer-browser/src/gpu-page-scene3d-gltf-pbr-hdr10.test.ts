import { createHash, webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { GPU_PAGE_PIPELINE_CATALOG } from "./gpu-page-pipeline-catalog";
import { GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG } from "./gpu-page-scene3d-gltf-pbr-contract";
import { GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_CATALOG, GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_PIPELINE_IDENTITY, GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_RESOURCE_CEILING } from "./gpu-page-scene3d-gltf-pbr-hdr10-contract";
import { renderWebGpuPageSessionScene3dGltfPbrHdr10Frame } from "./gpu-page-scene3d-gltf-pbr-hdr10-frame";
import { installWebGpuPageSessionScene3dGltfPbrHdr10Pipeline } from "./gpu-page-scene3d-gltf-pbr-hdr10-pipeline";
import { GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_READBACK_SCHEMA, readWebGpuPageSessionScene3dGltfPbrHdr10Frame } from "./gpu-page-scene3d-gltf-pbr-hdr10-readback";
import { releaseWebGpuPageSessionScene3dGltfPbrHdr10StreamingReadback, reserveWebGpuPageSessionScene3dGltfPbrHdr10StreamingReadback } from "./gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback";
import { prepareWebGpuPageSessionScene3dGltfPbrHdr10Resources, releaseWebGpuPageSessionScene3dGltfPbrHdr10Resources, type GpuPageScene3dGltfPbrHdr10ResourceInput } from "./gpu-page-scene3d-gltf-pbr-hdr10-resources";
import { createGpuScene3dGltfPbrHdr10ResourceInput, renderGpuScene3dGltfPbrHdr10Page } from "./gpu-scene3d-gltf-pbr-hdr10-session";

const HASH = "a".repeat(64);

describe("isolated HDR10 glTF PBR page/session", () => {
  it("keeps SDR/global catalogs pinned while giving HDR its own immutable catalog and ceiling", () => {
    expect(GPU_PAGE_PIPELINE_CATALOG.sha256).toBe("0c96fc421c065c6cafae7232d9c1b2a911e2994a118e9dda01126f0f7bf33d3a");
    expect(GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_CATALOG.sha256).not.toBe(GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256);
    expect(GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_RESOURCE_CEILING).toMatchObject({ targetFormat: "rgba16float", alpha: "opaque-no-blend", fixedViewport: { rgba16floatBytesPerRow: 10_240 }, readbackBytes: 7_372_800, maxReadbackChunkBytes: 65_536 });
    expect([renderGpuScene3dGltfPbrHdr10Page, readWebGpuPageSessionScene3dGltfPbrHdr10Frame].map(String).join("\n")).not.toMatch(/console\.(?:debug|error|info|log|warn)/);
  });

  it("installs the separate opaque Rec.2020-linear-nits rgba16float pipeline", async () => {
    const descriptors: unknown[] = [], device = { createShaderModule: vi.fn((value) => value), createRenderPipeline: vi.fn((value) => { descriptors.push(value); return { getBindGroupLayout: () => ({}) }; }) };
    const context = contextFor({ __shellxMotionGpuHdr10PbrSessionV1: { device } });
    const install = runInContext(`(${installWebGpuPageSessionScene3dGltfPbrHdr10Pipeline.toString()})`, context) as typeof installWebGpuPageSessionScene3dGltfPbrHdr10Pipeline;
    await expect(install(GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_PIPELINE_IDENTITY)).resolves.toEqual({ ok: true });
    expect(descriptors[0]).toMatchObject({ fragment: { targets: [{ format: "rgba16float" }] } });
    expect(JSON.stringify(descriptors[0])).not.toContain("blend");
    expect(device.createShaderModule.mock.calls[0]![0].code).toContain("toRec2020");
    expect(device.createShaderModule.mock.calls[0]![0].code).toContain("*203.0");
    expect(device.createShaderModule.mock.calls[0]![0].code).toContain("1000.0");
  });

  it("preflights opaque bytes and limits before allocation, then releases every resource", async () => {
    const createdTextures: { destroy: ReturnType<typeof vi.fn> }[] = [], createdBuffers: { destroy: ReturnType<typeof vi.fn> }[] = [];
    const device = {
      createTexture: vi.fn(() => { const texture = { createView: vi.fn((value) => ({ value })), destroy: vi.fn() }; createdTextures.push(texture); return texture; }),
      createBuffer: vi.fn(() => { const buffer = { destroy: vi.fn() }; createdBuffers.push(buffer); return buffer; }), createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({ beginRenderPass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }), finish: () => ({}) })),
      queue: { writeTexture: vi.fn(), writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(async () => undefined) },
    };
    const state = { device, limits: { maxTextureDimension2D: 4096, maxBufferSize: 8 * 1024 * 1024 }, hdr10PbrPipeline: { getBindGroupLayout: () => ({}) }, hdr10PbrMipPipeline: { getBindGroupLayout: () => ({}) }, hdr10PbrPipelineIdentity: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_PIPELINE_IDENTITY };
    const context = contextFor({ __shellxMotionGpuHdr10PbrSessionV1: state });
    const prepare = runInContext(`(${prepareWebGpuPageSessionScene3dGltfPbrHdr10Resources.toString()})`, context) as typeof prepareWebGpuPageSessionScene3dGltfPbrHdr10Resources;
    const release = runInContext(`(${releaseWebGpuPageSessionScene3dGltfPbrHdr10Resources.toString()})`, context) as typeof releaseWebGpuPageSessionScene3dGltfPbrHdr10Resources;
    const input = resourceInput(), transparent = { ...input, textures: [{ ...input.textures[0]!, rgbaBase64: Buffer.from([1, 2, 3, 0]).toString("base64"), decodedRgbaByteLength: 4, width: 1, height: 1, mipLevelCount: 1, mipmappedRgbaByteLength: 4, decodedRgbaSha256: hash(Buffer.from([1, 2, 3, 0])) }] };
    state.limits = { maxTextureDimension2D: 1, maxBufferSize: 8 * 1024 * 1024 };
    await expect(prepare(input)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(device.createSampler).not.toHaveBeenCalled(); expect(device.createTexture).not.toHaveBeenCalled(); expect(device.createBuffer).not.toHaveBeenCalled();
    state.limits = { maxTextureDimension2D: 4096, maxBufferSize: 7_372_799 };
    await expect(prepare(input)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(device.createSampler).not.toHaveBeenCalled(); expect(device.createTexture).not.toHaveBeenCalled(); expect(device.createBuffer).not.toHaveBeenCalled();
    state.limits = { maxTextureDimension2D: 4096, maxBufferSize: 8 * 1024 * 1024 };
    await expect(prepare(transparent)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(device.createTexture).not.toHaveBeenCalled(); expect(device.createBuffer).not.toHaveBeenCalled();
    await expect(prepare(input)).resolves.toMatchObject({ ok: true, metrics: { staticGpuBytes: 384, renderTargetBytes: 7_372_800, depthTargetBytes: 3_686_400, readbackBytes: 7_372_800, peakGpuBytes: 18_432_384, retainedFrameAllocations: 0 } });
    expect(device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ format: "rgba16float" }));
    expect(release("cancelled")).toMatchObject({ hadResources: true, reason: "cancelled", destroyedTextures: 1, destroyedVertexBuffers: 1, destroyedIndexBuffers: 1, destroyedUniformBuffers: 1, destroyedRenderTargets: 2, remainingGpuBytes: 0 });
    for (const resource of [...createdTextures, ...createdBuffers]) expect(resource.destroy).toHaveBeenCalledOnce();
  });

  it("renders only the prepared triple identity and readback processes aligned float bytes in bounded chunks", async () => {
    const unmap = vi.fn(), destroy = vi.fn(), chunkLengths: number[] = [], buffer = { mapAsync: vi.fn(async () => undefined), getMappedRange: () => new ArrayBuffer(7_372_800), unmap, destroy };
    const device = { createBuffer: vi.fn(() => buffer), createCommandEncoder: vi.fn(() => ({ copyTextureToBuffer: vi.fn(), finish: () => ({}) })), queue: { submit: vi.fn(), onSubmittedWorkDone: vi.fn(async () => undefined) } };
    const resources = { staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64), target: { createView: () => ({}) }, depth: { createView: () => ({}) }, primitives: [], renderedFrames: 0, metrics: { readbackBytes: 7_372_800, frameGpuBytes: 11_059_584, peakGpuBytes: 18_432_384 } };
    const context = contextFor({ btoa: (value: string) => { chunkLengths.push(value.length); return "x"; }, __shellxMotionGpuHdr10PbrSessionV1: { device, limits: { maxTextureDimension2D: 4096, maxBufferSize: 8 * 1024 * 1024 }, hdr10PbrPipeline: {}, resources } });
    const read = runInContext(`(${readWebGpuPageSessionScene3dGltfPbrHdr10Frame.toString()})`, context) as typeof readWebGpuPageSessionScene3dGltfPbrHdr10Frame;
    const render = runInContext(`(${renderWebGpuPageSessionScene3dGltfPbrHdr10Frame.toString()})`, context) as typeof renderWebGpuPageSessionScene3dGltfPbrHdr10Frame;
    await expect(render({ schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-frame@1", staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64) })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
    await expect(read({ schema: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_READBACK_SCHEMA, staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64) })).resolves.toMatchObject({ ok: true, width: 1280, height: 720, bytesPerRow: 10_240, evidence: { processingChunkBytes: 65_535, mappedBufferUnmapped: true, mappedBufferDestroyed: true } });
    expect(chunkLengths.every((length) => length <= 65_535)).toBe(true); expect(unmap).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
  });

  it("refuses a readback limit before it can allocate a mapped buffer", async () => {
    const device = { createBuffer: vi.fn(), createCommandEncoder: vi.fn(), queue: { submit: vi.fn() } }, resources = { staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64), target: {}, metrics: { readbackBytes: 7_372_800, frameGpuBytes: 11_059_584, peakGpuBytes: 18_432_384 } };
    const context = contextFor({ __shellxMotionGpuHdr10PbrSessionV1: { device, limits: { maxTextureDimension2D: 4096, maxBufferSize: 7_372_799 }, resources } });
    const read = runInContext(`(${readWebGpuPageSessionScene3dGltfPbrHdr10Frame.toString()})`, context) as typeof readWebGpuPageSessionScene3dGltfPbrHdr10Frame;
    await expect(read({ schema: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_READBACK_SCHEMA, staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64) })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded" } });
    expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it("reserves exactly one persistent HDR float readback and releases it terminally", () => {
    const global = globalThis as Record<string, unknown>, previousState = global.__shellxMotionGpuHdr10PbrSessionV1, previousUsage = global.GPUBufferUsage, createBuffer = vi.fn(() => ({ destroy: vi.fn() }));
    try {
      global.GPUBufferUsage = { COPY_DST: 1, MAP_READ: 2 };
      global.__shellxMotionGpuHdr10PbrSessionV1 = { device: { createBuffer }, limits: { maxBufferSize: 7_372_800 }, resources: { staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64), metrics: { readbackBytes: 7_372_800, frameGpuBytes: 11_059_584, peakGpuBytes: 18_432_384 } } };
      const input = { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback@1" as const, staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64) };
      expect(reserveWebGpuPageSessionScene3dGltfPbrHdr10StreamingReadback(input)).toEqual({ ok: true }); expect(reserveWebGpuPageSessionScene3dGltfPbrHdr10StreamingReadback(input)).toEqual({ ok: true }); expect(createBuffer).toHaveBeenCalledTimes(1);
      expect(releaseWebGpuPageSessionScene3dGltfPbrHdr10StreamingReadback()).toMatchObject({ hadReservedBuffer: true, destroyedReservedBuffer: true, remainingReadbackBufferBytes: 0, mapOperations: 0 });
    } finally { global.__shellxMotionGpuHdr10PbrSessionV1 = previousState; global.GPUBufferUsage = previousUsage; }
  });

  it("cross-binds the authenticated Core HDR static plan to the SDR material plan before opening a page", async () => {
    const route = coreRoute();
    expect(createGpuScene3dGltfPbrHdr10ResourceInput(route)).toMatchObject({ staticFingerprint: route.hdrRoute.staticPlan.fingerprint, sdrStaticFingerprint: route.sdrRoute.renderPlan.staticPlan.fingerprint, frameFingerprint: route.sdrRoute.renderPlan.framePlan.fingerprint, budget: { readbackBytes: 7_372_800, peakGpuBytes: 18_432_384 } });
    const page = { evaluate: vi.fn() };
    await expect(renderGpuScene3dGltfPbrHdr10Page(page, {})).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" }, release: null, close: null });
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("records terminal resource release and real page-close evidence before a successful HDR readback returns", async () => {
    const page = successfulHdr10Page();
    await expect(renderGpuScene3dGltfPbrHdr10Page(page, coreRoute())).resolves.toMatchObject({ ok: true, release: { remainingGpuBytes: 0 }, close: { deviceDestroyed: true, forcedResourceRelease: false } });
    expect(page.evaluate).toHaveBeenCalledTimes(7);
  });

  it("rejects forged page readback bytes or partial evidence before success", async () => {
    const page = successfulHdr10Page({ readback: { ok: true, width: 1280, height: 720, bytesPerRow: 10240, paddedBase64: "raw", evidence: { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-readback-evidence@1" } } });
    await expect(renderGpuScene3dGltfPbrHdr10Page(page, coreRoute())).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed" }, release: { reason: "terminal", remainingGpuBytes: 0 }, close: { deviceDestroyed: true } });
    expect(page.evaluate).toHaveBeenCalledTimes(7);
  });

  it("rejects a nonterminal page close even after exact release", async () => {
    const page = successfulHdr10Page({ close: { deviceDestroyed: false, forcedResourceRelease: false } });
    await expect(renderGpuScene3dGltfPbrHdr10Page(page, coreRoute())).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed" }, release: { reason: "terminal", remainingGpuBytes: 0 }, close: { deviceDestroyed: false } });
  });
});

function resourceInput(): GpuPageScene3dGltfPbrHdr10ResourceInput {
  const rgba = Buffer.from([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]), vertices = Buffer.alloc(96), indices = Buffer.alloc(12); indices.writeUInt32LE(1, 4); indices.writeUInt32LE(2, 8);
  return { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-resources@1", staticFingerprint: HASH, sdrStaticFingerprint: "b".repeat(64), frameFingerprint: "c".repeat(64), sourceSha256: HASH, pbr: { abi: "shellx-motion/browser-scene3d-gltf-pbr-sdr@1", baseColorTextureFormat: "rgba8unorm-srgb", baseColorTextureTransfer: "srgb-to-linear-hardware", factorSpace: "linear-gltf", brdf: "ggx-smith-schlick-directional@1", ambient: "bounded-diffuse@1", directionalLight: { direction: [-0.4, -0.8, -0.4], color: [1, 1, 1], intensity: 1, ambientDiffuse: 0.15 }, outputTransfer: "linear-to-srgb-explicit" }, pipeline: GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_PIPELINE_IDENTITY, textures: [{ resourceId: "texture-a", assetRef: "assets/pbr/a.png", encodedSha256: HASH, decodedRgbaSha256: hash(rgba), width: 2, height: 2, decodedRgbaByteLength: 16, mipLevelCount: 2, mipmappedRgbaByteLength: 20, rgbaBase64: rgba.toString("base64") }], primitives: [{ id: "mesh-a", sourceSha256: HASH, textureResourceId: "texture-a", vertexCount: 3, indexCount: 3, vertexBufferSha256: hash(vertices), vertexBufferByteLength: 96, indexBufferSha256: hash(indices), indexBufferByteLength: 12, verticesBase64: vertices.toString("base64"), indicesBase64: indices.toString("base64"), modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1, emissiveFactor: [0, 0, 0] } }], camera: { viewport: { width: 1280, height: 720 }, projection: "perspective@1", fovDeg: 42, near: 0.1, far: 100, position: [2, 2, 4], target: [0, 0, 0], viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, budget: { staticGpuBytes: 384, renderTargetBytes: 7_372_800, depthTargetBytes: 3_686_400, readbackBytes: 7_372_800, frameGpuBytes: 11_059_584, peakGpuBytes: 18_432_384 } };
}
function contextFor(extra: Record<string, unknown>) { return createContext({ Array, ArrayBuffer, Float32Array, Math, Number, Object, Promise, Set, Map, String, Uint8Array, Uint32Array, crypto: webcrypto, atob: (value: string) => Buffer.from(value, "base64").toString("latin1"), GPUBufferUsage: { COPY_DST: 1, VERTEX: 2, INDEX: 4, UNIFORM: 8, MAP_READ: 16 }, GPUTextureUsage: { COPY_DST: 1, COPY_SRC: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 8 }, GPUMapMode: { READ: 1 }, ...extra }); }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function successfulHdr10Page(options: { readback?: unknown; close?: unknown } = {}) {
  const input = createGpuScene3dGltfPbrHdr10ResourceInput(coreRoute()), raw = Buffer.alloc(7_372_800), metrics = (renderedFrames: 0 | 1) => ({ schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-resource-metrics@1", staticFingerprint: input.staticFingerprint, textureSlots: input.textures.length, primitiveSlots: input.primitives.length, staticGpuBytes: input.budget.staticGpuBytes, renderTargetBytes: input.budget.renderTargetBytes, depthTargetBytes: input.budget.depthTargetBytes, readbackBytes: input.budget.readbackBytes, frameGpuBytes: input.budget.frameGpuBytes, peakGpuBytes: input.budget.peakGpuBytes, mipGenerationPasses: input.textures.reduce((sum, texture) => sum + texture.mipLevelCount - 1, 0), preparationOperations: 1, renderedFrames, retainedFrameAllocations: 0 }), release = { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-release@1", reason: "terminal", hadResources: true, destroyedTextures: 1, destroyedVertexBuffers: 1, destroyedIndexBuffers: 1, destroyedUniformBuffers: 1, destroyedRenderTargets: 2, releasedGpuBytes: input.budget.frameGpuBytes, remainingGpuBytes: 0 }, readback = options.readback ?? { ok: true, width: 1280, height: 720, bytesPerRow: 10240, paddedBase64: raw.toString("base64"), evidence: { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-readback-evidence@1", staticFingerprint: input.staticFingerprint, sdrStaticFingerprint: input.sdrStaticFingerprint, frameFingerprint: input.frameFingerprint, bytesPerRow: 10240, mappedByteLength: 7_372_800, transientReadbackBufferBytes: 7_372_800, processingChunkBytes: 65_535, rawRgba16floatSha256: hash(raw), frameGpuBytes: input.budget.frameGpuBytes, peakGpuBytes: input.budget.peakGpuBytes, mapOperations: 1, mappedBufferUnmapped: true, mappedBufferDestroyed: true } }, close = options.close ?? { deviceDestroyed: true, forcedResourceRelease: false };
  return { evaluate: vi.fn(async (callback: { name?: string }) => { const name = callback.name ?? ""; if (name.includes("open") || name.includes("install")) return { ok: true }; if (name.includes("prepare")) return { ok: true, metrics: metrics(0) }; if (name.includes("render")) return { ok: true, metrics: metrics(1) }; if (name.includes("read")) return readback; if (name.includes("release")) return release; return close; }) };
}

function coreRoute() {
  const hdr = resourceInput(), texture = hdr.textures[0]!, primitive = hdr.primitives[0]!, rgba = Buffer.from(texture.rgbaBase64, "base64"), vertices = Buffer.from(primitive.verticesBase64, "base64"), indices = Buffer.from(primitive.indicesBase64, "base64");
  const sdrBudget = { vertexBufferBytes: 96, indexBufferBytes: 12, uniformBufferBytes: 256, decodedTextureBytes: 16, mipmappedTextureBytes: 20, gpuResourceBytes: 384, renderTargetBytes: 3_686_400, depthTargetBytes: 3_686_400, readbackBufferBytes: 3_686_400, frameGpuResourceBytes: 7_373_184, peakGpuResourceBytes: 11_059_584 };
  const staticBase = { schema: "shellx-motion/scene3d-gltf-material-render-static@1" as const, source: { sha256: HASH }, pbr: hdr.pbr, textures: [{ resourceId: texture.resourceId, assetRef: texture.assetRef, encodedSha256: texture.encodedSha256, decodedRgbaSha256: texture.decodedRgbaSha256, width: texture.width, height: texture.height, decodedRgbaByteLength: texture.decodedRgbaByteLength, mipLevelCount: texture.mipLevelCount, mipmappedRgbaByteLength: texture.mipmappedRgbaByteLength }], primitives: [{ id: primitive.id, source: { sha256: HASH }, material: { ...primitive.material, textureResourceId: primitive.textureResourceId }, vertices: Array.from(new Float32Array(vertices.buffer, vertices.byteOffset, 24)), indices: Array.from(new Uint32Array(indices.buffer, indices.byteOffset, 3)), vertexCount: 3, indexCount: 3, vertexBufferSha256: primitive.vertexBufferSha256, vertexBufferByteLength: 96, indexBufferSha256: primitive.indexBufferSha256, indexBufferByteLength: 12 }], budget: sdrBudget };
  const staticPlan = { ...staticBase, fingerprint: canonicalJsonSha256(staticBase) }, frameBase = { schema: "shellx-motion/scene3d-gltf-material-render-frame@1" as const, staticFingerprint: staticPlan.fingerprint, pbrAbi: hdr.pbr.abi, camera: hdr.camera, primitiveBindings: [{ primitiveId: primitive.id, primitiveFingerprint: HASH, textureResourceId: primitive.textureResourceId, modelMatrix: primitive.modelMatrix, pbrUniformByteLength: 256 as const }], resourceFingerprint: canonicalJsonSha256({ textures: staticPlan.textures, budget: staticPlan.budget }) }, framePlan = { ...frameBase, fingerprint: canonicalJsonSha256(frameBase) };
  const sdrRoute = { schema: "shellx-motion/scene3d-gltf-pbr-final-route@1", packageId: "pkg_hdr", sceneStateSha256: "d".repeat(64), rendererCatalogSha256: GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256, fingerprint: "e".repeat(64), renderPlan: { staticPlan, framePlan, textures: [{ ...staticPlan.textures[0]!, rgba }] } };
  const hdrStatic = { schema: "shellx-motion/scene3d-gltf-pbr-hdr10-static@1", fingerprint: "f".repeat(64), admissionFingerprint: "7f2ace036507ca86cbb8eb58f5f3894eac37fa69bbe0700e6810210f5d28ca27", source: { format: "gltf", sha256: HASH }, inheritedSdr: { routeFingerprint: sdrRoute.fingerprint, staticPlanFingerprint: staticPlan.fingerprint, framePlanFingerprint: framePlan.fingerprint, sceneStateSha256: sdrRoute.sceneStateSha256, rendererCatalogSha256: GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256 }, resourceFacts: { staticGpuBytes: 384, rgba16floatTargetBytes: 7_372_800, depthTargetBytes: 3_686_400, rgba16floatReadbackBytes: 7_372_800, frameGpuBytes: 11_059_584, peakGpuBytes: 18_432_384 } };
  return { sdrRoute, hdrRoute: { schema: "shellx-motion/scene3d-gltf-pbr-hdr10-final-route@1", packageId: "pkg_hdr", staticPlan: hdrStatic, inputHashes: { "scene3d-gltf-pbr-hdr10-catalog": GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_CATALOG.sha256, "scene3d-gltf-pbr-hdr10-sdr-catalog": GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256 } } } as unknown as { hdrRoute: { staticPlan: { fingerprint: string } }; sdrRoute: { renderPlan: { staticPlan: { fingerprint: string }; framePlan: { fingerprint: string } } } };
}
