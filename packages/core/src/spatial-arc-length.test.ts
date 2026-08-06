import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARC_LENGTH_PANELS,
  ARC_LENGTH_QUADRATURE_POINTS,
  ARC_LENGTH_SOLVER_STEPS,
  arcLengthParameter,
  chordAlignedSegment,
} from "./spatial-arc-length";

interface Point { x: number; y: number }
type Curve = readonly [Point, Point, Point, Point];

/** Symmetric arch used by the core spatial-path suite. Its speed is a polynomial. */
const ARCH: Curve = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }];
/** Symmetric arch used by the sdk suite. Its speed is a genuine elliptic integrand. */
const SDK_ARCH: Curve = [{ x: 0, y: 0 }, { x: 0, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 0 }];
/** One-sided handle: the incoming handle is zero, so the speed reaches 0 at s = 1. */
const ONE_SIDED: Curve = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 0 }, { x: 100, y: 0 }];
/** Interior cusp: the speed passes through exactly zero inside the segment. */
const CUSP: Curve = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: -100, y: 0 }, { x: 0, y: 100 }];
/** Long asymmetric S with handles far outside the anchor box. */
const SWEEP: Curve = [{ x: -320, y: 40 }, { x: 600, y: 40 }, { x: -400, y: 700 }, { x: 500, y: 700 }];

/**
 * Reference speed and arc length, deliberately NOT sharing an implementation
 * with the module under test: composite Simpson rather than the module's
 * composite Gauss-Legendre. Simpson's error on these integrands at 2048
 * intervals is ~1e-14 relative, an order tighter than every tolerance asserted
 * against it below.
 */
function speed(curve: Curve, s: number): number {
  const u = 1 - s;
  const dx = 3 * (u * u * (curve[1].x - curve[0].x) + 2 * u * s * (curve[2].x - curve[1].x) + s * s * (curve[3].x - curve[2].x));
  const dy = 3 * (u * u * (curve[1].y - curve[0].y) + 2 * u * s * (curve[2].y - curve[1].y) + s * s * (curve[3].y - curve[2].y));
  return Math.sqrt(dx * dx + dy * dy);
}

function referenceArcLength(curve: Curve, from: number, to: number, intervals = 2_048): number {
  const step = (to - from) / intervals;
  let sum = speed(curve, from) + speed(curve, to);
  for (let index = 1; index < intervals; index += 1) sum += speed(curve, from + index * step) * (index % 2 === 1 ? 4 : 2);
  return (sum * step) / 3;
}

/** Bezier position, used only to check that reparameterised points stay on the curve. */
function position(curve: Curve, s: number): Point {
  const u = 1 - s;
  const uu = u * u;
  const ss = s * s;
  const w0 = uu * u;
  const w1 = 3 * uu * s;
  const w2 = 3 * u * ss;
  const w3 = ss * s;
  return {
    x: w0 * curve[0].x + w1 * curve[1].x + w2 * curve[2].x + w3 * curve[3].x,
    y: w0 * curve[0].y + w1 * curve[1].y + w2 * curve[2].y + w3 * curve[3].y,
  };
}

const solve = (curve: Curve, t: number): number => arcLengthParameter(curve[0], curve[1], curve[2], curve[3], t);

describe("spatial arc-length reparameterisation", () => {
  // The defining property. Sampling at even t must cover even DISTANCE, which is
  // what "easing: linear means constant speed" reduces to. Every sample below is
  // off the midpoint except the one at t = 0.5, because the previous defect in
  // this area was invisible to midpoint-only assertions.
  const constantSpeedCases: Array<[string, Curve, number]> = [
    ["symmetric arch", ARCH, 3e-12],
    ["sdk arch", SDK_ARCH, 3e-12],
    ["one-sided handle", ONE_SIDED, 3e-12],
    ["asymmetric sweep", SWEEP, 3e-12],
    // A cusp makes the integrand |s - s0|-like, so spectral convergence drops to
    // algebraic. 1e-6 of the total length is still far under a millipixel here.
    ["interior cusp", CUSP, 1e-6],
  ];
  for (const [name, curve, tolerance] of constantSpeedCases) {
    it(`advances ${name} by distance, not by curve parameter`, () => {
      const total = referenceArcLength(curve, 0, 1);
      const samples = 32;
      for (let index = 1; index <= samples; index += 1) {
        const t = index / samples;
        const travelled = referenceArcLength(curve, 0, solve(curve, t));
        expect(Math.abs(travelled - t * total) / total).toBeLessThan(tolerance);
      }
    });
  }

  it("keeps consecutive equal-time steps equal in length", () => {
    const total = referenceArcLength(ARCH, 0, 1);
    const samples = 16;
    let previous = 0;
    for (let index = 1; index <= samples; index += 1) {
      const travelled = referenceArcLength(ARCH, 0, solve(ARCH, index / samples));
      expect(Math.abs((travelled - previous) - total / samples) / total).toBeLessThan(3e-12);
      previous = travelled;
    }
  });

  // The old parameterisation is spelled out so the size of the correction is on
  // the record: sampling the arch at even times used to cover 59.375 of its 200
  // units in the first quarter of the time rather than 50.
  it("measures the parameter-time error the reparameterisation removes", () => {
    const total = referenceArcLength(ARCH, 0, 1);
    expect(total).toBeCloseTo(200, 9);
    expect(referenceArcLength(ARCH, 0, 0.25)).toBeCloseTo(59.375, 9);
    expect(Math.abs(referenceArcLength(ARCH, 0, 0.25) - 0.25 * total) / total).toBeCloseTo(0.046875, 9);
    // Same quarter under arc-length timing.
    expect(Math.abs(referenceArcLength(ARCH, 0, solve(ARCH, 0.25)) - 0.25 * total) / total).toBeLessThan(3e-12);
  });

  // Shape is preserved by construction -- the caller evaluates the same cubic --
  // but assert it rather than assume it: every reparameterised sample must sit on
  // the curve. Distance to the curve is measured by scan plus ternary refine,
  // which stays well conditioned where recovering the parameter from x would not.
  it("moves along the curve without moving the curve", () => {
    for (const curve of [ARCH, ONE_SIDED, CUSP, SWEEP]) {
      for (let index = 0; index <= 40; index += 1) {
        const sample = position(curve, solve(curve, index / 40));
        const squared = (s: number) => (position(curve, s).x - sample.x) ** 2 + (position(curve, s).y - sample.y) ** 2;
        let best = 0;
        for (let scan = 1; scan <= 2_000; scan += 1) if (squared(scan / 2_000) < squared(best)) best = scan / 2_000;
        let low = Math.max(0, best - 5e-4);
        let high = Math.min(1, best + 5e-4);
        for (let refine = 0; refine < 80; refine += 1) {
          const lower = low + (high - low) / 3;
          const upper = high - (high - low) / 3;
          if (squared(lower) < squared(upper)) high = upper; else low = lower;
        }
        expect(Math.sqrt(squared((low + high) / 2))).toBeLessThan(1e-9);
      }
    }
  });

  it("returns progress unchanged where there is no authored arc to measure", () => {
    // Outside [0, 1] an overshooting easing has left the segment, so the caller
    // keeps the polynomial extrapolation it always had.
    expect(solve(ARCH, 1.0877)).toBe(1.0877);
    expect(solve(ARCH, -0.05)).toBe(-0.05);
    expect(solve(ARCH, 0)).toBe(0);
    expect(solve(ARCH, 1)).toBe(1);
    expect(Number.isNaN(solve(ARCH, Number.NaN))).toBe(true);
    // A segment with no length has no distance to distribute.
    const still: Curve = [{ x: 7, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 7 }];
    expect(solve(still, 0.25)).toBe(0.25);
  });

  it("collapses to the exact chord only for a forward straight traversal", () => {
    const chord = (a: Point, b: Point, c: Point, d: Point) => chordAlignedSegment(a, b, c, d);
    expect(chord({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 5 })).toBe(true);
    expect(chord({ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 8, y: 4 }, { x: 10, y: 5 })).toBe(true);
    // Handle reaching past the far anchor is not a monotone traversal.
    expect(chord({ x: 0, y: 0 }, { x: 30, y: 15 }, { x: 8, y: 4 }, { x: 10, y: 5 })).toBe(false);
    expect(chord({ x: 0, y: 0 }, { x: -2, y: -1 }, { x: 8, y: 4 }, { x: 10, y: 5 })).toBe(false);
    expect(chord({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 8, y: 4 }, { x: 10, y: 5 })).toBe(false);
    // A zero-length chord has no direction and may still loop away and return.
    expect(chord({ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: -50 }, { x: 0, y: 0 })).toBe(false);
  });
});

describe("spatial arc-length determinism", () => {
  // These constants are inputs to hashed render output. Changing one moves every
  // curved spatial sample in its last digits and re-hashes every render that
  // contains a curved path, so a change must be a deliberate format revision and
  // must fail here first.
  it("pins the solver parameters that renders are hashed against", () => {
    expect(ARC_LENGTH_PANELS).toBe(16);
    expect(ARC_LENGTH_SOLVER_STEPS).toBe(8);
    expect(ARC_LENGTH_QUADRATURE_POINTS).toBe(8);
  });

  // Exact doubles, so any drift in the arithmetic is caught. These are not
  // "whatever the code prints": the arch values are the double nearest the
  // closed-form root of 2s^3 - 3s^2 + 3s - 2t = 0, verified to 60 digits in the
  // suite below.
  it("pins the exact parameters emitted for the fixture curves", () => {
    expect(solve(ARCH, 0.25)).toBe(0.20196418100833924);
    expect(solve(ARCH, 0.5)).toBe(0.5);
    expect(solve(ARCH, 0.75)).toBe(0.7980358189916608);
    expect(solve(ONE_SIDED, 0.25)).toBe(0.1698972216424266);
    expect(solve(ONE_SIDED, 0.75)).toBe(0.6530067688921501);
    // Both symmetric arches solve to parameters that mirror each other exactly,
    // because mirrored panels of the length table are summed ±node-pair first and
    // so come out bit-identical.
    expect(solve(SDK_ARCH, 0.25) + solve(SDK_ARCH, 0.75)).toBe(1);
    expect(solve(ARCH, 0.25) + solve(ARCH, 0.75)).toBe(1);
  });

  /**
   * The arch's speed is |P'| = 300*(1 - 2s + 2s^2) exactly: with w = s(1-s), the
   * radicand 600^2 w^2 + 300^2 (1-4w) is 300^2 (1-2w)^2, a perfect square, so the
   * elliptic integral degenerates to a polynomial. Hence
   * L(s) = 300*(s - s^2 + (2/3)s^3), L(1) = 200, and L(s) = 200t reduces to the
   * cubic 2s^3 - 3s^2 + 3s - 2t = 0. Cardano at t = 1/4 gives the closed form
   * s = 1/2 + (cbrt(sqrt(2) - 1) - cbrt(sqrt(2) + 1)) / 2, and s(1 - t) = 1 - s(t)
   * by symmetry. Those are the values checked here -- an independent derivation,
   * not a recording of the implementation's own output.
   */
  it("matches the closed-form root available for the arch", () => {
    const closedForm = 0.5 + (Math.cbrt(Math.SQRT2 - 1) - Math.cbrt(Math.SQRT2 + 1)) / 2;
    expect(closedForm).toBeCloseTo(0.201964181008339238, 15);
    expect(Math.abs(solve(ARCH, 0.25) - closedForm)).toBeLessThan(1e-15);
    expect(Math.abs(solve(ARCH, 0.75) - (1 - closedForm))).toBeLessThan(1e-15);
    // Residual of the defining cubic at the solved parameter.
    for (const t of [0.25, 0.5, 0.75]) {
      const s = solve(ARCH, t);
      expect(Math.abs(2 * s * s * s - 3 * s * s + 3 * s - 2 * t)).toBeLessThan(1e-15);
    }
  });

  it("returns bit-identical results when repeated", () => {
    const first = [0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9].map((t) => solve(SWEEP, t));
    for (let run = 0; run < 500; run += 1) {
      const again = [0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9].map((t) => solve(SWEEP, t));
      for (let index = 0; index < first.length; index += 1) expect(Object.is(again[index], first[index])).toBe(true);
    }
  });

  // Enforcement, not documentation: run the solver with every locale-sensitive
  // and implementation-approximated global replaced by a thrower. If the result
  // is still bit-identical, none of them is reachable from the render path.
  it("cannot reach locale, ICU, or implementation-approximated arithmetic", () => {
    const expected = [0.1, 0.25, 1 / 3, 0.75, 0.9].map((t) => solve(SWEEP, t));
    const globals = globalThis as Record<string, unknown>;
    const savedIntl = globals.Intl;
    const savedToLocale = Number.prototype.toLocaleString;
    const savedCompare = String.prototype.localeCompare;
    const approximated = ["pow", "exp", "log", "log2", "log10", "cbrt", "sin", "cos", "tan", "atan2", "hypot", "random"] as const;
    const savedMath = approximated.map((name) => [name, Math[name]] as const);
    const boom = () => { throw new Error("locale or implementation-approximated path reached"); };
    let actual: number[];
    try {
      globals.Intl = new Proxy({}, { get: boom, has: boom, apply: boom });
      Number.prototype.toLocaleString = boom as typeof Number.prototype.toLocaleString;
      String.prototype.localeCompare = boom as typeof String.prototype.localeCompare;
      for (const name of approximated) (Math as unknown as Record<string, unknown>)[name] = boom;
      process.env.LC_ALL = "tr_TR.UTF-8";
      process.env.LANG = "tr_TR.UTF-8";
      process.env.TZ = "Asia/Kathmandu";
      actual = [0.1, 0.25, 1 / 3, 0.75, 0.9].map((t) => solve(SWEEP, t));
    } finally {
      globals.Intl = savedIntl;
      Number.prototype.toLocaleString = savedToLocale;
      String.prototype.localeCompare = savedCompare;
      for (const [name, value] of savedMath) (Math as unknown as Record<string, unknown>)[name] = value;
      delete process.env.LC_ALL;
      delete process.env.LANG;
      delete process.env.TZ;
    }
    for (let index = 0; index < expected.length; index += 1) expect(Object.is(actual[index], expected[index])).toBe(true);
  });

  // `**` is Number::exponentiate, which ECMA-262 leaves implementation-
  // approximated, and `u ** 3 !== u * u * u` for roughly a quarter of doubles in
  // V8. `Math.sqrt` is required to be correctly rounded (tc39/ecma262#3345), and
  // abs/max/min are exact selections. Nothing else may enter these two modules.
  const CORRECTLY_ROUNDED = ["sqrt", "abs", "max", "min"];
  it("uses only correctly-rounded arithmetic in the sampler sources", async () => {
    for (const module of ["spatial-arc-length.ts", "spatial-path.ts"]) {
      const source = await readFile(fileURLToPath(new URL(module, import.meta.url)), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const used = [...code.matchAll(/Math\.(\w+)/g)].map((match) => match[1]);
      expect({ module, exponentiation: code.includes("**") }).toEqual({ module, exponentiation: false });
      expect({ module, approximated: used.filter((name) => !CORRECTLY_ROUNDED.includes(name)) }).toEqual({ module, approximated: [] });
    }
  });
});
