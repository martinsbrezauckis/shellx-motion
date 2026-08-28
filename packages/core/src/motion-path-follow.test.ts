import { describe, expect, it } from "vitest";
import { MAX_MOTION_PATH_FOLLOW_INPUT_BYTES, MOTION_PATH_FOLLOW_SCHEMA, evaluateMotionPathFollow } from "./motion-path-follow";
import { MOTION_SHAPE_GEOMETRY_SCHEMA } from "./motion-shape-geometry";

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };
const SQUARE = "M 0 0 L 100 0 L 100 100 L 0 100 Z";

function geometry(data = SQUARE): Record<string, unknown> {
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox: VIEW_BOX, data };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: MOTION_PATH_FOLLOW_SCHEMA, geometry: geometry(), atUs: 0, startUs: 0, durationUs: 400, ...overrides };
}

function evaluated(value: unknown) {
  const result = evaluateMotionPathFollow(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.evaluation;
}

describe("closed v1 path-follow evaluator", () => {
  it("uses exact local microseconds, constant distance, and y-down line orientation", () => {
    const start = evaluated(request({ orientToPath: true }));
    const corner = evaluated(request({ atUs: 100, orientToPath: true }));
    expect(start).toMatchObject({ localUs: 0, phaseUs: 0, transform: { x: 0, y: 0, rotation: 0 } });
    expect(corner.transform).toEqual({ x: 100, y: 0, rotation: 90 });
    const triangle = evaluated(request({ geometry: geometry("M 0 0 L 100 0 L 100 100 Z"), atUs: 200 }));
    expect(triangle.transform).toMatchObject({ x: 100, y: expect.closeTo(70.710678, 6) });
  });

  it("uses the settled flattened curve for orientation and does not expose rotation unless requested", () => {
    const curve = geometry("M 0 0 Q 0 100 100 100 L 100 0 Z");
    const oriented = evaluated(request({ geometry: curve, orientToPath: true }));
    expect(oriented.transform.rotation).toBeGreaterThan(80);
    expect(oriented.transform.rotation).toBeLessThan(100);
    expect(evaluated(request({ geometry: curve })).transform).not.toHaveProperty("rotation");
  });

  it("defines reverse and positive offset as wrapped closed-path phase policies", () => {
    const reverse = evaluated(request({ atUs: 100, direction: "reverse", orientToPath: true }));
    expect(reverse).toMatchObject({ phaseUs: 300, transform: { x: 0, y: 100, rotation: -90 } });
    const offset = evaluated(request({ offsetUs: 100, orientToPath: true }));
    expect(offset).toMatchObject({ phaseUs: 100, transform: { x: 100, y: 0, rotation: 90 } });
  });

  it("reuses canonical easing while retaining a closed wrapped phase", () => {
    const result = evaluated(request({ atUs: 200, easing: "ease-in" }));
    expect(result).toMatchObject({ localUs: 200, phaseUs: 100, transform: { x: 100, y: 0 } });
    expect(evaluated(request({ atUs: 400, easing: "ease-out" }))).toMatchObject({ phaseUs: 0, transform: { x: 0, y: 0 } });
  });

  it("is source-order independent, fingerprints the canonical intent, and never mutates input", () => {
    const source = request({ atUs: 123, easing: "ease-in-out", orientToPath: true });
    const reversed = {
      durationUs: 400, orientToPath: true, atUs: 123, geometry: structuredClone(source.geometry),
      schema: MOTION_PATH_FOLLOW_SCHEMA, startUs: 0, easing: "ease-in-out"
    };
    const before = structuredClone(source);
    const first = evaluated(source), second = evaluated(reversed);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.pathFingerprint).toBe(second.pathFingerprint);
    expect(first.sourceSha256).toBe(second.sourceSha256);
    expect(Object.isFrozen(first.transform)).toBe(true);
    expect(source).toEqual(before);
  });

  it("binds canonical follow policy into identity even when a sampled transform coincides", () => {
    const forward = evaluated(request({ direction: "forward" }));
    const reverse = evaluated(request({ direction: "reverse" }));
    expect(forward.transform).toEqual(reverse.transform);
    expect(forward.sourceSha256).not.toBe(reverse.sourceSha256);
    expect(forward.fingerprint).not.toBe(reverse.fingerprint);
  });

  it.each([
    [request({ unexpected: true }), "unknown field 'unexpected'"],
    [request({ geometry: { ...geometry(), kind: "polygon", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] } }), "unknown field 'points'"],
    [request({ geometry: geometry("M 0 0 L 0 0 L 0 100 Z") }), "zero-length"],
    [request({ easing: "not-a-real-easing" }), "unsupported easing"],
    [request({ atUs: 0.5 }), "safe integer microsecond"],
    [request({ offsetUs: 400 }), "less than durationUs"]
  ])("refuses unsupported topology, timing, and easing %#", (value, message) => {
    expect(evaluateMotionPathFollow(value)).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("fails closed on getters, sparse arrays, and cyclic extension data", () => {
    const getter = request();
    Object.defineProperty(getter, "atUs", { configurable: true, enumerable: true, get: () => 0 });
    expect(evaluateMotionPathFollow(getter)).toEqual({ ok: false, message: expect.stringContaining("enumerable data field") });
    expect(evaluateMotionPathFollow(request({ easing: new Array(2) }))).toEqual({ ok: false, message: expect.stringContaining("plain object") });
    const cyclic = request();
    cyclic.geometry = cyclic;
    expect(evaluateMotionPathFollow(cyclic)).toEqual({ ok: false, message: expect.stringContaining("unknown field") });
  });

  it("bounds the complete canonical input before path lowering work", () => {
    const paddedPath = "M 0 0 L 100 0 L 0 100 Z".padEnd(16 * 1024, " ");
    expect(evaluateMotionPathFollow(request({ geometry: geometry(paddedPath) }))).toEqual({ ok: false, message: expect.stringContaining(`${MAX_MOTION_PATH_FOLLOW_INPUT_BYTES}-byte`) });
  });
});
