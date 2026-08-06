import { describe, expect, it } from "vitest";
import type { MotionDocument, MotionLayer } from "./types";

describe("MotionIR type compatibility", () => {
  it("allows host and lane extension fields on documents and layers", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      startMs: 0,
      durationMs: 1000,
      text: "Anna",
      trackId: "overlay",
      "x-shellx-cut": { track: "overlay" }
    };
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion_extension_fields",
      name: "Extension Fields",
      durationMs: 1000,
      fps: 30,
      width: 1920,
      height: 1080,
      tracks: [{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }],
      scenes: [{ id: "intro", name: "Intro", startMs: 0, durationMs: 1000, trackIds: ["overlay"], markerIds: ["beat"] }],
      markers: [{ id: "beat", atMs: 500, label: "Beat", type: "beat" }],
      layers: [layer],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      "x-shellx-canvas": { sourceFrameId: "frame_1" }
    };

    expect(motion.layers[0].id).toBe("title");
  });
});
