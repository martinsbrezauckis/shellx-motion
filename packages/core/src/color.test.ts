import { describe, expect, it } from "vitest";
import {
  isSupportedMotionColorString,
  isVisibleMotionColorString,
  MAX_MOTION_COLOR_STRING_LENGTH,
  parseMotionColorString,
} from "./color";

describe("bounded Motion color parser", () => {
  it("preserves the declared legacy grammar inside the raw bound", () => {
    for (const value of [
      "#abc", "#abcd", "#aabbcc", "#aabbccdd", "transparent", "currentColor", "orange",
      "rgb(1, 2, 3)", "rgba(1,2,3,50%)", "hsl(210 50% 40%)", "hsla(210, 50%, 40%, .5)",
      "rgb(,,,,)", "rgb(1 2 3 / 0)",
    ]) expect(isSupportedMotionColorString(value), value).toBe(true);
  });

  it("refuses long whitespace, comma, percentage, and functional near misses before scanning", () => {
    const over = " ".repeat(MAX_MOTION_COLOR_STRING_LENGTH + 1);
    for (const value of [
      over,
      `rgb(${" ".repeat(MAX_MOTION_COLOR_STRING_LENGTH)})`,
      `rgba(0,0,0,${"%".repeat(MAX_MOTION_COLOR_STRING_LENGTH)})`,
      `rgb(${",".repeat(MAX_MOTION_COLOR_STRING_LENGTH)}`,
      "rgb(1,2,3))",
      "rgb((1,2,3)",
      "rgb(1,2,three)",
      "color(display-p3 1 0 0)",
    ]) expect(parseMotionColorString(value), value.slice(0, 32)).toBeNull();
    expect(parseMotionColorString(`rgb(0,0,0)${"\u2000".repeat(40)}`)).toBeNull();
  });

  it("centralizes zero-alpha visibility across hex, comma, and slash forms", () => {
    for (const value of ["transparent", "currentColor", "#fff0", "#ffffff00", "rgba(1,2,3,0)", "rgb(1 2 3 / 0%)", "hsl(1 2% 3% / -0.0)"]) {
      expect(isVisibleMotionColorString(value), value).toBe(false);
    }
    for (const value of ["#fff1", "#ffffff01", "rgba(1,2,3,.1)", "rgb(1 2 3 / 50%)", "red"]) {
      expect(isVisibleMotionColorString(value), value).toBe(true);
    }
  });
});
