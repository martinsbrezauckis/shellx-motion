import { describe, expect, it, vi } from "vitest";
import { renderWebGpuPageSessionAfterimageStackFrame } from "./gpu-page-afterimage-stack-frame";
import { createGpuPageAfterimageStackFixture } from "./unadopted/gpu-page-afterimage-stack.test-support";
import type { InternalGpuFramePlan } from "./gpu-runtime-types";

const descriptor = createGpuPageAfterimageStackFixture({ drawId: "afterimage.draw", width: 4, height: 2 });

describe("module-only afterimage page renderer", () => {
  it.each([false, true])("canonicalizes %s prefix parity onto the retained source", async (oddPrefix) => {
    const calls: Array<{ source: unknown; target: unknown }> = [];
    const groupCurrent = texture("group-current"), groupSource = texture("group-source"), groupTarget = texture("group-target");
    const state = pageState(groupCurrent, groupSource, groupTarget, calls);
    const saved = (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1;
    const restoreGpuGlobals = installGpuGlobals();
    (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = state;
    try {
      const plan = modulePlan(oddPrefix);
      const rendered = await renderWebGpuPageSessionAfterimageStackFrame(plan);
      if (!rendered.ok) throw new Error(rendered.failure.message);
      expect(rendered).toMatchObject({ ok: true });
      expect(calls).toEqual([{ source: groupCurrent, target: groupTarget }]);
      expect(state.afterimageStackFrame).toBeUndefined();
    } finally {
      (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = saved;
      restoreGpuGlobals();
    }
  });

  it("clears a consumed frame holder when module execution refuses", async () => {
    const groupCurrent = texture("group-current"), groupSource = texture("group-source"), groupTarget = texture("group-target");
    const state = pageState(groupCurrent, groupSource, groupTarget, []);
    state.afterimageStackExecute = () => ({ ok: false, failure: { code: "gpu_render_failed", message: "forced" } });
    const saved = (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1;
    const restoreGpuGlobals = installGpuGlobals();
    (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = state;
    try {
      await expect(renderWebGpuPageSessionAfterimageStackFrame(modulePlan(false))).resolves.toMatchObject({ ok: false });
      expect(state.afterimageStackFrame).toBeUndefined();
    } finally {
      (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = saved;
      restoreGpuGlobals();
    }
  });
});

function texture(name: string) { return { name, createView: () => name }; }

function installGpuGlobals(): () => void {
  const global = globalThis as unknown as { GPUBufferUsage?: unknown; GPUTextureUsage?: unknown; GPUMapMode?: unknown; btoa?: unknown };
  const saved = { GPUBufferUsage: global.GPUBufferUsage, GPUTextureUsage: global.GPUTextureUsage, GPUMapMode: global.GPUMapMode, btoa: global.btoa };
  global.GPUBufferUsage = { VERTEX: 1, COPY_DST: 2, UNIFORM: 4, INDEX: 8 };
  global.GPUTextureUsage = { TEXTURE_BINDING: 1 };
  global.GPUMapMode = { READ: 1 };
  global.btoa = () => "";
  return () => Object.assign(global, saved);
}

function pageState(current: ReturnType<typeof texture>, source: ReturnType<typeof texture>, target: ReturnType<typeof texture>, calls: Array<{ source: unknown; target: unknown }>) {
  const rootCurrent = texture("root-current"), rootSource = texture("root-source"), rootTarget = texture("root-target");
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, draw() {}, drawIndexed() {}, end() {} };
  const encoder = { beginRenderPass: vi.fn(() => pass), beginComputePass: vi.fn(() => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} })), copyTextureToBuffer() {}, finish: () => ({}) };
  const readback = { getMappedRange: () => new ArrayBuffer(512), mapAsync: async () => {}, unmap() {} };
  const arena = { readback, root: { current: rootCurrent, source: rootSource, target: rootTarget, scratch: texture("root-scratch") }, keyCleanup: null, groups: [{ current, source, target, scratch: texture("group-scratch") }], depth: null };
  return {
    device: { createCommandEncoder: () => encoder, createBindGroup: () => ({}), createBuffer: () => ({}), createTexture: () => texture("unused"), pushErrorScope() {}, popErrorScope: async () => null, queue: { submit() {}, onSubmittedWorkDone: async () => {}, writeBuffer() {} } },
    rectPipeline: {}, pointPipeline: {}, ellipsePipeline: {}, imagePipeline: { getBindGroupLayout: () => ({}) }, additiveRectPipeline: {}, additivePointPipeline: {}, additiveEllipsePipeline: {}, additiveImagePipeline: { getBindGroupLayout: () => ({}) }, imageSampler: {}, blendPipeline: { getBindGroupLayout: () => ({}) }, adjustmentPipeline: { getBindGroupLayout: () => ({}) }, images: new Map(), textSurfaces: new Map(), limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 }, lost: false,
    resources: { beginFrame() {}, acquireBuffer: () => ({}), environmentUniformBuffer: () => ({}), environmentAccumulator: () => texture("environment"), completeFrame() {} },
    afterimageStackFrame: { fingerprint: "f".repeat(64), descriptorSeal: afterimageDescriptorSeal(), arena, source: current, target, scopeGroupDrawId: descriptor.scopeGroupDrawId },
    afterimageStackMetrics: { uniformBufferSlots: 1 as const, uniformBytes: 160 as const, bindGroupSlots: 1 as const, passes: 0, frames: 0, lateAllocationRefusals: 0, persistentTextureCount: 0 as const },
    afterimageStackExecute(input: { source: unknown; target: unknown }): { ok: true; uniformBytes: 160; maxTextureLoadsPerPixel: 5 } | { ok: false; failure: { code: "gpu_render_failed"; message: string } } { calls.push({ source: input.source, target: input.target }); return { ok: true, uniformBytes: 160, maxTextureLoadsPerPixel: 5 }; }
  };
}

function afterimageDescriptorSeal(): string {
  return JSON.stringify([
    descriptor.schema, descriptor.layerId, descriptor.drawId, descriptor.scopeGroupId, descriptor.scopeGroupDrawId, descriptor.moduleId, descriptor.version,
    descriptor.manifestSha256, descriptor.manifestByteLength, descriptor.registryEntrySha256, descriptor.installationProvenanceSha256,
    descriptor.pipelineImplementationSha256, descriptor.resourceCeilingSha256, descriptor.intrinsic, descriptor.rendererAbi, descriptor.parameterSchema,
    descriptor.referenceFingerprint, descriptor.width, descriptor.height,
    descriptor.echoes.map((echo) => [echo.dxPx, echo.dyPx, echo.rgba8, echo.opacityQ16]),
    descriptor.amountQ16, descriptor.uniformBytes, descriptor.textureLoadCount, descriptor.passCount, descriptor.retainedTextureCount,
    descriptor.descriptorFingerprint, descriptor.bindingFingerprint
  ]);
}

function modulePlan(oddPrefix: boolean): InternalGpuFramePlan {
  const rect = { kind: "rect" as const, id: "plate", x: 0, y: 0, width: 4, height: 2, rotationDeg: 0, pivotX: 0, pivotY: 0, color: { r: 1, g: 0, b: 0, a: 1 }, blendMode: "normal" as const, effects: null };
  const adjustment = { kind: "adjustment" as const, id: "prefix-adjustment", vignette: null, filmGrain: null };
  const effect = { kind: "effectModule" as const, id: descriptor.drawId, blendMode: "normal" as const, effects: null, ...descriptor };
  const prefix = oddPrefix ? [adjustment, rect] : [rect];
  const group = { kind: "groupStart" as const, id: descriptor.scopeGroupDrawId, drawCount: prefix.length + 1, x: 0, y: 0, scale: 1, rotationDeg: 0, pivotX: 0, pivotY: 0, opacity: 1, blendMode: "normal" as const, effects: null };
  return { schema: "shellx-motion/gpu-frame-intent@1", width: 4, height: 2, clear: { r: 0, g: 0, b: 0, a: 0 }, draws: [group, ...prefix, effect, { kind: "groupEnd", id: `${descriptor.scopeGroupDrawId}.end`, groupId: descriptor.scopeGroupDrawId }], fingerprint: "f".repeat(64), budget: { pointBufferBytes: 0, computeParticleBufferBytes: 0, scene3dVertexBufferBytes: 0, scene3dIndexBufferBytes: 0, textCount: 0 } } as InternalGpuFramePlan;
}
