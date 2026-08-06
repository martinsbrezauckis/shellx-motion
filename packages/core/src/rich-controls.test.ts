import { describe, expect, it } from "vitest";
import { setTimelineLayerRichControl } from "./rich-controls";
import { validateScene3DLayers } from "./scene-3d-validate";
import type { MotionDocument } from "./types";

describe("rich Motion controls", () => {
  it("edits every supported rich family without mutating the source document", () => {
    const motion = richMotion();
    const shader = setTimelineLayerRichControl(motion, { layerId: "shader", path: "shader.uniforms.u_speed", value: 1.25 });
    expect(shader.layer.shader?.uniforms?.u_speed).toBe(1.25);
    expect(motion.layers[0].shader?.uniforms?.u_speed).toBe(0.5);
    expect(shader.changedPaths).toEqual(["/layers/shader/shader/uniforms/u_speed"]);

    const particles = setTimelineLayerRichControl(motion, { layerId: "particles", path: "emitter.count", value: 320 });
    expect(particles.layer.emitter?.count).toBe(320);

    const scene = setTimelineLayerRichControl(motion, { layerId: "stage", path: "scene3d.objects.hero.rotationDeg.y", value: 45 });
    expect(scene.layer.scene3d?.objects[0].rotationDeg).toEqual([0, 45, 0]);

    const depth = setTimelineLayerRichControl(motion, { layerId: "depth", path: "depth", value: 0.75 });
    expect(depth.layer.depth).toBe(0.75);

    const blur = setTimelineLayerRichControl(motion, { layerId: "depth", path: "effects.motionBlur.shutterAngle", value: 270 });
    expect(blur.layer.effects?.motionBlur?.shutterAngle).toBe(270);

    const film = setTimelineLayerRichControl(motion, { layerId: "film", path: "effects.filmGrain.seed", value: 9001 });
    expect(film.layer.effects?.filmGrain?.seed).toBe(9001);

    const rain = setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.ground.wetness", value: 0.96 });
    expect(rain.layer.environment?.kind).toBe("rain");
    if (rain.layer.environment?.kind !== "rain") throw new Error("Expected edited rain environment.");
    expect(rain.layer.environment.ground.wetness).toBe(0.96);
    const rainQuality = setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.quality", value: "preview" });
    expect(rainQuality.layer.environment?.quality).toBe("preview");
    const rainScene = setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.sceneSourceLayerId", value: "alternate-footage" });
    expect(rainScene.layer.environment?.sceneSourceLayerId).toBe("alternate-footage");
    const rainMask = setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.effectMaskLayerId", value: "alternate-mask" });
    expect(rainMask.layer.environment?.effectMaskLayerId).toBe("alternate-mask");

    const water = setTimelineLayerRichControl(motion, { layerId: "water", path: "environment.optics.caustics", value: 0.88 });
    expect(water.layer.environment?.kind).toBe("water");
    if (water.layer.environment?.kind !== "water") throw new Error("Expected edited water environment.");
    expect(water.layer.environment.optics.caustics).toBe(0.88);

    const snow = setTimelineLayerRichControl(motion, { layerId: "snow", path: "environment.fall.turbulence", value: 0.74 });
    expect(snow.layer.environment?.kind).toBe("snow");
    if (snow.layer.environment?.kind !== "snow") throw new Error("Expected edited snow environment.");
    expect(snow.layer.environment.fall.turbulence).toBe(0.74);
    const snowDepth = setTimelineLayerRichControl(motion, { layerId: "snow", path: "environment.fall.depthLayers", value: 3 });
    expect(snowDepth.layer.environment?.kind === "snow" && snowDepth.layer.environment.fall.depthLayers).toBe(3);

    const fog = setTimelineLayerRichControl(motion, { layerId: "fog", path: "environment.fog.density", value: 0.86 });
    expect(fog.layer.environment?.kind === "fog" && fog.layer.environment.fog.density).toBe(0.86);
    const fogDepth = setTimelineLayerRichControl(motion, { layerId: "fog", path: "environment.fog.depthLayers", value: 3 });
    expect(fogDepth.layer.environment?.kind === "fog" && fogDepth.layer.environment.fog.depthLayers).toBe(3);
  });

  it("rejects generic traversal, undeclared values, type confusion, and locked edits", () => {
    const motion = richMotion();
    expect(() => setTimelineLayerRichControl(motion, { layerId: "shader", path: "shader.fragmentAssetId", value: "other" })).toThrow("Unsupported rich control path");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "shader", path: "shader.uniforms.u_missing", value: 1 })).toThrow("not declared");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "particles", path: "emitter.count", value: 2.5 })).toThrow("must be an integer");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "stage", path: "scene3d.objects.hero.color", value: "url(https://evil.example)" })).toThrow("must be a hex color");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "depth", path: "effects.motionBlur.samples", value: 9 })).toThrow("must be between 2 and 8");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.ground.horizon", value: 1 })).toThrow("must be between 0.15 and 0.9");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.fall.turbulence", value: 0.5 })).toThrow("requires a snow environment");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.fog.density", value: 0.5 })).toThrow("requires a fog environment");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.sceneSourceLayerId", value: "../unsafe" })).toThrow("must be a safe layer id");
    expect(() => setTimelineLayerRichControl(motion, { layerId: "rain", path: "environment.effectMaskLayerId", value: "../unsafe" })).toThrow("must be a safe layer id");
    expect(() => setTimelineLayerRichControl({ ...motion, layers: motion.layers.map((layer) => layer.id === "rain" ? { ...layer, type: "shape" } : layer) }, { layerId: "rain", path: "environment.intensity", value: 0.5 })).toThrow("requires an environment layer");
    expect(() => setTimelineLayerRichControl({ ...motion, layers: motion.layers.map((layer) => layer.id === "shader" ? { ...layer, locked: true } : layer) }, { layerId: "shader", path: "shader.seed", value: 2 })).toThrow("Cannot edit locked layer");
  });

  it("accepts canonical scene3d control boundaries", () => {
    const boundaries: Array<[string, number]> = [
      ["scene3d.camera.fovDeg", 120],
      ["scene3d.camera.near", 0.01],
      ["scene3d.camera.far", 10_000],
      ["scene3d.camera.orbitDegPerSecond", -720],
      ["scene3d.camera.position.x", 1_000],
      ["scene3d.lighting.direction.x", -1],
      ["scene3d.lighting.intensity", 4],
      ["scene3d.objects.hero.scale", 100],
      ["scene3d.objects.hero.rotationDeg.x", -36_000],
      ["scene3d.objects.hero.spinDegPerSecond.z", 720],
      ["scene3d.objects.hero.emissive", 1],
    ];
    for (const [path, value] of boundaries) {
      const result = setTimelineLayerRichControl(richMotion(), { layerId: "stage", path, value });
      const errors: Array<{ path: string; message: string }> = [];
      validateScene3DLayers([result.layer], errors);
      expect(errors, path).toEqual([]);
    }
  });

  it("refuses scene3d values and relationships outside canonical validation", () => {
    const outside: Array<[string, number]> = [
      ["scene3d.camera.fovDeg", 120.001],
      ["scene3d.camera.near", 0.009],
      ["scene3d.camera.far", 10_000.001],
      ["scene3d.camera.orbitDegPerSecond", 720.001],
      ["scene3d.camera.position.x", 1_000.001],
      ["scene3d.lighting.direction.x", 1.001],
      ["scene3d.lighting.intensity", 4.001],
      ["scene3d.objects.hero.scale", 100.001],
      ["scene3d.objects.hero.rotationDeg.x", 36_000.001],
      ["scene3d.objects.hero.spinDegPerSecond.z", 720.001],
      ["scene3d.objects.hero.emissive", 1.001],
    ];
    for (const [path, value] of outside) {
      expect(() => setTimelineLayerRichControl(richMotion(), { layerId: "stage", path, value }), path).toThrow("must be between");
    }

    expect(() => setTimelineLayerRichControl(richMotion(), {
      layerId: "stage", path: "scene3d.camera.far", value: 0.1,
    })).toThrow(/canonical scene3d contract.*far.*greater than near/);
    expect(() => setTimelineLayerRichControl(richMotion(), {
      layerId: "stage", path: "scene3d.camera.position.z", value: 0,
    })).toThrow(/canonical scene3d contract.*non-vertical view/);

    const zeroLight = richMotion();
    const scene = zeroLight.layers.find((layer) => layer.id === "stage")?.scene3d;
    if (!scene) throw new Error("Expected scene3d fixture.");
    scene.lighting.direction = [0, 0, 1];
    expect(() => setTimelineLayerRichControl(zeroLight, {
      layerId: "stage", path: "scene3d.lighting.direction.z", value: 0,
    })).toThrow(/canonical scene3d contract.*must not be the zero vector/);
  });
});

function richMotion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "motion-rich", name: "Rich", durationMs: 2000, fps: 30, width: 1920, height: 1080,
    provenance: { sourceApp: "test", createdBy: "test" }, assets: [], layers: [{
      id: "shader", type: "shader", startMs: 0, durationMs: 2000,
      shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "plasma", seed: 1, fallbackColor: "#000000", uniforms: { u_speed: 0.5 } }
    }, {
      id: "particles", type: "particles", startMs: 0, durationMs: 2000,
      emitter: { seed: 1, count: 120, lifetimeMs: 1000, shape: "circle", color: "#FFFFFF", minSize: 2, maxSize: 8, minSpeed: 20, maxSpeed: 80, direction: -90, spread: 45, gravity: 100, fadeOut: true }
    }, {
      id: "stage", type: "scene3d", startMs: 0, durationMs: 2000,
      scene3d: {
        schema: "shellx-motion/scene3d@1", backgroundColor: "#020617",
        camera: { position: [0, 1, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 1_000, orbitDegPerSecond: 20 },
        lighting: { ambient: 0.25, direction: [1, -1, -1], intensity: 1.4, color: "#FFFFFF" },
        objects: [{ id: "hero", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 20, 0], spinDegPerSecond: [0, 0, 20], scale: 1.2, color: "#7C3AED", emissive: 0.2 }]
      }
    }, {
      id: "depth", type: "shape", startMs: 0, durationMs: 2000, depth: 0.2,
      effects: { motionBlur: { samples: 8, shutterAngle: 180 } }
    }, {
      id: "film", type: "adjustment", startMs: 0, durationMs: 2000,
      effects: { vignette: { amount: 0.3, softness: 0.7, color: "#000000" }, filmGrain: { amount: 0.2, size: 2, seed: 42 } }
    }, {
      id: "rain", type: "environment", startMs: 0, durationMs: 2000,
      environment: {
        schema: "shellx-motion/environment@1", kind: "rain", seed: 7, quality: "cinematic", mode: "scene", sceneSourceLayerId: "footage", effectMaskLayerId: "mask",
        intensity: 0.8, wind: 0.1, dropSpeed: 1.4, dropLength: 1.1, depthLayers: 4,
        color: "#C8F1FF", backgroundColor: "#050A12", lightColor: "#67E8F9", accentColor: "#FB7185",
        ground: { horizon: 0.43, wetness: 0.9, roughness: 0.2, rippleAmount: 0.8, splashAmount: 0.6, reflectionStrength: 0.9 },
        atmosphere: { mist: 0.4, lensDroplets: 0.3 }
      }
    }, {
      id: "water", type: "environment", startMs: 0, durationMs: 2000,
      environment: {
        schema: "shellx-motion/environment@1", kind: "water", seed: 8, quality: "cinematic", mode: "scene",
        backgroundColor: "#07111F", shallowColor: "#16B8C8", deepColor: "#03294A", reflectionColor: "#BDEBFF", foamColor: "#ECFEFF",
        surface: { horizon: 0.58, waveScale: 4.6, waveHeight: 0.48, waveSpeed: 0.72, direction: 18, choppiness: 0.42, waveOctaves: 4 },
        optics: { reflectionStrength: 0.78, refractionStrength: 0.66, fresnel: 0.72, caustics: 0.58, clarity: 0.7, foam: 0.26 }
      }
    }, {
      id: "snow", type: "environment", startMs: 0, durationMs: 2000,
      environment: {
        schema: "shellx-motion/environment@1", kind: "snow", seed: 9, quality: "cinematic", mode: "scene",
        backgroundColor: "#07111F", snowColor: "#F8FCFF", shadowColor: "#8BA7C1", lightColor: "#C7E7FF",
        fall: { intensity: 0.72, speed: 0.68, wind: 0.22, turbulence: 0.48, flakeSize: 1.15, depthLayers: 4, focusFalloff: 0.62 },
        ground: { horizon: 0.63, accumulation: 0.7, drift: 0.52, contactAmount: 0.46 },
        atmosphere: { haze: 0.3, depthFade: 0.58 }
      }
    }, {
      id: "fog", type: "environment", startMs: 0, durationMs: 2000,
      environment: {
        schema: "shellx-motion/environment@1", kind: "fog", seed: 10, quality: "cinematic", mode: "scene",
        backgroundColor: "#07111F", fogColor: "#B8CEDA", lightColor: "#DDF7FF",
        fog: { density: 0.62, speed: 0.34, scale: 4.8, turbulence: 0.58, height: 0.74, depthLayers: 4, lightStrength: 0.46 }
      }
    }]
  };
}
