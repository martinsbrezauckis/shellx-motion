import type { GpuRuntimeFailure } from "./gpu-runtime-types";
import type { GpuPageSessionOpenOutput } from "./gpu-page-session-types";

export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_INPUT_SCHEMA = "shellx-motion/linear-srgb-sdr-final-webgpu-page-input@1" as const;
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_READBACK_SCHEMA = "shellx-motion/linear-srgb-sdr-final-webgpu-page-readback@1" as const;
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_SHADER_SOURCE_SHA256 = "156efd31ca9d7070f68638ac5b68123793a2f77372f191f0ab19f375f4afd924";
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256 = "8c3c00b2f504d734271dfb00bb5ca5fb6df0066e43d5c7dc60602163b90e2b3b";
export const LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PAGE_EXPECTED_SHADER_SOURCE_SHA256 = "76d087d7368948ecb670e9e7f99910a1b15f83e52880f23bd7f6a4d189c682aa";
export const LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256 = "3ee0875016ddd32cd1a94796b17b1acf2146d857846e8f8b2364ad889551939c";
export const LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256 = "3f2211df797dcbfedc09746fa3daf2d3f204f9998762f872afc358a19dd9c09a";

export interface LinearSrgbSdrFinalWebGpuPageInput {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_INPUT_SCHEMA;
  readonly routeFingerprint: string;
  readonly documentFingerprint: string;
  readonly pipelineImplementationSha256: string;
  readonly shaderSourceSha256: string;
  readonly compositeWgsl: string;
  readonly encodeWgsl: string;
  readonly canvas: { readonly width: number; readonly height: number; readonly background: { readonly hex: string; readonly r: number; readonly g: number; readonly b: number } };
  readonly rects: readonly (
    | { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly fill: { readonly hex: string; readonly r: number; readonly g: number; readonly b: number }; readonly opacity: number; readonly blendMode?: "screen" }
    | {
      readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number;
      readonly gradient: (
        | { readonly type: "linear"; readonly angleDeg: number; readonly stops: readonly { readonly offset: number; readonly color: { readonly hex: string; readonly r: number; readonly g: number; readonly b: number } }[] }
        | { readonly type: "radial"; readonly centerX: number; readonly centerY: number; readonly stops: readonly { readonly offset: number; readonly color: { readonly hex: string; readonly r: number; readonly g: number; readonly b: number } }[] }
      );
      readonly opacity: number;
      readonly blendMode?: "screen";
    }
  )[];
  readonly gradientPipelineImplementationSha256?: string;
  readonly gradientShaderSourceSha256?: string;
  readonly gradientWgsl?: string;
  /** Present only when an admitted F2b screen rectangle requires the alternate fixed blend state. */
  readonly screenPipelineImplementationSha256?: string;
}

export interface LinearSrgbSdrFinalWebGpuPageReadbackInput {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_READBACK_SCHEMA;
  readonly routeFingerprint: string;
  readonly documentFingerprint: string;
}

type Failure = { readonly ok: false; readonly failure: GpuRuntimeFailure };
type Success = { readonly ok: true };

/** Opens an isolated page-global device for the route-private final producer. */
export async function openLinearSrgbSdrFinalWebGpuPage(options: { powerPreference: "high-performance" }): Promise<GpuPageSessionOpenOutput> {
  type Device = { destroy?(): void; limits?: { maxTextureDimension2D?: number; maxBufferSize?: number; maxStorageBufferBindingSize?: number }; lost?: Promise<unknown> };
  const browser = globalThis as unknown as {
    isSecureContext?: boolean;
    navigator?: { gpu?: { requestAdapter(options?: { powerPreference: "high-performance" }): Promise<unknown> } };
    __shellxMotionLinearSrgbSdrFinalWebGpuV1?: unknown;
  };
  if (browser.__shellxMotionLinearSrgbSdrFinalWebGpuV1) return fail("gpu_render_failed", "The isolated linear-sRGB SDR final GPU page is already open.");
  if (!browser.isSecureContext || !browser.navigator?.gpu) return fail("gpu_api_unavailable", "WebGPU is unavailable for the isolated linear-sRGB SDR final producer.");
  const adapter = await browser.navigator.gpu.requestAdapter(options) ?? await browser.navigator.gpu.requestAdapter(options);
  if (!adapter || typeof adapter !== "object") return fail("gpu_adapter_unavailable", "The isolated linear-sRGB SDR final producer did not receive a WebGPU adapter.");
  let persistent: Device | undefined;
  try {
    const raw = (adapter as { info?: unknown; requestAdapterInfo?(): Promise<unknown> }).info ?? await (adapter as { requestAdapterInfo?(): Promise<unknown> }).requestAdapterInfo?.();
    const info = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined, vendor = typeof info?.vendor === "string" ? info.vendor : "", deviceName = typeof info?.device === "string" ? info.device : "";
    const architecture = typeof info?.architecture === "string" && info.architecture.trim() ? info.architecture : null, description = typeof info?.description === "string" && info.description.trim() ? info.description : null;
    if (!vendor.trim() || (!deviceName.trim() && !architecture && !description)) return fail("gpu_adapter_identity_unavailable", "The isolated linear-sRGB SDR adapter did not expose a correlatable identity.");
    const requestDevice = (adapter as { requestDevice?(): Promise<unknown> }).requestDevice;
    const device = requestDevice ? await requestDevice.call(adapter).catch(() => null) : null;
    if (!device || typeof device !== "object") return fail("gpu_device_unavailable", "The isolated linear-sRGB SDR final producer did not receive a WebGPU device.");
    persistent = device as Device;
    const limits = persistent.limits;
    if (typeof persistent.destroy !== "function") return fail("gpu_device_unavailable", "The isolated linear-sRGB SDR device did not expose terminal destruction.");
    if (!integer(limits?.maxTextureDimension2D, 1, Number.MAX_SAFE_INTEGER) || !integer(limits?.maxBufferSize, 1, Number.MAX_SAFE_INTEGER) || !integer(limits?.maxStorageBufferBindingSize, 1, Number.MAX_SAFE_INTEGER)) {
      persistent.destroy?.();
      return fail("gpu_limits_exceeded", "The isolated linear-sRGB SDR final device did not expose bounded integer limits.");
    }
    const state = { device: persistent, limits: { maxTextureDimension2D: limits.maxTextureDimension2D!, maxBufferSize: limits.maxBufferSize!, maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize! }, lost: false };
    persistent.lost?.then(() => { state.lost = true; }).catch(() => { state.lost = true; });
    browser.__shellxMotionLinearSrgbSdrFinalWebGpuV1 = state;
    return { ok: true, runtime: { secureContext: true, gpuApi: true, adapter: true, adapterInfo: { vendor, device: deviceName, architecture, description }, device: true, limits: state.limits } };
  } catch {
    try { persistent?.destroy?.(); } catch { /* initialization refusal still attempts terminal device destruction */ }
    return fail("gpu_render_failed", "The isolated linear-sRGB SDR final GPU page could not initialize its device.");
  }
  function fail(code: GpuRuntimeFailure["code"], message: string): GpuPageSessionOpenOutput { return { ok: false, failure: { code, message } }; }
  function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
}

/** Creates only the float working and encoded publication textures after full route-shape validation. */
export async function prepareLinearSrgbSdrFinalWebGpuPage(input: LinearSrgbSdrFinalWebGpuPageInput): Promise<Success | Failure> {
  const MAX_WIDTH = 1920, MAX_HEIGHT = 1080, MAX_RECTS = 64, MAX_STOPS = 16, ALIGNMENT = 256, UNIFORM_STRIDE = 256, GRADIENT_UNIFORM_STRIDE = 512;
  type Buffer = { destroy(): void };
  type Texture = { createView(): unknown; destroy(): void };
  type BindGroup = unknown;
  type Pipeline = { getBindGroupLayout(index: number): unknown };
  type Device = {
    createShaderModule(value: unknown): unknown;
    createRenderPipeline(value: unknown): Pipeline;
    createTexture(value: unknown): Texture;
    createBuffer(value: unknown): Buffer;
    createBindGroup(value: unknown): BindGroup;
    pushErrorScope(filter: "validation"): void;
    popErrorScope(): Promise<unknown>;
    queue: { writeBuffer(buffer: Buffer, offset: number, data: ArrayBuffer): void };
  };
  type BlendMode = "normal" | "screen";
  type Draw = { kind: "flat" | "gradient"; blendMode: BlendMode; group: BindGroup };
  type Resources = { routeFingerprint: string; documentFingerprint: string; working: Texture; publication: Texture; ditherMask: Texture; uniform: Buffer; gradientUniform?: Buffer; composite: Pipeline; gradientComposite?: Pipeline; screenComposite?: Pipeline; screenGradientComposite?: Pipeline; encode: Pipeline; draws: readonly Draw[]; encodeGroup: BindGroup; width: number; height: number; paddedBytesPerRow: number; tightByteLength: number; paddedByteLength: number; gpuBytes: number; rendered: boolean };
  type State = { device?: Device; limits?: { maxTextureDimension2D: number; maxBufferSize: number }; lost?: boolean; resources?: Resources };
  const browser = globalThis as unknown as { GPUTextureUsage?: Record<string, number>; GPUBufferUsage?: Record<string, number>; __shellxMotionLinearSrgbSdrFinalWebGpuV1?: State };
  const state = browser.__shellxMotionLinearSrgbSdrFinalWebGpuV1, usage = browser.GPUTextureUsage, bufferUsage = browser.GPUBufferUsage;
  if (!state?.device || !state.limits || !usage || !bufferUsage || state.resources || state.lost || typeof state.device.pushErrorScope !== "function" || typeof state.device.popErrorScope !== "function") return fail(state?.lost ? "gpu_device_lost" : "gpu_resource_refused", "The isolated linear-sRGB SDR final page has no available device resources or validation scopes.");
  if (!validInput(input) || input.canvas.width > state.limits.maxTextureDimension2D || input.canvas.height > state.limits.maxTextureDimension2D) return fail("gpu_resource_refused", "The isolated linear-sRGB SDR final page rejected its bounded route input before resource allocation.");
  const usesGradients = input.rects.some((rect) => "gradient" in rect);
  const usesScreen = input.rects.some((rect) => rect.blendMode === "screen");
  const usesNormalGradients = input.rects.some((rect) => "gradient" in rect && rect.blendMode !== "screen");
  const usesScreenGradients = input.rects.some((rect) => "gradient" in rect && rect.blendMode === "screen");
  let exactShader = false;
  try { exactShader = await exactShaderSource(input); } catch { exactShader = false; }
  let exactGradientShader = !usesGradients;
  if (usesGradients) try { exactGradientShader = await exactGradientShaderSource(input); } catch { exactGradientShader = false; }
  if (input.pipelineImplementationSha256 !== "8c3c00b2f504d734271dfb00bb5ca5fb6df0066e43d5c7dc60602163b90e2b3b" || input.shaderSourceSha256 !== "156efd31ca9d7070f68638ac5b68123793a2f77372f191f0ab19f375f4afd924" || !exactShader || (usesGradients && (input.gradientPipelineImplementationSha256 !== "3ee0875016ddd32cd1a94796b17b1acf2146d857846e8f8b2364ad889551939c" || input.gradientShaderSourceSha256 !== "76d087d7368948ecb670e9e7f99910a1b15f83e52880f23bd7f6a4d189c682aa" || !exactGradientShader)) || (usesScreen && input.screenPipelineImplementationSha256 !== "3f2211df797dcbfedc09746fa3daf2d3f204f9998762f872afc358a19dd9c09a")) return fail("gpu_resource_refused", "The isolated linear-sRGB SDR final page rejected an unbound shader or pipeline identity before resource allocation.");
  const paddedBytesPerRow = Math.ceil(input.canvas.width * 4 / ALIGNMENT) * ALIGNMENT;
  const tightByteLength = input.canvas.width * input.canvas.height * 4;
  const paddedByteLength = paddedBytesPerRow * input.canvas.height;
  const flatLayerCount = 1 + input.rects.filter((rect) => "fill" in rect).length, gradientLayerCount = input.rects.length - flatLayerCount + 1;
  const uniformBytes = flatLayerCount * UNIFORM_STRIDE, gradientUniformBytes = gradientLayerCount * GRADIENT_UNIFORM_STRIDE;
  // rgba16float working + rgba8 publication + r8 visible-gradient normal/screen coverage.
  const gpuBytes = input.canvas.width * input.canvas.height * 13 + uniformBytes + gradientUniformBytes;
  if (!Number.isSafeInteger(tightByteLength) || !Number.isSafeInteger(paddedByteLength) || paddedByteLength > MAX_WIDTH * MAX_HEIGHT * 4 || paddedByteLength > state.limits.maxBufferSize || uniformBytes > state.limits.maxBufferSize || gradientUniformBytes > state.limits.maxBufferSize) return fail("gpu_limits_exceeded", "The isolated linear-sRGB SDR final page refused its bounded texture or readback size.");
  if (![usage.RENDER_ATTACHMENT, usage.TEXTURE_BINDING, usage.COPY_SRC, bufferUsage.UNIFORM, bufferUsage.COPY_DST].every((value) => typeof value === "number")) return fail("gpu_resource_refused", "The WebGPU implementation did not expose the required isolated producer usages.");
  let working: Texture | undefined, publication: Texture | undefined, ditherMask: Texture | undefined, uniform: Buffer | undefined, gradientUniform: Buffer | undefined, scopeOpen = false;
  try {
    state.device.pushErrorScope("validation"); scopeOpen = true;
    const compositeModule = state.device.createShaderModule({ code: input.compositeWgsl });
    const encodeModule = state.device.createShaderModule({ code: input.encodeWgsl });
    const normalWorkingTarget = { format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } } as const;
    const screenWorkingTarget = { format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } } as const;
    const normalFlatCoverage = { format: "r8unorm", blend: { color: { srcFactor: "zero", dstFactor: "one-minus-src", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one-minus-src", operation: "add" } } } as const;
    const normalGradientCoverage = { format: "r8unorm", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" } } } as const;
    const screenFlatCoverage = { format: "r8unorm", blend: { color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" } } } as const;
    const screenGradientCoverage = { format: "r8unorm", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } } as const;
    const composite = state.device.createRenderPipeline({ layout: "auto", vertex: { module: compositeModule, entryPoint: "vertexMain" }, fragment: { module: compositeModule, entryPoint: "compositeMain", targets: [normalWorkingTarget, normalFlatCoverage] }, primitive: { topology: "triangle-list" } });
    const screenComposite = usesScreen ? state.device.createRenderPipeline({ layout: "auto", vertex: { module: compositeModule, entryPoint: "vertexMain" }, fragment: { module: compositeModule, entryPoint: "compositeMain", targets: [screenWorkingTarget, screenFlatCoverage] }, primitive: { topology: "triangle-list" } }) : undefined;
    const gradientComposite = usesNormalGradients ? state.device.createRenderPipeline({ layout: "auto", vertex: { module: state.device.createShaderModule({ code: input.gradientWgsl! }), entryPoint: "vertexMain" }, fragment: { module: state.device.createShaderModule({ code: input.gradientWgsl! }), entryPoint: "gradientMain", targets: [normalWorkingTarget, normalGradientCoverage] }, primitive: { topology: "triangle-list" } }) : undefined;
    const screenGradientComposite = usesScreenGradients ? state.device.createRenderPipeline({ layout: "auto", vertex: { module: state.device.createShaderModule({ code: input.gradientWgsl! }), entryPoint: "vertexMain" }, fragment: { module: state.device.createShaderModule({ code: input.gradientWgsl! }), entryPoint: "gradientMain", targets: [screenWorkingTarget, screenGradientCoverage] }, primitive: { topology: "triangle-list" } }) : undefined;
    const encode = state.device.createRenderPipeline({ layout: "auto", vertex: { module: encodeModule, entryPoint: "vertexMain" }, fragment: { module: encodeModule, entryPoint: "encodeMain", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    working = state.device.createTexture({ size: { width: input.canvas.width, height: input.canvas.height, depthOrArrayLayers: 1 }, format: "rgba16float", usage: usage.RENDER_ATTACHMENT | usage.TEXTURE_BINDING });
    publication = state.device.createTexture({ size: { width: input.canvas.width, height: input.canvas.height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: usage.RENDER_ATTACHMENT | usage.COPY_SRC });
    ditherMask = state.device.createTexture({ size: { width: input.canvas.width, height: input.canvas.height, depthOrArrayLayers: 1 }, format: "r8unorm", usage: usage.RENDER_ATTACHMENT | usage.TEXTURE_BINDING });
    uniform = state.device.createBuffer({ size: uniformBytes, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
    if (usesGradients) gradientUniform = state.device.createBuffer({ size: gradientUniformBytes, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
    if (typeof working.createView !== "function" || typeof working.destroy !== "function" || typeof publication.createView !== "function" || typeof publication.destroy !== "function" || typeof ditherMask.createView !== "function" || typeof ditherMask.destroy !== "function" || typeof uniform.destroy !== "function" || (usesGradients && typeof gradientUniform?.destroy !== "function")) throw new Error("terminal resource destruction");
    const uniformData = new Float32Array(uniformBytes / 4);
    const flatLayers = [{ x: 0, y: 0, width: input.canvas.width, height: input.canvas.height, fill: input.canvas.background, opacity: 1, blendMode: "normal" as const }, ...input.rects.filter((rect) => "fill" in rect)];
    for (let index = 0; index < flatLayers.length; index += 1) {
      const layer = flatLayers[index]!;
      uniformData.set([layer.fill.r, layer.fill.g, layer.fill.b, layer.opacity, layer.x, layer.y, layer.width, layer.height], index * (UNIFORM_STRIDE / 4));
    }
    state.device.queue.writeBuffer(uniform, 0, uniformData.buffer);
    const flatGroups = flatLayers.map((layer, index) => state.device!.createBindGroup({ layout: (layer.blendMode === "screen" ? screenComposite! : composite).getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform!, offset: index * UNIFORM_STRIDE, size: 32 } }] }));
    const gradientGroups: BindGroup[] = [];
    if (usesGradients) {
      const gradientData = new Float32Array(gradientUniformBytes / 4);
      const gradients = input.rects.filter((rect) => "gradient" in rect);
      for (let index = 0; index < gradients.length; index += 1) {
        const layer = gradients[index]!, offset = index * (GRADIENT_UNIFORM_STRIDE / 4), gradient = layer.gradient;
        gradientData.set([gradient.type === "linear" ? 1 : 2, layer.opacity, gradient.type === "linear" ? gradient.angleDeg * Math.PI / 180 : 0, gradient.stops.length], offset);
        gradientData.set([layer.x, layer.y, layer.width, layer.height], offset + 4);
        gradientData.set([gradient.type === "radial" ? gradient.centerX : 0.5, gradient.type === "radial" ? gradient.centerY : 0.5, layer.blendMode === "screen" ? 1 : 0], offset + 8);
        for (let stopIndex = 0; stopIndex < gradient.stops.length; stopIndex += 1) {
          const stop = gradient.stops[stopIndex]!;
          gradientData[offset + 12 + stopIndex] = stop.offset;
          gradientData.set([stop.color.r, stop.color.g, stop.color.b, 1], offset + 28 + stopIndex * 4);
        }
        gradientGroups.push(state.device.createBindGroup({ layout: (layer.blendMode === "screen" ? screenGradientComposite! : gradientComposite!).getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: gradientUniform!, offset: index * GRADIENT_UNIFORM_STRIDE, size: GRADIENT_UNIFORM_STRIDE } }] }));
      }
      state.device.queue.writeBuffer(gradientUniform!, 0, gradientData.buffer);
    }
    const draws: Draw[] = [{ kind: "flat", blendMode: "normal", group: flatGroups[0]! }];
    let flatIndex = 1, gradientIndex = 0;
    for (const rect of input.rects) {
      if ("fill" in rect) draws.push({ kind: "flat", blendMode: rect.blendMode === "screen" ? "screen" : "normal", group: flatGroups[flatIndex++]! });
      else draws.push({ kind: "gradient", blendMode: rect.blendMode === "screen" ? "screen" : "normal", group: gradientGroups[gradientIndex++]! });
    }
    const encodeGroup = state.device.createBindGroup({ layout: encode.getBindGroupLayout(0), entries: [{ binding: 0, resource: working.createView() }, { binding: 1, resource: ditherMask.createView() }] });
    const validation = await state.device.popErrorScope(); scopeOpen = false;
    if (validation) throw new Error("pipeline validation");
    state.resources = { routeFingerprint: input.routeFingerprint, documentFingerprint: input.documentFingerprint, working, publication, ditherMask, uniform, ...(gradientUniform ? { gradientUniform } : {}), composite, ...(screenComposite ? { screenComposite } : {}), ...(gradientComposite ? { gradientComposite } : {}), ...(screenGradientComposite ? { screenGradientComposite } : {}), encode, draws, encodeGroup, width: input.canvas.width, height: input.canvas.height, paddedBytesPerRow, tightByteLength, paddedByteLength, gpuBytes, rendered: false };
    return { ok: true };
  } catch {
    if (scopeOpen) try { await state.device.popErrorScope(); } catch { /* resource release remains mandatory */ }
    for (const resource of [working, publication, ditherMask, uniform, gradientUniform]) try { resource?.destroy(); } catch { /* every resource remains attempted */ }
    return fail("gpu_render_failed", "The isolated linear-sRGB SDR final producer could not create its fixed pipelines or resources.");
  }
  function validInput(value: unknown): value is LinearSrgbSdrFinalWebGpuPageInput {
    if (!record(value) || value.schema !== "shellx-motion/linear-srgb-sdr-final-webgpu-page-input@1" || !hash(value.routeFingerprint) || !hash(value.documentFingerprint) || !hash(value.pipelineImplementationSha256) || !hash(value.shaderSourceSha256) || typeof value.compositeWgsl !== "string" || value.compositeWgsl.length < 1 || value.compositeWgsl.length > 16_384 || typeof value.encodeWgsl !== "string" || value.encodeWgsl.length < 1 || value.encodeWgsl.length > 16_384 || !Array.isArray(value.rects) || value.rects.length > MAX_RECTS) return false;
    const gradients = value.rects.some((rect) => record(rect) && Object.hasOwn(rect, "gradient"));
    const screen = value.rects.some((rect) => record(rect) && rect.blendMode === "screen");
    const keys = ["schema", "routeFingerprint", "documentFingerprint", "pipelineImplementationSha256", "shaderSourceSha256", "compositeWgsl", "encodeWgsl", "canvas", "rects", ...(gradients ? ["gradientPipelineImplementationSha256", "gradientShaderSourceSha256", "gradientWgsl"] : []), ...(screen ? ["screenPipelineImplementationSha256"] : [])];
    if (!sameKeys(value, keys) || (gradients && (!hash(value.gradientPipelineImplementationSha256) || !hash(value.gradientShaderSourceSha256) || typeof value.gradientWgsl !== "string" || value.gradientWgsl.length < 1 || value.gradientWgsl.length > 16_384)) || (screen && !hash(value.screenPipelineImplementationSha256))) return false;
    const currentCanvas = value.canvas;
    if (!canvas(currentCanvas)) return false;
    const ids = new Set<string>();
    return value.rects.every((rect) => rectangle(rect, currentCanvas, ids) && !ids.has(rect.id) && (ids.add(rect.id), true)) && (!gradients || value.rects.some((rect) => record(rect) && Object.hasOwn(rect, "gradient")));
  }
  function canvas(value: unknown): value is LinearSrgbSdrFinalWebGpuPageInput["canvas"] { return record(value) && sameKeys(value, ["width", "height", "background"]) && integer(value.width, 1, MAX_WIDTH) && integer(value.height, 1, MAX_HEIGHT) && color(value.background); }
  function rectangle(value: unknown, current: LinearSrgbSdrFinalWebGpuPageInput["canvas"], ids: ReadonlySet<string>): value is LinearSrgbSdrFinalWebGpuPageInput["rects"][number] { if (!record(value) || typeof value.id !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/u.test(value.id) || ids.has(value.id) || !integer(value.x, 0, current.width - 1) || !integer(value.y, 0, current.height - 1) || !integer(value.width, 1, current.width) || !integer(value.height, 1, current.height) || value.x + value.width > current.width || value.y + value.height > current.height || !finite(value.opacity, 0, 1) || (value.blendMode !== undefined && value.blendMode !== "screen")) return false; const base = ["id", "x", "y", "width", "height", "opacity", ...(value.blendMode === "screen" ? ["blendMode"] : [])]; return (sameKeys(value, [...base, "fill"]) && color(value.fill)) || (sameKeys(value, [...base, "gradient"]) && gradient(value.gradient)); }
  function gradient(value: unknown): boolean { if (!record(value) || !Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > MAX_STOPS) return false; const linear = value.type === "linear" && sameKeys(value, ["type", "angleDeg", "stops"]) && finite(value.angleDeg, 0, 360), radial = value.type === "radial" && sameKeys(value, ["type", "centerX", "centerY", "stops"]) && finite(value.centerX, 0, 1) && finite(value.centerY, 0, 1); if (!linear && !radial) return false; let prior = -1; for (const stop of value.stops) { if (!record(stop) || !sameKeys(stop, ["offset", "color"]) || !finite(stop.offset, 0, 1) || stop.offset <= prior || !color(stop.color)) return false; prior = stop.offset; } return value.stops[0]?.offset === 0 && value.stops.at(-1)?.offset === 1; }
  function color(value: unknown): value is { readonly hex: string; readonly r: number; readonly g: number; readonly b: number } { return record(value) && sameKeys(value, ["hex", "r", "g", "b"]) && typeof value.hex === "string" && /^#[0-9a-f]{6}$/u.test(value.hex) && finite(value.r, 0, 1) && finite(value.g, 0, 1) && finite(value.b, 0, 1); }
  async function exactShaderSource(value: LinearSrgbSdrFinalWebGpuPageInput): Promise<boolean> { const crypto = globalThis.crypto?.subtle; if (!crypto || typeof TextEncoder !== "function") return false; const canonical = `{"compositeWgsl":${JSON.stringify(value.compositeWgsl)},"encodeWgsl":${JSON.stringify(value.encodeWgsl)}}`; const digest = new Uint8Array(await crypto.digest("SHA-256", new TextEncoder().encode(canonical))); const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); return actual === value.shaderSourceSha256 && actual === "156efd31ca9d7070f68638ac5b68123793a2f77372f191f0ab19f375f4afd924"; }
  async function exactGradientShaderSource(value: LinearSrgbSdrFinalWebGpuPageInput): Promise<boolean> { const crypto = globalThis.crypto?.subtle; if (!crypto || typeof TextEncoder !== "function" || typeof value.gradientWgsl !== "string") return false; const canonical = `{"gradientWgsl":${JSON.stringify(value.gradientWgsl)}}`; const digest = new Uint8Array(await crypto.digest("SHA-256", new TextEncoder().encode(canonical))); const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); return actual === value.gradientShaderSourceSha256 && actual === "76d087d7368948ecb670e9e7f99910a1b15f83e52880f23bd7f6a4d189c682aa"; }
  function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
  function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
  function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
  function finite(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
  function fail(code: GpuRuntimeFailure["code"], message: string): Failure { return { ok: false, failure: { code, message } }; }
}

/** Draws the static document in admitted normal/source-over and F2b screen order, then publishes a separate encoded texture. */
export async function renderLinearSrgbSdrFinalWebGpuPage(input: LinearSrgbSdrFinalWebGpuPageReadbackInput): Promise<Success | Failure> {
  type Texture = { createView(): unknown };
  type Pass = { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; draw(vertices: number): void; end(): void };
  type Resources = { routeFingerprint: string; documentFingerprint: string; working: Texture; publication: Texture; ditherMask: Texture; composite: unknown; screenComposite?: unknown; gradientComposite?: unknown; screenGradientComposite?: unknown; encode: unknown; draws: readonly { kind: "flat" | "gradient"; blendMode: "normal" | "screen"; group: unknown }[]; encodeGroup: unknown; rendered: boolean };
  type State = { device?: { createCommandEncoder(): { beginRenderPass(value: unknown): Pass; finish(): unknown }; queue: { submit(commands: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } }; resources?: Resources; lost?: boolean };
  const state = (globalThis as unknown as { __shellxMotionLinearSrgbSdrFinalWebGpuV1?: State }).__shellxMotionLinearSrgbSdrFinalWebGpuV1, resources = state?.resources;
  if (!state?.device || !resources || !valid(input, resources)) return fail("gpu_resource_refused", "The isolated linear-sRGB SDR final page rejected a render without matching prepared resources.");
  if (state.lost) return fail("gpu_device_lost", "The isolated linear-sRGB SDR final GPU device was lost before rendering.");
  try {
    const encoder = state.device.createCommandEncoder();
    const composite = encoder.beginRenderPass({ colorAttachments: [{ view: resources.working.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }, { view: resources.ditherMask.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
    for (const draw of resources.draws) {
      composite.setPipeline(draw.kind === "flat"
        ? (draw.blendMode === "screen" ? resources.screenComposite! : resources.composite)
        : (draw.blendMode === "screen" ? resources.screenGradientComposite! : resources.gradientComposite!));
      composite.setBindGroup(0, draw.group);
      composite.draw(3);
    }
    composite.end();
    const publish = encoder.beginRenderPass({ colorAttachments: [{ view: resources.publication.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
    publish.setPipeline(resources.encode); publish.setBindGroup(0, resources.encodeGroup); publish.draw(3); publish.end();
    state.device.queue.submit([encoder.finish()]); if (state.device.queue.onSubmittedWorkDone) await state.device.queue.onSubmittedWorkDone();
    resources.rendered = true;
    return { ok: true };
  } catch {
    return fail(state.lost ? "gpu_device_lost" : "gpu_render_failed", "The isolated linear-sRGB SDR final GPU producer could not render its bounded static frame.");
  }
  function valid(value: unknown, current: Resources): value is LinearSrgbSdrFinalWebGpuPageReadbackInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "documentFingerprint,routeFingerprint,schema" && (value as LinearSrgbSdrFinalWebGpuPageReadbackInput).schema === "shellx-motion/linear-srgb-sdr-final-webgpu-page-readback@1" && (value as LinearSrgbSdrFinalWebGpuPageReadbackInput).routeFingerprint === current.routeFingerprint && (value as LinearSrgbSdrFinalWebGpuPageReadbackInput).documentFingerprint === current.documentFingerprint; }
  function fail(code: GpuRuntimeFailure["code"], message: string): Failure { return { ok: false, failure: { code, message } }; }
}

/** Reads only the encoded publication texture through an aligned, bounded transient buffer. */
export async function readLinearSrgbSdrFinalWebGpuPage(input: LinearSrgbSdrFinalWebGpuPageReadbackInput): Promise<Failure | { readonly ok: true; readonly paddedBase64: string; readonly evidence: { readonly bytesPerRow: number; readonly paddedByteLength: number; readonly tightByteLength: number; readonly mappedByteLength: number; readonly mappedBufferUnmapped: true; readonly mappedBufferDestroyed: true } }> {
  type Buffer = { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; destroy(): void };
  type Resources = { routeFingerprint: string; documentFingerprint: string; publication: unknown; width: number; height: number; paddedBytesPerRow: number; tightByteLength: number; paddedByteLength: number; rendered: boolean };
  type State = { device?: { createBuffer(value: unknown): Buffer; createCommandEncoder(): { copyTextureToBuffer(source: { texture: unknown }, destination: { buffer: Buffer; bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number; depthOrArrayLayers: number }): void; finish(): unknown }; queue: { submit(commands: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } }; limits?: { maxBufferSize: number }; resources?: Resources; lost?: boolean };
  const browser = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; GPUMapMode?: Record<string, number>; btoa?(value: string): string; __shellxMotionLinearSrgbSdrFinalWebGpuV1?: State }, state = browser.__shellxMotionLinearSrgbSdrFinalWebGpuV1, resources = state?.resources, usage = browser.GPUBufferUsage, mapMode = browser.GPUMapMode;
  if (!state?.device || !resources || !usage || !mapMode || !valid(input, resources) || !resources.rendered) return fail("gpu_resource_refused", "The isolated linear-sRGB SDR final producer has no rendered publication texture to read.");
  if (state.lost) return fail("gpu_device_lost", "The isolated linear-sRGB SDR final GPU device was lost before readback.");
  if (resources.paddedByteLength > 1920 * 1080 * 4 || resources.paddedByteLength > Number.MAX_SAFE_INTEGER || resources.paddedByteLength > (state.limits?.maxBufferSize ?? 0) || typeof usage.COPY_DST !== "number" || typeof usage.MAP_READ !== "number" || typeof mapMode.READ !== "number") return fail("gpu_limits_exceeded", "The isolated linear-sRGB SDR producer refused an unbounded or unsupported readback.");
  let buffer: Buffer | undefined, mapped = false, cleanupFailed = false;
  try {
    buffer = state.device.createBuffer({ size: resources.paddedByteLength, usage: usage.COPY_DST | usage.MAP_READ });
    if (typeof buffer.destroy !== "function") throw new Error("readback terminal destruction");
    const encoder = state.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: resources.publication }, { buffer, bytesPerRow: resources.paddedBytesPerRow, rowsPerImage: resources.height }, { width: resources.width, height: resources.height, depthOrArrayLayers: 1 });
    state.device.queue.submit([encoder.finish()]); if (state.device.queue.onSubmittedWorkDone) await state.device.queue.onSubmittedWorkDone();
    await buffer.mapAsync(mapMode.READ); mapped = true;
    const mappedBytes = new Uint8Array(buffer.getMappedRange());
    const mappedByteLength = mappedBytes.byteLength;
    if (mappedByteLength !== resources.paddedByteLength) throw new Error("readback size");
    const paddedBase64 = base64(mappedBytes, browser.btoa);
    buffer.unmap(); mapped = false;
    buffer.destroy(); buffer = undefined;
    return { ok: true, paddedBase64, evidence: { bytesPerRow: resources.paddedBytesPerRow, paddedByteLength: resources.paddedByteLength, tightByteLength: resources.tightByteLength, mappedByteLength, mappedBufferUnmapped: true, mappedBufferDestroyed: true } };
  } catch {
    return fail(state.lost ? "gpu_device_lost" : "gpu_render_failed", "The isolated linear-sRGB SDR final producer could not complete bounded publication readback.");
  } finally {
    if (mapped) try { buffer?.unmap(); } catch { cleanupFailed = true; }
    if (buffer) try { buffer.destroy(); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new Error("The isolated linear-sRGB SDR final producer could not terminally release its readback buffer.");
  }
  function valid(value: unknown, current: Resources): value is LinearSrgbSdrFinalWebGpuPageReadbackInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "documentFingerprint,routeFingerprint,schema" && (value as LinearSrgbSdrFinalWebGpuPageReadbackInput).schema === "shellx-motion/linear-srgb-sdr-final-webgpu-page-readback@1" && (value as LinearSrgbSdrFinalWebGpuPageReadbackInput).routeFingerprint === current.routeFingerprint && (value as LinearSrgbSdrFinalWebGpuPageReadbackInput).documentFingerprint === current.documentFingerprint; }
  function base64(bytes: Uint8Array, encode: ((value: string) => string) | undefined): string { if (typeof encode !== "function") throw new Error("base64 unavailable"); let result = ""; for (let offset = 0; offset < bytes.length; offset += 32_766) { let text = ""; for (const value of bytes.subarray(offset, Math.min(bytes.length, offset + 32_766))) text += String.fromCharCode(value); result += encode(text); } return result; }
  function fail(code: GpuRuntimeFailure["code"], message: string): Failure { return { ok: false, failure: { code, message } }; }
}

/** Releases the route-private textures and uniform buffer before closing the device. */
export function releaseLinearSrgbSdrFinalWebGpuPage(): { readonly hadResources: boolean; readonly releasedGpuBytes: number; readonly remainingGpuBytes: 0; readonly releaseFailed: boolean } {
  type Resources = { working: { destroy?(): void }; publication: { destroy?(): void }; ditherMask: { destroy?(): void }; uniform: { destroy?(): void }; gradientUniform?: { destroy?(): void }; gpuBytes: number };
  const state = (globalThis as unknown as { __shellxMotionLinearSrgbSdrFinalWebGpuV1?: { resources?: Resources } }).__shellxMotionLinearSrgbSdrFinalWebGpuV1, resources = state?.resources;
  if (!resources) return { hadResources: false, releasedGpuBytes: 0, remainingGpuBytes: 0, releaseFailed: false };
  let releaseFailed = false;
  for (const resource of [resources.working, resources.publication, resources.ditherMask, resources.uniform, resources.gradientUniform]) {
    if (!resource) continue;
    if (typeof resource.destroy !== "function") { releaseFailed = true; continue; }
    try { resource.destroy(); } catch { releaseFailed = true; }
  }
  delete state!.resources;
  return { hadResources: true, releasedGpuBytes: resources.gpuBytes, remainingGpuBytes: 0, releaseFailed };
}

/** Final page close force-releases only on an interrupted caller path and always destroys the device. */
export function closeLinearSrgbSdrFinalWebGpuPage(): { readonly deviceDestroyed: boolean; readonly forcedResourceRelease: boolean; readonly releaseFailed: boolean } {
  type Resources = { working?: { destroy?(): void }; publication?: { destroy?(): void }; ditherMask?: { destroy?(): void }; uniform?: { destroy?(): void }; gradientUniform?: { destroy?(): void } };
  const browser = globalThis as unknown as { __shellxMotionLinearSrgbSdrFinalWebGpuV1?: { device?: { destroy?(): void }; resources?: Resources } }, state = browser.__shellxMotionLinearSrgbSdrFinalWebGpuV1;
  delete browser.__shellxMotionLinearSrgbSdrFinalWebGpuV1;
  if (!state) return { deviceDestroyed: false, forcedResourceRelease: false, releaseFailed: false };
  let forcedResourceRelease = false, releaseFailed = false, deviceDestroyed = false;
  if (state?.resources) {
    forcedResourceRelease = true;
    for (const resource of [state.resources.working, state.resources.publication, state.resources.ditherMask, state.resources.uniform, state.resources.gradientUniform]) {
      if (!resource) continue;
      if (typeof resource?.destroy !== "function") { releaseFailed = true; continue; }
      try { resource.destroy(); } catch { releaseFailed = true; }
    }
  }
  if (typeof state?.device?.destroy !== "function") releaseFailed = true;
  else try { state.device.destroy(); deviceDestroyed = true; } catch { releaseFailed = true; }
  return { deviceDestroyed, forcedResourceRelease, releaseFailed };
}
