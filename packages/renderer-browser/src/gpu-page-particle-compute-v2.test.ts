import { afterEach, describe, expect, it } from "vitest";
import { createContext, runInContext } from "node:vm";
import { closeWebGpuPageSession } from "./gpu-page-session-close";
import { installWebGpuPageSessionParticleComputeV2, type GpuPageParticleV2Draw } from "./gpu-page-particle-compute-v2";

type Buffer = { destroyed: boolean; destroy(): void };
type EncoderMock = { dispatches: number[]; draws: Array<[number, number]>; beginComputePass(): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; dispatchWorkgroups(count: number): void; end(): void }; beginRenderPass(): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; setVertexBuffer(index: number, value: unknown): void; draw(vertices: number, instances: number): void; end(): void } };
type PageState = { device: ReturnType<typeof fakeDevice>["device"]; limits: { maxBufferSize: number; maxStorageBufferBindingSize: number }; computeParticlesV2?: { render(draw: GpuPageParticleV2Draw, width: number, height: number, encoder: EncoderMock, target: {createView():unknown}): void; snapshot(): { computeParticleBufferSlots: number; computeParticleBufferBytes: number; computeParticleDispatches: number }; destroy(): void } };

afterEach(() => { delete (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1; delete (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage; });

describe("fixed v2 particle page compute", () => {
  it("rejects a real asynchronous shader pipeline failure without publishing retained state", async () => {
    const fake = fakeDevice(true);
    installState(fake.device);
    await expect(installWebGpuPageSessionParticleComputeV2()).resolves.toMatchObject({ ok: false });
    expect((globalThis as { __shellxMotionGpuSessionV1?: PageState }).__shellxMotionGpuSessionV1?.computeParticlesV2).toBeUndefined();
  });

  it("reports the first browser WGSL compiler error before creating a pipeline", async () => {
    const fake = fakeDevice(false, { type: "error", lineNum: 7, linePos: 11, message: "invalid fixed expression" });
    installState(fake.device);
    await expect(installWebGpuPageSessionParticleComputeV2()).resolves.toMatchObject({
      ok: false,
      failure: { code: "gpu_render_failed", message: expect.stringContaining("compute WGSL 7:11: invalid fixed expression") }
    });
  });

  it("runs once after page-style source serialization without module helper captures", async () => {
    const fake = fakeDevice(false);
    const context = createContext({ ArrayBuffer, Float32Array, Uint32Array, JSON, Math, Number, Object, Promise, Error, GPUBufferUsage: { STORAGE: 1, VERTEX: 2, COPY_DST: 4, UNIFORM: 8 }, __shellxMotionGpuSessionV1: { device: fake.device, limits: { maxBufferSize: 32 * 1024 * 1024, maxStorageBufferBindingSize: 32 * 1024 * 1024 } }, drawJson: JSON.stringify(goldenDraw()) });
    const install = runInContext(`(${installWebGpuPageSessionParticleComputeV2.toString()})`, context) as typeof installWebGpuPageSessionParticleComputeV2;
    expect(await install()).toEqual({ ok: true });
    expect(() => runInContext("globalThis.draw=JSON.parse(drawJson);globalThis.dispatches=[];globalThis.encoder={beginComputePass(){return{setPipeline(){},setBindGroup(){},dispatchWorkgroups(n){dispatches.push(n)},end(){}}},beginRenderPass(){return{setPipeline(){},setBindGroup(){},setVertexBuffer(){},draw(){},end(){}}}};globalThis.__shellxMotionGpuSessionV1.computeParticlesV2.render(draw,1920,1080,encoder,{createView(){return {}}});", context)).not.toThrow();
    expect(runInContext("globalThis.dispatches", context)).toEqual([391]);
  });

  it("accepts only the existing bounded mask record without widening its page descriptor keys", async () => {
    const fake = fakeDevice(false), state = installState(fake.device);
    await expect(installWebGpuPageSessionParticleComputeV2()).resolves.toEqual({ ok: true });
    const installed = state.computeParticlesV2;
    if (!installed) throw new Error("v2 test install failed");
    const mask = { shape: "rect" as const, x: 4, y: 2, width: 72, height: 36, radius: 6, rotationDeg: 0, pivotX: 40, pivotY: 20, inverted: false, opacity: 1, featherPx: 0 };
    expect(() => installed.render({ ...goldenDraw(), mask }, 960, 540, encoder(), { createView: () => ({}) })).not.toThrow();
    for (const invalid of [{ ...mask, shape: "path" }, { ...mask, radius: 19 }, { ...mask, extra: true }]) {
      expect(() => installed.render({ ...goldenDraw(), mask: invalid } as GpuPageParticleV2Draw, 960, 540, encoder(), { createView: () => ({}) })).toThrow(/descriptor/i);
    }
  });

  it("encodes the fixed 432-byte golden ABI, retains exactly two buffers, and never grows", async () => {
    const fake = fakeDevice(false), state = installState(fake.device);
    await expect(installWebGpuPageSessionParticleComputeV2()).resolves.toEqual({ ok: true });
    const installed = state.computeParticlesV2;
    if (!installed) throw new Error("v2 test install failed");
    for (const malformed of [{ ...goldenDraw(), unexpected: true }, { ...goldenDraw(), sources: [{ ...goldenDraw().sources[0], unexpected: true }] }, { ...goldenDraw(), origins: [{ ...goldenDraw().origins[0], directionOffsetDeg: 361 }] }, { ...goldenDraw(), trail: { ...goldenDraw().trail!, unexpected: true } }, { ...goldenDraw(), shading: { ...goldenDraw().shading, unexpected: true } }]) expect(() => installed.render(malformed as GpuPageParticleV2Draw, 1920, 1080, encoder(), { createView: () => ({}) })).toThrow(/descriptor/i);
    expect(installed.snapshot()).toMatchObject({ computeParticleBufferSlots: 0, lateAllocationRefusals: 5 });
    const commands = encoder();
    installed.render(goldenDraw(), 1920, 1080, commands, { createView: () => ({}) });
    expect(fake.uniformWrites).toHaveLength(1);
    const uniform = new Float32Array(fake.uniformWrites[0]);
    expect(uniform.byteLength).toBe(432);
    expect(uniform[104]).toBeCloseTo(0.73); // explicit trail opacity vec4[25].x
    expect(fake.computeCode).toContain("p.values[0].w>0.5"); // fadeOut, never seed
    expect(fake.computeCode).toContain("let delta=vec2<f32>(a.y,a.z)-n"); // outward impact parity
    expect(fake.computeCode).toContain("bitcast<u32>(i32(floor(x*4096.0)))"); // signed turbulence cells
    expect(fake.computeCode).toContain("let globalProgress=clamp((time-timing.y)/timing.z,0.0,1.0)");
    expect(fake.computeCode).toContain("let threshold=rnd(");
    expect(fake.computeCode).not.toContain("let target=");
    expect(fake.computeCode).toContain("if(s<3u){t2=t1;t3=t1;}else if(s<4u){t3=t2;}");
    expect(fake.computeCode).toContain("var t1=position(");
    expect(fake.computeCode).toContain("var t2=position(");
    expect(fake.computeCode).toContain("var t3=position(");
    expect(fake.shaderCode).toContain("let local=delta/input.head.zw");
    expect(fake.shaderCode).toContain("return clamp(i.color*coverage");
    expect(fake.shaderCode).toContain("let glowAmount=fract(input.tail.w)*4.");
    expect(fake.shaderCode).toContain("1.+glowAmount*.8");
    expect(commands.dispatches).toEqual([391]);
    expect(commands.draws).toEqual([[18, 100_000], [6, 100_000]]);
    expect(installed.snapshot()).toMatchObject({ abi: "shellx-motion/gpu-compute-particle-field@2", instanceBytes: 64, retainedBufferCount: 2, uniformBytes: 432, computeParticleBufferSlots: 2, computeParticleBufferBytes: 12_800_000, computeParticleDispatches: 1, rasterCalls: 2, headRasterCalls: 1, trailRasterCalls: 1 });
    expect(() => installed.render({ ...goldenDraw(), count: 100_001, retainedInstanceBytes: 12_800_128 }, 1920, 1080, encoder(), { createView: () => ({}) })).toThrow(/cannot grow/i);
    await closeWebGpuPageSession();
    expect(fake.buffers.every((buffer) => buffer.destroyed)).toBe(true);
  });

  it("keeps 2/3/4 trail topology and synchronized impact timing deterministic across particle indices", () => {
    expect(trailTopology(2)).toEqual(["head-t1"]);
    expect(trailTopology(3)).toEqual(["head-t1", "t1-t2"]);
    expect(trailTopology(4)).toEqual(["head-t1", "t1-t2", "t2-t3"]);
    const sampleTimes = [-1, 200, 450, 700, 1_100];
    const pulses = sampleTimes.map((time) => impactPulse(time, 0, 1_000, .2, .5));
    expect(pulses[0]).toBe(0); expect(pulses[1]).toBe(0); expect(pulses[2]).toBe(1); expect(pulses[3]).toBeCloseTo(0); expect(pulses[4]).toBe(0);
    for (const index of [0, 1, 4_096, 99_999]) expect(impactPulse(450, 0, 1_000, .2, .5)).toBe(1);
    expect(glowHalo(0)).toBe(1); expect(glowHalo(1)).toBe(1.8); expect(glowHalo(1)).toBeGreaterThan(glowHalo(.5));
  });
});

function trailTopology(samples: number): string[] { return samples === 2 ? ["head-t1"] : samples === 3 ? ["head-t1", "t1-t2"] : ["head-t1", "t1-t2", "t2-t3"]; }
function impactPulse(time: number, startMs: number, lifetimeMs: number, startProgress: number, durationProgress: number): number { const global = Math.min(1, Math.max(0, (time - startMs) / lifetimeMs)); const local = (global - startProgress) / durationProgress; return local < 0 || local > 1 ? 0 : Math.sin(Math.PI * local); }
function glowHalo(amount: number): number { return 1 + amount * .8; }

function goldenDraw(): GpuPageParticleV2Draw { return { kind: "particleCompute", id: "field-v2", blendMode: "normal", effects: null, schema: "shellx-motion/gpu-compute-particle-field@2", seed: 7, count: 100_000, atMs: 625, startMs: 0, lifetimeMs: 1_000, width: 960, height: 540, x: 0, y: 0, scale: 1, originX: 480, originY: 270, rotationDeg: 0, opacity: 1, color: {r:1,g:.2,b:.1,a:1}, secondaryColor: {r:.1,g:.5,b:1,a:1}, minSize: 2, maxSize: 6, minSpeed: 40, maxSpeed: 80, direction: 0, spread: 40, gravity: 0, fadeOut: false, sources: [{kind:"radial",centerX:.3,centerY:.2,strength:.4,softening:.2},{kind:"vortex",centerX:.6,centerY:.7,strength:-.3,softening:.1},{kind:"turbulence",scale:1.5,strength:.2},{kind:"impact",centerX:.5,centerY:.5,radius:.3,strength:.6,startProgress:.2,durationProgress:.5}], origins: [{x:.1,y:.1,weight:.1,directionOffsetDeg:-10,speedScale:.5},{x:.3,y:.4,weight:.2,directionOffsetDeg:0,speedScale:1},{x:.7,y:.6,weight:.3,directionOffsetDeg:15,speedScale:1.5},{x:.9,y:.8,weight:.4,directionOffsetDeg:30,speedScale:2}], trail: {durationMs:120,samples:4,opacity:.73}, shading: {mode:"glow",sizeJitter:.2,opacityJitter:.1,glow:.6}, computeDispatchCount: 1, rasterPassCount: 2, instanceBytes: 64, retainedBufferCount: 2, retainedInstanceBytes: 12_800_000 }; }

function installState(device: ReturnType<typeof fakeDevice>["device"]): PageState { (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage = { STORAGE: 1, VERTEX: 2, COPY_DST: 4, UNIFORM: 8 }; const state: PageState = { device, limits: { maxBufferSize: 32 * 1024 * 1024, maxStorageBufferBindingSize: 32 * 1024 * 1024 } }; (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = state; return state; }
function encoder(): EncoderMock { const dispatches: number[] = [], draws: Array<[number, number]> = []; return { dispatches, draws, beginComputePass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: (count: number) => dispatches.push(count), end: () => {} }), beginRenderPass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {}, draw: (vertices: number, instances: number) => draws.push([vertices, instances]), end: () => {} }) }; }
function fakeDevice(rejectAsync: boolean, compilationError?: { type: string; lineNum: number; linePos: number; message: string }) { const buffers: Buffer[] = [], uniformWrites: ArrayBuffer[] = []; let computeCode = "", shaderCode = ""; const device = { createBuffer: () => { const buffer: Buffer = { destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; }, createShaderModule: (input: {code:string}) => { const compute = input.code.includes("@compute"); shaderCode += input.code; if (compute) computeCode = input.code; return { getCompilationInfo: async () => ({ messages: compute && compilationError ? [compilationError] : [] }) }; }, createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }), createComputePipelineAsync: async () => { if (rejectAsync) throw new Error("WGSL rejected"); return { getBindGroupLayout: () => ({}) }; }, createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }), createBindGroup: () => ({}), queue: { writeBuffer: (_buffer: Buffer, _offset: number, data: ArrayBuffer) => uniformWrites.push(data.slice(0)) } }; return { device, buffers, uniformWrites, get computeCode() { return computeCode; }, get shaderCode() { return shaderCode; } }; }
