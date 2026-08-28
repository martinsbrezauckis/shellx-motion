import { describe, expect, it } from "vitest";
import { matchRendererCapability, NATIVE_CAPABILITY, type MotionDocument } from "@shellx-motion/core";

describe("native fixed-adjustment preflight", () => {
  it("refuses fixed vignette and film-grain layers before native raster work", () => {
    const motion = {
      schema: "shellx-motion/motion@1", id: "native-fixed-adjustment", name: "Native fixed adjustment", durationMs: 1_000, fps: 30, width: 100, height: 60,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [
        { id: "plate", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 },
        { id: "finish", type: "adjustment", startMs: 0, durationMs: 1_000, effects: { vignette: { amount: 0.7, softness: 0.45, color: "#10203080" }, filmGrain: { amount: 0.25, size: 3, seed: 42 } } },
      ],
    } as MotionDocument;
    expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [{ layerId: "finish", feature: "layer.type:adjustment", reason: "Lane native does not support adjustment layers." }],
    });
  });
});
