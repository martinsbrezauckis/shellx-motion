import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionGlowPipeline } from "./gpu-page-glow";

describe("installWebGpuPageSessionGlowPipeline", () => {
  it("groups a fixed authored-color halo beneath a color-graded layer", async () => {
    const createShaderModule = vi.fn((_value: { code: string }) => ({})); const createRenderPipeline = vi.fn((_value: unknown) => ({}));
    const context = createContext({ __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } } });
    const install = runInContext(`(${installWebGpuPageSessionGlowPipeline.toString()})`, context) as typeof installWebGpuPageSessionGlowPipeline;
    await expect(install()).resolves.toEqual({ ok: true });
    const shader = createShaderModule.mock.calls[0]?.[0]?.code;
    expect(shader).toContain("halo*(1.0-adjusted.a)"); expect(shader).toContain("apply_color_effects");
    expect(createRenderPipeline).toHaveBeenCalledOnce();
  });
});
