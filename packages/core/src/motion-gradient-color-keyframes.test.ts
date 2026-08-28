import { describe, expect, it } from "vitest";
import {
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES,
  MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA,
  evaluateMotionGradientColorKeyframes,
} from "./motion-gradient-color-keyframes";
import { effectiveLayerAtMs } from "./timeline";
import type { MotionLayer } from "./types";

function gradient(keyframes: unknown[] = [snapshot(0, ["#ff0000", "#000000"]), snapshot(1_000, ["#0000ff", "#ffffff"], "ease-in")]): Record<string, unknown> {
  return {
    type: "linear",
    angle: 45,
    stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#000000" }],
    colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes },
  };
}

function snapshot(atUs: number, colors: string[], easing?: unknown): Record<string, unknown> {
  return { atUs, colors, ...(easing === undefined ? {} : { easing }) };
}

function request(value = gradient(), atUs = 500): Record<string, unknown> {
  return { gradient: value, atUs };
}

function evaluated(value: unknown) {
  const result = evaluateMotionGradientColorKeyframes(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.evaluation;
}

describe("fixed-topology gradient color keyframes", () => {
  it("samples complete color vectors at exact microseconds with canonical color and easing semantics", () => {
    const result = evaluated(request());
    expect(result).toMatchObject({
      schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA,
      atUs: 500,
      colors: ["#800080", "#808080"],
      budget: { snapshotCount: 2, stopCount: 2, interpolationWorkUnits: 4 },
    });
    expect(result.sourceSequenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.topologySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds full authored color snapshots and easing in source identity while fixed topology owns a separate hash", () => {
    const baseline = evaluated(request());
    const changedEasing = evaluated(request(gradient([
      snapshot(0, ["#ff0000", "#000000"]),
      snapshot(1_000, ["#0000ff", "#ffffff"], "ease-out"),
    ])));
    const changedOffset = evaluated(request({
      ...gradient(),
      stops: [{ offset: 0.1, color: "#ff0000" }, { offset: 1, color: "#000000" }],
    }));
    expect(changedEasing.sourceSequenceSha256).not.toBe(baseline.sourceSequenceSha256);
    expect(changedEasing.topologySha256).toBe(baseline.topologySha256);
    expect(changedOffset.sourceSequenceSha256).toBe(baseline.sourceSequenceSha256);
    expect(changedOffset.topologySha256).not.toBe(baseline.topologySha256);
  });

  it.each([
    [request({ ...gradient(), colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [snapshot(1, ["#000", "#fff"]), snapshot(0, ["#111", "#eee"])] } }), "strictly ascending unique atUs"],
    [request({ ...gradient(), colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [snapshot(0, ["#000"]) ] } }), "exactly 2 entries"],
    [request({ ...gradient(), colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [snapshot(0.5, ["#000", "#fff"]) ] } }), "safe integer"],
    [request({ ...gradient(), colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: Array.from({ length: 33 }, (_, index) => snapshot(index, ["#000", "#fff"])) } }), "32-item payload"],
    [request({ ...gradient(), colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [snapshot(0, ["x".repeat(MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES + 1), "#fff"]) ] } }), "at most"],
    [request({ ...gradient(), stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, unexpected: true } }), "unknown field 'unexpected'"],
    [request({ type: "radial", angle: 10, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [snapshot(0, ["#000", "#fff"]) ] } }), "unknown field 'angle'"],
  ])("refuses malformed or topology-changing data %#", (value, message) => {
    expect(evaluateMotionGradientColorKeyframes(value)).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("refuses accessors and oversized arrays before reading hostile nested values", () => {
    let colorReads = 0;
    const colors = ["#000", "#fff"];
    Object.defineProperty(colors, "0", { configurable: true, enumerable: true, get: () => { colorReads += 1; return "#000"; } });
    expect(evaluateMotionGradientColorKeyframes(request(gradient([snapshot(0, colors)])))).toEqual({ ok: false, message: expect.stringContaining("data value") });
    expect(colorReads).toBe(0);

    let snapshotReads = 0;
    const keyframes = Array.from({ length: 33 }, (_, index) => snapshot(index, ["#000", "#fff"]));
    Object.defineProperty(keyframes, "0", { configurable: true, enumerable: true, get: () => { snapshotReads += 1; return snapshot(0, ["#000", "#fff"]); } });
    expect(evaluateMotionGradientColorKeyframes(request(gradient(keyframes)))).toEqual({ ok: false, message: expect.stringContaining("32-item payload") });
    expect(snapshotReads).toBe(0);
  });

  it("applies stop and color caps before indexed Proxy descriptors, and never runs nested mutating getters", () => {
    let stopLengthReads = 0, stopElementReads = 0;
    const stops = new Proxy(new Array(100_000), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") stopLengthReads += 1; else stopElementReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(evaluateMotionGradientColorKeyframes(request({
      type: "linear", angle: 45, stops,
      colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [snapshot(0, ["#000", "#fff"])] },
    }))).toEqual({ ok: false, message: expect.stringContaining("16-item payload") });
    expect(stopLengthReads).toBeLessThanOrEqual(1);
    expect(stopElementReads).toBe(0);

    let colorLengthReads = 0, colorElementReads = 0;
    const colors = new Proxy(new Array(100_000), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "length") colorLengthReads += 1; else colorElementReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(evaluateMotionGradientColorKeyframes(request(gradient([snapshot(0, colors as unknown as string[])])))).toEqual({ ok: false, message: expect.stringContaining("16-item payload") });
    expect(colorLengthReads).toBeLessThanOrEqual(1);
    expect(colorElementReads).toBe(0);

    const source = request();
    const sourceGradient = source.gradient as Record<string, unknown>;
    const hostile = snapshot(0, ["#000", "#fff"]);
    let getterCalls = 0;
    Object.defineProperty(hostile, "colors", {
      configurable: true, enumerable: true,
      get: () => { getterCalls += 1; (sourceGradient.stops as Array<{ color: string }>)[0]!.color = "#ffffff"; return ["#000", "#fff"]; },
    });
    sourceGradient.colorKeyframes = { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: [hostile] };
    expect(evaluateMotionGradientColorKeyframes(source)).toEqual({ ok: false, message: expect.stringContaining("enumerable data field") });
    expect(getterCalls).toBe(0);
    expect((sourceGradient.stops as Array<{ color: string }>)[0]!.color).toBe("#ff0000");
  });

  it("returns controlled refusals for sparse, symbol, non-enumerable, and throwing-reflection data", () => {
    const sparse = new Array<string>(2); sparse[1] = "#fff";
    expect(evaluateMotionGradientColorKeyframes(request(gradient([snapshot(0, sparse)])))).toEqual({ ok: false, message: expect.stringContaining("dense data array") });

    const symbolicStops = [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }];
    Object.defineProperty(symbolicStops, Symbol("hidden"), { value: true, enumerable: true });
    expect(evaluateMotionGradientColorKeyframes(request({ ...gradient(), stops: symbolicStops }))).toEqual({ ok: false, message: expect.stringContaining("symbol keys") });

    const nonEnumerableColors = ["#000", "#fff"];
    Object.defineProperty(nonEnumerableColors, "0", { value: "#000", enumerable: false });
    expect(evaluateMotionGradientColorKeyframes(request(gradient([snapshot(0, nonEnumerableColors)])))).toEqual({ ok: false, message: expect.stringContaining("data value") });

    const reflectionTrap = new Proxy(gradient(), { getPrototypeOf: () => { throw new Error("untrusted trap"); } });
    expect(evaluateMotionGradientColorKeyframes(request(reflectionTrap))).toEqual({ ok: false, message: expect.stringContaining("cannot be reflected safely") });
  });

  it("is deterministic across equivalent own-key insertion order and leaves inputs unchanged", () => {
    const source = request();
    const reordered = {
      atUs: source.atUs,
      gradient: {
        colorKeyframes: structuredClone((source.gradient as Record<string, unknown>).colorKeyframes),
        stops: structuredClone((source.gradient as Record<string, unknown>).stops),
        angle: 45,
        type: "linear",
      },
    };
    const before = structuredClone(source);
    expect(evaluated(source).fingerprint).toBe(evaluated(reordered).fingerprint);
    expect(source).toEqual(before);
  });

  it("applies only evaluated stop colors to ordinary effective layers and refuses inexact microsecond playheads", () => {
    const layer: MotionLayer = {
      id: "field", type: "shape", shape: "rect", startMs: 0, durationMs: 2,
      gradient: gradient() as unknown as MotionLayer["gradient"],
    };
    const before = structuredClone(layer);
    const effective = effectiveLayerAtMs(layer, 0.5);
    expect(effective.gradient).toEqual({
      type: "linear", angle: 45,
      stops: [{ offset: 0, color: "#800080" }, { offset: 1, color: "#808080" }],
      colorKeyframes: before.gradient?.colorKeyframes,
    });
    expect(layer).toEqual(before);
    expect(() => effectiveLayerAtMs(layer, 0.0001)).toThrow("safe integer microsecond");
  });
});
