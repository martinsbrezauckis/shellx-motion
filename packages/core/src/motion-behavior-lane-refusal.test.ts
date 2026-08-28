import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY, matchRendererCapability, NATIVE_CAPABILITY, unrenderablePackageRefusal } from "./capabilities";
import { motionBehaviorLaneRefusal } from "./motion-behavior-lane-refusal";
import type { MotionDocument } from "./types";

describe("behavior legacy-lane refusal", () => {
  it("keeps browser/native refused while GPU composition makes active and disabled stores renderable", () => {
    for (const enabled of [true, false]) {
      const motion = document(enabled);
      expect(motionBehaviorLaneRefusal(motion, "browser")).toMatchObject({
        schema: "shellx-motion/motion-behavior-lane-refusal@1",
        code: "motion_behaviors_unavailable",
        feature: "motion.behaviors@1",
        message: "Browser rendering does not yet support document behaviors@1.",
      });
      expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toEqual({
        ok: false,
        lane: "native",
        unsupported: [{
          layerId: "__motion_behaviors__",
          feature: "motion.behaviors@1",
          reason: "Native rendering does not yet support document behaviors@1.",
        }],
      });
      expect(matchRendererCapability(motion, GPU_CAPABILITY)).toEqual({ ok: true, lane: "gpu", unsupported: [] });
      expect(unrenderablePackageRefusal(motion)).toBeNull();
    }
  });

  it("reports behavior composition refusal as package renderability truth", () => {
    const motion = document(true);
    motion.layers[0]!.effects = { motionBlur: { samples: 2, shutterAngle: 180 } };
    expect(unrenderablePackageRefusal(motion)).toMatchObject({
      code: "package_unrenderable",
      message: expect.stringContaining("shutter samples evaluate behaviors"),
      layers: [{ layerId: "__motion_behaviors__", type: "document_behavior_store" }],
    });
  });

  it("leaves absent behavior stores on the legacy capability path", () => {
    const motion = document();
    expect(motionBehaviorLaneRefusal(motion, "native")).toBeUndefined();
    expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
    expect(unrenderablePackageRefusal(motion)).toBeNull();
  });
});

function document(enabled?: boolean): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "behavior-lane", name: "Behavior lane", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 }],
    ...(enabled === undefined ? {} : { behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] } }),
  };
}
