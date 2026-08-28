import { describe, expect, it } from "vitest";
import { RgbaCanvas } from "./native-raster-canvas";
import { applyColorEffects, blurCanvas } from "./native-raster-filters";

function pixel(canvas: RgbaCanvas, x: number, y: number): [number, number, number, number] {
  const offset = (y * canvas.width + x) * 4;
  return [canvas.data[offset], canvas.data[offset + 1], canvas.data[offset + 2], canvas.data[offset + 3]];
}

describe("native raster kernel", () => {
  it("keeps straight RGBA samples while transparent blur uses temporary premultiplication", () => {
    const source = new RgbaCanvas(3, 3);
    source.fillRect(1, 1, 1, 1, { r: 255, g: 0, b: 0, a: 128 });

    expect(pixel(source, 1, 1)).toEqual([255, 0, 0, 128]);

    const blurred = blurCanvas(source, 1);
    const halo = pixel(blurred, 0, 1);
    expect(halo[3]).toBeGreaterThan(0);
    expect(halo.slice(0, 3)).toEqual([255, 0, 0]);
  });

  it("composites supported blend modes against the backdrop", () => {
    const target = new RgbaCanvas(1, 1);
    target.fill({ r: 100, g: 100, b: 100, a: 255 });
    const source = new RgbaCanvas(1, 1);
    source.fill({ r: 200, g: 50, b: 0, a: 255 });

    target.composite(source, "multiply");

    expect(pixel(target, 0, 0)).toEqual([78, 20, 0, 255]);
  });

  it("preserves rounded clip and bounded path geometry", () => {
    const clipped = new RgbaCanvas(4, 4);
    clipped.withClip({ x: 0, y: 0, width: 4, height: 4, radius: 2 }, () => {
      clipped.fill({ r: 255, g: 0, b: 0, a: 255 });
    });
    expect(pixel(clipped, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(clipped, 1, 1)).toEqual([255, 0, 0, 255]);

    const path = new RgbaCanvas(4, 4);
    path.fillPathShape(0, 0, 4, 4, "M 0 0 L 100 0 L 0 100 Z", { r: 0, g: 0, b: 255, a: 255 });
    expect(pixel(path, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(path, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it("applies color filters as post-processing and rotates the isolated layer canvas", () => {
    const source = new RgbaCanvas(3, 3);
    source.fillRect(0, 0, 1, 1, { r: 255, g: 0, b: 0, a: 255 });
    const filtered = applyColorEffects(source, { brightness: 1, contrast: 1, saturate: 1, grayscale: 1 });
    const filteredPixel = pixel(filtered, 0, 0);
    expect(filteredPixel[0]).toBe(filteredPixel[1]);
    expect(filteredPixel[1]).toBe(filteredPixel[2]);
    expect(filteredPixel[3]).toBe(255);

    const target = new RgbaCanvas(3, 3);
    target.compositeRotated(source, 1.5, 1.5, 90);
    expect(pixel(target, 2, 0)).toEqual([255, 0, 0, 255]);
  });

  it("owns a shared colored-triangle edge once, including at half alpha", () => {
    const canvas = new RgbaCanvas(2, 2), color = { r: 30, g: 60, b: 90, a: 128 };
    canvas.fillFlatColoredTriangles([
      { x: 0, y: 0, color }, { x: 2, y: 0, color }, { x: 2, y: 2, color },
      { x: 0, y: 0, color }, { x: 2, y: 2, color }, { x: 0, y: 2, color }
    ]);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) expect(pixel(canvas, x, y)).toEqual([30, 60, 90, 128]);
  });
});
