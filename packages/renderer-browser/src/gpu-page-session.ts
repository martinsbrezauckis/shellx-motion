import type { GpuRuntimeFailure, InternalGpuFramePlan } from "./gpu-runtime-types";
import type { GpuPageFrameTransport } from "./gpu-page-frame-transport";
import type { GpuPageComputeParticleV2Metrics, GpuPageParticleV2Draw } from "./gpu-page-particle-compute-v2";
import type { GpuPageSessionFrameOutput, GpuPageSessionOpenOutput, InternalCompositeDraw, InternalGpuLegacyFramePlan, InternalGpuLegacyPrimitiveDraw, InternalPrimitiveDraw } from "./gpu-page-session-types";
export type { GpuPageSessionDynamicImageReplacementOutput, GpuPageSessionDynamicImageReservation, GpuPageSessionDynamicImageReservationOutput, GpuPageSessionFrameOutput, GpuPageSessionImageInput, GpuPageSessionImageOutput, GpuPageSessionOpenOutput } from "./gpu-page-session-types";

/** Initializes one persistent device and fixed pipelines inside the isolated loopback page. */
export async function openWebGpuPageSession(options: { powerPreference: "high-performance" }): Promise<GpuPageSessionOpenOutput> {
  type Device = {
    createBindGroup(descriptor: unknown): unknown;
    createRenderPipeline(descriptor: unknown): { getBindGroupLayout(index: number): unknown };
    createRenderPipelineAsync?(descriptor: unknown): Promise<{ getBindGroupLayout(index: number): unknown }>;
    createSampler(descriptor: unknown): unknown;
    createShaderModule(descriptor: unknown): unknown;
    destroy?(): void;
    limits?: { maxTextureDimension2D?: number; maxBufferSize?: number; maxStorageBufferBindingSize?: number };
    lost?: Promise<unknown>;
  };
  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuPageSessionOpenOutput => ({ ok: false, failure: { code, message } });
  const browserGlobal = globalThis as unknown as {
    __shellxMotionGpuSessionV1?: unknown;
    isSecureContext?: boolean;
    navigator?: { gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> } };
  };
  if (browserGlobal.__shellxMotionGpuSessionV1) return fail("gpu_render_failed", "A GPU page session is already open.");
  const gpu = browserGlobal.navigator?.gpu;
  if (!gpu) return fail("gpu_api_unavailable", "WebGPU is unavailable in the renderer page.");
  const firstAdapter = await gpu.requestAdapter(options);
  const adapter = firstAdapter ?? await gpu.requestAdapter(options);
  if (!adapter || typeof adapter !== "object") return fail("gpu_adapter_unavailable", "WebGPU did not provide a render adapter.");
  const readAdapterInfo = async (): Promise<{ vendor: string; device: string; architecture: string | null; description: string | null } | null> => {
    try {
      const candidate = (adapter as { info?: unknown; requestAdapterInfo?: () => Promise<unknown> }).info
        ?? await (adapter as { requestAdapterInfo?: () => Promise<unknown> }).requestAdapterInfo?.();
      if (!candidate || typeof candidate !== "object") return null;
      const record = candidate as Record<string, unknown>;
      if (typeof record.vendor !== "string" || !record.vendor.trim()) return null;
      const device = typeof record.device === "string" ? record.device : "";
      const architecture = typeof record.architecture === "string" && record.architecture.trim() ? record.architecture : null;
      const description = typeof record.description === "string" && record.description.trim() ? record.description : null;
      return device.trim() || architecture || description ? { vendor: record.vendor, device, architecture, description } : null;
    } catch { return null; }
  };
  const adapterInfo = await readAdapterInfo();
  if (!adapterInfo) return fail("gpu_adapter_identity_unavailable", "The persistent WebGPU adapter did not expose a correlatable identity.");
  const requestDevice = (adapter as { requestDevice?: () => Promise<unknown> }).requestDevice;
  const deviceValue = requestDevice ? await requestDevice.call(adapter).catch(() => null) : null;
  if (!deviceValue || typeof deviceValue !== "object") return fail("gpu_device_unavailable", "WebGPU did not provide a persistent render device.");
  const device = deviceValue as Device;
  const maxTextureDimension2D = device.limits?.maxTextureDimension2D;
  const maxBufferSize = device.limits?.maxBufferSize;
  const maxStorageBufferBindingSize = device.limits?.maxStorageBufferBindingSize;
  if (![maxTextureDimension2D, maxBufferSize, maxStorageBufferBindingSize].every((value) => typeof value === "number" && Number.isInteger(value))) {
    device.destroy?.();
    return fail("gpu_limits_exceeded", "The persistent WebGPU device did not expose bounded integer limits.");
  }
  const rectangleWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> }
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>) -> VertexOut { var o: VertexOut; o.position = vec4<f32>(position, 0.0, 1.0); o.color = color; return o; }
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { return input.color; }
`;
  const pointWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>, @location(1) local: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) vertex: u32, @location(0) center: vec2<f32>, @location(1) size: vec2<f32>, @location(2) color: vec4<f32>) -> VertexOut {
  let quad = array<vec2<f32>, 6>(vec2<f32>(-1.0,-1.0),vec2<f32>(1.0,-1.0),vec2<f32>(-1.0,1.0),vec2<f32>(-1.0,1.0),vec2<f32>(1.0,-1.0),vec2<f32>(1.0,1.0));
  var o: VertexOut; o.position = vec4<f32>(center + quad[vertex] * size * 0.5, 0.0, 1.0); o.color = color; o.local = quad[vertex]; return o;
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { if (dot(input.local,input.local) > 1.0) { discard; } return input.color; }
`;
  const ellipseWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>, @location(1) fill: vec4<f32>, @location(2) stroke: vec4<f32>, @location(3) halfSize: vec2<f32>, @location(4) strokeWidth: f32 }
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) local: vec2<f32>, @location(2) fill: vec4<f32>, @location(3) stroke: vec4<f32>, @location(4) halfSize: vec2<f32>, @location(5) strokeWidth: f32) -> VertexOut { var o: VertexOut; o.position=vec4<f32>(position,0.0,1.0); o.local=local; o.fill=fill; o.stroke=stroke; o.halfSize=halfSize; o.strokeWidth=strokeWidth; return o; }
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { if (dot(input.local,input.local) > 1.0) { discard; } if (input.strokeWidth > 0.0 && input.stroke.a > 0.0) { let inner=input.halfSize-vec2<f32>(input.strokeWidth); if (inner.x <= 0.0 || inner.y <= 0.0 || dot(input.local*input.halfSize/inner,input.local*input.halfSize/inner) > 1.0) { return input.stroke; } } return input.fill; }
`;
  const imageWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) opacity: f32 }
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) opacity: f32) -> VertexOut { var o: VertexOut; o.position=vec4<f32>(position,0.0,1.0); o.uv=uv; o.opacity=opacity; return o; }
@group(0) @binding(0) var imageSampler: sampler; @group(0) @binding(1) var imageTexture: texture_2d<f32>;
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { let sampled=textureSample(imageTexture,imageSampler,input.uv); let alpha=sampled.a*input.opacity; return vec4<f32>(sampled.rgb*alpha,alpha); }
`;
  try {
    const createPipeline = (descriptor: unknown) => device.createRenderPipelineAsync
      ? device.createRenderPipelineAsync(descriptor)
      : Promise.resolve(device.createRenderPipeline(descriptor));
    const blend = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } };
    const additive = { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } };
    const rectModule = device.createShaderModule({ code: rectangleWgsl });
    const pointModule = device.createShaderModule({ code: pointWgsl });
    const rectPipeline = await createPipeline({ layout: "auto", vertex: { module: rectModule, entryPoint: "vs", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x4" }] }] }, fragment: { module: rectModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } });
    const additiveRectPipeline = await createPipeline({ layout: "auto", vertex: { module: rectModule, entryPoint: "vs", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x4" }] }] }, fragment: { module: rectModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: additive }] }, primitive: { topology: "triangle-list" } });
    const pointPipeline = await createPipeline({ layout: "auto", vertex: { module: pointModule, entryPoint: "vs", buffers: [{ stepMode: "instance", arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32x4" }] }] }, fragment: { module: pointModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } });
    const additivePointPipeline = await createPipeline({ layout: "auto", vertex: { module: pointModule, entryPoint: "vs", buffers: [{ stepMode: "instance", arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32x4" }] }] }, fragment: { module: pointModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: additive }] }, primitive: { topology: "triangle-list" } });
    const ellipseModule = device.createShaderModule({ code: ellipseWgsl });
    const ellipseLayout = [{ arrayStride: 60, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32x4" }, { shaderLocation: 3, offset: 32, format: "float32x4" }, { shaderLocation: 4, offset: 48, format: "float32x2" }, { shaderLocation: 5, offset: 56, format: "float32" }] }];
    const ellipsePipeline = await createPipeline({ layout: "auto", vertex: { module: ellipseModule, entryPoint: "vs", buffers: ellipseLayout }, fragment: { module: ellipseModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } });
    const additiveEllipsePipeline = await createPipeline({ layout: "auto", vertex: { module: ellipseModule, entryPoint: "vs", buffers: ellipseLayout }, fragment: { module: ellipseModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: additive }] }, primitive: { topology: "triangle-list" } });
    const imageModule = device.createShaderModule({ code: imageWgsl });
    const imagePipeline = await createPipeline({ layout: "auto", vertex: { module: imageModule, entryPoint: "vs", buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32" }] }] }, fragment: { module: imageModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } });
    const additiveImagePipeline = await createPipeline({ layout: "auto", vertex: { module: imageModule, entryPoint: "vs", buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32" }] }] }, fragment: { module: imageModule, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: additive }] }, primitive: { topology: "triangle-list" } });
    const imageSampler = device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const limits = {
      maxTextureDimension2D: maxTextureDimension2D as number,
      maxBufferSize: maxBufferSize as number,
      maxStorageBufferBindingSize: maxStorageBufferBindingSize as number
    };
    const state = { device, rectPipeline, pointPipeline, ellipsePipeline, imagePipeline, additiveRectPipeline, additivePointPipeline, additiveEllipsePipeline, additiveImagePipeline, imageSampler, images: new Map<string, { texture: { destroy?(): void }; bindGroup: unknown }>(), fonts: new Map<string, unknown>(), textSurfaces: new Map<string, { texture: { destroy?(): void }; bindGroup: unknown; bytes: number; signature: string }>(), textSurfaceBytes: 0, limits, lost: false };
    device.lost?.then(() => { state.lost = true; }).catch(() => { state.lost = true; });
    browserGlobal.__shellxMotionGpuSessionV1 = state;
    return { ok: true, runtime: { secureContext: browserGlobal.isSecureContext === true, gpuApi: true, adapter: true, adapterInfo, device: true, limits } };
  } catch (error) {
    device.destroy?.();
    const detail = error instanceof Error ? error.message.slice(0, 512) : "unknown WebGPU validation error";
    return fail("gpu_render_failed", `Persistent WebGPU pipeline creation failed: ${detail}`);
  }
}

/** Renders one admitted frame through the persistent page device and pipelines. */
export async function renderWebGpuPageSessionFrame(input: InternalGpuFramePlan | GpuPageFrameTransport): Promise<GpuPageSessionFrameOutput> {
  type BufferFacade = { destroy?(): void; getMappedRange(): ArrayBuffer; mapAsync(mode: number): Promise<void>; unmap(): void };
  type TextureFacade = { createView(): unknown; destroy?(): void };
  type Pass = { draw(vertices: number, instances?: number): void; drawIndexed(indices:number):void; end(): void; setBindGroup(index: number, value: unknown): void; setIndexBuffer(value:BufferFacade,format:"uint32"):void; setPipeline(value: unknown): void; setVertexBuffer(slot: number, value: BufferFacade): void };
  type Encoder = { beginComputePass(): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; dispatchWorkgroups(count: number): void; end(): void }; beginRenderPass(value: unknown): Pass; copyTextureToBuffer(a: unknown,b: unknown,c: unknown): void; finish(): unknown };
  type Device = {
    createBindGroup(value: unknown): unknown;
    createBuffer(value: unknown): BufferFacade;
    createCommandEncoder(): Encoder;
    createTexture(value: unknown): TextureFacade;
    destroy?(): void;
    pushErrorScope(filter: "validation"): void;
    popErrorScope(): Promise<{ message?: unknown } | null>;
    queue: { onSubmittedWorkDone(): Promise<void>; submit(value: unknown[]): void; writeBuffer(buffer: BufferFacade, offset: number, data: Float32Array|Uint32Array): void };
  };
  type Surface = { current: TextureFacade; source: TextureFacade | null; target: TextureFacade | null; scratch: TextureFacade | null };
  type PageResources = {
    takeReservedFrameArena(fingerprint: string): { readback: BufferFacade; root: Surface; keyCleanup: Surface | null; groups: Surface[]; depth: TextureFacade | null };
    beginFrame(): void;
    acquireBuffer(role: "vertex" | "index" | "uniform", bytes: number, usage: number): BufferFacade;
    environmentUniformBuffer(): BufferFacade;
    environmentAccumulator(): TextureFacade;
    completeFrame(environmentDraws: number): void;
  };
  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuPageSessionFrameOutput => ({ ok: false, failure: { code, message } });
  const browserGlobal = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; GPUMapMode?: Record<string, number>; GPUTextureUsage?: Record<string, number>; btoa?(value: string): string; __shellxMotionGpuSessionV1?: unknown; __shellxMotionDecodeGpuFrameTransportV1?(input: unknown): Promise<unknown> };
  let plan: InternalGpuLegacyFramePlan;
  try { plan = input.schema === "shellx-motion/gpu-page-frame-transport@1" ? await browserGlobal.__shellxMotionDecodeGpuFrameTransportV1?.(input) as InternalGpuLegacyFramePlan : input as InternalGpuLegacyFramePlan; }
  catch { return fail("gpu_render_failed", "The GPU page frame transport failed integrity validation."); }
  if (!plan || plan.schema !== "shellx-motion/gpu-frame-intent@1") return fail("gpu_render_failed", "The GPU page frame transport did not decode an admitted plan.");
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; rectPipeline: unknown; pointPipeline: unknown; ellipsePipeline: unknown; imagePipeline: { getBindGroupLayout(index:number): unknown }; chromaKeyPipeline?: { getBindGroupLayout(index:number): unknown }; chromaMatteSeedPipeline?: { getBindGroupLayout(index:number): unknown }; chromaMatteCleanupPipeline?: { getBindGroupLayout(index:number): unknown }; chromaMattePresentPipeline?: { getBindGroupLayout(index:number): unknown }; additiveChromaMattePresentPipeline?: { getBindGroupLayout(index:number): unknown }; additiveRectPipeline: unknown; additivePointPipeline: unknown; additiveEllipsePipeline: unknown; additiveImagePipeline: { getBindGroupLayout(index:number): unknown }; imageSampler: unknown; gradientPipeline?: { getBindGroupLayout(index:number): unknown }; additiveGradientPipeline?: { getBindGroupLayout(index:number): unknown }; styledRectanglePipeline?: { getBindGroupLayout(index:number): unknown }; additiveStyledRectanglePipeline?: { getBindGroupLayout(index:number): unknown }; scene3dPipeline?:{getBindGroupLayout(index:number):unknown}; environmentPipeline?:{getBindGroupLayout(index:number):unknown}; additiveEnvironmentPipeline?:{getBindGroupLayout(index:number):unknown}; materialPipeline?:{getBindGroupLayout(index:number):unknown}; blendPipeline?: { getBindGroupLayout(index:number): unknown }; blurPipeline?: { getBindGroupLayout(index:number): unknown }; glowPipeline?: { getBindGroupLayout(index:number): unknown }; maskPipeline?: { getBindGroupLayout(index:number): unknown }; adjustmentPipeline?: { getBindGroupLayout(index:number): unknown }; images: Map<string, { texture: TextureFacade; bindGroup: unknown }>; textSurfaces: Map<string, { texture: TextureFacade; bindGroup: unknown }>; limits: { maxTextureDimension2D: number; maxBufferSize: number; maxStorageBufferBindingSize: number }; lost: boolean; computeParticles?: { render(input: Extract<InternalGpuFramePlan["draws"][number],{kind:"particleCompute"}>,frameWidth:number,frameHeight:number,encoder:Encoder): BufferFacade }; computeParticlesV2?: { render(input: GpuPageParticleV2Draw,frameWidth:number,frameHeight:number,encoder:Encoder,target:TextureFacade): void; snapshot(): GpuPageComputeParticleV2Metrics }; instanceBuffers?: { acquire(values: Float32Array): BufferFacade }; resources?: PageResources } | undefined;
  const bufferUsage = browserGlobal.GPUBufferUsage; const textureUsage = browserGlobal.GPUTextureUsage; const mapMode = browserGlobal.GPUMapMode;
  if (!state || !bufferUsage || !textureUsage || !mapMode || !state.resources) return fail("gpu_device_unavailable", "The persistent GPU page session is unavailable.");
  if (typeof state.device.pushErrorScope !== "function" || typeof state.device.popErrorScope !== "function") return fail("gpu_device_unavailable", "The persistent WebGPU device does not expose required validation scopes.");
  const pageResources = state.resources;
  if (state.lost) return fail("gpu_device_lost", "The persistent WebGPU device was lost.");
  const bytesPerRow = Math.ceil((plan.width * 4) / 256) * 256;
  const readbackBytes = bytesPerRow * plan.height;
  if (plan.width > state.limits.maxTextureDimension2D || plan.height > state.limits.maxTextureDimension2D || plan.budget.pointBufferBytes > state.limits.maxBufferSize || plan.budget.computeParticleBufferBytes / 2 > state.limits.maxBufferSize || plan.budget.computeParticleBufferBytes / 2 > state.limits.maxStorageBufferBindingSize || plan.budget.scene3dVertexBufferBytes > state.limits.maxBufferSize || plan.budget.scene3dIndexBufferBytes > state.limits.maxBufferSize || readbackBytes > state.limits.maxBufferSize) return fail("gpu_limits_exceeded", "The persistent WebGPU device cannot satisfy this bounded frame plan.");
  const readbackBase64 = (bytes: Uint8Array): string => {
    const modern = bytes as Uint8Array & { toBase64?: () => string };
    if (typeof modern.toBase64 === "function") return modern.toBase64();
    if (typeof browserGlobal.btoa !== "function") throw new Error("Canonical GPU readback base64 is unavailable.");
    let binary = ""; for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
    return browserGlobal.btoa(binary);
  };
  const premultiply = (c: {r:number;g:number;b:number;a:number}): [number,number,number,number] => [c.r*c.a,c.g*c.a,c.b*c.a,c.a];
  const rotate = (x:number,y:number,d:{rotationDeg:number;pivotX:number;pivotY:number}): [number,number] => { if(Math.abs(d.rotationDeg%360)<0.0001)return[x,y]; const radians=d.rotationDeg*(Math.PI/180),cosine=Math.cos(radians),sine=Math.sin(radians),localX=x-d.pivotX,localY=y-d.pivotY; return[d.pivotX+(localX*cosine)-(localY*sine),d.pivotY+(localX*sine)+(localY*cosine)]; };
  const rectVertices = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"rect"}>): Float32Array => { const c=premultiply(d.color),v=(x:number,y:number):number[]=>{const p=rotate(x,y,d);return[p[0]/plan.width*2-1,1-p[1]/plan.height*2,...c];},l=d.x,r=d.x+d.width,t=d.y,b=d.y+d.height; return new Float32Array([...v(l,t),...v(r,t),...v(l,b),...v(l,b),...v(r,t),...v(r,b)]); };
  const instances = (points: Array<{x:number;y:number;size:number;color:{r:number;g:number;b:number;a:number}}>): Float32Array => { const values=new Float32Array(points.length*8); points.forEach((p,i)=>values.set([p.x/plan.width*2-1,1-p.y/plan.height*2,p.size/plan.width*2,p.size/plan.height*2,...premultiply(p.color)],i*8)); return values; };
  const ellipse = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"ellipse"}>): Float32Array => { const fill=premultiply(d.color),stroke=premultiply(d.stroke),v=(x:number,y:number,lx:number,ly:number):number[]=>{const p=rotate(x,y,d);return[p[0]/plan.width*2-1,1-p[1]/plan.height*2,lx,ly,...fill,...stroke,d.width/2,d.height/2,d.strokeWidth];},l=d.x,r=d.x+d.width,t=d.y,b=d.y+d.height; return new Float32Array([...v(l,t,-1,-1),...v(r,t,1,-1),...v(l,b,-1,1),...v(l,b,-1,1),...v(r,t,1,-1),...v(r,b,1,1)]); };
  const triangles = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"triangles"}>): Float32Array => { const c=premultiply(d.color); return new Float32Array(d.vertices.flatMap((v)=>{const p=rotate(v.x,v.y,d);return[p[0]/plan.width*2-1,1-p[1]/plan.height*2,...c];})); };
  const coloredTriangles = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"coloredTriangles"}>): Float32Array => new Float32Array(d.vertices.flatMap((v)=>{const p=rotate(v.x,v.y,d);return[p[0]/plan.width*2-1,1-p[1]/plan.height*2,...premultiply(v.color)];}));
  const image = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"image"}>): Float32Array => { const v=(x:number,y:number,u:number,w:number):number[]=>{const p=rotate(x,y,d);return[p[0]/plan.width*2-1,1-p[1]/plan.height*2,u,w,d.opacity];},l=d.x,r=d.x+d.width,t=d.y,b=d.y+d.height; return new Float32Array([...v(l,t,d.u0,d.v0),...v(r,t,d.u1,d.v0),...v(l,b,d.u0,d.v1),...v(l,b,d.u0,d.v1),...v(r,t,d.u1,d.v0),...v(r,b,d.u1,d.v1)]); };
  const textImage = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"text"}>): Float32Array => image({ kind:"image",id:d.id,blendMode:d.blendMode,effects:d.effects,...(d.mask?{mask:d.mask}:{}),resourceId:d.surfaceId,x:d.x,y:d.y,width:d.width,height:d.height,rotationDeg:d.rotationDeg,pivotX:d.pivotX,pivotY:d.pivotY,u0:0,v0:0,u1:1,v1:1,opacity:d.opacity });
  const gradientVertices = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"gradientRect"}>): Float32Array => { const v=(x:number,y:number,u:number,w:number):number[]=>{const p=rotate(x,y,d);return[p[0]/plan.width*2-1,1-p[1]/plan.height*2,u,w];},l=d.x,r=d.x+d.width,t=d.y,b=d.y+d.height;return new Float32Array([...v(l,t,0,0),...v(r,t,1,0),...v(l,b,0,1),...v(l,b,0,1),...v(r,t,1,0),...v(r,b,1,1)]); };
  const gradientUniform = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"gradientRect"}>): Float32Array => { const values=new Float32Array(84);values.fill(2,4,20);values.set([d.gradientType==="radial"?1:0,d.angleDeg*Math.PI/180,d.centerX,d.centerY]);d.stops.forEach((stop,index)=>{values[4+index]=stop.offset;const c=premultiply(stop.color);values.set(c,20+index*4);});return values; };
  const styledRectangleVertices = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"styledRect"}>): Float32Array => { const s=d.shadow,blur=(s?.blur??0)*2,spread=s?.spread??0,left=Math.min(0,(s?.offsetX??0)-spread-blur),right=Math.max(d.width,d.width+(s?.offsetX??0)+spread+blur),top=Math.min(0,(s?.offsetY??0)-spread-blur),bottom=Math.max(d.height,d.height+(s?.offsetY??0)+spread+blur),v=(x:number,y:number):number[]=>{const p=rotate(d.x+x,d.y+y,d);return[p[0]/plan.width*2-1,1-p[1]/plan.height*2,x,y];};return new Float32Array([...v(left,top),...v(right,top),...v(left,bottom),...v(left,bottom),...v(right,top),...v(right,bottom)]); };
  const styledRectangleUniform = (d: Extract<InternalGpuFramePlan["draws"][number],{kind:"styledRect"}>): Float32Array => { const s=d.shadow,values=new Float32Array(20);values.set([d.width,d.height,d.radius,d.strokeWidth]);values.set(s?[s.offsetX,s.offsetY,s.blur,s.spread]:[0,0,0,0],4);values.set(premultiply(d.fill),8);values.set(premultiply(d.stroke),12);values.set(s?premultiply(s.color):[0,0,0,0],16);return values; };
  for (const draw of plan.draws) if (draw.kind === "image" && !state.images.has(draw.resourceId)) return fail("gpu_render_failed", `GPU image resource '${draw.resourceId}' was not uploaded.`);
  for(const draw of plan.draws)if(draw.kind==="environment"&&((draw.sceneResourceId&&!state.images.has(draw.sceneResourceId))||(draw.effectMaskResourceId&&!state.images.has(draw.effectMaskResourceId))))return fail("gpu_render_failed",`GPU environment '${draw.id}' references an image resource that was not uploaded.`);
  for (const draw of plan.draws) if (draw.kind === "text" && !state.textSurfaces.has(draw.surfaceId)) return fail("gpu_render_failed", `GPU text surface '${draw.surfaceId}' was not prepared.`);
  const gradientPipeline = state.gradientPipeline; const additiveGradientPipeline = state.additiveGradientPipeline;
  if (plan.draws.some((draw) => draw.kind === "gradientRect") && (!gradientPipeline || !additiveGradientPipeline || typeof bufferUsage.UNIFORM !== "number")) return fail("gpu_render_failed", "The persistent GPU gradient pipeline is unavailable.");
  const installedGradientPipeline = gradientPipeline as { getBindGroupLayout(index: number): unknown };
  const installedAdditiveGradientPipeline = additiveGradientPipeline as { getBindGroupLayout(index: number): unknown };
  const styledRectanglePipeline = state.styledRectanglePipeline; const additiveStyledRectanglePipeline = state.additiveStyledRectanglePipeline;
  if (plan.draws.some((draw) => draw.kind === "styledRect") && (!styledRectanglePipeline || !additiveStyledRectanglePipeline || typeof bufferUsage.UNIFORM !== "number")) return fail("gpu_render_failed", "The persistent GPU styled rectangle pipeline is unavailable.");
  const installedStyledRectanglePipeline = styledRectanglePipeline as { getBindGroupLayout(index: number): unknown };
  const installedAdditiveStyledRectanglePipeline = additiveStyledRectanglePipeline as { getBindGroupLayout(index: number): unknown };
  const hasChromaMatteCleanup = (key: NonNullable<Extract<InternalGpuFramePlan["draws"][number], { kind: "image" }> ["chromaKey"]>): boolean => { const matte = key.matte; return matte.denoiseRadiusPx !== 0 || matte.growShrinkPx !== 0 || matte.chokePx !== 0 || matte.featherPx !== 0 || matte.blackClip !== 0 || matte.whiteClip !== 1; };
  const needsChromaMatteCleanup = plan.draws.some((draw) => draw.kind === "image" && draw.chromaKey !== undefined && hasChromaMatteCleanup(draw.chromaKey));
  const hasLayerComposite = plan.draws.some((draw) => draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd" && (draw.kind === "environment" || draw.kind === "material" || draw.kind === "motionBlurStart" || draw.kind === "groupStart" || (draw.kind === "image" && draw.chromaKey !== undefined && hasChromaMatteCleanup(draw.chromaKey)) || draw.blendMode !== "normal" || draw.effects !== null || draw.mask !== undefined)); const blendPipeline = state.blendPipeline;
  if (hasLayerComposite && (!blendPipeline || typeof bufferUsage.UNIFORM !== "number" || typeof textureUsage.TEXTURE_BINDING !== "number")) return fail("gpu_render_failed", "The persistent GPU composite pipeline is unavailable.");
  const installedBlendPipeline = blendPipeline as { getBindGroupLayout(index: number): unknown };
  const hasGlow = plan.draws.some((draw) => draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd" && draw.effects?.glow); const hasBlur = plan.draws.some((draw) => draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd" && ((draw.effects?.blur ?? 0) > 0 || (draw.effects?.glow?.radius ?? 0) > 0)); const blurPipeline = state.blurPipeline;
  if (hasBlur && (!blurPipeline || typeof bufferUsage.UNIFORM !== "number" || typeof textureUsage.TEXTURE_BINDING !== "number")) return fail("gpu_render_failed", "The persistent GPU blur pipeline is unavailable.");
  const installedBlurPipeline = blurPipeline as { getBindGroupLayout(index: number): unknown };
  const glowPipeline = state.glowPipeline;
  if (hasGlow && (!glowPipeline || typeof bufferUsage.UNIFORM !== "number" || typeof textureUsage.TEXTURE_BINDING !== "number")) return fail("gpu_render_failed", "The persistent GPU glow pipeline is unavailable.");
  const installedGlowPipeline = glowPipeline as { getBindGroupLayout(index: number): unknown };
  const hasMask = plan.draws.some((draw) => draw.kind !== "adjustment" && draw.kind !== "motionBlurEnd" && draw.kind !== "groupEnd" && draw.mask !== undefined); const maskPipeline = state.maskPipeline;
  if (hasMask && (!maskPipeline || typeof bufferUsage.UNIFORM !== "number" || typeof textureUsage.TEXTURE_BINDING !== "number")) return fail("gpu_render_failed", "The persistent GPU mask pipeline is unavailable.");
  const installedMaskPipeline = maskPipeline as { getBindGroupLayout(index: number): unknown };
  const hasAdjustment = plan.draws.some((draw) => draw.kind === "adjustment"); const adjustmentPipeline = state.adjustmentPipeline;
  if (hasAdjustment && (!adjustmentPipeline || typeof bufferUsage.UNIFORM !== "number" || typeof textureUsage.TEXTURE_BINDING !== "number")) return fail("gpu_render_failed", "The persistent GPU adjustment pipeline is unavailable.");
  const installedAdjustmentPipeline = adjustmentPipeline as { getBindGroupLayout(index: number): unknown };
  const scene3dPipeline=state.scene3dPipeline;if(plan.draws.some((draw)=>draw.kind==="scene3d")&&(!scene3dPipeline||typeof bufferUsage.INDEX!=="number"||typeof bufferUsage.UNIFORM!=="number"))return fail("gpu_render_failed","The persistent GPU scene3d pipeline is unavailable.");
  const installedScene3dPipeline=scene3dPipeline as {getBindGroupLayout(index:number):unknown};
  const environmentPipeline=state.environmentPipeline,additiveEnvironmentPipeline=state.additiveEnvironmentPipeline;
  const hasTemporalEnvironment=plan.draws.some((draw,index)=>draw.kind==="motionBlurStart"&&plan.draws[index+1]?.kind==="environment");
  if(plan.draws.some((draw)=>draw.kind==="environment")&&(!environmentPipeline||typeof bufferUsage.UNIFORM!=="number"||typeof textureUsage.TEXTURE_BINDING!=="number"))return fail("gpu_render_failed","The persistent GPU environment pipeline is unavailable.");
  if(hasTemporalEnvironment&&!additiveEnvironmentPipeline)return fail("gpu_render_failed","The persistent GPU temporal environment pipeline is unavailable.");
  const installedEnvironmentPipeline=environmentPipeline as {getBindGroupLayout(index:number):unknown};
  const installedAdditiveEnvironmentPipeline=additiveEnvironmentPipeline as {getBindGroupLayout(index:number):unknown};
  const materialPipeline=state.materialPipeline;if(plan.draws.some((draw)=>draw.kind==="material")&&(!materialPipeline||typeof bufferUsage.UNIFORM!=="number"))return fail("gpu_render_failed","The persistent GPU material pipeline is unavailable.");
  const installedMaterialPipeline=materialPipeline as {getBindGroupLayout(index:number):unknown};
  const chromaKeyPipeline=state.chromaKeyPipeline;if(plan.draws.some((draw)=>draw.kind==="image"&&draw.chromaKey!==undefined)&&(!chromaKeyPipeline||typeof bufferUsage.UNIFORM!=="number"))return fail("gpu_render_failed","The persistent GPU chroma-key pipeline is unavailable.");
  const installedChromaKeyPipeline=chromaKeyPipeline as {getBindGroupLayout(index:number):unknown};
  const chromaMatteSeedPipeline = state.chromaMatteSeedPipeline; const chromaMatteCleanupPipeline = state.chromaMatteCleanupPipeline; const chromaMattePresentPipeline = state.chromaMattePresentPipeline; const additiveChromaMattePresentPipeline = state.additiveChromaMattePresentPipeline;
  if (needsChromaMatteCleanup && (!chromaMatteSeedPipeline || !chromaMatteCleanupPipeline || !chromaMattePresentPipeline || !additiveChromaMattePresentPipeline || typeof bufferUsage.UNIFORM !== "number" || typeof textureUsage.TEXTURE_BINDING !== "number")) return fail("gpu_render_failed", "The persistent GPU chroma matte-cleanup pipelines are unavailable.");
  const installedChromaMatteSeedPipeline = chromaMatteSeedPipeline as { getBindGroupLayout(index:number): unknown };
  const installedChromaMatteCleanupPipeline = chromaMatteCleanupPipeline as { getBindGroupLayout(index:number): unknown };
  const installedChromaMattePresentPipeline = chromaMattePresentPipeline as { getBindGroupLayout(index:number): unknown };
  const installedAdditiveChromaMattePresentPipeline = additiveChromaMattePresentPipeline as { getBindGroupLayout(index:number): unknown };
  let validationScopeOpen = false;
  try {
    state.device.pushErrorScope("validation"); validationScopeOpen = true;
    const arena = pageResources.takeReservedFrameArena(plan.fingerprint);
    pageResources.beginFrame();
    const encoder = state.device.createCommandEncoder();
    let environmentUniformSlot = 0, environmentCompositeSlot = 32;
    const clearTexture=(texture:TextureFacade,clearValue:number[]):void=>{const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue,loadOp:"clear",storeOp:"store"}]});pass.end();};
    const root = arena.root as Surface;clearTexture(root.current,premultiply(plan.clear));
    const groupSurfaces = arena.groups as Surface[];
    const drawPrimitive = (pass: Pass, draw: InternalGpuLegacyPrimitiveDraw, additive = false, chromaMatteSeed = false): void => {
      if (draw.kind === "particleCompute") throw new Error("The fixed GPU compute particle pipeline was not installed.");
      const data = draw.kind === "rect" ? rectVertices(draw) : draw.kind === "ellipse" ? ellipse(draw) : draw.kind === "triangles" ? triangles(draw) : draw.kind === "coloredTriangles" ? coloredTriangles(draw) : draw.kind === "image" ? image(draw) : draw.kind === "text" ? textImage(draw) : draw.kind === "gradientRect" ? gradientVertices(draw) : draw.kind === "styledRect" ? styledRectangleVertices(draw) : instances(draw.points);
      if (data.byteLength === 0) return;
      if (data.byteLength > state.limits.maxBufferSize) throw new Error("GPU primitive data exceeds the explicit adapter buffer limit.");
      const staticInstances = draw.kind === "points" && draw.instanceBufferMode === "static";
      const buffer = staticInstances ? state.instanceBuffers?.acquire(data) : pageResources.acquireBuffer("vertex", data.byteLength, bufferUsage.VERTEX | bufferUsage.COPY_DST);
      if (!buffer) throw new Error("GPU static point buffer cache was not installed.");
      if (!staticInstances) state.device.queue.writeBuffer(buffer,0,data);
      if(draw.kind==="gradientRect"||draw.kind==="styledRect"){const uniform=draw.kind==="gradientRect"?gradientUniform(draw):styledRectangleUniform(draw),pipeline=draw.kind==="gradientRect"?(additive?installedAdditiveGradientPipeline:installedGradientPipeline):(additive?installedAdditiveStyledRectanglePipeline:installedStyledRectanglePipeline),uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST);state.device.queue.writeBuffer(uniformBuffer,0,uniform);pass.setPipeline(pipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniformBuffer}}]}));}
      else if(draw.kind==="image"&&draw.chromaKey){const key=draw.chromaKey,uniform=new Float32Array([key.keyColor.r,key.keyColor.g,key.keyColor.b,1,key.similarity,key.smoothness,key.shadow,key.spillSuppression,key.spillBalance,key.edgeColorCorrection,0,0]),uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST),resource=state.images.get(draw.resourceId),pipeline=chromaMatteSeed?installedChromaMatteSeedPipeline:installedChromaKeyPipeline;if(!resource)throw new Error("GPU chroma-key image resource changed after admission.");state.device.queue.writeBuffer(uniformBuffer,0,uniform);pass.setPipeline(pipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:state.imageSampler},{binding:1,resource:resource.texture.createView()},{binding:2,resource:{buffer:uniformBuffer}}]}));}
      else {
        const pipeline = draw.kind === "rect" || draw.kind === "triangles" || draw.kind === "coloredTriangles" ? (additive?state.additiveRectPipeline:state.rectPipeline) : draw.kind === "ellipse" ? (additive?state.additiveEllipsePipeline:state.ellipsePipeline) : draw.kind === "image" || draw.kind === "text" ? (additive?state.additiveImagePipeline:state.imagePipeline) : (additive?state.additivePointPipeline:state.pointPipeline); pass.setPipeline(pipeline);
        if (draw.kind === "image" || draw.kind === "text") {
          const resource = draw.kind === "image" ? state.images.get(draw.resourceId) : state.textSurfaces.get(draw.surfaceId); if (!resource) throw new Error("GPU image surface changed after admission.");
          const bindGroup = additive ? state.device.createBindGroup({ layout: state.additiveImagePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: state.imageSampler }, { binding: 1, resource: resource.texture.createView() }] }) : resource.bindGroup;
          pass.setBindGroup(0, bindGroup); }}
      pass.setVertexBuffer(0,buffer);
      if (draw.kind === "points") pass.draw(6, draw.points.length); else pass.draw(draw.kind === "triangles" || draw.kind === "coloredTriangles" ? draw.vertices.length : 6);
    };
    const renderChromaMatteCleanup = (draw: Extract<InternalGpuFramePlan["draws"][number], { kind: "image" }>, output: TextureFacade, additive: boolean): void => {
      const key = draw.chromaKey;
      const cleanupSurface = arena.keyCleanup as Surface | null;
      if (!key || !cleanupSurface || !cleanupSurface.source || !cleanupSurface.target) throw new Error("GPU chroma matte-cleanup textures were not allocated.");
      clearTexture(cleanupSurface.current, [0, 0, 0, 0]);
      const seedPass = encoder.beginRenderPass({ colorAttachments: [{ view: cleanupSurface.current.createView(), loadOp: "load", storeOp: "store" }] });
      drawPrimitive(seedPass, draw, false, true); seedPass.end();
      let active = cleanupSurface.current;
      const next = (): TextureFacade => active === cleanupSurface.source ? cleanupSurface.target! : cleanupSurface.source!;
      const stage = (mode: number, radius: number, grow = false, blackClip = 0, whiteClip = 1): void => {
        const outputTexture = next();
        const uniform = new Float32Array([mode, radius, grow ? 1 : 0, blackClip, whiteClip, 0, 0, 0]);
        const uniformBuffer = pageResources.acquireBuffer("uniform", uniform.byteLength, bufferUsage.UNIFORM | bufferUsage.COPY_DST);
        state.device.queue.writeBuffer(uniformBuffer, 0, uniform);
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: outputTexture.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
        pass.setPipeline(installedChromaMatteCleanupPipeline);
        pass.setBindGroup(0, state.device.createBindGroup({ layout: installedChromaMatteCleanupPipeline.getBindGroupLayout(0), entries: [{ binding: 1, resource: active.createView() }, { binding: 2, resource: cleanupSurface.current.createView() }, { binding: 3, resource: { buffer: uniformBuffer } }] }));
        pass.draw(3); pass.end(); active = outputTexture;
      };
      const matte = key.matte;
      if (matte.denoiseRadiusPx > 0) { stage(0, matte.denoiseRadiusPx); stage(1, matte.denoiseRadiusPx); }
      if (matte.growShrinkPx !== 0) { const radius = Math.abs(matte.growShrinkPx); stage(2, radius, matte.growShrinkPx > 0); stage(3, radius, matte.growShrinkPx > 0); }
      if (matte.chokePx > 0) { stage(2, matte.chokePx, false); stage(3, matte.chokePx, false); }
      if (matte.featherPx > 0) { stage(4, matte.featherPx); stage(5, matte.featherPx); }
      stage(6, 0, false, matte.blackClip, matte.whiteClip);
      const uniform = new Float32Array([draw.opacity, 0, 0, 0]);
      const uniformBuffer = pageResources.acquireBuffer("uniform", uniform.byteLength, bufferUsage.UNIFORM | bufferUsage.COPY_DST);
      state.device.queue.writeBuffer(uniformBuffer, 0, uniform);
      const presentPass = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: "load", storeOp: "store" }] });
      const pipeline = additive ? installedAdditiveChromaMattePresentPipeline : installedChromaMattePresentPipeline;
      presentPass.setPipeline(pipeline);
      presentPass.setBindGroup(0, state.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: cleanupSurface.current.createView() }, { binding: 1, resource: active.createView() }, { binding: 2, resource: { buffer: uniformBuffer } }] }));
      presentPass.draw(3); presentPass.end();
    };
    const renderScene3d=(texture:TextureFacade,draw:Extract<InternalGpuFramePlan["draws"][number],{kind:"scene3d"}>):void=>{
      const backgroundPass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:"load",storeOp:"store"}]});drawPrimitive(backgroundPass,{kind:"rect",id:`${draw.id}.background`,blendMode:"normal",effects:null,x:0,y:0,width:plan.width,height:plan.height,rotationDeg:0,pivotX:plan.width/2,pivotY:plan.height/2,color:draw.background});backgroundPass.end();
      const depthTexture=arena.depth;if(!depthTexture)throw new Error("GPU depth texture was not allocated.");
      const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:"load",storeOp:"store"}],depthStencilAttachment:{view:depthTexture.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"discard"}});pass.setPipeline(installedScene3dPipeline);
      for(const object of draw.objects){const vertexData=new Float32Array(object.vertices),indexData=new Uint32Array(object.indices),uniform=new Float32Array(48);uniform.set(draw.viewProjection,0);uniform.set(object.model,16);uniform.set([...draw.lightDirection,draw.ambient],32);uniform.set([draw.lightColor.r,draw.lightColor.g,draw.lightColor.b,draw.intensity],36);uniform.set([object.color.r,object.color.g,object.color.b,object.color.a],40);uniform.set([object.emissive,draw.opacity,0,0],44);const vertexBuffer=pageResources.acquireBuffer("vertex",vertexData.byteLength,bufferUsage.VERTEX|bufferUsage.COPY_DST),indexBuffer=pageResources.acquireBuffer("index",indexData.byteLength,bufferUsage.INDEX|bufferUsage.COPY_DST),uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST);state.device.queue.writeBuffer(vertexBuffer,0,vertexData);state.device.queue.writeBuffer(indexBuffer,0,indexData);state.device.queue.writeBuffer(uniformBuffer,0,uniform);pass.setBindGroup(0,state.device.createBindGroup({layout:installedScene3dPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniformBuffer}}]}));pass.setVertexBuffer(0,vertexBuffer);pass.setIndexBuffer(indexBuffer,"uint32");pass.drawIndexed(object.indices.length);}
      pass.end();
    };
    const renderEnvironment=(texture:TextureFacade,dummy:TextureFacade,draw:Extract<InternalGpuFramePlan["draws"][number],{kind:"environment"}>,additive=false):void=>{
      const uniform=new Float32Array(52),kind=draw.environmentKind==="rain"?0:draw.environmentKind==="water"?1:draw.environmentKind==="snow"?2:3;uniform.set([plan.width,plan.height,draw.timeSeconds,draw.seed/4294967296]);uniform.set([draw.x,draw.y,draw.width,draw.height],4);uniform.set([draw.rotationDeg*Math.PI/180,draw.pivotX,draw.pivotY,draw.opacity],8);uniform.set([kind,draw.mode==="overlay"?1:0,draw.sceneResourceId?1:0,draw.effectMaskResourceId?1:0],12);draw.colors.forEach((color,index)=>uniform.set([color.r,color.g,color.b,color.a],16+index*4));uniform.set(draw.parameters,36);
      const sceneTexture=draw.sceneResourceId?state.images.get(draw.sceneResourceId)?.texture:dummy,maskTexture=draw.effectMaskResourceId?state.images.get(draw.effectMaskResourceId)?.texture:dummy;if(!sceneTexture||!maskTexture)throw new Error("GPU environment resource identity changed after admission.");if(sceneTexture===texture||maskTexture===texture)throw new Error("GPU environment cannot sample its render attachment.");if(environmentUniformSlot>=32)throw new Error("GPU environment sample reservation exceeded its fixed capacity.");const uniformBuffer=pageResources.environmentUniformBuffer(),uniformOffset=environmentUniformSlot++*256,pipeline=additive?installedAdditiveEnvironmentPipeline:installedEnvironmentPipeline;state.device.queue.writeBuffer(uniformBuffer,uniformOffset,uniform);const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:[0,0,0,0],loadOp:additive?"load":"clear",storeOp:"store"}]});pass.setPipeline(pipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:state.imageSampler},{binding:1,resource:sceneTexture.createView()},{binding:2,resource:maskTexture.createView()},{binding:3,resource:{buffer:uniformBuffer,offset:uniformOffset,size:208}}]}));pass.draw(3);pass.end();
    };
    const renderMaterial=(texture:TextureFacade,draw:Extract<InternalGpuFramePlan["draws"][number],{kind:"material"}>):void=>{
      const uniform=new Float32Array(36),preset=draw.preset==="plasma"?0:draw.preset==="hologram"?1:draw.preset==="energy"?2:3;
      uniform.set([plan.width,plan.height,draw.timeSeconds,draw.seed/4294967296]);uniform.set([draw.x,draw.y,draw.width,draw.height],4);uniform.set([draw.rotationDeg*Math.PI/180,draw.pivotX,draw.pivotY,draw.opacity],8);uniform.set([preset,0,0,0],12);draw.colors.forEach((color,index)=>uniform.set([color.r,color.g,color.b,color.a],16+index*4));uniform.set(draw.parameters,28);
      const uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST);state.device.queue.writeBuffer(uniformBuffer,0,uniform);const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});pass.setPipeline(installedMaterialPipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:installedMaterialPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniformBuffer}}]}));pass.draw(3);pass.end();
    };
    const blurPass = (input: TextureFacade, output: TextureFacade, directionX: number, directionY: number, radius: number): void => { const uniform=new Float32Array([directionX,directionY,radius,0]),uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST);state.device.queue.writeBuffer(uniformBuffer,0,uniform);const pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});pass.setPipeline(installedBlurPipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:installedBlurPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:state.imageSampler},{binding:1,resource:input.createView()},{binding:2,resource:{buffer:uniformBuffer}}]}));pass.draw(3);pass.end(); };
    const glowPass = (source: TextureFacade, blurred: TextureFacade, output: TextureFacade, draw: InternalCompositeDraw): void => { const glow=draw.effects?.glow;if(!glow)throw new Error("GPU glow state was not available.");const effect=draw.effects??{blur:0,brightness:1,contrast:1,saturate:1,grayscale:0,glow:null},uniform=new Float32Array([glow.color.r,glow.color.g,glow.color.b,glow.color.a,effect.brightness,effect.contrast,effect.saturate,effect.grayscale]),uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST);state.device.queue.writeBuffer(uniformBuffer,0,uniform);const pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});pass.setPipeline(installedGlowPipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:installedGlowPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:source.createView()},{binding:1,resource:blurred.createView()},{binding:2,resource:{buffer:uniformBuffer}}]}));pass.draw(3);pass.end(); };
    const maskPass = (input: TextureFacade, output: TextureFacade, draw: InternalCompositeDraw): void => { const mask=draw.mask;if(!mask)throw new Error("GPU mask state was not available.");const shape=mask.shape==="ellipse"?1:mask.shape==="triangle"?2:0,uniform=new Float32Array([mask.x,mask.y,mask.width,mask.height,mask.rotationDeg*Math.PI/180,mask.pivotX,mask.pivotY,mask.radius,shape,mask.inverted?1:0,mask.opacity,mask.featherPx]),uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST);state.device.queue.writeBuffer(uniformBuffer,0,uniform);const pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});pass.setPipeline(installedMaskPipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:installedMaskPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:input.createView()},{binding:1,resource:{buffer:uniformBuffer}}]}));pass.draw(3);pass.end(); };
    const adjustmentPass = (input: TextureFacade, output: TextureFacade, draw: Extract<InternalGpuFramePlan["draws"][number],{kind:"adjustment"}>): void => { const uniform=new Float32Array(12),v=draw.vignette,g=draw.filmGrain;uniform.set(v?[v.color.r,v.color.g,v.color.b,v.color.a]:[0,0,0,0]);uniform.set(v?[v.amount,v.softness,1,0]:[0,0,0,0],4);uniform.set(g?[g.amount,g.size]:[0,1],8);const words=new Uint32Array(uniform.buffer);words[10]=g?.frameSeed??0;words[11]=g?1:0;const uniformBuffer=pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST);state.device.queue.writeBuffer(uniformBuffer,0,uniform);const pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});pass.setPipeline(installedAdjustmentPipeline);pass.setBindGroup(0,state.device.createBindGroup({layout:installedAdjustmentPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:input.createView()},{binding:1,resource:{buffer:uniformBuffer}}]}));pass.draw(3);pass.end(); };
    const blendModes=["multiply","screen","overlay","darken","lighten","color-dodge","color-burn","hard-light","soft-light","difference","exclusion","hue","saturation","color","luminosity","plus-lighter"];
    const compositeLayer = (destination:Surface,draw: InternalCompositeDraw, source: TextureFacade, fixedEnvironmentSlot?: number): void => {
      if (!destination.source || !destination.target) throw new Error("GPU blend textures were not allocated."); let compositeSource:TextureFacade=source;
      if (draw.mask) { if (!destination.scratch) throw new Error("GPU mask texture was not allocated.");maskPass(source,destination.scratch,draw);compositeSource=destination.scratch; }
      if ((draw.effects?.blur ?? 0) > 0) { if (!destination.scratch) throw new Error("GPU blur texture was not allocated.");const horizontal=compositeSource===destination.source?destination.scratch:destination.source;const vertical=compositeSource===destination.source?destination.source:destination.scratch;blurPass(compositeSource,horizontal,1,0,draw.effects?.blur??0);blurPass(horizontal,vertical,0,1,draw.effects?.blur??0);compositeSource=vertical; }
      let applyColorEffects=true;
      if (draw.effects?.glow) { if (!destination.scratch) throw new Error("GPU glow texture was not allocated.");let glowAlpha:TextureFacade=compositeSource;if(draw.effects.glow.radius>0){const horizontal=compositeSource===destination.source?destination.scratch:destination.source;blurPass(compositeSource,horizontal,1,0,draw.effects.glow.radius);blurPass(horizontal,destination.target,0,1,draw.effects.glow.radius);glowAlpha=destination.target;}const glowOutput=compositeSource===destination.source?destination.scratch:destination.source;glowPass(compositeSource,glowAlpha,glowOutput,draw);compositeSource=glowOutput;applyColorEffects=false; }
      const index=draw.blendMode==="normal"?0:blendModes.indexOf(draw.blendMode)+1,effect=applyColorEffects?(draw.effects??{blur:0,brightness:1,contrast:1,saturate:1,grayscale:0,glow:null}):{brightness:1,contrast:1,saturate:1,grayscale:0},group=draw.kind==="groupStart"?draw:null,uniform=new Float32Array(16);uniform.set([index,0,0,0,effect.brightness,effect.contrast,effect.saturate,effect.grayscale]);uniform.set(group?[group.x,group.y,group.scale,group.rotationDeg*Math.PI/180,group.pivotX,group.pivotY,group.opacity,1]:[0,0,1,0,0,0,1,0],8);const uniformBuffer=fixedEnvironmentSlot===undefined?pageResources.acquireBuffer("uniform",uniform.byteLength,bufferUsage.UNIFORM|bufferUsage.COPY_DST):pageResources.environmentUniformBuffer(),uniformOffset=fixedEnvironmentSlot===undefined?0:fixedEnvironmentSlot*256;if(fixedEnvironmentSlot!==undefined&&(fixedEnvironmentSlot<32||fixedEnvironmentSlot>=36))throw new Error("GPU temporal environment composite reservation exceeded its fixed capacity.");state.device.queue.writeBuffer(uniformBuffer,uniformOffset,uniform);
      const blendPass=encoder.beginRenderPass({colorAttachments:[{view:destination.target.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});blendPass.setPipeline(installedBlendPipeline);blendPass.setBindGroup(0,state.device.createBindGroup({layout:installedBlendPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:destination.current.createView()},{binding:1,resource:compositeSource.createView()},{binding:2,resource:fixedEnvironmentSlot===undefined?{buffer:uniformBuffer}:{buffer:uniformBuffer,offset:uniformOffset,size:64}}]}));blendPass.draw(3);blendPass.end();const previous=destination.current;destination.current=destination.target;destination.target=previous;
    };
    const renderRange=(destination:Surface,start:number,end:number,depth:number):void=>{for(let drawIndex=start;drawIndex<end;drawIndex+=1){const draw=plan.draws[drawIndex];
      if(draw.kind==="adjustment"){if(!destination.target)throw new Error("GPU adjustment target was not allocated.");adjustmentPass(destination.current,destination.target,draw);const previous=destination.current;destination.current=destination.target;destination.target=previous;continue;}
      if(draw.kind==="motionBlurEnd"||draw.kind==="groupEnd")throw new Error("GPU isolated group closed without renderer ownership.");
      if(draw.kind==="groupStart"){const endIndex=drawIndex+draw.drawCount+1,close=plan.draws[endIndex],child=groupSurfaces[depth];if(!child||!close||close.kind!=="groupEnd"||close.groupId!==draw.id)throw new Error("GPU group grammar changed after admission.");clearTexture(child.current,[0,0,0,0]);renderRange(child,drawIndex+1,endIndex,depth+1);compositeLayer(destination,draw,child.current);drawIndex=endIndex;continue;}
      if(draw.kind==="motionBlurStart"){if(!destination.source)throw new Error("GPU temporal texture was not allocated.");const first=plan.draws[drawIndex+1],environmentOnly=first?.kind==="environment",temporalTarget=environmentOnly?pageResources.environmentAccumulator():destination.source;clearTexture(temporalTarget,[0,0,0,0]);if(environmentOnly&&draw.drawCount!==draw.sampleCount)throw new Error("GPU temporal environment sample count changed after admission.");for(let child=1;child<=draw.drawCount;child+=1){const sample=plan.draws[drawIndex+child];if(!sample||sample.kind==="adjustment"||sample.kind==="scene3d"||sample.kind==="material"||sample.kind==="particleCompute"||sample.kind==="motionBlurStart"||sample.kind==="motionBlurEnd"||sample.kind==="groupStart"||sample.kind==="groupEnd"||sample.blendMode!=="normal"||sample.effects!==null||sample.mask!==undefined||environmentOnly!== (sample.kind==="environment"))throw new Error("GPU temporal sample grammar changed after admission.");if(sample.kind==="environment"){renderEnvironment(temporalTarget,destination.current,sample,true);continue;}if(sample.kind==="image"&&sample.chromaKey&&hasChromaMatteCleanup(sample.chromaKey)){renderChromaMatteCleanup(sample,destination.source,true);}else{const pass=encoder.beginRenderPass({colorAttachments:[{view:destination.source.createView(),loadOp:"load",storeOp:"store"}]});drawPrimitive(pass,sample,true);pass.end();}}compositeLayer(destination,draw,temporalTarget,environmentOnly?environmentCompositeSlot++:undefined);drawIndex+=draw.drawCount+1;continue;}
      if(draw.kind==="scene3d"){if(draw.blendMode==="normal"&&draw.effects===null&&draw.mask===undefined)renderScene3d(destination.current,draw);else{if(!destination.source)throw new Error("GPU scene3d composite texture was not allocated.");clearTexture(destination.source,[0,0,0,0]);renderScene3d(destination.source,draw);compositeLayer(destination,draw,destination.source);}continue;}
      if(draw.kind==="environment"){if(!destination.source)throw new Error("GPU environment texture was not allocated.");renderEnvironment(destination.source,destination.current,draw);compositeLayer(destination,draw,destination.source,environmentCompositeSlot++);continue;}
      if(draw.kind==="material"){if(!destination.source)throw new Error("GPU material texture was not allocated.");renderMaterial(destination.source,draw);compositeLayer(destination,draw,destination.source);continue;}
      if(draw.kind==="image"&&draw.chromaKey&&hasChromaMatteCleanup(draw.chromaKey)){if(!destination.source)throw new Error("GPU chroma matte-cleanup composite texture was not allocated.");clearTexture(destination.source,[0,0,0,0]);renderChromaMatteCleanup(draw,destination.source,false);compositeLayer(destination,draw,destination.source);continue;}
      if(draw.kind==="particleCompute"){if(draw.schema==="shellx-motion/gpu-compute-particle-field@2"){if(draw.blendMode!=="normal"||draw.effects!==null)throw new Error("GPU v2 particle admission lost its fixed composite contract.");const input:GpuPageParticleV2Draw={...draw,blendMode:"normal",effects:null};const compute=state.computeParticlesV2;if(!compute)throw new Error("The fixed v2 GPU compute particle pipeline was not installed.");if(input.mask===undefined){compute.render(input,plan.width,plan.height,encoder,destination.current);}else{if(!destination.source)throw new Error("GPU v2 particle composite texture was not allocated.");clearTexture(destination.source,[0,0,0,0]);compute.render(input,plan.width,plan.height,encoder,destination.source);compositeLayer(destination,draw,destination.source);}continue;}const compute=state.computeParticles;if(!compute)throw new Error("The fixed GPU compute particle pipeline was not installed.");const buffer=compute.render(draw,plan.width,plan.height,encoder),pass=encoder.beginRenderPass({colorAttachments:[{view:destination.current.createView(),loadOp:"load",storeOp:"store"}]});pass.setPipeline(state.pointPipeline);pass.setVertexBuffer(0,buffer);pass.draw(6,draw.count);pass.end();continue;}
      if(draw.blendMode==="normal"&&draw.effects===null&&draw.mask===undefined){const pass=encoder.beginRenderPass({colorAttachments:[{view:destination.current.createView(),loadOp:"load",storeOp:"store"}]});drawPrimitive(pass,draw);pass.end();continue;}
      if(!destination.source)throw new Error("GPU blend texture was not allocated.");clearTexture(destination.source,[0,0,0,0]);const sourcePass=encoder.beginRenderPass({colorAttachments:[{view:destination.source.createView(),loadOp:"load",storeOp:"store"}]});drawPrimitive(sourcePass,draw);sourcePass.end();compositeLayer(destination,draw,destination.source);
    }};
    renderRange(root,0,plan.draws.length,0);
    encoder.copyTextureToBuffer({texture:root.current},{buffer:arena.readback,bytesPerRow,rowsPerImage:plan.height},{width:plan.width,height:plan.height,depthOrArrayLayers:1}); state.device.queue.submit([encoder.finish()]); await state.device.queue.onSubmittedWorkDone();
    validationScopeOpen = false;
    const validation = await state.device.popErrorScope();
    if (validation) {
      const detail = typeof validation.message === "string" && validation.message.trim()
        ? `: ${validation.message}`
        : ".";
      return fail("gpu_render_failed", `Persistent WebGPU frame validation failed${detail}`);
    }
    if (state.lost) return fail("gpu_device_lost", "The persistent WebGPU device was lost during frame rendering.");
    await arena.readback.mapAsync(mapMode.READ);
    try { const paddedBase64 = readbackBase64(new Uint8Array(arena.readback.getMappedRange())); pageResources.completeFrame(environmentUniformSlot); return { ok: true, bytesPerRow, paddedBase64 }; } finally { arena.readback.unmap(); }
  } catch {
    if (validationScopeOpen) await state.device.popErrorScope().catch(() => null);
    return fail(state.lost ? "gpu_device_lost" : "gpu_render_failed", state.lost ? "The persistent WebGPU device was lost during frame rendering." : "Persistent WebGPU frame rendering failed.");
  }
}

export { uploadWebGpuPageSessionImages } from "./gpu-page-session-images";
export { closeWebGpuPageSession } from "./gpu-page-session-close";
