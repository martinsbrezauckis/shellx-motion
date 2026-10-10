/** Private facade for one borrowed-RGBA M1 spatial observation per literal frame. */
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  accumulateStrictSdrCandidateThreeSlot2dDirect,
  accumulateStrictSdrCandidateThreeSlot2dTangent,
  isCanonicalSignedBigIntDecimal,
  isCanonicalUnsignedBigIntDecimal,
  type StrictSdrCandidateThreeSlot2dDirectTuple,
  type StrictSdrCandidateThreeSlot2dSpatialTuple,
  type StrictSdrCandidateThreeSlot2dTangentTuple,
} from "./linear-srgb-sdr-final-three-slot-2d-accumulators.js";
import {
  visitStrictSdrCandidateThreeSlot2dMeasurementDomain,
  assertStrictSdrCandidateThreeSlot2dMeasurementPlanSource,
  withStrictSdrCandidateThreeSlot2dMeasurementPairs,
  type StrictSdrCandidateThreeSlot2dMeasurementDomain,
  type StrictSdrCandidateThreeSlot2dMeasurementExpectation,
  type StrictSdrCandidateThreeSlot2dMeasurementPlan,
  type StrictSdrCandidateThreeSlot2dSpatialPlan,
} from "./linear-srgb-sdr-final-three-slot-2d-plan.js";

const FRAME_BYTES = 3_686_400;
const SHA256 = /^[a-f0-9]{64}$/u;
const M1A_SCHEMA = "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d-binding@2";
const M1A_Q1_SCHEMA = "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d-binding@3";
const M1A_SHA256 = "6094a359867488d16e65b2fb7f5a3b1dca23dc9cee8a1326d2f4d905558eb571";
const M1A_CAP_PROOF_SHA256 = "5150a8a969644b58735ad77d20c182ad07981ffc131fe38952382b6fde1cfdef";
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const DIRECT_KEYS = [
  ["f2a.linear.safe", "f2a.radial.inner", "f2a.radial.outer"],
  ["f2b-screen.normal.unoccluded", "f2b-screen.radial", "f2b-screen.flat.overlap"],
  ["f2b-screen-controls.saturated", "f2b-screen-controls.partial-alpha", "f2b-screen-controls.zero-alpha"],
] as const;
const M1A_SLOTS = [
  { slot: "f2a" as const, mask: true, domains: [["f2a.linear.safe", true], ["f2a.radial.inner", true], ["f2a.radial.outer", true]] as const },
  { slot: "f2b-screen" as const, mask: false, domains: [["f2b-screen.normal.unoccluded", true], ["f2b-screen.radial", true], ["f2b-screen.flat.overlap", false]] as const },
  { slot: "f2b-screen-controls" as const, mask: false, domains: [["f2b-screen-controls.saturated", false], ["f2b-screen-controls.partial-alpha", false], ["f2b-screen-controls.zero-alpha", false]] as const },
] as const;

export type { StrictSdrCandidateThreeSlot2dMeasurementDomain, StrictSdrCandidateThreeSlot2dMeasurementExpectation, StrictSdrCandidateThreeSlot2dMeasurementPlan, StrictSdrCandidateThreeSlot2dSpatialPlan };
export type StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair = Readonly<{
  m1aSpatialMeasurement: unknown;
  m1aSpatialMeasurementSha256: string;
}>;
export type StrictSdrCandidateThreeSlot2dSpatialFrame = Readonly<{ spatial: readonly StrictSdrCandidateThreeSlot2dSpatialTuple[] }>;
export type StrictSdrCandidateThreeSlotM1aMeasurementExpectation = StrictSdrCandidateThreeSlot2dMeasurementExpectation & Readonly<{
  q1StaticContinuity?: Readonly<{ profileVersion: 1; continuityImplementationSha256: string }>;
}>;

/** Restores one fixed compact M1 binding slot without importing the scripts transport helper. */
export function assertStrictSdrCandidateThreeSlotM1aMeasurementExpectation(pair: StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair, slot: StrictSdrCandidateThreeSlot2dMeasurementExpectation["slot"]): StrictSdrCandidateThreeSlotM1aMeasurementExpectation {
  const joined = exactRecord(pair, ["m1aSpatialMeasurement", "m1aSpatialMeasurementSha256"], "Strict-SDR M1a spatial binding pair");
  if (!sha(joined.m1aSpatialMeasurementSha256)) throw new Error("Strict-SDR M1a spatial binding pair lacks its exact binding hash.");
  const raw = joined.m1aSpatialMeasurement;
  const q1Binding = !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype
    && Object.getOwnPropertyDescriptor(raw, "schema")?.value === M1A_Q1_SCHEMA;
  const binding = exactRecord(raw, ["schema", "m1Sha256", "capProofSha256", "sourceFilesManifestSha256", "fixtureInputsManifestSha256", "slots", "sourcePlanSha256", ...(q1Binding ? ["q1"] : [])], "Strict-SDR M1a compact spatial binding");
  if (binding.schema !== (q1Binding ? M1A_Q1_SCHEMA : M1A_SCHEMA) || binding.m1Sha256 !== M1A_SHA256 || binding.capProofSha256 !== M1A_CAP_PROOF_SHA256
    || !sha(binding.sourceFilesManifestSha256) || !sha(binding.fixtureInputsManifestSha256) || !sha(binding.sourcePlanSha256)
    || canonicalJsonSha256(binding) !== joined.m1aSpatialMeasurementSha256) {
    throw new Error("Strict-SDR M1a compact spatial binding differs from its fixed schema, identity, or Core canonical hash.");
  }
  const q1 = q1Binding ? exactArray(binding.q1, 2, "Strict-SDR M1a Q1 compact binding") : undefined;
  if (q1 !== undefined && (q1[0] !== 1 || !sha(q1[1]))) throw new Error("Strict-SDR M1a Q1 compact binding lacks its literal profile or implementation identity.");
  const index = M1A_SLOTS.findIndex((candidate) => candidate.slot === slot), specification = M1A_SLOTS[index];
  if (!specification) throw new Error("Strict-SDR M1a compact spatial binding has no literal slot selection.");
  const compactSlots = exactArray(binding.slots, M1A_SLOTS.length, "Strict-SDR M1a compact spatial slots");
  const compactSlot = exactArray(compactSlots[index], specification.mask ? 5 : 4, `Strict-SDR M1a ${slot} compact slot`);
  const compactDomains = exactArray(compactSlot[specification.mask ? 4 : 3], specification.domains.length, `Strict-SDR M1a ${slot} compact domains`);
  const domains: StrictSdrCandidateThreeSlot2dMeasurementDomain[] = specification.domains.map(([key, tangent], domainIndex) => {
    const compact = exactArray(compactDomains[domainIndex], tangent ? 5 : 1, `Strict-SDR M1a ${slot} compact domain ${key}`);
    const directSampleCount = boundedInteger(compact[0], 1, 921_600, `Strict-SDR M1a ${slot} ${key} direct sample count`);
    if (!tangent) return Object.freeze({ key, directSampleCount, tangentAnchorCount: null, omittedAnchorCount: null, pairCount: null, topologySha256: null, sourceVarianceNumeratorDecimal: null });
    const omittedAnchorCount = boundedInteger(compact[1], 0, directSampleCount, `Strict-SDR M1a ${slot} ${key} omitted anchor count`);
    const pairCount = boundedInteger(compact[2], 1, directSampleCount, `Strict-SDR M1a ${slot} ${key} pair count`);
    if (pairCount + omittedAnchorCount !== directSampleCount || !sha(compact[3]) || typeof compact[4] !== "string" || !UNSIGNED_DECIMAL.test(compact[4])) {
      throw new Error("Strict-SDR M1a compact spatial tangent domain is not a closed literal tuple.");
    }
    return Object.freeze({ key, directSampleCount, tangentAnchorCount: directSampleCount, omittedAnchorCount, pairCount, topologySha256: compact[3] as string, sourceVarianceNumeratorDecimal: compact[4] as string });
  });
  const mask = specification.mask ? compactSlot[3] : null;
  if (specification.mask ? !sha(mask) : mask !== null) throw new Error("Strict-SDR M1a compact spatial slot has an invalid schema-owned dither mask.");
  if (!sha(compactSlot[0]) || !sha(compactSlot[1]) || !sha(compactSlot[2])) throw new Error("Strict-SDR M1a compact spatial slot has malformed route or source identities.");
  return Object.freeze({ m1Sha256: M1A_SHA256, sourcePlanSha256: binding.sourcePlanSha256 as string, slot,
    routeFingerprint: compactSlot[0] as string, documentFingerprint: compactSlot[1] as string, sourceFrameSha256: compactSlot[2] as string, sourceFrameByteLength: FRAME_BYTES,
    ditherMaskSha256: mask as string | null, domains: Object.freeze(domains),
    ...(q1 === undefined ? {} : { q1StaticContinuity: Object.freeze({ profileVersion: 1 as const, continuityImplementationSha256: q1[1] as string }) }),
  });
}

/** Validates optional M1 facts before temporal staging without repeating measurement math. */
export function assertStrictSdrCandidateThreeSlot2dTemporalSpatialStage(input: Readonly<{
  expected: StrictSdrCandidateThreeSlotM1aMeasurementExpectation | undefined;
  priorSpatialPlan: StrictSdrCandidateThreeSlot2dSpatialPlan | undefined;
  spatialPlan: unknown;
  spatial: unknown;
}>): Readonly<{
  spatialPlan: StrictSdrCandidateThreeSlot2dSpatialPlan | undefined;
  spatial: StrictSdrCandidateThreeSlot2dSpatialFrame | undefined;
}> {
  if (!input.expected) {
    if (input.spatialPlan !== undefined || input.spatial !== undefined) throw new Error("Strict-SDR all-delivered-frame stage does not retain its exact descriptor-bound literal frame facts.");
    return Object.freeze({ spatialPlan: undefined, spatial: undefined });
  }
  if (input.spatialPlan === undefined || input.spatial === undefined) throw new Error("Strict-SDR all-delivered-frame stage does not retain its exact descriptor-bound literal frame facts.");
  const spatialPlan = assertStrictSdrCandidateThreeSlot2dSpatialPlan(input.spatialPlan);
  if (spatialPlan.m1Sha256 !== input.expected.m1Sha256 || spatialPlan.sourcePlanSha256 !== input.expected.sourcePlanSha256
    || spatialPlan.ditherMaskSha256 !== input.expected.ditherMaskSha256 || canonicalJson(spatialPlan.domains) !== canonicalJson(input.expected.domains)
    || input.priorSpatialPlan !== undefined && canonicalJson(input.priorSpatialPlan) !== canonicalJson(spatialPlan)) {
    throw new Error("Strict-SDR all-delivered-frame spatial plan changed from its selected compact binding.");
  }
  const spatial = assertStrictSdrCandidateThreeSlot2dSpatialFrame(input.spatial, spatialPlan);
  return Object.freeze({ spatialPlan, spatial });
}

/** Refuses a temporal record whose optional M1 facts do not cover its exact source and all sixty frames. */
export function assertStrictSdrCandidateThreeSlot2dTemporalSpatialRecord(input: Readonly<{
  expected: StrictSdrCandidateThreeSlotM1aMeasurementExpectation | undefined;
  spatialPlan: StrictSdrCandidateThreeSlot2dSpatialPlan | undefined;
  snapshot: Readonly<{ sha256: string; byteLength: number; route: Readonly<{ fingerprint: string; documentFingerprint: string }> }>;
  frames: readonly Readonly<{ spatial?: unknown }>[];
}>): void {
  const missing = input.expected === undefined
    ? input.spatialPlan !== undefined || input.frames.some((frame) => frame.spatial !== undefined)
    : !input.spatialPlan || input.snapshot.sha256 !== input.expected.sourceFrameSha256 || input.snapshot.byteLength !== input.expected.sourceFrameByteLength
      || input.snapshot.route.fingerprint !== input.expected.routeFingerprint || input.snapshot.route.documentFingerprint !== input.expected.documentFingerprint
      || input.frames.some((frame) => frame.spatial === undefined);
  if (missing) throw new Error("Strict-SDR all-delivered-frame record lacks complete fresh descriptor-bound frame facts.");
}

/** Measures a sealed source/borrowed decoded pair without retaining either byte buffer. */
export function measureStrictSdrCandidateThreeSlot2dMeasurement(input: Readonly<{
  plan: StrictSdrCandidateThreeSlot2dMeasurementPlan;
  sourceRgba8: Buffer;
  decodedRgba8: Buffer;
}>): StrictSdrCandidateThreeSlot2dSpatialFrame {
  const spatialPlan = assertStrictSdrCandidateThreeSlot2dSpatialPlan(input.plan.spatialPlan);
  if (input.sourceRgba8.byteLength !== FRAME_BYTES || input.decodedRgba8.byteLength !== FRAME_BYTES) {
    throw new Error("Strict-SDR spatial observation requires exactly one tight literal RGBA frame.");
  }
  assertStrictSdrCandidateThreeSlot2dMeasurementPlanSource(input.plan, input.sourceRgba8);
  const spatial = spatialPlan.domains.map((domain, index) => {
    const direct = accumulateStrictSdrCandidateThreeSlot2dDirect(input.sourceRgba8, input.decodedRgba8, (visit) => {
      visitStrictSdrCandidateThreeSlot2dMeasurementDomain(input.plan, index, visit);
    });
    if (direct[6] !== 0) throw new Error("Strict-SDR spatial observation refuses non-opaque source or decoded alpha before staging.");
    if (domain.tangentAnchorCount === null) return direct;
    return withStrictSdrCandidateThreeSlot2dMeasurementPairs(input.plan, index, (pairs, start, count) =>
      accumulateStrictSdrCandidateThreeSlot2dTangent(direct, input.sourceRgba8, input.decodedRgba8, pairs, start, count));
  });
  return assertStrictSdrCandidateThreeSlot2dSpatialFrame(Object.freeze({ spatial: Object.freeze(spatial) }), spatialPlan);
}

/** Structural boundary for temporal staging; it deliberately does not repeat measurement math. */
export function assertStrictSdrCandidateThreeSlot2dSpatialPlan(value: unknown): StrictSdrCandidateThreeSlot2dSpatialPlan {
  const record = exactRecord(value, ["schema", "m1Sha256", "sourcePlanSha256", "ditherMaskSha256", "domains"], "Strict-SDR spatial plan");
  if (record.schema !== "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d@1" || !sha(record.m1Sha256) || !sha(record.sourcePlanSha256)
    || !(typeof record.ditherMaskSha256 === "string" && sha(record.ditherMaskSha256) || record.ditherMaskSha256 === null)
    || !isExactArray(record.domains, 3)) {
    throw new Error("Strict-SDR spatial plan has an invalid closed observational shape.");
  }
  const domains = record.domains.map((domain) => assertDomain(domain));
  const keys = domains.map((domain) => domain.key).join(",");
  const expected = DIRECT_KEYS.find((candidate) => candidate.join(",") === keys);
  if (!expected || (expected[0]!.startsWith("f2a.") ? !sha(record.ditherMaskSha256) : record.ditherMaskSha256 !== null)) {
    throw new Error("Strict-SDR spatial plan does not retain a literal slot order or mask state.");
  }
  return Object.freeze({
    schema: "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d@1",
    m1Sha256: record.m1Sha256, sourcePlanSha256: record.sourcePlanSha256, ditherMaskSha256: record.ditherMaskSha256,
    domains: Object.freeze(domains),
  });
}

/** Structural boundary for one frame; all tuples remain scalar bounded facts. */
export function assertStrictSdrCandidateThreeSlot2dSpatialFrame(value: unknown, plan: StrictSdrCandidateThreeSlot2dSpatialPlan): StrictSdrCandidateThreeSlot2dSpatialFrame {
  const checkedPlan = assertStrictSdrCandidateThreeSlot2dSpatialPlan(plan);
  const record = exactRecord(value, ["spatial"], "Strict-SDR spatial frame");
  if (!isExactArray(record.spatial, checkedPlan.domains.length)) {
    throw new Error("Strict-SDR spatial frame has a missing or reordered literal domain tuple.");
  }
  const spatial = record.spatial.map((tuple, index) => assertTuple(tuple, checkedPlan.domains[index]!));
  return Object.freeze({ spatial: Object.freeze(spatial) });
}

function assertDomain(value: unknown): StrictSdrCandidateThreeSlot2dMeasurementDomain {
  const record = exactRecord(value, ["key", "directSampleCount", "tangentAnchorCount", "omittedAnchorCount", "pairCount", "topologySha256", "sourceVarianceNumeratorDecimal"], "Strict-SDR spatial domain");
  const keys = DIRECT_KEYS.flat(), key = record.key;
  if (typeof key !== "string" || !keys.includes(key as typeof keys[number]) || !safe(record.directSampleCount) || record.directSampleCount <= 0 || record.directSampleCount > 921_600) {
    throw new Error("Strict-SDR spatial domain has an invalid literal key or direct count.");
  }
  const tangent = record.tangentAnchorCount !== null || record.omittedAnchorCount !== null || record.pairCount !== null || record.topologySha256 !== null || record.sourceVarianceNumeratorDecimal !== null;
  const tangentExpected = key === "f2a.linear.safe" || key === "f2a.radial.inner" || key === "f2a.radial.outer"
    || key === "f2b-screen.normal.unoccluded" || key === "f2b-screen.radial";
  if (tangent !== tangentExpected) throw new Error("Strict-SDR spatial domain changed its literal tangent eligibility.");
  if (!tangent) {
    return Object.freeze({ key: key as StrictSdrCandidateThreeSlot2dMeasurementDomain["key"], directSampleCount: record.directSampleCount, tangentAnchorCount: null, omittedAnchorCount: null, pairCount: null, topologySha256: null, sourceVarianceNumeratorDecimal: null });
  }
  if (record.tangentAnchorCount !== record.directSampleCount || !safe(record.omittedAnchorCount) || record.omittedAnchorCount < 0
    || !safe(record.pairCount) || record.pairCount <= 0 || record.pairCount + record.omittedAnchorCount !== record.tangentAnchorCount
    || !sha(record.topologySha256) || !isCanonicalUnsignedBigIntDecimal(record.sourceVarianceNumeratorDecimal)) {
    throw new Error("Strict-SDR spatial tangent domain violates its fixed topology or BigInt grammar.");
  }
  return Object.freeze({
    key: key as StrictSdrCandidateThreeSlot2dMeasurementDomain["key"], directSampleCount: record.directSampleCount,
    tangentAnchorCount: record.tangentAnchorCount, omittedAnchorCount: record.omittedAnchorCount, pairCount: record.pairCount,
    topologySha256: record.topologySha256, sourceVarianceNumeratorDecimal: record.sourceVarianceNumeratorDecimal,
  });
}

function assertTuple(value: unknown, domain: StrictSdrCandidateThreeSlot2dMeasurementDomain): StrictSdrCandidateThreeSlot2dSpatialTuple {
  const tuple = exactArray(value, domain.tangentAnchorCount === null ? 7 : 16, "Strict-SDR spatial tuple");
  if (![0, 1, 2, 3, 4, 5, 6].every((index) => safe(tuple[index])) || tuple[6] !== 0
    || [0, 1, 2].some((index) => (tuple[index] as number) > 255)
    || [3, 4, 5].some((index) => (tuple[index] as number) > 255 * domain.directSampleCount)) {
    throw new Error("Strict-SDR spatial direct tuple has an invalid scalar or alpha refusal fact.");
  }
  const direct = directTuple(tuple);
  if (domain.tangentAnchorCount === null) return direct;
  const pairCount = domain.pairCount;
  if (pairCount === null || ![7, 8, 9, 10, 11, 12].every((index) => safe(tuple[index]))
    || [7, 8, 9].some((index) => (tuple[index] as number) > 510 * pairCount)
    || [10, 11, 12].some((index) => (tuple[index] as number) > 260_100 * pairCount)
    || (tuple[13] !== "defined" && tuple[13] !== "unavailable")) {
    throw new Error("Strict-SDR spatial tangent tuple has invalid residual accumulators.");
  }
  const state = correlationState(tuple[13]);
  if (state === "defined") {
    const maximum = BigInt(pairCount * 3) ** 2n * 255n ** 2n;
    const covariance = boundedDecimal(tuple[14], maximum, true), decodedVariance = boundedDecimal(tuple[15], maximum, false);
    if (domain.sourceVarianceNumeratorDecimal === "0" || decodedVariance === "0") {
      throw new Error("Strict-SDR spatial defined correlation has an invalid BigInt numerator grammar.");
    }
    return Object.freeze([
      ...direct, scalar(tuple, 7), scalar(tuple, 8), scalar(tuple, 9), scalar(tuple, 10), scalar(tuple, 11), scalar(tuple, 12),
      state, covariance, decodedVariance,
    ] as const satisfies StrictSdrCandidateThreeSlot2dTangentTuple);
  }
  if (tuple[14] !== null || tuple[15] !== null) throw new Error("Strict-SDR spatial unavailable correlation must omit both BigInt numerators.");
  return Object.freeze([
    ...direct, scalar(tuple, 7), scalar(tuple, 8), scalar(tuple, 9), scalar(tuple, 10), scalar(tuple, 11), scalar(tuple, 12),
    state, null, null,
  ] as const satisfies StrictSdrCandidateThreeSlot2dTangentTuple);
}

function directTuple(tuple: readonly unknown[]): StrictSdrCandidateThreeSlot2dDirectTuple {
  return Object.freeze([scalar(tuple, 0), scalar(tuple, 1), scalar(tuple, 2), scalar(tuple, 3), scalar(tuple, 4), scalar(tuple, 5), scalar(tuple, 6)] as const);
}
function scalar(tuple: readonly unknown[], index: number): number {
  const value = tuple[index];
  if (!safe(value)) throw new Error("Strict-SDR spatial tuple lost a validated scalar.");
  return value;
}
function correlationState(value: unknown): "defined" | "unavailable" {
  if (value !== "defined" && value !== "unavailable") throw new Error("Strict-SDR spatial tuple lost its correlation state.");
  return value;
}
function boundedDecimal(value: unknown, maximum: bigint, signed: boolean): string {
  if (typeof value !== "string") throw new Error("Strict-SDR spatial tuple lost its canonical BigInt grammar.");
  const text = value, digits = text[0] === "-" ? text.length - 1 : text.length;
  if (digits > maximum.toString().length) throw new Error("Strict-SDR spatial tuple exceeds its bounded BigInt decimal length.");
  if (!(signed ? isCanonicalSignedBigIntDecimal(text) : isCanonicalUnsignedBigIntDecimal(text))) throw new Error("Strict-SDR spatial tuple lost its canonical BigInt grammar.");
  const numerator = BigInt(text);
  if (numerator < (signed ? -maximum : 0n) || numerator > maximum) throw new Error("Strict-SDR spatial tuple exceeds its bounded BigInt numerator.");
  return text;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error(`${label} is not a plain data record.`);
  }
  const names = Object.getOwnPropertyNames(value).sort(), expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index]) || names.some((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set");
  })) throw new Error(`${label} keys are not exact enumerable data.`);
  return value as Record<string, unknown>;
}

function isExactArray(value: unknown, length: number): value is unknown[] {
  try { exactArray(value, length, "Strict-SDR spatial array"); return true; } catch { return false; }
}
function exactArray(value: unknown, length: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0
    || value.length !== length || Object.keys(value).length !== length || Object.getOwnPropertyNames(value).length !== length + 1) {
    throw new Error(`${label} is not a closed dense array.`);
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set")) {
      throw new Error(`${label} has a sparse, accessor, or non-enumerable member.`);
    }
  }
  return value;
}

function safe(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is not a bounded safe integer.`);
  return value;
}
function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
