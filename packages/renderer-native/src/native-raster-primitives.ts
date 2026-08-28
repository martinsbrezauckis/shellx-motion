/** Internal straight-RGBA raster contracts shared by the native painter kernel. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface NativeColorEffects {
  brightness: number;
  contrast: number;
  saturate: number;
  grayscale: number;
}

export type NativeBlendMode =
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "plus-lighter";

export interface NativeClip {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

export interface PolygonPoint {
  x: number;
  y: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
