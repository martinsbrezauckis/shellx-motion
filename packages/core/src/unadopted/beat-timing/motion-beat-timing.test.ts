import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { MAX_MOTION_BEAT_TIMING_TIME_US, MOTION_BEAT_TIMING_SCHEMA, evaluateMotionBeatTiming } from "./motion-beat-timing";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: MOTION_BEAT_TIMING_SCHEMA,
    atTick: 0,
    ticksPerBeat: 4,
    tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 500_000, denominator: 1 } }],
    ...overrides
  };
}

function evaluated(value: unknown) {
  const result = evaluateMotionBeatTiming(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.evaluation;
}

describe("bounded beat timing evaluator", () => {
  it("maps exact integer beat ticks and step tempo changes to safe microseconds", () => {
    expect(evaluated(request({ atTick: 6 })).atUs).toBe(750_000);
    expect(evaluated(request({ atTick: 6, tempoSegments: [
      { startTick: 0, microsecondsPerBeat: { numerator: 500_000, denominator: 1 } },
      { startTick: 4, microsecondsPerBeat: { numerator: 1_000_000, denominator: 1 } }
    ] }))).toMatchObject({ atUs: 1_000_000, budget: { appliedSegmentCount: 2 } });
  });

  it("sums reduced rational segments before one final ties-to-even round", () => {
    const oneSegment = evaluated(request({ atTick: 2, ticksPerBeat: 2, tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 1 } }] }));
    const split = evaluated(request({ atTick: 2, ticksPerBeat: 2, tempoSegments: [
      { startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 1 } },
      { startTick: 1, microsecondsPerBeat: { numerator: 1, denominator: 1 } }
    ] }));
    expect(oneSegment.atUs).toBe(1);
    expect(split.atUs).toBe(1);
    expect(split.sourceSha256).not.toBe(oneSegment.sourceSha256);
    expect(split.fingerprint).not.toBe(oneSegment.fingerprint);
    expect(evaluated(request({ atTick: 1, ticksPerBeat: 1, tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 3, denominator: 2 } }] })).atUs).toBe(2);
    expect(evaluated(request({ atTick: 1, ticksPerBeat: 2, tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 1 } }] })).atUs).toBe(0);
  });

  it("has canonical immutable source and evaluation identity without source mutation", () => {
    const source = request({ atTick: 5 });
    const reordered = {
      tempoSegments: [{ microsecondsPerBeat: { denominator: 1, numerator: 500_000 }, startTick: 0 }],
      ticksPerBeat: 4, atTick: 5, schema: MOTION_BEAT_TIMING_SCHEMA
    };
    const before = structuredClone(source);
    const first = evaluated(source), second = evaluated(reordered);
    expect(first.fingerprint).toBe(second.fingerprint);
    const later = evaluated(request({ atTick: 6 }));
    expect(later.sourceSha256).toBe(first.sourceSha256);
    expect(later.fingerprint).not.toBe(first.fingerprint);
    expect(source).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.budget)).toBe(true);
    expect(Object.isFrozen(first.budget.limits)).toBe(true);
    const refused = request({ atTick: 1.5 });
    const refusedBefore = structuredClone(refused);
    expect(evaluateMotionBeatTiming(refused)).toEqual({ ok: false, message: expect.stringContaining("safe integer") });
    expect(refused).toEqual(refusedBefore);
  });

  it.each([
    [request({ unexpected: true }), "unknown field 'unexpected'"],
    [request({ tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 1, extension: true } }] }), "unknown field 'extension'"],
    [request({ tempoSegments: [{ startTick: 1, microsecondsPerBeat: { numerator: 1, denominator: 1 } }] }), "start at tick 0"],
    [request({ tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 1 } }, { startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 1 } }] }), "strictly ascending"],
    [request({ tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 0 } }] }), "safe integer"],
    [request({ tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: Number.NaN, denominator: 1 } }] }), "safe integer"],
    [request({ timeSignature: { numerator: 4, denominator: 4 } }), "unknown field 'timeSignature'"],
    [request({ tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 1, denominator: 2 } }] }), "resolve within"],
    [request({ atTick: 1_000_000_000, ticksPerBeat: 1, tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 60_000_000, denominator: 1 } }] }), "output limit"]
  ])("refuses unknown, unsupported, invalid, and over-limit input %#", (value, message) => {
    expect(evaluateMotionBeatTiming(value)).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("never reads caller getters and safely snapshots accepted and refused proxy data", () => {
    const acceptedSource = request({ atTick: 4 }), acceptedBytes = canonicalJson(acceptedSource), acceptedKeys = Reflect.ownKeys(acceptedSource);
    let gets = 0;
    const accepted = new Proxy(acceptedSource, { get(target, key, receiver) { gets += 1; target.unexpected = true; return Reflect.get(target, key, receiver); } });
    expect(evaluated(accepted).atUs).toBe(500_000);
    expect(gets).toBe(0);
    expect(canonicalJson(acceptedSource)).toBe(acceptedBytes);
    expect(Reflect.ownKeys(acceptedSource)).toEqual(acceptedKeys);

    const refusedSource = request({ atTick: 1.5 }), refusedBytes = canonicalJson(refusedSource), refusedKeys = Reflect.ownKeys(refusedSource);
    const refused = new Proxy(refusedSource, { get(target, key, receiver) { gets += 1; target.changed = true; return Reflect.get(target, key, receiver); } });
    expect(evaluateMotionBeatTiming(refused)).toEqual({ ok: false, message: expect.stringContaining("safe integer") });
    expect(gets).toBe(0);
    expect(canonicalJson(refusedSource)).toBe(refusedBytes);
    expect(Reflect.ownKeys(refusedSource)).toEqual(refusedKeys);
  });

  it("fails closed for getters, sparse/cyclic data, reflection traps, and unbounded keys", () => {
    let reads = 0;
    const getter = request();
    Object.defineProperty(getter, "atTick", { configurable: true, enumerable: true, get: () => { reads += 1; return 0; } });
    expect(evaluateMotionBeatTiming(getter)).toEqual({ ok: false, message: expect.stringContaining("enumerable data field") });
    expect(reads).toBe(0);
    const sparse = request({ tempoSegments: new Array(1) });
    expect(evaluateMotionBeatTiming(sparse)).toEqual({ ok: false, message: expect.stringContaining("dense") });
    const cyclic = request();
    cyclic.tempoSegments = [cyclic];
    expect(evaluateMotionBeatTiming(cyclic)).toEqual({ ok: false, message: expect.stringContaining("cycles") });
    const throwingOwnKeys = new Proxy(request(), { ownKeys: () => { throw new Error("no keys"); } });
    const throwingDescriptor = new Proxy(request(), { getOwnPropertyDescriptor: () => { throw new Error("no descriptor"); } });
    const throwingPrototype = new Proxy(request(), { getPrototypeOf: () => { throw new Error("no prototype"); } });
    for (const source of [throwingOwnKeys, throwingDescriptor, throwingPrototype]) expect(evaluateMotionBeatTiming(source)).toEqual({ ok: false, message: expect.stringContaining("reflection failed") });
    let descriptorCalls = 0;
    const oversized = new Proxy({}, { ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `k${index}`), getOwnPropertyDescriptor: () => { descriptorCalls += 1; return { configurable: true, enumerable: true, value: 0 }; } });
    expect(evaluateMotionBeatTiming(oversized)).toEqual({ ok: false, message: expect.stringContaining("8-field record limit") });
    expect(descriptorCalls).toBe(0);
  });

  it("keeps the output bound explicit", () => {
    expect(MAX_MOTION_BEAT_TIMING_TIME_US).toBe(1_000_000_000_000);
  });
});
