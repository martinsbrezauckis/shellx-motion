import { describe, expect, it } from "vitest";
import {
  MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS,
  MOTION_TRANSFORM_BEHAVIOR_SCHEMA,
  evaluateMotionTransformBehavior
} from "./motion-transform-behavior";
import { canonicalJson } from "./canonical-json";
import {
  MOTION_BEHAVIOR_MAX_GRAVITY,
  MOTION_BEHAVIOR_MAX_RESTITUTION,
  MOTION_BEHAVIOR_MAX_VELOCITY,
  MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY,
} from "./motion-behavior-types";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: MOTION_TRANSFORM_BEHAVIOR_SCHEMA,
    atUs: 0,
    startUs: 0,
    durationUs: 1_000_000,
    base: { x: 10, y: 20 },
    motion: { kind: "gravity", velocityX: 10, velocityY: 5, gravityY: 20 },
    ...overrides
  };
}

function squashRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { motion: _motion, ...result } = request(overrides);
  return result;
}

function evaluated(value: unknown) {
  const result = evaluateMotionTransformBehavior(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.evaluation;
}

describe("bounded transform behavior evaluator", () => {
  it("uses exact microseconds, y-down gravity, and documented transform defaults", () => {
    const start = evaluated(request());
    const end = evaluated(request({ atUs: 1_000_000 }));
    expect(start).toMatchObject({ localUs: 0, transform: { x: 10, y: 20, rotation: 0, scale: 1 } });
    expect(end.transform).toEqual({ x: 20, y: 35, rotation: 0, scale: 1 });
  });

  it("admits the shared transform extrema and retains the six-decimal bounce-gravity floor", () => {
    expect(evaluateMotionTransformBehavior(request({
      motion: { kind: "gravity", velocityX: MOTION_BEHAVIOR_MAX_VELOCITY, velocityY: -MOTION_BEHAVIOR_MAX_VELOCITY, gravityY: MOTION_BEHAVIOR_MAX_GRAVITY },
    }))).toMatchObject({ ok: true });
    expect(evaluateMotionTransformBehavior(request({
      motion: { kind: "bounce", floorY: 20, velocityY: -1, gravityY: MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY, restitution: MOTION_BEHAVIOR_MAX_RESTITUTION },
    }))).toMatchObject({ ok: true });
    expect(evaluateMotionTransformBehavior(request({
      motion: { kind: "bounce", floorY: 20, velocityY: 0, gravityY: MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY / 10, restitution: 0 },
    }))).toEqual({ ok: false, message: expect.stringContaining("bounce.gravityY") });
  });

  it("uses a fixed full-duration bounce admission cap and lets zero restitution settle naturally", () => {
    const settling = request({
      atUs: 2_000_000,
      durationUs: 2_000_000,
      base: { x: 0, y: 0 },
      motion: { kind: "bounce", floorY: 10, velocityY: 0, gravityY: 20, restitution: 0 }
    });
    expect(evaluated(settling)).toMatchObject({ transform: { x: 0, y: 10 }, budget: { impactCount: 1, sampledImpactCount: 1 } });
    const overCap = request({
      atUs: 0,
      durationUs: 18_000_000,
      base: { x: 0, y: 0 },
      motion: { kind: "bounce", floorY: 0, velocityY: -10, gravityY: 10, restitution: 1 }
    });
    expect(evaluateMotionTransformBehavior(overCap)).toEqual({ ok: false, message: expect.stringContaining(`more than ${MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS} impacts`) });
    expect(evaluated({ ...overCap, durationUs: 16_000_000 }).budget.impactCount).toBe(MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS);
  });

  it("defines floorY on the pre-squash bounce origin, then preserves composed vertical-squash centre/area", () => {
    const result = evaluated(request({
      atUs: 1_000_000,
      durationUs: 2_000_000,
      base: { x: 0, y: 0, width: 10, height: 10 },
      motion: { kind: "bounce", floorY: 10, velocityY: 0, gravityY: 20, restitution: 0 },
      squash: { kind: "squash", axis: "vertical", amount: 0.5 }
    }));
    expect(result.transform).toEqual({ x: -2.5, y: 11.666667, rotation: 0, scale: 1, width: 15, height: 6.666667 });
    expect(result.transform.y + result.transform.height! / 2).toBeCloseTo(15, 5);
  });

  it("emits a center-preserving, area-preserving squash intent away from a bounce floor", () => {
    const result = evaluated(squashRequest({
      atUs: 500_000,
      base: { x: 0, y: 0, width: 100, height: 100 },
      squash: { kind: "squash", axis: "vertical", amount: 0.5 }
    }));
    expect(result.transform).toEqual({ x: -25, y: 16.666667, rotation: 0, scale: 1, width: 150, height: 66.666667 });
    expect(result.transform.x + result.transform.width! / 2).toBeCloseTo(50, 6);
    expect(result.transform.y + result.transform.height! / 2).toBeCloseTo(50, 6);
  });

  it("binds the full authored source interval/config and immutable budget even when a sample coincides", () => {
    const first = evaluated(request({ atUs: 0 }));
    const second = evaluated(request({ atUs: 0, motion: { kind: "gravity", velocityX: 40, velocityY: 0, gravityY: 0 } }));
    expect(first.transform).toEqual(second.transform);
    expect(first.sourceSha256).not.toBe(second.sourceSha256);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.transform)).toBe(true);
    expect(Object.isFrozen(first.budget)).toBe(true);
    expect(Object.isFrozen(first.budget.limits)).toBe(true);
  });

  it("has order-independent canonical identity and never mutates accepted or refused source", () => {
    const source = request({ atUs: 500_000 });
    const reordered = {
      base: { y: 20, x: 10 }, durationUs: 1_000_000, motion: { gravityY: 20, kind: "gravity", velocityY: 5, velocityX: 10 },
      startUs: 0, schema: MOTION_TRANSFORM_BEHAVIOR_SCHEMA, atUs: 500_000
    };
    const before = structuredClone(source);
    expect(evaluated(source).fingerprint).toBe(evaluated(reordered).fingerprint);
    expect(source).toEqual(before);
    const refused = request({ motion: { kind: "gravity", velocityX: 0, velocityY: 0, gravityY: 0 } });
    const refusedBefore = structuredClone(refused);
    expect(evaluateMotionTransformBehavior(refused)).toEqual({ ok: false, message: expect.stringContaining("must change") });
    expect(refused).toEqual(refusedBefore);
  });

  it.each([
    [request({ unexpected: true }), "unknown field 'unexpected'"],
    [request({ base: { x: 0, y: 0, surprise: true } }), "unknown field 'surprise'"],
    [request({ atUs: 0.5 }), "safe integer microsecond"],
    [request({ base: { x: Number.NaN, y: 0 } }), "finite number"],
    [request({ motion: { kind: "bounce", floorY: 0, velocityY: 2, gravityY: 10, restitution: 0.5 }, base: { x: 0, y: 0 } }), "requires upward velocity"],
    [request({ motion: { kind: "squash", axis: "vertical", amount: 0.2 } }), "kind must be gravity or bounce"],
    [squashRequest({ squash: { kind: "squash", axis: "vertical", amount: 0.2 } }), "requires base.width and base.height"]
  ])("refuses unsupported, degenerate, and out-of-range input %#", (value, message) => {
    expect(evaluateMotionTransformBehavior(value)).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("descriptor-clones accepted/refused proxies without ever invoking a mutating get trap", () => {
    const acceptedSource = request({ atUs: 500_000 });
    const acceptedBytes = canonicalJson(acceptedSource), acceptedKeys = Reflect.ownKeys(acceptedSource);
    let acceptedGets = 0;
    const accepted = new Proxy(acceptedSource, { get(target, key, receiver) { acceptedGets += 1; target.unexpected = true; return Reflect.get(target, key, receiver); } });
    expect(evaluated(accepted).transform).toEqual({ x: 15, y: 25, rotation: 0, scale: 1 });
    expect(acceptedGets).toBe(0);
    expect(canonicalJson(acceptedSource)).toBe(acceptedBytes);
    expect(Reflect.ownKeys(acceptedSource)).toEqual(acceptedKeys);

    const nestedSource = request();
    const baseTarget = nestedSource.base as Record<string, unknown>;
    const baseBytes = canonicalJson(baseTarget);
    let nestedGets = 0;
    const nested = new Proxy(baseTarget, { get(target, key, receiver) { nestedGets += 1; target.x = 999; return Reflect.get(target, key, receiver); } });
    nestedSource.base = nested;
    expect(evaluated(nestedSource).transform).toEqual({ x: 10, y: 20, rotation: 0, scale: 1 });
    expect(nestedGets).toBe(0);
    expect(canonicalJson(baseTarget)).toBe(baseBytes);
    expect(nestedSource.base).toBe(nested);

    const refusedSource = request({ unexpected: true });
    const refusedBytes = canonicalJson(refusedSource), refusedKeys = Reflect.ownKeys(refusedSource);
    let refusedGets = 0;
    const refused = new Proxy(refusedSource, { get(target, key, receiver) { refusedGets += 1; target.changed = true; return Reflect.get(target, key, receiver); } });
    expect(evaluateMotionTransformBehavior(refused)).toEqual({ ok: false, message: expect.stringContaining("unknown field 'unexpected'") });
    expect(refusedGets).toBe(0);
    expect(canonicalJson(refusedSource)).toBe(refusedBytes);
    expect(Reflect.ownKeys(refusedSource)).toEqual(refusedKeys);
  });

  it("fails closed without reading getters or mutating accessor/sparse/cyclic hostile sources", () => {
    let reads = 0;
    const getter = request();
    const getterKeys = Reflect.ownKeys(getter);
    Object.defineProperty(getter, "base", { configurable: true, enumerable: true, get: () => { reads += 1; return { x: 0, y: 0 }; } });
    expect(evaluateMotionTransformBehavior(getter)).toEqual({ ok: false, message: expect.stringContaining("enumerable data field") });
    expect(reads).toBe(0);
    const sparse = new Array(1);
    const sparseSource = request({ motion: sparse });
    const sparseKeys = Reflect.ownKeys(sparseSource);
    expect(evaluateMotionTransformBehavior(sparseSource)).toEqual({ ok: false, message: expect.stringContaining("plain data objects") });
    expect(Reflect.ownKeys(sparseSource)).toEqual(sparseKeys);
    const cyclic = request();
    const cyclicKeys = Reflect.ownKeys(cyclic);
    cyclic.base = cyclic;
    expect(evaluateMotionTransformBehavior(cyclic)).toEqual({ ok: false, message: expect.stringContaining("cycles") });
    expect(Reflect.ownKeys(cyclic)).toEqual(cyclicKeys);
    expect(Reflect.ownKeys(getter)).toEqual(getterKeys);

    const nonEnumerable = request();
    Object.defineProperty(nonEnumerable, "hidden", { configurable: true, enumerable: false, value: 1 });
    const nonEnumerableKeys = Reflect.ownKeys(nonEnumerable);
    expect(evaluateMotionTransformBehavior(nonEnumerable)).toEqual({ ok: false, message: expect.stringContaining("enumerable data field") });
    expect(Reflect.ownKeys(nonEnumerable)).toEqual(nonEnumerableKeys);

    const symbolSource = request();
    const extension = Symbol("extension");
    Object.defineProperty(symbolSource, extension, { configurable: true, enumerable: true, value: 1 });
    const symbolKeys = Reflect.ownKeys(symbolSource);
    expect(evaluateMotionTransformBehavior(symbolSource)).toEqual({ ok: false, message: expect.stringContaining("symbol fields") });
    expect(Reflect.ownKeys(symbolSource)).toEqual(symbolKeys);
  });

  it("returns controlled refusal for throwing reflection proxies and bounds a 10,000-key proxy before descriptors", () => {
    const throwingOwnKeys = new Proxy(request(), { ownKeys: () => { throw new Error("no keys"); } });
    const throwingDescriptor = new Proxy(request(), { getOwnPropertyDescriptor: () => { throw new Error("no descriptor"); } });
    const throwingPrototype = new Proxy(request(), { getPrototypeOf: () => { throw new Error("no prototype"); } });
    for (const source of [throwingOwnKeys, throwingDescriptor, throwingPrototype]) {
      expect(evaluateMotionTransformBehavior(source)).toEqual({ ok: false, message: expect.stringContaining("data reflection failed") });
    }
    let descriptorCalls = 0;
    const oversized = new Proxy({}, {
      ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `k${index}`),
      getOwnPropertyDescriptor: () => { descriptorCalls += 1; return { configurable: true, enumerable: true, value: 0 }; }
    });
    expect(evaluateMotionTransformBehavior(oversized)).toEqual({ ok: false, message: expect.stringContaining("8-field record limit") });
    expect(descriptorCalls).toBe(0);
  });
});
