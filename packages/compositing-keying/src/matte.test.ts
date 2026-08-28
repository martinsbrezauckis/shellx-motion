import { describe, expect, it } from "vitest";
import { cleanupMatte } from "./matte";

const defaults = {
  denoiseRadiusPx: 0,
  growShrinkPx: 0,
  chokePx: 0,
  featherPx: 0,
  blackClip: 0,
  whiteClip: 1,
};

describe("bounded matte cleanup", () => {
  it("grows, shrinks, chokes, and feathers without changing dimensions", () => {
    const source = new Uint8Array([
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 255, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ]);
    const grown = cleanupMatte(source, 5, 5, { ...defaults, growShrinkPx: 1 });
    expect([...grown.alpha].filter((value) => value === 255)).toHaveLength(9);
    const feathered = cleanupMatte(grown.alpha, 5, 5, { ...defaults, featherPx: 1 });
    expect(feathered.alpha).toHaveLength(25);
    expect([...feathered.alpha].some((value) => value > 0 && value < 255)).toBe(true);
    const choked = cleanupMatte(grown.alpha, 5, 5, { ...defaults, chokePx: 1 });
    expect([...choked.alpha].filter((value) => value === 255)).toHaveLength(1);
  });

  it("denoises isolated alpha noise and applies black/white cleanup", () => {
    const source = new Uint8Array(25);
    source[12] = 255;
    const cleaned = cleanupMatte(source, 5, 5, {
      ...defaults,
      denoiseRadiusPx: 1,
      blackClip: 0.2,
      whiteClip: 0.8,
    });
    expect(cleaned.alpha[12]).toBe(0);
    expect(cleaned.evidence).toMatchObject({ denoiseRadiusPx: 1, blackClip: 0.2, whiteClip: 0.8 });
  });

  it("pins the promoted bounded cleanup profile to deterministic alpha pixels", () => {
    const source = new Uint8Array([0, 255, 0, 0, 0, 0, 0, 0, 255]);
    const cleaned = cleanupMatte(source, 3, 3, {
      denoiseRadiusPx: 1,
      growShrinkPx: -1,
      chokePx: 1,
      featherPx: 2,
      blackClip: 0.04,
      whiteClip: 0.96,
    });
    expect(Array.from(cleaned.alpha)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cleaned.evidence).toMatchObject({ denoiseRadiusPx: 1, growShrinkPx: -1, chokePx: 1, featherPx: 2, blackClip: 0.04, whiteClip: 0.96 });
  });

  it("rejects malformed or over-budget matte buffers", () => {
    expect(() => cleanupMatte(new Uint8Array(3), 2, 2, defaults)).toThrow(/byte length/);
    expect(() => cleanupMatte(new Uint8Array(1), 9_000_000, 1, defaults)).toThrow(/dimensions/);
  });
});
