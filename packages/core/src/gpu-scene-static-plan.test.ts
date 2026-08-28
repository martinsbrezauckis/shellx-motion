import { describe, expect, it } from "vitest";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { MotionDocument } from "./types";

function admitted(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "static-gpu", name: "Static GPU", durationMs: 1_000, fps: 30, width: 160, height: 90, background: "#102030", assets: [{ id: "brand", type: "font", family: "Brand", source: { path: "assets/brand.woff2", mimeType: "font/woff2" } }], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "camera", type: "camera", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, scale: 1 } },
      { id: "pack", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["panel", "stars"] },
      { id: "panel", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { width: 40, height: 30 }, keyframes: { "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 30 }] } },
      { id: "stars", type: "points", startMs: 0, durationMs: 1_000, pointCloud: { points: [{ x: 1, y: 2, size: 2, opacity: 1 }, { x: 3, y: 4, size: 2, opacity: 1 }] } },
      { id: "sparks", type: "particles", startMs: 100, durationMs: 800, emitter: { seed: 1, count: 3, lifetimeMs: 800, color: "#ffffff" } },
      { id: "plate", type: "image", assetRef: "/not-opened/plate.png", startMs: 0, durationMs: 1_000, transform: { width: 160, height: 90 } },
      { id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 },
      { id: "title", type: "text", text: "GPU", startMs: 0, durationMs: 1_000, style: { fontFamily: "Brand", width: 100, height: 30 } },
      { id: "caption", type: "caption", text: "Caption", startMs: 0, durationMs: 1_000, style: { fontFamily: "Brand", width: 100, height: 30 } },
      { id: "finish", type: "adjustment", startMs: 0, durationMs: 1_000, effects: { vignette: { amount: 0.2, softness: 0.4, color: "#000000" } } },
      { id: "world", type: "scene3d", startMs: 0, durationMs: 1_000, scene3d: { schema: "shellx-motion/scene3d@1", backgroundColor: "#000000", camera: { position: [0, 1, 5], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 }, lighting: { ambient: 0.2, direction: [0, -1, -1], intensity: 1, color: "#ffffff" }, objects: [{ id: "floor", primitive: "plane", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#ffffff" }] } },
      { id: "fog", type: "environment", startMs: 0, durationMs: 1_000, environment: { schema: "shellx-motion/environment@1", kind: "fog", seed: 2, quality: "balanced", mode: "overlay", sceneSourceLayerId: "plate", backgroundColor: "#000000", fogColor: "#ffffff", lightColor: "#ffffff", fog: { density: 0.2, speed: 1, scale: 1, turbulence: 0.2, height: 0.5, depthLayers: 2, lightStrength: 0.5 } } },
      { id: "material", type: "shader", startMs: 0, durationMs: 1_000, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "legacy", seed: 7, fallbackColor: "#000000", gpuMaterial: { preset: "plasma", colors: ["#000000", "#00ffff", "#ffffff"] } } }
    ]
  };
}

describe("compileGpuSceneStaticPlan", () => {
  it("derives frozen topology, all admitted resource kinds, fixed material, and bounded maxima without opening asset paths", () => {
    const result = compileGpuSceneStaticPlan(admitted());
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan).toMatchObject({ canonicalFrameCount: 30, maxima: { maxGroupCount: 1, maxPointCount: 5, maxImageCount: 1, maxVideoCount: 1, maxTextCount: 2, maxAdjustmentCount: 1, maxScene3dCount: 1, maxScene3dObjectCount: 1, maxEnvironmentCount: 1, maxMaterialCount: 1 } });
    expect(result.plan.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "image", assetRef: "/not-opened/plate.png", consumers: expect.arrayContaining([expect.objectContaining({ role: "texture" }), expect.objectContaining({ role: "environment-scene" })]) }),
      expect.objectContaining({ kind: "video", assetRef: "assets/clip.mp4" }),
      expect.objectContaining({ kind: "font", assetRef: "assets/brand.woff2", family: "Brand" })
    ]));
    expect(result.plan.layers.find((layer) => layer.id === "panel")).toMatchObject({ keyframeTargets: ["transform.x"], geometry: { reuse: "not-claimed", keyframed: true } });
    expect(result.plan.layers.find((layer) => layer.id === "material")).toMatchObject({ type: "shader", geometry: { reuse: "not-claimed" } });
    // This fixture's title is ordinary legacy `text`, not text-runs@1. Its
    // static identity must not acquire a styled-runs field or drift.
    expect(result.plan.fingerprint).toBe("4d6277f8318620e7432d0649a6d9faed14abec23e8cc65cf39949ffa0115d0ec");
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.resources)).toBe(true);
  });

  it("is deterministic across object key order", () => {
    const left = admitted(); const right = reorder(left) as MotionDocument;
    const first = compileGpuSceneStaticPlan(left); const second = compileGpuSceneStaticPlan(right);
    expect(first).toMatchObject({ ok: true }); expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) return;
    expect(second.plan).toEqual(first.plan);
    expect(second.plan.fingerprint).toBe(first.plan.fingerprint);
  });

  it("admits fixed-topology gradient colors without allocating a second static resource shape", () => {
    const staticGradient = admitted();
    staticGradient.layers = [{
      id: "gradient", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000,
      transform: { width: 100, height: 50 },
      gradient: { type: "linear", angle: 45, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] },
    }];
    const animatedGradient = structuredClone(staticGradient);
    animatedGradient.layers[0].gradient!.colorKeyframes = {
      schema: "shellx-motion/gradient-color-keyframes@1",
      keyframes: [{ atUs: 0, colors: ["#ff0000", "#0000ff"] }, { atUs: 1_000, colors: ["#0000ff", "#ff0000"] }],
    };
    const staticPlan = compileGpuSceneStaticPlan(staticGradient);
    const animatedPlan = compileGpuSceneStaticPlan(animatedGradient);
    expect(staticPlan).toMatchObject({ ok: true });
    expect(animatedPlan).toMatchObject({ ok: true });
    if (!staticPlan.ok || !animatedPlan.ok) return;
    expect(animatedPlan.plan.resources).toEqual(staticPlan.plan.resources);
    expect(animatedPlan.plan.maxima).toEqual(staticPlan.plan.maxima);
    expect(animatedPlan.plan.layers[0]).toMatchObject({ keyframeTargets: ["gradient.colorKeyframes"], geometry: { keyframed: true } });
    expect(animatedPlan.plan.fingerprint).not.toBe(staticPlan.plan.fingerprint);
  });

  it("refuses malformed gradient color snapshots before static resource collection", () => {
    const motion = admitted();
    motion.layers = [{
      id: "gradient", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000,
      transform: { width: 100, height: 50 },
      gradient: {
        type: "linear", stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }],
        colorKeyframes: { schema: "shellx-motion/gradient-color-keyframes@1", keyframes: [{ atUs: 0, colors: ["#ff0000"] }] },
      },
    }];
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "gradient", message: expect.stringContaining("invalid gradient color keyframes") } });
  });

  it("refuses a late non-deterministic browser source before resource staging", () => {
    const motion = admitted(); motion.layers.push({ id: "late-web", type: "web", startMs: 900, durationMs: 100, source: "https://example.invalid" });
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "late-web", message: expect.stringContaining("package-relative HTML") } });
  });

  it("admits one package HTML surface as explicit hybrid topology and refuses a second producer", () => {
    const motion = admitted();
    motion.layers.push({ id: "browser-surface", type: "web", startMs: 0, durationMs: 1_000, source: "surfaces/card.html", transform: { width: 160, height: 90 } });
    const hybrid = compileGpuSceneStaticPlan(motion);
    expect(hybrid).toMatchObject({ ok: true }); if (!hybrid.ok) return;
    expect(hybrid.plan.resources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "browser-surface", assetRef: "surfaces/card.html", consumers: [{ layerId: "browser-surface", role: "governed-browser-surface" }] })]));
    expect(hybrid.plan.maxima.maxBrowserSurfaceCount).toBe(1);
    motion.layers.unshift({ id: "hidden-browser-source", type: "html", visible: false, startMs: 0, durationMs: 1_000, source: "surfaces/hidden.html" });
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", layerId: "browser-surface", message: expect.stringContaining("first browser surface") } });
    motion.layers.shift();
    motion.layers.push({ id: "second-browser-surface", type: "canvas", startMs: 0, durationMs: 1_000, source: "surfaces/chart.html" });
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", layerId: "second-browser-surface", message: expect.stringContaining("exactly one visible browser surface") } });
  });

  it("refuses an unsupported late keyframe target before runtime starts", () => {
    const motion = admitted(); const panel = motion.layers.find((layer) => layer.id === "panel"); if (!panel) throw new Error("fixture missing panel");
    panel.startMs = 900; panel.durationMs = 100; panel.keyframes = { blendMode: [{ atMs: 0, value: "screen" }] };
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "panel", message: expect.stringContaining("unsupported keyframe") } });
  });

  it("returns a bounded aggregate-point refusal instead of throwing", () => {
    const motion = admitted(); const stars = motion.layers.find((layer) => layer.id === "stars"); if (!stars?.pointCloud) throw new Error("fixture missing stars");
    stars.pointCloud.points = Array.from({ length: 65_537 }, () => ({ x: 1, y: 1, size: 1, opacity: 1 }));
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("65536-point") } });
  });

  it("refuses a concurrent worst-case v1 contour load before frame triangle allocation", () => {
    const motion = admitted(), points = Array.from({ length: 128 }, (_, index) => ({ x: 50 + 45 * Math.cos((index * Math.PI * 2) / 128), y: 50 + 45 * Math.sin((index * Math.PI * 2) / 128) }));
    motion.layers.push(...Array.from({ length: 58 }, (_, index) => ({ id: `v1-${index}`, type: "shape" as const, startMs: 0, durationMs: 1_000, transform: { width: 100, height: 100 }, geometry: { schema: "shellx-motion/shape-geometry@1" as const, kind: "polygon" as const, viewBox: { x: 0, y: 0, width: 100, height: 100 }, points }, style: { fill: "#ffffff", stroke: "#ffffff", strokeWidth: 1, strokeLinecap: "butt", strokeLinejoin: "miter" } })));
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("65535 authored shape triangle") } });
  });

  it("admits only wipe topology with an exact fixed-mask lowering before resource staging", () => {
    const motion = admitted(); const panel = motion.layers.find((layer) => layer.id === "panel"); if (!panel) throw new Error("fixture missing panel");
    panel.transitions = { in: { type: "wipe", durationMs: 300, direction: "left", easing: "ease-out" }, out: { type: "wipe", durationMs: 200, direction: "down", easing: "linear" } };
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: true });

    panel.mask = { type: "rect" };
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "panel", message: expect.stringContaining("single-mask ABI") } });

    delete panel.mask;
    const pack = motion.layers.find((layer) => layer.id === "pack"); if (!pack) throw new Error("fixture missing pack");
    pack.transitions = { in: { type: "wipe", durationMs: 300, direction: "left" } };
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "pack", message: expect.stringContaining("group") } });
  });

  it("admits a typed static triangle as a track-matte source before any resource staging", () => {
    const motion = admitted();
    motion.layers.push(
      { id: "matte-triangle", type: "shape", shape: "triangle", startMs: 0, durationMs: 1_000, transform: { x: 8, y: 8, width: 40, height: 30 }, style: { fill: "#ffffff" } },
      { id: "matte-consumer", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { width: 80, height: 60 }, matte: { type: "alpha", sourceLayerId: "matte-triangle" } }
    );
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: true });
  });
});

function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, child]) => [key, reorder(child)]));
}
