import { describe, expect, it } from "vitest";
import {
  alignedTextStartX,
  alignedTextStartY,
  layoutNativeTextLines,
  lineHeightPixels,
  measureNativeText
} from "./native-text-layout";

describe("native block-glyph text layout", () => {
  it("preserves hard-line normalization, word wrapping, and long-word splitting", () => {
    expect(layoutNativeTextLines("ONE TWO\r\nTHREE", null, 5, 1)).toEqual(["ONE TWO", "THREE"]);
    expect(layoutNativeTextLines("ONE TWO THREE", 30, 5, 1)).toEqual(["ONE", "TWO", "THREE"]);
    expect(layoutNativeTextLines("SHELLX", 17, 5, 1)).toEqual(["SHE", "LLX"]);
  });

  it("uses the rasterizer's tab width and alignment math", () => {
    expect(measureNativeText("A\tB", 5, 1)).toBe(35);
    expect(alignedTextStartX(10, "A", 20, 5, 1, "center")).toBe(17.5);
    expect(alignedTextStartX(10, "A", 20, 5, 1, "right")).toBe(25);
    expect(alignedTextStartY(10, 2, 30, 8, 7, "middle")).toBe(17.5);
    expect(alignedTextStartY(10, 2, 30, 8, 7, "bottom")).toBe(25);
  });

  it("keeps CSS-like line-height inputs pinned to block-glyph pixel rows", () => {
    expect(lineHeightPixels("120%", 16, 1, 14)).toBe(19);
    expect(lineHeightPixels("20px", 16, 1, 14)).toBe(20);
    expect(lineHeightPixels(undefined, 16, 1, 14)).toBe(18);
  });
});
