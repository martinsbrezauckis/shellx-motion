import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageAfterimageStackPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };
export type GpuPageAfterimageStackPreparedPassOutput = { ok: true; prepared: GpuPageAfterimageStackPreparedPass } | { ok: false; failure: GpuRuntimeFailure };
export type GpuPageAfterimageStackPassOutput = { ok: true; uniformBytes: 160; maxTextureLoadsPerPixel: 5 } | { ok: false; failure: GpuRuntimeFailure };
export type GpuPageAfterimageStackMetrics = { uniformBufferSlots: 0 | 1; uniformBytes: 0 | 160; bindGroupSlots: 0 | 1; passes: number; frames: number; lateAllocationRefusals: number; persistentTextureCount: 0 };

export interface GpuPageAfterimageStackFrameArena {
  readonly fingerprint: string;
  /** Exact ordered descriptor identity sealed at prepare, before the page executes it. */
  readonly descriptorSeal: string;
  readonly arena: { readonly readback: { getMappedRange(): ArrayBuffer; mapAsync(mode: number): Promise<void>; unmap(): void }; readonly root: unknown; readonly keyCleanup: unknown; readonly groups: Array<{ current: { createView(): unknown }; source: { createView(): unknown } | null; target: { createView(): unknown } | null; scratch: unknown }>; readonly depth: unknown };
  readonly source: { createView(): unknown };
  readonly target: { createView(): unknown };
  readonly scopeGroupDrawId: string;
}

export interface GpuPageAfterimageStackPreparedPass {
  readonly source: { createView(): unknown };
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Descriptor-neutral: one fixed source/extent/uniform binding serves sequential admitted descriptors. */
  /** Pre-reserved 160-byte arena buffer; this leaf never allocates it. */
  readonly uniformBuffer: unknown;
  /** One page-owned packing slab, reused for every frame before queue.writeBuffer. */
  readonly uniformData: ArrayBuffer;
  readonly bindGroup: unknown;
}

/** Trusted session-envelope facts, supplied only after Node-side canonical re-admission. */
export interface GpuPageAfterimageStackImplementationIdentity {
  readonly pipelineImplementationSha256: string;
  readonly resourceCeilingSha256: string;
}

export interface GpuPageAfterimageStackPrepareInput {
  readonly descriptor: unknown;
  /** Production consumes the legacy already-reserved arena under this exact admitted plan fingerprint. */
  readonly frameFingerprint?: string;
  /** Direct test seam; production resolves this from the already-reserved page arena. */
  readonly source?: { createView(): unknown };
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly uniformBuffer?: unknown;
}

export interface GpuPageAfterimageStackPassInput {
  readonly descriptor: unknown;
  readonly prepared: GpuPageAfterimageStackPreparedPass;
  readonly target: { createView(): unknown };
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly encoder: { beginRenderPass(value: unknown): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; draw(vertexCount: number): void; end(): void } };
}

/** Page-local execution seam installed beside the fixed WGSL; no package code crosses it. */
export interface GpuPageAfterimageStackPreparedExecutionInput {
  readonly descriptor: unknown;
  readonly source: { createView(): unknown };
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly target: { createView(): unknown };
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly encoder: { beginRenderPass(value: unknown): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; draw(vertexCount: number): void; end(): void } };
}

/** Installs the one fixed Motion-owned afterimage WGSL pipeline. */
export async function installWebGpuPageSessionAfterimageStackPipeline(identity: GpuPageAfterimageStackImplementationIdentity): Promise<GpuPageAfterimageStackPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown; queue: { writeBuffer(buffer: unknown, offset: number, data: ArrayBuffer): void } };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; afterimageStackPipeline?: unknown; afterimageStackIdentity?: GpuPageAfterimageStackImplementationIdentity; afterimageStackPrepared?: Set<GpuPageAfterimageStackPreparedPass>; afterimageStackFrame?: GpuPageAfterimageStackFrameArena; afterimageStackTarget?: { createView(): unknown }; afterimageStackMetrics?: GpuPageAfterimageStackMetrics; afterimageStackExecute?: (input: GpuPageAfterimageStackPreparedExecutionInput) => GpuPageAfterimageStackPassOutput; afterimageStackClose?: () => { releasedPipeline: boolean; releasedPreparedPasses: number; releasedArenaUniformReferences: number; releasedUniformBuffers: 0 | 1 } } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for afterimage setup." } };
  if (!identity || !hash(identity.pipelineImplementationSha256) || !hash(identity.resourceCeilingSha256)) return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pipeline requires an exact current implementation identity." } };
  if (state.afterimageStackPipeline) {
    const installedIdentity = state.afterimageStackIdentity;
    return installedIdentity && installedIdentity.pipelineImplementationSha256 === identity.pipelineImplementationSha256 && installedIdentity.resourceCeilingSha256 === identity.resourceCeilingSha256
      ? { ok: true }
      : { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pipeline identity changed during a retained page session." } };
  }
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32> }
struct AfterimageStackState { dimensions: vec4<u32>, offsets: array<vec4<i32>,4>, colors: array<vec4<f32>,4>, amount: vec4<f32> }
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> stack: AfterimageStackState;
@vertex fn vs(@builtin(vertex_index) index:u32)->VertexOut { let positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var output:VertexOut;output.position=vec4<f32>(positions[index],0.0,1.0);return output; }
fn over(front:vec4<f32>,back:vec4<f32>)->vec4<f32> { return front+back*(1.0-front.a); }
fn alphaAt(pixel:vec2<i32>,dimensions:vec2<i32>)->f32 { if(pixel.x<0||pixel.y<0||pixel.x>=dimensions.x||pixel.y>=dimensions.y){return 0.0;}return textureLoad(sourceTexture,pixel,0).a; }
@fragment fn fs(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32> {
  let pixel=vec2<i32>(position.xy);let dimensions=vec2<i32>(stack.dimensions.xy);let current=textureLoad(sourceTexture,pixel,0);var echoes=vec4<f32>(0.0);
  for(var reverse:u32=0u;reverse<4u;reverse=reverse+1u){let index=3u-reverse;if(index>=stack.dimensions.z){continue;}let offset=stack.offsets[index];let color=stack.colors[index];let alpha=clamp(alphaAt(pixel-vec2<i32>(offset.xy),dimensions)*color.a*(f32(offset.z)/65535.0)*stack.amount.x,0.0,1.0);echoes=over(vec4<f32>(color.rgb*alpha,alpha),echoes);}
  return clamp(over(current,echoes),vec4<f32>(0.0),vec4<f32>(1.0));
}`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    state.afterimageStackPipeline = state.device.createRenderPipelineAsync
      ? await state.device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } })
      : state.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    state.afterimageStackIdentity = Object.freeze({ pipelineImplementationSha256: identity.pipelineImplementationSha256, resourceCeilingSha256: identity.resourceCeilingSha256 });
    state.afterimageStackExecute = (input: GpuPageAfterimageStackPreparedExecutionInput): GpuPageAfterimageStackPassOutput => {
      const prepared = state.afterimageStackPrepared?.values().next().value;
      const descriptor = input?.descriptor;
      const installedIdentity = state.afterimageStackIdentity;
      const frameSeal = state.afterimageStackFrame?.descriptorSeal;
      if (!prepared || !input || !installedIdentity || !descriptorShape(descriptor) || (frameSeal !== undefined && descriptorSeal(descriptor) !== frameSeal) || descriptor.pipelineImplementationSha256 !== installedIdentity.pipelineImplementationSha256 || descriptor.resourceCeilingSha256 !== installedIdentity.resourceCeilingSha256 || descriptor.width !== prepared.sourceWidth || descriptor.height !== prepared.sourceHeight || input.source !== prepared.source || input.sourceWidth !== prepared.sourceWidth || input.sourceHeight !== prepared.sourceHeight || input.targetWidth !== prepared.sourceWidth || input.targetHeight !== prepared.sourceHeight || input.source === input.target || !input.encoder) return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pass received an invalid prepared execution binding." } };
      try {
        const bytes = prepared.uniformData;
        new Uint32Array(bytes, 0, 4).set([descriptor.width as number, descriptor.height as number, (descriptor.echoes as unknown[]).length, 0]);
        const offsets = new Int32Array(bytes, 16, 16); const colors = new Float32Array(bytes, 80, 16);
        for (let index = 0; index < (descriptor.echoes as Array<{ dxPx: number; dyPx: number; rgba8: [number, number, number, number]; opacityQ16: number }>).length; index += 1) { const echo = (descriptor.echoes as Array<{ dxPx: number; dyPx: number; rgba8: [number, number, number, number]; opacityQ16: number }>)[index]!; offsets.set([echo.dxPx, echo.dyPx, echo.opacityQ16, 0], index * 4); colors.set([echo.rgba8[0] / 255, echo.rgba8[1] / 255, echo.rgba8[2] / 255, echo.rgba8[3] / 255], index * 4); }
        new Float32Array(bytes, 144, 4).set([(descriptor.amountQ16 as number) / 65_535, 0, 0, 0]);
        state.device.queue.writeBuffer(prepared.uniformBuffer, 0, bytes);
        const pass = input.encoder.beginRenderPass({ colorAttachments: [{ view: input.target.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
        pass.setPipeline(state.afterimageStackPipeline); pass.setBindGroup(0, prepared.bindGroup); pass.draw(3); pass.end();
        return { ok: true, uniformBytes: 160, maxTextureLoadsPerPixel: 5 };
      } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed WebGPU afterimage pass failed; the owning page session must close." } }; }
    };
    state.afterimageStackClose = () => {
      const releasedPipeline = state.afterimageStackPipeline !== undefined;
      const releasedPreparedPasses = state.afterimageStackPrepared?.size ?? 0;
      for (const prepared of state.afterimageStackPrepared ?? []) (prepared.uniformBuffer as { destroy?(): void }).destroy?.();
      state.afterimageStackPrepared?.clear();
      delete state.afterimageStackPrepared;
      delete state.afterimageStackFrame;
      delete state.afterimageStackTarget;
      delete state.afterimageStackMetrics;
      delete state.afterimageStackExecute;
      delete state.afterimageStackPipeline;
      delete state.afterimageStackIdentity;
      delete state.afterimageStackClose;
      return { releasedPipeline, releasedPreparedPasses, releasedArenaUniformReferences: releasedPreparedPasses, releasedUniformBuffers: releasedPreparedPasses ? 1 : 0 };
    };
    return { ok: true };
  } catch {
    delete state.afterimageStackPipeline;
    delete state.afterimageStackIdentity;
    delete state.afterimageStackExecute;
    delete state.afterimageStackClose;
    return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU afterimage pipeline creation failed." } };
  }

  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
  function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
  function descriptorShape(value: unknown): value is Record<string, unknown> {
    if (!exactRecord(value, ["schema", "layerId", "drawId", "scopeGroupId", "scopeGroupDrawId", "moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "pipelineImplementationSha256", "resourceCeilingSha256", "intrinsic", "rendererAbi", "parameterSchema", "referenceFingerprint", "width", "height", "echoes", "amountQ16", "uniformBytes", "textureLoadCount", "passCount", "retainedTextureCount", "descriptorFingerprint", "bindingFingerprint"])) return false;
    const width = value.width, height = value.height, amountQ16 = value.amountQ16;
    if (value.schema !== "shellx-motion/gpu-page-afterimage-stack@1" || value.intrinsic !== "motion.afterimage-stack.v1" || value.rendererAbi !== "shellx-motion/gpu-effect-module@1" || value.parameterSchema !== "motion.afterimage-stack.parameters@1" || value.scopeGroupDrawId !== `${value.scopeGroupId}.group` || !hash(value.descriptorFingerprint) || !hash(value.bindingFingerprint) || !integer(width, 1, 4096) || !integer(height, 1, 4096) || !integer(amountQ16, 0, 65535) || !Array.isArray(value.echoes) || value.echoes.length < 1 || value.echoes.length > 4 || value.uniformBytes !== 160 || value.textureLoadCount !== value.echoes.length + 1 || value.passCount !== 1 || value.retainedTextureCount !== 0) return false;
    return value.echoes.every((raw) => {
      if (!exactRecord(raw, ["dxPx", "dyPx", "rgba8", "opacityQ16"])) return false;
      const echo = raw as { dxPx: unknown; dyPx: unknown; opacityQ16: unknown; rgba8: unknown };
      return integer(echo.dxPx, -256, 256) && integer(echo.dyPx, -256, 256) && integer(echo.opacityQ16, 0, 65535) && Array.isArray(echo.rgba8) && echo.rgba8.length === 4 && echo.rgba8.every((channel) => integer(channel, 0, 255));
    });
  }
  function descriptorSeal(value: Record<string, unknown>): string {
    return JSON.stringify([
      value.schema, value.layerId, value.drawId, value.scopeGroupId, value.scopeGroupDrawId, value.moduleId, value.version,
      value.manifestSha256, value.manifestByteLength, value.registryEntrySha256, value.installationProvenanceSha256,
      value.pipelineImplementationSha256, value.resourceCeilingSha256, value.intrinsic, value.rendererAbi, value.parameterSchema,
      value.referenceFingerprint, value.width, value.height,
      (value.echoes as Array<Record<string, unknown>>).map((echo) => [echo.dxPx, echo.dyPx, echo.rgba8, echo.opacityQ16]),
      value.amountQ16, value.uniformBytes, value.textureLoadCount, value.passCount, value.retainedTextureCount,
      value.descriptorFingerprint, value.bindingFingerprint
    ]);
  }
  function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
}

/** Creates the sole bind group once from a pre-reserved arena buffer and stable group texture. */
export function prepareWebGpuPageSessionAfterimageStackPass(input: GpuPageAfterimageStackPrepareInput): GpuPageAfterimageStackPreparedPassOutput {
  type Pipeline = { getBindGroupLayout(index: number): unknown };
  type Device = { createBindGroup(value: unknown): unknown; createBuffer(value: unknown): unknown };
  type Prepared = GpuPageAfterimageStackPreparedPass;
  type Arena = GpuPageAfterimageStackFrameArena["arena"];
  const browserGlobal = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; afterimageStackPipeline?: unknown; afterimageStackIdentity?: GpuPageAfterimageStackImplementationIdentity; afterimageStackPrepared?: Set<Prepared>; afterimageStackFrame?: GpuPageAfterimageStackFrameArena; afterimageStackTarget?: { createView(): unknown }; afterimageStackMetrics?: GpuPageAfterimageStackMetrics; resources?: { takeReservedFrameArena(fingerprint: string): Arena } } | undefined;
  const descriptor = admit(input.descriptor, state?.afterimageStackIdentity);
  let arena: Arena | undefined, source: { createView(): unknown } | undefined, target: { createView(): unknown } | undefined;
  if (descriptor && !input.source) {
    try {
      if (typeof input.frameFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.frameFingerprint)) throw new Error("missing frame reservation");
      arena = state?.resources?.takeReservedFrameArena(input.frameFingerprint);
      const group = arena?.groups[0];
      if (!group?.target || !group.source || group.current === group.target || group.current === group.source || group.target === group.source) throw new Error("invalid isolated group arena");
      source = group.current; target = group.target;
    } catch {
      if (state?.afterimageStackMetrics) state.afterimageStackMetrics.lateAllocationRefusals += 1;
      return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pass was not pre-reserved against its isolated-group source." } };
    }
  }
  source ??= input.source;
  const sourceWidth = input.sourceWidth ?? (arena ? descriptor?.width : undefined);
  const sourceHeight = input.sourceHeight ?? (arena ? descriptor?.height : undefined);
  if (!descriptor || !state || !state.afterimageStackPipeline || !validExtent(sourceWidth, sourceHeight) || sourceWidth !== descriptor.width || sourceHeight !== descriptor.height || !source) return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pass could not prepare its isolated-group binding." } };
  const existing = state.afterimageStackPrepared?.values().next().value;
  if (existing) {
    if (!arena) {
      if (existing.source !== source || existing.sourceWidth !== sourceWidth || existing.sourceHeight !== sourceHeight) return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pass permits one pre-reserved isolated-group bind-group slot per page session." } };
      return { ok: true, prepared: existing };
    }
    const stableTarget = state.afterimageStackTarget;
    if (existing.sourceWidth !== sourceWidth || existing.sourceHeight !== sourceHeight || !stableTarget || (arena && (!target || (source !== existing.source && target !== existing.source) || (source !== stableTarget && target !== stableTarget)))) return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pass permits one pre-reserved isolated-group bind-group slot per page session." } };
    if (arena && input.frameFingerprint) state.afterimageStackFrame = Object.freeze({ fingerprint: input.frameFingerprint, descriptorSeal: descriptor.seal, arena, source: existing.source, target: stableTarget, scopeGroupDrawId: descriptor.scopeGroupDrawId });
    return { ok: true, prepared: existing };
  }
  try {
    const uniformBuffer = input.uniformBuffer ?? (() => { const usage = browserGlobal.GPUBufferUsage; if (!usage || typeof usage.COPY_DST !== "number" || typeof usage.UNIFORM !== "number") throw new Error("uniform usage unavailable"); return state.device.createBuffer({ size: 160, usage: usage.COPY_DST | usage.UNIFORM }); })();
    const pipeline = state.afterimageStackPipeline as Pipeline;
    const prepared: Prepared = Object.freeze({ source, sourceWidth, sourceHeight, uniformBuffer, uniformData: new ArrayBuffer(160), bindGroup: state.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: { buffer: uniformBuffer } }] }) });
    (state.afterimageStackPrepared ??= new Set()).add(prepared);
    state.afterimageStackMetrics = { uniformBufferSlots: 1, uniformBytes: 160, bindGroupSlots: 1, passes: 0, frames: 0, lateAllocationRefusals: 0, persistentTextureCount: 0 };
    if (arena && target && input.frameFingerprint) { state.afterimageStackTarget = target; state.afterimageStackFrame = Object.freeze({ fingerprint: input.frameFingerprint, descriptorSeal: descriptor.seal, arena, source, target, scopeGroupDrawId: descriptor.scopeGroupDrawId }); }
    return { ok: true, prepared };
  } catch {
    return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed WebGPU afterimage pass could not prepare its retained binding; the owning page session must close." } };
  }

  function admit(value: unknown, identity: GpuPageAfterimageStackImplementationIdentity | undefined): { width: number; height: number; scopeGroupDrawId: string; seal: string } | null {
    if (!exactRecord(value, ["schema", "layerId", "drawId", "scopeGroupId", "scopeGroupDrawId", "moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "pipelineImplementationSha256", "resourceCeilingSha256", "intrinsic", "rendererAbi", "parameterSchema", "referenceFingerprint", "width", "height", "echoes", "amountQ16", "uniformBytes", "textureLoadCount", "passCount", "retainedTextureCount", "descriptorFingerprint", "bindingFingerprint"])) return null;
    const width = readInteger(value.width, 1, 4096), height = readInteger(value.height, 1, 4096);
    if (value.schema !== "shellx-motion/gpu-page-afterimage-stack@1" || value.intrinsic !== "motion.afterimage-stack.v1" || value.rendererAbi !== "shellx-motion/gpu-effect-module@1" || value.parameterSchema !== "motion.afterimage-stack.parameters@1" || !identity || value.pipelineImplementationSha256 !== identity.pipelineImplementationSha256 || value.resourceCeilingSha256 !== identity.resourceCeilingSha256 || !identifier(value.layerId) || !identifier(value.drawId) || !identifier(value.scopeGroupId) || !identifier(value.scopeGroupDrawId) || !moduleId(value.moduleId) || !coreSealedVersion(value.version) || !hash(value.manifestSha256) || !integer(value.manifestByteLength, 1, 16384) || !hash(value.registryEntrySha256) || !hash(value.installationProvenanceSha256) || !hash(value.pipelineImplementationSha256) || !hash(value.resourceCeilingSha256) || !hash(value.referenceFingerprint) || !hash(value.descriptorFingerprint) || !hash(value.bindingFingerprint) || width === null || height === null || width * height > 16777216 || !integer(value.amountQ16, 0, 65535) || !Array.isArray(value.echoes) || value.echoes.length < 1 || value.echoes.length > 4 || value.uniformBytes !== 160 || value.textureLoadCount !== value.echoes.length + 1 || value.passCount !== 1 || value.retainedTextureCount !== 0) return null;
    for (const echo of value.echoes) if (!exactRecord(echo, ["dxPx", "dyPx", "rgba8", "opacityQ16"]) || !integer(echo.dxPx, -256, 256) || !integer(echo.dyPx, -256, 256) || !integer(echo.opacityQ16, 0, 65535) || !Array.isArray(echo.rgba8) || echo.rgba8.length !== 4 || !echo.rgba8.every((channel) => integer(channel, 0, 255))) return null;
    return { width, height, scopeGroupDrawId: value.scopeGroupDrawId, seal: descriptorSeal(value) };
  }
  function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
  function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
  function readInteger(value: unknown, minimum: number, maximum: number): number | null { return integer(value, minimum, maximum) ? value : null; }
  function validExtent(width: unknown, height: unknown): width is number { return integer(width, 1, 4096) && integer(height, 1, 4096) && width * height <= 16777216; }
  function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
  function moduleId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$/.test(value); }
  /** Serialized Core-equivalent grammar; page closures cannot import the Core module. */
  function coreSealedVersion(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
    let index = 0;
    const digit = (code: number) => code >= 48 && code <= 57;
    const numeric = () => { const start = index; while (index < value.length && digit(value.charCodeAt(index))) index += 1; return index > start && !(value.charCodeAt(start) === 48 && index - start > 1); };
    if (!numeric() || value[index++] !== "." || !numeric() || value[index++] !== "." || !numeric()) return false;
    if (index === value.length) return true;
    if (value[index++] !== "-") return false;
    while (index < value.length) {
      const start = index; let allDigits = true;
      while (index < value.length && value[index] !== ".") { const code = value.charCodeAt(index); if (!(digit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45)) return false; if (!digit(code)) allDigits = false; index += 1; }
      if (index === start || (allDigits && value.charCodeAt(start) === 48 && index - start > 1)) return false;
      if (index === value.length) return true;
      index += 1;
    }
    return false;
  }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
  function descriptorSeal(value: Record<string, unknown>): string {
    return JSON.stringify([
      value.schema, value.layerId, value.drawId, value.scopeGroupId, value.scopeGroupDrawId, value.moduleId, value.version,
      value.manifestSha256, value.manifestByteLength, value.registryEntrySha256, value.installationProvenanceSha256,
      value.pipelineImplementationSha256, value.resourceCeilingSha256, value.intrinsic, value.rendererAbi, value.parameterSchema,
      value.referenceFingerprint, value.width, value.height,
      (value.echoes as Array<Record<string, unknown>>).map((echo) => [echo.dxPx, echo.dyPx, echo.rgba8, echo.opacityQ16]),
      value.amountQ16, value.uniformBytes, value.textureLoadCount, value.passCount, value.retainedTextureCount,
      value.descriptorFingerprint, value.bindingFingerprint
    ]);
  }
}

/** Emits one source-to-target pass with no per-frame GPU-object allocation. */
export function renderWebGpuPageSessionAfterimageStackPass(input: GpuPageAfterimageStackPassInput): GpuPageAfterimageStackPassOutput {
  type Device = { queue: { writeBuffer(buffer: unknown, offset: number, data: ArrayBuffer): void } };
  type Echo = { dxPx: number; dyPx: number; rgba8: [number, number, number, number]; opacityQ16: number };
  type Descriptor = { width: number; height: number; echoes: Echo[]; amountQ16: number };
  type Prepared = GpuPageAfterimageStackPreparedPass;
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; afterimageStackPipeline?: unknown; afterimageStackIdentity?: GpuPageAfterimageStackImplementationIdentity; afterimageStackPrepared?: Set<Prepared> } | undefined;
  const descriptor = admit(input.descriptor, state?.afterimageStackIdentity);
  if (!descriptor || !state || !state.afterimageStackPipeline || !state.afterimageStackPrepared?.has(input.prepared) || input.prepared.sourceWidth !== descriptor.width || input.prepared.sourceHeight !== descriptor.height || input.targetWidth !== descriptor.width || input.targetHeight !== descriptor.height || input.prepared.source === input.target || !input.encoder) return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pass received an invalid isolated-group binding." } };
  try {
    const bytes = input.prepared.uniformData;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== 160) return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed afterimage pass lost its pre-reserved packing slab." } };
    new Uint32Array(bytes, 0, 4).set([descriptor.width, descriptor.height, descriptor.echoes.length, 0]);
    const offsets = new Int32Array(bytes, 16, 16); const colors = new Float32Array(bytes, 80, 16);
    for (let index = 0; index < descriptor.echoes.length; index += 1) { const echo = descriptor.echoes[index]; offsets.set([echo.dxPx, echo.dyPx, echo.opacityQ16, 0], index * 4); colors.set([echo.rgba8[0] / 255, echo.rgba8[1] / 255, echo.rgba8[2] / 255, echo.rgba8[3] / 255], index * 4); }
    new Float32Array(bytes, 144, 4).set([descriptor.amountQ16 / 65535, 0, 0, 0]);
    state.device.queue.writeBuffer(input.prepared.uniformBuffer, 0, bytes);
    const pass = input.encoder.beginRenderPass({ colorAttachments: [{ view: input.target.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(state.afterimageStackPipeline); pass.setBindGroup(0, input.prepared.bindGroup); pass.draw(3); pass.end();
    return { ok: true, uniformBytes: 160, maxTextureLoadsPerPixel: 5 };
  } catch {
    return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed WebGPU afterimage pass failed; the owning page session must close." } };
  }

  function admit(value: unknown, identity: GpuPageAfterimageStackImplementationIdentity | undefined): Descriptor | null {
    if (!exactRecord(value, ["schema", "layerId", "drawId", "scopeGroupId", "scopeGroupDrawId", "moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "pipelineImplementationSha256", "resourceCeilingSha256", "intrinsic", "rendererAbi", "parameterSchema", "referenceFingerprint", "width", "height", "echoes", "amountQ16", "uniformBytes", "textureLoadCount", "passCount", "retainedTextureCount", "descriptorFingerprint", "bindingFingerprint"])) return null;
    const width = readInteger(value.width, 1, 4096), height = readInteger(value.height, 1, 4096);
    if (value.schema !== "shellx-motion/gpu-page-afterimage-stack@1" || value.intrinsic !== "motion.afterimage-stack.v1" || value.rendererAbi !== "shellx-motion/gpu-effect-module@1" || value.parameterSchema !== "motion.afterimage-stack.parameters@1" || !identity || value.pipelineImplementationSha256 !== identity.pipelineImplementationSha256 || value.resourceCeilingSha256 !== identity.resourceCeilingSha256 || !identifier(value.layerId) || !identifier(value.drawId) || !identifier(value.scopeGroupId) || !identifier(value.scopeGroupDrawId) || !moduleId(value.moduleId) || !coreSealedVersion(value.version) || !hash(value.manifestSha256) || !integer(value.manifestByteLength, 1, 16384) || !hash(value.registryEntrySha256) || !hash(value.installationProvenanceSha256) || !hash(value.pipelineImplementationSha256) || !hash(value.resourceCeilingSha256) || !hash(value.referenceFingerprint) || !hash(value.descriptorFingerprint) || !hash(value.bindingFingerprint) || width === null || height === null || width * height > 16777216 || !integer(value.amountQ16, 0, 65535) || !Array.isArray(value.echoes) || value.echoes.length < 1 || value.echoes.length > 4 || value.uniformBytes !== 160 || value.textureLoadCount !== value.echoes.length + 1 || value.passCount !== 1 || value.retainedTextureCount !== 0) return null;
    const echoes: Echo[] = [];
    for (const rawEcho of value.echoes) { if (!exactRecord(rawEcho, ["dxPx", "dyPx", "rgba8", "opacityQ16"]) || !integer(rawEcho.dxPx, -256, 256) || !integer(rawEcho.dyPx, -256, 256) || !integer(rawEcho.opacityQ16, 0, 65535) || !Array.isArray(rawEcho.rgba8) || rawEcho.rgba8.length !== 4 || !rawEcho.rgba8.every((channel) => integer(channel, 0, 255))) return null; echoes.push({ dxPx: rawEcho.dxPx, dyPx: rawEcho.dyPx, rgba8: [rawEcho.rgba8[0], rawEcho.rgba8[1], rawEcho.rgba8[2], rawEcho.rgba8[3]], opacityQ16: rawEcho.opacityQ16 }); }
    return { width, height, echoes, amountQ16: value.amountQ16 };
  }
  function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
  function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
  function readInteger(value: unknown, minimum: number, maximum: number): number | null { return integer(value, minimum, maximum) ? value : null; }
  function validExtent(width: unknown, height: unknown): width is number { return integer(width, 1, 4096) && integer(height, 1, 4096) && width * height <= 16777216; }
  function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
  function moduleId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$/.test(value); }
  /** Serialized Core-equivalent grammar; page closures cannot import the Core module. */
  function coreSealedVersion(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
    let index = 0;
    const digit = (code: number) => code >= 48 && code <= 57;
    const numeric = () => { const start = index; while (index < value.length && digit(value.charCodeAt(index))) index += 1; return index > start && !(value.charCodeAt(start) === 48 && index - start > 1); };
    if (!numeric() || value[index++] !== "." || !numeric() || value[index++] !== "." || !numeric()) return false;
    if (index === value.length) return true;
    if (value[index++] !== "-") return false;
    while (index < value.length) {
      const start = index; let allDigits = true;
      while (index < value.length && value[index] !== ".") { const code = value.charCodeAt(index); if (!(digit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45)) return false; if (!digit(code)) allDigits = false; index += 1; }
      if (index === start || (allDigits && value.charCodeAt(start) === 48 && index - start > 1)) return false;
      if (index === value.length) return true;
      index += 1;
    }
    return false;
  }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
}

/** Reads the module-only allocation proof without changing the legacy page metrics object. */
export function readWebGpuPageSessionAfterimageStackMetrics(): GpuPageAfterimageStackMetrics | null {
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: { afterimageStackMetrics?: GpuPageAfterimageStackMetrics } };
  const metrics = browserGlobal.__shellxMotionGpuSessionV1?.afterimageStackMetrics;
  return metrics ? Object.freeze({ ...metrics }) : null;
}

/** Releases only module-owned fixed pipeline/bind-group/uniform references. */
export function closeWebGpuPageSessionAfterimageStackPipeline(): { releasedPipeline: boolean; releasedPreparedPasses: number; releasedArenaUniformReferences: number; releasedUniformBuffers: 0 | 1 } {
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: { afterimageStackPipeline?: unknown; afterimageStackIdentity?: unknown; afterimageStackPrepared?: Set<{ uniformBuffer: { destroy?(): void } }>; afterimageStackFrame?: unknown; afterimageStackTarget?: unknown; afterimageStackMetrics?: unknown; afterimageStackExecute?: unknown; afterimageStackClose?: () => { releasedPipeline: boolean; releasedPreparedPasses: number; releasedArenaUniformReferences: number; releasedUniformBuffers: 0 | 1 } } };
  const state = browserGlobal.__shellxMotionGpuSessionV1;
  if (state?.afterimageStackClose) return state.afterimageStackClose();
  const releasedPipeline = state?.afterimageStackPipeline !== undefined;
  const releasedPreparedPasses = state?.afterimageStackPrepared?.size ?? 0;
  const releasedArenaUniformReferences = releasedPreparedPasses;
  for (const prepared of state?.afterimageStackPrepared ?? []) prepared.uniformBuffer.destroy?.();
  state?.afterimageStackPrepared?.clear(); if (state) { delete state.afterimageStackPrepared; delete state.afterimageStackFrame; delete state.afterimageStackTarget; delete state.afterimageStackMetrics; delete state.afterimageStackExecute; delete state.afterimageStackPipeline; delete state.afterimageStackIdentity; }
  return { releasedPipeline, releasedPreparedPasses, releasedArenaUniformReferences, releasedUniformBuffers: releasedPreparedPasses ? 1 : 0 };
}
