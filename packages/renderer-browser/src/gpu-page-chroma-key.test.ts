import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionChromaKeyPipeline } from "./gpu-page-chroma-key";

describe("installWebGpuPageSessionChromaKeyPipeline", () => {
  it("installs only the fixed CPU-keyer-equivalent color math", async () => {
    const createShaderModule = vi.fn((value: unknown) => value);
    const createRenderPipeline = vi.fn(() => ({}));
    const install = runInNewContext(`(${installWebGpuPageSessionChromaKeyPipeline.toString()})`, {
      globalThis: { __shellxMotionGpuSessionV1: { device: { createShaderModule, createRenderPipeline } } }
    }) as typeof installWebGpuPageSessionChromaKeyPipeline;
    expect(await install()).toEqual({ ok: true });
    const code = (createShaderModule.mock.calls[0]?.[0] as { code: string }).code;
    expect(code).toContain("-0.168736");
    expect(code).toContain("-0.418688");
    expect(code).toContain("smoothstep(threshold,threshold+max(0.0001,key.controls.y),distance)");
    expect(code).toContain("key.controls.w*spillWeight");
    expect(code).toContain("key.spill.y*spillWeight");
    expect(code).not.toContain("texture_external");
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
  });
});
