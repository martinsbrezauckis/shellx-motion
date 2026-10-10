import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  assertStrictSdrCandidateThreeSlotM1aMeasurementExpectation,
  type StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair,
} from "./linear-srgb-sdr-final-three-slot-2d-measurement.js";
import { assertStrictSdrCandidateThreeSlotQ1StaticContinuityCapability } from "./linear-srgb-sdr-final-three-slot-observation-contract.js";

const SHA = (letter: string) => letter.repeat(64);

describe("three-slot M1a temporal binding adapter", () => {
  it("restores only the literal selected compact slot after binding the Core canonical hash", () => {
    const pair = bindingPair();
    const actual = assertStrictSdrCandidateThreeSlotM1aMeasurementExpectation(pair, "f2b-screen");

    expect(actual).toMatchObject({
      slot: "f2b-screen",
      sourceFrameByteLength: 3_686_400,
      ditherMaskSha256: null,
      domains: [
        { key: "f2b-screen.normal.unoccluded", tangentAnchorCount: 1, pairCount: 1 },
        { key: "f2b-screen.radial", tangentAnchorCount: 1, pairCount: 1 },
        { key: "f2b-screen.flat.overlap", tangentAnchorCount: null, pairCount: null },
      ],
    });
    expect(actual).not.toHaveProperty("q1StaticContinuity");
  });

  it("refuses a changed canonical binding hash and a malformed selected tangent tuple", () => {
    const pair = bindingPair();
    expect(() => assertStrictSdrCandidateThreeSlotM1aMeasurementExpectation({ ...pair, m1aSpatialMeasurementSha256: SHA("0") }, "f2a")).toThrow(/canonical hash/i);

    const binding = pair.m1aSpatialMeasurement as { slots: unknown[] };
    const slots = [...binding.slots];
    const f2a = [...(slots[0] as unknown[])];
    const domains = [...(f2a[4] as unknown[])];
    domains[0] = [1, 0, 0, SHA("e"), "0"];
    f2a[4] = domains;
    slots[0] = f2a;
    const malformed = { ...(binding as object), slots };
    expect(() => assertStrictSdrCandidateThreeSlotM1aMeasurementExpectation(pairFor(malformed), "f2a")).toThrow(/pair count is not a bounded safe integer/i);
  });

  it("admits only a frozen plain six-method Q1 capability map", () => {
    const member = () => undefined;
    const plain = Object.freeze({ buildPlan: member, measureFrame: member, disposePlan: member, assertFactoryPlan: member, assertFrame: member, assertTemporalRecord: member });
    expect(() => assertStrictSdrCandidateThreeSlotQ1StaticContinuityCapability(plain)).not.toThrow();
    expect(() => assertStrictSdrCandidateThreeSlotQ1StaticContinuityCapability(Object.freeze({ ...plain, extra: member }))).toThrow(/keys/i);
    const getter = { ...plain };
    Object.defineProperty(getter, "buildPlan", { enumerable: true, get: () => member });
    expect(() => assertStrictSdrCandidateThreeSlotQ1StaticContinuityCapability(Object.freeze(getter))).toThrow(/enumerable data/i);
  });
});

function bindingPair(version: "@2" | "@3" = "@2"): StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair {
  return pairFor({
    schema: version === "@2" ? "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d-binding@2" : "shellx-motion/strict-sdr-candidate-three-slot-m1a-2d-binding@3",
    m1Sha256: "6094a359867488d16e65b2fb7f5a3b1dca23dc9cee8a1326d2f4d905558eb571",
    capProofSha256: "5150a8a969644b58735ad77d20c182ad07981ffc131fe38952382b6fde1cfdef",
    sourceFilesManifestSha256: SHA("a"),
    fixtureInputsManifestSha256: SHA("b"),
    sourcePlanSha256: SHA("c"),
    slots: [
      [SHA("1"), SHA("2"), SHA("3"), SHA("4"), [[1, 0, 1, SHA("5"), "0"], [1, 0, 1, SHA("6"), "0"], [1, 0, 1, SHA("7"), "0"]]],
      [SHA("8"), SHA("9"), SHA("a"), [[1, 0, 1, SHA("b"), "0"], [1, 0, 1, SHA("c"), "0"], [1]]],
      [SHA("d"), SHA("e"), SHA("f"), [[1], [1], [1]]],
    ],
    ...(version === "@2" ? {} : { q1: [1, SHA("d")] }),
  });
}

function pairFor(m1aSpatialMeasurement: unknown): StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair {
  return Object.freeze({ m1aSpatialMeasurement, m1aSpatialMeasurementSha256: canonicalJsonSha256(m1aSpatialMeasurement) });
}
