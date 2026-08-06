import { describe, expect, it } from "vitest";
import { CHROMA_KEY_SCHEMA } from "@shellx-motion/core";
import { applyChromaKeyFrame } from "./keyer";

describe("bounded chroma key", () => {
  it("separates green, preserves foreground, and suppresses edge spill", () => {
    const rgba = new Uint8Array([
      0, 255, 0, 255,
      28, 220, 32, 255,
      220, 40, 35, 255,
      16, 96, 18, 255,
    ]);
    const result = applyChromaKeyFrame({
      rgba,
      width: 4,
      height: 1,
      keying: {
        schema: CHROMA_KEY_SCHEMA,
        keyColor: "#00ff00",
        similarity: 0.12,
        smoothness: 0.22,
        shadow: 0.5,
        spillSuppression: 0.9,
        edgeColorCorrection: 0.5,
      },
    });
    expect(result.matte[0]).toBe(0);
    expect(result.matte[2]).toBe(255);
    expect(result.rgba[5]).toBeLessThan(rgba[5]);
    expect(result.evidence.spillAdjustedPixels).toBeGreaterThan(0);
    expect(result.evidence.pixels).toBe(4);
  });

  it("keeps source alpha as an upper bound", () => {
    const result = applyChromaKeyFrame({
      rgba: new Uint8Array([255, 0, 0, 64]),
      width: 1,
      height: 1,
      keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00" },
    });
    expect(result.rgba[3]).toBeLessThanOrEqual(64);
  });

  it("does not let matte growth resurrect transparent source pixels", () => {
    const result = applyChromaKeyFrame({
      rgba: new Uint8Array([
        255, 0, 0, 255,
        255, 0, 0, 0,
        0, 255, 0, 255,
      ]),
      width: 3,
      height: 1,
      keying: {
        schema: CHROMA_KEY_SCHEMA,
        keyColor: "#00ff00",
        matte: { growShrinkPx: 1 },
      },
    });
    expect(result.matte[1]).toBe(0);
    expect(result.rgba[7]).toBe(0);
  });

  it("rejects out-of-contract controls before processing pixels", () => {
    expect(() => applyChromaKeyFrame({
      rgba: new Uint8Array([0, 255, 0, 255]),
      width: 1,
      height: 1,
      keying: {
        schema: CHROMA_KEY_SCHEMA,
        keyColor: "#00ff00",
        similarity: 4,
      },
    })).toThrow(/similarity/);
  });

  it("rejects malformed RGBA buffers", () => {
    expect(() => applyChromaKeyFrame({
      rgba: new Uint8Array(3),
      width: 1,
      height: 1,
      keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00" },
    })).toThrow(/byte length/);
  });
});
