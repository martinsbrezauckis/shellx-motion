import { describe, expect, it } from "vitest";
import { parseGpuSceneColor } from "./gpu-scene-color";

describe("parseGpuSceneColor", () => {
  it("preserves the bounded authored rgb and rgba subset without quantizing decimal alpha", () => {
    expect(parseGpuSceneColor("rgb(2, 8, 23)")).toEqual({ r: 2 / 255, g: 8 / 255, b: 23 / 255, a: 1 });
    expect(parseGpuSceneColor("rgba(192, 132, 252, 0.3)")).toEqual({ r: 192 / 255, g: 132 / 255, b: 252 / 255, a: 0.3 });
    expect(parseGpuSceneColor("rgba(100%, 50%, 0%, 68%)")).toEqual({ r: 1, g: 0.5, b: 0, a: 0.68 });
  });

  it("refuses incomplete, alternate, and out-of-range CSS forms before GPU planning", () => {
    for (const value of ["rgba(2, 8, 23)", "rgb(2, 8, 23, 0.3)", "rgba(.3, 8, 23, 0.3)", "rgba(02, 8, 23, 0.3)", "rgba(256, 8, 23, 0.3)", "rgba(2, 8, 23, 1.01)", "rgba(2, 8, 23, 3e-1)"]) {
      expect(parseGpuSceneColor(value), value).toBeNull();
    }
  });
});
