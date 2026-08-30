import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  closeWebGpuPageSessionAfterimageStackPipeline,
  installWebGpuPageSessionAfterimageStackPipeline,
  prepareWebGpuPageSessionAfterimageStackPass,
  renderWebGpuPageSessionAfterimageStackPass
} from "./gpu-page-afterimage-stack";
import { isCanonicalMotionEffectModuleVersion } from "@shellx-motion/core";
import { createGpuPageAfterimageStackFixture } from "./unadopted/gpu-page-afterimage-stack.test-support";

const descriptor = createGpuPageAfterimageStackFixture({
  width: 5,
  height: 3,
  echoes: [
    { dxPx: 2, dyPx: 0, rgba8: [255, 0, 64, 255], opacityQ16: 65_535 },
    { dxPx: -1, dyPx: 1, rgba8: [0, 128, 255, 128], opacityQ16: 32_768 }
  ],
  amountQ16: 32_768
});
const sequentialDescriptor = createGpuPageAfterimageStackFixture({
  width: 5,
  height: 3,
  echoes: [{ dxPx: -2, dyPx: 1, rgba8: [0, 255, 64, 192], opacityQ16: 20_000 }],
  amountQ16: 1
});
const implementationIdentity = {
  pipelineImplementationSha256: descriptor.pipelineImplementationSha256,
  resourceCeilingSha256: descriptor.resourceCeilingSha256
};

describe("fixed WebGPU afterimage-stack page intrinsic", () => {
  it("installs host-owned WGSL with four bounded alpha texture loads and no time/random/code seam", async () => {
    let shaderCode = "";
    const createShaderModule = vi.fn((value: { code: string }) => { shaderCode = value.code; return {}; });
    const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
    const context = createContext({ __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } } });
    const install = runInContext(`(${installWebGpuPageSessionAfterimageStackPipeline.toString()})`, context) as typeof installWebGpuPageSessionAfterimageStackPipeline;
    expect(await install(implementationIdentity)).toEqual({ ok: true });
    expect(shaderCode).toContain("array<vec4<i32>,4>");
    expect(shaderCode).toContain("pixel.x<0||pixel.y<0");
    expect(shaderCode).toContain("textureLoad(sourceTexture,pixel,0)");
    expect(shaderCode).toContain("over(current,echoes)");
    expect(shaderCode).toContain("reverse<4u");
    expect(shaderCode).not.toContain("textureSample");
    expect(shaderCode).not.toMatch(/time|random|seed|history|asset/i);
    expect(createRenderPipeline).toHaveBeenCalledOnce();
    expect(await install(implementationIdentity)).toEqual({ ok: true });
    expect(createRenderPipeline).toHaveBeenCalledOnce();
  });

  it("fails closed when asynchronous pipeline validation rejects", async () => {
    const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
    const createRenderPipelineAsync = vi.fn(async () => { throw new Error("WGSL validation"); });
    const context = createContext({ __shellxMotionGpuSessionV1: { device: { createShaderModule: vi.fn(() => ({})), createRenderPipeline, createRenderPipelineAsync } } });
    const install = runInContext(`(${installWebGpuPageSessionAfterimageStackPipeline.toString()})`, context) as typeof installWebGpuPageSessionAfterimageStackPipeline;
    expect(await install(implementationIdentity)).toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
    expect(createRenderPipeline).not.toHaveBeenCalled();
    expect(runInContext("Object.hasOwn(globalThis.__shellxMotionGpuSessionV1, 'afterimageStackPipeline')", context)).toBe(false);
  });

  it("executes the installed page closure only for its exact prepared source-to-target ABI", async () => {
    const writeBuffer = vi.fn();
    const beginRenderPass = vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }));
    const pipeline = { getBindGroupLayout: vi.fn(() => ({})) };
    const context = createContext({
      __shellxMotionGpuSessionV1: { device: { createShaderModule: vi.fn(() => ({})), createRenderPipeline: vi.fn(() => pipeline), createBindGroup: vi.fn(() => ({})), queue: { writeBuffer } } },
      Array, ArrayBuffer, Int32Array, Uint32Array, Float32Array, Number, Object, Set
    });
    const install = runInContext(`(${installWebGpuPageSessionAfterimageStackPipeline.toString()})`, context) as typeof installWebGpuPageSessionAfterimageStackPipeline;
    const prepare = runInContext(`(${prepareWebGpuPageSessionAfterimageStackPass.toString()})`, context) as typeof prepareWebGpuPageSessionAfterimageStackPass;
    expect(await install(implementationIdentity)).toEqual({ ok: true });
    const source = { createView: () => "source" }, target = { createView: () => "target" };
    expect(prepare({ descriptor: { ...descriptor, version: `1.2.3-${"a".repeat(128)}` }, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: {} })).toMatchObject({ ok: false });
    expect(beginRenderPass).not.toHaveBeenCalled();
    expect(prepare({ descriptor, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: {} })).toMatchObject({ ok: true });
    const pageState = runInContext("globalThis.__shellxMotionGpuSessionV1", context) as { afterimageStackFrame?: { descriptorSeal: string } };
    pageState.afterimageStackFrame = { descriptorSeal: afterimageDescriptorSeal(descriptor) };
    const execute = runInContext("globalThis.__shellxMotionGpuSessionV1.afterimageStackExecute", context) as (input: unknown) => { ok: boolean };
    const base = { descriptor, source, sourceWidth: 5, sourceHeight: 3, target, targetWidth: 5, targetHeight: 3, encoder: { beginRenderPass } };
    expect(execute(base)).toEqual({ ok: true, uniformBytes: 160, maxTextureLoadsPerPixel: 5 });
    const uploads = writeBuffer.mock.calls.length;
    expect(execute({ ...base, target: source })).toMatchObject({ ok: false });
    expect(execute({ ...base, targetWidth: 4 })).toMatchObject({ ok: false });
    expect(execute({ ...base, descriptor: { ...descriptor, bindingFingerprint: "0".repeat(64) } })).toMatchObject({ ok: false });
    expect(execute({ ...base, descriptor: { ...descriptor, amountQ16: 12_345 } })).toMatchObject({ ok: false });
    expect(execute({ ...base, descriptor: { ...descriptor, echoes: [{ ...descriptor.echoes[0]!, dxPx: 7 }, ...descriptor.echoes.slice(1)] } })).toMatchObject({ ok: false });
    expect(writeBuffer).toHaveBeenCalledTimes(uploads);
  });

  it("matches Core's canonical SemVer corpus in both serialized page evaluators", () => {
    const versions = [
      "0.0.0", "1.2.3", "1.2.3-0", "1.2.3-rc.1", "1.2.3-alpha-01",
      "v1.2.3", "1.2.3+build", "latest", "^1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-00", "1.2.3-rc.01", `1.2.3-${"a".repeat(128)}`
    ];
    for (const version of versions) {
      const context = createContext({
        __shellxMotionGpuSessionV1: { device: { queue: { writeBuffer: vi.fn() }, createBindGroup: vi.fn(() => ({})) }, afterimageStackPipeline: { getBindGroupLayout: () => ({}) }, afterimageStackIdentity: implementationIdentity },
        Array, ArrayBuffer, Int32Array, Uint32Array, Float32Array, Number, Object, Set
      });
      const prepare = runInContext(`(${prepareWebGpuPageSessionAfterimageStackPass.toString()})`, context) as typeof prepareWebGpuPageSessionAfterimageStackPass;
      const render = runInContext(`(${renderWebGpuPageSessionAfterimageStackPass.toString()})`, context) as typeof renderWebGpuPageSessionAfterimageStackPass;
      const source = { createView: () => "source" }, target = { createView: () => "target" };
      const expected = isCanonicalMotionEffectModuleVersion(version);
      const prepared = prepare({ descriptor: { ...descriptor, version }, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: {} });
      expect(prepared.ok, `prepare ${version}`).toBe(expected);
      if (prepared.ok) {
        expect(render({ descriptor: { ...descriptor, version }, prepared: prepared.prepared, target, targetWidth: 5, targetHeight: 3, encoder: { beginRenderPass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }) } }), `render ${version}`).toMatchObject({ ok: true });
        continue;
      }
      const valid = prepare({ descriptor, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: {} });
      if (!valid.ok) throw new Error("valid fixture did not prepare");
      expect(render({ descriptor: { ...descriptor, version }, prepared: valid.prepared, target, targetWidth: 5, targetHeight: 3, encoder: { beginRenderPass: vi.fn() } }), `render ${version}`).toMatchObject({ ok: false });
    }
  });

  it("reuses one prepared isolated source-to-target pass across sequential Core bindings with no second-frame allocation", () => {
    const writeBuffer = vi.fn();
    const createBindGroup = vi.fn(() => ({ binding: "prepared" }));
    const createBuffer = vi.fn();
    const setPipeline = vi.fn(); const setBindGroup = vi.fn(); const draw = vi.fn(); const end = vi.fn();
    const pipeline = { getBindGroupLayout: vi.fn(() => ({})) };
    const context = createContext({
      __shellxMotionGpuSessionV1: { device: { queue: { writeBuffer }, createBindGroup, createBuffer }, afterimageStackPipeline: pipeline, afterimageStackIdentity: implementationIdentity },
      Array, ArrayBuffer, Int32Array, Uint32Array, Float32Array, Number, Object, Set
    });
    const prepare = runInContext(`(${prepareWebGpuPageSessionAfterimageStackPass.toString()})`, context) as typeof prepareWebGpuPageSessionAfterimageStackPass;
    const render = runInContext(`(${renderWebGpuPageSessionAfterimageStackPass.toString()})`, context) as typeof renderWebGpuPageSessionAfterimageStackPass;
    const source = { createView: () => "source-view" };
    const target = { createView: () => "target-view" };
    const prepared = prepare({ descriptor, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: {} });
    if (!prepared.ok) throw new Error("fixture did not prepare");
    expect(prepare({ descriptor: sequentialDescriptor, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: prepared.prepared.uniformBuffer })).toEqual({ ok: true, prepared: prepared.prepared });
    expect(prepare({ descriptor, source: { createView: () => "second-source" }, sourceWidth: 5, sourceHeight: 3, uniformBuffer: prepared.prepared.uniformBuffer })).toMatchObject({ ok: false });
    const input = {
      descriptor,
      prepared: prepared.prepared,
      target,
      targetWidth: 5,
      targetHeight: 3,
      encoder: { beginRenderPass: () => ({ setPipeline, setBindGroup, draw, end }) }
    };
    expect(render(input)).toEqual({ ok: true, uniformBytes: 160, maxTextureLoadsPerPixel: 5 });
    expect(render({ ...input, descriptor: sequentialDescriptor })).toEqual({ ok: true, uniformBytes: 160, maxTextureLoadsPerPixel: 5 });
    expect(render(input)).toEqual({ ok: true, uniformBytes: 160, maxTextureLoadsPerPixel: 5 });
    expect(createBindGroup).toHaveBeenCalledOnce();
    expect(createBuffer).not.toHaveBeenCalled();
    expect(writeBuffer).toHaveBeenCalledTimes(3);
    const bytes = writeBuffer.mock.calls[0][2] as ArrayBuffer;
    expect(bytes.byteLength).toBe(160);
    expect(Array.from(new Uint32Array(bytes, 0, 4))).toEqual([5, 3, 2, 0]);
    expect(setPipeline).toHaveBeenCalledWith(pipeline);
    expect(setBindGroup).toHaveBeenCalledWith(0, prepared.prepared.bindGroup);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(end).toHaveBeenCalledTimes(3);
  });

  it("fails before upload for an alias target, incorrect extent, or unprepared binding", () => {
    const writeBuffer = vi.fn();
    const state = { device: { queue: { writeBuffer }, createBindGroup: vi.fn(() => ({})) }, afterimageStackPipeline: { getBindGroupLayout: () => ({}) }, afterimageStackIdentity: implementationIdentity };
    const saved = (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1;
    (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = state;
    try {
      const source = { createView: () => ({}) };
      const target = { createView: () => ({}) };
      const prepared = prepareWebGpuPageSessionAfterimageStackPass({ descriptor, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: {} });
      if (!prepared.ok) throw new Error("fixture did not prepare");
      const base = { descriptor, prepared: prepared.prepared, target, targetWidth: 5, targetHeight: 3, encoder: { beginRenderPass: vi.fn() } };
      const { drawId: _drawId, ...withoutDrawId } = descriptor;
      const expectRefusalBeforeUpload = (input: Parameters<typeof renderWebGpuPageSessionAfterimageStackPass>[0]) => {
        const uploads = writeBuffer.mock.calls.length;
        expect(renderWebGpuPageSessionAfterimageStackPass(input)).toMatchObject({ ok: false });
        expect(writeBuffer).toHaveBeenCalledTimes(uploads);
      };
      expectRefusalBeforeUpload({ ...base, targetWidth: 4 });
      expectRefusalBeforeUpload({ ...base, descriptor: { ...descriptor, code: "forbidden" } });
      expectRefusalBeforeUpload({ ...base, descriptor: withoutDrawId });
      expectRefusalBeforeUpload({ ...base, descriptor: { ...descriptor, version: `1.2.3-${"a".repeat(128)}` } });
      expectRefusalBeforeUpload({ ...base, descriptor: { ...descriptor, pipelineImplementationSha256: "a".repeat(64) } });
      expectRefusalBeforeUpload({ ...base, target: source });
      expectRefusalBeforeUpload({ ...base, prepared: { ...prepared.prepared } });
    } finally {
      (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = saved;
    }
  });

  it("reports a render failure and drops all prepared bind-group and uniform references on close", () => {
    const state = { device: { queue: { writeBuffer: vi.fn() }, createBindGroup: vi.fn(() => ({})) }, afterimageStackPipeline: { getBindGroupLayout: () => ({}) }, afterimageStackIdentity: implementationIdentity };
    const saved = (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1;
    (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = state;
    try {
      const source = { createView: () => ({}) };
      const prepared = prepareWebGpuPageSessionAfterimageStackPass({ descriptor, source, sourceWidth: 5, sourceHeight: 3, uniformBuffer: {} });
      if (!prepared.ok) throw new Error("fixture did not prepare");
      const result = renderWebGpuPageSessionAfterimageStackPass({
        descriptor,
        prepared: prepared.prepared,
        target: { createView: () => ({}) },
        targetWidth: 5,
        targetHeight: 3,
        encoder: { beginRenderPass: () => { throw new Error("device lost"); } }
      });
      expect(result).toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
      expect(closeWebGpuPageSessionAfterimageStackPipeline()).toEqual({ releasedPipeline: true, releasedPreparedPasses: 1, releasedArenaUniformReferences: 1, releasedUniformBuffers: 1 });
      expect(closeWebGpuPageSessionAfterimageStackPipeline()).toEqual({ releasedPipeline: false, releasedPreparedPasses: 0, releasedArenaUniformReferences: 0, releasedUniformBuffers: 0 });
      expect(renderWebGpuPageSessionAfterimageStackPass({
        descriptor,
        prepared: prepared.prepared,
        target: { createView: () => ({}) },
        targetWidth: 5,
        targetHeight: 3,
        encoder: { beginRenderPass: vi.fn() }
      })).toMatchObject({ ok: false });
    } finally {
      (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = saved;
    }
  });
});

function afterimageDescriptorSeal(value: Record<string, unknown>): string {
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
