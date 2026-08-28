import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionMaterialPipeline } from "./gpu-page-material";

describe("fixed WebGPU material pipeline", () => {
  it("installs the four Motion-owned presets without a package shader execution path", async () => {
    const createShaderModule = vi.fn((descriptor: { code: string }) => descriptor);
    const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
    const context = createContext({ Promise, __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } } });
    const install = runInContext(`(${installWebGpuPageSessionMaterialPipeline.toString()})`, context) as typeof installWebGpuPageSessionMaterialPipeline;

    expect(await install()).toEqual({ ok: true });
    expect(createShaderModule).toHaveBeenCalledTimes(1);
    const source = createShaderModule.mock.calls[0][0].code;
    expect(source).toContain("struct MaterialUniform");
    expect(source).toContain("fn palette(");
    expect(source).toContain("material.header.x");
    expect(source).not.toMatch(/fetch\(|eval\(|import\(|require\(|glsl|package/i);
    expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({ layout: "auto", fragment: expect.objectContaining({ entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }), primitive: { topology: "triangle-list" } }));
  });
});
