import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { GPU_CAPABILITY, matchRendererCapability, matchRendererCapabilityCards } from "./capabilities";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import {
  compileGpuSceneGeometryKeyframesFramePlan,
  compileGpuSceneGeometryKeyframesStaticPlan,
  GPU_SCENE_GEOMETRY_KEYFRAMES_FRAME_PLAN_SCHEMA,
  GPU_SCENE_GEOMETRY_KEYFRAMES_STATIC_PLAN_SCHEMA,
} from "./gpu-scene-geometry-keyframes-composition";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA } from "./motion-shape-geometry-keyframes";
import type { MotionDocument } from "./types";

describe("GPU shape geometry-keyframe composition", () => {
  it("samples interpolated geometry once at an exact microsecond and delegates to the settled GPU plan", () => {
    const motion = animated();
    const staticPlan = compileGpuSceneGeometryKeyframesStaticPlan(motion);
    expect(staticPlan).toMatchObject({ ok: true, plan: { schema: GPU_SCENE_GEOMETRY_KEYFRAMES_STATIC_PLAN_SCHEMA, targets: [{ layerId: "contour", keyframeCount: 2 }] } });
    if (!staticPlan.ok) return;
    expect(staticPlan.plan.basePlan.schema).toBe("shellx-motion/gpu-scene-static-plan@1");
    expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { layerId: "contour", message: expect.stringContaining("exact geometry-keyframe composition") } });
    expect(compileGpuScene2dPlan(motion, 500)).toMatchObject({ ok: false, failure: { layerId: "contour", message: expect.stringContaining("exact geometry-keyframe composition") } });

    const frame = compileGpuSceneGeometryKeyframesFramePlan(motion, staticPlan.plan, 500_000);
    expect(frame).toMatchObject({ ok: true, plan: { schema: GPU_SCENE_GEOMETRY_KEYFRAMES_FRAME_PLAN_SCHEMA, atUs: 500_000, staticFingerprint: staticPlan.plan.fingerprint, samples: [{ layerId: "contour" }], frame: { schema: "shellx-motion/gpu-frame-intent@1" } } });
    if (!frame.ok) return;
    const draw = frame.plan.frame.draws.find((candidate) => candidate.id === "contour");
    expect(draw).toMatchObject({ kind: "coloredTriangles" });
    expect((draw as { vertices: Array<{ x: number }> }).vertices.some((vertex) => vertex.x === 10)).toBe(true);
    expect(Object.isFrozen(frame.plan)).toBe(true);
  });

  it("refuses forged and stale execution wrappers before supplied resources are touched", () => {
    const motion = animated();
    const staticPlan = compileGpuSceneGeometryKeyframesStaticPlan(motion);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    const forbiddenResources = new Proxy({}, { get() { throw new Error("resources must not be read"); } });
    const forged = { ...staticPlan.plan };
    expect(compileGpuSceneGeometryKeyframesFramePlan(motion, forged, 500_000, forbiddenResources)).toEqual({ ok: false, failure: { code: "gpu_resource_refused", message: "GPU geometry-keyframe composition requires an exact Core-issued static execution wrapper." } });
    const stale = structuredClone(motion);
    stale.layers[0] = { ...stale.layers[0]!, name: "changed" };
    expect(compileGpuSceneGeometryKeyframesFramePlan(stale, staticPlan.plan, 500_000, forbiddenResources)).toEqual({ ok: false, failure: { code: "gpu_resource_refused", message: "GPU geometry-keyframe static execution wrapper is stale for this Motion document." } });
  });

  it("refuses nonrepresentable times, motion blur, and behavior conflicts before frame resources", () => {
    const motion = animated();
    const staticPlan = compileGpuSceneGeometryKeyframesStaticPlan(motion);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    const forbiddenResources = new Proxy({}, { get() { throw new Error("resources must not be read"); } });
    const long = structuredClone(motion); long.durationMs = 9_000_000_000_001; long.fps = 1; long.layers[0]!.durationMs = long.durationMs;
    expect(compileGpuSceneGeometryKeyframesFramePlan(long, staticPlan.plan, 9_000_000_000_000_001, forbiddenResources)).toEqual({ ok: false, failure: { code: "gpu_invalid_time", message: "GPU geometry-keyframe composition atUs cannot round-trip through the legacy GPU millisecond ABI." } });
    const blurred = structuredClone(motion); blurred.layers[0]!.effects = { motionBlur: { samples: 2, shutterAngle: 180 } };
    expect(compileGpuSceneGeometryKeyframesStaticPlan(blurred)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "contour", message: expect.stringContaining("shutter") } });
    const conflicted = structuredClone(motion); conflicted.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [] };
    expect(compileGpuSceneGeometryKeyframesStaticPlan(conflicted)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("document behaviors") } });
  });

  it("adds the feature only to strict GPU matching and preserves no-feature static/frame goldens", () => {
    const motion = animated();
    expect(matchRendererCapability(motion, GPU_CAPABILITY)).toMatchObject({ ok: true, lane: "gpu" });
    expect(matchRendererCapabilityCards(motion, { output: "png-frame", target: "preview" }).matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: true });
    expect(matchRendererCapabilityCards(motion, { output: "raw-rgba", target: "final" }).matches.find((match) => match.lane === "gpu")).toMatchObject({
      ok: false,
      unsupported: expect.arrayContaining([expect.objectContaining({ feature: "shape.geometry.keyframes", reason: expect.stringContaining("strict Browser GPU preview") })])
    });
    const legacy = staticShape();
    const first = compileGpuSceneStaticPlan(legacy), second = compileGpuSceneStaticPlan(structuredClone(legacy));
    expect(first).toEqual(second);
    if (!first.ok || !second.ok) return;
    expect(canonicalJson(first.plan)).toBe(canonicalJson(second.plan));
    expect(first.plan.fingerprint).toBe("46c2344ccaf160309199dc305e9f83c08d71d305db86c5cb5071562774041e1f");
    const firstFrame = compileGpuScene2dPlan(legacy, 500), secondFrame = compileGpuScene2dPlan(structuredClone(legacy), 500);
    expect(firstFrame).toEqual(secondFrame);
    if (!firstFrame.ok || !secondFrame.ok) return;
    expect(canonicalJson(firstFrame.plan)).toBe(canonicalJson(secondFrame.plan));
    expect(firstFrame.plan.frame.fingerprint).toBe("f2db4ab62b01b5ab605d378139877196b5a6721a98f7ea7919f917f092792468");
  });
});

function animated(): MotionDocument {
  const motion = staticShape();
  motion.layers[0] = {
    ...motion.layers[0]!,
    geometryKeyframes: {
      schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA,
      keyframes: [
        { atUs: 0, geometry: polygon(0) },
        { atUs: 1_000_000, geometry: polygon(20) },
      ]
    }
  };
  return motion;
}

function staticShape(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gpu-geometry-keyframes", name: "GPU geometry keyframes", durationMs: 1_000, fps: 30, width: 100, height: 60,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "contour", type: "shape", startMs: 0, durationMs: 1_000,
      transform: { width: 100, height: 60 }, fill: "#ff8040", geometry: polygon(0)
    }]
  };
}

function polygon(offset: number) {
  return {
    schema: "shellx-motion/shape-geometry@1" as const,
    kind: "polygon" as const,
    viewBox: { x: 0, y: 0, width: 100, height: 60 },
    points: [{ x: offset, y: 0 }, { x: offset + 30, y: 0 }, { x: offset + 15, y: 30 }]
  };
}
