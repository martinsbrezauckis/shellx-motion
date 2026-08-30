import { describe, expect, it } from "vitest";
import {
  BROWSER_CAPABILITY,
  GPU_CAPABILITY,
  NATIVE_CAPABILITY,
  matchRendererCapability,
  matchRendererCapabilityCards
} from "./capabilities";
import type { MotionDocument } from "./types";

describe("gradient capability matching", () => {
  it("selects Browser for a radial-gradient ellipse and refuses the strict GPU and Native lanes", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion_gradient_glow",
      name: "Gradient glow",
      durationMs: 1000,
      fps: 30,
      width: 960,
      height: 540,
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      layers: [{
        id: "gradient-glow",
        type: "shape",
        shape: "ellipse",
        startMs: 0,
        durationMs: 1000,
        transform: { x: 120, y: 80, width: 480, height: 360 },
        gradient: {
          type: "radial",
          centerX: 0.5,
          centerY: 0.5,
          stops: [{ offset: 0, color: "#3f7fe0" }, { offset: 1, color: "#080b14" }]
        }
      }]
    };

    expect(matchRendererCapabilityCards(motion, { target: "preview", output: "png-frame" })).toMatchObject({
      recommendedLane: "browser",
      matches: expect.arrayContaining([expect.objectContaining({ lane: "browser", ok: true })])
    });
    expect(matchRendererCapability(motion, BROWSER_CAPABILITY)).toMatchObject({ ok: true, lane: "browser" });
    expect(matchRendererCapability(motion, GPU_CAPABILITY)).toMatchObject({ ok: false, lane: "gpu" });
    expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toMatchObject({
      ok: false,
      lane: "native",
      unsupported: [expect.objectContaining({ layerId: "gradient-glow", feature: "shape.gradient" })]
    });
  });
});
