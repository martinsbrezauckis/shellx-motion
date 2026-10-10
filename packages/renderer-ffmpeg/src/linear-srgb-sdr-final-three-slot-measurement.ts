/**
 * Literal three-slot frame admission and observational measurement helpers.
 * The diagnostic lifecycle owns leases and scope state; this source-relative helper owns no capability.
 */
import { createHash } from "node:crypto";
import {
  LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT,
  LINEAR_SRGB_SDR_FINAL_MAX_WIDTH,
  type LinearSrgbSdrFinalRoute,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LocalMotionJobEvidence } from "@shellx-motion/core";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";

const WIDTH = 1_280;
const HEIGHT = 720;
const FPS = 30;
const DURATION_MS = 2_000;

export type StrictSdrCandidateThreeSlot = "f2a" | "f2b-screen" | "f2b-screen-controls";

export type StrictSdrCandidateThreeSlotAllPixelMeasurement = Readonly<{
  pixelCount: number;
  rgbSampleCount: number;
  maximumChannelDelta: number;
  meanAbsoluteChannelDelta: number;
  alphaMismatchedPixelCount: number;
}>;

export type StrictSdrCandidateF2bScreenControlsThreeSlotSamples = readonly Readonly<{
  name: "screen-saturated-overlays" | "screen-partial-alpha-control" | "transparent-screen-zero-alpha-control";
  x: number;
  y: number;
  sourceRgba8: readonly [number, number, number, number];
  decodedRgba8: readonly [number, number, number, number];
}>[];

export type StrictSdrCandidateThreeSlotDecodedMeasurement = Readonly<{
  allPixels: StrictSdrCandidateThreeSlotAllPixelMeasurement;
  samples?: StrictSdrCandidateF2bScreenControlsThreeSlotSamples;
}>;

export type StrictSdrCandidateThreeSlotInverseResult = Readonly<{
  decoded: Readonly<{ sha256: string; byteLength: number }>;
  measurement: StrictSdrCandidateThreeSlotDecodedMeasurement;
  inverseCommandSha256: string;
}>;

export type StrictSdrCandidateThreeSlotBaseMeasurement = Readonly<{
  media: Readonly<{ sha256: string; byteLength: number }>;
  sourceFrame: Readonly<{ sha256: string; byteLength: number }>;
  decodedFrame: Readonly<{ sha256: string; byteLength: number }>;
  allPixels: StrictSdrCandidateThreeSlotAllPixelMeasurement;
  inverseCommandSha256: string;
  inverseJob: LocalMotionJobEvidence;
}>;

export type StrictSdrCandidateThreeSlotF2aMeasurement = Readonly<StrictSdrCandidateThreeSlotBaseMeasurement & {
  schema: "shellx-motion/strict-sdr-candidate-three-slot-f2a-measurement@1";
}>;
export type StrictSdrCandidateF2bScreenThreeSlotMeasurement = Readonly<StrictSdrCandidateThreeSlotBaseMeasurement & {
  schema: "shellx-motion/strict-sdr-candidate-f2b-screen-three-slot-measurement@1";
}>;
export type StrictSdrCandidateF2bScreenControlsThreeSlotMeasurement = Readonly<StrictSdrCandidateThreeSlotBaseMeasurement & {
  schema: "shellx-motion/strict-sdr-candidate-f2b-screen-controls-three-slot-measurement@1";
  samples: StrictSdrCandidateF2bScreenControlsThreeSlotSamples;
}>;

/** Reject any frame that differs from the sealed literal route/layer topology before copying it. */
export function assertStrictSdrCandidateThreeSlotFrame(
  slot: StrictSdrCandidateThreeSlot,
  route: LinearSrgbSdrFinalRoute,
  frame: LinearSrgbSdrFinalWebGpuFrame,
): void {
  const bytes = route.canvas.width * route.canvas.height * 4;
  const hasScreen = route.rects.some((rect) => rect.blendMode === "screen");
  const hasGradient = route.rects.some((rect) => "gradient" in rect);
  const literalRoute = route.canvas.width === WIDTH && route.canvas.height === HEIGHT && route.canvas.fps === FPS && route.canvas.durationMs === DURATION_MS
    && route.canvas.width <= LINEAR_SRGB_SDR_FINAL_MAX_WIDTH && route.canvas.height <= LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT
    && frame.width === route.canvas.width && frame.height === route.canvas.height && frame.bytesPerRow === route.canvas.width * 4
    && frame.routeFingerprint === route.fingerprint && frame.documentFingerprint === route.documentFingerprint && frame.rgba8Srgb.byteLength === bytes;
  const slotRoute = slot === "f2a" ? !hasScreen && hasGradient
    : slot === "f2b-screen" ? hasScreen && hasGradient
      : hasScreen && !hasGradient;
  if (!literalRoute || !slotRoute) throw new Error("Strict-SDR three-slot frame does not match its literal admitted route and RGBA layout.");
}

export function strictSdrCandidateThreeSlotFrameSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Full-image first-frame observation with no pass line or qualification decision. */
export function measureStrictSdrCandidateThreeSlotAllPixels(
  source: Buffer,
  decoded: Buffer,
  route: LinearSrgbSdrFinalRoute,
): StrictSdrCandidateThreeSlotAllPixelMeasurement {
  const bytes = route.canvas.width * route.canvas.height * 4;
  if (source.byteLength !== bytes || decoded.byteLength !== bytes) throw new Error("Strict-SDR three-slot inverse did not provide one exact decoded RGBA frame.");
  let maximumChannelDelta = 0, absoluteDelta = 0, alphaMismatchedPixelCount = 0;
  for (let offset = 0; offset < bytes; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(source[offset + channel]! - decoded[offset + channel]!);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      absoluteDelta += delta;
    }
    if (source[offset + 3] !== decoded[offset + 3]) alphaMismatchedPixelCount += 1;
  }
  return Object.freeze({
    pixelCount: route.canvas.width * route.canvas.height,
    rgbSampleCount: route.canvas.width * route.canvas.height * 3,
    maximumChannelDelta,
    meanAbsoluteChannelDelta: absoluteDelta / (route.canvas.width * route.canvas.height * 3),
    alphaMismatchedPixelCount,
  });
}

/** Three fixed controls are observations only; their values never decide a candidate outcome. */
export function strictSdrCandidateF2bScreenControlsThreeSlotSamples(
  source: Buffer,
  decoded: Buffer,
  route: LinearSrgbSdrFinalRoute,
): StrictSdrCandidateF2bScreenControlsThreeSlotSamples {
  return Object.freeze([
    point("screen-saturated-overlays", 240, 356),
    point("screen-partial-alpha-control", 640, 356),
    point("transparent-screen-zero-alpha-control", 1040, 356),
  ].map(({ name, x, y }) => Object.freeze({
    name,
    x,
    y,
    sourceRgba8: rgba(source, route, x, y),
    decodedRgba8: rgba(decoded, route, x, y),
  })));
}

/** Check that the private inverse bridge returned only route-derived bounded observation facts. */
export function assertStrictSdrCandidateThreeSlotInverseMeasurement(
  value: StrictSdrCandidateThreeSlotInverseResult,
  route: LinearSrgbSdrFinalRoute,
  controls: boolean,
): void {
  const expectedPixels = route.canvas.width * route.canvas.height;
  const decoded = value?.decoded, measurement = value?.measurement?.allPixels;
  if (!value || !decoded || !/^[a-f0-9]{64}$/u.test(decoded.sha256) || decoded.byteLength !== expectedPixels * 4
    || !/^[a-f0-9]{64}$/u.test(value.inverseCommandSha256) || !measurement
    || measurement.pixelCount !== expectedPixels || measurement.rgbSampleCount !== expectedPixels * 3
    || !Number.isSafeInteger(measurement.maximumChannelDelta) || measurement.maximumChannelDelta < 0 || measurement.maximumChannelDelta > 255
    || !Number.isFinite(measurement.meanAbsoluteChannelDelta) || measurement.meanAbsoluteChannelDelta < 0 || measurement.meanAbsoluteChannelDelta > 255
    || !Number.isSafeInteger(measurement.alphaMismatchedPixelCount) || measurement.alphaMismatchedPixelCount < 0 || measurement.alphaMismatchedPixelCount > expectedPixels
    || controls !== !!value.measurement.samples) {
    throw new Error("Strict-SDR three-slot inverse did not return bounded route-derived measurement facts.");
  }
  if (controls && !sameVectorSamples(value.measurement.samples!)) {
    throw new Error("Strict-SDR three-slot controls inverse did not preserve its three fixed vector locations.");
  }
}

function sameVectorSamples(samples: StrictSdrCandidateF2bScreenControlsThreeSlotSamples): boolean {
  const expected = [
    ["screen-saturated-overlays", 240, 356],
    ["screen-partial-alpha-control", 640, 356],
    ["transparent-screen-zero-alpha-control", 1040, 356],
  ] as const;
  return samples.length === expected.length && samples.every((sample, index) => sample.name === expected[index]![0]
    && sample.x === expected[index]![1] && sample.y === expected[index]![2]
    && sample.sourceRgba8.length === 4 && sample.decodedRgba8.length === 4
    && [...sample.sourceRgba8, ...sample.decodedRgba8].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255));
}

function point(
  name: StrictSdrCandidateF2bScreenControlsThreeSlotSamples[number]["name"],
  x: number,
  y: number,
): Readonly<{ name: typeof name; x: number; y: number }> {
  return Object.freeze({ name, x, y });
}

function rgba(bytes: Buffer, route: LinearSrgbSdrFinalRoute, x: number, y: number): readonly [number, number, number, number] {
  if (x < 0 || x >= route.canvas.width || y < 0 || y >= route.canvas.height) throw new Error("Strict-SDR three-slot vector point is outside the admitted frame.");
  const offset = (y * route.canvas.width + x) * 4;
  return Object.freeze([bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!] as [number, number, number, number]);
}
