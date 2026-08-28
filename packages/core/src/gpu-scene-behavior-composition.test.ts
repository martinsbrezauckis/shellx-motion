import { describe, expect, it } from "vitest";
import { compileGpuSceneBehaviorFramePlan, compileGpuSceneBehaviorStaticPlan } from "./gpu-scene-behavior-composition";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { gpuVideoTimelineAtUs } from "./gpu-video-frame-request";
import type { MotionDocument } from "./types";

describe("GPU behavior composition", () => {
  it("binds the ordinary legacy static/frame plans to deterministic behavior identities", () => {
    const motion = document(transformBinding("shape"));
    const first = compileGpuSceneBehaviorStaticPlan(motion), replay = compileGpuSceneBehaviorStaticPlan(structuredClone(motion));
    expect(first).toMatchObject({ ok: true }); expect(replay).toEqual(first);
    if (!first.ok) return;
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(first.plan.targetLayerIds).toEqual(["shape"]);
    const frame = compileGpuSceneBehaviorFramePlan(motion, 500_000);
    expect(frame).toMatchObject({ ok: true, plan: { atUs: 500_000, staticFingerprint: first.plan.fingerprint, activeTargetLayerIds: ["shape"], frame: { schema: "shellx-motion/gpu-frame-intent@1" } } });
    if (!frame.ok) return;
    expect(frame.plan.frame.draws.find((draw) => draw.id === "shape")).toMatchObject({ kind: "rect", x: 60, y: 20 });
    const changed = structuredClone(motion); (changed.behaviors!.bindings[0] as { motion: { velocityX: number } }).motion.velocityX = 101;
    const changedStatic = compileGpuSceneBehaviorStaticPlan(changed);
    expect(changedStatic).toMatchObject({ ok: true }); if (changedStatic.ok) expect(changedStatic.plan.fingerprint).not.toBe(first.plan.fingerprint);
  });

  it("composes a closed path-follow transform through the existing GPU shape lowerer", () => {
    const motion = document(pathBinding("shape"));
    const start = compileGpuSceneBehaviorFramePlan(motion, 0), middle = compileGpuSceneBehaviorFramePlan(motion, 250_000);
    expect(start).toMatchObject({ ok: true }); expect(middle).toMatchObject({ ok: true });
    if (!start.ok || !middle.ok) return;
    const startDraw = start.plan.frame.draws.find((draw) => draw.id === "shape");
    const middleDraw = middle.plan.frame.draws.find((draw) => draw.id === "shape");
    expect(middleDraw).not.toEqual(startDraw);
    expect(middle.plan.activeTargetLayerIds).toEqual(["shape"]);
  });

  it("keeps disabled behavior geometry byte-identical to the stripped legacy frame", () => {
    const motion = document({ ...transformBinding("shape"), enabled: false });
    const composed = compileGpuSceneBehaviorFramePlan(motion, 500_000);
    const { behaviors: _behaviors, ...legacy } = motion;
    const base = compileGpuScene2dPlan(legacy, 500);
    expect(composed).toMatchObject({ ok: true, plan: { activeTargetLayerIds: [], budget: { activeBindingCount: 0 } } }); expect(base).toMatchObject({ ok: true });
    if (!composed.ok || !base.ok) return;
    expect(composed.plan.frame).toEqual(base.plan.frame);
    expect(composed.plan.baseFrameFingerprint).toBe(base.plan.frame.fingerprint);
  });

  it("refuses absent stores, invalid root time, and target motion blur before a GPU frame exists", () => {
    expect(compileGpuSceneBehaviorStaticPlan(document())).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU behavior composition requires document behaviors@1." } });
    expect(compileGpuSceneBehaviorFramePlan(document(transformBinding("shape")), 1.5)).toMatchObject({ ok: false, failure: { code: "gpu_invalid_time" } });
    const blurred = document(transformBinding("shape")); blurred.layers[0]!.effects = { motionBlur: { samples: 2, shutterAngle: 180 } };
    expect(compileGpuSceneBehaviorFramePlan(blurred, 500_000)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", layerId: "shape", message: expect.stringContaining("shutter samples") } });
  });

  it("refuses behavior plus active video before reading even a stale supplied video resource", () => {
    const motion = document(transformBinding("shape"));
    motion.layers.push({ id: "video", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000 });
    const staleResources = new Proxy({}, { get() { throw new Error("stale video resource must not be read"); } }) as import("./gpu-scene-2d-plan").GpuScene2dCompileResources;
    expect(compileGpuSceneBehaviorFramePlan(motion, 500_001, staleResources)).toEqual({ ok: false, failure: { code: "gpu_unsupported_feature", message: "GPU behavior composition does not combine document behaviors@1 with video sources before exact behavior video request binding exists." } });
  });

  it("refuses a huge low-fps video timeline that cannot round-trip from atUs through legacy atMs", () => {
    const atUs = 9_000_000_000_000_001;
    const motion = document(transformBinding("shape"));
    motion.durationMs = 9_000_000_000_001;
    motion.fps = 1;
    motion.layers.push({ id: "video", type: "video", assetRef: "assets/long.mp4", startMs: 0, durationMs: motion.durationMs });
    expect(gpuVideoTimelineAtUs(atUs / 1_000)).not.toBe(atUs);
    expect(compileGpuSceneBehaviorFramePlan(motion, atUs)).toEqual({ ok: false, failure: { code: "gpu_invalid_time", message: "GPU behavior composition atUs cannot round-trip through the legacy GPU millisecond ABI." } });
  });

  it("preserves ordinary exact microsecond times through the legacy mapping", () => {
    const atUs = 500_001;
    expect(gpuVideoTimelineAtUs(atUs / 1_000)).toBe(atUs);
    expect(compileGpuSceneBehaviorFramePlan(document(transformBinding("shape")), atUs)).toMatchObject({ ok: true, plan: { atUs } });
  });
});

function document(binding?: NonNullable<MotionDocument["behaviors"]>["bindings"][number]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gpu-behavior-composition", name: "GPU behavior composition", durationMs: 1_000, fps: 30, width: 160, height: 90, background: "#102030", assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ff0000", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 20, width: 20, height: 10 } }],
    ...(binding ? { behaviors: { schema: "shellx-motion/behaviors@1", bindings: [binding] } } : {}),
  };
}
function transformBinding(targetLayerId: string) {
  return { targetLayerId, enabled: true, kind: "transform" as const, startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity" as const, velocityX: 100, velocityY: 0, gravityY: 0 } };
}
function pathBinding(targetLayerId: string) {
  return { targetLayerId, enabled: true, kind: "path-follow" as const, startUs: 0, durationUs: 1_000_000, orientToPath: true, geometry: { schema: "shellx-motion/shape-geometry@1" as const, kind: "path" as const, viewBox: { x: 0, y: 0, width: 100, height: 100 }, data: "M 0 0 L 100 0 L 100 100 Z" } };
}
