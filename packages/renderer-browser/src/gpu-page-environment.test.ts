import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionEnvironmentPipeline } from "./gpu-page-environment";

describe("fixed WebGPU environment pipeline", () => {
  it("installs Motion-owned rain, water, snow and fog WGSL without package code", async () => {
    const createShaderModule = vi.fn((descriptor: { code: string }) => descriptor);
    const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
    const context = createContext({
      Promise,
      __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } }
    });
    const install = runInContext(`(${installWebGpuPageSessionEnvironmentPipeline.toString()})`, context) as typeof installWebGpuPageSessionEnvironmentPipeline;

    expect(await install()).toEqual({ ok: true });
    expect(createShaderModule).toHaveBeenCalledTimes(1);
    const source = createShaderModule.mock.calls[0][0].code;
    expect(source).toContain("fn rain(");
    expect(source).toContain("fn water(");
    expect(source).toContain("fn snow(");
    expect(source).toContain("fn fog(");
    expect(source).toContain("@fragment fn fs(");
    expect(source).not.toMatch(/fetch\(|eval\(|import\(|package/i);
    expect(createRenderPipeline).toHaveBeenNthCalledWith(1, expect.objectContaining({
      layout: "auto",
      fragment: expect.objectContaining({ entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }),
      primitive: { topology: "triangle-list" }
    }));
    expect(createRenderPipeline).toHaveBeenNthCalledWith(2, expect.objectContaining({
      fragment: expect.objectContaining({
        targets: [expect.objectContaining({
          format: "rgba16float",
          blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } }
        })]
      })
    }));
  });
});
