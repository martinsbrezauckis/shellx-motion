import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileTrackingStabilization, type TrackingAnalysis } from "./tracking-analysis";
import {
  applyTrackingStabilization,
  detachTrackingStabilization,
  readTrackingStabilizationAttachment,
  verifyTrackingStabilization,
} from "./tracking-application";
import type { MotionDocument } from "./types";

describe("reversible tracking stabilization application", () => {
  it("requires an explicit segment for partial analysis and restores exact prior keyframes on detach", async () => {
    const analysis = JSON.parse(await readFile(resolve("../../fixtures/tracking/similarity-known.tracking.json"), "utf8")) as TrackingAnalysis;
    const motion = document();
    const plan = compileTrackingStabilization({ analysis, targetLayerId: "plate" });

    expect(() => applyTrackingStabilization({ motion, plan })).toThrow("explicit confidence-qualified segmentIndex");
    const applied = applyTrackingStabilization({ motion, plan, segmentIndex: 0 });

    expect(motion.layers[0].keyframes).toEqual({
      "transform.x": [{ atMs: 0, value: 5, easing: "ease-in" }],
      opacity: [{ atMs: 0, value: 1 }],
    });
    expect(applied.motion.layers[0].keyframes).toMatchObject({
      "transform.x": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 100, value: -10, easing: "linear" },
      ],
      "transform.y": expect.any(Array),
      "transform.scale": expect.any(Array),
      "transform.rotation": expect.any(Array),
      opacity: [{ atMs: 0, value: 1 }],
    });
    expect(readTrackingStabilizationAttachment(applied.motion.layers[0])).toMatchObject({
      schema: "shellx-motion/tracking-stabilization-attachment@1",
      analysisId: analysis.id,
      segmentIndex: 0,
      previousKeyframes: {
        "transform.x": [{ atMs: 0, value: 5, easing: "ease-in" }],
        "transform.y": null,
        "transform.scale": null,
        "transform.rotation": null,
      },
    });
    expect(verifyTrackingStabilization({
      motion: applied.motion,
      layerId: "plate",
      analysisId: analysis.id,
      sourceSha256: analysis.source.sha256,
    })).toMatchObject({ attached: true, current: true, mismatchedTargets: [], reasons: [] });

    const detached = detachTrackingStabilization({ motion: applied.motion, layerId: "plate" });
    expect(detached.motion.layers[0].keyframes).toEqual({
      "transform.x": [{ atMs: 0, value: 5, easing: "ease-in" }],
      opacity: [{ atMs: 0, value: 1 }],
    });
    expect(readTrackingStabilizationAttachment(detached.motion.layers[0])).toBeNull();
  });

  it("detects stale source identity and post-application keyframe edits", async () => {
    const analysis = JSON.parse(await readFile(resolve("../../fixtures/tracking/homography-known.tracking.json"), "utf8")) as TrackingAnalysis;
    const plan = compileTrackingStabilization({ analysis, targetLayerId: "plate" });
    const applied = applyTrackingStabilization({ motion: document(), plan });
    applied.motion.layers[0].keyframes!["transform.x"]![0].value = 999;

    expect(verifyTrackingStabilization({
      motion: applied.motion,
      layerId: "plate",
      sourceSha256: "0".repeat(64),
    })).toMatchObject({
      attached: true,
      current: false,
      mismatchedTargets: ["transform.x"],
      reasons: ["source_identity_mismatch", "generated_keyframes_changed"],
    });
  });

  it("refuses mutation of locked or already-attached layers", async () => {
    const analysis = JSON.parse(await readFile(resolve("../../fixtures/tracking/homography-known.tracking.json"), "utf8")) as TrackingAnalysis;
    const plan = compileTrackingStabilization({ analysis, targetLayerId: "plate" });
    const locked = document();
    locked.layers[0].locked = true;
    expect(() => applyTrackingStabilization({ motion: locked, plan })).toThrow("is locked");

    const applied = applyTrackingStabilization({ motion: document(), plan });
    expect(() => applyTrackingStabilization({ motion: applied.motion, plan })).toThrow("already attached");
  });
});

function document(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_tracking_apply",
    name: "Tracking Apply",
    durationMs: 500,
    fps: 30,
    width: 640,
    height: 360,
    layers: [{
      id: "plate",
      type: "video",
      startMs: 0,
      durationMs: 500,
      assetId: "footage_similarity",
      keyframes: {
        "transform.x": [{ atMs: 0, value: 5, easing: "ease-in" }],
        opacity: [{ atMs: 0, value: 1 }],
      },
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "tracking-application.test" },
  };
}
