import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionStyledRectanglePipeline } from "./gpu-page-styled-rectangle";

describe("installWebGpuPageSessionStyledRectanglePipeline", () => {
  it("installs one fixed analytic radius, stroke and shadow shader", async () => {
    const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ getBindGroupLayout: () => ({}) }));
    const createShaderModule = vi.fn((_descriptor: { code: string }) => ({}));
    const context = createContext({ __shellxMotionGpuSessionV1: { device: { createRenderPipeline, createShaderModule } } });
    const install = runInContext(`(${installWebGpuPageSessionStyledRectanglePipeline.toString()})`, context) as typeof installWebGpuPageSessionStyledRectanglePipeline;
    expect(await install()).toEqual({ ok: true });
    const shader = createShaderModule.mock.calls[0]?.[0]?.code;
    expect(shader).toContain("rounded_distance");
    expect(shader).toContain("shadowCoverage");
    expect(shader).not.toMatch(/eval|Function|import|require|fetch/);
    expect(createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({ primitive: { topology: "triangle-list" } }));
  });
});
