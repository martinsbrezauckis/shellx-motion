import { describe, expect, it } from "vitest";
import {
  MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INPUT_BYTES,
  MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA,
  evaluateMotionShapeGeometryKeyframes
} from "./motion-shape-geometry-keyframes";
import { MOTION_SHAPE_GEOMETRY_SCHEMA } from "./motion-shape-geometry";

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };

function geometry(kind: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind, viewBox: VIEW_BOX, ...fields };
}

function keyframe(atUs: number, value: Record<string, unknown>, easing?: unknown): Record<string, unknown> {
  return { atUs, geometry: value, ...(easing === undefined ? {} : { easing }) };
}

function request(keyframes: unknown[], atUs = 0): Record<string, unknown> {
  return { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, atUs, keyframes };
}

function evaluated(value: unknown) {
  const result = evaluateMotionShapeGeometryKeyframes(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.evaluation;
}

describe("fixed-topology shape geometry keyframes", () => {
  it("uses exact microsecond easing, preserves ordered source snapshots, and leaves source data unchanged", () => {
    const start = geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    const end = geometry("line", { points: [{ x: 0, y: 20 }, { x: 100, y: 40 }] });
    const source = request([keyframe(0, start, "ease-in"), keyframe(1_000_000, end)], 500_000);
    const before = structuredClone(source);
    const first = evaluated(source), second = evaluated(structuredClone(source));
    expect(first.geometry).toMatchObject({ kind: "line", points: [{ x: 0, y: 5 }, { x: 100, y: 10 }] });
    expect(first.budget).toMatchObject({ keyframeCount: 2, interpolationScalars: 4 });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.geometryFingerprint).toBe(second.geometryFingerprint);
    expect(first.sourceSequenceSha256).toBe(second.sourceSequenceSha256);
    expect(Object.isFrozen(first.geometry)).toBe(true);
    expect(source).toEqual(before);
  });

  it("binds the authored sequence and easing even when two samples coincide", () => {
    const start = geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    const end = geometry("line", { points: [{ x: 0, y: 20 }, { x: 100, y: 20 }] });
    const eased = evaluated(request([keyframe(0, start, "ease-in"), keyframe(1_000_000, end)], 0));
    const linear = evaluated(request([keyframe(0, start, "linear"), keyframe(1_000_000, end)], 0));
    expect(eased.geometry).toEqual(linear.geometry);
    expect(eased.sourceSequenceSha256).not.toBe(linear.sourceSequenceSha256);
    expect(eased.fingerprint).not.toBe(linear.fingerprint);
  });

  it("honors canonical hold easing and exact-keyframe selection", () => {
    const start = geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    const end = geometry("line", { points: [{ x: 0, y: 40 }, { x: 100, y: 40 }] });
    expect(evaluated(request([keyframe(0, start, "hold"), keyframe(100, end)], 50)).geometry).toMatchObject({ points: [{ y: 0 }, { y: 0 }] });
    expect(evaluated(request([keyframe(0, start, "hold"), keyframe(100, end)], 100)).geometry).toMatchObject({ points: [{ y: 40 }, { y: 40 }] });
  });

  it("interpolates point order and every arc or sector control field positionally", () => {
    const polygon = evaluated(request([
      keyframe(0, geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] })),
      keyframe(100, geometry("polygon", { points: [{ x: 0, y: 10 }, { x: 90, y: 0 }, { x: 10, y: 90 }] }))
    ], 50));
    expect(polygon.geometry).toMatchObject({ kind: "polygon", points: [{ x: 0, y: 5 }, { x: 95, y: 0 }, { x: 5, y: 95 }] });
    const arc = evaluated(request([
      keyframe(0, geometry("arc", { center: { x: 50, y: 50 }, radius: 20, startAngleDeg: 0, sweepAngleDeg: 90 })),
      keyframe(100, geometry("arc", { center: { x: 60, y: 50 }, radius: 30, startAngleDeg: 20, sweepAngleDeg: 180 }))
    ], 50));
    expect(arc.geometry).toMatchObject({ kind: "arc", center: { x: 55, y: 50 }, radius: 25, startAngleDeg: 10, sweepAngleDeg: 135 });
    const sector = evaluated(request([
      keyframe(0, geometry("sector", { center: { x: 50, y: 50 }, radius: 20, innerRadius: 5, startAngleDeg: 0, sweepAngleDeg: 90 })),
      keyframe(100, geometry("sector", { center: { x: 50, y: 50 }, radius: 30, innerRadius: 10, startAngleDeg: 20, sweepAngleDeg: 180 }))
    ], 50));
    expect(sector.geometry).toMatchObject({ kind: "sector", radius: 25, innerRadius: 7.5, startAngleDeg: 10, sweepAngleDeg: 135 });
  });

  it.each([
    ["line", geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] })],
    ["polyline", geometry("polyline", { points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }] })],
    ["polygon", geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] })],
    ["arc", geometry("arc", { center: { x: 50, y: 50 }, radius: 25, startAngleDeg: 0, sweepAngleDeg: 90 })],
    ["sector", geometry("sector", { center: { x: 50, y: 50 }, radius: 25, innerRadius: 10, startAngleDeg: 0, sweepAngleDeg: 90 })],
    ["path", geometry("path", { data: "M 0 0 L 100 0 L 0 100 Z" })]
  ])("admits bounded fixed topology %s snapshots", (kind, value) => {
    expect(evaluated(request([keyframe(0, value), keyframe(100, structuredClone(value))], 50)).geometry.kind).toBe(kind);
  });

  it("interpolates matching parsed path topology without a second contour implementation", () => {
    const start = geometry("path", { data: "M 0 0 L 10 0 L 0 10 Z" });
    const end = geometry("path", { data: "M 0 0 L 20 0 L 0 20 Z" });
    const result = evaluated(request([keyframe(0, start), keyframe(100, end)], 50));
    expect(result.geometry).toEqual({ schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox: VIEW_BOX, data: "M 0 0 L 15 0 L 0 15 Z" });
    expect(result.budget.interpolationScalars).toBe(6);
  });

  it.each([
    [request([
      keyframe(0, geometry("polyline", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })),
      keyframe(100, geometry("polyline", { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] }))
    ]), "fixed point count"],
    [request([
      keyframe(0, geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })),
      keyframe(100, geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] }))
    ]), "fixed geometry kind"],
    [request([
      keyframe(0, geometry("sector", { center: { x: 50, y: 50 }, radius: 25, startAngleDeg: 0, sweepAngleDeg: 90 })),
      keyframe(100, geometry("sector", { center: { x: 50, y: 50 }, radius: 25, innerRadius: 5, startAngleDeg: 0, sweepAngleDeg: 90 }))
    ]), "innerRadius presence"],
    [request([
      keyframe(0, geometry("path", { data: "M 0 0 L 10 0 L 0 10 Z" })),
      keyframe(100, geometry("path", { data: "M 0 0 H 10 L 0 10 Z" }))
    ]), "identical parsed command"],
    [request([
      keyframe(0, geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })),
      keyframe(100, { ...geometry("line", { points: [{ x: 0, y: 0 }, { x: 90, y: 0 }] }), viewBox: { ...VIEW_BOX, width: 90 } })
    ]), "identical viewBox"]
  ])("refuses topology changes before evaluation", (value, message) => {
    expect(evaluateMotionShapeGeometryKeyframes(value)).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("refuses a degenerate evaluated contour rather than approximating through it", () => {
    const start = geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] });
    const end = geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 }] });
    expect(evaluateMotionShapeGeometryKeyframes(request([keyframe(0, start), keyframe(100, end)], 50))).toEqual({ ok: false, message: expect.stringContaining("adjacent duplicate") });
  });

  it.each([
    [request([keyframe(0, { ...geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }), surprise: true })]), "unknown field 'surprise'"],
    [request([keyframe(0, geometry("line", { points: [{ x: 0, y: 0, extra: 1 }, { x: 100, y: 0 }] }))]), "unknown field 'extra'"],
    [request([keyframe(0, geometry("line", { points: [{ x: Number.NaN, y: 0 }, { x: 100, y: 0 }] }))]), "must be a finite number"],
    [request([keyframe(0, geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }), "not-a-real-easing")]), "unsupported easing"],
    [request([keyframe(0, geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }), { type: "spring", stiffness: 170, damping: 26, surprise: true })]), "unknown field 'surprise'"],
    [request([keyframe(100, geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })), keyframe(0, geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }))]), "strictly ascending unique atUs"]
  ])("fails closed on hostile snapshot input %#", (value, message) => {
    expect(evaluateMotionShapeGeometryKeyframes(value)).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("bounds snapshot count and canonical input bytes before evaluating a segment", () => {
    const line = geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    expect(evaluateMotionShapeGeometryKeyframes(request(Array.from({ length: 33 }, (_, index) => keyframe(index, line))))).toEqual({ ok: false, message: expect.stringContaining("32-item payload") });
    const paddedData = "M 0 0 L 100 0 L 0 100 Z".padEnd(16 * 1024, " ");
    const unresolved = { ...geometry("path", { data: paddedData }), viewBox: { ...VIEW_BOX, width: 0 } };
    const oversized = request(Array.from({ length: 5 }, (_, index) => keyframe(index, unresolved)));
    const result = evaluateMotionShapeGeometryKeyframes(oversized);
    expect(result).toEqual({ ok: false, message: expect.stringContaining(`${MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INPUT_BYTES}-byte`) });
  });

  it("caps points and path bytes before any semantic resolver reads their nested payload", () => {
    let pointReads = 0;
    const points = Array.from({ length: 129 }, () => ({ x: 0, y: 0 }));
    Object.defineProperty(points, "0", { configurable: true, enumerable: true, get: () => { pointReads += 1; return { x: 0, y: 0 }; } });
    expect(evaluateMotionShapeGeometryKeyframes(request([keyframe(0, geometry("polygon", { points }))]))).toEqual({ ok: false, message: expect.stringContaining("128-item payload") });
    expect(pointReads).toBe(0);
    let viewBoxReads = 0;
    const unvisitedViewBox: Record<string, unknown> = { y: 0, width: 100, height: 100 };
    Object.defineProperty(unvisitedViewBox, "x", { configurable: true, enumerable: true, get: () => { viewBoxReads += 1; return 0; } });
    const oversizedPath = { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox: unvisitedViewBox, data: "M 0 0 L 100 0 L 0 100 Z".padEnd(16 * 1024 + 1, " ") };
    expect(evaluateMotionShapeGeometryKeyframes(request([keyframe(0, oversizedPath)]))).toEqual({ ok: false, message: expect.stringContaining("payload limit") });
    expect(viewBoxReads).toBe(0);
  });

  it("rejects accessors and sparse keyframe collections without reading or changing input", () => {
    let getterReads = 0;
    const guarded = keyframe(0, geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }));
    Object.defineProperty(guarded, "geometry", { configurable: true, enumerable: true, get: () => { getterReads += 1; return {}; } });
    expect(evaluateMotionShapeGeometryKeyframes(request([guarded]))).toEqual({ ok: false, message: expect.stringContaining("enumerable data field") });
    expect(getterReads).toBe(0);
    const sparse = new Array(2);
    const source = request(sparse);
    const before = structuredClone(source);
    expect(evaluateMotionShapeGeometryKeyframes(source)).toEqual({ ok: false, message: expect.stringContaining("dense data array") });
    expect(source).toEqual(before);
  });
});
