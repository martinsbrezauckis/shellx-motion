/** Boundary tests for shared SVG shape and path-mask geometry validation. */
import { describe, expect, it } from "vitest";
import { parseMotionPathViewBox, validateMotionPathData } from "./path-contract";

describe("Motion path contract", () => {
  it("normalizes bounded complete path and viewBox inputs", () => {
    expect(validateMotionPathData(" M 0 0 C 25 0 75 100 100 100 Z ")).toBe("M 0 0 C 25 0 75 100 100 100 Z");
    expect(parseMotionPathViewBox("0, 0, 640, 360")).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      normalized: "0 0 640 360"
    });
  });

  it("rejects residue, incomplete commands, bad arcs, and extreme coordinates", () => {
    expect(() => validateMotionPathData("M0 0<script>")).toThrow("unsupported path syntax");
    expect(() => validateMotionPathData("M0 0 C 1 2")).toThrow("incomplete C command");
    expect(() => validateMotionPathData("M0 0 A 5 5 0 2 0 10 10")).toThrow("invalid arc radii or flags");
    expect(() => validateMotionPathData("M0 0 L 1000000001 1")).toThrow("invalid L parameters");
  });

  it("rejects missing, non-finite, non-positive, and extreme viewBoxes", () => {
    expect(() => parseMotionPathViewBox(undefined)).toThrow("four bounded numbers");
    expect(() => parseMotionPathViewBox("0 0 NaN 10")).toThrow("finite x/y and positive width/height");
    expect(() => parseMotionPathViewBox("0 0 0 10")).toThrow("finite x/y and positive width/height");
    expect(() => parseMotionPathViewBox("1000000001 0 10 10")).toThrow("finite x/y and positive width/height");
  });
});
