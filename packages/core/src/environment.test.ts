import { describe, expect, it } from "vitest";
import { requiredLayerFeatures } from "./capabilities";
import { effectiveLayerAtMs } from "./timeline";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionFogEnvironment, MotionLayer, MotionRainEnvironment, MotionSnowEnvironment, MotionWaterEnvironment } from "./types";

describe("bounded environment simulation contract", () => {
  it("accepts deterministic rain scenes and advertises the fixed host feature", async () => {
    const layer = validRainLayer();

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([layer]))).toEqual({ ok: true });
    expect(requiredLayerFeatures(layer)).toContain("environment.rain.fixed-simulation");
  });

  it("accepts a bounded full-frame image as a deterministic scene texture", async () => {
    const source: MotionLayer = {
      id: "footage",
      type: "image",
      source: "assets/scene.png",
      fit: "fill",
      startMs: 0,
      durationMs: 3000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 }
    };
    const rain = validRainLayer();
    if (rain.environment?.kind !== "rain") throw new Error("Expected rain environment.");
    rain.environment.sceneSourceLayerId = source.id;

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([source, rain]))).toEqual({ ok: true });

    rain.environment.mode = "overlay";
    const invalidMode = await validateDocument(await loadSchema("motion"), motionWithLayers([source, rain]));
    expect(invalidMode).toEqual({
      ok: false,
      errors: [{
        path: "/layers/1/environment/sceneSourceLayerId",
        message: "requires environment.mode scene"
      }]
    });
  });

  it("rejects lossy, late, or transformed scene-texture bindings", async () => {
    const source: MotionLayer = {
      id: "footage",
      type: "image",
      source: "assets/scene.png",
      fit: "cover",
      startMs: 500,
      durationMs: 1000,
      transform: { x: 12, y: 0, width: 308, height: 180 }
    };
    const rain = validRainLayer();
    if (rain.environment?.kind !== "rain") throw new Error("Expected rain environment.");
    rain.environment.sceneSourceLayerId = source.id;

    const result = await validateDocument(await loadSchema("motion"), motionWithLayers([rain, source]));

    expect(result).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        { path: "/layers/0/environment/sceneSourceLayerId", message: "must reference an earlier image layer" },
        { path: "/layers/0/environment/sceneSourceLayerId", message: "source layer timing must cover the complete environment layer" },
        { path: "/layers/0/environment/sceneSourceLayerId", message: "source image must use fit fill for exact texture mapping" },
        { path: "/layers/0/environment/sceneSourceLayerId", message: "source image must use an identity full-document transform" }
      ])
    });
  });

  it("accepts a hidden full-frame image as a deterministic environment effect mask", async () => {
    const scene: MotionLayer = {
      id: "footage",
      type: "image",
      source: "assets/scene.png",
      fit: "fill",
      startMs: 0,
      durationMs: 3000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 }
    };
    const mask: MotionLayer = {
      id: "effect-mask",
      type: "image",
      source: "assets/mask.png",
      fit: "fill",
      opacity: 0,
      startMs: 0,
      durationMs: 3000,
      transform: { x: 0, y: 0, width: 320, height: 180, scale: 1, rotation: 0 }
    };
    const rain = validRainLayer();
    if (rain.environment?.kind !== "rain") throw new Error("Expected rain environment.");
    rain.environment.sceneSourceLayerId = scene.id;
    rain.environment.effectMaskLayerId = mask.id;

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([scene, mask, rain]))).toEqual({ ok: true });

    mask.opacity = 1;
    const visibleMask = await validateDocument(await loadSchema("motion"), motionWithLayers([scene, mask, rain]));
    expect(visibleMask).toEqual({
      ok: false,
      errors: [{
        path: "/layers/2/environment/effectMaskLayerId",
        message: "mask image must use effective opacity 0 so it is sampled but not composited"
      }]
    });
  });

  it("rejects executable or unbounded rain configuration", async () => {
    const layer = validRainLayer();
    (layer as unknown as { environment: Record<string, unknown>; shader: unknown }).environment = {
      schema: "environment@latest",
      kind: "script",
      seed: -1,
      quality: "ultra",
      mode: "remote",
      intensity: 2,
      wind: 3,
      dropSpeed: 0,
      dropLength: 3,
      depthLayers: 99,
      color: "white",
      backgroundColor: "transparent",
      lightColor: "#ffffff",
      accentColor: "#ffffff",
      ground: {
        horizon: 1,
        wetness: -1,
        roughness: 2,
        rippleAmount: 2,
        splashAmount: 2,
        reflectionStrength: 2
      },
      atmosphere: { mist: 2, lensDroplets: -1 },
      code: "fetch('https://example.test')"
    };
    (layer as unknown as { shader: unknown }).shader = { source: "hostile" };

    const result = await validateDocument(await loadSchema("motion"), motionWithLayers([layer]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      { path: "/layers/0/environment/schema", message: "must be shellx-motion/environment@1" },
      { path: "/layers/0/environment/kind", message: "must be rain, water, snow, fog" },
      { path: "/layers/0/environment/seed", message: "must be an unsigned 32-bit integer" },
      { path: "/layers/0/environment/quality", message: "must be preview, balanced, cinematic" },
      { path: "/layers/0/environment/mode", message: "must be scene or overlay" },
      { path: "/layers/0/environment/code", message: "executable or external source fields are not supported" },
      { path: "/layers/0/shader", message: "is not supported on environment layers" }
    ]));
  });

  it("caps environment surfaces per composition", async () => {
    const result = await validateDocument(
      await loadSchema("motion"),
      motionWithLayers(Array.from({ length: 5 }, (_value, index) => validRainLayer(`rain-${index}`)))
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({ path: "/layers/4/type", message: "at most 4 environment layers are supported" });
  });

  it("validates and resolves bounded rain animation controls", async () => {
    const layer = validRainLayer();
    layer.keyframes = {
      "environment.intensity": [{ atMs: 0, value: 0.2 }, { atMs: 1000, value: 0.8, easing: "linear" }],
      "environment.ground.wetness": [{ atMs: 0, value: 0.4 }, { atMs: 1000, value: 1, easing: "linear" }]
    };

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([layer]))).toEqual({ ok: true });
    const resolved = effectiveLayerAtMs(layer, 500);
    expect(resolved.environment?.kind).toBe("rain");
    if (resolved.environment?.kind !== "rain") throw new Error("Expected resolved rain environment.");
    expect(resolved.environment.intensity).toBeCloseTo(0.5, 5);
    expect(resolved.environment.ground.wetness).toBeCloseTo(0.7, 5);

    layer.keyframes["environment.intensity"] = [{ atMs: 0, value: 2 }];
    const invalid = await validateDocument(await loadSchema("motion"), motionWithLayers([layer]));
    expect(invalid).toEqual({
      ok: false,
      errors: [{ path: "/layers/0/keyframes/environment.intensity/0/value", message: "must be between 0 and 1" }]
    });
  });

  it("accepts deterministic water surfaces", async () => {
    const layer: MotionLayer = {
      id: "water",
      type: "environment",
      startMs: 0,
      durationMs: 3000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      environment: validWaterEnvironment(),
      keyframes: {
        "environment.surface.waveHeight": [{ atMs: 0, value: 0.2 }, { atMs: 1000, value: 0.7, easing: "linear" }],
        "environment.optics.caustics": [{ atMs: 0, value: 0.3 }, { atMs: 1000, value: 0.9, easing: "linear" }]
      }
    };

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([layer]))).toEqual({ ok: true });
    expect(requiredLayerFeatures(layer)).toContain("environment.water.fixed-simulation");
    const resolved = effectiveLayerAtMs(layer, 500);
    expect(resolved.environment?.kind).toBe("water");
    if (resolved.environment?.kind !== "water") throw new Error("Expected resolved water environment.");
    expect(resolved.environment.surface.waveHeight).toBeCloseTo(0.45, 5);
    expect(resolved.environment.optics.caustics).toBeCloseTo(0.6, 5);
  });

  it("rejects unbounded water geometry and optics", async () => {
    const environment = validWaterEnvironment();
    environment.surface.waveOctaves = 5;
    environment.surface.waveScale = 0;
    environment.optics.reflectionStrength = 2;
    const layer: MotionLayer = { id: "water", type: "environment", startMs: 0, durationMs: 1000, environment };

    const result = await validateDocument(await loadSchema("motion"), motionWithLayers([layer]));

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/environment/surface/waveScale", message: "must be a finite number between 0.1 and 20" },
        { path: "/layers/0/environment/surface/waveOctaves", message: "must be an integer between 1 and 4" },
        { path: "/layers/0/environment/optics/reflectionStrength", message: "must be a finite number between 0 and 1" }
      ]
    });

    layer.keyframes = { "environment.intensity": [{ atMs: 0, value: 0.5 }] };
    const wrongKind = await validateDocument(await loadSchema("motion"), motionWithLayers([layer]));
    expect(wrongKind).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/environment/surface/waveScale", message: "must be a finite number between 0.1 and 20" },
        { path: "/layers/0/environment/surface/waveOctaves", message: "must be an integer between 1 and 4" },
        { path: "/layers/0/environment/optics/reflectionStrength", message: "must be a finite number between 0 and 1" },
        { path: "/layers/0/keyframes/environment.intensity", message: "requires a rain environment" }
      ]
    });
  });

  it("accepts deterministic layered snow and resolves visible weather controls", async () => {
    const layer: MotionLayer = {
      id: "snow",
      type: "environment",
      startMs: 0,
      durationMs: 3000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      environment: validSnowEnvironment(),
      keyframes: {
        "environment.fall.intensity": [{ atMs: 0, value: 0.2 }, { atMs: 1000, value: 0.8, easing: "linear" }],
        "environment.ground.accumulation": [{ atMs: 0, value: 0.3 }, { atMs: 1000, value: 0.9, easing: "linear" }],
        "environment.atmosphere.haze": [{ atMs: 0, value: 0.1 }, { atMs: 1000, value: 0.5, easing: "linear" }]
      }
    };

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([layer]))).toEqual({ ok: true });
    expect(requiredLayerFeatures(layer)).toContain("environment.snow.fixed-simulation");
    const resolved = effectiveLayerAtMs(layer, 500);
    expect(resolved.environment?.kind).toBe("snow");
    if (resolved.environment?.kind !== "snow") throw new Error("Expected resolved snow environment.");
    expect(resolved.environment.fall.intensity).toBeCloseTo(0.5, 5);
    expect(resolved.environment.ground.accumulation).toBeCloseTo(0.6, 5);
    expect(resolved.environment.atmosphere.haze).toBeCloseTo(0.3, 5);
  });

  it("rejects unbounded snow depth, fall, ground, and atmosphere controls", async () => {
    const environment = validSnowEnvironment();
    environment.fall.depthLayers = 5;
    environment.fall.flakeSize = 4;
    environment.ground.horizon = 0;
    environment.atmosphere.depthFade = 2;
    const layer: MotionLayer = { id: "snow", type: "environment", startMs: 0, durationMs: 1000, environment };

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([layer]))).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/environment/fall/flakeSize", message: "must be a finite number between 0.1 and 3" },
        { path: "/layers/0/environment/fall/depthLayers", message: "must be an integer between 1 and 4" },
        { path: "/layers/0/environment/ground/horizon", message: "must be a finite number between 0.1 and 0.9" },
        { path: "/layers/0/environment/atmosphere/depthFade", message: "must be a finite number between 0 and 1" }
      ]
    });
  });

  it("validates and interpolates bounded volumetric fog", async () => {
    const layer: MotionLayer = {
      id: "fog",
      type: "environment",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      environment: validFogEnvironment(),
      keyframes: {
        "environment.fog.density": [{ atMs: 0, value: 0.2 }, { atMs: 1000, value: 0.8, easing: "linear" }],
        "environment.fog.lightStrength": [{ atMs: 0, value: 0.1 }, { atMs: 1000, value: 0.7, easing: "linear" }]
      }
    };

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([layer]))).toEqual({ ok: true });
    expect(requiredLayerFeatures(layer)).toContain("environment.fog.fixed-simulation");
    const resolved = effectiveLayerAtMs(layer, 500);
    expect(resolved.environment?.kind).toBe("fog");
    if (resolved.environment?.kind !== "fog") throw new Error("Expected resolved fog environment.");
    expect(resolved.environment.fog.density).toBeCloseTo(0.5, 5);
    expect(resolved.environment.fog.lightStrength).toBeCloseTo(0.4, 5);
  });

  it("rejects unbounded fog volumes", async () => {
    const environment = validFogEnvironment();
    environment.fog.depthLayers = 5;
    environment.fog.speed = 0;
    environment.fog.scale = 20;
    const layer: MotionLayer = { id: "fog", type: "environment", startMs: 0, durationMs: 1000, environment };

    expect(await validateDocument(await loadSchema("motion"), motionWithLayers([layer]))).toEqual({
      ok: false,
      errors: [
        { path: "/layers/0/environment/fog/speed", message: "must be a finite number between 0.01 and 3" },
        { path: "/layers/0/environment/fog/scale", message: "must be a finite number between 0.1 and 12" },
        { path: "/layers/0/environment/fog/depthLayers", message: "must be an integer between 1 and 4" }
      ]
    });
  });
});

export function validRainEnvironment(): MotionRainEnvironment {
  return {
    schema: "shellx-motion/environment@1",
    kind: "rain",
    seed: 20260713,
    quality: "cinematic",
    mode: "scene",
    intensity: 0.82,
    wind: 0.18,
    dropSpeed: 1.35,
    dropLength: 1.1,
    depthLayers: 4,
    color: "#BDEBFF",
    backgroundColor: "#050A12",
    lightColor: "#7DD3FC",
    accentColor: "#FB7185",
    ground: {
      horizon: 0.43,
      wetness: 0.92,
      roughness: 0.24,
      rippleAmount: 0.78,
      splashAmount: 0.64,
      reflectionStrength: 0.88
    },
    atmosphere: { mist: 0.44, lensDroplets: 0.34 }
  };
}

export function validWaterEnvironment(): MotionWaterEnvironment {
  return {
    schema: "shellx-motion/environment@1",
    kind: "water",
    seed: 20260714,
    quality: "cinematic",
    mode: "scene",
    backgroundColor: "#07111F",
    shallowColor: "#16B8C8",
    deepColor: "#03294A",
    reflectionColor: "#BDEBFF",
    foamColor: "#ECFEFF",
    surface: {
      horizon: 0.58,
      waveScale: 4.6,
      waveHeight: 0.48,
      waveSpeed: 0.72,
      direction: 18,
      choppiness: 0.42,
      waveOctaves: 4
    },
    optics: {
      reflectionStrength: 0.78,
      refractionStrength: 0.66,
      fresnel: 0.72,
      caustics: 0.58,
      clarity: 0.7,
      foam: 0.26
    }
  };
}

export function validSnowEnvironment(): MotionSnowEnvironment {
  return {
    schema: "shellx-motion/environment@1",
    kind: "snow",
    seed: 20260715,
    quality: "cinematic",
    mode: "scene",
    backgroundColor: "#07111F",
    snowColor: "#F8FCFF",
    shadowColor: "#8BA7C1",
    lightColor: "#C7E7FF",
    fall: {
      intensity: 0.72,
      speed: 0.68,
      wind: 0.22,
      turbulence: 0.48,
      flakeSize: 1.15,
      depthLayers: 4,
      focusFalloff: 0.62
    },
    ground: { horizon: 0.63, accumulation: 0.7, drift: 0.52, contactAmount: 0.46 },
    atmosphere: { haze: 0.3, depthFade: 0.58 }
  };
}

export function validFogEnvironment(): MotionFogEnvironment {
  return {
    schema: "shellx-motion/environment@1",
    kind: "fog",
    seed: 20260717,
    quality: "cinematic",
    mode: "scene",
    backgroundColor: "#07111F",
    fogColor: "#B8CEDA",
    lightColor: "#DDF7FF",
    fog: {
      density: 0.62,
      speed: 0.34,
      scale: 4.8,
      turbulence: 0.58,
      height: 0.74,
      depthLayers: 4,
      lightStrength: 0.46
    }
  };
}

function validRainLayer(id = "rain"): MotionLayer {
  return {
    id,
    type: "environment",
    startMs: 0,
    durationMs: 3000,
    transform: { x: 0, y: 0, width: 320, height: 180 },
    environment: validRainEnvironment()
  };
}

function motionWithLayers(layers: MotionLayer[]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "environment_motion",
    name: "Environment",
    durationMs: 3000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#050A12",
    layers,
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" }
  };
}
