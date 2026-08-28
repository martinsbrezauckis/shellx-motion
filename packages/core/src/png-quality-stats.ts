import type { PngQuality } from "./quality";
import type { DecodedPngRgba } from "./png-rgba-decode";

/** Internal per-frame measurement shared by materialized and streamed quality checks. */
export function inspectRgba(input: DecodedPngRgba, sha256: string): PngQuality {
  let minLuma = 255;
  let maxLuma = 0;
  let totalLuma = 0;
  let darkPixels = 0;
  let brightPixels = 0;
  let transparentPixels = 0;
  let nonTransparentPixels = 0;
  let opaquePixels = 0;
  let chromaPixels = 0;
  const min = { r: 255, g: 255, b: 255 };
  const max = { r: 0, g: 0, b: 0 };

  for (let offset = 0; offset < input.rgba.length; offset += 4) {
    const alpha = input.rgba[offset + 3];
    if (alpha === 0) {
      transparentPixels += 1;
      continue;
    }
    if (alpha === 255) opaquePixels += 1;
    const r = input.rgba[offset];
    const g = input.rgba[offset + 1];
    const b = input.rgba[offset + 2];
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    totalLuma += luma;
    if (luma <= 55) darkPixels += 1;
    if (luma >= 200) brightPixels += 1;
    nonTransparentPixels += 1;
    min.r = Math.min(min.r, r);
    min.g = Math.min(min.g, g);
    min.b = Math.min(min.b, b);
    max.r = Math.max(max.r, r);
    max.g = Math.max(max.g, g);
    max.b = Math.max(max.b, b);
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 32) chromaPixels += 1;
  }

  const pixels = input.width * input.height;
  const transparentRatio = pixels === 0 ? 0 : transparentPixels / pixels;
  const nonTransparentRatio = pixels === 0 ? 0 : nonTransparentPixels / pixels;
  const opaqueRatio = pixels === 0 ? 0 : opaquePixels / pixels;
  const lumaRange = nonTransparentPixels === 0 ? 0 : maxLuma - minLuma;
  const rgbRange = {
    r: nonTransparentPixels === 0 ? 0 : max.r - min.r,
    g: nonTransparentPixels === 0 ? 0 : max.g - min.g,
    b: nonTransparentPixels === 0 ? 0 : max.b - min.b
  };
  const maxRgbRange = Math.max(rgbRange.r, rgbRange.g, rgbRange.b);
  const edgePixels = countEdgePixels(input);

  return {
    ok: true,
    width: input.width,
    height: input.height,
    pixels,
    transparentPixels,
    transparentRatio,
    nonTransparentPixels,
    nonTransparentRatio,
    opaquePixels,
    opaqueRatio,
    blank: nonTransparentRatio < 0.01 || (lumaRange <= 2 && maxRgbRange <= 2),
    sha256,
    luma: {
      min: nonTransparentPixels === 0 ? 0 : minLuma,
      max: nonTransparentPixels === 0 ? 0 : maxLuma,
      avg: nonTransparentPixels === 0 ? 0 : totalLuma / nonTransparentPixels,
      range: lumaRange,
      darkPixels,
      darkRatio: pixels === 0 ? 0 : darkPixels / pixels,
      brightPixels,
      brightRatio: pixels === 0 ? 0 : brightPixels / pixels
    },
    chroma: {
      pixels: chromaPixels,
      ratio: pixels === 0 ? 0 : chromaPixels / pixels,
      channelSpanThreshold: 32
    },
    edges: {
      pixels: edgePixels,
      ratio: pixels === 0 ? 0 : edgePixels / pixels
    },
    rgbRange
  };
}

function countEdgePixels(input: DecodedPngRgba): number {
  const threshold = 24;
  let edgePixels = 0;
  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      const offset = (y * input.width + x) * 4;
      const alpha = input.rgba[offset + 3];
      if (alpha === 0) continue;
      const luma = lumaAt(input.rgba, offset);
      let edge = false;
      if (x + 1 < input.width) {
        const rightOffset = offset + 4;
        edge = edge || Math.abs(luma - lumaAt(input.rgba, rightOffset)) >= threshold || Math.abs(alpha - input.rgba[rightOffset + 3]) >= threshold;
      }
      if (y + 1 < input.height) {
        const downOffset = ((y + 1) * input.width + x) * 4;
        edge = edge || Math.abs(luma - lumaAt(input.rgba, downOffset)) >= threshold || Math.abs(alpha - input.rgba[downOffset + 3]) >= threshold;
      }
      if (edge) edgePixels += 1;
    }
  }
  return edgePixels;
}

function lumaAt(rgba: Buffer, offset: number): number {
  return Math.round(0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]);
}
