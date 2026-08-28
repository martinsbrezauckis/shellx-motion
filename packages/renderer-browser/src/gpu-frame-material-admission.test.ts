import { describe, expect, it } from "vitest";
import { admitGpuMaterial } from "./gpu-frame-material-admission";

const composite = { blendMode: "screen", effects: null };
const material = {
  preset: "energy", seed: 29, timeSeconds: 2.5, x: 4, y: 8, width: 32, height: 16,
  rotationDeg: 15, pivotX: 20, pivotY: 16, opacity: 0.7,
  colors: [{ r: 1, g: 0, b: 0.2, a: 1 }, { r: 0, g: 0.8, b: 1, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }],
  parameters: [1.5, 4, 1, 3, 0.5, 0.7, 0.2, 0.1]
};

describe("admitGpuMaterial", () => {
  it("reconstructs only the fixed material ABI and discards authored shader text", () => {
    const admitted = admitGpuMaterial({ ...material, glsl: "void main() {}", wgsl: "@fragment fn fs() {}" }, "neon", composite);
    expect(admitted).toMatchObject({ kind: "material", id: "neon", preset: "energy", parameters: material.parameters, blendMode: "screen" });
    expect(admitted).not.toHaveProperty("glsl");
    expect(admitted).not.toHaveProperty("wgsl");
  });

  it("refuses values outside the fixed preset, color, and parameter bounds", () => {
    expect(admitGpuMaterial({ ...material, preset: "custom" }, "neon", composite)).toBeNull();
    expect(admitGpuMaterial({ ...material, colors: material.colors.slice(0, 2) }, "neon", composite)).toBeNull();
    expect(admitGpuMaterial({ ...material, parameters: [...material.parameters.slice(0, 7), 1_001] }, "neon", composite)).toBeNull();
  });
});
