import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  resolveLinearSrgbSdrFinalRoute,
  type LinearSrgbSdrFinalRoute,
  type LinearSrgbSdrFinalRouteRequest,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { MotionDocument } from "@shellx-motion/core";
import {
  buildLinearSrgbSdrFinalReferenceDitherMask,
  LINEAR_SRGB_SDR_FINAL_F2A_REFERENCE_DITHER_MASK_BYTES,
  linearSrgbSdrFinalReferenceDitherMaskBit,
} from "./linear-srgb-sdr-final-webgpu-reference";

const REQUEST: LinearSrgbSdrFinalRouteRequest = Object.freeze({ target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });

describe("strict F2a reference dither mask", () => {
  it("packs the completed eligibility predicate as a literal 1280x720 row-major bitset", () => {
    const mask = buildLinearSrgbSdrFinalReferenceDitherMask(route("gradient"));
    expect(mask.packedRowMajorBits).toHaveLength(LINEAR_SRGB_SDR_FINAL_F2A_REFERENCE_DITHER_MASK_BYTES);
    expect(mask.eligibleCount).toBe(1280 * 720);
    expect(mask.packedRowMajorBits.every((byte) => byte === 0xff)).toBe(true);
    expect(linearSrgbSdrFinalReferenceDitherMaskBit(mask, 0, 0)).toBe(true);
    expect(linearSrgbSdrFinalReferenceDitherMaskBit(mask, 1279, 719)).toBe(true);
    expect(mask.sha256).toBe(createHash("sha256").update(mask.packedRowMajorBits).digest("hex"));
  });

  it("keeps a flat final route out of the producer-owned eligibility mask", () => {
    const mask = buildLinearSrgbSdrFinalReferenceDitherMask(route("flat"));
    expect(mask.eligibleCount).toBe(0);
    expect(mask.packedRowMajorBits.every((byte) => byte === 0)).toBe(true);
    expect(linearSrgbSdrFinalReferenceDitherMaskBit(mask, 640, 360)).toBe(false);
  });

  it("uses the documented least-significant-bit-first row-major membership order", () => {
    const packedRowMajorBits = Buffer.alloc(LINEAR_SRGB_SDR_FINAL_F2A_REFERENCE_DITHER_MASK_BYTES);
    packedRowMajorBits[0] = 0b1000_0001;
    packedRowMajorBits[1] = 0b0000_0010;
    const mask = { packedRowMajorBits, sha256: "a".repeat(64), eligibleCount: 3 };
    expect(linearSrgbSdrFinalReferenceDitherMaskBit(mask, 0, 0)).toBe(true);
    expect(linearSrgbSdrFinalReferenceDitherMaskBit(mask, 7, 0)).toBe(true);
    expect(linearSrgbSdrFinalReferenceDitherMaskBit(mask, 9, 0)).toBe(true);
    expect(linearSrgbSdrFinalReferenceDitherMaskBit(mask, 1, 0)).toBe(false);
  });

  it("refuses a nonliteral canvas before allocating an M1 mask", () => {
    expect(() => buildLinearSrgbSdrFinalReferenceDitherMask(route("gradient", 4, 2))).toThrow("literal 1280x720");
  });
});

function route(kind: "gradient" | "flat", width = 1280, height = 720): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: `strict-f2a-mask-${kind}-${width}x${height}`, name: "Strict F2a mask", durationMs: 2_000, fps: 30, width, height,
    background: "#101010", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "reference-mask" },
    layers: kind === "gradient"
      ? [{ id: "f2a-ramp", type: "shape", shape: "rect", startMs: 0, durationMs: 2_000, opacity: 1, gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#202020" }, { offset: 1, color: "#a0a0a0" }] }, transform: { x: 0, y: 0, width, height } }]
      : [{ id: "flat", type: "shape", shape: "rect", startMs: 0, durationMs: 2_000, opacity: 1, fill: "#406080", transform: { x: 0, y: 0, width, height } }],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}
