import { createContext, runInContext } from "node:vm";
import { compileGpuFramePlan, evaluateMotionParticles } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { evaluateFixedGpuParticleGolden } from "./gpu-page-particle-compute-golden.test-support";
import { installWebGpuPageSessionParticleCompute } from "./gpu-page-particle-compute";

const descriptor = (atMs: number, count = 100_000) => ({ kind: "particleCompute" as const, id: "dust", schema: "shellx-motion/gpu-compute-particle-field@1" as const, blendMode: "normal" as const, effects: null, seed: 71, count, atMs, startMs: 0, lifetimeMs: 2_000, width: 80, height: 40, x: 0, y: 0, scale: 1, originX: 40, originY: 20, rotationDeg: 0, opacity: 1, color: { r: 1, g: 0.5, b: 0.25, a: 1 }, secondaryColor: { r: 0.25, g: 0.625, b: 1, a: 1 }, minSize: 4, maxSize: 8, minSpeed: 12, maxSpeed: 30, direction: -70, spread: 40, gravity: 6, fadeOut: true, sources: [{ kind: "radial" as const, centerX: 0.25, centerY: 0.75, strength: 0.3, softening: 0.2 }, { kind: "vortex" as const, centerX: 0.6, centerY: 0.4, strength: -0.5, softening: 0.12 }] });

describe("fixed WebGPU analytic particle field", () => {
  it("keeps particle zero within float32 tolerance of the Core radial/vortex evaluator at canonical times", () => {
    const emitter = { seed: 71, count: 100_000, lifetimeMs: 2_000, shape: "circle" as const, color: "#ff8040", secondaryColor: "#40a0ff", minSize: 4, maxSize: 8, minSpeed: 12, maxSpeed: 30, direction: -70, spread: 40, gravity: 6, fadeOut: true, field: { schema: "shellx-motion/particle-field@1" as const, sources: descriptor(0).sources } };
    for (const atMs of [0, 500, 1_400]) {
      const core = evaluateMotionParticles({ emitter, atMs, startMs: 0, width: 80, height: 40 })[0];
      const golden = evaluateFixedGpuParticleGolden({ ...descriptor(atMs), index: 0 });
      expect(golden.x).toBeCloseTo(core.x + core.size / 2, 3);
      expect(golden.y).toBeCloseTo(core.y + core.size / 2, 3);
      expect(golden.size).toBeCloseTo(core.size, 3);
      expect(golden.color.a).toBeCloseTo(core.opacity, 3);
    }
  });

  it("dispatches only fixed 100k/131072 capacities, reuses two buffers, and destroys every allocation", async () => {
    const destroy = vi.fn(), createBuffer = vi.fn(() => ({ destroy })), writeBuffer = vi.fn(), dispatchWorkgroups = vi.fn();
    const context = computeContext({ createBuffer, writeBuffer, dispatchWorkgroups, maxStorageBufferBindingSize: 8 * 1024 * 1024 });
    const install = runInContext(`(${installWebGpuPageSessionParticleCompute.toString()})`, context) as typeof installWebGpuPageSessionParticleCompute;
    expect(await install()).toEqual({ ok: true });
    runInContext(`globalThis.__shellxMotionGpuSessionV1.computeParticles.render(${JSON.stringify(descriptor(0))},80,40,{beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups:globalThis.dispatchWorkgroups,end(){}})});`, context);
    const firstBuffers = createBuffer.mock.calls.length;
    runInContext(`globalThis.__shellxMotionGpuSessionV1.computeParticles.render(${JSON.stringify(descriptor(500))},80,40,{beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups:globalThis.dispatchWorkgroups,end(){}})});`, context);
    expect(firstBuffers).toBe(3); expect(createBuffer).toHaveBeenCalledTimes(3); expect(dispatchWorkgroups).toHaveBeenNthCalledWith(1, 391); expect(dispatchWorkgroups).toHaveBeenNthCalledWith(2, 391);
    expect(runInContext("globalThis.__shellxMotionGpuSessionV1.computeParticles.snapshot()", context)).toMatchObject({ computeField: "fixed-analytic-v1", computeParticleBufferSlots: 2, computeParticleBufferBytes: 6_400_000, computeParticleDispatches: 2 });
    runInContext("globalThis.__shellxMotionGpuSessionV1.computeParticles.destroy()", context); expect(destroy).toHaveBeenCalledTimes(3);
  });

  it("uses a bounded adapter refusal before compute allocations or dispatch", async () => {
    const createBuffer = vi.fn(), dispatchWorkgroups = vi.fn(); const context = computeContext({ createBuffer, writeBuffer: vi.fn(), dispatchWorkgroups, maxStorageBufferBindingSize: 3_199_999 });
    const install = runInContext(`(${installWebGpuPageSessionParticleCompute.toString()})`, context) as typeof installWebGpuPageSessionParticleCompute;
    expect(await install()).toEqual({ ok: true });
    expect(() => runInContext(`globalThis.__shellxMotionGpuSessionV1.computeParticles.render(${JSON.stringify(descriptor(0))},80,40,{beginComputePass(){throw new Error('must not dispatch')}});`, context)).toThrow("storage-buffer limit");
    expect(createBuffer).not.toHaveBeenCalled(); expect(dispatchWorkgroups).not.toHaveBeenCalled();
  });

  it("holds the full 131072 route to exactly 512 workgroups", async () => {
    const createBuffer = vi.fn(() => ({ destroy: vi.fn() })), dispatchWorkgroups = vi.fn(); const context = computeContext({ createBuffer, writeBuffer: vi.fn(), dispatchWorkgroups, maxStorageBufferBindingSize: 8 * 1024 * 1024 });
    const install = runInContext(`(${installWebGpuPageSessionParticleCompute.toString()})`, context) as typeof installWebGpuPageSessionParticleCompute;
    await install(); runInContext(`globalThis.__shellxMotionGpuSessionV1.computeParticles.render(${JSON.stringify(descriptor(0, 131072))},80,40,{beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups:globalThis.dispatchWorkgroups,end(){}})});`, context);
    expect(dispatchWorkgroups).toHaveBeenCalledWith(512);
  });

  it("refuses an asynchronously rejected fixed WGSL pipeline before buffers or dispatch", async () => {
    const createBuffer = vi.fn();
    const dispatchWorkgroups = vi.fn();
    const context = computeContext({ createBuffer, writeBuffer: vi.fn(), dispatchWorkgroups, maxStorageBufferBindingSize: 8 * 1024 * 1024, createComputePipelineAsync: async () => { throw new Error("WGSL validation"); } });
    const install = runInContext(`(${installWebGpuPageSessionParticleCompute.toString()})`, context) as typeof installWebGpuPageSessionParticleCompute;
    await expect(install()).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringContaining("fixed particle compute") } });
    expect(createBuffer).not.toHaveBeenCalled();
    expect(dispatchWorkgroups).not.toHaveBeenCalled();
  });

  it("keeps canonical replay descriptors pure across repeat and out-of-order timestamps", () => {
    const first = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: 80, height: 40, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [descriptor(500)] });
    const later = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: 80, height: 40, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [descriptor(1_400)] });
    const replay = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: 80, height: 40, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [descriptor(500)] });
    expect(replay.fingerprint).toBe(first.fingerprint); expect(later.fingerprint).not.toBe(first.fingerprint); expect(replay.draws[0]).toEqual(first.draws[0]);
  });
});

function computeContext(input: { createBuffer: ReturnType<typeof vi.fn>; writeBuffer: ReturnType<typeof vi.fn>; dispatchWorkgroups: ReturnType<typeof vi.fn>; maxStorageBufferBindingSize: number; createComputePipelineAsync?: () => Promise<unknown> }) {
  return createContext({ Array, ArrayBuffer, Float32Array, Uint32Array, Math, Number, Object, Error, GPUBufferUsage: { STORAGE: 1, VERTEX: 2, COPY_DST: 4, UNIFORM: 8 }, dispatchWorkgroups: input.dispatchWorkgroups, __shellxMotionGpuSessionV1: { device: { createBuffer: input.createBuffer, createShaderModule: vi.fn(), createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })), ...(input.createComputePipelineAsync ? { createComputePipelineAsync: input.createComputePipelineAsync } : {}), createBindGroup: vi.fn(() => ({})), queue: { writeBuffer: input.writeBuffer } }, limits: { maxBufferSize: 8 * 1024 * 1024, maxStorageBufferBindingSize: input.maxStorageBufferBindingSize } } });
}
