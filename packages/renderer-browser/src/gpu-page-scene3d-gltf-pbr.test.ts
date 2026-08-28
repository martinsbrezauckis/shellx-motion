import { createHash, webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import {
  GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY,
  GPU_PAGE_SCENE3D_GLTF_PBR_RESOURCE_CEILING,
} from "./gpu-page-scene3d-gltf-pbr-contract";
import { installWebGpuPageSessionScene3dGltfPbrPipeline } from "./gpu-page-scene3d-gltf-pbr-pipeline";
import { renderWebGpuPageSessionScene3dGltfPbrFrame } from "./gpu-page-scene3d-gltf-pbr-frame";
import { GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA, readWebGpuPageSessionScene3dGltfPbrFrame } from "./gpu-page-scene3d-gltf-pbr-readback";
import { readWebGpuPageSessionScene3dGltfPbrStreamingFrame, releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback, reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback } from "./gpu-page-scene3d-gltf-pbr-streaming-readback";
import { closeWebGpuPageSessionScene3dGltfPbr, openWebGpuPageSessionScene3dGltfPbr } from "./gpu-page-scene3d-gltf-pbr-session";
import { createGpuScene3dGltfPbrResourceInput, prepareGpuScene3dGltfPbrMaterialPage, releaseGpuScene3dGltfPbrMaterialPage, renderGpuScene3dGltfPbrMaterialPage } from "./gpu-scene3d-gltf-pbr-material-route";
import {
  prepareWebGpuPageSessionScene3dGltfPbrResources,
  readWebGpuPageSessionScene3dGltfPbrResourceMetrics,
  releaseWebGpuPageSessionScene3dGltfPbrResources,
  type GpuPageScene3dGltfPbrResourceInput,
} from "./gpu-page-scene3d-gltf-pbr-resources";

const HASH = "a".repeat(64);

describe("isolated fixed SDR glTF PBR Browser page path", () => {
  it("creates a 32-byte PBR vertex pipeline, sRGB mip pipeline, and independent catalog identity", async () => {
    const renderDescriptors: unknown[] = [], shaderCodes: string[] = [];
    const context = createContext({
      Promise, Object,
      __shellxMotionGpuSessionV1: {
        device: {
          createShaderModule: vi.fn(({ code }: { code: string }) => { shaderCodes.push(code); return {}; }),
          createRenderPipeline: vi.fn((descriptor: unknown) => { renderDescriptors.push(descriptor); return { getBindGroupLayout: () => ({}) }; }),
        },
      },
    });
    const install = runInContext(`(${installWebGpuPageSessionScene3dGltfPbrPipeline.toString()})`, context) as typeof installWebGpuPageSessionScene3dGltfPbrPipeline;
    await expect(install(GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY)).resolves.toEqual({ ok: true });
    expect(renderDescriptors).toHaveLength(2);
    expect(renderDescriptors[0]).toMatchObject({ vertex: { buffers: [{ arrayStride: 32, attributes: [{ format: "float32x3" }, { format: "float32x3" }, { format: "float32x2" }] }] }, fragment: { targets: [{ format: "rgba8unorm" }] } });
    expect(renderDescriptors[1]).toMatchObject({ fragment: { targets: [{ format: "rgba8unorm-srgb" }] } });
    expect(renderDescriptors[0]).not.toMatchObject({ fragment: { targets: [{ blend: expect.anything() }] } });
    expect(shaderCodes[0]).toContain("linearToSrgb(linear),vec3<f32>(0.0),vec3<f32>(1.0)), 1.0");
    expect(shaderCodes[0]).not.toContain("texel.a");
    expect(GPU_PAGE_SCENE3D_GLTF_PBR_RESOURCE_CEILING).toMatchObject({
      pbrAbi: "shellx-motion/browser-scene3d-gltf-pbr-sdr@1", outputTransfer: "linear-to-srgb-explicit",
      containedPbrImport: {
        schema: "shellx-motion/scene3d-gltf-pbr-direct-final-admission@1", frameLane: "gpu", delivery: "ffmpeg-direct-final",
        viewport: { width: 1280, height: 720 }, scene: "static-immutable-canonical-source-projection",
        material: "contained-png-srgb-TEXCOORD_0-linear-pbr-factors",
        limits: { maxPrimitives: 16, maxTextures: 16, maxEncodedTextureBytesEach: 4 * 1024 * 1024, maxEncodedTextureBytesTotal: 8 * 1024 * 1024, maxDecodedTextureBytesEach: 16 * 1024 * 1024, maxDecodedTextureBytesTotal: 32 * 1024 * 1024, maxGpuResourceBytes: 48 * 1024 * 1024, maxReadbackBytes: 4 * 1024 * 1024 },
        refusals: ["browser-preview", "native-preview", "segmented-or-resume-final", "jpeg", "external-uri", "sampler", "extensions", "compression", "skins", "animations", "morph-targets", "sparse-accessors", "matrix-transforms", "nonuniform-scale"],
      },
    });
    await expect(install({ ...GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY, pipelineImplementationSha256: "b".repeat(64) })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
  });

  it("opens and closes only the isolated PBR page state without constructing legacy page pipelines", async () => {
    const destroy = vi.fn(), createRenderPipeline = vi.fn();
    const device = { destroy, limits: { maxTextureDimension2D: 4_096, maxBufferSize: 16 * 1024 * 1024, maxStorageBufferBindingSize: 16 * 1024 * 1024 }, lost: new Promise(() => undefined), createRenderPipeline };
    const adapter = { info: { vendor: "nvidia", device: "rtx", architecture: null, description: null }, requestDevice: async () => device };
    const context = createContext({ Promise, Object, Number, navigator: { gpu: { requestAdapter: vi.fn(async () => adapter) } }, isSecureContext: true });
    const open = runInContext(`(${openWebGpuPageSessionScene3dGltfPbr.toString()})`, context) as typeof openWebGpuPageSessionScene3dGltfPbr;
    const close = runInContext(`(${closeWebGpuPageSessionScene3dGltfPbr.toString()})`, context) as typeof closeWebGpuPageSessionScene3dGltfPbr;
    await expect(open({ powerPreference: "high-performance" })).resolves.toMatchObject({ ok: true, runtime: { limits: device.limits } });
    expect(runInContext("Object.keys(globalThis.__shellxMotionGpuSessionV1).sort()", context)).toEqual(["device", "limits", "lost"]);
    expect(createRenderPipeline).not.toHaveBeenCalled(); expect(close()).toEqual({ deviceDestroyed: true, forcedResourceRelease: false }); expect(destroy).toHaveBeenCalledOnce();
  });

  it("prepares one immutable decoded PNG snapshot, generates every mip once, and records actual terminal destruction", async () => {
    const createdTextures: Array<{ destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }> = [], createdBuffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [], passes: unknown[] = [];
    const device = {
      createTexture: vi.fn(() => { const texture = { destroy: vi.fn(), createView: vi.fn((view?: unknown) => ({ texture: createdTextures.length, view })) }; createdTextures.push(texture); return texture; }),
      createBuffer: vi.fn(() => { const buffer = { destroy: vi.fn() }; createdBuffers.push(buffer); return buffer; }),
      createSampler: vi.fn(() => ({ sampler: true })),
      createBindGroup: vi.fn((value: unknown) => value),
      createCommandEncoder: vi.fn(() => ({ beginRenderPass: (value: unknown) => { passes.push(value); return { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn() }; }, finish: () => ({}) })),
      queue: { writeTexture: vi.fn(), writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(async () => undefined) },
    };
    const state = { device, limits: { maxTextureDimension2D: 4_096, maxBufferSize: 4 * 1024 * 1024 }, gltfPbrPipeline: { getBindGroupLayout: () => ({ pbr: true }) }, gltfPbrMipPipeline: { getBindGroupLayout: () => ({ mip: true }) }, gltfPbrPipelineIdentity: GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY };
    const context = createContext({ ArrayBuffer, Uint8Array, Uint32Array, Float32Array, Math, Number, Object, Map, Set, Promise, Array, crypto: webcrypto, atob: (value: string) => Buffer.from(value, "base64").toString("latin1"), GPUBufferUsage: { COPY_DST: 1, VERTEX: 2, INDEX: 4, UNIFORM: 8 }, GPUTextureUsage: { COPY_DST: 1, COPY_SRC: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 8 }, __shellxMotionGpuSessionV1: state });
    const prepare = runInContext(`(${prepareWebGpuPageSessionScene3dGltfPbrResources.toString()})`, context) as typeof prepareWebGpuPageSessionScene3dGltfPbrResources;
    const metrics = runInContext(`(${readWebGpuPageSessionScene3dGltfPbrResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionScene3dGltfPbrResourceMetrics;
    const release = runInContext(`(${releaseWebGpuPageSessionScene3dGltfPbrResources.toString()})`, context) as typeof releaseWebGpuPageSessionScene3dGltfPbrResources;
    const render = runInContext(`(${renderWebGpuPageSessionScene3dGltfPbrFrame.toString()})`, context) as typeof renderWebGpuPageSessionScene3dGltfPbrFrame;
    const input = resourceInput();
    const first = await prepare(input);
    expect(first).toMatchObject({ ok: true, metrics: { textureSlots: 1, textureBytes: 20, vertexBufferSlots: 1, vertexBufferBytes: 96, indexBufferBytes: 12, uniformBufferBytes: 256, bindGroupSlots: 1, renderTargetSlots: 1, depthTargetSlots: 1, mipGenerationPasses: 1, retainedFrameAllocations: 0, gpuResourceBytes: 7_373_184 } });
    expect(device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ format: "rgba8unorm-srgb", mipLevelCount: 2 }));
    expect(device.createTexture).toHaveBeenNthCalledWith(2, expect.objectContaining({ format: "rgba8unorm", usage: 10 }));
    const uniform = new Float32Array(device.queue.writeBuffer.mock.calls[2]![2] as ArrayBuffer);
    expect(uniform[35]).toBe(1); expect([...uniform.slice(52, 55)]).toEqual([2, 2, 4]);
    expect(passes).toEqual([expect.objectContaining({ colorAttachments: [expect.objectContaining({ view: expect.objectContaining({ view: { baseMipLevel: 1, mipLevelCount: 1 } }) })] })]);
    const allocated = { textures: device.createTexture.mock.calls.length, buffers: device.createBuffer.mock.calls.length, submits: device.queue.submit.mock.calls.length };
    await expect(prepare(input)).resolves.toEqual(first);
    expect({ textures: device.createTexture.mock.calls.length, buffers: device.createBuffer.mock.calls.length, submits: device.queue.submit.mock.calls.length }).toEqual(allocated);
    expect(runInContext("Object.keys(globalThis.__shellxMotionGpuSessionV1.gltfPbrResources).sort()", context)).toEqual(["depth", "frameFingerprint", "metrics", "primitives", "renderedFrames", "staticFingerprint", "target", "textures"]);
    await expect(prepare({ ...input, staticFingerprint: "b".repeat(64) })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    await expect(render({ schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-frame@1", staticFingerprint: HASH, frameFingerprint: HASH })).resolves.toMatchObject({ ok: true, drawCount: 1, metrics: { renderedFrames: 1, retainedFrameAllocations: 0 } });
    expect(metrics()).toMatchObject({ retainedFrameAllocations: 0, preparationOperations: 1, renderedFrames: 1 });
    expect(release("cancelled")).toEqual({ schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-release@1", reason: "cancelled", hadResources: true, destroyedTextures: 1, destroyedVertexBuffers: 1, destroyedIndexBuffers: 1, destroyedUniformBuffers: 1, destroyedRenderTargets: 2, releasedGpuResourceBytes: 7_373_184, remainingGpuResourceBytes: 0 });
    for (const texture of createdTextures) expect(texture.destroy).toHaveBeenCalledOnce();
    for (const buffer of createdBuffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(metrics()).toBeNull();
  });

  it("refuses malformed/stale bytes, non-finite vertices, invalid indices, unknown keys, and device overflow before any GPU allocation", async () => {
    const device = { createTexture: vi.fn(), createBuffer: vi.fn(), createSampler: vi.fn(), createBindGroup: vi.fn(), createCommandEncoder: vi.fn(), queue: { writeTexture: vi.fn(), writeBuffer: vi.fn(), submit: vi.fn() } };
    const state = { device, limits: { maxTextureDimension2D: 4_096, maxBufferSize: 1_048_576 }, gltfPbrPipeline: { getBindGroupLayout: () => ({}) }, gltfPbrMipPipeline: { getBindGroupLayout: () => ({}) }, gltfPbrPipelineIdentity: GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY };
    const context = createContext({ ArrayBuffer, Uint8Array, Uint32Array, Float32Array, Math, Number, Object, Map, Set, Promise, Array, crypto: webcrypto, atob, GPUBufferUsage: { COPY_DST: 1, VERTEX: 2, INDEX: 4, UNIFORM: 8 }, GPUTextureUsage: { COPY_DST: 1, COPY_SRC: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 8 }, __shellxMotionGpuSessionV1: state });
    const prepare = runInContext(`(${prepareWebGpuPageSessionScene3dGltfPbrResources.toString()})`, context) as typeof prepareWebGpuPageSessionScene3dGltfPbrResources;
    const valid = resourceInput(); const malformed = { ...valid, textures: [{ ...valid.textures[0]!, rgbaBase64: "x" }] };
    const stale = { ...valid, textures: [{ ...valid.textures[0]!, decodedRgbaSha256: HASH }] };
    const nanVertices = Buffer.from(valid.primitives[0]!.verticesBase64, "base64"); nanVertices.writeFloatLE(Number.NaN, 0);
    const nan = { ...valid, primitives: [{ ...valid.primitives[0]!, verticesBase64: nanVertices.toString("base64"), vertexBufferSha256: sha256(nanVertices) }] };
    const badIndices = Buffer.from(valid.primitives[0]!.indicesBase64, "base64"); badIndices.writeUInt32LE(3, 0);
    const outOfRange = { ...valid, primitives: [{ ...valid.primitives[0]!, indicesBase64: badIndices.toString("base64"), indexBufferSha256: sha256(badIndices) }] };
    const unknown = { ...valid, primitives: [{ ...valid.primitives[0]!, unexpected: true }] };
    const translucentFactor = { ...valid, primitives: [{ ...valid.primitives[0]!, material: { ...valid.primitives[0]!.material, baseColorFactor: [1, 1, 1, 0.5] as const } }] };
    const dimension = { ...valid, textures: [{ ...valid.textures[0]!, width: 4_097, decodedRgbaByteLength: 4_097 * 2 * 4, mipLevelCount: 13, mipmappedRgbaByteLength: 43_700, rgbaBase64: valid.textures[0]!.rgbaBase64 }] };
    await expect(prepare(malformed)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded" } });
    for (const hostile of [stale, nan, outOfRange, unknown, translucentFactor, dimension]) await expect(prepare(hostile)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded" } });
    expect(device.createTexture).not.toHaveBeenCalled(); expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it("preflights the fixed aligned PBR readback, maps once, and destroys the transient buffer before returning pixels", async () => {
    const unmap = vi.fn(), destroy = vi.fn(), copyTextureToBuffer = vi.fn(), submit = vi.fn();
    const buffer = { mapAsync: vi.fn(async () => undefined), getMappedRange: () => new ArrayBuffer(3_686_400), unmap, destroy };
    const device = { createBuffer: vi.fn(() => buffer), createCommandEncoder: vi.fn(() => ({ copyTextureToBuffer, finish: () => ({}) })), queue: { submit, onSubmittedWorkDone: vi.fn(async () => undefined) } };
    const state = { device, limits: { maxTextureDimension2D: 4_096, maxBufferSize: 4 * 1024 * 1024 }, gltfPbrResources: { staticFingerprint: HASH, frameFingerprint: HASH, target: { target: true }, metrics: { gpuResourceBytes: 7_373_184, readbackBufferBytes: 3_686_400, peakGpuResourceBytes: 11_059_584 } } };
    const context = createContext({ ArrayBuffer, Uint8Array, Object, String, Promise, GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 }, GPUMapMode: { READ: 1 }, btoa: (value: string) => Buffer.from(value, "latin1").toString("base64"), __shellxMotionGpuSessionV1: state });
    const read = runInContext(`(${readWebGpuPageSessionScene3dGltfPbrFrame.toString()})`, context) as typeof readWebGpuPageSessionScene3dGltfPbrFrame;
    await expect(read({ schema: GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA, staticFingerprint: HASH, frameFingerprint: HASH })).resolves.toMatchObject({ ok: true, width: 1280, height: 720, bytesPerRow: 5120, evidence: { mappedByteLength: 3_686_400, transientReadbackBufferBytes: 3_686_400, peakGpuResourceBytes: 11_059_584, mappedBufferUnmapped: true, mappedBufferDestroyed: true } });
    expect(device.createBuffer).toHaveBeenCalledWith({ size: 3_686_400, usage: 3 }); expect(copyTextureToBuffer).toHaveBeenCalledWith({ texture: state.gltfPbrResources.target }, { buffer, bytesPerRow: 5120, rowsPerImage: 720 }, { width: 1280, height: 720, depthOrArrayLayers: 1 }); expect(submit).toHaveBeenCalledOnce(); expect(unmap).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
  });

  it("refuses a readback budget or identity mismatch before it can allocate a mapped buffer", async () => {
    const device = { createBuffer: vi.fn(), createCommandEncoder: vi.fn(), queue: { submit: vi.fn() } };
    const state = { device, limits: { maxTextureDimension2D: 4_096, maxBufferSize: 3_686_399 }, gltfPbrResources: { staticFingerprint: HASH, frameFingerprint: HASH, target: {}, metrics: { gpuResourceBytes: 7_373_184, readbackBufferBytes: 3_686_400, peakGpuResourceBytes: 11_059_584 } } };
    const context = createContext({ Object, Promise, GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 }, GPUMapMode: { READ: 1 }, __shellxMotionGpuSessionV1: state });
    const read = runInContext(`(${readWebGpuPageSessionScene3dGltfPbrFrame.toString()})`, context) as typeof readWebGpuPageSessionScene3dGltfPbrFrame;
    await expect(read({ schema: GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA, staticFingerprint: HASH, frameFingerprint: HASH })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded" } });
    await expect(read({ schema: GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA, staticFingerprint: "b".repeat(64), frameFingerprint: HASH })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(device.createBuffer).not.toHaveBeenCalled();
  });

  it("reserves one PBR streaming readback buffer before frames and reuses then terminally destroys it", async () => {
    const unmap = vi.fn(), destroy = vi.fn(), mapAsync = vi.fn(async () => undefined), copyTextureToBuffer = vi.fn();
    const buffer = { mapAsync, getMappedRange: () => new ArrayBuffer(3_686_400), unmap, destroy };
    const device = { createBuffer: vi.fn(() => buffer), createCommandEncoder: vi.fn(() => ({ copyTextureToBuffer, finish: () => ({}) })), queue: { submit: vi.fn(), onSubmittedWorkDone: vi.fn(async () => undefined) } };
    const state = { device, limits: { maxBufferSize: 4 * 1024 * 1024 }, gltfPbrResources: { staticFingerprint: HASH, frameFingerprint: HASH, target: {}, metrics: { gpuResourceBytes: 7_373_184, readbackBufferBytes: 3_686_400, peakGpuResourceBytes: 11_059_584 } } };
    const context = createContext({ ArrayBuffer, Uint8Array, Object, Promise, GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 }, GPUMapMode: { READ: 1 }, btoa: () => "bounded", __shellxMotionGpuSessionV1: state });
    const reserve = runInContext(`(${reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback.toString()})`, context) as typeof reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback;
    const read = runInContext(`(${readWebGpuPageSessionScene3dGltfPbrStreamingFrame.toString()})`, context) as typeof readWebGpuPageSessionScene3dGltfPbrStreamingFrame;
    const release = runInContext(`(${releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback.toString()})`, context) as typeof releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback;
    const input = { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback@1" as const, staticFingerprint: HASH, frameFingerprint: HASH };
    expect(reserve(input)).toEqual({ ok: true }); expect(reserve(input)).toEqual({ ok: true }); expect(device.createBuffer).toHaveBeenCalledTimes(1);
    await expect(read(input)).resolves.toMatchObject({ ok: true, evidence: { readbackBufferAllocations: 1, mapOperations: 1, retainedReadbackBuffer: true } });
    await expect(read(input)).resolves.toMatchObject({ ok: true, evidence: { mapOperations: 2 } });
    expect(mapAsync).toHaveBeenCalledTimes(2); expect(unmap).toHaveBeenCalledTimes(2); expect(destroy).not.toHaveBeenCalled();
    expect(release()).toMatchObject({ hadReservedBuffer: true, destroyedReservedBuffer: true, mapOperations: 2, remainingReadbackBufferBytes: 0 }); expect(destroy).toHaveBeenCalledOnce();
  });

  it("rechecks Core static/frame seals and copied decoded texture bytes before crossing the material-only page boundary", () => {
    const plan = routePlan();
    expect(createGpuScene3dGltfPbrResourceInput(plan)).toMatchObject({ schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-resources@1", staticFingerprint: plan.staticPlan.fingerprint, frameFingerprint: plan.framePlan.fingerprint, primitives: [{ modelMatrix: plan.framePlan.primitiveBindings[0]!.modelMatrix }] });
    plan.textures[0]!.rgba[0] ^= 0xff;
    expect(() => createGpuScene3dGltfPbrResourceInput(plan)).toThrow(/texture snapshot identity changed/);
  });

  it("keeps prepare, render, and terminal release in the isolated material-only page route", async () => {
    const plan = routePlan(), metrics = { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-resource-metrics@1", staticFingerprint: plan.staticPlan.fingerprint } as never;
    const page = { evaluate: vi.fn(async (callback: { name?: string }) => (callback.name ?? "").includes("install") ? { ok: true } : (callback.name ?? "").includes("prepare") ? { ok: true, metrics } : (callback.name ?? "").includes("render") ? { ok: true, metrics } : { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-release@1", reason: "terminal", hadResources: true, remainingGpuResourceBytes: 0 }) };
    const prepared = await prepareGpuScene3dGltfPbrMaterialPage(page, plan); expect(prepared).toMatchObject({ ok: true, metrics });
    if (!prepared.ok) return;
    await expect(renderGpuScene3dGltfPbrMaterialPage(page, prepared.input)).resolves.toMatchObject({ ok: true, metrics });
    await expect(releaseGpuScene3dGltfPbrMaterialPage(page)).resolves.toMatchObject({ remainingGpuResourceBytes: 0 });
    expect(page.evaluate).toHaveBeenCalledTimes(4);
  });
});

function resourceInput(): GpuPageScene3dGltfPbrResourceInput {
  const vertices = Buffer.alloc(96), indices = Buffer.alloc(12), rgba = Buffer.from([0x11, 0x22, 0x33, 0x00, 0x44, 0x55, 0x66, 0xff, 0x77, 0x88, 0x99, 0xff, 0xaa, 0xbb, 0xcc, 0xff]);
  const vertexSha256 = sha256(vertices), indexSha256 = sha256(indices), rgbaSha256 = sha256(rgba);
  return {
    schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-resources@1", staticFingerprint: HASH, frameFingerprint: HASH, sourceSha256: HASH,
    pbr: { abi: "shellx-motion/browser-scene3d-gltf-pbr-sdr@1", baseColorTextureFormat: "rgba8unorm-srgb", baseColorTextureTransfer: "srgb-to-linear-hardware", factorSpace: "linear-gltf", brdf: "ggx-smith-schlick-directional@1", ambient: "bounded-diffuse@1", directionalLight: { direction: [-0.4, -0.8, -0.4], color: [1, 1, 1], intensity: 1, ambientDiffuse: 0.15 }, outputTransfer: "linear-to-srgb-explicit" },
    pipeline: GPU_PAGE_SCENE3D_GLTF_PBR_PIPELINE_IDENTITY,
    textures: [{ resourceId: "scene3d-gltf-pbr-a", assetRef: "assets/pbr/a.png", encodedSha256: HASH, decodedRgbaSha256: rgbaSha256, width: 2, height: 2, decodedRgbaByteLength: 16, mipLevelCount: 2, mipmappedRgbaByteLength: 20, rgbaBase64: rgba.toString("base64") }],
    primitives: [{ id: "mesh-0-primitive-0", sourceSha256: HASH, textureResourceId: "scene3d-gltf-pbr-a", vertexCount: 3, indexCount: 3, vertexBufferSha256: vertexSha256, vertexBufferByteLength: vertices.byteLength, indexBufferSha256: indexSha256, indexBufferByteLength: indices.byteLength, verticesBase64: vertices.toString("base64"), indicesBase64: indices.toString("base64"), modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1, emissiveFactor: [0, 0, 0] } }],
    camera: { viewport: { width: 1280, height: 720 }, projection: "perspective@1", fovDeg: 42, near: 0.1, far: 100, position: [2, 2, 4], target: [0, 0, 0], viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    budget: { vertexBufferBytes: 96, indexBufferBytes: 12, uniformBufferBytes: 256, decodedTextureBytes: 16, mipmappedTextureBytes: 20, gpuResourceBytes: 384, renderTargetBytes: 3_686_400, depthTargetBytes: 3_686_400, readbackBufferBytes: 3_686_400, frameGpuResourceBytes: 7_373_184, peakGpuResourceBytes: 11_059_584 },
  };
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function routePlan() {
  const input = resourceInput(), [texture] = input.textures, [primitive] = input.primitives;
  const rgba = Buffer.from(texture!.rgbaBase64, "base64"), vertices = Buffer.from(primitive!.verticesBase64, "base64"), indices = Buffer.from(primitive!.indicesBase64, "base64");
  const staticBase = {
    schema: "shellx-motion/scene3d-gltf-material-render-static@1" as const, source: { sha256: HASH }, pbr: input.pbr,
    textures: [{ resourceId: texture!.resourceId, assetRef: texture!.assetRef, encodedSha256: texture!.encodedSha256, decodedRgbaSha256: texture!.decodedRgbaSha256, width: texture!.width, height: texture!.height, decodedRgbaByteLength: texture!.decodedRgbaByteLength, mipLevelCount: texture!.mipLevelCount, mipmappedRgbaByteLength: texture!.mipmappedRgbaByteLength }],
    primitives: [{ id: primitive!.id, source: { sha256: HASH }, material: { ...primitive!.material, textureResourceId: primitive!.textureResourceId }, vertices: Array.from(new Float32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4)), indices: Array.from(new Uint32Array(indices.buffer, indices.byteOffset, indices.byteLength / 4)), vertexCount: primitive!.vertexCount, indexCount: primitive!.indexCount, vertexBufferSha256: primitive!.vertexBufferSha256, vertexBufferByteLength: primitive!.vertexBufferByteLength, indexBufferSha256: primitive!.indexBufferSha256, indexBufferByteLength: primitive!.indexBufferByteLength }],
    budget: input.budget,
  };
  const staticPlan = { ...staticBase, fingerprint: canonicalJsonSha256(staticBase) };
  const frameBase = { schema: "shellx-motion/scene3d-gltf-material-render-frame@1" as const, staticFingerprint: staticPlan.fingerprint, pbrAbi: input.pbr.abi, camera: input.camera, primitiveBindings: [{ primitiveId: primitive!.id, primitiveFingerprint: HASH, textureResourceId: primitive!.textureResourceId, modelMatrix: primitive!.modelMatrix, pbrUniformByteLength: 256 as const }], resourceFingerprint: canonicalJsonSha256({ textures: staticPlan.textures, budget: staticPlan.budget }) };
  return { staticPlan, framePlan: { ...frameBase, fingerprint: canonicalJsonSha256(frameBase) }, textures: [{ ...staticPlan.textures[0]!, rgba }] };
}
