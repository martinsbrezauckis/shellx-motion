/** Bounded scalar accumulators for the private same-parent M1 2-D observation. */
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { StrictSdrCandidateThreeSlot } from "./linear-srgb-sdr-final-three-slot-measurement.js";

export type StrictSdrCandidateThreeSlot2dDirectTuple = readonly [
  number, number, number, number, number, number, number,
];
export type StrictSdrCandidateThreeSlot2dTangentTuple = readonly [
  number, number, number, number, number, number, number,
  number, number, number, number, number, number, "defined" | "unavailable", string | null, string | null,
];
export type StrictSdrCandidateThreeSlot2dSpatialTuple = StrictSdrCandidateThreeSlot2dDirectTuple | StrictSdrCandidateThreeSlot2dTangentTuple;

const SIGNED_DECIMAL = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

export function canonicalSignedBigIntDecimal(value: bigint): string {
  const text = value.toString(10);
  if (!SIGNED_DECIMAL.test(text)) throw new Error("Strict-SDR spatial covariance is not canonical BigInt decimal.");
  return text;
}

export function canonicalUnsignedBigIntDecimal(value: bigint): string {
  if (value < 0n) throw new Error("Strict-SDR spatial variance cannot be negative.");
  const text = value.toString(10);
  if (!UNSIGNED_DECIMAL.test(text)) throw new Error("Strict-SDR spatial variance is not canonical BigInt decimal.");
  return text;
}

export function isCanonicalSignedBigIntDecimal(value: unknown): value is string {
  return typeof value === "string" && SIGNED_DECIMAL.test(value);
}

export function isCanonicalUnsignedBigIntDecimal(value: unknown): value is string {
  return typeof value === "string" && UNSIGNED_DECIMAL.test(value);
}

/** Rejects drift from the frozen R5 source geometry before any scalar plan state is allocated. */
export function assertStrictSdrCandidateThreeSlot2dLiteralRoute(slot: StrictSdrCandidateThreeSlot, route: LinearSrgbSdrFinalRoute): void {
  const common = route.schema === "shellx-motion/linear-srgb-sdr-final-route@1" && route.canvas.width === 1_280 && route.canvas.height === 720
    && route.canvas.fps === 30 && route.canvas.durationMs === 2_000 && route.admission.target === "final" && route.admission.frameLane === "gpu"
    && route.admission.delivery === "streamed" && route.admission.finalLane === "ffmpeg" && route.admission.preset === "mp4-h264"
    && route.admission.working === "premultiplied-linear-srgb-rgba16float" && route.admission.frameBoundary === "straight-srgb-rgba8"
    && route.admission.composition === (slot === "f2a" ? "normal-source-over-document-order" : "normal-and-screen-document-order");
  const expected = slot === "f2a" ? [
    gradient("linear_black_white", 64, 64, 544, 592, 1, undefined, "linear", 90, ["#000000", "#ffffff"]),
    gradient("radial_three_stop", 672, 64, 544, 592, 1, undefined, "radial", [.5, .5], ["#101820", "#00ff40", "#ffffff"]),
  ] : slot === "f2b-screen" ? [
    fill("stage", 80, 80, 1120, 560, 1, undefined, "#101820"), fill("cyan_base", 160, 156, 420, 408, .7, undefined, "#0066cc"),
    fill("warm_screen", 360, 236, 420, 248, .48, "screen", "#ff6040"), gradient("normal_gradient", 700, 156, 420, 408, 1, undefined, "linear", 90, ["#081020", "#2050a0"]),
    gradient("screen_gradient", 760, 216, 280, 288, .52, "screen", "radial", [.5, .5], ["#ff8040", "#200810"]),
  ] : [
    fill("saturated_base", 64, 180, 352, 352, 1, undefined, "#101820"), fill("saturated_red_screen", 64, 180, 352, 352, .4, "screen", "#ff0040"), fill("saturated_blue_screen", 64, 180, 352, 352, .45, "screen", "#0066ff"),
    fill("partial_base", 464, 180, 352, 352, 1, undefined, "#0c1420"), fill("partial_normal", 464, 180, 352, 352, .18, undefined, "#204080"), fill("partial_screen", 464, 180, 352, 352, .31, "screen", "#ff5020"),
    fill("zero_alpha_base", 864, 180, 352, 352, 1, undefined, "#305070"), fill("zero_alpha_screen", 864, 180, 352, 352, 0, "screen", "#ff0080"),
  ];
  const background = slot === "f2b-screen-controls" ? "#000000" : "#02040a";
  if (!common || route.canvas.background.hex !== background || route.rects.length !== expected.length || !route.rects.every((rect, index) => expected[index]!(rect))) {
    throw new Error("Strict-SDR spatial plan route changed its literal geometry, layer order, paint, opacity, or blend semantics.");
  }
}

export function countStrictSdrCandidateThreeSlot2dBits(bits: Buffer): number {
  let count = 0;
  for (const value of bits) for (let current = value; current !== 0; current >>>= 1) count += current & 1;
  return count;
}

function fill(id: string, x: number, y: number, width: number, height: number, opacity: number, blendMode: "screen" | undefined, color: string) {
  return (rect: LinearSrgbSdrFinalRoute["rects"][number]) => "fill" in rect && rect.id === id && rect.x === x && rect.y === y && rect.width === width && rect.height === height && rect.opacity === opacity && rect.blendMode === blendMode && rect.fill.hex === color;
}
function gradient(id: string, x: number, y: number, width: number, height: number, opacity: number, blendMode: "screen" | undefined, type: "linear" | "radial", detail: number | readonly [number, number], colors: readonly string[]) {
  return (rect: LinearSrgbSdrFinalRoute["rects"][number]) => {
    if (!("gradient" in rect) || rect.id !== id || rect.x !== x || rect.y !== y || rect.width !== width || rect.height !== height || rect.opacity !== opacity || rect.blendMode !== blendMode) return false;
    const field = rect.gradient, same = field.type === "linear"
      ? type === "linear" && typeof detail === "number" && field.angleDeg === detail
      : type === "radial" && Array.isArray(detail) && field.centerX === detail[0] && field.centerY === detail[1];
    return same && field.stops.length === colors.length
      && field.stops.every((stop, index) => stop.offset === index / (colors.length - 1) || (colors.length === 3 && index === 1 && stop.offset === .5))
      && field.stops.every((stop, index) => stop.color.hex === colors[index]);
  };
}

export function accumulateStrictSdrCandidateThreeSlot2dDirect(
  source: Buffer,
  decoded: Buffer,
  visit: (sample: (pixelIndex: number) => void) => void,
): StrictSdrCandidateThreeSlot2dDirectTuple {
  const maximum = [0, 0, 0], sums = [0, 0, 0];
  let alphaMismatches = 0;
  visit((pixelIndex) => {
    const offset = pixelIndex * 4;
    if (source[offset + 3] !== 255 || decoded[offset + 3] !== 255) {
      alphaMismatches += 1;
      return;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(source[offset + channel]! - decoded[offset + channel]!);
      maximum[channel] = Math.max(maximum[channel]!, delta);
      sums[channel] += delta;
    }
  });
  return Object.freeze([maximum[0]!, maximum[1]!, maximum[2]!, sums[0]!, sums[1]!, sums[2]!, alphaMismatches] as const);
}

export function sourceVarianceNumerator(source: Buffer, pairs: Uint32Array, start: number, count: number): bigint {
  const state = newTangentState();
  forEachPair(pairs, start, count, (left, right) => addTangent(state, source, source, left, right));
  return variance(state.count, state.sourceSum, state.sourceSquareSum);
}

export function accumulateStrictSdrCandidateThreeSlot2dTangent(
  direct: StrictSdrCandidateThreeSlot2dDirectTuple,
  source: Buffer,
  decoded: Buffer,
  pairs: Uint32Array,
  start: number,
  count: number,
): StrictSdrCandidateThreeSlot2dTangentTuple {
  const state = newTangentState();
  const absolute = [0, 0, 0], squared = [0, 0, 0];
  forEachPair(pairs, start, count, (left, right) => {
    const leftOffset = left * 4, rightOffset = right * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const sourceDelta = source[rightOffset + channel]! - source[leftOffset + channel]!;
      const decodedDelta = decoded[rightOffset + channel]! - decoded[leftOffset + channel]!;
      const residual = decodedDelta - sourceDelta;
      absolute[channel] += Math.abs(residual);
      squared[channel] += residual * residual;
      const sourceValue = BigInt(sourceDelta), decodedValue = BigInt(decodedDelta);
      state.sourceSum += sourceValue;
      state.decodedSum += decodedValue;
      state.sourceSquareSum += sourceValue * sourceValue;
      state.decodedSquareSum += decodedValue * decodedValue;
      state.productSum += sourceValue * decodedValue;
      state.count += 1n;
    }
  });
  const sourceVariance = variance(state.count, state.sourceSum, state.sourceSquareSum);
  const decodedVariance = variance(state.count, state.decodedSum, state.decodedSquareSum);
  const covariance = state.count * state.productSum - state.sourceSum * state.decodedSum;
  const correlation = sourceVariance === 0n || decodedVariance === 0n ? ["unavailable", null, null] as const
    : ["defined", canonicalSignedBigIntDecimal(covariance), canonicalUnsignedBigIntDecimal(decodedVariance)] as const;
  return Object.freeze([
    ...direct, absolute[0]!, absolute[1]!, absolute[2]!, squared[0]!, squared[1]!, squared[2]!, ...correlation,
  ] as StrictSdrCandidateThreeSlot2dTangentTuple);
}

function forEachPair(pairs: Uint32Array, start: number, count: number, visit: (left: number, right: number) => void): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || (start + count) * 2 > pairs.length) {
    throw new Error("Strict-SDR spatial tangent pair range is outside its fixed topology buffer.");
  }
  for (let index = start; index < start + count; index += 1) {
    const left = pairs[index * 2]!, right = pairs[index * 2 + 1]!;
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left === right) throw new Error("Strict-SDR spatial topology contains an invalid pair.");
    visit(left, right);
  }
}

function newTangentState() {
  return { count: 0n, sourceSum: 0n, decodedSum: 0n, sourceSquareSum: 0n, decodedSquareSum: 0n, productSum: 0n };
}

function addTangent(state: ReturnType<typeof newTangentState>, source: Buffer, decoded: Buffer, left: number, right: number): void {
  const leftOffset = left * 4, rightOffset = right * 4;
  for (let channel = 0; channel < 3; channel += 1) {
    const sourceDelta = source[rightOffset + channel]! - source[leftOffset + channel]!;
    const decodedDelta = decoded[rightOffset + channel]! - decoded[leftOffset + channel]!;
    const sourceValue = BigInt(sourceDelta), decodedValue = BigInt(decodedDelta);
    state.sourceSum += sourceValue;
    state.decodedSum += decodedValue;
    state.sourceSquareSum += sourceValue * sourceValue;
    state.decodedSquareSum += decodedValue * decodedValue;
    state.productSum += sourceValue * decodedValue;
    state.count += 1n;
  }
}

function variance(count: bigint, sum: bigint, squareSum: bigint): bigint {
  if (count <= 0n) throw new Error("Strict-SDR spatial tangent topology has no RGB components.");
  const result = count * squareSum - sum * sum;
  if (result < 0n) throw new Error("Strict-SDR spatial variance underflowed its exact BigInt domain.");
  return result;
}
