import { describe, expect, it } from "vitest";
import {
  CHROMA_KEY_SCHEMA,
  ROTO_MASK_SCHEMA,
  ROTO_TRACKING_ATTACHMENT_SCHEMA,
} from "./keying";
import {
  applyMotionLayerChromaKey,
  detachMotionLayerRotoTracking,
  inspectMotionLayerKeying,
  removeMotionLayerChromaKey,
  removeMotionLayerRotoMask,
  upsertMotionLayerRotoMask,
} from "./keying-authoring";
import type { MotionDocument } from "./types";

const motion: MotionDocument = {
  schema: "shellx-motion/motion@1",
  id: "keying-authoring",
  name: "Keying authoring",
  durationMs: 1_000,
  fps: 30,
  width: 320,
  height: 180,
  layers: [{ id: "subject", type: "video", source: "assets/subject.mp4", startMs: 0, durationMs: 1_000 }],
  assets: [],
  provenance: { sourceApp: "shellx-motion", createdBy: "test" },
};

describe("keying and roto authoring", () => {
  it("applies and removes chroma key without mutating source state", () => {
    const applied = applyMotionLayerChromaKey(motion, "subject", {
      schema: CHROMA_KEY_SCHEMA,
      keyColor: "#00ff00",
      spillSuppression: 0.8,
    });
    expect(motion.layers[0].keying).toBeUndefined();
    expect(applied.changedPaths).toEqual(["/layers/0/keying"]);
    expect(applied.state.keying?.keyColor).toBe("#00ff00");

    const removed = removeMotionLayerChromaKey(applied.motion, "subject");
    expect(removed.state.keying).toBeNull();
    expect(applied.motion.layers[0].keying).toBeDefined();
  });

  it("upserts tracked roto, detaches only tracking, then removes the mask", () => {
    const upserted = upsertMotionLayerRotoMask(motion, "subject", {
      type: "roto",
      schema: ROTO_MASK_SCHEMA,
      closed: true,
      frames: [{
        atMs: 0,
        vertices: [
          { id: "a", x: 0.1, y: 0.1 },
          { id: "b", x: 0.9, y: 0.1 },
          { id: "c", x: 0.5, y: 0.9 },
        ],
      }],
      tracking: {
        schema: ROTO_TRACKING_ATTACHMENT_SCHEMA,
        analysisId: "subject-track",
        sourceSha256: "a".repeat(64),
        segmentIndex: 0,
        model: "similarity",
      },
    });
    expect(upserted.state.trackingAttached).toBe(true);

    const detached = detachMotionLayerRotoTracking(upserted.motion, "subject");
    expect(detached.state.trackingAttached).toBe(false);
    expect(detached.state.roto?.frames).toEqual(upserted.state.roto?.frames);
    expect(upserted.state.trackingAttached).toBe(true);

    const removed = removeMotionLayerRotoMask(detached.motion, "subject");
    expect(removed.state.roto).toBeNull();
  });

  it("rejects invalid media/keying combinations and preserves input", () => {
    const shapeMotion = structuredClone(motion);
    shapeMotion.layers[0].type = "shape";
    expect(() => applyMotionLayerChromaKey(shapeMotion, "subject", {
      schema: CHROMA_KEY_SCHEMA,
      keyColor: "#00ff00",
    })).toThrow(/image or video/);
    expect(inspectMotionLayerKeying(shapeMotion, "subject").keying).toBeNull();
  });
});
