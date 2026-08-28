import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export interface GpuPageGltfObjectRetainedStaticInput {
  readonly schema: "shellx-motion/private-gltf-object-retained-page-static@1";
  readonly staticFingerprint: string;
  readonly width: number;
  readonly height: number;
  readonly geometries: readonly Readonly<{ id: string; vertexCount: number; indexCount: number; vertexBufferSha256: string; indexBufferSha256: string; vertexBufferBytes: number; indexBufferBytes: number; verticesBase64: string; indicesBase64: string }>[];
  readonly instanceSlots: readonly Readonly<{ instanceId: string; primitiveRef: string; renderMode?: "alpha" }>[];
  readonly budget: Readonly<{ vertexBufferBytes: number; indexBufferBytes: number; uniformBufferBytes: number; renderTargetBytes: number; depthTargetBytes: number; readbackBufferBytes: number; retainedGpuBytes: number }>;
}

export interface GpuPageGltfObjectRetainedFrameInput {
  readonly schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1";
  readonly staticFingerprint: string;
  readonly evaluationFingerprint: string;
  readonly sourceFrameFingerprint: string;
  readonly atUs: number;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly background: readonly [number, number, number, number];
  readonly viewProjection: readonly number[];
  readonly lighting: Readonly<{ direction: readonly [number, number, number]; color: readonly [number, number, number, number]; ambient: number; intensity: number }>;
  readonly bindings: readonly Readonly<{ instanceId: string; primitiveRef: string; modelMatrix: readonly number[]; color: readonly [number, number, number, number]; emissive: number }>[];
  readonly fingerprint: string;
}

export interface GpuPageGltfObjectRetainedMetrics {
  readonly schema: "shellx-motion/gltf-object-retained-page-metrics@1";
  readonly staticFingerprint: string;
  readonly geometryResourceCount: number;
  readonly instanceSlotCount: number;
  readonly sharedGeometryReuseCount: number;
  readonly vertexBufferBytes: number;
  readonly indexBufferBytes: number;
  readonly uniformBufferBytes: number;
  readonly retainedGpuBytes: number;
  readonly preparationOperations: 1;
  readonly renderedFrames: number;
  readonly perFrameGpuAllocations: 0;
}

export type GpuPageGltfObjectRetainedPrepareOutput = { readonly ok: true; readonly metrics: GpuPageGltfObjectRetainedMetrics } | { readonly ok: false; readonly failure: GpuRuntimeFailure };
export type GpuPageGltfObjectRetainedFrameOutput = { readonly ok: true; readonly width: number; readonly height: number; readonly bytesPerRow: number; readonly paddedBase64: string; readonly metrics: GpuPageGltfObjectRetainedMetrics } | { readonly ok: false; readonly failure: GpuRuntimeFailure };
export interface GpuPageGltfObjectRetainedReleaseEvidence { readonly schema: "shellx-motion/gltf-object-retained-page-release@1"; readonly hadResources: boolean; readonly destroyedVertexBuffers: number; readonly destroyedIndexBuffers: number; readonly destroyedUniformBuffers: number; readonly destroyedRenderTargets: number; readonly destroyedReadbackBuffers: number; readonly releasedGpuBytes: number; readonly remainingGpuBytes: 0 }

/** Prepares one immutable geometry resource per primitive and one stable uniform slot per instance. */
export async function prepareWebGpuPageGltfObjectRetained(input: GpuPageGltfObjectRetainedStaticInput): Promise<GpuPageGltfObjectRetainedPrepareOutput> {
  type BufferFacade = { destroy?(): void };
  type TextureFacade = { createView(): unknown; destroy?(): void };
  type PipelineFacade = { getBindGroupLayout(index: number): unknown };
  type Device = { createShaderModule(value: unknown): unknown; createRenderPipeline(value: unknown): PipelineFacade; createRenderPipelineAsync?(value: unknown): Promise<PipelineFacade>; createBuffer(value: unknown): BufferFacade; createTexture(value: unknown): TextureFacade; createBindGroup(value: unknown): unknown; queue: { writeBuffer(buffer: BufferFacade, offset: number, bytes: Uint8Array): void; onSubmittedWorkDone?(): Promise<void> }; limits?: { maxTextureDimension2D?: number; maxBufferSize?: number } };
  const global = globalThis as unknown as { __shellxMotionGpuSessionV1?: { device?: Device; limits?: { maxTextureDimension2D: number; maxBufferSize: number }; lost?: boolean; gltfObjectRetained?: unknown }; GPUBufferUsage?: Record<string, number>; GPUTextureUsage?: Record<string, number>; atob?(value: string): string; crypto?: Crypto };
  const state = global.__shellxMotionGpuSessionV1, device = state?.device, bufferUsage = global.GPUBufferUsage, textureUsage = global.GPUTextureUsage;
  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuPageGltfObjectRetainedPrepareOutput => ({ ok: false, failure: { code, message } });
  if (!state || !device || !state.limits || !bufferUsage || !textureUsage || !global.atob || !global.crypto?.subtle) return fail("gpu_device_unavailable", "The retained imported-object page has no admitted WebGPU device or binary APIs.");
  if (state.gltfObjectRetained) return fail("gpu_resource_refused", "Retained imported-object resources are already prepared in this page session.");
  const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
  const decode = (value: string, bytes: number): Uint8Array => { const binary = global.atob!(value); if (binary.length !== bytes) throw new Error("base64 bytes"); const result = new Uint8Array(bytes); for (let index = 0; index < bytes; index += 1) result[index] = binary.charCodeAt(index); return result; };
  const sha = async (bytes: Uint8Array): Promise<string> => { const digest = new Uint8Array(await global.crypto!.subtle.digest("SHA-256", bytes as unknown as BufferSource)); return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); };
  if (!input || input.schema !== "shellx-motion/private-gltf-object-retained-page-static@1" || !hash(input.staticFingerprint) || !integer(input.width, 1, 1920) || !integer(input.height, 1, 1080) || input.width > state.limits.maxTextureDimension2D || input.height > state.limits.maxTextureDimension2D || !Array.isArray(input.geometries) || input.geometries.length < 1 || input.geometries.length > 32 || !Array.isArray(input.instanceSlots) || input.instanceSlots.length < 1 || input.instanceSlots.length > 256) return fail("gpu_limits_exceeded", "The retained imported-object static upload is outside its fixed shape or device limits.");
  const geometryIds = new Set<string>(), slotIds = new Set<string>(); let vertexBytes = 0, indexBytes = 0;
  for (const geometry of input.geometries) { if (!id(geometry.id) || geometryIds.has(geometry.id) || !integer(geometry.vertexCount, 3, 1_048_576) || !integer(geometry.indexCount, 3, 3_145_728) || geometry.indexCount % 3 !== 0 || geometry.vertexBufferBytes !== geometry.vertexCount * 24 || geometry.indexBufferBytes !== geometry.indexCount * 4 || !hash(geometry.vertexBufferSha256) || !hash(geometry.indexBufferSha256) || typeof geometry.verticesBase64 !== "string" || typeof geometry.indicesBase64 !== "string") return fail("gpu_limits_exceeded", "The retained imported-object geometry upload is malformed."); geometryIds.add(geometry.id); vertexBytes += geometry.vertexBufferBytes; indexBytes += geometry.indexBufferBytes; }
  let alphaSlots = 0;
  for (let index = 0; index < input.instanceSlots.length; index += 1) { const slot = input.instanceSlots[index]!; if (!id(slot.instanceId) || slotIds.has(slot.instanceId) || !geometryIds.has(slot.primitiveRef) || (slot.renderMode !== undefined && slot.renderMode !== "alpha") || (slot.renderMode === "alpha" && (++alphaSlots !== 1 || index !== input.instanceSlots.length - 1))) return fail("gpu_limits_exceeded", "The retained imported-object instance slots are malformed."); slotIds.add(slot.instanceId); }
  const bytesPerRow = Math.ceil((input.width * 4) / 256) * 256, targetBytes = input.width * input.height * 4, readbackBytes = bytesPerRow * input.height, uniformBytes = input.instanceSlots.length * 256;
  if (vertexBytes !== input.budget.vertexBufferBytes || indexBytes !== input.budget.indexBufferBytes || uniformBytes !== input.budget.uniformBufferBytes || targetBytes !== input.budget.renderTargetBytes || targetBytes !== input.budget.depthTargetBytes || readbackBytes !== input.budget.readbackBufferBytes || input.budget.retainedGpuBytes !== vertexBytes + indexBytes + uniformBytes + targetBytes * 2 + readbackBytes || input.budget.retainedGpuBytes > 64 * 1024 * 1024 || Math.max(vertexBytes, indexBytes, readbackBytes) > state.limits.maxBufferSize) return fail("gpu_limits_exceeded", "The retained imported-object resource budget does not match its exact upload.");
  const geometries: Array<{ id: string; vertex: BufferFacade; index: BufferFacade; indexCount: number }> = [], instances: Array<{ instanceId: string; primitiveRef: string; renderMode?: "alpha"; uniform: BufferFacade; bindGroup: unknown }> = [];
  let target: TextureFacade | undefined, depth: TextureFacade | undefined, readback: BufferFacade | undefined;
  try {
    const module = device.createShaderModule({ code: `
struct ObjectUniform { viewProjection: mat4x4<f32>, model: mat4x4<f32>, lightDirectionAmbient: vec4<f32>, lightColorIntensity: vec4<f32>, color: vec4<f32>, params: vec4<f32> }
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) normal: vec3<f32> }
@group(0) @binding(0) var<uniform> object: ObjectUniform;
@vertex fn vs(@location(0) position:vec3<f32>,@location(1) normal:vec3<f32>)->VertexOut { var out:VertexOut; out.position=object.viewProjection*object.model*vec4<f32>(position,1.0); out.normal=normalize((object.model*vec4<f32>(normal,0.0)).xyz); return out; }
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32> { let diffuse=max(dot(normalize(input.normal),normalize(-object.lightDirectionAmbient.xyz)),0.0); let light=object.lightDirectionAmbient.w+object.params.x+diffuse*object.lightColorIntensity.w; return vec4<f32>(clamp(object.color.rgb*object.lightColorIntensity.rgb*light,vec3<f32>(0.0),vec3<f32>(1.0)),object.color.a); }
` });
    const descriptor = { layout: "auto", vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }] }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list", cullMode: "none" }, depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" } };
    const pipeline = device.createRenderPipelineAsync ? await device.createRenderPipelineAsync(descriptor) : device.createRenderPipeline(descriptor);
    const alphaDescriptor = { ...descriptor, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] }, primitive: { topology: "triangle-list", cullMode: "back" }, depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" } };
    const alphaPipeline = alphaSlots === 1 ? (device.createRenderPipelineAsync ? await device.createRenderPipelineAsync(alphaDescriptor) : device.createRenderPipeline(alphaDescriptor)) : undefined;
    for (const geometry of input.geometries) { const vertices = decode(geometry.verticesBase64, geometry.vertexBufferBytes), indices = decode(geometry.indicesBase64, geometry.indexBufferBytes); if (await sha(vertices) !== geometry.vertexBufferSha256 || await sha(indices) !== geometry.indexBufferSha256) throw new Error("geometry identity"); const vertex = device.createBuffer({ size: geometry.vertexBufferBytes, usage: bufferUsage.VERTEX! | bufferUsage.COPY_DST! }), index = device.createBuffer({ size: geometry.indexBufferBytes, usage: bufferUsage.INDEX! | bufferUsage.COPY_DST! }); device.queue.writeBuffer(vertex, 0, vertices); device.queue.writeBuffer(index, 0, indices); geometries.push({ id: geometry.id, vertex, index, indexCount: geometry.indexCount }); }
    for (const slot of input.instanceSlots) { const uniform = device.createBuffer({ size: 256, usage: bufferUsage.UNIFORM! | bufferUsage.COPY_DST! }), slotPipeline = slot.renderMode === "alpha" ? alphaPipeline! : pipeline, bindGroup = device.createBindGroup({ layout: slotPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] }); instances.push({ ...slot, uniform, bindGroup }); }
    target = device.createTexture({ size: { width: input.width, height: input.height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: textureUsage.RENDER_ATTACHMENT! | textureUsage.COPY_SRC! });
    depth = device.createTexture({ size: { width: input.width, height: input.height, depthOrArrayLayers: 1 }, format: "depth24plus", usage: textureUsage.RENDER_ATTACHMENT! });
    readback = device.createBuffer({ size: readbackBytes, usage: bufferUsage.MAP_READ! | bufferUsage.COPY_DST! });
    const metrics: GpuPageGltfObjectRetainedMetrics = Object.freeze({ schema: "shellx-motion/gltf-object-retained-page-metrics@1", staticFingerprint: input.staticFingerprint, geometryResourceCount: geometries.length, instanceSlotCount: instances.length, sharedGeometryReuseCount: instances.length - new Set(instances.map((slot) => slot.primitiveRef)).size, vertexBufferBytes: vertexBytes, indexBufferBytes: indexBytes, uniformBufferBytes: uniformBytes, retainedGpuBytes: input.budget.retainedGpuBytes, preparationOperations: 1, renderedFrames: 0, perFrameGpuAllocations: 0 });
    state.gltfObjectRetained = { staticFingerprint: input.staticFingerprint, width: input.width, height: input.height, bytesPerRow, pipeline, alphaPipeline, geometries, instances, target, depth, readback, metrics, renderedFrames: 0 };
    if (device.queue.onSubmittedWorkDone) await device.queue.onSubmittedWorkDone();
    return { ok: true, metrics };
  } catch { for (const item of geometries) { item.vertex.destroy?.(); item.index.destroy?.(); } for (const item of instances) item.uniform.destroy?.(); target?.destroy?.(); depth?.destroy?.(); readback?.destroy?.(); return fail("gpu_render_failed", "The retained imported-object page failed closed while preparing exact resources."); }
}

/** Updates only retained instance uniforms, draws shared geometry, and reuses one mapped readback buffer. */
export async function renderWebGpuPageGltfObjectRetainedFrame(input: GpuPageGltfObjectRetainedFrameInput): Promise<GpuPageGltfObjectRetainedFrameOutput> {
  type BufferFacade = { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void };
  type TextureFacade = { createView(): unknown };
  type PipelineFacade = unknown;
  type Geometry = { id: string; vertex: unknown; index: unknown; indexCount: number };
  type Instance = { instanceId: string; primitiveRef: string; renderMode?: "alpha"; uniform: unknown; bindGroup: unknown };
  type Resources = { staticFingerprint: string; width: number; height: number; bytesPerRow: number; pipeline: PipelineFacade; alphaPipeline?: PipelineFacade; geometries: Geometry[]; instances: Instance[]; target: TextureFacade; depth: TextureFacade; readback: BufferFacade; metrics: GpuPageGltfObjectRetainedMetrics; renderedFrames: number };
  type Encoder = { beginRenderPass(value: unknown): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; setVertexBuffer(index: number, value: unknown): void; setIndexBuffer(value: unknown, format: "uint32"): void; drawIndexed(count: number): void; end(): void }; copyTextureToBuffer(a: unknown, b: unknown, c: unknown): void; finish(): unknown };
  type Device = { createCommandEncoder(): Encoder; queue: { writeBuffer(buffer: unknown, offset: number, bytes: Float32Array): void; submit(values: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } };
  const global = globalThis as unknown as { __shellxMotionGpuSessionV1?: { device?: Device; lost?: boolean; gltfObjectRetained?: Resources }; GPUMapMode?: Record<string, number>; btoa?(value: string): string };
  const state = global.__shellxMotionGpuSessionV1, resources = state?.gltfObjectRetained, device = state?.device;
  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuPageGltfObjectRetainedFrameOutput => ({ ok: false, failure: { code, message } });
  const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const array = (value: unknown, length: number, min: number, max: number): value is number[] => Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= min && entry <= max);
  if (!resources || !device || !global.GPUMapMode || typeof global.GPUMapMode.READ !== "number" || !global.btoa) return fail("gpu_device_unavailable", "The retained imported-object frame has no prepared resources.");
  if (state?.lost) return fail("gpu_device_lost", "The retained imported-object device was lost before rendering.");
  if (!input || input.schema !== "shellx-motion/private-gltf-object-retained-render-frame-upload@1" || input.staticFingerprint !== resources.staticFingerprint || !hash(input.fingerprint) || !hash(input.evaluationFingerprint) || !hash(input.sourceFrameFingerprint) || input.viewport?.width !== resources.width || input.viewport?.height !== resources.height || !array(input.background, 4, 0, 1) || !array(input.viewProjection, 16, -1_000_000, 1_000_000) || !array(input.lighting?.direction, 3, -1, 1) || !array(input.lighting?.color, 4, 0, 1) || typeof input.lighting?.ambient !== "number" || input.lighting.ambient < 0 || input.lighting.ambient > 1 || typeof input.lighting?.intensity !== "number" || input.lighting.intensity < 0 || input.lighting.intensity > 4 || !Array.isArray(input.bindings) || input.bindings.length !== resources.instances.length) return fail("gpu_resource_refused", "The retained imported-object frame does not match its prepared static authority.");
  const geometryById = new Map(resources.geometries.map((geometry) => [geometry.id, geometry]));
  for (let index = 0; index < resources.instances.length; index += 1) { const slot = resources.instances[index]!, binding = input.bindings[index], alpha = binding?.color?.[3]; if (!binding || binding.instanceId !== slot.instanceId || binding.primitiveRef !== slot.primitiveRef || !geometryById.has(binding.primitiveRef) || !array(binding.modelMatrix, 16, -1_000_000, 1_000_000) || !array(binding.color, 4, 0, 1) || (slot.renderMode === "alpha" ? !(alpha! > 0 && alpha! < 1) : alpha !== 1) || typeof binding.emissive !== "number" || binding.emissive < 0 || binding.emissive > 1) return fail("gpu_resource_refused", "The retained imported-object frame binding order or values changed after compilation."); }
  let mapped = false;
  try {
    for (let index = 0; index < resources.instances.length; index += 1) { const slot = resources.instances[index]!, binding = input.bindings[index]!, uniform = new Float32Array(48); uniform.set(input.viewProjection, 0); uniform.set(binding.modelMatrix, 16); uniform.set([...input.lighting.direction, input.lighting.ambient], 32); uniform.set([...input.lighting.color.slice(0, 3), input.lighting.intensity], 36); uniform.set(binding.color, 40); uniform.set([binding.emissive, 1, 0, 0], 44); device.queue.writeBuffer(slot.uniform, 0, uniform); }
    const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: resources.target.createView(), clearValue: input.background, loadOp: "clear", storeOp: "store" }], depthStencilAttachment: { view: resources.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    pass.setPipeline(resources.pipeline);
    for (const slot of resources.instances) { if (slot.renderMode === "alpha") pass.setPipeline(resources.alphaPipeline!); const geometry = geometryById.get(slot.primitiveRef)!; pass.setBindGroup(0, slot.bindGroup); pass.setVertexBuffer(0, geometry.vertex); pass.setIndexBuffer(geometry.index, "uint32"); pass.drawIndexed(geometry.indexCount); }
    pass.end(); encoder.copyTextureToBuffer({ texture: resources.target }, { buffer: resources.readback, bytesPerRow: resources.bytesPerRow, rowsPerImage: resources.height }, { width: resources.width, height: resources.height, depthOrArrayLayers: 1 }); device.queue.submit([encoder.finish()]); if (device.queue.onSubmittedWorkDone) await device.queue.onSubmittedWorkDone();
    await resources.readback.mapAsync(global.GPUMapMode.READ); mapped = true; const bytes = new Uint8Array(resources.readback.getMappedRange()); let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); resources.renderedFrames += 1; const metrics = Object.freeze({ ...resources.metrics, renderedFrames: resources.renderedFrames });
    return { ok: true, width: resources.width, height: resources.height, bytesPerRow: resources.bytesPerRow, paddedBase64: global.btoa(binary), metrics };
  } catch { return fail(state?.lost ? "gpu_device_lost" : "gpu_render_failed", "The retained imported-object frame failed during its fixed draw or readback."); }
  finally { if (mapped) resources.readback.unmap(); }
}

export function readWebGpuPageGltfObjectRetainedMetrics(): GpuPageGltfObjectRetainedMetrics | null { const state = (globalThis as unknown as { __shellxMotionGpuSessionV1?: { gltfObjectRetained?: { metrics: GpuPageGltfObjectRetainedMetrics; renderedFrames: number } } }).__shellxMotionGpuSessionV1, resources = state?.gltfObjectRetained; return resources ? Object.freeze({ ...resources.metrics, renderedFrames: resources.renderedFrames }) : null; }

/** Destroys every retained resource and returns terminal zero-remaining evidence. */
export function releaseWebGpuPageGltfObjectRetained(): GpuPageGltfObjectRetainedReleaseEvidence {
  type Resources = { geometries: Array<{ vertex: { destroy?(): void }; index: { destroy?(): void } }>; instances: Array<{ uniform: { destroy?(): void } }>; target: { destroy?(): void }; depth: { destroy?(): void }; readback: { destroy?(): void }; metrics: GpuPageGltfObjectRetainedMetrics };
  const state = (globalThis as unknown as { __shellxMotionGpuSessionV1?: { gltfObjectRetained?: Resources } }).__shellxMotionGpuSessionV1, resources = state?.gltfObjectRetained;
  if (!resources) return { schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: false, destroyedVertexBuffers: 0, destroyedIndexBuffers: 0, destroyedUniformBuffers: 0, destroyedRenderTargets: 0, destroyedReadbackBuffers: 0, releasedGpuBytes: 0, remainingGpuBytes: 0 };
  for (const geometry of resources.geometries) { geometry.vertex.destroy?.(); geometry.index.destroy?.(); } for (const instance of resources.instances) instance.uniform.destroy?.(); resources.target.destroy?.(); resources.depth.destroy?.(); resources.readback.destroy?.(); delete state!.gltfObjectRetained;
  return { schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: true, destroyedVertexBuffers: resources.geometries.length, destroyedIndexBuffers: resources.geometries.length, destroyedUniformBuffers: resources.instances.length, destroyedRenderTargets: 2, destroyedReadbackBuffers: 1, releasedGpuBytes: resources.metrics.retainedGpuBytes, remainingGpuBytes: 0 };
}
