import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionAdjustmentPipeline } from "./gpu-page-adjustment";

describe("persistent WebGPU adjustment pipeline", () => {
  it("installs fixed deterministic vignette and film-grain WGSL", async () => {
    let shaderCode = ""; const createShaderModule = vi.fn((value: { code: string }) => { shaderCode = value.code; return {}; }); const createRenderPipeline = vi.fn(() => ({}));
    const context = createContext({ __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } } });
    const install = runInContext(`(${installWebGpuPageSessionAdjustmentPipeline.toString()})`, context) as typeof installWebGpuPageSessionAdjustmentPipeline;
    expect(await install()).toEqual({ ok: true });
    expect(shaderCode).toContain("random01(adjustment.grainSeed");
    expect(shaderCode).toContain("smoothstep(0.7-adjustment.vignette.y*0.5");
    expect(shaderCode).toContain("soft_light(b,noise)");
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
  });
});
