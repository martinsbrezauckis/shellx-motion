import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { gpuSceneWipeInsets } from "./gpu-scene-wipe-transition";
import { resolveEasing } from "./timeline";
import type { MotionDocument, MotionLayer, MotionTransition } from "./types";

function motion(layer: MotionLayer): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gpu-wipe", name: "GPU wipe", durationMs: 1_000, fps: 30, width: 200, height: 120,
    background: "#102030", assets: [], provenance: { sourceApp: "test", createdBy: "gpu-scene-wipe-transition.test" }, layers: [layer],
  };
}

function shape(transitions: MotionLayer["transitions"]): MotionLayer {
  return {
    id: "panel", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000,
    transform: { x: 10, y: 20, width: 100, height: 60 }, transitions,
  };
}

describe("GPU wipe transition lowering", () => {
  it("matches the browser/native inset timing reference across endpoints and easing samples", () => {
    const layer = shape({ in: { type: "wipe", durationMs: 400, direction: "left", easing: "ease-out" }, out: { type: "wipe", durationMs: 400, direction: "up", easing: "ease-in" } });
    for (const atMs of [0, 100, 200, 400, 600, 850, 999, 1_000]) {
      expect(gpuSceneWipeInsets(layer, atMs)).toEqual(browserNativeWipeInsets(layer, atMs));
    }
    expect(gpuSceneWipeInsets(layer, 100)).toEqual({ top: 0, right: 56.25, bottom: 0, left: 0 });
    expect(gpuSceneWipeInsets(layer, 850)).toEqual({ top: 39.0625, right: 0, bottom: 0, left: 0 });
    expect(gpuSceneWipeInsets(layer, 0)).toEqual({ top: 0, right: 100, bottom: 0, left: 0 });
    expect(gpuSceneWipeInsets(layer, 400)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(gpuSceneWipeInsets(layer, 1_000)).toEqual({ top: 100, right: 0, bottom: 0, left: 0 });
  });

  it("lowers all four in/out directions to the exact transformed layer-local rectangular mask", () => {
    const expectedIn = {
      left: { top: 0, right: 50, bottom: 0, left: 0 },
      right: { top: 0, right: 0, bottom: 0, left: 50 },
      up: { top: 0, right: 0, bottom: 50, left: 0 },
      down: { top: 50, right: 0, bottom: 0, left: 0 },
    } as const;
    const expectedOut = {
      left: { top: 0, right: 0, bottom: 0, left: 50 },
      right: { top: 0, right: 50, bottom: 0, left: 0 },
      up: { top: 50, right: 0, bottom: 0, left: 0 },
      down: { top: 0, right: 0, bottom: 50, left: 0 },
    } as const;
    for (const direction of ["left", "right", "up", "down"] as const) {
      expect(gpuSceneWipeInsets(shape({ in: { type: "wipe", durationMs: 400, direction, easing: "linear" } }), 200)).toEqual(expectedIn[direction]);
      expect(gpuSceneWipeInsets(shape({ out: { type: "wipe", durationMs: 400, direction, easing: "linear" } }), 800)).toEqual(expectedOut[direction]);
    }

    const transformed = shape({ in: { type: "wipe", durationMs: 400, direction: "right", easing: "linear" } });
    transformed.transform = { x: 10, y: 20, width: 100, height: 60, scale: 1.5, originX: 20, originY: 10, rotation: 30 };
    const result = compileGpuScene2dPlan(motion(transformed), 200);
    expect(result).toMatchObject({
      ok: true,
      plan: { maskCount: 1, frame: { draws: [{ mask: { shape: "rect", x: 75, y: 15, width: 75, height: 90, rotationDeg: 30, pivotX: 30, pivotY: 30, radius: 0, opacity: 1, featherPx: 0 } }] } },
    });

    const overlap = shape({ in: { type: "wipe", durationMs: 400, direction: "right", easing: "linear" }, out: { type: "wipe", durationMs: 400, direction: "right", easing: "linear" } });
    overlap.durationMs = 600;
    const overlappingDocument = motion(overlap); overlappingDocument.durationMs = 600;
    expect(compileGpuScene2dPlan(overlappingDocument, 300)).toMatchObject({
      ok: true,
      plan: { frame: { draws: [{ mask: { x: 35, y: 20, width: 50, height: 60, opacity: 1 } }] } },
    });
  });

  it("clips image/video content against the authored layer box, not a post-object-fit visible placement", () => {
    const layer: MotionLayer = {
      id: "clip", type: "video", assetRef: "assets/clip.mp4", fit: "contain", startMs: 0, durationMs: 1_000,
      transform: { x: 10, y: 20, width: 100, height: 80 }, transitions: { in: { type: "wipe", durationMs: 400, direction: "down", easing: "linear" } },
    };
    const result = compileGpuScene2dPlan(motion(layer), 200, {
      videos: new Map([["clip", { layerId: "clip", resourceId: "frame-clip", assetRef: "assets/clip.mp4", width: 100, height: 50, sha256: "a".repeat(64), sourceAtMs: 200 }]]),
    });
    expect(result).toMatchObject({
      ok: true,
      plan: { frame: { draws: [{ kind: "image", x: 10, y: 35, width: 100, height: 50, mask: { x: 10, y: 60, width: 100, height: 40 } }] } },
    });
  });

  it("refuses authored-mask, matte, and temporal-blur combinations rather than approximating CSS composition", () => {
    const wipe = { in: { type: "wipe" as const, durationMs: 400, direction: "left" as const } };
    const masked = shape(wipe); masked.mask = { type: "rect" };
    expect(compileGpuScene2dPlan(motion(masked), 100)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "panel", message: expect.stringContaining("single-mask ABI") } });

    const matted = shape(wipe); matted.matte = { type: "alpha", sourceLayerId: "missing" };
    expect(compileGpuScene2dPlan(motion(matted), 100)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "panel", message: expect.stringContaining("single-mask ABI") } });

    const blurred = shape(wipe); blurred.effects = { motionBlur: { samples: 3, shutterAngle: 180 } };
    expect(compileGpuScene2dPlan(motion(blurred), 100)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "panel", message: expect.stringContaining("temporal motion blur") } });
  });

  it("refuses point and particle wipes and media without an attested layer-local box", () => {
    const wipe = { in: { type: "wipe" as const, durationMs: 400, direction: "left" as const } };
    const points: MotionLayer = { id: "points", type: "points", startMs: 0, durationMs: 1_000, transitions: wipe, pointCloud: { points: [{ x: 1, y: 2, size: 2, opacity: 1 }] } };
    expect(compileGpuScene2dPlan(motion(points), 100)).toMatchObject({ ok: false, failure: { layerId: "points", message: expect.stringContaining("only for shape, image, video, text, and caption") } });

    const image: MotionLayer = { id: "image", type: "image", assetRef: "assets/image.png", startMs: 0, durationMs: 1_000, transitions: wipe };
    expect(compileGpuScene2dPlan(motion(image), 100)).toMatchObject({ ok: false, failure: { layerId: "image", message: expect.stringContaining("requires explicit bounded width and height") } });
  });

  it("keeps browser/native zero-duration wipes as no-op transitions", () => {
    const layer = shape({ in: { type: "wipe", durationMs: 0, direction: "diagonal" } });
    expect(gpuSceneWipeInsets(layer, 0)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(compileGpuScene2dPlan(motion(layer), 0)).toMatchObject({ ok: true, plan: { maskCount: 0 } });
  });
});

/** A direct transcription of the existing browser/native clip-path transition rules. */
function browserNativeWipeInsets(layer: MotionLayer, atMs: number): { top: number; right: number; bottom: number; left: number } {
  const localMs = atMs - layer.startMs;
  const remainingMs = Math.max(0, layer.durationMs) - localMs;
  const entering = referenceTransitionInsets(layer.transitions?.in, localMs, "in");
  const leaving = referenceTransitionInsets(layer.transitions?.out, remainingMs, "out");
  return {
    top: Math.max(0, entering.top, leaving.top), right: Math.max(0, entering.right, leaving.right),
    bottom: Math.max(0, entering.bottom, leaving.bottom), left: Math.max(0, entering.left, leaving.left),
  };
}

function referenceTransitionInsets(transition: MotionTransition | undefined, elapsedMs: number, edge: "in" | "out"): { top: number; right: number; bottom: number; left: number } {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!transition || transition.type !== "wipe" || transition.durationMs <= 0) return zero;
  const hidden = edge === "in"
    ? elapsedMs >= transition.durationMs ? 0 : elapsedMs <= 0 ? 100 : 100 * (1 - resolveEasing(transition.easing)(elapsedMs / transition.durationMs))
    : elapsedMs >= transition.durationMs ? 0 : elapsedMs <= 0 ? 100 : 100 * resolveEasing(transition.easing)(1 - elapsedMs / transition.durationMs);
  const direction = transition.direction ?? "left";
  if (edge === "in") {
    if (direction === "right") return { ...zero, left: hidden };
    if (direction === "up") return { ...zero, bottom: hidden };
    if (direction === "down") return { ...zero, top: hidden };
    return { ...zero, right: hidden };
  }
  if (direction === "right") return { ...zero, right: hidden };
  if (direction === "up") return { ...zero, top: hidden };
  if (direction === "down") return { ...zero, bottom: hidden };
  return { ...zero, left: hidden };
}
