import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY,
  LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256,
  compareLinearSrgbSdrFinalFrames,
} from "./linear-srgb-sdr-final-compare.js";

describe("strict linear-sRGB SDR decoded-frame comparison", () => {
  it("accepts an exact opaque retained/decode pair and binds both byte identities", () => {
    const source = Buffer.from([0, 16, 255, 255, 8, 32, 128, 255]);
    const compared = compareLinearSrgbSdrFinalFrames({ width: 2, height: 1, source, decoded: Buffer.from(source) });
    expect(compared).toMatchObject({
      width: 2,
      height: 1,
      rgb: { sampleCount: 6, maximumChannelDelta: 0, meanAbsoluteChannelDelta: 0, materialDeltaSampleCount: 0, materialDeltaSampleRatio: 0 },
      alpha: { mismatchedPixelCount: 0 },
      accepted: true,
    });
    expect(compared.sourceSha256).toBe(compared.decodedSha256);
    expect(compared.policySha256).toBe(LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256);
    expect(compared.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(compared.rgb)).toBe(true);
  });

  it("accepts bounded yuv420 loss but rejects material full-frame drift", () => {
    const source = opaqueFrame(4, 4, [64, 96, 128]);
    const bounded = Buffer.from(source);
    for (let offset = 0; offset < bounded.byteLength; offset += 4) {
      bounded[offset] = 60;
      bounded[offset + 1] = 101;
      bounded[offset + 2] = 120;
    }
    expect(compareLinearSrgbSdrFinalFrames({ width: 4, height: 4, source, decoded: bounded }).accepted).toBe(true);

    const drifted = opaqueFrame(4, 4, [160, 192, 224]);
    const rejected = compareLinearSrgbSdrFinalFrames({ width: 4, height: 4, source, decoded: drifted });
    expect(rejected.accepted).toBe(false);
    expect(rejected.rgb.meanAbsoluteChannelDelta).toBeGreaterThan(LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY.rgb.maximumMeanAbsoluteChannelDelta);
    expect(rejected.rgb.materialDeltaSampleRatio).toBe(1);
  });

  it("rejects any non-opaque source or inverse decode", () => {
    const source = Buffer.from([1, 2, 3, 254]);
    const decoded = Buffer.from([1, 2, 3, 255]);
    const compared = compareLinearSrgbSdrFinalFrames({ width: 1, height: 1, source, decoded });
    expect(compared).toMatchObject({ alpha: { mismatchedPixelCount: 1 }, accepted: false });
  });

  it("refuses dimension and tight-frame mismatches before comparison", () => {
    expect(() => compareLinearSrgbSdrFinalFrames({ width: 0, height: 1, source: Buffer.alloc(0), decoded: Buffer.alloc(0) })).toThrow("bounded positive");
    expect(() => compareLinearSrgbSdrFinalFrames({ width: 1, height: 1, source: Buffer.alloc(4), decoded: Buffer.alloc(3) })).toThrow("tightly packed");
    expect(() => compareLinearSrgbSdrFinalFrames({ width: 1921, height: 1, source: Buffer.alloc(4), decoded: Buffer.alloc(4) })).toThrow("bounded positive");
  });

  it("freezes and fingerprints the fixed qualification-gated policy", () => {
    expect(LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256).toBe(canonicalJsonSha256(LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY));
    expect(Object.isFrozen(LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY.rgb)).toBe(true);
    expect(LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY).toMatchObject({
      source: "retained-straight-srgb-rgba8",
      decoded: "bt709-limited-yuv420p-inverse-to-straight-srgb-rgba8",
      alpha: { expected: 255, maximumMismatchedPixels: 0 },
    });
  });
});

function opaqueFrame(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const frame = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < frame.byteLength; offset += 4) {
    frame[offset] = rgb[0]; frame[offset + 1] = rgb[1]; frame[offset + 2] = rgb[2]; frame[offset + 3] = 255;
  }
  return frame;
}
