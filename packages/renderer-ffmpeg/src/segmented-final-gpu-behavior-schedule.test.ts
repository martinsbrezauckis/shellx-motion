import { type MotionDocument } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { MAX_GPU_BEHAVIOR_RENDER_SEGMENT_STORE_MANIFEST_BYTES } from "./segmented-final-internal/render-segment-store.js";
import { MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES } from "./segmented-final-internal/render-segment-gpu-behavior-types.js";
import { compileSegmentedGpuBehaviorSchedule } from "./segmented-final-gpu-behavior-schedule.js";

describe("segmented GPU behavior schedule", () => {
  it("derives every durable fact from the Core behavior wrapper at canonical timestamps", () => {
    const schedule = compileSegmentedGpuBehaviorSchedule({ motion: document(), timeline: { motionSha256: "0".repeat(64), frameCount: 2, durationMs: 1_000, fps: 2, width: 16, height: 16 }, resources: { images: new Map(), fonts: new Map() } as never });
    expect(schedule.frames).toMatchObject([{ index: 0, atMs: 0, atUs: 0 }, { index: 1, atMs: 500, atUs: 500_000 }]);
    expect(schedule.frames.every((frame) => /^[a-f0-9]{64}$/.test(frame.fingerprint) && /^[a-f0-9]{64}$/.test(frame.budgetSha256))).toBe(true);
  });

  it("refuses the distinct pre-store frame ceiling before reading source or allocating schedule facts", () => {
    const source = new Proxy({}, { get() { throw new Error("oversize schedule must not read Motion"); } }) as MotionDocument;
    expect(() => compileSegmentedGpuBehaviorSchedule({ motion: source, timeline: { frameCount: MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES + 1 } as never, resources: new Proxy({}, { get() { throw new Error("oversize schedule must not read resources"); } }) as never })).toThrow(`at most ${MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES}`);
    expect(MAX_GPU_BEHAVIOR_RENDER_SEGMENT_STORE_MANIFEST_BYTES).toBeGreaterThan(MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES * 512);
  });
});

function document(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "behavior-schedule", name: "Behavior schedule", durationMs: 1_000, fps: 2, width: 16, height: 16,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#fff", width: 4, height: 4, transform: { x: 1, y: 1 }, startMs: 0, durationMs: 1_000 }],
    behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] }
  };
}
