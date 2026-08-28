import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionBlurPipeline } from "./gpu-page-blur";

describe("installWebGpuPageSessionBlurPipeline", () => {
  it("installs one fixed bounded separable blur without package shader input", async () => {
    const createShaderModule = vi.fn((_value: { code: string }) => ({})); const createRenderPipeline = vi.fn((_value: unknown) => ({}));
    const context = createContext({ __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } } });
    const install = runInContext(`(${installWebGpuPageSessionBlurPipeline.toString()})`, context) as typeof installWebGpuPageSessionBlurPipeline;
    await expect(install()).resolves.toEqual({ ok: true });
    const shader = createShaderModule.mock.calls[0]?.[0]?.code as string;
    expect(shader).toContain("textureSampleLevel"); expect(shader).toContain("blur.radius/4.0");
    expect(shader.match(/textureSampleLevel/g)).toHaveLength(9);
    expect(createRenderPipeline).toHaveBeenCalledOnce();
  });
});
