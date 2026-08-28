import type { GpuPageAdapterInfo, GpuPageObservation } from "./gpu-runtime-assessment";
import type { GpuRuntimeFailure, InternalGpuFramePlan } from "./gpu-runtime-types";

export type GpuBrowserFrameOutput =
  | { ok: true; bytesPerRow: number; padded: number[]; runtime: GpuPageObservation }
  | { ok: false; failure: GpuRuntimeFailure };

export interface GpuPageRenderInput {
  plan: InternalGpuFramePlan;
  adapterOptions: { powerPreference: "high-performance" };
}

/**
 * A deliberately self-contained Playwright page function. Every executable
 * helper and both fixed shaders live inside this function so serialization
 * cannot lose a module closure or accept caller-provided code.
 */
export async function renderWebGpuPlan(input: GpuPageRenderInput): Promise<GpuBrowserFrameOutput> {
  type Texture = { createView(): unknown; destroy?(): void };
  type BufferFacade = { destroy?(): void; getMappedRange(): ArrayBuffer; mapAsync(mode: number): Promise<void>; unmap(): void };
  type Pass = { draw(vertexCount: number, instanceCount?: number): void; end(): void; setPipeline(pipeline: unknown): void; setVertexBuffer(slot: number, buffer: BufferFacade): void };
  type Encoder = { beginRenderPass(descriptor: unknown): Pass; copyTextureToBuffer(source: unknown, destination: unknown, copySize: unknown): void; finish(): unknown };
  type Queue = { onSubmittedWorkDone(): Promise<void>; submit(commands: unknown[]): void; writeBuffer(buffer: BufferFacade, offset: number, data: Float32Array): void };
  type Device = {
    createBuffer(descriptor: unknown): BufferFacade;
    createCommandEncoder(): Encoder;
    createRenderPipeline(descriptor: unknown): unknown;
    createShaderModule(descriptor: unknown): unknown;
    createTexture(descriptor: unknown): Texture;
    destroy?(): void;
    limits?: { maxTextureDimension2D?: number; maxBufferSize?: number; maxStorageBufferBindingSize?: number };
    lost?: Promise<unknown>;
    queue: Queue;
  };

  const fail = (code: GpuRuntimeFailure["code"], message: string): GpuBrowserFrameOutput => ({ ok: false, failure: { code, message } });
  const premultiply = (color: { r: number; g: number; b: number; a: number }): [number, number, number, number] =>
    [color.r * color.a, color.g * color.a, color.b * color.a, color.a];
  const rotate = (x: number, y: number, rotationDeg: number, pivotX: number, pivotY: number): [number, number] => {
    if (Math.abs(rotationDeg % 360) < 0.0001) return [x, y];
    const radians = rotationDeg * (Math.PI / 180); const cosine = Math.cos(radians); const sine = Math.sin(radians);
    const localX = x - pivotX; const localY = y - pivotY;
    return [pivotX + (localX * cosine) - (localY * sine), pivotY + (localX * sine) + (localY * cosine)];
  };
  const rectangleVertices = (draw: Extract<InternalGpuFramePlan["draws"][number], { kind: "rect" }>, width: number, height: number): Float32Array => {
    const color = premultiply(draw.color);
    const vertex = (x: number, y: number): number[] => { const point = rotate(x, y, draw.rotationDeg, draw.pivotX, draw.pivotY); return [(point[0] / width) * 2 - 1, 1 - (point[1] / height) * 2, ...color]; };
    const left = draw.x; const right = draw.x + draw.width; const top = draw.y; const bottom = draw.y + draw.height;
    return new Float32Array([...vertex(left, top), ...vertex(right, top), ...vertex(left, bottom), ...vertex(left, bottom), ...vertex(right, top), ...vertex(right, bottom)]);
  };
  const pointInstances = (points: Extract<InternalGpuFramePlan["draws"][number], { kind: "points" }>["points"], width: number, height: number): Float32Array => {
    const values = new Float32Array(points.length * 8);
    points.forEach((point, index) => values.set([
      (point.x / width) * 2 - 1,
      1 - (point.y / height) * 2,
      (point.size / width) * 2,
      (point.size / height) * 2,
      ...premultiply(point.color)
    ], index * 8));
    return values;
  };
  const ellipseVertices = (draw: Extract<InternalGpuFramePlan["draws"][number], { kind: "ellipse" }>, width: number, height: number): Float32Array => {
    const fill = premultiply(draw.color); const stroke = premultiply(draw.stroke);
    const vertex = (x: number, y: number, localX: number, localY: number): number[] => { const point = rotate(x, y, draw.rotationDeg, draw.pivotX, draw.pivotY); return [(point[0] / width) * 2 - 1, 1 - (point[1] / height) * 2, localX, localY, ...fill, ...stroke, draw.width / 2, draw.height / 2, draw.strokeWidth]; };
    const left=draw.x,right=draw.x+draw.width,top=draw.y,bottom=draw.y+draw.height;
    return new Float32Array([...vertex(left,top,-1,-1),...vertex(right,top,1,-1),...vertex(left,bottom,-1,1),...vertex(left,bottom,-1,1),...vertex(right,top,1,-1),...vertex(right,bottom,1,1)]);
  };
  const triangleVertices = (draw: Extract<InternalGpuFramePlan["draws"][number], { kind: "triangles" }>, width: number, height: number): Float32Array => {
    const color = premultiply(draw.color);
    return new Float32Array(draw.vertices.flatMap((vertex) => {
      const point = rotate(vertex.x, vertex.y, draw.rotationDeg, draw.pivotX, draw.pivotY);
      return [(point[0] / width) * 2 - 1, 1 - (point[1] / height) * 2, ...color];
    }));
  };
  const coloredTriangleVertices = (draw: Extract<InternalGpuFramePlan["draws"][number], { kind: "coloredTriangles" }>, width: number, height: number): Float32Array => new Float32Array(draw.vertices.flatMap((vertex) => {
    const point = rotate(vertex.x, vertex.y, draw.rotationDeg, draw.pivotX, draw.pivotY);
    return [(point[0] / width) * 2 - 1, 1 - (point[1] / height) * 2, ...premultiply(vertex.color)];
  }));
  const destroy = (device: { destroy?: () => void }): void => {
    try { device.destroy?.(); } catch { /* browser close remains the final boundary */ }
  };
  const rectangleWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> }
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>) -> VertexOut {
  var output: VertexOut; output.position = vec4<f32>(position, 0.0, 1.0); output.color = color; return output;
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { return input.color; }
`;
  const pointWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>, @location(1) local: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) vertex: u32, @location(0) center: vec2<f32>, @location(1) size: vec2<f32>, @location(2) color: vec4<f32>) -> VertexOut {
  let quad = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  var output: VertexOut; let position = center + quad[vertex] * size * 0.5;
  output.position = vec4<f32>(position, 0.0, 1.0); output.color = color; output.local = quad[vertex]; return output;
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { if (dot(input.local, input.local) > 1.0) { discard; } return input.color; }
`;
  const ellipseWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>, @location(1) fill: vec4<f32>, @location(2) stroke: vec4<f32>, @location(3) halfSize: vec2<f32>, @location(4) strokeWidth: f32 }
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) local: vec2<f32>, @location(2) fill: vec4<f32>, @location(3) stroke: vec4<f32>, @location(4) halfSize: vec2<f32>, @location(5) strokeWidth: f32) -> VertexOut { var o: VertexOut; o.position=vec4<f32>(position,0.0,1.0); o.local=local; o.fill=fill; o.stroke=stroke; o.halfSize=halfSize; o.strokeWidth=strokeWidth; return o; }
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { if (dot(input.local,input.local) > 1.0) { discard; } if (input.strokeWidth > 0.0 && input.stroke.a > 0.0) { let inner=input.halfSize-vec2<f32>(input.strokeWidth); if (inner.x <= 0.0 || inner.y <= 0.0 || dot(input.local*input.halfSize/inner,input.local*input.halfSize/inner) > 1.0) { return input.stroke; } } return input.fill; }
`;
  const readAdapterInfo = async (adapter: object): Promise<GpuPageAdapterInfo | null> => {
    try {
      const candidate = (adapter as { info?: unknown; requestAdapterInfo?: () => Promise<unknown> }).info
        ?? await (adapter as { requestAdapterInfo?: () => Promise<unknown> }).requestAdapterInfo?.();
      if (!candidate || typeof candidate !== "object") return null;
      const record = candidate as Record<string, unknown>;
      if (typeof record.vendor !== "string" || !record.vendor.trim()) return null;
      const device = typeof record.device === "string" ? record.device : "";
      const architecture = typeof record.architecture === "string" && record.architecture.trim() ? record.architecture : null;
      const description = typeof record.description === "string" && record.description.trim() ? record.description : null;
      if (!device.trim() && !architecture && !description) return null;
      return { vendor: record.vendor, device, architecture, description };
    } catch {
      return null;
    }
  };

  const browserGlobal = globalThis as unknown as {
    GPUBufferUsage?: Record<string, number>;
    GPUMapMode?: Record<string, number>;
    GPUTextureUsage?: Record<string, number>;
    isSecureContext?: boolean;
    navigator?: { gpu?: { requestAdapter(options?: { powerPreference?: string }): Promise<unknown> } };
  };
  const { plan, adapterOptions } = input;
  if (plan.draws.some((draw) => draw.kind === "adjustment" || draw.kind === "scene3d" || draw.kind === "environment" || draw.kind === "motionBlurStart" || draw.kind === "motionBlurEnd" || draw.kind === "groupStart" || draw.kind === "groupEnd" || draw.blendMode !== "normal" || draw.effects !== null || draw.mask !== undefined)) return fail("gpu_render_failed", "One-shot GPU frames cannot apply composite effects; use a persistent render session.");
  const gpu = browserGlobal.navigator?.gpu;
  const bufferUsage = browserGlobal.GPUBufferUsage;
  const textureUsage = browserGlobal.GPUTextureUsage;
  const mapMode = browserGlobal.GPUMapMode;
  if (!gpu || !bufferUsage || !textureUsage || !mapMode) return fail("gpu_api_unavailable", "WebGPU globals are unavailable in the renderer page.");
  const adapter = await gpu.requestAdapter(adapterOptions);
  if (!adapter || typeof adapter !== "object") return fail("gpu_adapter_unavailable", "WebGPU did not provide a render adapter.");
  const adapterInfo = await readAdapterInfo(adapter);
  if (!adapterInfo) return fail("gpu_adapter_identity_unavailable", "The render-selected WebGPU adapter did not expose a correlatable identity.");
  const requestDevice = (adapter as { requestDevice?: () => Promise<unknown> }).requestDevice;
  const device = requestDevice ? await requestDevice.call(adapter).catch(() => null) : null;
  if (!device || typeof device !== "object") return fail("gpu_device_unavailable", "WebGPU did not provide a render device.");
  const gpuDevice = device as Device;
  const maxTextureDimension2D = gpuDevice.limits?.maxTextureDimension2D;
  const maxBufferSize = gpuDevice.limits?.maxBufferSize;
  const maxStorageBufferBindingSize = gpuDevice.limits?.maxStorageBufferBindingSize;
  const bytesPerRow = Math.ceil((plan.width * 4) / 256) * 256;
  const readbackBytes = bytesPerRow * plan.height;
  if (typeof maxTextureDimension2D !== "number" || typeof maxBufferSize !== "number" || typeof maxStorageBufferBindingSize !== "number" || !Number.isInteger(maxTextureDimension2D) || !Number.isInteger(maxBufferSize) || !Number.isInteger(maxStorageBufferBindingSize) || plan.width > maxTextureDimension2D || plan.height > maxTextureDimension2D || plan.budget.pointBufferBytes > maxBufferSize || readbackBytes > maxBufferSize) {
    destroy(gpuDevice);
    return fail("gpu_limits_exceeded", "The admitted GPU device cannot satisfy this bounded frame plan.");
  }

  const texture = gpuDevice.createTexture({ size: { width: plan.width, height: plan.height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: textureUsage.RENDER_ATTACHMENT | textureUsage.COPY_SRC });
  const readback = gpuDevice.createBuffer({ size: bytesPerRow * plan.height, usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ });
  const resources: Array<{ destroy?: () => void }> = [texture, readback];
  try {
    const encoder = gpuDevice.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), clearValue: premultiply(plan.clear), loadOp: "clear", storeOp: "store" }] });
    const blend = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
    };
    const rectPipeline = gpuDevice.createRenderPipeline({
      layout: "auto",
      vertex: { module: gpuDevice.createShaderModule({ code: rectangleWgsl }), entryPoint: "vs", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x4" }] }] },
      fragment: { module: gpuDevice.createShaderModule({ code: rectangleWgsl }), entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] },
      primitive: { topology: "triangle-list" }
    });
    const pointPipeline = gpuDevice.createRenderPipeline({
      layout: "auto",
      vertex: { module: gpuDevice.createShaderModule({ code: pointWgsl }), entryPoint: "vs", buffers: [{ stepMode: "instance", arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32x4" }] }] },
      fragment: { module: gpuDevice.createShaderModule({ code: pointWgsl }), entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] },
      primitive: { topology: "triangle-list" }
    });
    const ellipsePipeline = gpuDevice.createRenderPipeline({
      layout: "auto",
      vertex: { module: gpuDevice.createShaderModule({ code: ellipseWgsl }), entryPoint: "vs", buffers: [{ arrayStride: 60, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32x4" }, { shaderLocation: 3, offset: 32, format: "float32x4" }, { shaderLocation: 4, offset: 48, format: "float32x2" }, { shaderLocation: 5, offset: 56, format: "float32" }] }] },
      fragment: { module: gpuDevice.createShaderModule({ code: ellipseWgsl }), entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] },
      primitive: { topology: "triangle-list" }
    });
    for (const draw of plan.draws) {
      if (draw.kind === "rect") {
        const buffer = gpuDevice.createBuffer({ size: 6 * 24, usage: bufferUsage.VERTEX | bufferUsage.COPY_DST });
        resources.push(buffer);
        gpuDevice.queue.writeBuffer(buffer, 0, rectangleVertices(draw, plan.width, plan.height));
        pass.setPipeline(rectPipeline);
        pass.setVertexBuffer(0, buffer);
        pass.draw(6);
      } else if (draw.kind === "ellipse") {
        const buffer = gpuDevice.createBuffer({ size: 6 * 60, usage: bufferUsage.VERTEX | bufferUsage.COPY_DST });
        resources.push(buffer);
        gpuDevice.queue.writeBuffer(buffer, 0, ellipseVertices(draw, plan.width, plan.height));
        pass.setPipeline(ellipsePipeline);
        pass.setVertexBuffer(0, buffer);
        pass.draw(6);
      } else if (draw.kind === "triangles" || draw.kind === "coloredTriangles") {
        const buffer = gpuDevice.createBuffer({ size: draw.vertices.length * 24, usage: bufferUsage.VERTEX | bufferUsage.COPY_DST });
        resources.push(buffer);
        gpuDevice.queue.writeBuffer(buffer, 0, draw.kind === "triangles" ? triangleVertices(draw, plan.width, plan.height) : coloredTriangleVertices(draw, plan.width, plan.height));
        pass.setPipeline(rectPipeline);
        pass.setVertexBuffer(0, buffer);
        pass.draw(draw.vertices.length);
      } else if (draw.kind === "image" || draw.kind === "text" || draw.kind === "gradientRect" || draw.kind === "styledRect") {
        return fail("gpu_render_failed", "One-shot GPU frames cannot consume retained image, text, gradient or styled-shape resources; use a persistent render session.");
      } else if (draw.kind === "points" && draw.points.length > 0) {
        const buffer = gpuDevice.createBuffer({ size: draw.points.length * 32, usage: bufferUsage.VERTEX | bufferUsage.COPY_DST });
        resources.push(buffer);
        gpuDevice.queue.writeBuffer(buffer, 0, pointInstances(draw.points, plan.width, plan.height));
        pass.setPipeline(pointPipeline);
        pass.setVertexBuffer(0, buffer);
        pass.draw(6, draw.points.length);
      }
    }
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow, rowsPerImage: plan.height }, { width: plan.width, height: plan.height, depthOrArrayLayers: 1 });
    gpuDevice.queue.submit([encoder.finish()]);
    const work = (async () => {
      await gpuDevice.queue.onSubmittedWorkDone();
      await readback.mapAsync(mapMode.READ);
      try {
        return {
          ok: true as const, bytesPerRow, padded: Array.from(new Uint8Array(readback.getMappedRange())),
          runtime: {
            secureContext: browserGlobal.isSecureContext === true, gpuApi: true, adapter: true, adapterInfo, device: true,
            limits: { maxTextureDimension2D, maxBufferSize, maxStorageBufferBindingSize }
          }
        };
      }
      finally { readback.unmap(); }
    })();
    const lost = typeof gpuDevice.lost?.then === "function"
      ? gpuDevice.lost.then(() => fail("gpu_device_lost", "WebGPU device was lost during frame rendering."))
      : new Promise<GpuBrowserFrameOutput>(() => undefined);
    return await Promise.race([work, lost]);
  } catch {
    return fail("gpu_render_failed", "Fixed WebGPU frame rendering failed.");
  } finally {
    for (const resource of resources) resource.destroy?.();
    destroy(gpuDevice);
  }
}
