import type { GpuRuntimeFailure } from "./gpu-runtime-types";

/** The B7 preview always clears the isolated trace target to transparent RGBA. */
export const GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_BACKGROUND = "transparent-rgba@1" as const;
export const GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES = 20;
export const GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_VERTICES = 64;
export const GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_UPLOAD_BYTES = 1_280;
export const GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS = 378;

export interface GpuPageCheckpointStoryboardRetainedTraceInput {
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
  readonly rasterVertexInvocations: number;
  /** Transport encoding of bytes issued by Core. No descriptor or sample reconstruction enters the page. */
  readonly vertexBytesBase64: string;
}

export type GpuPageCheckpointStoryboardRetainedTraceOutput =
  | { ok: true; bytesPerRow: number; paddedBase64: string; cleanup: { sampleBufferDestroyed: true; rasterControlBufferDestroyed: true; targetDestroyed: true; readbackBufferDestroyed: true } }
  | { ok: false; failure: GpuRuntimeFailure };

/**
 * Dedicated B7 raster executor. It deliberately does not call the general page-frame compositor:
 * Core-issued sample bytes are the only visual source and this target is transparent.
 */
export async function renderWebGpuPageCheckpointStoryboardRetainedTrace(
  input: GpuPageCheckpointStoryboardRetainedTraceInput,
): Promise<GpuPageCheckpointStoryboardRetainedTraceOutput> {
  // Keep these literal in the evaluated closure: Playwright serializes this function without
  // module bindings, and the browser must independently enforce the same closed ABI.
  const vertexStride = 20;
  const maxSamples = 64;
  const maxUploadBytes = 1_280;
  const maxRasterVertexInvocations = 378;
  type BufferFacade = { destroy?(): void; getMappedRange(): ArrayBuffer; mapAsync(mode: number): Promise<void>; unmap(): void };
  type TextureFacade = { createView(): unknown; destroy?(): void };
  type PipelineFacade = { getBindGroupLayout(index: number): unknown };
  type Pass = { setPipeline(value: PipelineFacade): void; setBindGroup(index: number, value: unknown): void; draw(vertices: number): void; end(): void };
  type Encoder = { beginRenderPass(value: unknown): Pass; copyTextureToBuffer(a: unknown, b: unknown, c: unknown): void; finish(): unknown };
  type Device = {
    createBuffer(value: unknown): BufferFacade;
    createTexture(value: unknown): TextureFacade;
    createShaderModule(value: unknown): unknown;
    createRenderPipeline(value: unknown): PipelineFacade;
    createRenderPipelineAsync?(value: unknown): Promise<PipelineFacade>;
    createBindGroup(value: unknown): unknown;
    createCommandEncoder(): Encoder;
    pushErrorScope(filter: "validation"): void;
    popErrorScope(): Promise<{ message?: unknown } | null>;
    queue: { writeBuffer(buffer: BufferFacade, offset: number, bytes: Uint8Array): void; submit(commands: readonly unknown[]): void; onSubmittedWorkDone(): Promise<void> };
    limits?: { maxTextureDimension2D?: number; maxBufferSize?: number };
  };
  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuPageCheckpointStoryboardRetainedTraceOutput => ({ ok: false, failure: { code, message } });
  const browserGlobal = globalThis as unknown as {
    __shellxMotionGpuSessionV1?: unknown;
    GPUBufferUsage?: { STORAGE?: number; UNIFORM?: number; COPY_DST?: number; MAP_READ?: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT?: number; COPY_SRC?: number };
    GPUMapMode?: { READ?: number };
    atob?(value: string): string;
    btoa?(value: string): string;
  };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as {
    device: Device;
    limits: { maxTextureDimension2D: number; maxBufferSize: number };
    lost: boolean;
    checkpointStoryboardRetainedTraceRasterPipeline?: PipelineFacade;
  } | undefined;
  if (!state) return fail("gpu_render_failed", "The retained-trace page executor requires an open dedicated GPU session.");
  if (state.lost) return fail("gpu_device_lost", "The retained-trace GPU session is already lost.");
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1 || input.width > state.limits.maxTextureDimension2D || input.height > state.limits.maxTextureDimension2D) return fail("gpu_limits_exceeded", "The retained-trace target dimensions are outside the exact device limit.");
  if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1 || input.sampleCount > maxSamples) return fail("gpu_limits_exceeded", "The retained-trace raster must contain exactly 1..64 Core samples.");
  const expectedRasterVertexInvocations = input.sampleCount === 1 ? 6 : (input.sampleCount - 1) * 6;
  if (!Number.isSafeInteger(input.rasterVertexInvocations) || input.rasterVertexInvocations !== expectedRasterVertexInvocations || input.rasterVertexInvocations > maxRasterVertexInvocations) return fail("gpu_limits_exceeded", "The retained-trace raster invocation count does not match its fixed square-cap/segment-quad budget.");
  if (typeof input.vertexBytesBase64 !== "string" || !browserGlobal.atob || !browserGlobal.btoa || !browserGlobal.GPUBufferUsage || !browserGlobal.GPUTextureUsage || !browserGlobal.GPUMapMode) return fail("gpu_render_failed", "The retained-trace page executor lacks the fixed binary transport APIs.");
  let vertexBytes: Uint8Array;
  try {
    const binary = browserGlobal.atob(input.vertexBytesBase64);
    vertexBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return fail("gpu_render_failed", "The retained-trace page executor refused malformed Core vertex bytes.");
  }
  if (vertexBytes.byteLength !== input.sampleCount * vertexStride || vertexBytes.byteLength > maxUploadBytes) return fail("gpu_limits_exceeded", "The retained-trace Core upload does not match the fixed 20-byte sample ABI.");
  const bytesPerRow = Math.ceil((input.width * 4) / 256) * 256;
  const readbackBytes = bytesPerRow * input.height;
  if (!Number.isSafeInteger(readbackBytes) || readbackBytes > state.limits.maxBufferSize) return fail("gpu_limits_exceeded", "The retained-trace readback exceeds the exact device buffer limit.");
  const createPipeline = (descriptor: unknown) => state.device.createRenderPipelineAsync
    ? state.device.createRenderPipelineAsync(descriptor)
    : Promise.resolve(state.device.createRenderPipeline(descriptor));
  let sampleBuffer: BufferFacade | undefined;
  let rasterControlBuffer: BufferFacade | undefined;
  let target: TextureFacade | undefined;
  let readback: BufferFacade | undefined;
  let scopeOpen = false;
  try {
    if (!state.checkpointStoryboardRetainedTraceRasterPipeline) {
      const module = state.device.createShaderModule({ code: `
struct RawSamples { words: array<u32> }
struct RasterControls { sampleCount: f32, width: f32, height: f32, padding: f32 }
struct Sample { position: vec2<f32>, width: f32, shade: f32, opacity: f32 }
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) shade: f32, @location(1) opacity: f32 }
@group(0) @binding(0) var<storage, read> samples: RawSamples;
@group(0) @binding(1) var<uniform> controls: RasterControls;

fn sampleAt(index: u32) -> Sample {
  let offset = index * 5u;
  let signal = unpack4x8unorm(samples.words[offset + 4u]);
  // The packed z word is intentionally never read: B7 rasterization is 2D.
  return Sample(vec2<f32>(bitcast<f32>(samples.words[offset]), bitcast<f32>(samples.words[offset + 1u])), max(0.0, bitcast<f32>(samples.words[offset + 3u])), clamp(signal.x, 0.0, 1.0), clamp(signal.y, 0.0, 1.0));
}

fn motionPixelToNdc(pixel: vec2<f32>) -> vec2<f32> {
  return vec2<f32>((pixel.x / controls.width) * 2.0 - 1.0, 1.0 - (pixel.y / controls.height) * 2.0);
}

fn capCorner(index: u32) -> vec2<f32> {
  switch (index) {
    case 0u: { return vec2<f32>(-1.0, -1.0); }
    case 1u: { return vec2<f32>(1.0, -1.0); }
    case 2u: { return vec2<f32>(1.0, 1.0); }
    case 3u: { return vec2<f32>(-1.0, -1.0); }
    case 4u: { return vec2<f32>(1.0, 1.0); }
    default: { return vec2<f32>(-1.0, 1.0); }
  }
}

@vertex fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let sampleCount = u32(controls.sampleCount);
  var pixel = vec2<f32>(0.0, 0.0);
  var shade = 0.0;
  var opacity = 0.0;
  if (sampleCount == 1u) {
    let sample = sampleAt(0u);
    pixel = sample.position + capCorner(vertexIndex) * (sample.width * 0.5);
    shade = sample.shade;
    opacity = sample.opacity;
  } else {
    let segment = vertexIndex / 6u;
    let corner = vertexIndex % 6u;
    let start = sampleAt(segment);
    let end = sampleAt(segment + 1u);
    let delta = end.position - start.position;
    let segmentLength = length(delta);
    var axis = vec2<f32>(1.0, 0.0);
    if (segmentLength > 0.0) { axis = delta / segmentLength; }
    let normal = vec2<f32>(-axis.y, axis.x);
    let startLeft = start.position + normal * (start.width * 0.5);
    let startRight = start.position - normal * (start.width * 0.5);
    let endLeft = end.position + normal * (end.width * 0.5);
    let endRight = end.position - normal * (end.width * 0.5);
    switch (corner) {
      case 0u: { pixel = startLeft; shade = start.shade; opacity = start.opacity; }
      case 1u: { pixel = startRight; shade = start.shade; opacity = start.opacity; }
      case 2u: { pixel = endLeft; shade = end.shade; opacity = end.opacity; }
      case 3u: { pixel = startRight; shade = start.shade; opacity = start.opacity; }
      case 4u: { pixel = endRight; shade = end.shade; opacity = end.opacity; }
      default: { pixel = endLeft; shade = end.shade; opacity = end.opacity; }
    }
  }
  output.position = vec4<f32>(motionPixelToNdc(pixel), 0.0, 1.0);
  output.shade = shade;
  output.opacity = opacity;
  return output;
}

@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let alpha = clamp(input.opacity, 0.0, 1.0);
  let grayscale = clamp(input.shade, 0.0, 1.0);
  return vec4<f32>(vec3<f32>(grayscale * alpha), alpha);
}
` });
      state.checkpointStoryboardRetainedTraceRasterPipeline = await createPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs", buffers: [] },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] },
        primitive: { topology: "triangle-list" },
      });
    }
    const rasterPipeline = state.checkpointStoryboardRetainedTraceRasterPipeline;
    if (!rasterPipeline) return fail("gpu_render_failed", "The retained-trace raster pipeline could not be retained by the dedicated GPU session.");
    sampleBuffer = state.device.createBuffer({ size: vertexBytes.byteLength, usage: browserGlobal.GPUBufferUsage.STORAGE! | browserGlobal.GPUBufferUsage.COPY_DST! });
    rasterControlBuffer = state.device.createBuffer({ size: 16, usage: browserGlobal.GPUBufferUsage.UNIFORM! | browserGlobal.GPUBufferUsage.COPY_DST! });
    target = state.device.createTexture({ size: { width: input.width, height: input.height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: browserGlobal.GPUTextureUsage.RENDER_ATTACHMENT! | browserGlobal.GPUTextureUsage.COPY_SRC! });
    readback = state.device.createBuffer({ size: readbackBytes, usage: browserGlobal.GPUBufferUsage.MAP_READ! | browserGlobal.GPUBufferUsage.COPY_DST! });
    state.device.queue.writeBuffer(sampleBuffer, 0, vertexBytes);
    const rasterControls = new Float32Array([input.sampleCount, input.width, input.height, 0]);
    state.device.queue.writeBuffer(rasterControlBuffer, 0, new Uint8Array(rasterControls.buffer));
    const bindGroup = state.device.createBindGroup({ layout: rasterPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: sampleBuffer } }, { binding: 1, resource: { buffer: rasterControlBuffer } }] });
    state.device.pushErrorScope("validation"); scopeOpen = true;
    const encoder = state.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
    pass.setPipeline(rasterPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(input.rasterVertexInvocations);
    pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow, rowsPerImage: input.height }, { width: input.width, height: input.height, depthOrArrayLayers: 1 });
    state.device.queue.submit([encoder.finish()]);
    await state.device.queue.onSubmittedWorkDone();
    scopeOpen = false;
    const validation = await state.device.popErrorScope();
    if (validation) return fail("gpu_render_failed", `The retained-trace raster pipeline failed WebGPU validation${typeof validation.message === "string" ? `: ${validation.message}` : "."}`);
    if (state.lost) return fail("gpu_device_lost", "The retained-trace GPU device was lost during its isolated raster draw.");
    await readback.mapAsync(browserGlobal.GPUMapMode.READ!);
    try {
      const bytes = new Uint8Array(readback.getMappedRange());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { ok: true, bytesPerRow, paddedBase64: browserGlobal.btoa(binary), cleanup: { sampleBufferDestroyed: true, rasterControlBufferDestroyed: true, targetDestroyed: true, readbackBufferDestroyed: true } };
    } finally {
      readback.unmap();
    }
  } catch {
    if (scopeOpen) await state.device.popErrorScope().catch(() => null);
    return fail(state.lost ? "gpu_device_lost" : "gpu_render_failed", state.lost ? "The retained-trace GPU device was lost during its isolated raster draw." : "The retained-trace page executor failed its fixed raster draw.");
  } finally {
    sampleBuffer?.destroy?.();
    rasterControlBuffer?.destroy?.();
    target?.destroy?.();
    readback?.destroy?.();
  }
}
