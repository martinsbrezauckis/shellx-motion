import { createContext, runInContext } from "node:vm";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { closeWebGpuPageSession, openWebGpuPageSession, renderWebGpuPageSessionFrame, uploadWebGpuPageSessionImages } from "./gpu-page-session";
import { installWebGpuPageSessionResources, readWebGpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import { createGpuPageFrameReservation, reserveWebGpuPageSessionEnvironmentEnvelope, reserveWebGpuPageSessionFrameResources } from "./gpu-page-frame-reservation";
import { installWebGpuPageSessionAdjustmentPipeline } from "./gpu-page-adjustment";
import { installWebGpuPageSessionGradientPipeline } from "./gpu-page-gradient";
import { installWebGpuPageSessionGlowPipeline } from "./gpu-page-glow";
import { installWebGpuPageSessionMaskPipeline } from "./gpu-page-mask";
import { installWebGpuPageSessionBlendPipeline } from "./gpu-page-blend";
import { installWebGpuPageSessionBlurPipeline } from "./gpu-page-blur";
import { installWebGpuPageSessionStyledRectanglePipeline } from "./gpu-page-styled-rectangle";
import { installWebGpuPageSessionScene3dPipeline } from "./gpu-page-scene3d";
import { installWebGpuPageSessionEnvironmentPipeline } from "./gpu-page-environment";
import { installWebGpuPageSessionMaterialPipeline } from "./gpu-page-material";
import { installWebGpuPageSessionChromaKeyPipeline } from "./gpu-page-chroma-key";
import { installWebGpuPageSessionChromaMatteCleanupPipeline } from "./gpu-page-chroma-matte-cleanup";
import { prepareWebGpuPageSessionTextSurfaces, uploadWebGpuPageSessionFonts } from "./gpu-page-text-session";
import type { InternalGpuFramePlan } from "./gpu-runtime-types";

describe("persistent WebGPU page session", () => {
  it("admits the exact 512 MiB arena but refuses a larger topology without replacing it", async () => {
    const createBuffer = vi.fn(() => ({ destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(4), mapAsync: async () => undefined, unmap: vi.fn() }));
    const destroyTexture = vi.fn();
    const createTexture = vi.fn(() => ({ createView: () => ({}), destroy: destroyTexture }));
    const context = createContext({
      Map,
      Set,
      Math,
      Object,
      Number,
      GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 },
      GPUTextureUsage: { RENDER_ATTACHMENT: 4, COPY_SRC: 8, COPY_DST: 16, TEXTURE_BINDING: 32 },
      __shellxMotionGpuSessionV1: { device: { createBuffer, createTexture } }
    });
    const install = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const metrics = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    expect(await install()).toEqual({ ok: true });
    for (const malformed of [
      "{ width: 1, height: 1, bytesPerRow: 4, root: { source: true, target: false, scratch: false }, groupDepth: 0, needsDepth: false }",
      "{ width: 1, height: 1, bytesPerRow: 4, root: { source: 1, target: 'false', scratch: null }, keyCleanup: 0, groupDepth: 0, needsDepth: 'false' }"
    ]) expect(() => runInContext(`globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena(${malformed});`, context)).toThrow("GPU frame arena configuration is outside fixed bounds.");
    expect(createBuffer).not.toHaveBeenCalled();
    expect(createTexture).not.toHaveBeenCalled();
    const exact = "{ width: 4096, height: 4096, bytesPerRow: 16384, root: { source: true, target: true, scratch: false }, keyCleanup: false, groupDepth: 1, needsDepth: false }";
    runInContext(`globalThis.exactArena = globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena(${exact});`, context);
    expect(await metrics()).toMatchObject({ frameArenaReconfigurations: 1, frameTextureSlots: 7, frameTextureBytes: 469_762_048, depthTextureBytes: 0, readbackBytes: 67_108_864, frameArenaBytes: 536_870_912 });
    const allocations = { buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length, destroyed: destroyTexture.mock.calls.length };
    const oversized = "{ width: 4096, height: 4096, bytesPerRow: 16384, root: { source: true, target: true, scratch: true }, keyCleanup: false, groupDepth: 1, needsDepth: false }";
    expect(() => runInContext(`globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena(${oversized});`, context)).toThrow("512 MiB");
    expect({ buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length, destroyed: destroyTexture.mock.calls.length }).toEqual(allocations);
    expect(runInContext(`globalThis.exactArena === globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena(${exact});`, context)).toBe(true);
    expect(await metrics()).toMatchObject({ frameArenaReconfigurations: 1, frameArenaBytes: 536_870_912 });
  });

  it("pins exact dynamic-pool growth accounting at the 128 MiB hard cap before allocation", async () => {
    const createBuffer = vi.fn(() => ({ destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(4), mapAsync: async () => undefined, unmap: vi.fn() }));
    const context = createContext({
      Map,
      Set,
      Math,
      Object,
      Number,
      GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 },
      GPUTextureUsage: { RENDER_ATTACHMENT: 4, COPY_SRC: 8, COPY_DST: 16, TEXTURE_BINDING: 32 },
      __shellxMotionGpuSessionV1: { device: { createBuffer, createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })) } }
    });
    const install = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const metrics = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    expect(await install()).toEqual({ ok: true });
    runInContext("globalThis.__shellxMotionGpuSessionV1.resources.beginFrame(); globalThis.__shellxMotionGpuSessionV1.resources.acquireBuffer('vertex', 134217724, 5);", context);
    runInContext("globalThis.__shellxMotionGpuSessionV1.resources.beginFrame(); globalThis.__shellxMotionGpuSessionV1.resources.acquireBuffer('vertex', 134217728, 5);", context);
    expect(await metrics()).toMatchObject({ dynamicBufferBytes: 134_217_728, dynamicBufferSlots: 1 });
    expect(() => runInContext("globalThis.__shellxMotionGpuSessionV1.resources.acquireBuffer('uniform', 4, 5);", context)).toThrow("128 MiB");
    expect(createBuffer).toHaveBeenCalledTimes(2);
  });

  it("admits exactly three reusable chroma matte-cleanup textures", async () => {
    const context = createContext({
      Map, Set, Math, Object, Number,
      GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2 },
      GPUTextureUsage: { RENDER_ATTACHMENT: 4, COPY_SRC: 8, COPY_DST: 16, TEXTURE_BINDING: 32 },
      __shellxMotionGpuSessionV1: { device: { createBuffer: vi.fn(() => ({ destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(256), mapAsync: async () => undefined, unmap: vi.fn() })), createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })) } }
    });
    const install = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const metrics = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    expect(await install()).toEqual({ ok: true });
    expect(runInContext("globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena({ width: 1, height: 1, bytesPerRow: 256, root: { source: true, target: true, scratch: false }, keyCleanup: true, groupDepth: 0, needsDepth: false }).keyCleanup !== null", context)).toBe(true);
    expect(await metrics()).toMatchObject({ frameTextureSlots: 6, frameTextureBytes: 24, readbackBytes: 256, frameArenaBytes: 280 });
  });

  it("freezes a reserved environment envelope before delivery and refuses larger later topology", async () => {
    const createBuffer = vi.fn(() => ({ destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(256), mapAsync: async () => undefined, unmap: vi.fn() }));
    const createTexture = vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() }));
    const context = createContext({
      Map, Set, Math, Object, Number,
      GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2, UNIFORM: 8 },
      GPUTextureUsage: { RENDER_ATTACHMENT: 4, COPY_SRC: 8, COPY_DST: 16, TEXTURE_BINDING: 32 },
      __shellxMotionGpuSessionV1: { device: { createBuffer, createTexture } }
    });
    const install = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const reserveEnvelope = runInContext(`(${reserveWebGpuPageSessionEnvironmentEnvelope.toString()})`, context) as typeof reserveWebGpuPageSessionEnvironmentEnvelope;
    const metrics = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    expect(await install()).toEqual({ ok: true });
    expect(await reserveEnvelope({ width: 4, height: 1, groupDepth: 1, keyCleanup: true, needsDepth: true })).toEqual({ ok: true });
    const allocations = { buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length };
    expect(() => runInContext("globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena({ width: 4, height: 1, bytesPerRow: 256, root: { source: true, target: true, scratch: true }, keyCleanup: true, groupDepth: 2, needsDepth: true });", context)).toThrow("environment arena envelope");
    expect(() => runInContext("globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena({ width: 5, height: 1, bytesPerRow: 256, root: { source: true, target: true, scratch: true }, keyCleanup: true, groupDepth: 1, needsDepth: true });", context)).toThrow("environment arena envelope");
    expect({ buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length }).toEqual(allocations);
    expect(await metrics()).toMatchObject({ environmentEnvelopeReservations: 1, environmentUniformCapacitySlots: 36, frameArenaLateAllocationRefusals: 2 });
  });

  it("renders a masked v2 field into root.source, composites it once, and reuses the fixed arena", async () => {
    let textureSerial = 0;
    const createBuffer = vi.fn(() => ({ destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(256), mapAsync: async () => undefined, unmap: vi.fn() }));
    const createTexture = vi.fn(() => { const name = `texture-${textureSerial++}`; return { name, createView: () => ({ name }), destroy: vi.fn() }; });
    const pipelineCalls: string[] = [], computeTargets: string[] = [];
    const device = {
      createBindGroup: vi.fn(() => ({})), createBuffer, createTexture,
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: () => ({ draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn(), setBindGroup: vi.fn(), setIndexBuffer: vi.fn(), setPipeline: (pipeline: { tag?: string }) => pipelineCalls.push(pipeline.tag ?? "unknown"), setVertexBuffer: vi.fn() }),
        copyTextureToBuffer: vi.fn(), finish: () => ({})
      })),
      pushErrorScope: vi.fn(), popErrorScope: async () => null,
      queue: { onSubmittedWorkDone: async () => undefined, submit: vi.fn(), writeBuffer: vi.fn() }
    };
    const state = {
      device, rectPipeline: {}, pointPipeline: {}, ellipsePipeline: {}, imagePipeline: {}, additiveRectPipeline: {}, additivePointPipeline: {}, additiveEllipsePipeline: {}, additiveImagePipeline: {}, imageSampler: {},
      blendPipeline: { tag: "blend", getBindGroupLayout: () => ({}) }, maskPipeline: { tag: "mask", getBindGroupLayout: () => ({}) }, images: new Map(), textSurfaces: new Map(),
      limits: { maxTextureDimension2D: 4_096, maxBufferSize: 32 * 1024 * 1024, maxStorageBufferBindingSize: 32 * 1024 * 1024 }, lost: false,
      computeParticlesV2: { render: (_draw: unknown, _width: number, _height: number, _encoder: unknown, target: { name: string }) => { computeTargets.push(target.name); }, snapshot: () => ({}) }
    };
    const context = createContext({ ArrayBuffer, Float32Array, Uint8Array, Uint32Array, Map, Set, Math, Number, Object, Promise, Error, btoa: (value: string) => Buffer.from(value, "latin1").toString("base64"), GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2, VERTEX: 4, UNIFORM: 8, INDEX: 16 }, GPUMapMode: { READ: 1 }, GPUTextureUsage: { COPY_SRC: 1, RENDER_ATTACHMENT: 2, COPY_DST: 4, TEXTURE_BINDING: 8 }, __shellxMotionGpuSessionV1: state });
    const installResources = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const reserve = runInContext(`(${reserveWebGpuPageSessionFrameResources.toString()})`, context) as typeof reserveWebGpuPageSessionFrameResources;
    const render = runInContext(`(${renderWebGpuPageSessionFrame.toString()})`, context) as typeof renderWebGpuPageSessionFrame;
    expect(await installResources()).toEqual({ ok: true });
    const plan = maskedV2Plan();
    expect(plan.budget).toMatchObject({ computeParticleFieldCount: 1, computeParticleBufferBytes: 12_800_000, maskCount: 1, maskUniformBytes: 48, compositeCount: 1, compositeUniformBytes: 64, compositeIntermediateTextureBytes: 38_400 });
    expect(await reserve(createGpuPageFrameReservation(plan))).toEqual({ ok: true });
    expect(await render(plan)).toMatchObject({ ok: true, bytesPerRow: 512 });
    expect(computeTargets).toEqual(["texture-1"]);
    expect(pipelineCalls).toEqual(["mask", "blend"]);
    const allocations = { buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length };
    expect(await reserve(createGpuPageFrameReservation(plan))).toEqual({ ok: true });
    expect(await render(plan)).toMatchObject({ ok: true, bytesPerRow: 512 });
    expect(computeTargets).toEqual(["texture-1", "texture-1"]);
    expect(pipelineCalls).toEqual(["mask", "blend", "mask", "blend"]);
    expect({ buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length }).toEqual(allocations);
  });

  it("accumulates every fixed environment shutter sample in one retained arena without sampling its attachment", async () => {
    let textureSerial = 0;
    const destroyed: string[] = [], textureDescriptors: Array<{ name: string; descriptor: unknown }> = [], passes: Array<{ target: string; loadOp: string; pipeline?: string; bindings: Array<{ binding: number; resource: unknown }> }> = [];
    const createTexture = vi.fn((descriptor: unknown) => {
      const name = `arena-${textureSerial++}`;
      textureDescriptors.push({ name, descriptor });
      return { name, createView: () => ({ name }), destroy: () => destroyed.push(name) };
    });
    const createBuffer = vi.fn(() => ({ destroy: vi.fn(), getMappedRange: () => new ArrayBuffer(256), mapAsync: async () => undefined, unmap: vi.fn() }));
    const device = {
      createBuffer, createTexture,
      createBindGroup: vi.fn((descriptor: { entries: Array<{ binding: number; resource: unknown }> }) => descriptor),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: { colorAttachments: Array<{ view: { name: string }; loadOp: string }> }) => {
          const record = { target: descriptor.colorAttachments[0]!.view.name, loadOp: descriptor.colorAttachments[0]!.loadOp, pipeline: undefined as string | undefined, bindings: [] as Array<{ binding: number; resource: unknown }> };
          passes.push(record);
          return { draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setPipeline: (pipeline: { tag?: string }) => { record.pipeline = pipeline.tag; }, setBindGroup: (_index: number, group: { entries: Array<{ binding: number; resource: unknown }> }) => { record.bindings = group.entries; } };
        },
        copyTextureToBuffer: vi.fn(), finish: () => ({})
      }),
      pushErrorScope: vi.fn(), popErrorScope: async () => null,
      queue: { onSubmittedWorkDone: async () => undefined, submit: vi.fn(), writeBuffer: vi.fn() }
    };
    const source = { name: "immutable-scene", createView: () => ({ name: "immutable-scene" }) };
    const effectMask = { name: "immutable-mask", createView: () => ({ name: "immutable-mask" }) };
    const state = {
      device, rectPipeline: {}, pointPipeline: {}, ellipsePipeline: {}, imagePipeline: {}, additiveRectPipeline: {}, additivePointPipeline: {}, additiveEllipsePipeline: {}, additiveImagePipeline: {}, imageSampler: {},
      environmentPipeline: { tag: "environment-replace", getBindGroupLayout: () => ({}) }, additiveEnvironmentPipeline: { tag: "environment-additive", getBindGroupLayout: () => ({}) }, blendPipeline: { tag: "blend", getBindGroupLayout: () => ({}) },
      images: new Map([["scene", { texture: source }], ["mask", { texture: effectMask }]]), textSurfaces: new Map(), limits: { maxTextureDimension2D: 4_096, maxBufferSize: 32 * 1024 * 1024, maxStorageBufferBindingSize: 32 * 1024 * 1024 }, lost: false
    };
    const context = createContext({ ArrayBuffer, Float32Array, Uint8Array, Uint32Array, Map, Set, Math, Number, Object, Promise, Error, btoa: (value: string) => Buffer.from(value, "latin1").toString("base64"), GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2, VERTEX: 4, UNIFORM: 8, INDEX: 16 }, GPUMapMode: { READ: 1 }, GPUTextureUsage: { COPY_SRC: 1, RENDER_ATTACHMENT: 2, COPY_DST: 4, TEXTURE_BINDING: 8 }, __shellxMotionGpuSessionV1: state });
    const installResources = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const reserve = runInContext(`(${reserveWebGpuPageSessionFrameResources.toString()})`, context) as typeof reserveWebGpuPageSessionFrameResources;
    const reserveEnvironmentEnvelope = runInContext(`(${reserveWebGpuPageSessionEnvironmentEnvelope.toString()})`, context) as typeof reserveWebGpuPageSessionEnvironmentEnvelope;
    const render = runInContext(`(${renderWebGpuPageSessionFrame.toString()})`, context) as typeof renderWebGpuPageSessionFrame;
    const metrics = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    const close = runInContext(`(${closeWebGpuPageSession.toString()})`, context) as typeof closeWebGpuPageSession;
    expect(await installResources()).toEqual({ ok: true });
    expect(createBuffer).not.toHaveBeenCalled();
    expect(await reserveEnvironmentEnvelope({ width: 4, height: 1, groupDepth: 1, keyCleanup: true, needsDepth: true })).toEqual({ ok: true });
    expect(createBuffer).toHaveBeenCalledWith({ size: 9_216, usage: 9 });
    const accumulatorTextures = textureDescriptors.filter((entry) => (entry.descriptor as { format?: unknown }).format === "rgba16float");
    expect(accumulatorTextures).toHaveLength(1);
    const accumulator = accumulatorTextures[0];
    expect(accumulator).toEqual({ name: "arena-4", descriptor: { size: { width: 4, height: 1, depthOrArrayLayers: 1 }, format: "rgba16float", usage: 10 } });
    const plainPlan = plainPlanBeforeEnvironment();
    expect(await reserve(createGpuPageFrameReservation(plainPlan))).toEqual({ ok: true });
    expect(await render(plainPlan)).toMatchObject({ ok: true, bytesPerRow: 256 });
    const environmentReservationAllocations = { buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length };
    // A later nested environment, chroma cleanup, or scene3d frame is already
    // covered by the static envelope and cannot attach another surface.
    runInContext("globalThis.__shellxMotionGpuSessionV1.resources.ensureFrameArena({ width: 4, height: 1, bytesPerRow: 256, root: { source: true, target: true, scratch: true }, keyCleanup: true, groupDepth: 1, needsDepth: true });", context);
    expect({ buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length }).toEqual(environmentReservationAllocations);
    const staticPlan = staticEnvironmentPlan();
    expect(await reserve(createGpuPageFrameReservation(staticPlan))).toEqual({ ok: true });
    expect(await render(staticPlan)).toMatchObject({ ok: true, bytesPerRow: 256 });
    expect({ buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length }).toEqual(environmentReservationAllocations);
    const staticAllocations = { buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length };
    const plan = temporalEnvironmentPlan(2);
    expect(await reserve(createGpuPageFrameReservation(plan))).toEqual({ ok: true });
    expect(await render(plan)).toMatchObject({ ok: true, bytesPerRow: 256 });
    const firstFramePasses = passes.filter((pass) => pass.pipeline === "environment-additive");
    expect(firstFramePasses).toHaveLength(2);
    expect(firstFramePasses.map((pass) => [pass.target, pass.loadOp])).toEqual([[accumulator!.name, "load"], [accumulator!.name, "load"]]);
    for (const pass of firstFramePasses) {
      expect(pass.bindings.find((entry) => entry.binding === 1)?.resource).toEqual({ name: "immutable-scene" });
      expect(pass.bindings.find((entry) => entry.binding === 2)?.resource).toEqual({ name: "immutable-mask" });
      expect(pass.target).not.toBe("immutable-scene");
      expect(pass.target).not.toBe("immutable-mask");
    }
    const temporalBlends = passes.filter((pass) => pass.pipeline === "blend").slice(1);
    expect(temporalBlends).toHaveLength(1);
    expect(temporalBlends[0]?.bindings.find((entry) => entry.binding === 1)?.resource).toEqual({ name: accumulator!.name });
    expect(device.queue.writeBuffer.mock.calls.filter(([, _offset, value]) => value instanceof Float32Array && value.length === 52).map(([, offset]) => offset)).toEqual([0, 0, 256]);
    expect(firstFramePasses.map((pass) => pass.bindings.find((entry) => entry.binding === 3)?.resource)).toEqual([
      expect.objectContaining({ offset: 0, size: 208 }),
      expect.objectContaining({ offset: 256, size: 208 })
    ]);
    expect(temporalBlends[0]?.bindings.find((entry) => entry.binding === 2)?.resource).toEqual(expect.objectContaining({ offset: 8_192, size: 64 }));
    const noSource = temporalEnvironmentPlan(2);
    noSource.draws = noSource.draws.map((draw) => draw.kind === "environment" ? (({ sceneResourceId: _scene, effectMaskResourceId: _mask, ...sample }) => sample)(draw) : draw) as typeof noSource.draws;
    expect(await reserve(createGpuPageFrameReservation(noSource))).toEqual({ ok: true });
    expect(await render(noSource)).toMatchObject({ ok: true, bytesPerRow: 256 });
    const noSourcePasses = passes.filter((pass) => pass.pipeline === "environment-additive").slice(-2);
    expect(noSourcePasses).toHaveLength(2);
    for (const pass of noSourcePasses) {
      expect(pass.target).toBe(accumulator!.name);
      expect(pass.bindings.find((entry) => entry.binding === 1)?.resource).toEqual({ name: "arena-0" });
      expect(pass.bindings.find((entry) => entry.binding === 1)?.resource).not.toEqual({ name: accumulator!.name });
    }
    const firstMetrics = await metrics();
    expect(firstMetrics).toMatchObject({ frameTextureSlots: 13, frameTextureBytes: 224, frameTextureHighWaterSlots: 13, frameTextureHighWaterBytes: 224, frameArenaBytes: 480, frameArenaHighWaterBytes: 480 });
    for (const samples of [2, 4, 8]) {
      const replay = temporalEnvironmentPlan(samples);
      expect(await reserve(createGpuPageFrameReservation(replay))).toEqual({ ok: true });
      expect(await render(replay)).toMatchObject({ ok: true, bytesPerRow: 256 });
    }
    expect({ buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length }).toEqual(staticAllocations);
    expect(await metrics()).toMatchObject({ framesRendered: 7, frameTextureSlots: firstMetrics?.frameTextureSlots, frameTextureHighWaterSlots: firstMetrics?.frameTextureHighWaterSlots, dynamicBufferSlots: firstMetrics?.dynamicBufferSlots, dynamicBufferHighWaterSlots: firstMetrics?.dynamicBufferHighWaterSlots, environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216, environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: 19, environmentEnvelopeReservations: 1 });
    await close();
    expect(await metrics()).toBeNull();
    expect(destroyed).toContain(accumulator!.name);
  });

  it("reuses one adapter, device and fixed pipeline set across multiple frames", async () => {
    const destroyDevice = vi.fn();
    const destroyBuffer = vi.fn();
    const destroyTexture = vi.fn();
    const createRenderPipeline = vi.fn((_descriptor:unknown) => { const layout = {}; return { getBindGroupLayout: () => layout }; });
    const writeBuffer = vi.fn();
    const createBindGroup = vi.fn((_descriptor: unknown) => ({}));
    const pushErrorScope = vi.fn();
    const popErrorScope = vi.fn<() => Promise<{ message: string } | null>>(async () => null);
    const drawIndexed = vi.fn(); const setIndexBuffer = vi.fn();
    const requestDevice = vi.fn(async () => ({
      createBindGroup,
      createBuffer: vi.fn(() => ({ destroy: destroyBuffer, getMappedRange: () => new ArrayBuffer(256), mapAsync: async () => undefined, unmap: vi.fn() })),
      createCommandEncoder: vi.fn(() => ({ beginRenderPass: () => ({ draw: vi.fn(), drawIndexed, end: vi.fn(), setBindGroup: vi.fn(), setIndexBuffer, setPipeline: vi.fn(), setVertexBuffer: vi.fn() }), copyTextureToBuffer: vi.fn(), finish: () => ({}) })),
      createRenderPipeline,
      createSampler: vi.fn(() => ({})),
      createShaderModule: vi.fn(() => ({})),
      createTexture: vi.fn(() => ({ createView: () => ({}), destroy: destroyTexture })),
      destroy: destroyDevice,
      pushErrorScope,
      popErrorScope,
      limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 },
      lost: new Promise<never>(() => undefined),
      queue: { copyExternalImageToTexture: vi.fn(), onSubmittedWorkDone: async () => undefined, submit: vi.fn(), writeBuffer, writeTexture: vi.fn() }
    }));
    const requestAdapter = vi.fn(async () => ({
      info: { vendor: "nvidia", device: "", architecture: "blackwell", description: "" },
      requestDevice
    }));
    const digest = async (_algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> => Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
    const context = createContext({
      Float32Array,
      Array,
      ArrayBuffer,
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      Promise,
      Uint8Array,
      Uint32Array,
      GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2, VERTEX: 4, UNIFORM: 8, INDEX:16 },
      GPUMapMode: { READ: 1 },
      GPUTextureUsage: { COPY_SRC: 1, RENDER_ATTACHMENT: 2, COPY_DST: 4, TEXTURE_BINDING: 8 },
      btoa: (value: string) => Buffer.from(value, "latin1").toString("base64"),
      crypto: { subtle: { digest } },
      isSecureContext: true,
      navigator: { gpu: { requestAdapter } },
      FontFace: class { async load() { return this; } },
      document: { fonts: { add: vi.fn(), check: () => true }, createElement: () => ({ width: 0, height: 0, getContext: () => ({ direction: "ltr", fillStyle: "", font: "", fontKerning: "", letterSpacing: "", textAlign: "", textBaseline: "", fillText: vi.fn(), measureText: () => ({ width: 1 }) }) }) }
    });
    const open = runInContext(`(${openWebGpuPageSession.toString()})`, context) as typeof openWebGpuPageSession;
    const installResources = runInContext(`(${installWebGpuPageSessionResources.toString()})`, context) as typeof installWebGpuPageSessionResources;
    const reserve = runInContext(`(${reserveWebGpuPageSessionFrameResources.toString()})`, context) as typeof reserveWebGpuPageSessionFrameResources;
    const resourceMetrics = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    const render = runInContext(`(${renderWebGpuPageSessionFrame.toString()})`, context) as typeof renderWebGpuPageSessionFrame;
    const renderReserved = async (input: InternalGpuFramePlan) => { expect(await reserve(createGpuPageFrameReservation(input))).toEqual({ ok: true }); return await render(input); };
    const upload = runInContext(`(${uploadWebGpuPageSessionImages.toString()})`, context) as typeof uploadWebGpuPageSessionImages;
    const uploadFonts = runInContext(`(${uploadWebGpuPageSessionFonts.toString()})`, context) as typeof uploadWebGpuPageSessionFonts;
    const prepareText = runInContext(`(${prepareWebGpuPageSessionTextSurfaces.toString()})`, context) as typeof prepareWebGpuPageSessionTextSurfaces;
    const installGradient = runInContext(`(${installWebGpuPageSessionGradientPipeline.toString()})`, context) as typeof installWebGpuPageSessionGradientPipeline;
    const installStyledRectangle = runInContext(`(${installWebGpuPageSessionStyledRectanglePipeline.toString()})`, context) as typeof installWebGpuPageSessionStyledRectanglePipeline;
    const installBlend = runInContext(`(${installWebGpuPageSessionBlendPipeline.toString()})`, context) as typeof installWebGpuPageSessionBlendPipeline;
    const installBlur = runInContext(`(${installWebGpuPageSessionBlurPipeline.toString()})`, context) as typeof installWebGpuPageSessionBlurPipeline;
    const installGlow = runInContext(`(${installWebGpuPageSessionGlowPipeline.toString()})`, context) as typeof installWebGpuPageSessionGlowPipeline;
    const installMask = runInContext(`(${installWebGpuPageSessionMaskPipeline.toString()})`, context) as typeof installWebGpuPageSessionMaskPipeline;
    const installAdjustment = runInContext(`(${installWebGpuPageSessionAdjustmentPipeline.toString()})`, context) as typeof installWebGpuPageSessionAdjustmentPipeline;
    const installScene3d = runInContext(`(${installWebGpuPageSessionScene3dPipeline.toString()})`, context) as typeof installWebGpuPageSessionScene3dPipeline;
    const installEnvironment = runInContext(`(${installWebGpuPageSessionEnvironmentPipeline.toString()})`, context) as typeof installWebGpuPageSessionEnvironmentPipeline;
    const installMaterial = runInContext(`(${installWebGpuPageSessionMaterialPipeline.toString()})`, context) as typeof installWebGpuPageSessionMaterialPipeline;
    const installChromaKey = runInContext(`(${installWebGpuPageSessionChromaKeyPipeline.toString()})`, context) as typeof installWebGpuPageSessionChromaKeyPipeline;
    const installChromaMatteCleanup = runInContext(`(${installWebGpuPageSessionChromaMatteCleanupPipeline.toString()})`, context) as typeof installWebGpuPageSessionChromaMatteCleanupPipeline;
    const close = runInContext(`(${closeWebGpuPageSession.toString()})`, context) as typeof closeWebGpuPageSession;
    const opened = await open({ powerPreference: "high-performance" });
    expect(opened).toMatchObject({ ok: true, runtime: { adapterInfo: { vendor: "nvidia", architecture: "blackwell" }, device: true } });
    expect(await installResources()).toEqual({ ok: true });
    expect(await installGradient()).toEqual({ ok: true });
    expect(await installStyledRectangle()).toEqual({ ok: true });
    expect(await installBlend()).toEqual({ ok: true });
    expect(await installBlur()).toEqual({ ok: true });
    expect(await installGlow()).toEqual({ ok: true });
    expect(await installMask()).toEqual({ ok: true });
    expect(await installAdjustment()).toEqual({ ok: true });
    expect(await installScene3d()).toEqual({ ok: true });
    expect(await installEnvironment()).toEqual({ ok: true });
    expect(await installMaterial()).toEqual({ ok: true });
    expect(await installChromaKey()).toEqual({ ok: true });
    expect(await installChromaMatteCleanup()).toEqual({ ok: true });
    const imageBytes = Buffer.from([255, 0, 0, 255]);
    const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
    expect(await upload([{ id: "image-a", width: 1, height: 1, rgbaBase64: imageBytes.toString("base64"), sourceSha256: imageSha256, decodedSha256: imageSha256 }])).toEqual({ ok: true, uploaded: 1, decoded: [{ id: "image-a", sourceSha256: imageSha256, decodedSha256: imageSha256, width: 1, height: 1 }] });
    expect(await uploadFonts([{ resourceId: "font-a", family: "Brand", weight: 400, style: "normal", bytesBase64: Buffer.from("font").toString("base64") }])).toEqual({ ok: true, count: 1, textFit: [] });

    const plan: InternalGpuFramePlan = {
      schema: "shellx-motion/gpu-frame-intent@1", width: 1, height: 1,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      draws: [
        { kind: "ellipse", id: "orb", blendMode: "normal", effects: null, mask: { shape: "ellipse", x: 0, y: 0, width: 1, height: 1, radius: 0, rotationDeg: 45, pivotX: 0.5, pivotY: 0.5, inverted: false, opacity: 0.8, featherPx: 0.1 }, x: 0, y: 0, width: 1, height: 1, rotationDeg: 45, pivotX: 0.5, pivotY: 0.5, color: { r: 0, g: 1, b: 1, a: 1 }, strokeWidth: 0.1, stroke: { r: 1, g: 1, b: 1, a: 0.5 } },
        { kind: "groupStart", id: "title-card", drawCount: 3, x: 0.1, y: 0.2, scale: 1.5, rotationDeg: 10, pivotX: 0.5, pivotY: 0.5, opacity: 0.8, blendMode: "normal", effects: null },
        { kind: "image", id: "photo", blendMode: "normal", effects: null, resourceId: "image-a", x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, u0: 0, v0: 0, u1: 1, v1: 1, opacity: 1, chromaKey: { keyColor: { r: 0, g: 1, b: 0, a: 1 }, similarity: 0.12, smoothness: 0.18, shadow: 0.5, spillSuppression: 0.9, spillBalance: -0.25, edgeColorCorrection: 0.5, matte: { denoiseRadiusPx: 1, growShrinkPx: -1, chokePx: 1, featherPx: 2, blackClip: 0.04, whiteClip: 0.96 } } },
        { kind: "text", id: "title", blendMode: "normal", effects: null, surfaceId: "text-a", fontResourceIds: ["font-a"], fontFamily: "Brand", text: "A", x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 }, fontSize: 1, fontWeight: 400, fontStyle: "normal", letterSpacing: 0, lineHeight: 1, textAlign: "left", verticalAlign: "top", direction: "ltr", textShadow: null, textFit: null },
        { kind: "coloredTriangles", id: "path", blendMode: "normal", effects: null, vertices: [{ x: 0, y: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } }, { x: 1, y: 0, color: { r: 0, g: 1, b: 0, a: 0.5 } }, { x: 0, y: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }], rotationDeg: 0, pivotX: 0.5, pivotY: 0.5 },
        { kind: "groupEnd", id: "title-card.end", groupId: "title-card" },
        { kind: "gradientRect", id: "gradient", blendMode: "normal", effects: null, x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, gradientType: "linear", angleDeg: 90, centerX: 0.5, centerY: 0.5, stops: [{ offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] },
        { kind: "styledRect", id: "panel", blendMode: "screen", effects: { blur: 4, brightness: 1.2, contrast: 1.1, saturate: 0.75, grayscale: 0.25, glow: { radius: 3, color: { r: 0.2, g: 0.4, b: 0.8, a: 0.75 } } }, x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, radius: 0.25, fill: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 0.1, stroke: { r: 1, g: 1, b: 1, a: 1 }, shadow: { offsetX: 0.1, offsetY: 0.1, blur: 0.2, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.5 } } },
        { kind: "motionBlurStart", id: "sweep.motion-blur", blendMode: "normal", effects: null, sampleCount: 2, drawCount: 2, shutterAngle: 180, shutterDurationMs: 16.667 },
        { kind: "text", id: "sweep.sample-0.0", blendMode: "normal", effects: null, surfaceId: "text-sample-a", fontResourceIds: ["font-a"], fontFamily: "Brand", text: "A", x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, opacity: 0.5, color: { r: 1, g: 0, b: 0, a: 1 }, fontSize: 1, fontWeight: 400, fontStyle: "normal", letterSpacing: 0, lineHeight: 1, textAlign: "left", verticalAlign: "top", direction: "ltr", textShadow: null, textFit: null },
        { kind: "text", id: "sweep.sample-1.0", blendMode: "normal", effects: null, surfaceId: "text-sample-b", fontResourceIds: ["font-a"], fontFamily: "Brand", text: "B", x: 0.5, y: 0, width: 0.5, height: 1, rotationDeg: 0, pivotX: 0.75, pivotY: 0.5, opacity: 0.5, color: { r: 0, g: 0, b: 1, a: 1 }, fontSize: 1, fontWeight: 400, fontStyle: "normal", letterSpacing: 0, lineHeight: 1, textAlign: "left", verticalAlign: "top", direction: "ltr", textShadow: null, textFit: null },
        { kind: "motionBlurEnd", id: "sweep.motion-blur.end", groupId: "sweep.motion-blur" },
        { kind:"scene3d",id:"world",blendMode:"normal",effects:null,background:{r:0.01,g:0.02,b:0.03,a:1},opacity:1,viewProjection:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],lightDirection:[0,-1,-1],lightColor:{r:1,g:1,b:1,a:1},ambient:0.2,intensity:1,objects:[{id:"mesh",vertices:[0,0,0,0,0,1,1,0,0,0,0,1,0,1,0,0,0,1],indices:[0,1,2],model:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],color:{r:1,g:0,b:0,a:1},emissive:0.1}]},
        { kind:"environment",id:"storm",blendMode:"normal",effects:null,environmentKind:"rain",mode:"scene",seed:17,timeSeconds:1.5,x:0,y:0,width:1,height:1,rotationDeg:0,pivotX:.5,pivotY:.5,opacity:.8,sceneResourceId:"image-a",effectMaskResourceId:"image-a",colors:[{r:0,g:0,b:0,a:1},{r:.7,g:.9,b:1,a:1},{r:.2,g:.4,b:.7,a:1},{r:1,g:1,b:1,a:1},{r:0,g:0,b:0,a:0}],parameters:[.8,.2,1.4,1,4,.45,.9,.2,.7,.6,.8,.4,.3,0,0,0]},
        { kind:"environment",id:"water",blendMode:"normal",effects:null,environmentKind:"water",mode:"overlay",seed:18,timeSeconds:1.5,x:0,y:0,width:1,height:1,rotationDeg:0,pivotX:.5,pivotY:.5,opacity:.7,colors:[{r:0,g:.1,b:.2,a:1},{r:0,g:.4,b:.7,a:1},{r:0,g:.1,b:.3,a:1},{r:1,g:1,b:1,a:1},{r:.8,g:.9,b:1,a:1}],parameters:[.5,4,.2,1,0,.5,3,.7,.4,.6,.3,.8,.2,0,0,0]},
        { kind:"environment",id:"snow",blendMode:"normal",effects:null,environmentKind:"snow",mode:"overlay",seed:19,timeSeconds:1.5,x:0,y:0,width:1,height:1,rotationDeg:0,pivotX:.5,pivotY:.5,opacity:.6,colors:[{r:.1,g:.1,b:.2,a:1},{r:1,g:1,b:1,a:1},{r:.4,g:.5,b:.7,a:1},{r:.8,g:.9,b:1,a:1},{r:0,g:0,b:0,a:0}],parameters:[.5,1,.2,.3,2,3,.4,.5,.6,.2,.3,.4,.5,0,0,0]},
        { kind:"environment",id:"fog",blendMode:"normal",effects:null,environmentKind:"fog",mode:"overlay",seed:20,timeSeconds:1.5,x:0,y:0,width:1,height:1,rotationDeg:0,pivotX:.5,pivotY:.5,opacity:.5,colors:[{r:.1,g:.1,b:.2,a:1},{r:.8,g:.8,b:.9,a:1},{r:1,g:1,b:1,a:1},{r:0,g:0,b:0,a:0},{r:0,g:0,b:0,a:0}],parameters:[.2,.5,2,.3,.4,3,.5,0,0,0,0,0,0,0,0,0]},
        { kind:"material",id:"neon",blendMode:"screen",effects:{blur:2,brightness:1,contrast:1,saturate:1,grayscale:0,glow:null},mask:{shape:"triangle",x:0,y:0,width:1,height:1,radius:0,rotationDeg:0,pivotX:.5,pivotY:.5,inverted:false,opacity:1,featherPx:0},preset:"energy",seed:29,timeSeconds:2.5,x:0,y:0,width:1,height:1,rotationDeg:0,pivotX:.5,pivotY:.5,opacity:.7,colors:[{r:1,g:0,b:.2,a:1},{r:0,g:.8,b:1,a:1},{r:1,g:1,b:1,a:1}],parameters:[1.5,4,1,3,.5,.7,.2,.1]},
        { kind: "adjustment", id: "finish", vignette: { amount: 0.8, softness: 0.6, color: { r: 0.1, g: 0.2, b: 0.3, a: 0.75 } }, filmGrain: { amount: 0.2, size: 3, frameSeed: 0xfedcba98 } }
      ],
      fingerprint: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      budget: { rectangleCount: 5, pointCount: 0, computeParticleFieldCount: 0, computeParticleCount: 0, triangleVertexCount: 3, imageCount: 1, chromaKeyCount: 1, chromaMatteCleanupCount: 1, chromaMatteCleanupPassCount: 9, textCount: 1, textUtf8Bytes: 1, textSurfacePixels: 1, scene3dCount:1,scene3dObjectCount:1,scene3dVertexCount:3,scene3dIndexCount:3,environmentCount:4,materialCount:1, gradientStopCount: 2, pointBufferBytes: 0, computeParticleBufferBytes: 0, triangleBufferBytes: 72, imageVertexBufferBytes: 120, chromaKeyUniformBytes: 48, chromaMatteCleanupUniformBytes: 288, textVertexBufferBytes: 120, scene3dVertexBufferBytes:72,scene3dIndexBufferBytes:12,scene3dUniformBytes:192,environmentUniformBytes:832,materialUniformBytes:144, gradientUniformBytes: 336, styledRectangleUniformBytes: 80, blendModeCount: 2, colorEffectCount: 1, blurEffectCount: 2, glowEffectCount: 1, maskCount: 2, blurPassCount: 6, adjustmentCount: 1, motionBlurGroupCount: 1, motionBlurSampleCount: 2, groupCount: 1, groupMaxDepth: 1, compositeCount: 10, compositeUniformBytes: 640, blurUniformBytes: 96, glowUniformBytes: 32, maskUniformBytes: 96, adjustmentUniformBytes: 48, chromaMatteCleanupIntermediateTextureBytes: 12, compositeIntermediateTextureBytes: 44, estimatedPlanBytes: 3381 }
    };
    expect(await prepareText(plan)).toEqual({ ok: true, count: 3, textFit: [] });
    expect(await renderReserved(plan)).toMatchObject({ ok: true, bytesPerRow: 256, paddedBase64: Buffer.alloc(256).toString("base64") });
    const additiveImageLayout = createRenderPipeline.mock.results[7]!.value.getBindGroupLayout(0);
    expect(createBindGroup.mock.calls.some(([descriptor]) => (descriptor as { layout?: unknown }).layout === additiveImageLayout)).toBe(true);
    const device = await requestDevice.mock.results[0]?.value;
    const createBuffer = device.createBuffer as ReturnType<typeof vi.fn>;
    const createTexture = device.createTexture as ReturnType<typeof vi.fn>;
    const resourceMetricsAfterFirst = await resourceMetrics();
    expect(resourceMetricsAfterFirst).toMatchObject({
      framesRendered: 1,
      immutableImageTextures: 1,
      frameTextureSlots: expect.any(Number),
      dynamicBufferSlots: expect.any(Number),
      dynamicBufferHighWaterSlots: expect.any(Number)
    });
    const stableAllocations = { buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length };
    for (let frame = 0; frame < 12; frame += 1) expect(await renderReserved(plan)).toMatchObject({ ok: true, bytesPerRow: 256 });
    expect({ buffers: createBuffer.mock.calls.length, textures: createTexture.mock.calls.length }).toEqual(stableAllocations);
    const adjustmentSeeds = writeBuffer.mock.calls
      .map(([, , value]) => value as Float32Array)
      .filter((value) => value instanceof Float32Array && value.length === 12 && new Uint32Array(value.buffer)[10] === 0xfedcba98)
      .map((value) => new Uint32Array(value.buffer)[10]);
    expect(adjustmentSeeds).toEqual(Array.from({ length: 13 }, () => 0xfedcba98));
    expect(await resourceMetrics()).toMatchObject({
      framesRendered: 13,
      immutableImageTextures: 1,
      frameTextureSlots: resourceMetricsAfterFirst?.frameTextureSlots,
      dynamicBufferSlots: resourceMetricsAfterFirst?.dynamicBufferSlots,
      dynamicBufferHighWaterSlots: resourceMetricsAfterFirst?.dynamicBufferHighWaterSlots
    });
    expect(requestAdapter).toHaveBeenCalledTimes(1);
    expect(requestDevice).toHaveBeenCalledTimes(1);
    expect(createRenderPipeline).toHaveBeenCalledTimes(26);
    expect(createRenderPipeline.mock.calls.some(([descriptor]) => (descriptor as {depthStencil?:{format?:string}}).depthStencil?.format === "depth24plus")).toBe(true);
    expect(drawIndexed).toHaveBeenCalledWith(3); expect(setIndexBuffer).toHaveBeenCalledWith(expect.anything(), "uint32");
    expect(writeBuffer.mock.calls.some(([, , value]) => value instanceof Float32Array && value.length === 4 && value[0] === 1 && value[1] === 0 && value[2] === 4)).toBe(true);
    expect(writeBuffer.mock.calls.some(([, , value]) => value instanceof Float32Array && value.length === 4 && value[0] === 0 && value[1] === 1 && value[2] === 4)).toBe(true);
    expect(writeBuffer.mock.calls.some(([, , value]) => value instanceof Float32Array && Array.from(value).join(",") === "-1,1,0.5,0,0,0.5,1,1,0,0.5,0,0.5,-1,-1,0,0,0.5,0.5")).toBe(true);
    const glowUniform = writeBuffer.mock.calls.map(([, , value]) => value as Float32Array).find((value) => value instanceof Float32Array && value.length === 8 && value[0] > 0.19 && value[0] < 0.21);
    expect(glowUniform).toBeDefined(); expect(glowUniform?.[1]).toBeCloseTo(0.4); expect(glowUniform?.[2]).toBeCloseTo(0.8); expect(glowUniform?.[3]).toBeCloseTo(0.75); expect(glowUniform?.[4]).toBeCloseTo(1.2); expect(glowUniform?.[5]).toBeCloseTo(1.1); expect(glowUniform?.[6]).toBeCloseTo(0.75); expect(glowUniform?.[7]).toBeCloseTo(0.25);
    const compositeUniform = writeBuffer.mock.calls.map(([, , value]) => value as Float32Array).find((value) => value instanceof Float32Array && value.length === 16 && value[0] === 2);
    expect(compositeUniform).toBeDefined(); expect(compositeUniform?.[4]).toBe(1); expect(compositeUniform?.[5]).toBe(1); expect(compositeUniform?.[6]).toBe(1); expect(compositeUniform?.[7]).toBe(0);
    const groupUniform=writeBuffer.mock.calls.map(([, , value])=>value as Float32Array).find((value)=>value instanceof Float32Array&&value.length===16&&value[15]===1);
    expect(groupUniform).toBeDefined();expect(groupUniform?.[8]).toBeCloseTo(0.1);expect(groupUniform?.[9]).toBeCloseTo(0.2);expect(groupUniform?.[10]).toBeCloseTo(1.5);expect(groupUniform?.[14]).toBeCloseTo(0.8);
    const adjustmentUniform = writeBuffer.mock.calls.map(([, , value]) => value as Float32Array).find((value) => value instanceof Float32Array && value.length === 12 && new Uint32Array(value.buffer)[10] === 0xfedcba98);
    expect(adjustmentUniform).toBeDefined(); if (!adjustmentUniform) throw new Error("adjustment uniform missing"); expect(adjustmentUniform[0]).toBeCloseTo(0.1); expect(adjustmentUniform[4]).toBeCloseTo(0.8); expect(adjustmentUniform[8]).toBeCloseTo(0.2); expect(new Uint32Array(adjustmentUniform.buffer)[10]).toBe(0xfedcba98);
    const maskUniform = writeBuffer.mock.calls.map(([, , value]) => value as Float32Array).find((value) => value instanceof Float32Array && value.length === 12 && value[8] === 1);
    expect(maskUniform).toBeDefined(); expect(maskUniform?.[4]).toBeCloseTo(Math.PI / 4); expect(maskUniform?.[10]).toBeCloseTo(0.8); expect(maskUniform?.[11]).toBeCloseTo(0.1);
    expect(writeBuffer.mock.calls.some(([, , value]) => value instanceof Float32Array && value.length === 12 && value[8] === 2 && value[7] === 0)).toBe(true);
    const environmentUniforms = writeBuffer.mock.calls.map(([, , value]) => value as Float32Array).filter((value) => value instanceof Float32Array && value.length === 52);
    expect(environmentUniforms).toHaveLength(52);
    expect(environmentUniforms.map((value) => value[12])).toEqual(Array.from({ length: 13 }, () => [0, 1, 2, 3]).flat());
    expect(environmentUniforms.slice(0, 4).map((value) => value[13])).toEqual([0, 1, 1, 1]);
    expect(environmentUniforms[0]?.[2]).toBeCloseTo(1.5); expect(environmentUniforms[0]?.[14]).toBe(1); expect(environmentUniforms[0]?.[36]).toBeCloseTo(0.8);
    const materialUniform = writeBuffer.mock.calls.map(([, , value]) => value as Float32Array).find((value) => value instanceof Float32Array && value.length === 36 && value[12] === 2);
    expect(materialUniform).toBeDefined(); expect(materialUniform?.[2]).toBeCloseTo(2.5); expect(materialUniform?.[12]).toBe(2); expect(materialUniform?.[15]).toBe(0); expect(materialUniform?.[28]).toBeCloseTo(1.5); expect(materialUniform?.[35]).toBeCloseTo(0.1);
    const chromaUniform = writeBuffer.mock.calls.map(([, , value]) => value as Float32Array).find((value) => value instanceof Float32Array && value.length === 12 && value[1] === 1 && Math.abs(value[4] - 0.12) < 0.000001 && value[8] === -0.25);
    expect(chromaUniform).toBeDefined(); expect(chromaUniform?.[5]).toBeCloseTo(0.18); expect(chromaUniform?.[6]).toBeCloseTo(0.5); expect(chromaUniform?.[7]).toBeCloseTo(0.9); expect(chromaUniform?.[9]).toBeCloseTo(0.5);
    expect(createBindGroup.mock.calls.some(([entry]) => (entry as { entries?: Array<{ binding?: number }> }).entries?.map(({ binding }) => binding).join(",") === "1,2,3")).toBe(true);
    expect(writeBuffer.mock.calls.some(([, , value]) => value instanceof Float32Array && Array.from(value).slice(0, 5).join(",") === "6,0,0,0.03999999910593033,0.9599999785423279")).toBe(true);
    // One text-preparation scope plus one scope for each of the 13 frames.
    expect(pushErrorScope).toHaveBeenCalledTimes(14);
    expect(popErrorScope).toHaveBeenCalledTimes(14);
    popErrorScope.mockResolvedValueOnce({ message: "fixed compute validation" });
    await expect(renderReserved(plan)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringContaining("fixed compute validation") } });
    await close();
    expect(destroyBuffer).toHaveBeenCalledTimes(createBuffer.mock.calls.length);
    expect(destroyTexture).toHaveBeenCalledTimes(createTexture.mock.calls.length);
    expect(destroyDevice).toHaveBeenCalledTimes(1);
    expect(await render(plan)).toMatchObject({ ok: false, failure: { code: "gpu_device_unavailable" } });
  });
});

function maskedV2Plan(): InternalGpuFramePlan {
  return {
    schema: "shellx-motion/gpu-frame-intent@1", width: 80, height: 40, clear: { r: 0, g: 0, b: 0, a: 1 }, fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    draws: [{ kind: "particleCompute", id: "field-v2", blendMode: "normal", effects: null, mask: { shape: "rect", x: 4, y: 2, width: 72, height: 36, radius: 6, rotationDeg: 0, pivotX: 40, pivotY: 20, inverted: false, opacity: 1, featherPx: 0 }, schema: "shellx-motion/gpu-compute-particle-field@2", seed: 7, count: 100_000, atMs: 0, startMs: 0, lifetimeMs: 1_000, width: 80, height: 40, x: 0, y: 0, scale: 1, originX: 40, originY: 20, rotationDeg: 0, opacity: 1, color: { r: 1, g: 0, b: 0, a: 1 }, secondaryColor: { r: 0, g: 0, b: 1, a: 1 }, minSize: 1, maxSize: 2, minSpeed: 0, maxSpeed: 1, direction: 0, spread: 0, gravity: 0, fadeOut: false, sources: [{ kind: "flow", angleDeg: 0, strength: 0.2 }], origins: [{ x: 0.5, y: 0.5, weight: 1, directionOffsetDeg: 0, speedScale: 1 }], trail: null, shading: { mode: "flat", sizeJitter: 0, opacityJitter: 0, glow: 0 }, computeDispatchCount: 1, rasterPassCount: 1, instanceBytes: 64, retainedBufferCount: 2, retainedInstanceBytes: 12_800_000 }],
    budget: { rectangleCount: 0, pointCount: 0, computeParticleFieldCount: 1, computeParticleCount: 100_000, triangleVertexCount: 0, imageCount: 0, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 0, textUtf8Bytes: 0, textSurfacePixels: 0, scene3dCount: 0, scene3dObjectCount: 0, scene3dVertexCount: 0, scene3dIndexCount: 0, environmentCount: 0, materialCount: 0, gradientStopCount: 0, pointBufferBytes: 0, computeParticleBufferBytes: 12_800_000, computeParticleComputeDispatchCount: 1, computeParticleRasterPassCount: 1, triangleBufferBytes: 0, imageVertexBufferBytes: 0, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0, textVertexBufferBytes: 0, scene3dVertexBufferBytes: 0, scene3dIndexBufferBytes: 0, scene3dUniformBytes: 0, environmentUniformBytes: 0, materialUniformBytes: 0, gradientUniformBytes: 0, styledRectangleUniformBytes: 0, blendModeCount: 0, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, maskCount: 1, blurPassCount: 0, adjustmentCount: 0, motionBlurGroupCount: 0, motionBlurSampleCount: 0, groupCount: 0, groupMaxDepth: 0, compositeCount: 1, compositeUniformBytes: 64, blurUniformBytes: 0, glowUniformBytes: 0, maskUniformBytes: 48, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: 38_400, estimatedPlanBytes: 448 }
  } as InternalGpuFramePlan;
}

function temporalEnvironmentPlan(sampleCount: number): InternalGpuFramePlan {
  const samples = Array.from({ length: sampleCount }, (_value, index) => ({ kind: "environment" as const, id: `rain.sample-${index}.0`, blendMode: "normal" as const, effects: null, environmentKind: "rain" as const, mode: "scene" as const, seed: 9, timeSeconds: index / 10, x: 0, y: 0, width: 4, height: 1, rotationDeg: 0, pivotX: 2, pivotY: .5, opacity: .25 / sampleCount, sceneResourceId: "scene", effectMaskResourceId: "mask", colors: [{ r: 0, g: 0, b: 0, a: 1 }, { r: .7, g: .9, b: 1, a: 1 }, { r: .2, g: .4, b: .7, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }] as [{ r: number; g: number; b: number; a: number }, { r: number; g: number; b: number; a: number }, { r: number; g: number; b: number; a: number }, { r: number; g: number; b: number; a: number }, { r: number; g: number; b: number; a: number }], parameters: [.8, .2, 1.4, 1, 4, .45, .9, .2, .7, .6, .8, .4, .3, 0, 0, 0] as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] }));
  return { schema: "shellx-motion/gpu-frame-intent@1", width: 4, height: 1, clear: { r: 0, g: 0, b: 0, a: 1 }, fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", draws: [{ kind: "motionBlurStart", id: "rain.motion-blur", blendMode: "normal", effects: null, sampleCount, drawCount: sampleCount, shutterAngle: 180, shutterDurationMs: 16.667 }, ...samples, { kind: "motionBlurEnd", id: "rain.motion-blur.end", groupId: "rain.motion-blur" }], budget: { rectangleCount: 0, pointCount: 0, computeParticleFieldCount: 0, computeParticleCount: 0, triangleVertexCount: 0, imageCount: 0, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 0, textUtf8Bytes: 0, textSurfacePixels: 0, scene3dCount: 0, scene3dObjectCount: 0, scene3dVertexCount: 0, scene3dIndexCount: 0, environmentCount: sampleCount, materialCount: 0, gradientStopCount: 0, pointBufferBytes: 0, computeParticleBufferBytes: 0, triangleBufferBytes: 0, imageVertexBufferBytes: 0, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0, textVertexBufferBytes: 0, scene3dVertexBufferBytes: 0, scene3dIndexBufferBytes: 0, scene3dUniformBytes: 0, environmentUniformBytes: sampleCount * 208, materialUniformBytes: 0, gradientUniformBytes: 0, styledRectangleUniformBytes: 0, blendModeCount: 0, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, maskCount: 0, blurPassCount: 0, adjustmentCount: 0, motionBlurGroupCount: 1, motionBlurSampleCount: sampleCount, groupCount: 0, groupMaxDepth: 0, compositeCount: 1, compositeUniformBytes: 64, blurUniformBytes: 0, glowUniformBytes: 0, maskUniformBytes: 0, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: 32, estimatedPlanBytes: sampleCount * 320 + 32 + 48 } } as InternalGpuFramePlan;
}

function staticEnvironmentPlan(): InternalGpuFramePlan {
  const temporal = temporalEnvironmentPlan(1);
  const sample = temporal.draws[1];
  if (!sample || sample.kind !== "environment") throw new Error("environment test plan is malformed");
  return { ...temporal, fingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", draws: [{ ...sample, id: "rain.static" }], budget: { ...temporal.budget, environmentCount: 1, environmentUniformBytes: 208, motionBlurGroupCount: 0, motionBlurSampleCount: 0, compositeCount: 1, compositeUniformBytes: 64, estimatedPlanBytes: 352 } };
}

function plainPlanBeforeEnvironment(): InternalGpuFramePlan {
  const environment = staticEnvironmentPlan();
  return { ...environment, fingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", draws: [{ kind: "rect", id: "plain", blendMode: "normal", effects: null, x: 0, y: 0, width: 4, height: 1, rotationDeg: 0, pivotX: 2, pivotY: .5, color: { r: .2, g: .3, b: .4, a: 1 } }], budget: { ...environment.budget, rectangleCount: 1, environmentCount: 0, environmentUniformBytes: 0, compositeCount: 0, compositeUniformBytes: 0, estimatedPlanBytes: 0 } };
}
