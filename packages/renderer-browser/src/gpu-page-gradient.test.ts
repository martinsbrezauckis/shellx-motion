import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionGradientPipeline } from "./gpu-page-gradient";

describe("installWebGpuPageSessionGradientPipeline", () => {
  it("installs one fixed bounded linear and radial gradient shader without package code", async () => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ getBindGroupLayout: () => ({}) }));
    const createShaderModule = vi.fn((_descriptor: { code: string }) => ({}));
    const context = createContext({
      __shellxMotionGpuSessionV1: { device: { createRenderPipeline, createShaderModule } }
    });
    const install = runInContext(`(${installWebGpuPageSessionGradientPipeline.toString()})`, context) as typeof installWebGpuPageSessionGradientPipeline;
    expect(await install()).toEqual({ ok: true });
    expect(createShaderModule).toHaveBeenCalledTimes(1);
    const shader = createShaderModule.mock.calls[0]?.[0]?.code;
    expect(shader).toContain("var<uniform> gradient");
    expect(shader).toContain("array<vec4<f32>,16>");
    expect(shader).toContain("gradient.header.x<0.5");
    expect(shader).not.toMatch(/eval|Function|import|require|fetch/);
    expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({ layout: "auto", primitive: { topology: "triangle-list" } }));
  });
});
