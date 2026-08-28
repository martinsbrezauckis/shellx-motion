import { describe, expect, it } from "vitest";
import { GPU_FRAME_INTENT_SCHEMA, compileGpuFramePlan } from "./gpu-frame-intent";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

function materialLayer(overrides: Partial<MotionLayer> = {}): MotionLayer {
  return {
    id: "material",
    type: "shader",
    startMs: 0,
    durationMs: 1_000,
    opacity: 0.75,
    blendMode: "screen",
    transform: { x: 10, y: 20, width: 80, height: 40 },
    shader: {
      schema: "shellx-motion/shader-plugin@1",
      language: "glsl-es-100-expression",
      fragmentAssetId: "package-provided-glsl-is-never-gpu-intent",
      seed: 7,
      fallbackColor: "#000000",
      uniforms: { u_speed: 1, u_glow: 1 },
      gpuMaterial: { preset: "plasma", colors: ["#ff000080", "#00ff00", "transparent"] }
    },
    ...overrides
  };
}

function materialScene(layers: MotionLayer[] = [materialLayer()]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_gpu_material",
    name: "GPU material",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 60,
    background: "#102030",
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
    layers
  };
}

describe("GPU fixed material scene lowering", () => {
  it("lowers fixed data at the exact timestamp, applies keyframes, and excludes package shader source", () => {
    const layer = materialLayer({
      keyframes: {
        "transform.x": [{ atMs: 0, value: 10 }, { atMs: 1_000, value: 30 }],
        "shader.uniforms.u_speed": [{ atMs: 0, value: -2 }, { atMs: 1_000, value: 2 }]
      } as never
    });
    const first = compileGpuScene2dPlan(materialScene([layer]), 500);
    const second = compileGpuScene2dPlan(JSON.parse(JSON.stringify(materialScene([layer]))), 500);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const draw = first.plan.frame.draws[0];
    expect(first.plan).toMatchObject({ visualLayerCount: 1, materialCount: 1 });
    expect(draw).toMatchObject({
      kind: "material", id: "material", preset: "plasma", seed: 7, timeSeconds: 0.5,
      x: 20, y: 20, width: 80, height: 40, opacity: 0.75,
      colors: [{ r: 1, g: 0, b: 0, a: 128 / 255 }, { r: 0, g: 1, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 0 }],
      parameters: [0, 4, 1, 3, 0.5, 1, 0.5, 0]
    });
    expect(draw).not.toHaveProperty("fragmentAssetId");
    expect(draw).not.toHaveProperty("shaderSource");
    expect(JSON.stringify(draw)).not.toContain("package-provided-glsl-is-never-gpu-intent");
    expect(first.plan.frame.fingerprint).toBe(second.plan.frame.fingerprint);
  });

  it("preserves fixed material effects and bounded authored masks in compositor accounting", () => {
    const result = compileGpuScene2dPlan(materialScene([materialLayer({
      effects: { blur: 4, brightness: 1.2, glow: { radius: 8, color: "#80c0ff" } },
      mask: { type: "rounded-rect", inset: { top: 2, right: 3 }, radius: 12, opacity: 0.5, featherPx: 4 }
    })]), 250);

    expect(result).toMatchObject({
      ok: true,
      plan: {
        materialCount: 1,
        maskCount: 1,
        frame: {
          draws: [{
            kind: "material",
            effects: { blur: 4, brightness: 1.2, contrast: 1, saturate: 1, grayscale: 0, glow: { radius: 8 } },
            mask: { shape: "rect", x: 10, y: 22, width: 77, height: 38, radius: 12, opacity: 0.5, featherPx: 4 }
          }],
          budget: { materialCount: 1, materialUniformBytes: 144, maskCount: 1, compositeCount: 1 }
        }
      }
    });
  });

  it("rejects unknown presets, uniforms, and colors before any GPU execution", () => {
    const preset = materialLayer();
    preset.shader!.gpuMaterial!.preset = "custom-wgsl" as never;
    expect(compileGpuScene2dPlan(materialScene([preset]), 0)).toMatchObject({
      ok: false,
      failure: { code: "gpu_resource_refused", message: expect.stringContaining("material.preset is unsupported") }
    });

    const uniform = materialLayer();
    uniform.shader!.uniforms = { u_speed: 1, u_time: 4 };
    expect(compileGpuScene2dPlan(materialScene([uniform]), 0)).toMatchObject({
      ok: false,
      failure: { code: "gpu_unsupported_feature", layerId: "material", message: expect.stringContaining("unsupported fixed-material uniforms") }
    });

    const color = materialLayer();
    color.shader!.gpuMaterial!.colors = ["#ff0000", "url(https://invalid.example)", "#0000ff"];
    expect(compileGpuScene2dPlan(materialScene([color]), 0)).toMatchObject({
      ok: false,
      failure: { code: "gpu_unsupported_feature", layerId: "material", message: expect.stringContaining("colors must be hexadecimal or transparent") }
    });
  });

  it("enforces the eight-layer Core budget and re-admits only fixed material frame fields", () => {
    const layers = Array.from({ length: 8 }, (_, index) => materialLayer({ id: `material-${index}` }));
    const scene = compileGpuScene2dPlan(materialScene(layers), 0);
    expect(scene).toMatchObject({ ok: true, plan: { materialCount: 8, frame: { budget: { materialCount: 8, materialUniformBytes: 1_152 } } } });

    const overLimit = compileGpuScene2dPlan(materialScene([...layers, materialLayer({ id: "material-8" })]), 0);
    expect(overLimit).toMatchObject({
      ok: false,
      failure: { code: "gpu_resource_refused", message: "GPU frames support at most eight fixed material layers." }
    });

    const plan = compileGpuFramePlan({
      schema: GPU_FRAME_INTENT_SCHEMA,
      width: 32,
      height: 16,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      draws: [{
        kind: "material", id: "fixed", preset: "energy", seed: 1, timeSeconds: 2,
        x: 0, y: 0, width: 32, height: 16, rotationDeg: 0, pivotX: 16, pivotY: 8, opacity: 1,
        colors: [{ r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 1, b: 0, a: 1 }, { r: 0, g: 0, b: 1, a: 1 }],
        parameters: [1, 4, 1, 3, 0.5, 1, 0.5, 0], shaderSource: "ignored-package-code"
      }]
    });
    expect(plan.draws[0]).toMatchObject({ kind: "material", preset: "energy", parameters: [1, 4, 1, 3, 0.5, 1, 0.5, 0] });
    expect(plan.draws[0]).not.toHaveProperty("shaderSource");
    expect(plan.budget).toMatchObject({ materialCount: 1, materialUniformBytes: 144, compositeCount: 1 });
  });

  it("refuses temporal motion blur for materials rather than synthesizing a fallback", () => {
    const result = compileGpuScene2dPlan(materialScene([materialLayer({
      effects: { motionBlur: { samples: 2, shutterAngle: 180 } }
    })]), 500);
    expect(result).toEqual({
      ok: false,
      failure: {
        code: "gpu_unsupported_feature",
        layerId: "material",
        message: "GPU material layer material does not yet support temporal supersampling."
      }
    });
  });
});
