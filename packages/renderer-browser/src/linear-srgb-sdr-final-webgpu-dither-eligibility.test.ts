import { describe, expect, it } from "vitest";
import {
  resolveLinearSrgbSdrFinalRoute,
  sampleLinearSrgbGradient,
  type LinearSrgbSdrFinalRoute,
  type LinearSrgbSdrFinalRouteRequest,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { MotionDocument } from "@shellx-motion/core";
import {
  LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER,
  linearSrgbSdrPublicationDitherEligible,
  linearSrgbSdrPublicationDitherOffset,
} from "./linear-srgb-sdr-final-webgpu-contract";
import { renderLinearSrgbSdrFinalReferenceFrame } from "./linear-srgb-sdr-final-webgpu-reference";

const REQUEST: LinearSrgbSdrFinalRouteRequest = Object.freeze({ target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
const CENTER = [0.5, 0.5, 0.5] as const;
const neighbour = (delta: number) => [0.5 + delta, 0.5 + delta, 0.5 + delta] as const;

describe("strict SDR publication-dither CPU eligibility", () => {
  it("uses the maximum local delta for mixed sharp/smooth edges and reference pixels", () => {
    const minimum = LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.smoothness.minimum;
    const maximum = LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.smoothness.maximum;
    const base = { gradientCoverage: 1, encodedRgb: CENTER, alpha: 1 };
    expect(linearSrgbSdrPublicationDitherEligible({ ...base, neighbouringEncodedRgb: [neighbour(minimum / 2), CENTER, CENTER, CENTER] })).toBe(false);
    expect(linearSrgbSdrPublicationDitherEligible({ ...base, neighbouringEncodedRgb: [neighbour(minimum * 2), CENTER, CENTER, CENTER] })).toBe(true);
    expect(linearSrgbSdrPublicationDitherEligible({ ...base, neighbouringEncodedRgb: [neighbour(maximum), CENTER, CENTER, CENTER] })).toBe(true);
    expect(linearSrgbSdrPublicationDitherEligible({ ...base, neighbouringEncodedRgb: [neighbour(0.001), neighbour(0.1), CENTER, CENTER] })).toBe(false);
    expect(linearSrgbSdrPublicationDitherEligible({ ...base, neighbouringEncodedRgb: [neighbour(maximum + 0.000_001), CENTER, CENTER, CENTER] })).toBe(false);

    const route = mixedEdgeRoute(), gradient = route.rects[0];
    if (!gradient || !("gradient" in gradient)) throw new Error("expected one gradient");
    const source = sampleLinearSrgbGradient(gradient.gradient, 0.25, 0.5);
    const undithered = Math.round(source.r * 255), frame = renderLinearSrgbSdrFinalReferenceFrame(route);
    const wouldDither = Array.from({ length: route.canvas.height }, (_, y) => Math.round((source.r + linearSrgbSdrPublicationDitherOffset(1, y)) * 255));
    expect(wouldDither.some((channel) => channel !== undithered)).toBe(true);
    for (let y = 0; y < route.canvas.height; y += 1) expect([...frame.subarray((y * route.canvas.width + 1) * 4, (y * route.canvas.width + 2) * 4)]).toEqual([undithered, undithered, undithered, 255]);
  });
});

function mixedEdgeRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-dither-mixed-edge", name: "Strict dither mixed edge", durationMs: 1_000, fps: 30, width: 4, height: 64,
    background: "#000000", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "dither-eligibility" },
    layers: [{ id: "smooth-edge", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#7f7f7f" }, { offset: 1, color: "#818181" }] }, transform: { x: 1, y: 0, width: 2, height: 64 } }],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}
