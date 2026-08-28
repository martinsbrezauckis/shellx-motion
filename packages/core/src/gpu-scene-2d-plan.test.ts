import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { evaluateMotionParticles } from "./particle-evaluator";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";
import type { MotionDocument } from "./types";

function scene(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_gpu_scene_2d",
    name: "GPU scene 2D",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 60,
    background: "#102030ff",
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      {
        id: "plate", type: "shape", shape: "rect", fill: "#ff0000", startMs: 0, durationMs: 1_000,
        opacity: 0.5, transform: { x: 10, y: 5, width: 20, height: 10, scale: 2, originX: 0, originY: 0 },
        keyframes: { "transform.x": [{ atMs: 0, value: 10 }, { atMs: 1_000, value: 30 }] }
      },
      { id: "sound", type: "audio", startMs: 0, durationMs: 1_000, assetRef: "score" },
      {
        id: "stars", type: "points", color: "#ffffff", opacity: 0.5, startMs: 0, durationMs: 1_000,
        transform: { x: 2, y: 3, scale: 2, originX: 0, originY: 0 },
        pointCloud: { points: [{ x: 4, y: 5, size: 2, opacity: 0.5 }] }
      },
      {
        id: "orb", type: "shape", shape: "ellipse", fill: "#00ffff80", startMs: 0, durationMs: 1_000,
        transform: { x: 60, y: 10, width: 20, height: 30 }
      }
    ]
  };
}

describe("compileGpuScene2dPlan", () => {
  it("lowers animated rect, ellipse and transformed points in canonical layer order", () => {
    const first = compileGpuScene2dPlan(scene(), 500);
    const second = compileGpuScene2dPlan(JSON.parse(JSON.stringify(scene())), 500);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.plan).toMatchObject({ visualLayerCount: 3, shapeCount: 2, pointCount: 1, particleCount: 0 });
    expect(first.plan.frame.draws.map((draw) => `${draw.kind}:${draw.id}`)).toEqual(["rect:plate", "points:stars", "ellipse:orb"]);
    expect(first.plan.frame.draws[0]).toMatchObject({ x: 20, y: 5, width: 40, height: 20, color: { a: 0.5 } });
    expect(first.plan.frame.draws[1]).toMatchObject({ points: [{ x: 10, y: 13, size: 4, color: { a: 0.25 } }] });
    expect(first.plan.frame.draws[1]).toMatchObject({ instanceBufferMode: "static" });
    expect(first.plan.frame.draws[2]).toMatchObject({ x: 60, y: 10, width: 20, height: 30 });
    expect(first.plan.frame.fingerprint).toBe(second.plan.frame.fingerprint);
  });

  it("uses shared fade and slide transition evaluation", () => {
    const motion = scene();
    motion.layers = [{
      id: "intro", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000,
      transform: { x: 20, y: 0, width: 10, height: 10 },
      transitions: { in: { type: "fade", durationMs: 400 }, out: { type: "slide", durationMs: 400, direction: "right", distance: 40 } }
    }];
    const entering = compileGpuScene2dPlan(motion, 200);
    const leaving = compileGpuScene2dPlan(motion, 800);
    expect(entering).toMatchObject({ ok: true, plan: { frame: { draws: [{ color: { a: 0.5 } }] } } });
    expect(leaving).toMatchObject({ ok: true, plan: { frame: { draws: [{ x: 40 }] } } });
  });

  it("binds animated rotation to authored origins for shapes and points", () => {
    const motion = scene();
    motion.layers[0].transform = { x: 10, y: 5, width: 20, height: 10, originX: 0, originY: 0, rotation: 0 };
    motion.layers[0].keyframes = { "transform.rotation": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 180 }] };
    motion.layers[2].transform = { x: 2, y: 3, scale: 2, originX: 0, originY: 0, rotation: 90 };
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.frame.draws[0]).toMatchObject({ kind: "rect", rotationDeg: 90, pivotX: 10, pivotY: 5 });
    expect(result.plan.frame.draws[1]).toMatchObject({ kind: "points", points: [{ x: -8, y: 11, size: 4 }] });
  });

  it("lowers deterministic circular particle fields through the shared evaluator", () => {
    const motion = scene();
    const emitter = {
      seed: 71, count: 3, lifetimeMs: 2_000, shape: "circle" as const,
      color: "#ff8040", secondaryColor: "#40a0ffff", minSize: 4, maxSize: 8,
      minSpeed: 12, maxSpeed: 30, direction: -70, spread: 40, gravity: 6,
      field: { schema: "shellx-motion/particle-field@1" as const, sources: [{ kind: "vortex" as const, centerX: 0.6, centerY: 0.4, strength: 0.5, softening: 0.2 }] }
    };
    motion.layers = [{
      id: "field-particles", type: "particles", startMs: 0, durationMs: 1_000, emitter, opacity: 0.5,
      transform: { x: 5, y: 7, width: 80, height: 40, scale: 2, originX: 0, originY: 0, rotation: 90 }
    }];
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const samples = evaluateMotionParticles({ emitter, atMs: 500, startMs: 0, width: 80, height: 40 });
    const points = result.plan.frame.draws[0];
    expect(result.plan).toMatchObject({ visualLayerCount: 1, particleCount: 3, pointCount: 3 });
    expect(points).toMatchObject({ kind: "points", id: "field-particles" });
    if (points.kind !== "points") return;
    expect(points.points[0].x).toBeCloseTo(5 - ((samples[0].y * 2) + samples[0].size), 10);
    expect(points.points[0].y).toBeCloseTo(7 + ((samples[0].x * 2) + samples[0].size), 10);
    expect(points.points[0].size).toBeCloseTo(samples[0].size * 2, 10);
    expect(points.points[0].color.a).toBeCloseTo(samples[0].opacity * 0.5, 10);
    expect(points).toMatchObject({ instanceBufferMode: "dynamic" });
  });

  it("replays seeded particles at an exact Core timestamp before WebGPU instanced rasterization", () => {
    const motion = scene();
    motion.layers = [{
      id: "seeded-replay", type: "particles", startMs: 0, durationMs: 1_000,
      emitter: { seed: 4_243, count: 2, lifetimeMs: 2_000, shape: "circle", color: "#80c0ff", minSize: 3, maxSize: 7, minSpeed: 10, maxSpeed: 24, direction: -80, spread: 35, gravity: 4 },
      transform: { width: 80, height: 40 }
    }];
    const first = compileGpuScene2dPlan(motion, 500);
    const replay = compileGpuScene2dPlan(JSON.parse(JSON.stringify(motion)), 500);
    const later = compileGpuScene2dPlan(motion, 600);
    expect(first.ok && replay.ok && later.ok).toBe(true);
    if (!first.ok || !replay.ok || !later.ok) return;
    const [firstDraw] = first.plan.frame.draws;
    const [replayDraw] = replay.plan.frame.draws;
    const [laterDraw] = later.plan.frame.draws;
    expect(firstDraw).toMatchObject({ kind: "points", id: "seeded-replay", instanceBufferMode: "dynamic" });
    expect(replay.plan.frame.fingerprint).toBe(first.plan.frame.fingerprint);
    expect(replayDraw).toEqual(firstDraw);
    if (firstDraw.kind !== "points" || laterDraw.kind !== "points") return;
    expect(laterDraw.seed).toBe(firstDraw.seed);
    expect(laterDraw.points).not.toEqual(firstDraw.points);
  });

  it("lowers square particles to bounded rotated quads with stable identifiers", () => {
    const motion = scene();
    motion.layers = [{
      id: "very-long-square-particle-layer", type: "particles", startMs: 0, durationMs: 1_000,
      emitter: { seed: 9, count: 2, lifetimeMs: 1_000, shape: "square", color: "#ffffff", minSize: 3, maxSize: 3, minSpeed: 0, maxSpeed: 0 },
      transform: { x: 10, y: 20, width: 30, height: 40, originX: 15, originY: 20, rotation: 30 }
    }];
    const result = compileGpuScene2dPlan(motion, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ particleCount: 2, pointCount: 0 });
    expect(result.plan.frame.draws).toHaveLength(2);
    expect(result.plan.frame.draws[0]).toMatchObject({ kind: "rect", width: 3, height: 3, rotationDeg: 30, pivotX: 25, pivotY: 40 });
    expect(result.plan.frame.draws[0].id).toMatch(/^particle-[0-9a-f]{16}-0$/);
    expect(result.plan.frame.draws[1].id).toMatch(/^particle-[0-9a-f]{16}-1$/);
    motion.layers[0].effects = { motionBlur: { samples: 2, shutterAngle: 180 }, glow: { radius: 2, color: "#ffffff80" } };
    const blurred = compileGpuScene2dPlan(motion, 500);
    expect(blurred.ok).toBe(true); if (!blurred.ok) return;
    expect(blurred.plan.frame.draws.map((draw) => draw.kind)).toEqual(["motionBlurStart", "rect", "rect", "rect", "rect", "motionBlurEnd"]);
    expect(blurred.plan.frame.draws[0]).toMatchObject({ kind: "motionBlurStart", sampleCount: 2, drawCount: 4, effects: { glow: { radius: 2 } } });
  });

  it("triangulates triangle and star fills while retaining z-order and rotation", () => {
    const motion = scene();
    motion.layers = [
      { id: "triangle", type: "shape", shape: "triangle", fill: "#ff0000", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 5, width: 20, height: 30 } },
      { id: "star", type: "shape", shape: "star", fill: "#ffff00", startMs: 0, durationMs: 1_000, transform: { x: 40, y: 5, width: 30, height: 30, rotation: 45 } }
    ];
    const result = compileGpuScene2dPlan(motion, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.frame.draws.map((draw) => `${draw.kind}:${draw.id}`)).toEqual(["triangles:triangle", "triangles:star"]);
    const [triangle, star] = result.plan.frame.draws;
    expect(triangle).toMatchObject({ vertices: [{ x: 20, y: 5 }, { x: 10, y: 35 }, { x: 30, y: 35 }], rotationDeg: 0, pivotX: 20, pivotY: 20 });
    expect(star).toMatchObject({ rotationDeg: 45, pivotX: 55, pivotY: 20 });
    if (star.kind !== "triangles") return;
    expect(star.vertices).toHaveLength(30);
    expect(result.plan.frame.budget).toMatchObject({ triangleVertexCount: 33, triangleBufferBytes: 792 });
  });

  it("lowers prepared image resources with cover UV cropping and animation", () => {
    const motion = scene();
    motion.layers = [{ id: "hero", type: "image", assetRef: "assets/hero.png", startMs: 0, durationMs: 1_000, opacity: 0.75, fit: "cover", transform: { x: 10, y: 5, width: 100, height: 100, rotation: 15 } }];
    const images = new Map([["assets/hero.png", { resourceId: "image-hero", assetRef: "assets/hero.png", width: 200, height: 100, sha256: "a".repeat(64) }]]);
    const result = compileGpuScene2dPlan(motion, 0, { images });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ visualLayerCount: 1, imageCount: 1 });
    expect(result.plan.frame.draws[0]).toMatchObject({
      kind: "image", id: "hero", resourceId: "image-hero", x: 10, y: 5, width: 100, height: 100,
      rotationDeg: 15, pivotX: 60, pivotY: 55, u0: 0.25, v0: 0, u1: 0.75, v1: 1, opacity: 0.75
    });
  });

  it("bounds floating-point roundoff at the closed edges of a transformed fill image", () => {
    const motion = scene();
    motion.layers = [{
      id: "moving-video-frame", type: "video", assetRef: "assets/clip.mp4", fit: "fill", startMs: 0, durationMs: 1_000,
      transform: { x: -13.5, y: 0, width: 1_920, height: 1_080, scale: 1.065 }
    }];
    const videos = new Map([["moving-video-frame", {
      layerId: "moving-video-frame", resourceId: "video-moving", assetRef: "assets/clip.mp4", width: 736, height: 400, sha256: "a".repeat(64), sourceAtMs: 500
    }]]);
    const result = compileGpuScene2dPlan(motion, 500, { videos });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const draw = result.plan.frame.draws[0];
    expect(draw).toMatchObject({ kind: "image", u0: 0, v0: 0, u1: 1 });
    if (draw.kind !== "image") return;
    expect(draw.v1).toBeGreaterThanOrEqual(0);
    expect(draw.v1).toBeLessThanOrEqual(1);
  });

  it("lowers one exact decoded video frame through image compositing semantics", () => {
    const motion = scene();
    motion.layers = [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000, opacity: 0.8, fit: "contain", transitions: { in: { type: "fade", durationMs: 1_000 } }, transform: { x: 10, y: 5, width: 80, height: 50 } }];
    const videos = new Map([["clip", { layerId: "clip", resourceId: "video-clip", assetRef: "assets/clip.mp4", width: 160, height: 90, sha256: "b".repeat(64), sourceAtMs: 500 }]]);
    const result = compileGpuScene2dPlan(motion, 500, { videos });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan).toMatchObject({ visualLayerCount: 1, imageCount: 0, videoCount: 1 });
    expect(result.plan.frame.draws[0]).toMatchObject({ kind: "image", id: "clip", resourceId: "video-clip", x: 10, y: 7.5, width: 80, height: 45, opacity: 0.4 });
  });

  it("lowers animated linear and radial rectangle gradients with bounded stops", () => {
    const motion = scene();
    motion.layers = [
      {
        id: "linear", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 0.5,
        transform: { x: 5, y: 6, width: 40, height: 20 },
        gradient: { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff0080" }, { offset: 1, color: "#0000ff" }] },
        keyframes: { "gradient.angle": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 180 }] }
      },
      {
        id: "radial", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000,
        transform: { x: 50, y: 10, width: 40, height: 40 },
        gradient: { type: "radial", centerX: 0.25, centerY: 0.75, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#00000000" }] }
      }
    ];
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.frame.draws).toMatchObject([
      { kind: "gradientRect", id: "linear", angleDeg: 90, centerX: 0.5, centerY: 0.5, stops: [{ offset: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } }, { offset: 0.5, color: { a: expect.closeTo(0.25098, 4) } }, { offset: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }] },
      { kind: "gradientRect", id: "radial", centerX: 0.25, centerY: 0.75 }
    ]);
    expect(result.plan.frame.budget).toMatchObject({ rectangleCount: 2, gradientStopCount: 5, gradientUniformBytes: 672, estimatedPlanBytes: 288 });
  });

  it("lowers animated rounded rectangles with strokes and bounded shadows", () => {
    const motion = scene();
    motion.layers = [{
      id: "panel", type: "shape", shape: "rect", fill: "#102030", blendMode: "screen", startMs: 0, durationMs: 1_000, opacity: 0.8,
      transform: { x: 10, y: 5, width: 40, height: 20, scale: 2, rotation: 15 },
      style: { borderRadius: 6, stroke: "#80c0ffff", strokeWidth: 2, shadow: { offsetX: 3, offsetY: 4, blur: 5, spread: 1, color: "#00000080" } },
      keyframes: { "style.borderRadius": [{ atMs: 0, value: 4 }, { atMs: 1_000, value: 8 }] }
    }];
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.frame.draws[0]).toMatchObject({
      kind: "styledRect", id: "panel", blendMode: "screen", x: -10, y: -5, width: 80, height: 40, rotationDeg: 15,
      radius: 12, strokeWidth: 4, fill: { a: 0.8 }, stroke: { a: 0.8 },
      shadow: { offsetX: 6, offsetY: 8, blur: 10, spread: 2, color: { a: expect.closeTo(0.40157, 4) } }
    });
    expect(result.plan.frame.budget).toMatchObject({ rectangleCount: 1, styledRectangleUniformBytes: 80, blendModeCount: 1, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, blurPassCount: 0, compositeCount: 1, compositeUniformBytes: 64, blurUniformBytes: 0, glowUniformBytes: 0, compositeIntermediateTextureBytes: 48_000, estimatedPlanBytes: 256 });
  });

  it("lowers rectangle and rounded-rect spellings through exact rectangle primitives", () => {
    const motion = scene();
    motion.layers = [
      {
        id: "legacy-rectangle", type: "shape", shape: "rectangle", startMs: 0, durationMs: 1_000,
        transform: { x: 4, y: 6, width: 40, height: 20 },
        gradient: { type: "linear", angle: 35, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff80" }] }
      },
      {
        id: "rounded-panel", type: "shape", shape: "rounded-rect", fill: "#102030", startMs: 0, durationMs: 1_000, opacity: 0.8,
        transform: { x: 50, y: 6, width: 40, height: 20 },
        style: { radius: 6, stroke: "#80c0ffff", strokeWidth: 2, shadow: { offsetX: 2, offsetY: 3, blur: 4, spread: 1, color: "#00000080" } }
      }
    ];

    const result = compileGpuScene2dPlan(motion, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.frame.draws).toMatchObject([
      { kind: "gradientRect", id: "legacy-rectangle", gradientType: "linear", angleDeg: 35 },
      { kind: "styledRect", id: "rounded-panel", radius: 6, strokeWidth: 2, shadow: { offsetX: 2, offsetY: 3, blur: 4, spread: 1 } }
    ]);
  });

  it("refuses rounded gradient styling rather than approximating it", () => {
    const motion = scene();
    motion.layers = [{
      id: "rounded-gradient", type: "shape", shape: "rounded-rect", startMs: 0, durationMs: 1_000,
      transform: { width: 40, height: 20 }, style: { radius: 6 },
      gradient: { type: "radial", stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }
    }];
    expect(compileGpuScene2dPlan(motion, 0)).toMatchObject({
      ok: false,
      failure: { code: "gpu_unsupported_feature", layerId: "rounded-gradient", message: expect.stringContaining("cannot combine a gradient with radius") }
    });

  });

  it("lowers animated color grading controls into one bounded compositor pass", () => {
    const motion = scene();
    motion.layers = [{
      id: "grade", type: "shape", shape: "ellipse", fill: "#4080c0", startMs: 0, durationMs: 1_000,
      transform: { x: 10, y: 10, width: 40, height: 30 },
      effects: { blur: 0, brightness: 1, contrast: 1.1, saturate: 0.8, grayscale: 0.2, glow: { radius: 12, color: "#00d4ff" } },
      keyframes: { "effects.blur": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 16 }], "effects.brightness": [{ atMs: 0, value: 1 }, { atMs: 1_000, value: 2 }] }
    }];
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.frame.draws[0]).toMatchObject({ effects: { blur: 8, brightness: 1.5, contrast: 1.1, saturate: 0.8, grayscale: 0.2, glow: { radius: 12, color: { r: 0, g: expect.closeTo(212 / 255), b: 1, a: 1 } } } });
    expect(result.plan.frame.budget).toMatchObject({ blendModeCount: 0, colorEffectCount: 1, blurEffectCount: 1, glowEffectCount: 1, blurPassCount: 4, compositeCount: 1, compositeUniformBytes: 64, blurUniformBytes: 64, glowUniformBytes: 32, compositeIntermediateTextureBytes: 72_000 });
  });

  it("lowers rounded masks and static luma track mattes without drawing matte sources", () => {
    const masked = scene();
    masked.layers = [{ id: "panel", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 5, width: 60, height: 30, rotation: 20 }, mask: { type: "rounded-rect", inset: { top: 2, right: 4, bottom: 3, left: 5 }, radius: 8, inverted: true, opacity: 0.75, featherPx: 3, expansionPx: 2 } }];
    const first = compileGpuScene2dPlan(masked, 0);
    expect(first).toMatchObject({ ok: true, plan: { maskCount: 1, matteCount: 0, frame: { budget: { maskCount: 1, maskUniformBytes: 48 }, draws: [{ mask: { shape: "rect", x: 13, y: 5, width: 55, height: 29, radius: 8, rotationDeg: 20, pivotX: 40, pivotY: 20, inverted: true, opacity: 0.75, featherPx: 3 } }] } } });

    const matted = scene();
    matted.layers = [
      { id: "matte-shape", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1_000, transform: { x: 20, y: 10, width: 40, height: 30 }, style: { fill: "#808080" } },
      { id: "content", type: "shape", shape: "rect", fill: "#00aaff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 100, height: 60 }, matte: { type: "luma-inverted", sourceLayerId: "matte-shape" } }
    ];
    const second = compileGpuScene2dPlan(matted, 0);
    expect(second).toMatchObject({ ok: true, plan: { visualLayerCount: 1, shapeCount: 1, maskCount: 0, matteCount: 1, frame: { draws: [{ id: "content", mask: { shape: "ellipse", x: 20, y: 10, width: 40, height: 30, inverted: true, opacity: expect.closeTo(128 / 255, 4) } }] } } });
  });

  it.each(["alpha", "alpha-inverted", "luma", "luma-inverted"] as const)("lowers a static %s triangle track matte through the fixed matte pass", (type) => {
    const matted = scene();
    matted.layers = [
      { id: "matte-triangle", type: "shape", shape: "triangle", startMs: 0, durationMs: 1_000, transform: { x: 20, y: 10, width: 40, height: 30 }, style: { fill: "#808080" } },
      { id: "content", type: "shape", shape: "rect", fill: "#00aaff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 100, height: 60 }, matte: { type, sourceLayerId: "matte-triangle" } }
    ];
    const result = compileGpuScene2dPlan(matted, 0);
    expect(result).toMatchObject({ ok: true, plan: { visualLayerCount: 1, shapeCount: 1, matteCount: 1, frame: { draws: [{ id: "content", mask: { shape: "triangle", x: 20, y: 10, width: 40, height: 30, radius: 0, inverted: type.endsWith("inverted"), opacity: type.startsWith("luma") ? expect.closeTo(128 / 255, 4) : 1, featherPx: 0 } }] } } });
  });

  it.each(["luma", "luma-inverted"] as const)("retains the source fill alpha for a static %s matte", (type) => {
    const matted = scene();
    matted.layers = [
      { id: "matte", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1_000, transform: { x: 20, y: 10, width: 40, height: 30 }, style: { fill: "#80808080" } },
      { id: "content", type: "shape", shape: "rect", fill: "#00aaff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 100, height: 60 }, matte: { type, sourceLayerId: "matte" } }
    ];

    const result = compileGpuScene2dPlan(matted, 0);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.frame.draws[0]).toMatchObject({
      id: "content",
      mask: {
        shape: "ellipse",
        inverted: type === "luma-inverted",
        // `mask-type:luminance` evaluates a #80808080 fill as luma * alpha.
        opacity: expect.closeTo((128 / 255) * (128 / 255), 4)
      }
    });
  });

  it("lowers vignette and deterministic film grain adjustment layers in authored order", () => {
    const motion = scene();
    motion.layers = [
      { id: "plate", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { width: 100, height: 60 } },
      { id: "finish", type: "adjustment", startMs: 0, durationMs: 1_000, effects: { vignette: { amount: 0.8, softness: 0.6, color: "#10203080" }, filmGrain: { amount: 0.25, size: 3, seed: 42 } } },
      { id: "title", type: "shape", shape: "rect", fill: "#ff0000", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 10, width: 20, height: 10 } }
    ];
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan).toMatchObject({ visualLayerCount: 3, adjustmentCount: 1 });
    expect(result.plan.frame.draws.map((draw) => `${draw.kind}:${draw.id}`)).toEqual(["rect:plate", "adjustment:finish", "rect:title"]);
    expect(result.plan.frame.draws[1]).toMatchObject({ kind: "adjustment", vignette: { amount: 0.8, softness: 0.6, color: { r: 16 / 255, g: 32 / 255, b: 48 / 255, a: 128 / 255 } }, filmGrain: { amount: 0.25, size: 3, frameSeed: ((42 ^ Math.imul(16, 0x9e3779b1)) >>> 0) } });
    expect(result.plan.frame.budget).toMatchObject({ adjustmentCount: 1, adjustmentUniformBytes: 48, compositeIntermediateTextureBytes: 24_000 });
  });

  it("lowers manifest-bound animated text into one browser-shaped GPU surface", () => {
    const motion = scene();
    motion.safeAreas = { title: { top: 4, right: 8, bottom: 6, left: 10 } };
    motion.assets = [{ id: "brand", type: "font", family: "Brand Sans", source: { path: "assets/brand.woff2", mimeType: "font/woff2" }, weight: 700 }];
    motion.layers = [{
      id: "title", type: "text", text: "Hello\nGPU", startMs: 0, durationMs: 1_000, opacity: 0.8,
      transform: { x: 10, y: 8, width: 80, height: 40, scale: 1.5, rotation: 12 },
      style: { fontFamily: "Brand Sans, sans-serif", fontSize: 20, fontWeight: 700, lineHeight: 1.1, letterSpacing: 1, color: "#80c0ffff", textAlign: "center", verticalAlign: "middle", textShadow: { offsetX: 2, offsetY: -3, blur: 2, color: "rgba(0, 0, 0, 0.5)" } },
      textFit: { policy: "auto-fit", safeAreaId: "title", minFontSize: 14 },
      keyframes: { "style.fontSize": [{ atMs: 0, value: 20 }, { atMs: 1_000, value: 30 }], "style.textShadow.blur": [{ atMs: 0, value: 2 }, { atMs: 1_000, value: 6 }] }
    }];
    const fonts = new Map([["brand sans", [{ resourceId: "font-brand", assetRef: "assets/brand.woff2", family: "Brand Sans", weight: 700, style: "normal" as const, mimeType: "font/woff2" as const, sha256: "a".repeat(64) }]]]);
    const result = compileGpuScene2dPlan(motion, 500, { fonts });
    const initial = compileGpuScene2dPlan(motion, 0, { fonts });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(initial.ok).toBe(true); if (!initial.ok) return;
    expect(result.plan).toMatchObject({ visualLayerCount: 1, textCount: 1 });
    // The simple-text frame remains the established GPU route; styled runs
    // refuse before lowering and must not perturb this legacy fingerprint.
    expect(result.plan.frame.fingerprint).toBe("752495e9aba757f98d0712eb5252f0589003373f4f59aa2c86d9f0b1c5a7286e");
    expect(result.plan.frame.draws[0]).toMatchObject({
      kind: "text", id: "title", surfaceId: expect.stringMatching(/^text-[a-f0-9]{24}$/), fontResourceIds: ["font-brand"],
      fontFamily: "Brand Sans", text: "Hello\nGPU", x: -10, y: -2, width: 120, height: 60,
      rotationDeg: 12, pivotX: 50, pivotY: 28, opacity: 0.8, fontSize: 37.5, fontWeight: 700,
      letterSpacing: 1.5, lineHeight: 1.1, textAlign: "center", verticalAlign: "middle", direction: "ltr",
      textShadow: { offsetX: 2, offsetY: -3, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      textFit: { policy: "auto-fit", safeArea: { top: 4, right: 92, bottom: 54, left: 10 }, minFontSize: 14 }
    });
    expect(initial.plan.frame.draws[0]?.kind === "text" && initial.plan.frame.draws[0].surfaceId).not.toBe(result.plan.frame.draws[0]?.kind === "text" && result.plan.frame.draws[0].surfaceId);
    expect(result.plan.frame.budget).toMatchObject({ textCount: 1, textUtf8Bytes: 9, textSurfacePixels: 7_200, textVertexBufferBytes: 120 });
  });

  it("refuses text fitting without a declared safe-area geometry contract", () => {
    const motion = scene();
    motion.assets = [{ id: "brand", type: "font", family: "Brand", source: { path: "assets/brand.woff2", mimeType: "font/woff2" } }];
    motion.layers = [{ id: "title", type: "text", text: "GPU", startMs: 0, durationMs: 1_000, transform: { width: 80, height: 30 }, style: { fontFamily: "Brand" }, textFit: { policy: "safe", safeAreaId: "missing" } }];
    const fonts = new Map([["brand", [{ resourceId: "font-brand", assetRef: "assets/brand.woff2", family: "Brand", weight: 400, style: "normal" as const, mimeType: "font/woff2" as const, sha256: "a".repeat(64) }]]]);
    expect(compileGpuScene2dPlan(motion, 0, { fonts })).toMatchObject({
      ok: false,
      failure: { code: "gpu_unsupported_feature", layerId: "title", message: expect.stringContaining("glyph-layout text-fit contract") }
    });
  });

  it("refuses unsupported layers and visual features without fallback", () => {
    const text = scene();
    text.layers = [{ id: "title", type: "text", text: "requires a font", startMs: 0, durationMs: 1_000, transform: { width: 100, height: 40 }, style: { fontFamily: "Brand" } }];
    expect(compileGpuScene2dPlan(text, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "title" } });

    const particles = scene();
    particles.layers = [{ id: "sparks", type: "particles", startMs: 0, durationMs: 1_000 }];
    expect(compileGpuScene2dPlan(particles, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_layer", layerId: "sparks" } });

    const adjustment = scene();
    adjustment.layers = [{ id: "finish", type: "adjustment", startMs: 0, durationMs: 1_000, effects: { blur: 4 } }];
    expect(compileGpuScene2dPlan(adjustment, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_effect", layerId: "finish" } });

    const image = scene();
    image.layers = [{ id: "hero", type: "image", assetRef: "assets/hero.png", startMs: 0, durationMs: 1_000 }];
    expect(compileGpuScene2dPlan(image, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "hero" } });

    const combined = scene();
    combined.layers = [{ id: "combined", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, style: { radius: 8 }, gradient: { type: "linear", stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] } }];
    expect(compileGpuScene2dPlan(combined, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "combined" } });
  });

  it("lowers authored motion blur into one isolated additive temporal group", () => {
    const motion = scene();
    motion.layers[0].blendMode = "screen";
    motion.layers[0].effects = { motionBlur: { samples: 3, shutterAngle: 180 }, brightness: 1.1 };
    motion.layers[0].keyframes = { "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 120 }] };
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan).toMatchObject({ motionBlurLayerCount: 1, motionBlurSampleCount: 3 });
    expect(result.plan.frame.draws.map((draw) => draw.kind)).toEqual(["motionBlurStart", "rect", "rect", "rect", "motionBlurEnd", "points", "ellipse"]);
    expect(result.plan.frame.draws[0]).toMatchObject({ id: "plate.motion-blur", sampleCount: 3, drawCount: 3, shutterAngle: 180, blendMode: "screen", effects: { brightness: 1.1 } });
    const samples = result.plan.frame.draws.slice(1, 4);
    expect(samples.every((draw) => draw.kind === "rect" && draw.blendMode === "normal" && draw.effects === null && draw.color.a === 0.5 / 3)).toBe(true);
    expect(samples.map((draw) => draw.kind === "rect" ? draw.x : -1)).toEqual([59, 60, 61]);
    expect(result.plan.frame.budget).toMatchObject({ rectangleCount: 4, motionBlurGroupCount: 1, motionBlurSampleCount: 3, colorEffectCount: 1, compositeCount: 1 });
  });

  it("lowers nested group children on local timelines into isolated spans",()=>{
    const motion=scene();motion.layers=[
      {id:"outer",type:"group",startMs:100,durationMs:800,childLayerIds:["child","inner"],transform:{x:10,y:5,scale:2,rotation:30,originX:50,originY:30,opacity:0.75},blendMode:"screen",effects:{brightness:1.1}},
      {id:"child",type:"shape",shape:"rect",fill:"#ff0000",startMs:0,durationMs:800,transform:{x:0,y:0,width:10,height:10},keyframes:{"transform.x":[{atMs:0,value:0},{atMs:800,value:80}]}},
      {id:"inner",type:"group",startMs:100,durationMs:600,childLayerIds:["orb"]},
      {id:"orb",type:"shape",shape:"ellipse",fill:"#00ff00",startMs:0,durationMs:600,transform:{x:20,y:10,width:8,height:8}}
    ];
    const result=compileGpuScene2dPlan(motion,500);expect(result.ok).toBe(true);if(!result.ok)return;
    expect(result.plan).toMatchObject({groupCount:2,groupMaxDepth:2,visualLayerCount:4});
    expect(result.plan.frame.draws.map((draw)=>draw.kind)).toEqual(["groupStart","rect","groupStart","ellipse","groupEnd","groupEnd"]);
    expect(result.plan.frame.draws[0]).toMatchObject({kind:"groupStart",drawCount:4,x:10,y:5,scale:2,rotationDeg:30,opacity:0.75,blendMode:"screen",effects:{brightness:1.1}});
    expect(result.plan.frame.draws[1]).toMatchObject({kind:"rect",x:40});
    expect(result.plan.frame.budget).toMatchObject({groupCount:2,groupMaxDepth:2,compositeCount:2});
  });

  it("lowers camera and depth parallax into fixed GPU transform planes", () => {
    const motion = scene();
    motion.layers = [
      { id: "camera", type: "camera", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 5, scale: 2, rotation: 15, originX: 50, originY: 30 } },
      { id: "far", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, depth: -0.5, transform: { x: 0, y: 0, width: 20, height: 10 } },
      { id: "near", type: "shape", shape: "ellipse", fill: "#ff0000", startMs: 0, durationMs: 1_000, depth: 1, transform: { x: 20, y: 10, width: 10, height: 10 } }
    ];
    const result = compileGpuScene2dPlan(motion, 0);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan).toMatchObject({ visualLayerCount: 2, cameraCount: 1, depthPlaneCount: 2, groupCount: 0 });
    expect(result.plan.frame.draws).toMatchObject([
      { kind: "groupStart", id: "camera-plane-1", x: -5, y: -2.5, scale: Math.sqrt(2), rotationDeg: -7.5, pivotX: 50, pivotY: 30, drawCount: 1 },
      { kind: "rect", id: "far" }, { kind: "groupEnd", groupId: "camera-plane-1" },
      { kind: "groupStart", id: "camera-plane-2", x: -20, y: -10, scale: 4, rotationDeg: -30, pivotX: 50, pivotY: 30, drawCount: 1 },
      { kind: "ellipse", id: "near" }, { kind: "groupEnd", groupId: "camera-plane-2" }
    ]);
    expect(result.plan.frame.budget).toMatchObject({ groupCount: 2, groupMaxDepth: 1, compositeCount: 2 });
  });

  it("lowers animated rain into fixed environment uniforms and quality bounds", () => {
    const motion = scene();
    motion.layers = [{
      id: "storm", type: "environment", startMs: 0, durationMs: 1_000, opacity: 0.75,
      transform: { x: 0, y: 0, width: 100, height: 60 },
      environment: {
        schema: "shellx-motion/environment@1", kind: "rain", seed: 71, quality: "preview", mode: "overlay",
        intensity: 0.8, wind: 0.2, dropSpeed: 1.4, dropLength: 1, depthLayers: 4,
        color: "#bdebff", backgroundColor: "#050a12", lightColor: "#7dd3fc", accentColor: "#fb7185",
        ground: { horizon: 0.43, wetness: 0.9, roughness: 0.24, rippleAmount: 0.78, splashAmount: 0.64, reflectionStrength: 0.88 },
        atmosphere: { mist: 0.44, lensDroplets: 0.34 }
      },
      keyframes: { "environment.intensity": [{ atMs: 0, value: 0.2 }, { atMs: 1_000, value: 0.8 }] }
    }];
    const first = compileGpuScene2dPlan(motion, 500);
    const second = compileGpuScene2dPlan(motion, 600);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true); if (!first.ok || !second.ok) return;
    expect(first.plan).toMatchObject({ environmentCount: 1, visualLayerCount: 1 });
    expect(first.plan.frame.draws[0]).toMatchObject({ kind: "environment", environmentKind: "rain", mode: "overlay", timeSeconds: 0.5, opacity: 0.75 });
    expect(first.plan.frame.draws[0]).toHaveProperty("parameters", expect.arrayContaining([0.5, 0.2, 1.4, 1, 2]));
    expect(first.plan.frame.budget).toMatchObject({ environmentCount: 1, environmentUniformBytes: 208, compositeCount: 1, compositeUniformBytes: 64, compositeIntermediateTextureBytes: 48_000, estimatedPlanBytes: 352 });
    expect(second.plan.frame.fingerprint).not.toBe(first.plan.frame.fingerprint);
  });

  it("binds environment scene and effect-mask inputs only to prepared image identities", () => {
    const motion = scene();
    const rain = {
      schema: "shellx-motion/environment@1" as const, kind: "rain" as const, seed: 9, quality: "balanced" as const, mode: "scene" as const,
      sceneSourceLayerId: "plate", effectMaskLayerId: "weather-mask", intensity: 0.7, wind: 0, dropSpeed: 1, dropLength: 1, depthLayers: 4,
      color: "#ffffff", backgroundColor: "#000000", lightColor: "#ffffff", accentColor: "#80c0ff",
      ground: { horizon: 0.5, wetness: 0.8, roughness: 0.2, rippleAmount: 0.5, splashAmount: 0.5, reflectionStrength: 0.5 }, atmosphere: { mist: 0.3, lensDroplets: 0.2 }
    };
    motion.layers = [
      { id: "plate", type: "image", source: "assets/plate.png", fit: "fill", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 100, height: 60, scale: 1, rotation: 0 } },
      { id: "weather-mask", type: "image", source: "assets/mask.png", fit: "fill", opacity: 0, startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 100, height: 60, scale: 1, rotation: 0 } },
      { id: "storm", type: "environment", startMs: 0, durationMs: 1_000, transform: { width: 100, height: 60 }, environment: rain }
    ];
    const images = new Map([
      ["assets/plate.png", { resourceId: "plate-exact", assetRef: "assets/plate.png", width: 100, height: 60, sha256: "a".repeat(64) }],
      ["assets/mask.png", { resourceId: "mask-exact", assetRef: "assets/mask.png", width: 100, height: 60, sha256: "b".repeat(64) }]
    ]);
    const result = compileGpuScene2dPlan(motion, 250, { images });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.frame.draws.map((draw) => draw.kind)).toEqual(["image", "image", "environment"]);
    expect(result.plan.frame.draws[2]).toMatchObject({ kind: "environment", sceneResourceId: "plate-exact", effectMaskResourceId: "mask-exact", parameters: expect.arrayContaining([3]) });
    expect(compileGpuScene2dPlan(motion, 250)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "plate" } });
  });

  it("lowers fixed primitives and admitted mesh geometry into a depth-buffered 3D draw", () => {
    const motion = scene(); motion.width = 160; motion.height = 90;
    motion.layers = [{
      id: "world", type: "scene3d", startMs: 0, durationMs: 1_000, opacity: 0.8,
      scene3d: {
        schema: "shellx-motion/scene3d@2", backgroundColor: "#102030",
        camera: { position: [0, 1, 5], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100, orbitDegPerSecond: 30 },
        lighting: { ambient: 0.2, direction: [0, -1, -1], intensity: 1.5, color: "#ffffff" },
        objects: [
          { id: "cube", primitive: "box", position: [-1, 0, 0], rotationDeg: [0, 0, 0], spinDegPerSecond: [0, 90, 0], scale: 1, color: "#ff0000", emissive: 0.1 },
          { id: "mesh", primitive: "mesh", position: [1, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00ff00", geometry: { positions: [0,0,0, 1,0,0, 0,1,0], normals: [0,0,1, 0,0,1, 0,0,1], indices: [0,1,2] }, source: { format: "gltf", meshIndex: 0, primitiveIndex: 0, geometrySha256: scene3dMeshGeometrySha256({ positions: [0,0,0, 1,0,0, 0,1,0], normals: [0,0,1, 0,0,1, 0,0,1], indices: [0,1,2] }) } }
        ]
      }
    }];
    const result = compileGpuScene2dPlan(motion, 500);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan).toMatchObject({ scene3dCount: 1, scene3dObjectCount: 2, visualLayerCount: 1 });
    expect(result.plan.frame.draws[0]).toMatchObject({ kind: "scene3d", id: "world", opacity: 0.8, background: { r: 16/255, g: 32/255, b: 48/255, a: 0.8 }, objects: [{ id: "cube", emissive: 0.1 }, { id: "mesh", indices: [0,1,2] }] });
    expect(result.plan.frame.budget).toMatchObject({ scene3dCount: 1, scene3dObjectCount: 2, scene3dVertexCount: 39, scene3dIndexCount: 39, scene3dVertexBufferBytes: 936, scene3dIndexBufferBytes: 156, scene3dUniformBytes: 384 });
    expect((result.plan.frame.draws[0] as { viewProjection:number[] }).viewProjection).toHaveLength(16);
  });

  it("refuses glTF mesh bytes changed after their source-backed geometry hash was issued", () => {
    const motion = scene();
    const geometry = { positions: [0,0,0, 1,0,0, 0,1,0], normals: [0,0,1, 0,0,1, 0,0,1], indices: [0,1,2] };
    motion.layers = [{
      id: "world", type: "scene3d", startMs: 0, durationMs: 1_000,
      scene3d: {
        schema: "shellx-motion/scene3d@2", backgroundColor: "#102030",
        camera: { position: [0, 1, 5], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
        lighting: { ambient: 0.2, direction: [0, -1, -1], intensity: 1, color: "#ffffff" },
        objects: [{ id: "mesh", primitive: "mesh", position: [0,0,0], rotationDeg: [0,0,0], scale: 1, color: "#ffffff", geometry, source: { format: "gltf", meshIndex: 0, primitiveIndex: 0, geometrySha256: scene3dMeshGeometrySha256(geometry) } }]
      }
    }];
    expect(compileGpuScene2dPlan(motion, 0)).toMatchObject({ ok: true });
    geometry.positions[3] = 1.25;
    expect(compileGpuScene2dPlan(motion, 0)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "world", message: expect.stringContaining("must match the exact bounded glTF geometry payload") } });
  });

  it("refuses a rootless group cycle even when document validation was bypassed",()=>{
    const motion=scene();motion.layers=[
      {id:"a",type:"group",startMs:0,durationMs:1000,childLayerIds:["b"]},
      {id:"b",type:"group",startMs:0,durationMs:1000,childLayerIds:["a"]}
    ];
    expect(compileGpuScene2dPlan(motion,0)).toMatchObject({ok:false,failure:{code:"gpu_unsupported_feature",message:expect.stringContaining("group cycle")}});
  });
});
