import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionBlendPipeline } from "./gpu-page-blend";

describe("installWebGpuPageSessionBlendPipeline", () => {
  it("installs one fixed 16-mode texture compositor", async () => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ getBindGroupLayout: () => ({}) }));
    const createShaderModule = vi.fn((_descriptor: { code: string }) => ({}));
    const context = createContext({ __shellxMotionGpuSessionV1: { device: { createRenderPipeline, createShaderModule } } });
    const install = runInContext(`(${installWebGpuPageSessionBlendPipeline.toString()})`, context) as typeof installWebGpuPageSessionBlendPipeline;
    expect(await install()).toEqual({ ok: true });
    const shader = createShaderModule.mock.calls[0]?.[0]?.code;
    expect(shader).toContain("soft_light_channel");
    expect(shader).toContain("set_lum(set_sat");
    expect(shader).toContain("apply_color_effects");
    expect(shader).toContain("0.2126,0.7152,0.0722");
    expect(shader).toContain("backdrop.a*source.a*mixed");
    expect(shader).toContain("backdrop.rgb/max(backdrop.a,0.000001)");
    expect(shader).toContain("source_pixel");
    expect(shader).toContain("/composite.groupA.z+pivot");
    expect(shader).not.toContain("backdrop.rgb/backdrop.a");
    expect(shader).not.toMatch(/eval|Function|import|require|fetch/);
  });
});
