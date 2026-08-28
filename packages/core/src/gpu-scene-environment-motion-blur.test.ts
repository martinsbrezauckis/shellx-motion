import { describe, expect, it } from "vitest";
import { compileGpuFramePlan } from "./gpu-frame-intent";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

const IMAGE_RESOURCES = new Map([
  ["assets/scene.png", { resourceId: "scene-exact", assetRef: "assets/scene.png", width: 120, height: 80, sha256: "a".repeat(64) }],
  ["assets/effect-mask.png", { resourceId: "effect-mask-exact", assetRef: "assets/effect-mask.png", width: 120, height: 80, sha256: "b".repeat(64) }]
]);

describe("GPU fixed-environment temporal blur", () => {
  it.each([
    ["rain", 2], ["water", 4], ["snow", 8], ["fog", 4]
  ] as const)("lowers %s through exactly %i bounded shutter samples", (kind, sampleCount) => {
    const motion = environmentDocument(kind, sampleCount);
    const first = compileGpuScene2dPlan(motion, 500, { images: IMAGE_RESOURCES });
    const replay = compileGpuScene2dPlan(structuredClone(motion), 500, { images: IMAGE_RESOURCES });

    expect(first).toMatchObject({ ok: true });
    expect(replay).toMatchObject({ ok: true });
    if (!first.ok || !replay.ok) return;

    const group = first.plan.frame.draws[2];
    const samples = first.plan.frame.draws.slice(3, -1);
    expect(first.plan).toMatchObject({ environmentCount: 1, motionBlurLayerCount: 1, motionBlurSampleCount: sampleCount });
    expect(first.plan.frame.draws.map((draw) => draw.kind)).toEqual(["image", "image", "motionBlurStart", ...Array(sampleCount).fill("environment"), "motionBlurEnd"]);
    expect(group).toMatchObject({
      kind: "motionBlurStart", id: "weather.motion-blur", sampleCount, drawCount: sampleCount, shutterAngle: 360,
      blendMode: "screen", effects: { blur: 3, brightness: 1.1, glow: { radius: 8 } },
      mask: { shape: "rect", x: 4, y: 3, width: 110, height: 72, radius: 12, opacity: 0.7, featherPx: 2 }
    });
    expect(first.plan.frame.draws.at(-1)).toEqual({ kind: "motionBlurEnd", id: "weather.motion-blur.end", groupId: "weather.motion-blur" });
    for (const [index, draw] of samples.entries()) {
      expect(draw).toMatchObject({ kind: "environment", id: `weather.sample-${index}.0`, environmentKind: kind, blendMode: "normal", effects: null, opacity: 0.75 / sampleCount, sceneResourceId: "scene-exact", effectMaskResourceId: "effect-mask-exact" });
      if (draw.kind !== "environment") throw new Error("Expected a fixed environment shutter sample.");
      // Environment colors are straight fixed-shader inputs: only draw opacity
      // is divided, which prevents alpha from being divided twice in WGSL.
      expect(draw.colors.map((color) => color.a)).toEqual(environmentColorAlphas(kind));
      expect(draw.timeSeconds).toBeCloseTo(0.5 + ((index / (sampleCount - 1)) - 0.5) / 30, 10);
    }
    expect(first.plan.frame.budget).toMatchObject({
      environmentCount: sampleCount, environmentUniformBytes: sampleCount * 208,
      motionBlurGroupCount: 1, motionBlurSampleCount: sampleCount,
      compositeCount: 1, compositeUniformBytes: 64,
      estimatedPlanBytes: 240 + (sampleCount * 320) + 32 + 16 + 48 + 96 + 48
    });
    expect(replay.plan.frame).toEqual(first.plan.frame);
  });

  it("clamps exact shutter samples to the environment layer interval", () => {
    const motion = environmentDocument("rain", 4, { startMs: 100, durationMs: 100 });
    const atStart = compileGpuScene2dPlan(motion, 100, { images: IMAGE_RESOURCES });
    const atEnd = compileGpuScene2dPlan(motion, 199.999, { images: IMAGE_RESOURCES });
    expect(atStart).toMatchObject({ ok: true });
    expect(atEnd).toMatchObject({ ok: true });
    if (!atStart.ok || !atEnd.ok) return;

    expect(environmentTimes(atStart)).toEqual(expect.arrayContaining([0, 0]));
    expect(environmentTimes(atStart).slice(2)).toEqual(expect.arrayContaining([expect.closeTo(1 / 180, 12), expect.closeTo(1 / 60, 12)]));
    expect(environmentTimes(atEnd)).toEqual(expect.arrayContaining([expect.closeTo(83.33233333333334 / 1_000, 12), expect.closeTo(94.44344444444445 / 1_000, 12), 99.999 / 1_000, 99.999 / 1_000]));
  });

  it("separates four active environment layers from thirty-two sampled draws", () => {
    const motion = environmentDocument("rain", 8);
    motion.layers = [motion.layers[0], motion.layers[1], ...(["rain", "water", "snow", "fog"] as const).map((kind) => environmentLayer(kind, 8, `${kind}-weather`))];
    const result = compileGpuScene2dPlan(motion, 500, { images: IMAGE_RESOURCES });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ environmentCount: 4, motionBlurLayerCount: 4, motionBlurSampleCount: 32 });
    expect(result.plan.frame.budget).toMatchObject({ environmentCount: 32, environmentUniformBytes: 32 * 208, motionBlurGroupCount: 4, motionBlurSampleCount: 32 });

    expect(() => compileGpuFramePlan({ ...result.plan.frame, draws: [...result.plan.frame.draws, { ...result.plan.frame.draws.find((draw) => draw.kind === "environment")!, id: "overflow-environment" }] })).toThrow("at most 32 environment draw samples");

    const temporal = temporalEnvironmentGroup();
    const staticEnvironment = (id: string) => ({ ...temporal.first, id });
    const frame = { schema: result.plan.frame.schema, width: result.plan.frame.width, height: result.plan.frame.height, clear: result.plan.frame.clear };
    expect(() => compileGpuFramePlan({ ...frame, draws: Array.from({ length: 5 }, (_, index) => staticEnvironment(`static-${index}`)) })).toThrow("at most 4 active environment layers");
    expect(() => compileGpuFramePlan({ ...frame, draws: [...Array.from({ length: 4 }, (_, index) => staticEnvironment(`static-${index}`)), ...temporal.draws] })).toThrow("at most 4 active environment layers");
    expect(() => compileGpuFramePlan({ ...frame, draws: [...Array.from({ length: 3 }, (_, index) => staticEnvironment(`static-${index}`)), ...temporal.draws, ...temporal.draws.map((draw) => draw.kind === "motionBlurStart" ? { ...draw, id: "second.motion-blur" } : draw.kind === "motionBlurEnd" ? { ...draw, id: "second.motion-blur.end", groupId: "second.motion-blur" } : { ...draw, id: `${draw.id}.second` })] })).toThrow("at most 4 active environment layers");

    motion.layers.push(environmentLayer("rain", 2, "fifth-weather"));
    expect(compileGpuScene2dPlan(motion, 500, { images: IMAGE_RESOURCES })).toMatchObject({
      ok: false,
      failure: { code: "gpu_resource_refused", layerId: "fifth-weather", message: "GPU scenes support at most 4 active environment layers." }
    });
  });

  it("rejects forged temporal environment group membership before fingerprinting", () => {
    const result = compileGpuScene2dPlan(environmentDocument("rain", 2), 500, { images: IMAGE_RESOURCES });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const [group, first, second, end] = result.plan.frame.draws.slice(2);
    if (group?.kind !== "motionBlurStart" || first?.kind !== "environment" || second?.kind !== "environment" || end?.kind !== "motionBlurEnd") throw new Error("Expected the two-sample environment temporal group.");
    const frame = { schema: result.plan.frame.schema, width: result.plan.frame.width, height: result.plan.frame.height, clear: result.plan.frame.clear };
    const rect = { kind: "rect", id: "forged-raster", blendMode: "normal", effects: null, x: 0, y: 0, width: 1, height: 1, color: { r: 1, g: 1, b: 1, a: 1 } };

    expect(() => compileGpuFramePlan({ ...frame, draws: [{ ...group, drawCount: 2 }, first, rect, end] })).toThrow("exactly one fixed environment draw per shutter sample");
    expect(() => compileGpuFramePlan({ ...frame, draws: [{ ...group, drawCount: 3 }, first, { ...first, id: "forged-repeat" }, second, end] })).toThrow("exactly one fixed environment draw per shutter sample");
    expect(() => compileGpuFramePlan({ ...frame, draws: [{ ...group, drawCount: 3 }, first, rect, second, end] })).toThrow("exactly one fixed environment draw per shutter sample");
  });

  it("retains temporal refusals outside fixed environment layers", () => {
    expect(compileGpuScene2dPlan(document([{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000, effects: { motionBlur: { samples: 2, shutterAngle: 180 } } }]), 500)).toMatchObject({ ok: false, failure: { layerId: "clip", message: expect.stringContaining("decoder can supply every shutter sample") } });
    expect(compileGpuScene2dPlan(document([{ id: "card", type: "html", source: "surface.html", startMs: 0, durationMs: 1_000, effects: { motionBlur: { samples: 2, shutterAngle: 180 } } }]), 500)).toMatchObject({ ok: false, failure: { layerId: "card", message: "GPU browser surface card does not support temporal motion blur." } });
    expect(compileGpuScene2dPlan(document([materialTemporalLayer()]), 500)).toMatchObject({ ok: false, failure: { layerId: "material", message: "GPU material layer material does not yet support temporal supersampling." } });
    expect(compileGpuScene2dPlan(document([scene3dTemporalLayer()]), 500)).toMatchObject({ ok: false, failure: { layerId: "world", message: "GPU scene3d layer world does not yet support temporal supersampling." } });
    expect(compileGpuScene2dPlan(document([{ id: "container", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["child"], effects: { motionBlur: { samples: 2, shutterAngle: 180 } } }, { id: "child", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 }]), 500)).toMatchObject({ ok: false, failure: { layerId: "container", message: expect.stringContaining("group-level temporal blur") } });
    expect(compileGpuScene2dPlan(document([{ id: "dust", type: "particles", startMs: 0, durationMs: 1_000, effects: { motionBlur: { samples: 2, shutterAngle: 180 } }, emitter: { seed: 7, count: 100_000, lifetimeMs: 1_000, shape: "circle", color: "#ffffff", field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.2, softening: 0.1 }] } } }]), 500)).toMatchObject({ ok: false, failure: { layerId: "dust", message: expect.stringContaining("requires normal blend with no effects, trails, or temporal blur") } });
  });
});

function environmentTimes(result: Extract<ReturnType<typeof compileGpuScene2dPlan>, { ok: true }>): number[] {
  return result.plan.frame.draws.filter((draw) => draw.kind === "environment").map((draw) => draw.timeSeconds);
}

function temporalEnvironmentGroup(): { draws: ReturnType<typeof compileGpuFramePlan>["draws"]; first: Extract<ReturnType<typeof compileGpuFramePlan>["draws"][number], { kind: "environment" }> } {
  const result = compileGpuScene2dPlan(environmentDocument("rain", 2), 500, { images: IMAGE_RESOURCES });
  if (!result.ok) throw new Error("Expected a two-sample environment plan.");
  const draws = result.plan.frame.draws.slice(2);
  const first = draws.find((draw): draw is Extract<typeof draw, { kind: "environment" }> => draw.kind === "environment");
  if (!first) throw new Error("Expected a fixed environment shutter sample.");
  return { draws, first };
}

function environmentColorAlphas(kind: "rain" | "water" | "snow" | "fog"): number[] {
  return kind === "water" ? [1, 1, 1, 1, 1] : kind === "fog" ? [1, 1, 1, 0, 0] : [1, 1, 1, 1, 0];
}

function materialTemporalLayer(): MotionLayer {
  return { id: "material", type: "shader", startMs: 0, durationMs: 1_000, transform: { width: 120, height: 80 }, effects: { motionBlur: { samples: 2, shutterAngle: 180 } }, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "fixed-material", seed: 7, fallbackColor: "#000000", gpuMaterial: { preset: "plasma", colors: ["#000000", "#00ffff", "#ffffff"] } } };
}

function scene3dTemporalLayer(): MotionLayer {
  return { id: "world", type: "scene3d", startMs: 0, durationMs: 1_000, effects: { motionBlur: { samples: 2, shutterAngle: 180 } }, scene3d: { schema: "shellx-motion/scene3d@2", backgroundColor: "#000000", camera: { position: [0, 0, 5], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 }, lighting: { ambient: 0.2, direction: [0, -1, -1], intensity: 1, color: "#ffffff" }, objects: [{ id: "cube", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#ffffff" }] } };
}

function environmentDocument(kind: "rain" | "water" | "snow" | "fog", samples: number, timing: { startMs?: number; durationMs?: number } = {}): MotionDocument {
  return document([
    { id: "scene", type: "image", source: "assets/scene.png", fit: "fill", startMs: 0, durationMs: 1_000, transform: { width: 120, height: 80 } },
    { id: "effect-mask", type: "image", source: "assets/effect-mask.png", fit: "fill", opacity: 0, startMs: 0, durationMs: 1_000, transform: { width: 120, height: 80 } },
    environmentLayer(kind, samples, "weather", timing)
  ]);
}

function environmentLayer(kind: "rain" | "water" | "snow" | "fog", samples: number, id: string, timing: { startMs?: number; durationMs?: number } = {}): MotionLayer {
  return {
    id, type: "environment", startMs: timing.startMs ?? 0, durationMs: timing.durationMs ?? 1_000, opacity: 0.75, blendMode: "screen",
    transform: { x: 0, y: 0, width: 120, height: 80 },
    effects: { motionBlur: { samples, shutterAngle: 360 }, blur: 3, brightness: 1.1, glow: { radius: 8, color: "#80c0ff" } },
    mask: { type: "rounded-rect", inset: { top: 3, right: 6, bottom: 5, left: 4 }, radius: 12, opacity: 0.7, featherPx: 2 },
    environment: environment(kind)
  };
}

function environment(kind: "rain" | "water" | "snow" | "fog"): NonNullable<MotionLayer["environment"]> {
  if (kind === "rain") return { schema: "shellx-motion/environment@1", kind, seed: 71, quality: "cinematic", mode: "scene", sceneSourceLayerId: "scene", effectMaskLayerId: "effect-mask", intensity: 0.8, wind: 0.2, dropSpeed: 1.4, dropLength: 1, depthLayers: 4, color: "#bdebff", backgroundColor: "#050a12", lightColor: "#7dd3fc", accentColor: "#fb7185", ground: { horizon: 0.43, wetness: 0.9, roughness: 0.24, rippleAmount: 0.78, splashAmount: 0.64, reflectionStrength: 0.88 }, atmosphere: { mist: 0.44, lensDroplets: 0.34 } };
  if (kind === "water") return { schema: "shellx-motion/environment@1", kind, seed: 72, quality: "cinematic", mode: "scene", sceneSourceLayerId: "scene", effectMaskLayerId: "effect-mask", backgroundColor: "#071522", shallowColor: "#4dd0e1", deepColor: "#0f2850", reflectionColor: "#ffffff", foamColor: "#dffcff", surface: { horizon: 0.4, waveScale: 3, waveHeight: 0.5, waveSpeed: 1.1, direction: 20, choppiness: 0.3, waveOctaves: 4 }, optics: { reflectionStrength: 0.6, refractionStrength: 0.3, fresnel: 0.5, caustics: 0.3, clarity: 0.8, foam: 0.3 } };
  if (kind === "snow") return { schema: "shellx-motion/environment@1", kind, seed: 73, quality: "cinematic", mode: "scene", sceneSourceLayerId: "scene", effectMaskLayerId: "effect-mask", backgroundColor: "#101826", snowColor: "#ffffff", shadowColor: "#9bb8df", lightColor: "#e8f7ff", fall: { intensity: 0.7, speed: 0.8, wind: 0.1, turbulence: 0.4, flakeSize: 1.2, depthLayers: 4, focusFalloff: 0.5 }, ground: { horizon: 0.5, accumulation: 0.4, drift: 0.2, contactAmount: 0.7 }, atmosphere: { haze: 0.2, depthFade: 0.4 } };
  return { schema: "shellx-motion/environment@1", kind, seed: 74, quality: "cinematic", mode: "scene", sceneSourceLayerId: "scene", effectMaskLayerId: "effect-mask", backgroundColor: "#061019", fogColor: "#b8d6e8", lightColor: "#ffffff", fog: { density: 0.4, speed: 0.7, scale: 1.4, turbulence: 0.3, height: 0.6, depthLayers: 4, lightStrength: 0.7 } };
}

function document(layers: MotionLayer[]): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "environment-temporal", name: "Environment temporal", durationMs: 1_000, fps: 30, width: 120, height: 80, background: "#000000", assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers };
}
