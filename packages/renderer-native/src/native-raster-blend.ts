import { clamp, type NativeBlendMode, type Rgba } from "./native-raster-primitives";
export function blendRgb(mode: NativeBlendMode, backdrop: Rgba, source: Rgba): Rgba {
  if (mode === "hue" || mode === "saturation" || mode === "color" || mode === "luminosity") {
    return blendHsl(mode, backdrop, source);
  }
  return {
    r: blendChannel(mode, backdrop.r, source.r),
    g: blendChannel(mode, backdrop.g, source.g),
    b: blendChannel(mode, backdrop.b, source.b),
    a: source.a
  };
}

function blendChannel(mode: NativeBlendMode, backdropChannel: number, sourceChannel: number): number {
  const backdrop = backdropChannel / 255;
  const source = sourceChannel / 255;
  let value: number;

  if (mode === "multiply") value = backdrop * source;
  else if (mode === "screen") value = backdrop + source - backdrop * source;
  else if (mode === "overlay") value = backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  else if (mode === "darken") value = Math.min(backdrop, source);
  else if (mode === "lighten") value = Math.max(backdrop, source);
  else if (mode === "color-dodge") value = backdrop <= 0 ? 0 : source >= 1 ? 1 : Math.min(1, backdrop / (1 - source));
  else if (mode === "color-burn") value = backdrop >= 1 ? 1 : source <= 0 ? 0 : 1 - Math.min(1, (1 - backdrop) / source);
  else if (mode === "hard-light") value = source <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  else if (mode === "soft-light") value = softLightChannel(backdrop, source);
  else if (mode === "difference") value = Math.abs(backdrop - source);
  else if (mode === "exclusion") value = backdrop + source - 2 * backdrop * source;
  else if (mode === "plus-lighter") value = Math.min(1, backdrop + source);
  else value = source;

  return clamp(Math.round(value * 255), 0, 255);
}

function softLightChannel(backdrop: number, source: number): number {
  if (source <= 0.5) return backdrop - (1 - 2 * source) * backdrop * (1 - backdrop);
  const d = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
  return backdrop + (2 * source - 1) * (d - backdrop);
}

function blendHsl(mode: NativeBlendMode, backdrop: Rgba, source: Rgba): Rgba {
  const backdropHsl = rgbToHsl(backdrop);
  const sourceHsl = rgbToHsl(source);
  if (mode === "hue") return hslToRgb({ h: sourceHsl.h, s: backdropHsl.s, l: backdropHsl.l, a: source.a });
  if (mode === "saturation") return hslToRgb({ h: backdropHsl.h, s: sourceHsl.s, l: backdropHsl.l, a: source.a });
  if (mode === "color") return hslToRgb({ h: sourceHsl.h, s: sourceHsl.s, l: backdropHsl.l, a: source.a });
  return hslToRgb({ h: backdropHsl.h, s: backdropHsl.s, l: sourceHsl.l, a: source.a });
}

function rgbToHsl(color: Rgba): { h: number; s: number; l: number; a: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l, a: color.a };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l, a: color.a };
}

export function hslToRgb(color: { h: number; s: number; l: number; a: number }): Rgba {
  if (color.s === 0) {
    const channel = clamp(Math.round(color.l * 255), 0, 255);
    return { r: channel, g: channel, b: channel, a: color.a };
  }
  const q = color.l < 0.5 ? color.l * (1 + color.s) : color.l + color.s - color.l * color.s;
  const p = 2 * color.l - q;
  return {
    r: clamp(Math.round(hueToRgb(p, q, color.h + 1 / 3) * 255), 0, 255),
    g: clamp(Math.round(hueToRgb(p, q, color.h) * 255), 0, 255),
    b: clamp(Math.round(hueToRgb(p, q, color.h - 1 / 3) * 255), 0, 255),
    a: color.a
  };
}

function hueToRgb(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}
