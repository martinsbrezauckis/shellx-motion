/** Literal M1 2-D source plan. It retains no decoded frame or caller-selected geometry. */
import { createHash } from "node:crypto";
import { linearSrgbGradientPosition, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  buildLinearSrgbSdrFinalReferenceDitherMask,
  linearSrgbSdrFinalReferenceDitherMaskBit,
  type LinearSrgbSdrFinalReferenceDitherMask,
} from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import {
  assertStrictSdrCandidateThreeSlot2dLiteralRoute,
  canonicalUnsignedBigIntDecimal,
  countStrictSdrCandidateThreeSlot2dBits,
  sourceVarianceNumerator,
} from "./linear-srgb-sdr-final-three-slot-2d-accumulators.js";
import type { StrictSdrCandidateThreeSlot } from "./linear-srgb-sdr-final-three-slot-measurement.js";

const WIDTH = 1_280, HEIGHT = 720, FRAME_BYTES = 3_686_400, MASK_BYTES = 115_200;
const SHA256 = /^[a-f0-9]{64}$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const PAIR_CAPACITY = WIDTH * HEIGHT;
const EXPECTATION_KEYS = ["m1Sha256", "sourcePlanSha256", "slot", "routeFingerprint", "documentFingerprint", "sourceFrameSha256", "sourceFrameByteLength", "ditherMaskSha256", "domains"] as const;
const DOMAIN_KEYS = ["key", "directSampleCount", "tangentAnchorCount", "omittedAnchorCount", "pairCount", "topologySha256", "sourceVarianceNumeratorDecimal"] as const;

export type StrictSdrCandidateThreeSlot2dDomainKey =
  | "f2a.linear.safe" | "f2a.radial.inner" | "f2a.radial.outer"
  | "f2b-screen.normal.unoccluded" | "f2b-screen.radial" | "f2b-screen.flat.overlap"
  | "f2b-screen-controls.saturated" | "f2b-screen-controls.partial-alpha" | "f2b-screen-controls.zero-alpha";

export type StrictSdrCandidateThreeSlot2dMeasurementDomain = Readonly<{
  key: StrictSdrCandidateThreeSlot2dDomainKey;
  directSampleCount: number;
  tangentAnchorCount: number | null;
  omittedAnchorCount: number | null;
  pairCount: number | null;
  topologySha256: string | null;
  sourceVarianceNumeratorDecimal: string | null;
}>;

export type StrictSdrCandidateThreeSlot2dMeasurementExpectation = Readonly<{
  m1Sha256: string;
  sourcePlanSha256: string;
  slot: StrictSdrCandidateThreeSlot;
  routeFingerprint: string;
  documentFingerprint: string;
  sourceFrameSha256: string;
  sourceFrameByteLength: 3_686_400;
  ditherMaskSha256: string | null;
  domains: readonly StrictSdrCandidateThreeSlot2dMeasurementDomain[];
}>;
/** Parent-held source-plan input only; it cannot activate, bind, or route M1. */
export type StrictSdrCandidateThreeSlot2dMeasurementWitness = Readonly<Omit<StrictSdrCandidateThreeSlot2dMeasurementExpectation, "m1Sha256" | "sourcePlanSha256">>;

export type StrictSdrCandidateThreeSlot2dSpatialPlan = Readonly<{
  schema: "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d@1";
  m1Sha256: string;
  sourcePlanSha256: string;
  ditherMaskSha256: string | null;
  domains: readonly StrictSdrCandidateThreeSlot2dMeasurementDomain[];
}>;
export type StrictSdrCandidateThreeSlot2dMeasurementPlan = Readonly<{ spatialPlan: StrictSdrCandidateThreeSlot2dSpatialPlan }>;

type DomainDefinition = Readonly<{
  key: StrictSdrCandidateThreeSlot2dDomainKey;
  left: number; top: number; right: number; bottom: number;
  tangent: boolean;
  contains(x: number, y: number, mask: LinearSrgbSdrFinalReferenceDitherMask | undefined): boolean;
  scalar?(x: number, y: number): number;
}>;
type DomainInternal = Readonly<{ definition: DomainDefinition; pairStart: number; pairCount: number }>;
type Internal = { readonly mask: LinearSrgbSdrFinalReferenceDitherMask | undefined; readonly referenceMaskEligibleCount: number | null; readonly pairs: Uint32Array; readonly domains: readonly DomainInternal[]; readonly sourceFrameSha256: string; disposed: boolean };
type ConstructedPlan = Readonly<{ mask: LinearSrgbSdrFinalReferenceDitherMask | undefined; referenceMaskEligibleCount: number | null; pairs: Uint32Array; domains: readonly StrictSdrCandidateThreeSlot2dMeasurementDomain[]; details: readonly DomainInternal[] }>;
const internals = new WeakMap<object, Internal>();

/** Builds and verifies one literal slot plan before the all-frame FFmpeg child starts. */
export function buildStrictSdrCandidateThreeSlot2dMeasurementPlan(input: Readonly<{
  route: LinearSrgbSdrFinalRoute;
  sourceRgba8: Buffer;
  expected: StrictSdrCandidateThreeSlot2dMeasurementExpectation;
}>): StrictSdrCandidateThreeSlot2dMeasurementPlan {
  assertExpectation(input.expected);
  assertStrictSdrCandidateThreeSlot2dLiteralRoute(input.expected.slot, input.route);
  if (input.sourceRgba8.byteLength !== FRAME_BYTES || sourceSha256(input.sourceRgba8) !== input.expected.sourceFrameSha256
    || input.route.fingerprint !== input.expected.routeFingerprint || input.route.documentFingerprint !== input.expected.documentFingerprint) {
    throw new Error("Strict-SDR spatial plan source identity does not match its sealed literal binding.");
  }
  const constructed = constructLiteralPlan(input.expected.slot, input.route, input.sourceRgba8);
  let retained = false;
  try {
    if ((constructed.mask?.sha256 ?? null) !== input.expected.ditherMaskSha256 || constructed.domains.some((domain, index) => !sameDomain(domain, input.expected.domains[index]!))) {
      throw new Error("Strict-SDR spatial plan differs from its sealed topology or source-variance binding.");
    }
    const spatialPlan: StrictSdrCandidateThreeSlot2dSpatialPlan = Object.freeze({
      schema: "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d@1",
      m1Sha256: input.expected.m1Sha256, sourcePlanSha256: input.expected.sourcePlanSha256,
      ditherMaskSha256: input.expected.ditherMaskSha256, domains: constructed.domains,
    });
    const plan: StrictSdrCandidateThreeSlot2dMeasurementPlan = Object.freeze({ spatialPlan });
    internals.set(plan, {
      mask: constructed.mask, referenceMaskEligibleCount: constructed.referenceMaskEligibleCount,
      pairs: constructed.pairs, domains: constructed.details, sourceFrameSha256: input.expected.sourceFrameSha256, disposed: false,
    });
    retained = true;
    return plan;
  } finally { if (!retained) releaseConstructedPlan(constructed); }
}

/** Derives one fixed literal source witness through the same bounded plan construction as runtime admission. */
export function deriveStrictSdrCandidateThreeSlot2dMeasurementWitness(input: Readonly<{
  slot: StrictSdrCandidateThreeSlot;
  route: LinearSrgbSdrFinalRoute;
  sourceRgba8: Buffer;
}>): StrictSdrCandidateThreeSlot2dMeasurementWitness {
  assertStrictSdrCandidateThreeSlot2dLiteralRoute(input.slot, input.route);
  if (input.sourceRgba8.byteLength !== FRAME_BYTES) throw new Error("Strict-SDR source-plan witness requires one exact literal RGBA8 source frame.");
  const constructed = constructLiteralPlan(input.slot, input.route, input.sourceRgba8);
  try {
    return Object.freeze({
      slot: input.slot, routeFingerprint: input.route.fingerprint, documentFingerprint: input.route.documentFingerprint,
      sourceFrameSha256: sourceSha256(input.sourceRgba8), sourceFrameByteLength: FRAME_BYTES,
      ditherMaskSha256: constructed.mask?.sha256 ?? null, domains: constructed.domains,
    });
  } finally { releaseConstructedPlan(constructed); }
}

export function disposeStrictSdrCandidateThreeSlot2dMeasurementPlan(plan: StrictSdrCandidateThreeSlot2dMeasurementPlan): void {
  const internal = internals.get(plan);
  if (!internal || internal.disposed) throw new Error("Strict-SDR spatial plan is absent or has already been disposed.");
  internal.pairs.fill(0); internal.mask?.packedRowMajorBits.fill(0); internal.disposed = true;
  internals.delete(plan);
}

export function visitStrictSdrCandidateThreeSlot2dMeasurementDomain(plan: StrictSdrCandidateThreeSlot2dMeasurementPlan, index: number, visit: (pixelIndex: number) => void): void {
  const internal = current(plan), domain = internal.domains[index];
  if (!domain) throw new Error("Strict-SDR spatial plan has no literal domain at this position.");
  forEachPoint(domain.definition, internal.mask, visit);
}

/** Rechecks the sealed producer bytes without retaining a second source-frame reference. */
export function assertStrictSdrCandidateThreeSlot2dMeasurementPlanSource(plan: StrictSdrCandidateThreeSlot2dMeasurementPlan, sourceRgba8: Buffer): void {
  const internal = current(plan);
  if (sourceRgba8.byteLength !== FRAME_BYTES || sourceSha256(sourceRgba8) !== internal.sourceFrameSha256) {
    throw new Error("Strict-SDR spatial observation source bytes no longer match the sealed producer snapshot.");
  }
}

export function withStrictSdrCandidateThreeSlot2dMeasurementPairs<T>(plan: StrictSdrCandidateThreeSlot2dMeasurementPlan, index: number, operation: (pairs: Uint32Array, start: number, count: number) => T): T {
  const internal = current(plan), domain = internal.domains[index];
  if (!domain || !domain.definition.tangent) throw new Error("Strict-SDR spatial plan domain has no tangent topology.");
  return operation(internal.pairs, domain.pairStart, domain.pairCount);
}

function current(plan: StrictSdrCandidateThreeSlot2dMeasurementPlan): Internal {
  const internal = internals.get(plan);
  if (!internal || internal.disposed) throw new Error("Strict-SDR spatial plan has expired or was disposed.");
  return internal;
}

/** Allocates only fixed plan state; every caller must release it unless ownership moves into a plan. */
function constructLiteralPlan(slot: StrictSdrCandidateThreeSlot, route: LinearSrgbSdrFinalRoute, source: Buffer): ConstructedPlan {
  let mask: LinearSrgbSdrFinalReferenceDitherMask | undefined;
  let pairs: Uint32Array | undefined;
  try {
    if (slot === "f2a") {
      // Take cleanup ownership before inspecting the independently built reference mask.
      mask = buildLinearSrgbSdrFinalReferenceDitherMask(route);
      if (mask.packedRowMajorBits.byteLength !== MASK_BYTES || !SHA256.test(mask.sha256)
        || sourceSha256(mask.packedRowMajorBits) !== mask.sha256 || !Number.isSafeInteger(mask.eligibleCount)
        || mask.eligibleCount < 0 || mask.eligibleCount > WIDTH * HEIGHT || countStrictSdrCandidateThreeSlot2dBits(mask.packedRowMajorBits) !== mask.eligibleCount) {
        throw new Error("Strict-SDR reference dither mask is not the fixed sealed 1280x720 bitset.");
      }
    }
    const definitions = literalDefinitions(slot, route), domains: StrictSdrCandidateThreeSlot2dMeasurementDomain[] = [], details: DomainInternal[] = [];
    const pairBuffer = new Uint32Array(PAIR_CAPACITY * 2);
    pairs = pairBuffer;
    let pairWrite = 0;
    for (const definition of definitions) {
      let directSampleCount = 0;
      forEachPoint(definition, mask, (pixelIndex) => {
        if (source[pixelIndex * 4 + 3] !== 255) {
          throw new Error("Strict-SDR spatial plan refuses a non-opaque source pixel in a literal domain.");
        }
        directSampleCount += 1;
      });
      if (directSampleCount <= 0) throw new Error("Strict-SDR spatial plan produced an empty literal domain.");
      const pairStart = pairWrite;
      const topology = definition.tangent ? createTopology(definition, mask, pairBuffer, pairWrite) : undefined;
      if (topology) pairWrite = topology.nextPairWrite;
      const measured: StrictSdrCandidateThreeSlot2dMeasurementDomain = Object.freeze(topology ? {
        key: definition.key, directSampleCount, tangentAnchorCount: directSampleCount, omittedAnchorCount: topology.omitted,
        pairCount: topology.pairCount, topologySha256: topology.sha256,
        sourceVarianceNumeratorDecimal: canonicalUnsignedBigIntDecimal(sourceVarianceNumerator(source, pairBuffer, pairStart, topology.pairCount)),
      } : {
        key: definition.key, directSampleCount, tangentAnchorCount: null, omittedAnchorCount: null,
        pairCount: null, topologySha256: null, sourceVarianceNumeratorDecimal: null,
      });
      if (!validDomain(measured, definition.key)) throw new Error("Strict-SDR spatial plan produced an invalid fixed literal domain.");
      domains.push(measured);
      details.push(Object.freeze({ definition, pairStart, pairCount: topology?.pairCount ?? 0 }));
    }
    return Object.freeze({
      mask, referenceMaskEligibleCount: mask?.eligibleCount ?? null, pairs: pairBuffer,
      domains: Object.freeze(domains), details: Object.freeze(details),
    });
  } catch (error) {
    pairs?.fill(0);
    mask?.packedRowMajorBits.fill(0);
    throw error;
  }
}

function releaseConstructedPlan(plan: ConstructedPlan): void {
  plan.pairs.fill(0);
  plan.mask?.packedRowMajorBits.fill(0);
}

function createTopology(definition: DomainDefinition, mask: LinearSrgbSdrFinalReferenceDitherMask | undefined, pairs: Uint32Array, pairWrite: number) {
  const hash = createHash("sha256"), record = Buffer.allocUnsafe(8);
  let omitted = 0, pairCount = 0, nextPairWrite = pairWrite;
  forEachPoint(definition, mask, (anchor) => {
    const x = anchor % WIDTH, y = Math.floor(anchor / WIDTH), scalar = definition.scalar!(x, y);
    if (!Number.isFinite(scalar)) throw new Error("Strict-SDR spatial topology has a non-finite analytic gradient scalar.");
    let selected: number | undefined, best = Number.POSITIVE_INFINITY;
    for (const [dx, dy] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
      const qx = x + dx, qy = y + dy;
      if (!definition.contains(qx, qy, mask)) continue;
      const candidate = definition.scalar!(qx, qy), delta = Math.abs(candidate - scalar);
      if (!Number.isFinite(candidate) || !Number.isFinite(delta)) throw new Error("Strict-SDR spatial topology has a non-finite candidate scalar.");
      if (delta < best) { best = delta; selected = qy * WIDTH + qx; }
    }
    const endpoint = selected ?? 0xffff_ffff;
    record.writeUInt32BE(anchor, 0); record.writeUInt32BE(endpoint, 4); hash.update(record);
    if (selected === undefined) { omitted += 1; return; }
    if (nextPairWrite >= PAIR_CAPACITY) throw new Error("Strict-SDR spatial topology exceeds its fixed pair capacity.");
    const low = Math.min(anchor, selected), high = Math.max(anchor, selected);
    // Rank offsets never move left. For vertical pairs the upper endpoint owns the pair;
    // for every other pair the left endpoint owns it, so a duplicate key is structurally impossible.
    if (low === high || (x === selected % WIDTH && low !== anchor) || (x !== selected % WIDTH && x > selected % WIDTH)) {
      throw new Error("Strict-SDR spatial topology produced a duplicate or noncanonical undirected pair.");
    }
    pairs[nextPairWrite * 2] = low; pairs[nextPairWrite * 2 + 1] = high;
    nextPairWrite += 1; pairCount += 1;
  });
  return { omitted, pairCount, nextPairWrite, sha256: hash.digest("hex") };
}

function forEachPoint(definition: DomainDefinition, mask: LinearSrgbSdrFinalReferenceDitherMask | undefined, visit: (pixelIndex: number) => void): void {
  for (let y = definition.top; y < definition.bottom; y += 1) for (let x = definition.left; x < definition.right; x += 1) {
    if (definition.contains(x, y, mask)) visit(y * WIDTH + x);
  }
}

function literalDefinitions(slot: StrictSdrCandidateThreeSlot, route: LinearSrgbSdrFinalRoute): readonly DomainDefinition[] {
  const rect = (index: number) => route.rects[index]!;
  const gradientScalar = (value: Extract<LinearSrgbSdrFinalRoute["rects"][number], { gradient: unknown }>) => (x: number, y: number) => linearSrgbGradientPosition(value.gradient, (x + .5 - value.x) / value.width, (y + .5 - value.y) / value.height);
  if (slot === "f2a") {
    const linear = rect(0) as Extract<LinearSrgbSdrFinalRoute["rects"][number], { gradient: unknown }>, radial = rect(1) as Extract<LinearSrgbSdrFinalRoute["rects"][number], { gradient: unknown }>;
    const radialScalar = gradientScalar(radial);
    return [
      domain("f2a.linear.safe", 96, 96, 576, 624, true, (x, y, mask) => maskBit(mask, x, y), gradientScalar(linear)),
      domain("f2a.radial.inner", 672, 64, 1216, 656, true, (x, y, mask) => maskBit(mask, x, y) && radialScalar(x, y) >= 1 / 8 && radialScalar(x, y) <= 3 / 8, radialScalar),
      domain("f2a.radial.outer", 672, 64, 1216, 656, true, (x, y) => radialScalar(x, y) >= 5 / 8 && radialScalar(x, y) <= 11 / 16, radialScalar),
    ];
  }
  if (slot === "f2b-screen") {
    const normal = rect(3) as Extract<LinearSrgbSdrFinalRoute["rects"][number], { gradient: unknown }>, radial = rect(4) as Extract<LinearSrgbSdrFinalRoute["rects"][number], { gradient: unknown }>;
    return [
      domain("f2b-screen.normal.unoccluded", 700, 156, 1120, 564, true, (x, y) => x < 760 || x >= 1040 || y < 216 || y >= 504, gradientScalar(normal)),
      domain("f2b-screen.radial", 760, 216, 1040, 504, true, () => true, gradientScalar(radial)),
      domain("f2b-screen.flat.overlap", 360, 236, 580, 484, false, () => true),
    ];
  }
  return [
    domain("f2b-screen-controls.saturated", 64, 180, 416, 532, false, () => true),
    domain("f2b-screen-controls.partial-alpha", 464, 180, 816, 532, false, () => true),
    domain("f2b-screen-controls.zero-alpha", 864, 180, 1216, 532, false, () => true),
  ];
}

function domain(key: StrictSdrCandidateThreeSlot2dDomainKey, left: number, top: number, right: number, bottom: number, tangent: boolean, contains: DomainDefinition["contains"], scalar?: DomainDefinition["scalar"]): DomainDefinition {
  return Object.freeze({ key, left, top, right, bottom, tangent, contains: (x, y, mask) => x >= left && x < right && y >= top && y < bottom && contains(x, y, mask), ...(scalar ? { scalar } : {}) });
}

function maskBit(mask: LinearSrgbSdrFinalReferenceDitherMask | undefined, x: number, y: number): boolean {
  return !!mask && x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && linearSrgbSdrFinalReferenceDitherMaskBit(mask, x, y);
}

function assertExpectation(value: StrictSdrCandidateThreeSlot2dMeasurementExpectation): void {
  if (!hasExactDataKeys(value, EXPECTATION_KEYS) || !isExactArray(value.domains, 3)) {
    throw new Error("Strict-SDR spatial expectation is not a closed expanded literal M1 binding slot.");
  }
  if (!isSlot(value.slot)) throw new Error("Strict-SDR spatial expectation has no literal M1 slot.");
  const expectedKeys = keysFor(value.slot);
  if (!SHA256.test(value.m1Sha256) || !SHA256.test(value.sourcePlanSha256) || !SHA256.test(value.routeFingerprint) || !SHA256.test(value.documentFingerprint)
    || !SHA256.test(value.sourceFrameSha256) || value.sourceFrameByteLength !== FRAME_BYTES
    || (value.slot === "f2a" ? !SHA256.test(value.ditherMaskSha256 ?? "") : value.ditherMaskSha256 !== null)
    || value.domains.some((domain, index) => !validDomain(domain, expectedKeys[index]!))) {
    throw new Error("Strict-SDR spatial expectation is not an expanded literal M1 binding slot.");
  }
}

function validDomain(domain: unknown, key: StrictSdrCandidateThreeSlot2dDomainKey): boolean {
  if (!hasExactDataKeys(domain, DOMAIN_KEYS)) return false;
  const candidate = domain as StrictSdrCandidateThreeSlot2dMeasurementDomain;
  const direct = Number.isSafeInteger(candidate.directSampleCount) && candidate.directSampleCount > 0 && candidate.directSampleCount <= PAIR_CAPACITY;
  if (!direct || candidate.key !== key) return false;
  const tangent = candidate.tangentAnchorCount !== null || candidate.omittedAnchorCount !== null || candidate.pairCount !== null || candidate.topologySha256 !== null || candidate.sourceVarianceNumeratorDecimal !== null;
  if (!tangent) return true;
  const omitted = candidate.omittedAnchorCount, pairs = candidate.pairCount;
  return candidate.tangentAnchorCount === candidate.directSampleCount && typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted >= 0
    && typeof pairs === "number" && Number.isSafeInteger(pairs) && pairs > 0 && pairs + omitted === candidate.tangentAnchorCount
    && SHA256.test(candidate.topologySha256 ?? "") && NONNEGATIVE_DECIMAL.test(candidate.sourceVarianceNumeratorDecimal ?? "");
}

function sameDomain(left: StrictSdrCandidateThreeSlot2dMeasurementDomain, right: StrictSdrCandidateThreeSlot2dMeasurementDomain): boolean {
  return left.key === right.key && left.directSampleCount === right.directSampleCount && left.tangentAnchorCount === right.tangentAnchorCount
    && left.omittedAnchorCount === right.omittedAnchorCount && left.pairCount === right.pairCount && left.topologySha256 === right.topologySha256
    && left.sourceVarianceNumeratorDecimal === right.sourceVarianceNumeratorDecimal;
}

function keysFor(slot: StrictSdrCandidateThreeSlot): readonly StrictSdrCandidateThreeSlot2dDomainKey[] {
  return slot === "f2a" ? ["f2a.linear.safe", "f2a.radial.inner", "f2a.radial.outer"]
    : slot === "f2b-screen" ? ["f2b-screen.normal.unoccluded", "f2b-screen.radial", "f2b-screen.flat.overlap"]
      : ["f2b-screen-controls.saturated", "f2b-screen-controls.partial-alpha", "f2b-screen-controls.zero-alpha"];
}

function isSlot(value: unknown): value is StrictSdrCandidateThreeSlot {
  return value === "f2a" || value === "f2b-screen" || value === "f2b-screen-controls";
}

function sourceSha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort(), expected = [...keys].sort();
  return names.length === expected.length && names.every((name, index) => name === expected[index]) && names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value") && !Object.hasOwn(descriptor, "get") && !Object.hasOwn(descriptor, "set");
  });
}

function isExactArray(value: unknown, length: number): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0
    || value.length !== length || Object.keys(value).length !== length || Object.getOwnPropertyNames(value).length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set")) return false;
  }
  return true;
}
