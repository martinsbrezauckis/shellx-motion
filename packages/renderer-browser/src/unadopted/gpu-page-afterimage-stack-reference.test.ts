import { describe, expect, it } from "vitest";
import { admitGpuPageAfterimageStackDescriptor } from "./gpu-page-afterimage-stack-admission";
import { evaluateGpuPageAfterimageStackPixel } from "./gpu-page-afterimage-stack-reference";
import { createGpuPageAfterimageStackFixture } from "./gpu-page-afterimage-stack.test-support";

const descriptor = admitGpuPageAfterimageStackDescriptor(createGpuPageAfterimageStackFixture({
  width: 4,
  height: 1,
  echoes: [
    { dxPx: 1, dyPx: 0, rgba8: [255, 0, 0, 255], opacityQ16: 32_768 },
    { dxPx: 1, dyPx: 0, rgba8: [0, 0, 255, 255], opacityQ16: 32_768 }
  ],
  amountQ16: 65_535
}));

describe("afterimage-stack alpha/edge pixel semantics", () => {
  it("puts ordered coloured echoes behind the unchanged opaque source", () => {
    if (!descriptor) throw new Error("fixture did not admit");
    const source = (x: number): readonly [number, number, number, number] => x === 0 ? [1, 1, 1, 1] : [0, 0, 0, 0];
    expect(evaluateGpuPageAfterimageStackPixel(descriptor, 0, 0, (x) => source(x))).toEqual([1, 1, 1, 1]);
    const echoed = evaluateGpuPageAfterimageStackPixel(descriptor, 1, 0, (x) => source(x));
    // echo[0] is front-most: red 0.5 over blue 0.5 yields red 0.5, blue 0.25.
    expect(echoed[0]).toBeCloseTo(32_768 / 65_535, 8);
    expect(echoed[1]).toBe(0);
    expect(echoed[2]).toBeCloseTo((32_767 / 65_535) * (32_768 / 65_535), 8);
    expect(echoed[3]).toBeCloseTo(1 - (1 - 32_768 / 65_535) ** 2, 8);
  });

  it("uses transparent out-of-bounds samples rather than clamping edge pixels", () => {
    if (!descriptor) throw new Error("fixture did not admit");
    const source = (x: number): readonly [number, number, number, number] => x === 0 ? [1, 1, 1, 1] : [0, 0, 0, 0];
    expect(evaluateGpuPageAfterimageStackPixel(descriptor, 0, 0, (x) => source(x))).toEqual([1, 1, 1, 1]);
    expect(evaluateGpuPageAfterimageStackPixel(descriptor, 3, 0, (x) => source(x))).toEqual([0, 0, 0, 0]);
  });

  it("preserves premultiplied source colour while alpha-derived echoes fill behind it", () => {
    if (!descriptor) throw new Error("fixture did not admit");
    const pixels: Record<number, readonly [number, number, number, number]> = {
      0: [0.2, 0.2, 0.2, 0.5],
      1: [0.1, 0.2, 0.3, 0.5]
    };
    const output = evaluateGpuPageAfterimageStackPixel(descriptor, 1, 0, (x) => pixels[x] ?? [0, 0, 0, 0]);
    // The source RGB components remain their exact premultiplied foreground;
    // only the uncovered half receives the ordered alpha-derived echo stack.
    expect(output[0]).toBeGreaterThanOrEqual(0.1);
    expect(output[1]).toBeCloseTo(0.2, 8);
    expect(output[2]).toBeGreaterThanOrEqual(0.3);
    expect(output[3]).toBeGreaterThan(0.5);
  });
});
