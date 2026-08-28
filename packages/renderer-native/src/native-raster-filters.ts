import { RgbaCanvas } from "./native-raster-canvas";
import { clamp, type NativeColorEffects } from "./native-raster-primitives";
export function blurCanvas(source: RgbaCanvas, radius: number): RgbaCanvas {
  const pixelRadius = Math.min(32, Math.max(1, Math.ceil(radius)));
  const premultiplied = new Float64Array(source.width * source.height * 4);
  for (let offset = 0; offset < source.data.length; offset += 4) {
    const alpha = source.data[offset + 3] / 255;
    premultiplied[offset] = source.data[offset] * alpha;
    premultiplied[offset + 1] = source.data[offset + 1] * alpha;
    premultiplied[offset + 2] = source.data[offset + 2] * alpha;
    premultiplied[offset + 3] = source.data[offset + 3];
  }

  const horizontal = blurFloatRgba(premultiplied, source.width, source.height, pixelRadius, "horizontal");
  const vertical = blurFloatRgba(horizontal, source.width, source.height, pixelRadius, "vertical");
  const blurred = new RgbaCanvas(source.width, source.height);
  for (let offset = 0; offset < vertical.length; offset += 4) {
    const alpha = clamp(Math.round(vertical[offset + 3]), 0, 255);
    if (alpha <= 0) continue;
    const alphaRatio = alpha / 255;
    blurred.data[offset] = clamp(Math.round(vertical[offset] / alphaRatio), 0, 255);
    blurred.data[offset + 1] = clamp(Math.round(vertical[offset + 1] / alphaRatio), 0, 255);
    blurred.data[offset + 2] = clamp(Math.round(vertical[offset + 2] / alphaRatio), 0, 255);
    blurred.data[offset + 3] = alpha;
  }
  return blurred;
}

export function applyColorEffects(source: RgbaCanvas, effects: NativeColorEffects): RgbaCanvas {
  const output = new RgbaCanvas(source.width, source.height);
  const grayscaleAmount = clamp(effects.grayscale, 0, 1);

  for (let offset = 0; offset < source.data.length; offset += 4) {
    const alpha = source.data[offset + 3];
    if (alpha <= 0) continue;

    let r = source.data[offset] * effects.brightness;
    let g = source.data[offset + 1] * effects.brightness;
    let b = source.data[offset + 2] * effects.brightness;

    r = (((r / 255) - 0.5) * effects.contrast + 0.5) * 255;
    g = (((g / 255) - 0.5) * effects.contrast + 0.5) * 255;
    b = (((b / 255) - 0.5) * effects.contrast + 0.5) * 255;

    const saturatedLuma = luminance(r, g, b);
    r = saturatedLuma + (r - saturatedLuma) * effects.saturate;
    g = saturatedLuma + (g - saturatedLuma) * effects.saturate;
    b = saturatedLuma + (b - saturatedLuma) * effects.saturate;

    if (grayscaleAmount > 0) {
      const grayscaleLuma = luminance(r, g, b);
      r += (grayscaleLuma - r) * grayscaleAmount;
      g += (grayscaleLuma - g) * grayscaleAmount;
      b += (grayscaleLuma - b) * grayscaleAmount;
    }

    output.data[offset] = clamp(Math.round(r), 0, 255);
    output.data[offset + 1] = clamp(Math.round(g), 0, 255);
    output.data[offset + 2] = clamp(Math.round(b), 0, 255);
    output.data[offset + 3] = alpha;
  }

  return output;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function blurFloatRgba(
  input: Float64Array,
  width: number,
  height: number,
  radius: number,
  direction: "horizontal" | "vertical"
): Float64Array {
  const output = new Float64Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = direction === "horizontal" ? Math.max(0, x - radius) : Math.max(0, y - radius);
      const to = direction === "horizontal" ? Math.min(width - 1, x + radius) : Math.min(height - 1, y + radius);
      const count = to - from + 1;
      const outputOffset = (y * width + x) * 4;
      for (let sample = from; sample <= to; sample += 1) {
        const sampleX = direction === "horizontal" ? sample : x;
        const sampleY = direction === "horizontal" ? y : sample;
        const sampleOffset = (sampleY * width + sampleX) * 4;
        output[outputOffset] += input[sampleOffset] / count;
        output[outputOffset + 1] += input[sampleOffset + 1] / count;
        output[outputOffset + 2] += input[sampleOffset + 2] / count;
        output[outputOffset + 3] += input[sampleOffset + 3] / count;
      }
    }
  }
  return output;
}
