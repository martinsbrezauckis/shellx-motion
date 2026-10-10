/** Closed structural contracts shared by the private all-delivered-frame scope and its Q1 capability. */
import { canonicalJson } from "@shellx-motion/core";
import {
  matchesCurrentStrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { StrictSdrCandidateFrame0PackInverseJob } from "./linear-srgb-sdr-final-three-slot-frame0-pack-evidence.js";
import type {
  StrictSdrCandidateThreeSlot2dMeasurementPlan,
  StrictSdrCandidateThreeSlot2dSpatialPlan,
} from "./linear-srgb-sdr-final-three-slot-2d-plan.js";
import type {
  StrictSdrCandidateThreeSlotM1aMeasurementExpectation,
  StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair,
} from "./linear-srgb-sdr-final-three-slot-2d-measurement.js";
import type {
  StrictSdrCandidateF2bScreenControlsThreeSlotSamples,
  StrictSdrCandidateThreeSlot,
  StrictSdrCandidateThreeSlotAllPixelMeasurement,
} from "./linear-srgb-sdr-final-three-slot-measurement.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const FRAME_BYTES = 3_686_400;
const FRAME_COUNT = 60;
const DECODED_BYTES = 221_184_000;
const SLOT_MAX_BYTES = 98_304;
const CHILD_MAX_BYTES = 294_912;
const CHUNK_MAX_BYTES = 1_048_576;

export type StrictSdrCandidateAllDeliveredFrameObservationBinding = Readonly<{
  schema: "shellx-motion/strict-sdr-candidate-all-delivered-frame-observation@1";
  width: 1280;
  height: 720;
  rgbaFrameBytes: 3_686_400;
  fps: 30;
  durationMs: 2_000;
  frameCount: 60;
  decodedByteLength: 221_184_000;
  maxAdmittedChunkBytes: 1_048_576;
  maxSlotReportBytes: 98_304;
  maxChildReportBytes: 294_912;
}>;
export type StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan = Readonly<{ spatialContinuityPlan: unknown }>;
/** Structural renderer seam; only the private child may construct an authenticated implementation. */
export type StrictSdrDecodedQualityCollectorCapability = Readonly<{
  observe: (frameIndex: number, decodedFrameSha256: string, decoded: Buffer) => unknown;
  complete: (sequenceSha256: string, expectedDecodedFrameSha256: readonly string[]) => unknown;
  dispose: () => void;
}>;
export type StrictSdrDecodedQualityCapability = Readonly<{
  bindingSha256: string;
  slot: StrictSdrCandidateThreeSlot;
  sourceFrameSha256: string;
  createCollector: (sourceRgba8: Buffer) => StrictSdrDecodedQualityCollectorCapability;
  assertSlot: (report: unknown, joins: Readonly<{ bindingSha256: string; slot: StrictSdrCandidateThreeSlot; sourceFrameSha256: string; sequenceSha256: string; decodedFrameSha256: readonly string[] }>) => unknown;
  record: (report: unknown) => unknown;
}>;
export type StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityFrame = Readonly<{ spatialContinuity: readonly unknown[] }>;
export type StrictSdrCandidateThreeSlotQ1StaticContinuityCapability = Readonly<{
  buildPlan: (input: Readonly<{
    route: LinearSrgbSdrFinalRoute;
    sourceRgba8: Buffer;
    m1Plan: StrictSdrCandidateThreeSlot2dMeasurementPlan;
    expected: StrictSdrCandidateThreeSlotM1aMeasurementExpectation;
  }>) => StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan;
  measureFrame: (input: Readonly<{
    plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan;
    sourceRgba8: Buffer;
    decodedRgba8: Buffer;
  }>) => StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityFrame;
  disposePlan: (plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan) => void;
  assertFactoryPlan: (input: Readonly<{
    expected: StrictSdrCandidateThreeSlotM1aMeasurementExpectation;
    spatialContinuityPlan: unknown;
  }>) => unknown;
  assertFrame: (input: Readonly<{
    plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan;
    spatialContinuity: unknown;
  }>) => StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityFrame;
  assertTemporalRecord: (input: Readonly<{
    pair: StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair;
    slot: StrictSdrCandidateThreeSlot;
    spatialContinuityPlan: unknown;
    spatialContinuities: readonly unknown[];
  }>) => void;
}>;
export type StrictSdrCandidateAllDeliveredFrameFact = Readonly<{
  frameIndex: number;
  decodedFrame: Readonly<{ sha256: string; byteLength: 3_686_400 }>;
  allPixels: StrictSdrCandidateThreeSlotAllPixelMeasurement;
  samples?: StrictSdrCandidateF2bScreenControlsThreeSlotSamples;
  spatial?: readonly (readonly (number | string | null)[])[];
  spatialContinuity?: readonly unknown[];
}>;
export type StrictSdrCandidateAllDeliveredFrameObservation = Readonly<{
  schema: "shellx-motion/strict-sdr-candidate-all-delivered-frame-observation@1";
  slot: StrictSdrCandidateThreeSlot;
  media: Readonly<{ sha256: string; byteLength: number }>;
  receipt: Readonly<{ sha256: string; byteLength: number }>;
  sourceFrame: Readonly<{ sha256: string; byteLength: 3_686_400 }>;
  route: Readonly<{ fingerprint: string; documentFingerprint: string }>;
  preparation: string;
  sourceSequence: Readonly<{
    mode: "repeated-static";
    frameSha256: string;
    frameCount: 60;
    sequenceSha256: string;
  }>;
  heldFfmpeg: Readonly<{ sha256: string }>;
  inverseCommandSha256: string;
  inverseJob: StrictSdrCandidateFrame0PackInverseJob;
  frameCount: 60;
  decodedByteLength: 221_184_000;
  sequenceSha256: string;
  spatialPlan?: StrictSdrCandidateThreeSlot2dSpatialPlan;
  spatialContinuityPlan?: unknown;
  frames: readonly StrictSdrCandidateAllDeliveredFrameFact[];
}>;

export function assertStrictSdrCandidateAllDeliveredFrameObservationBinding(value: unknown): StrictSdrCandidateAllDeliveredFrameObservationBinding {
  const record = exactRecord(value, ["decodedByteLength", "durationMs", "fps", "frameCount", "height", "maxAdmittedChunkBytes", "maxChildReportBytes", "maxSlotReportBytes", "rgbaFrameBytes", "schema", "width"], "Strict-SDR all-delivered-frame binding");
  if (record.schema !== "shellx-motion/strict-sdr-candidate-all-delivered-frame-observation@1" || record.width !== 1280 || record.height !== 720 || record.rgbaFrameBytes !== FRAME_BYTES || record.fps !== 30 || record.durationMs !== 2_000 || record.frameCount !== FRAME_COUNT || record.decodedByteLength !== DECODED_BYTES || record.maxAdmittedChunkBytes !== CHUNK_MAX_BYTES || record.maxSlotReportBytes !== SLOT_MAX_BYTES || record.maxChildReportBytes !== CHILD_MAX_BYTES) throw new Error("Strict-SDR all-delivered-frame binding does not retain its literal technical limits.");
  return Object.freeze({ schema: "shellx-motion/strict-sdr-candidate-all-delivered-frame-observation@1", width: 1280, height: 720, rgbaFrameBytes: FRAME_BYTES, fps: 30, durationMs: 2_000, frameCount: FRAME_COUNT, decodedByteLength: DECODED_BYTES, maxAdmittedChunkBytes: CHUNK_MAX_BYTES, maxSlotReportBytes: SLOT_MAX_BYTES, maxChildReportBytes: CHILD_MAX_BYTES });
}

export function assertStrictSdrCandidateThreeSlotQ1StaticContinuityCapability(value: unknown): StrictSdrCandidateThreeSlotQ1StaticContinuityCapability {
  const record = exactRecord(value, ["assertFactoryPlan", "assertFrame", "assertTemporalRecord", "buildPlan", "disposePlan", "measureFrame"], "Strict-SDR Q1 static-continuity capability");
  if (!Object.isFrozen(value) || Object.values(record).some((member) => typeof member !== "function")) throw new Error("Strict-SDR Q1 static-continuity capability is not one frozen exact function map.");
  return record as unknown as StrictSdrCandidateThreeSlotQ1StaticContinuityCapability;
}

export function assertStrictSdrDecodedQualityCapability(value: unknown, slot: StrictSdrCandidateThreeSlot): StrictSdrDecodedQualityCapability {
  const record = exactRecord(value, ["bindingSha256", "slot", "sourceFrameSha256", "createCollector", "assertSlot", "record"], "Strict SDR decoded quality capability");
  if (!Object.isFrozen(value) || typeof record.bindingSha256 !== "string" || !SHA256.test(record.bindingSha256) || record.slot !== slot
    || typeof record.sourceFrameSha256 !== "string" || !SHA256.test(record.sourceFrameSha256) || typeof record.createCollector !== "function"
    || typeof record.assertSlot !== "function" || typeof record.record !== "function") throw new Error("Strict SDR decoded quality capability binding differs or is not frozen");
  return record as StrictSdrDecodedQualityCapability;
}

/** The private report parser owns full grammar; this boundary checks exact old-record joins. */
export function assertStrictSdrDecodedQualityReportJoin(value: unknown, capability: StrictSdrDecodedQualityCapability,
  sequenceSha256: string, decodedFrameSha256: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Strict SDR decoded quality report is not a synchronous plain record");
  }
  const report = value as Record<string, unknown>;
  const source = report.sourceFrame as Record<string, unknown> | undefined;
  const frames = report.frames;
  if (report.schema !== "shellx-motion/strict-sdr-decoded-quality-slot@1" || report.bindingSha256 !== capability.bindingSha256
    || report.slot !== capability.slot || !source || source.sha256 !== capability.sourceFrameSha256
    || report.sequenceSha256 !== sequenceSha256 || !Array.isArray(frames) || frames.length !== FRAME_COUNT
    || decodedFrameSha256.length !== FRAME_COUNT || frames.some((frame, index) => {
      const row = frame as { frameIndex?: unknown; decodedFrame?: { sha256?: unknown } } | null;
      return !row || row.frameIndex !== index || row.decodedFrame?.sha256 !== decodedFrameSha256[index];
    })) throw new Error("Strict SDR decoded quality report differs from held all-delivered frame identity");
}

export function assertStrictSdrCandidateThreeSlotQ1StaticContinuityFactoryPlan(input: Readonly<{ expected: StrictSdrCandidateThreeSlotM1aMeasurementExpectation; capability: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability | undefined; spatialContinuityPlan: unknown }>): unknown {
  if (!input.expected.q1StaticContinuity || !input.capability) throw new Error("Strict-SDR Q1 factory plan lacks its sealed @3 capability.");
  return input.capability.assertFactoryPlan({ expected: input.expected, spatialContinuityPlan: input.spatialContinuityPlan });
}

export function assertStrictSdrCandidateThreeSlotQ1StaticContinuityStage(input: Readonly<{
  expected: StrictSdrCandidateThreeSlotM1aMeasurementExpectation | undefined;
  capability: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability | undefined;
  plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan | undefined;
  registeredSpatialContinuityPlan: unknown; spatialContinuityPlan: unknown; spatialContinuity: unknown;
}>): StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityFrame | undefined {
  if (!input.expected?.q1StaticContinuity) {
    if (input.capability || input.plan || input.registeredSpatialContinuityPlan !== undefined || input.spatialContinuityPlan !== undefined || input.spatialContinuity !== undefined) throw new Error("Strict-SDR all-delivered-frame stage retained Q1 facts outside its sealed binding.");
    return undefined;
  }
  if (!input.capability || !input.plan || input.registeredSpatialContinuityPlan === undefined || input.spatialContinuityPlan === undefined || input.spatialContinuity === undefined) throw new Error("Strict-SDR all-delivered-frame stage lacks its complete sealed Q1 facts.");
  const factory = assertStrictSdrCandidateThreeSlotQ1StaticContinuityFactoryPlan({ expected: input.expected, capability: input.capability, spatialContinuityPlan: input.spatialContinuityPlan });
  if (canonicalJson(factory) !== canonicalJson(input.registeredSpatialContinuityPlan)) throw new Error("Strict-SDR all-delivered-frame Q1 plan changed from its pre-governor factory plan.");
  return input.capability.assertFrame({ plan: input.plan, spatialContinuity: input.spatialContinuity });
}

export function assertStrictSdrCandidateThreeSlotQ1StaticContinuityRecord(input: Readonly<{
  expected: StrictSdrCandidateThreeSlotM1aMeasurementExpectation | undefined;
  capability: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability | undefined;
  plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan | undefined;
  spatialContinuityPlan: unknown; frames: readonly Readonly<{ spatialContinuity?: unknown }>[];
}>): void {
  if (!input.expected?.q1StaticContinuity) {
    if (input.capability || input.plan || input.spatialContinuityPlan !== undefined || input.frames.some((frame) => frame.spatialContinuity !== undefined)) throw new Error("Strict-SDR all-delivered-frame record retained Q1 facts outside its sealed binding.");
    return;
  }
  if (!input.capability || !input.plan || input.spatialContinuityPlan === undefined || input.frames.length !== FRAME_COUNT || input.frames.some((frame) => frame.spatialContinuity === undefined)) throw new Error("Strict-SDR all-delivered-frame record lacks complete sealed Q1 facts.");
}

export function assertStrictSdrCandidateAllDeliveredFrameStageInput(input: Readonly<{
  pair: StrictSdrCandidateHeldPair; slot: StrictSdrCandidateThreeSlot; expectedFrameIndex: number; observation: StrictSdrCandidateHeldPairObservation;
  snapshot: Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>; frameIndex: number;
  decodedFrame: Readonly<{ sha256: string; byteLength: number }>; allPixels: StrictSdrCandidateThreeSlotAllPixelMeasurement;
  samples?: StrictSdrCandidateF2bScreenControlsThreeSlotSamples;
}>): void {
  if (input.frameIndex !== input.expectedFrameIndex || input.frameIndex < 0 || input.frameIndex >= FRAME_COUNT || input.snapshot.byteLength !== FRAME_BYTES || input.snapshot.bytes.byteLength !== FRAME_BYTES || !SHA256.test(input.snapshot.sha256) || !matchesCurrentStrictSdrCandidateHeldPairObservation(input.pair, input.observation) || !fact(input.observation.media) || !fact(input.observation.receipt) || !SHA256.test(input.decodedFrame.sha256) || input.decodedFrame.byteLength !== FRAME_BYTES || !allPixels(input.allPixels) || (input.slot === "f2b-screen-controls") !== (input.samples !== undefined) || input.samples !== undefined && !samples(input.samples)) throw new Error("Strict-SDR all-delivered-frame stage does not retain its exact descriptor-bound literal frame facts.");
}

export function assertStrictSdrCandidateAllDeliveredFrameCanonicalBound(value: unknown, maximum: number, label: string): void {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > maximum) throw new Error(`${label} exceeds its canonical byte cap.`);
}

export function assertStrictSdrCandidateAllDeliveredFrameObservationEnvelope(value: Readonly<{ schema: string; bindingSha256: string; slots: readonly StrictSdrCandidateAllDeliveredFrameObservation[] }>): void {
  if (value.schema !== "shellx-motion/strict-sdr-candidate-all-delivered-frame-observation-result@1" || !SHA256.test(value.bindingSha256) || !Array.isArray(value.slots) || value.slots.length !== 3 || value.slots[0]?.slot !== "f2a" || value.slots[1]?.slot !== "f2b-screen" || value.slots[2]?.slot !== "f2b-screen-controls") throw new Error("Strict-SDR all-delivered-frame child envelope is malformed or reordered.");
  assertStrictSdrCandidateAllDeliveredFrameCanonicalBound(value, CHILD_MAX_BYTES, "Strict-SDR all-delivered-frame child envelope");
}

function fact(value: Readonly<{ sha256: string; byteLength: number }>): boolean { return SHA256.test(value.sha256) && Number.isSafeInteger(value.byteLength) && value.byteLength > 0; }
function allPixels(value: StrictSdrCandidateThreeSlotAllPixelMeasurement): boolean {
  const pixels = 1280 * 720;
  return Number.isSafeInteger(value.pixelCount) && value.pixelCount === pixels && Number.isSafeInteger(value.rgbSampleCount) && value.rgbSampleCount === pixels * 3 && Number.isSafeInteger(value.maximumChannelDelta) && value.maximumChannelDelta >= 0 && value.maximumChannelDelta <= 255 && Number.isFinite(value.meanAbsoluteChannelDelta) && value.meanAbsoluteChannelDelta >= 0 && value.meanAbsoluteChannelDelta <= 255 && Number.isSafeInteger(value.alphaMismatchedPixelCount) && value.alphaMismatchedPixelCount >= 0 && value.alphaMismatchedPixelCount <= pixels;
}
function samples(value: StrictSdrCandidateF2bScreenControlsThreeSlotSamples): boolean {
  const expected = [["screen-saturated-overlays", 240, 356], ["screen-partial-alpha-control", 640, 356], ["transparent-screen-zero-alpha-control", 1040, 356]] as const;
  return value.length === expected.length && value.every((sample, index) => sample.name === expected[index]![0] && sample.x === expected[index]![1] && sample.y === expected[index]![2] && sample.sourceRgba8.length === 4 && sample.decodedRgba8.length === 4 && [...sample.sourceRgba8, ...sample.decodedRgba8].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255));
}
function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} is not a plain data record.`);
  const names = Object.getOwnPropertyNames(value).sort(), expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new Error(`${label} keys are not exact.`);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable || Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set")) throw new Error(`${label}.${name} is not enumerable data.`);
  }
  return value as Record<string, unknown>;
}
