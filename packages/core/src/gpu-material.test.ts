import { describe, expect, it } from "vitest";
import {
  GPU_MATERIAL_PRESETS,
  GPU_MATERIAL_UNIFORM_NAMES,
  gpuMaterialUniformRule,
  gpuMaterialUniformValues,
  isMotionGpuMaterialPreset,
  isMotionGpuMaterialUniform
} from "./gpu-material";

describe("fixed GPU material contract", () => {
  it("exposes only the four Motion-owned presets and the fixed eight-float ABI", () => {
    expect(GPU_MATERIAL_PRESETS).toEqual(["plasma", "hologram", "energy", "noise"]);
    expect(GPU_MATERIAL_UNIFORM_NAMES).toEqual([
      "u_speed", "u_scale", "u_intensity", "u_detail",
      "u_warp", "u_glow", "u_scanline", "u_phase"
    ]);
    expect(GPU_MATERIAL_PRESETS.every(isMotionGpuMaterialPreset)).toBe(true);
    expect(isMotionGpuMaterialPreset("custom-wgsl")).toBe(false);
    expect(GPU_MATERIAL_UNIFORM_NAMES.every(isMotionGpuMaterialUniform)).toBe(true);
    expect(isMotionGpuMaterialUniform("u_time")).toBe(false);
  });

  it("fills the stable defaults and admits each documented range endpoint", () => {
    expect(gpuMaterialUniformValues(undefined)).toEqual([1, 4, 1, 3, 0.5, 1, 0.5, 0]);
    expect(GPU_MATERIAL_UNIFORM_NAMES.map(gpuMaterialUniformRule)).toEqual([
      [-4, 4, 1], [0.1, 20, 4], [0, 2, 1], [1, 4, 3],
      [0, 2, 0.5], [0, 2, 1], [0, 1, 0.5], [-1_000, 1_000, 0]
    ]);
    expect(gpuMaterialUniformValues({
      u_speed: -4, u_scale: 20, u_intensity: 0, u_detail: 4,
      u_warp: 2, u_glow: 0, u_scanline: 1, u_phase: -1_000
    })).toEqual([-4, 20, 0, 4, 2, 0, 1, -1_000]);
  });

  it("rejects unknown, non-finite, and out-of-range uniform values", () => {
    expect(gpuMaterialUniformValues({ u_speed: 4.001 })).toBeNull();
    expect(gpuMaterialUniformValues({ u_scale: 0.099 })).toBeNull();
    expect(gpuMaterialUniformValues({ u_phase: Number.NaN })).toBeNull();
    expect(gpuMaterialUniformValues({ u_speed: 1, u_time: 42 })).toBeNull();
  });
});
