import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionChromaMatteCleanupPipeline } from "./gpu-page-chroma-matte-cleanup";

describe("installWebGpuPageSessionChromaMatteCleanupPipeline", () => {
  it("installs the fixed CPU-matte-equivalent pass chain in an isolated VM", async () => {
    const createShaderModule = vi.fn((value: unknown) => value);
    const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
    const install = runInNewContext(`(${installWebGpuPageSessionChromaMatteCleanupPipeline.toString()})`, {
      globalThis: { __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } } }
    }) as typeof installWebGpuPageSessionChromaMatteCleanupPipeline;
    expect(await install()).toEqual({ ok: true });
    const source = createShaderModule.mock.calls.map(([entry]) => (entry as { code: string }).code).join("\n");
    expect(source).toContain("offset=-32");
    expect(source).toContain("offset=-16");
    expect(source).toContain("difference>=48.0/255.0");
    expect(source).toContain("rounded(original.a*0.75+blurred*0.25)");
    expect(source).toContain("alpha=min(cleaned,seed.a)*present.opacity");
    expect(source).toContain("blackClip");
    expect(source).not.toContain("texture_external");
    expect(createRenderPipeline).toHaveBeenCalledTimes(4);
  });
});
