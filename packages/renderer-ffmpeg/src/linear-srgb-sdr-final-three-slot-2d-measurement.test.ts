import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  accumulateStrictSdrCandidateThreeSlot2dDirect,
  accumulateStrictSdrCandidateThreeSlot2dTangent,
  sourceVarianceNumerator,
} from "./linear-srgb-sdr-final-three-slot-2d-accumulators.js";

const reference = vi.hoisted(() => ({ mask: undefined as Buffer | undefined }));
vi.mock("@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final", () => ({
  buildLinearSrgbSdrFinalReferenceDitherMask: () => {
    const mask = Buffer.alloc(115_200, 0x7f);
    reference.mask = mask;
    return { packedRowMajorBits: mask, sha256: "f".repeat(64), eligibleCount: 0 };
  },
  linearSrgbSdrFinalReferenceDitherMaskBit: () => false,
}));

import {
  buildStrictSdrCandidateThreeSlot2dMeasurementPlan,
  deriveStrictSdrCandidateThreeSlot2dMeasurementWitness,
  disposeStrictSdrCandidateThreeSlot2dMeasurementPlan,
  withStrictSdrCandidateThreeSlot2dMeasurementPairs,
} from "./linear-srgb-sdr-final-three-slot-2d-plan.js";
import {
  assertStrictSdrCandidateThreeSlot2dSpatialFrame,
  assertStrictSdrCandidateThreeSlot2dSpatialPlan,
  measureStrictSdrCandidateThreeSlot2dMeasurement,
} from "./linear-srgb-sdr-final-three-slot-2d-measurement.js";

const SHA = (letter: string) => letter.repeat(64);

describe("strict-SDR M1a 2-D scalar measurement", () => {
  it("computes direct and pooled RGB tangent facts with BigInt products", () => {
    const source = Buffer.from([10, 20, 30, 255, 20, 40, 60, 255]);
    const decoded = Buffer.from([11, 20, 30, 255, 21, 42, 59, 255]);
    const pairs = new Uint32Array([0, 1]);
    const direct = accumulateStrictSdrCandidateThreeSlot2dDirect(source, decoded, (visit) => { visit(0); visit(1); });

    expect(direct).toEqual([1, 2, 1, 2, 2, 1, 0]);
    expect(sourceVarianceNumerator(source, pairs, 0, 1)).toBe(600n);
    expect(accumulateStrictSdrCandidateThreeSlot2dTangent(direct, source, decoded, pairs, 0, 1))
      .toEqual([1, 2, 1, 2, 2, 1, 0, 0, 2, 1, 0, 4, 1, "defined", "570", "554"]);
  });

  it("rejects sparse, accessor, and alpha-bearing observational data", () => {
    const plan = controlsSpatialPlan();
    const sparse = Array.from({ length: 3 }, () => [0, 0, 0, 0, 0, 0, 0]);
    delete sparse[1];
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame({ spatial: sparse }, plan)).toThrow(/dense|missing/i);

    const accessor = [0, 0, 0, 0, 0, 0, 0];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 0 });
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame({ spatial: [accessor, [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] }, plan)).toThrow(/array|accessor/i);
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame({ spatial: [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] }, plan)).toThrow(/alpha/i);
  });

  it("bounds defined tangent BigInt numerators before parsing while preserving unavailable nulls", () => {
    const plan = tangentSpatialPlan(), maximum = "585225";
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame(tangentFrame(maximum, maximum), plan)).not.toThrow();
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame(tangentFrame(`-${maximum}`, maximum), plan)).not.toThrow();
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame(tangentFrame("585226", maximum), plan)).toThrow(/bounded BigInt numerator/i);
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame(tangentFrame(maximum, "585226"), plan)).toThrow(/bounded BigInt numerator/i);
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame(tangentFrame("9".repeat(7), maximum), plan)).toThrow(/bounded BigInt decimal length/i);
    expect(() => assertStrictSdrCandidateThreeSlot2dSpatialFrame(tangentFrame(null, null), plan)).not.toThrow();
  });

  it("zeroes a returned invalid reference mask before partial-plan failure", () => {
    const source = opaqueFrame();
    const route = f2aRoute();
    const expected = {
      m1Sha256: SHA("a"), sourcePlanSha256: SHA("b"), slot: "f2a" as const,
      routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint,
      sourceFrameSha256: sha256(source), sourceFrameByteLength: 3_686_400 as const,
      ditherMaskSha256: SHA("f"), domains: tangentDomains(),
    };
    expect(() => buildStrictSdrCandidateThreeSlot2dMeasurementPlan({ route, sourceRgba8: source, expected })).toThrow(/dither mask/i);
    expect(reference.mask).toBeDefined();
    expect(reference.mask!.every((value) => value === 0)).toBe(true);
    source.fill(0);
  });

  it("pins controls geometry, refuses alpha, and releases the disposed plan", () => {
    const route = controlsRoute();
    for (const [x, y] of [[64, 180], [464, 180], [864, 180]] as const) {
      const nonOpaque = opaqueFrame();
      nonOpaque[(y * 1_280 + x) * 4 + 3] = 0;
      expect(() => deriveStrictSdrCandidateThreeSlot2dMeasurementWitness({ slot: "f2b-screen-controls", route, sourceRgba8: nonOpaque })).toThrow(/non-opaque source/i);
      nonOpaque.fill(0);
    }
    const source = opaqueFrame();
    const witness = deriveStrictSdrCandidateThreeSlot2dMeasurementWitness({ slot: "f2b-screen-controls", route, sourceRgba8: source });
    expect(witness.domains.map((domain) => [domain.key, domain.directSampleCount, domain.tangentAnchorCount]))
      .toEqual([
        ["f2b-screen-controls.saturated", 123_904, null],
        ["f2b-screen-controls.partial-alpha", 123_904, null],
        ["f2b-screen-controls.zero-alpha", 123_904, null],
      ]);
    const plan = buildStrictSdrCandidateThreeSlot2dMeasurementPlan({
      route, sourceRgba8: source,
      expected: Object.freeze({ m1Sha256: SHA("c"), sourcePlanSha256: SHA("d"), ...witness }),
    });
    const decoded = Buffer.from(source), sample = (180 * 1_280 + 64) * 4;
    decoded[sample + 3] = 0;
    expect(() => measureStrictSdrCandidateThreeSlot2dMeasurement({ plan, sourceRgba8: source, decodedRgba8: decoded })).toThrow(/refuses non-opaque source or decoded alpha/i);
    decoded.fill(0);
    disposeStrictSdrCandidateThreeSlot2dMeasurementPlan(plan);
    expect(() => disposeStrictSdrCandidateThreeSlot2dMeasurementPlan(plan)).toThrow(/disposed|absent/i);
    expect(() => measureStrictSdrCandidateThreeSlot2dMeasurement({ plan, sourceRgba8: source, decodedRgba8: source })).toThrow(/expired|disposed/i);
    source.fill(0);
  });

  it("zeroes and releases the full retained tangent allocation", () => {
    const route = screenRoute(), source = opaqueFrame();
    const witness = deriveStrictSdrCandidateThreeSlot2dMeasurementWitness({ slot: "f2b-screen", route, sourceRgba8: source });
    const plan = buildStrictSdrCandidateThreeSlot2dMeasurementPlan({
      route, sourceRgba8: source,
      expected: Object.freeze({ m1Sha256: SHA("e"), sourcePlanSha256: SHA("f"), ...witness }),
    });
    let retained: Uint32Array | undefined;
    withStrictSdrCandidateThreeSlot2dMeasurementPairs(plan, 0, (pairs) => { retained = pairs; });
    expect(retained).toBeDefined();
    disposeStrictSdrCandidateThreeSlot2dMeasurementPlan(plan);
    expect(retained!.every((value) => value === 0)).toBe(true);
    expect(() => withStrictSdrCandidateThreeSlot2dMeasurementPairs(plan, 0, () => undefined)).toThrow(/expired|disposed/i);
    source.fill(0);
  });
});

function controlsSpatialPlan() {
  return assertStrictSdrCandidateThreeSlot2dSpatialPlan({
    schema: "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d@1",
    m1Sha256: SHA("a"), sourcePlanSha256: SHA("b"), ditherMaskSha256: null,
    domains: [
      directDomain("f2b-screen-controls.saturated"), directDomain("f2b-screen-controls.partial-alpha"), directDomain("f2b-screen-controls.zero-alpha"),
    ],
  });
}

function tangentSpatialPlan() {
  return assertStrictSdrCandidateThreeSlot2dSpatialPlan({
    schema: "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d@1", m1Sha256: SHA("a"), sourcePlanSha256: SHA("b"), ditherMaskSha256: SHA("c"),
    domains: ["f2a.linear.safe", "f2a.radial.inner", "f2a.radial.outer"].map((key) => ({ key, directSampleCount: 1, tangentAnchorCount: 1, omittedAnchorCount: 0, pairCount: 1, topologySha256: SHA("d"), sourceVarianceNumeratorDecimal: "1" })),
  });
}
function tangentFrame(covariance: string | null, decodedVariance: string | null) {
  const tuple = covariance === null ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "unavailable", null, null] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "defined", covariance, decodedVariance];
  return { spatial: [tuple, [...tuple], [...tuple]] };
}

function directDomain(key: "f2b-screen-controls.saturated" | "f2b-screen-controls.partial-alpha" | "f2b-screen-controls.zero-alpha") {
  return { key, directSampleCount: 1, tangentAnchorCount: null, omittedAnchorCount: null, pairCount: null, topologySha256: null, sourceVarianceNumeratorDecimal: null };
}

function tangentDomains() {
  return (["f2a.linear.safe", "f2a.radial.inner", "f2a.radial.outer"] as const).map((key) => ({
    key, directSampleCount: 1, tangentAnchorCount: 1, omittedAnchorCount: 0, pairCount: 1,
    topologySha256: SHA("e"), sourceVarianceNumeratorDecimal: "0",
  }));
}

function opaqueFrame(): Buffer {
  const source = Buffer.alloc(3_686_400);
  for (let offset = 3; offset < source.byteLength; offset += 4) source[offset] = 255;
  return source;
}

function f2aRoute() {
  return route("f2a", "#02040a", [
    gradient("linear_black_white", 64, 64, 544, 592, 1, undefined, { type: "linear", angleDeg: 90 }, ["#000000", "#ffffff"]),
    gradient("radial_three_stop", 672, 64, 544, 592, 1, undefined, { type: "radial", centerX: .5, centerY: .5 }, ["#101820", "#00ff40", "#ffffff"]),
  ]);
}

function controlsRoute() {
  return route("f2b-screen-controls", "#000000", [
    fill("saturated_base", 64, 180, 352, 352, 1, undefined, "#101820"), fill("saturated_red_screen", 64, 180, 352, 352, .4, "screen", "#ff0040"), fill("saturated_blue_screen", 64, 180, 352, 352, .45, "screen", "#0066ff"),
    fill("partial_base", 464, 180, 352, 352, 1, undefined, "#0c1420"), fill("partial_normal", 464, 180, 352, 352, .18, undefined, "#204080"), fill("partial_screen", 464, 180, 352, 352, .31, "screen", "#ff5020"),
    fill("zero_alpha_base", 864, 180, 352, 352, 1, undefined, "#305070"), fill("zero_alpha_screen", 864, 180, 352, 352, 0, "screen", "#ff0080"),
  ]);
}

function screenRoute() {
  return route("f2b-screen", "#02040a", [
    fill("stage", 80, 80, 1120, 560, 1, undefined, "#101820"), fill("cyan_base", 160, 156, 420, 408, .7, undefined, "#0066cc"),
    fill("warm_screen", 360, 236, 420, 248, .48, "screen", "#ff6040"), gradient("normal_gradient", 700, 156, 420, 408, 1, undefined, { type: "linear", angleDeg: 90 }, ["#081020", "#2050a0"]),
    gradient("screen_gradient", 760, 216, 280, 288, .52, "screen", { type: "radial", centerX: .5, centerY: .5 }, ["#ff8040", "#200810"]),
  ]);
}

function route(slot: "f2a" | "f2b-screen" | "f2b-screen-controls", background: string, rects: unknown[]): LinearSrgbSdrFinalRoute {
  return {
    schema: "shellx-motion/linear-srgb-sdr-final-route@1",
    admission: { target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264", working: "premultiplied-linear-srgb-rgba16float", frameBoundary: "straight-srgb-rgba8", composition: slot === "f2a" ? "normal-source-over-document-order" : "normal-and-screen-document-order" },
    canvas: { width: 1280, height: 720, fps: 30, durationMs: 2_000, background: { hex: background } },
    rects, fingerprint: SHA(slot === "f2a" ? "1" : slot === "f2b-screen" ? "2" : "3"), documentFingerprint: SHA(slot === "f2a" ? "4" : slot === "f2b-screen" ? "5" : "6"),
  } as unknown as LinearSrgbSdrFinalRoute;
}

function fill(id: string, x: number, y: number, width: number, height: number, opacity: number, blendMode: "screen" | undefined, hex: string) {
  return { id, x, y, width, height, opacity, blendMode, fill: { hex } };
}

function gradient(id: string, x: number, y: number, width: number, height: number, opacity: number, blendMode: "screen" | undefined, field: { type: "linear"; angleDeg: number } | { type: "radial"; centerX: number; centerY: number }, colors: string[]) {
  return { id, x, y, width, height, opacity, blendMode, gradient: { ...field, stops: colors.map((hex, index) => ({ offset: index / (colors.length - 1), color: { hex } })) } };
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
