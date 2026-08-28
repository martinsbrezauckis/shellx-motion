import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionAdjustmentPipeline } from "./gpu-page-adjustment";
import { installWebGpuPageSessionBlendPipeline } from "./gpu-page-blend";
import { installWebGpuPageSessionBlurPipeline } from "./gpu-page-blur";
import { installWebGpuPageSessionChromaKeyPipeline } from "./gpu-page-chroma-key";
import { installWebGpuPageSessionChromaMatteCleanupPipeline } from "./gpu-page-chroma-matte-cleanup";
import { installWebGpuPageSessionEnvironmentPipeline } from "./gpu-page-environment";
import { installWebGpuPageSessionGlowPipeline } from "./gpu-page-glow";
import { installWebGpuPageSessionGradientPipeline } from "./gpu-page-gradient";
import { installWebGpuPageSessionMaskPipeline } from "./gpu-page-mask";
import { installWebGpuPageSessionMaterialPipeline } from "./gpu-page-material";
import { installWebGpuPageSessionScene3dPipeline } from "./gpu-page-scene3d";
import { installWebGpuPageSessionStyledRectanglePipeline } from "./gpu-page-styled-rectangle";

const installers: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
  ["adjustment", installWebGpuPageSessionAdjustmentPipeline],
  ["blend", installWebGpuPageSessionBlendPipeline],
  ["blur", installWebGpuPageSessionBlurPipeline],
  ["chroma key", installWebGpuPageSessionChromaKeyPipeline],
  ["chroma matte cleanup", installWebGpuPageSessionChromaMatteCleanupPipeline],
  ["environment", installWebGpuPageSessionEnvironmentPipeline],
  ["glow", installWebGpuPageSessionGlowPipeline],
  ["gradient", installWebGpuPageSessionGradientPipeline],
  ["mask", installWebGpuPageSessionMaskPipeline],
  ["material", installWebGpuPageSessionMaterialPipeline],
  ["scene 3D", installWebGpuPageSessionScene3dPipeline],
  ["styled rectangle", installWebGpuPageSessionStyledRectanglePipeline]
];

describe("auxiliary WebGPU pipeline setup", () => {
  it("reports deferred pipeline validation failures before the installer succeeds", async () => {
    for (const [name, implementation] of installers) {
      const createRenderPipeline = vi.fn(() => ({}));
      const createRenderPipelineAsync = vi.fn(async () => {
        throw new Error(`${name} deferred pipeline validation`);
      });
      const install = runInNewContext(`(${implementation.toString()})`, {
        globalThis: {
          __shellxMotionGpuSessionV1: {
            device: { createShaderModule: vi.fn(() => ({})), createRenderPipeline, createRenderPipelineAsync }
          }
        }
      }) as () => Promise<unknown>;

      await expect(install()).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
      expect(createRenderPipelineAsync).toHaveBeenCalledTimes(name === "environment" ? 2 : 1);
      expect(createRenderPipeline).not.toHaveBeenCalled();
    }
  });

  it("does not publish a half-created environment pipeline pair", async () => {
    const state = { device: { createShaderModule: vi.fn(() => ({})), createRenderPipeline: vi.fn(), createRenderPipelineAsync: vi.fn()
      .mockResolvedValueOnce({ tag: "replace" })
      .mockRejectedValueOnce(new Error("additive validation failed")) } };
    const install = runInNewContext(`(${installWebGpuPageSessionEnvironmentPipeline.toString()})`, {
      globalThis: { __shellxMotionGpuSessionV1: state }
    }) as typeof installWebGpuPageSessionEnvironmentPipeline;

    await expect(install()).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed" } });
    expect(state.device.createRenderPipelineAsync).toHaveBeenCalledTimes(2);
    expect(state).not.toHaveProperty("environmentPipeline");
    expect(state).not.toHaveProperty("additiveEnvironmentPipeline");
  });
});
