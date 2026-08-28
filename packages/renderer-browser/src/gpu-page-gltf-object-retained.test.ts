import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareWebGpuPageGltfObjectRetained,
  readWebGpuPageGltfObjectRetainedMetrics,
  releaseWebGpuPageGltfObjectRetained,
  renderWebGpuPageGltfObjectRetainedFrame,
  type GpuPageGltfObjectRetainedFrameInput,
  type GpuPageGltfObjectRetainedStaticInput,
} from "./gpu-page-gltf-object-retained";

describe("C7A3e retained imported-object WebGPU page", () => {
  afterEach(() => { delete (globalThis as PageGlobal).__shellxMotionGpuSessionV1; });

  it("allocates shared geometry and stable instance slots once across frames, then terminally destroys them", async () => {
    const fake = installFakeGpu(), staticInput = retainedStatic();
    await expect(prepareWebGpuPageGltfObjectRetained(staticInput)).resolves.toMatchObject({ ok: true, metrics: { geometryResourceCount: 1, instanceSlotCount: 2, sharedGeometryReuseCount: 1, preparationOperations: 1, renderedFrames: 0, perFrameGpuAllocations: 0 } });
    const allocations = { buffers: fake.buffers.length, textures: fake.textures.length };
    const first = await renderWebGpuPageGltfObjectRetainedFrame(frame(staticInput.staticFingerprint, 0, "a".repeat(64)));
    const second = await renderWebGpuPageGltfObjectRetainedFrame(frame(staticInput.staticFingerprint, 250_000, "b".repeat(64)));
    expect(first).toMatchObject({ ok: true, width: 16, height: 16, bytesPerRow: 256, metrics: { renderedFrames: 1, perFrameGpuAllocations: 0 } });
    expect(second).toMatchObject({ ok: true, metrics: { renderedFrames: 2, perFrameGpuAllocations: 0 } });
    expect({ buffers: fake.buffers.length, textures: fake.textures.length }).toEqual(allocations);
    expect(readWebGpuPageGltfObjectRetainedMetrics()).toMatchObject({ renderedFrames: 2, retainedGpuBytes: 6_740 });
    expect(releaseWebGpuPageGltfObjectRetained()).toEqual({ schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: true, destroyedVertexBuffers: 1, destroyedIndexBuffers: 1, destroyedUniformBuffers: 2, destroyedRenderTargets: 2, destroyedReadbackBuffers: 1, releasedGpuBytes: 6_740, remainingGpuBytes: 0 });
    expect(fake.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(fake.textures.every((texture) => texture.destroyed)).toBe(true);
    expect(readWebGpuPageGltfObjectRetainedMetrics()).toBeNull();
  });

  it("refuses resource identity, binding order, byte hashes, and duplicate preparation", async () => {
    installFakeGpu();
    const base = retainedStatic(), invalid = { ...base, geometries: [{ ...base.geometries[0]!, vertexBufferSha256: "0".repeat(64) }] };
    await expect(prepareWebGpuPageGltfObjectRetained(invalid)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
    const valid = retainedStatic();
    await expect(prepareWebGpuPageGltfObjectRetained(valid)).resolves.toMatchObject({ ok: true });
    await expect(prepareWebGpuPageGltfObjectRetained(valid)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    const wrongStatic = frame("0".repeat(64), 0, "a".repeat(64));
    await expect(renderWebGpuPageGltfObjectRetainedFrame(wrongStatic)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    const ordered = frame(valid.staticFingerprint, 0, "a".repeat(64)), wrongOrder = { ...ordered, bindings: [...ordered.bindings].reverse() };
    await expect(renderWebGpuPageGltfObjectRetainedFrame(wrongOrder)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    releaseWebGpuPageGltfObjectRetained();
  });

  it("creates one final depth-read-only alpha pipeline without changing opaque slot admission", async () => {
    const fake = installFakeGpu(), base = retainedStatic(), alphaStatic = { ...base, instanceSlots: [base.instanceSlots[0]!, { ...base.instanceSlots[1]!, renderMode: "alpha" as const }] };
    await expect(prepareWebGpuPageGltfObjectRetained(alphaStatic)).resolves.toMatchObject({ ok: true, metrics: { instanceSlotCount: 2, preparationOperations: 1 } });
    expect(fake.pipelines.map((entry) => ({ cullMode: entry.primitive.cullMode, depthWriteEnabled: entry.depthStencil.depthWriteEnabled, blend: entry.fragment.targets[0]!.blend !== undefined }))).toEqual([
      { cullMode: "none", depthWriteEnabled: true, blend: false },
      { cullMode: "back", depthWriteEnabled: false, blend: true },
    ]);
    const opaqueFrame = frame(base.staticFingerprint, 0, "a".repeat(64)), alphaFrame = { ...opaqueFrame, bindings: [opaqueFrame.bindings[0]!, { ...opaqueFrame.bindings[1]!, color: [0, 0, 1, 0.25] as const }] };
    await expect(renderWebGpuPageGltfObjectRetainedFrame(opaqueFrame)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    const translucentOpaque = { ...alphaFrame, bindings: [{ ...alphaFrame.bindings[0]!, color: [1, 0, 0, 0.5] as const }, alphaFrame.bindings[1]!] };
    await expect(renderWebGpuPageGltfObjectRetainedFrame(translucentOpaque)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    await expect(renderWebGpuPageGltfObjectRetainedFrame(alphaFrame)).resolves.toMatchObject({ ok: true });
    expect(fake.drawPipelines).toEqual(["opaque", "alpha"]);
    releaseWebGpuPageGltfObjectRetained();

    installFakeGpu();
    await expect(prepareWebGpuPageGltfObjectRetained({ ...base, instanceSlots: [{ ...base.instanceSlots[0]!, renderMode: "alpha" }, base.instanceSlots[1]!] })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_limits_exceeded" } });
  });
});

interface FakeBuffer { readonly bytes: Uint8Array; destroyed: boolean; mapAsync(): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; destroy(): void }
interface FakeTexture { destroyed: boolean; createView(): object; destroy(): void }
interface PageGlobal { __shellxMotionGpuSessionV1?: unknown; GPUBufferUsage?: Record<string, number>; GPUTextureUsage?: Record<string, number>; GPUMapMode?: Record<string, number> }

function installFakeGpu() {
  const buffers: FakeBuffer[] = [], textures: FakeTexture[] = [], pipelines: any[] = [], drawPipelines: string[] = [];
  let activePipeline = "none";
  const device = {
    limits: { maxTextureDimension2D: 4_096, maxBufferSize: 64 * 1024 * 1024 },
    createShaderModule: () => ({}),
    createRenderPipelineAsync: async (descriptor: any) => { pipelines.push(descriptor); const tag = descriptor.depthStencil.depthWriteEnabled ? "opaque" : "alpha"; return { tag, getBindGroupLayout: () => ({ tag }) }; },
    createRenderPipeline: (descriptor: any) => { pipelines.push(descriptor); const tag = descriptor.depthStencil.depthWriteEnabled ? "opaque" : "alpha"; return { tag, getBindGroupLayout: () => ({ tag }) }; },
    createBindGroup: () => ({}),
    createBuffer: ({ size }: { size: number }) => { const buffer: FakeBuffer = { bytes: new Uint8Array(size), destroyed: false, async mapAsync() {}, getMappedRange() { return buffer.bytes.buffer as ArrayBuffer; }, unmap() {}, destroy() { buffer.destroyed = true; } }; buffers.push(buffer); return buffer; },
    createTexture: () => { const texture: FakeTexture = { destroyed: false, createView: () => ({}), destroy() { texture.destroyed = true; } }; textures.push(texture); return texture; },
    createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline(value: { tag: string }) { activePipeline = value.tag; }, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() { drawPipelines.push(activePipeline); }, end() {} }), copyTextureToBuffer() {}, finish: () => ({}) }),
    queue: { writeBuffer() {}, submit() {}, async onSubmittedWorkDone() {} },
  };
  const global = globalThis as PageGlobal;
  global.GPUBufferUsage = { VERTEX: 1, INDEX: 2, UNIFORM: 4, COPY_DST: 8, MAP_READ: 16 };
  global.GPUTextureUsage = { RENDER_ATTACHMENT: 1, COPY_SRC: 2 };
  global.GPUMapMode = { READ: 1 };
  global.__shellxMotionGpuSessionV1 = { device, limits: device.limits, lost: false };
  return { buffers, textures, pipelines, drawPipelines };
}

function retainedStatic(): GpuPageGltfObjectRetainedStaticInput {
  const vertices = Buffer.alloc(72), indices = Buffer.alloc(12); [0, 1, 2].forEach((value, index) => indices.writeUInt32LE(value, index * 4));
  return {
    schema: "shellx-motion/private-gltf-object-retained-page-static@1",
    staticFingerprint: "f".repeat(64), width: 16, height: 16,
    geometries: [{ id: "wheel", vertexCount: 3, indexCount: 3, vertexBufferSha256: hash(vertices), indexBufferSha256: hash(indices), vertexBufferBytes: 72, indexBufferBytes: 12, verticesBase64: vertices.toString("base64"), indicesBase64: indices.toString("base64") }],
    instanceSlots: [{ instanceId: "wheel-left", primitiveRef: "wheel" }, { instanceId: "wheel-right", primitiveRef: "wheel" }],
    budget: { vertexBufferBytes: 72, indexBufferBytes: 12, uniformBufferBytes: 512, renderTargetBytes: 1_024, depthTargetBytes: 1_024, readbackBufferBytes: 4_096, retainedGpuBytes: 6_740 },
  };
}

function frame(staticFingerprint: string, atUs: number, sourceFrameFingerprint: string): GpuPageGltfObjectRetainedFrameInput {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1", staticFingerprint, evaluationFingerprint: "e".repeat(64), sourceFrameFingerprint, atUs,
    viewport: { width: 16, height: 16 }, background: [0, 0, 0, 1], viewProjection: [...matrix], lighting: { direction: [-0.4, -0.8, -0.4], color: [1, 1, 1, 1], ambient: 0.3, intensity: 1.4 },
    bindings: [{ instanceId: "wheel-left", primitiveRef: "wheel", modelMatrix: [...matrix], color: [1, 0, 0, 1], emissive: 0 }, { instanceId: "wheel-right", primitiveRef: "wheel", modelMatrix: [...matrix], color: [0, 0, 1, 1], emissive: 0.1 }], fingerprint: "c".repeat(64),
  };
}

function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
