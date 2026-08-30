/**
 * Pure colour math shared by the strict linear-sRGB SDR route and its conformance vectors.
 *
 * Values named `srgb` are straight encoded sRGB. Values named `linear` are
 * premultiplied only when their type says so. Keeping this module free of GPU
 * objects makes the WebGPU shader vectors independently checkable in Core.
 */

export interface LinearSrgbSdrStraightRgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface LinearSrgbSdrPremultipliedRgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface CanonicalSrgbHex {
  readonly hex: string;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface LinearSrgbSdrGradientStop {
  readonly offset: number;
  readonly color: CanonicalSrgbHex;
}

export type LinearSrgbSdrGradient =
  | Readonly<{ readonly type: "linear"; readonly angleDeg: number; readonly stops: readonly LinearSrgbSdrGradientStop[] }>
  | Readonly<{ readonly type: "radial"; readonly centerX: number; readonly centerY: number; readonly stops: readonly LinearSrgbSdrGradientStop[] }>;

/** The strict linear SDR route permits one opaque authored colour grammar: lower-case #rrggbb. */
export function parseCanonicalSrgbHex(value: unknown): CanonicalSrgbHex | null {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/u.test(value)) return null;
  return Object.freeze({
    hex: value,
    r: Number.parseInt(value.slice(1, 3), 16) / 255,
    g: Number.parseInt(value.slice(3, 5), 16) / 255,
    b: Number.parseInt(value.slice(5, 7), 16) / 255,
  });
}

export function decodeSrgbChannel(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function encodeLinearSrgbChannel(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

export function straightSrgbToPremultipliedLinear(source: LinearSrgbSdrStraightRgba): LinearSrgbSdrPremultipliedRgba {
  return {
    r: decodeSrgbChannel(source.r) * source.a,
    g: decodeSrgbChannel(source.g) * source.a,
    b: decodeSrgbChannel(source.b) * source.a,
    a: source.a,
  };
}

/** Applies normal source-over in premultiplied linear-sRGB. */
export function linearSourceOver(source: LinearSrgbSdrPremultipliedRgba, destination: LinearSrgbSdrPremultipliedRgba): LinearSrgbSdrPremultipliedRgba {
  const remaining = 1 - source.a;
  return {
    r: source.r + destination.r * remaining,
    g: source.g + destination.g * remaining,
    b: source.b + destination.b * remaining,
    a: source.a + destination.a * remaining,
  };
}

export function premultipliedLinearToStraightSrgb(value: LinearSrgbSdrPremultipliedRgba): LinearSrgbSdrStraightRgba {
  if (value.a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: encodeLinearSrgbChannel(value.r / value.a),
    g: encodeLinearSrgbChannel(value.g / value.a),
    b: encodeLinearSrgbChannel(value.b / value.a),
    a: value.a,
  };
}

/** Composes bottom-to-top straight-sRGB layers through the strict route's declared domain. */
export function composeLinearSrgbSourceOver(layers: readonly LinearSrgbSdrStraightRgba[]): LinearSrgbSdrStraightRgba {
  let output: LinearSrgbSdrPremultipliedRgba = { r: 0, g: 0, b: 0, a: 0 };
  for (const layer of layers) output = linearSourceOver(straightSrgbToPremultipliedLinear(layer), output);
  return premultipliedLinearToStraightSrgb(output);
}

/**
 * Deliberately incorrect encoded-domain source-over. It exists only as a
 * control for vectors: any strict linear-SDR implementation matching this result is wrong.
 */
export function composeGammaWrongEncodedSourceOver(layers: readonly LinearSrgbSdrStraightRgba[]): LinearSrgbSdrStraightRgba {
  let output: LinearSrgbSdrPremultipliedRgba = { r: 0, g: 0, b: 0, a: 0 };
  for (const layer of layers) {
    const source = { r: layer.r * layer.a, g: layer.g * layer.a, b: layer.b * layer.a, a: layer.a };
    output = linearSourceOver(source, output);
  }
  if (output.a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: output.r / output.a, g: output.g / output.a, b: output.b / output.a, a: output.a };
}

/**
 * Samples the F2a rectangular-gradient geometry in the same local 0..1 space
 * as the route-private WebGPU shader. Stop colours are decoded before the
 * segment interpolation and encoded only at the straight-sRGB frame boundary.
 */
export function sampleLinearSrgbGradient(gradient: LinearSrgbSdrGradient, localX: number, localY: number): LinearSrgbSdrStraightRgba {
  const t = linearSrgbGradientPosition(gradient, localX, localY);
  return interpolateLinearSrgbGradientStops(gradient.stops, t);
}

export function linearSrgbGradientPosition(gradient: LinearSrgbSdrGradient, localX: number, localY: number): number {
  return gradientPosition(gradient, localX, localY);
}

export function interpolateLinearSrgbGradientStops(stops: readonly LinearSrgbSdrGradientStop[], t: number): LinearSrgbSdrStraightRgba {
  const segment = gradientSegment(stops, t);
  const amount = segment.span === 0 ? 0 : (segment.t - segment.left.offset) / segment.span;
  return {
    r: encodeLinearSrgbChannel(mix(decodeSrgbChannel(segment.left.color.r), decodeSrgbChannel(segment.right.color.r), amount)),
    g: encodeLinearSrgbChannel(mix(decodeSrgbChannel(segment.left.color.g), decodeSrgbChannel(segment.right.color.g), amount)),
    b: encodeLinearSrgbChannel(mix(decodeSrgbChannel(segment.left.color.b), decodeSrgbChannel(segment.right.color.b), amount)),
    a: 1,
  };
}

/** Deliberately wrong encoded-domain stop interpolation for isolated F2a controls. */
export function interpolateGammaWrongEncodedGradientStops(stops: readonly LinearSrgbSdrGradientStop[], t: number): LinearSrgbSdrStraightRgba {
  const segment = gradientSegment(stops, t);
  const amount = segment.span === 0 ? 0 : (segment.t - segment.left.offset) / segment.span;
  return {
    r: mix(segment.left.color.r, segment.right.color.r, amount),
    g: mix(segment.left.color.g, segment.right.color.g, amount),
    b: mix(segment.left.color.b, segment.right.color.b, amount),
    a: 1,
  };
}

function gradientPosition(gradient: LinearSrgbSdrGradient, localX: number, localY: number): number {
  const x = clamp01(localX), y = clamp01(localY);
  if (gradient.type === "linear") {
    const radians = gradient.angleDeg * Math.PI / 180;
    const directionX = Math.sin(radians), directionY = -Math.cos(radians);
    const extent = Math.max(0.000001, 0.5 * (Math.abs(directionX) + Math.abs(directionY)));
    return clamp01(((x - 0.5) * directionX + (y - 0.5) * directionY) / (2 * extent) + 0.5);
  }
  const radius = Math.max(
    Math.hypot(gradient.centerX, gradient.centerY),
    Math.hypot(gradient.centerX - 1, gradient.centerY),
    Math.hypot(gradient.centerX, gradient.centerY - 1),
    Math.hypot(gradient.centerX - 1, gradient.centerY - 1),
  );
  return clamp01(Math.hypot(x - gradient.centerX, y - gradient.centerY) / Math.max(radius, 0.000001));
}

function gradientSegment(stops: readonly LinearSrgbSdrGradientStop[], input: number): { readonly left: LinearSrgbSdrGradientStop; readonly right: LinearSrgbSdrGradientStop; readonly t: number; readonly span: number } {
  if (stops.length < 2) throw new Error("Linear-sRGB gradient sampling requires at least two admitted stops.");
  const t = clamp01(input);
  if (t <= stops[0]!.offset) return { left: stops[0]!, right: stops[0]!, t: stops[0]!.offset, span: 0 };
  for (let index = 1; index < stops.length; index += 1) {
    const right = stops[index]!;
    if (t <= right.offset) {
      const left = stops[index - 1]!;
      return { left, right, t, span: right.offset - left.offset };
    }
  }
  const last = stops[stops.length - 1]!;
  return { left: last, right: last, t: last.offset, span: 0 };
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function mix(left: number, right: number, amount: number): number { return left + (right - left) * amount; }
