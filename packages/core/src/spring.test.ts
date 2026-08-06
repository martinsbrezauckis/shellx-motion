import { describe, expect, it } from "vitest";
import {
  describeSpringEasing,
  isSpringEasing,
  resolveSpringEasing,
  SPRING_MIN_DAMPING_RATIO,
  SPRING_PRESET_IDS,
  SPRING_PRESETS,
  SPRING_SETTLE_TOLERANCE,
  springDampingRatio,
  springPresetEasing,
  validateSpringEasing
} from "./spring";
import type { MotionSpringEasing } from "./types";

/**
 * Independent numerical reference: integrate the normalized damped-oscillator ODE
 *   d'' + 2*zeta*omega*d' + omega^2*d = 0,  d(0) = -1, d'(0) = velocity
 * with classic RK4 over tau in [0,1], then apply the same endpoint normalization
 * (v = (1 + d(tau)) / (1 + d(1))). This shares only the documented omega-from-zeta
 * mapping with the implementation; the SOLUTION METHOD (RK4) is independent of the
 * analytic closed form under test, so it genuinely verifies the closed form solves
 * the oscillator.
 */
function rk4Reference(easing: MotionSpringEasing, steps = 20000): (t: number) => number {
  const mass = easing.mass ?? 1;
  const velocity = easing.initialVelocity ?? 0;
  let zeta = easing.damping / (2 * Math.sqrt(easing.stiffness * mass));
  if (!Number.isFinite(zeta) || zeta <= 0) zeta = SPRING_MIN_DAMPING_RATIO;
  zeta = Math.max(zeta, SPRING_MIN_DAMPING_RATIO);
  const settleLn = Math.log(1 / SPRING_SETTLE_TOLERANCE);
  const omega = zeta < 1 ? settleLn / zeta : zeta === 1 ? settleLn : settleLn / (zeta - Math.sqrt(zeta * zeta - 1));

  // Derivative of the first-order system [u=d, w=d'].
  const deriv = (u: number, w: number): [number, number] => [w, -2 * zeta * omega * w - omega * omega * u];

  // Integrate once, caching displacement at each grid node.
  const h = 1 / steps;
  const grid: number[] = new Array(steps + 1);
  let u = -1;
  let w = velocity;
  grid[0] = u;
  for (let i = 0; i < steps; i += 1) {
    const [k1u, k1w] = deriv(u, w);
    const [k2u, k2w] = deriv(u + (h / 2) * k1u, w + (h / 2) * k1w);
    const [k3u, k3w] = deriv(u + (h / 2) * k2u, w + (h / 2) * k2w);
    const [k4u, k4w] = deriv(u + h * k3u, w + h * k3w);
    u += (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
    w += (h / 6) * (k1w + 2 * k2w + 2 * k3w + k4w);
    grid[i + 1] = u;
  }
  const endRaw = 1 + grid[steps];
  const normalizer = Math.abs(endRaw) < 1e-9 ? 1 : endRaw;
  return (t: number): number => {
    const tau = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const node = Math.round(tau * steps);
    return (1 + grid[node]) / normalizer;
  };
}

const UNDER: MotionSpringEasing = { type: "spring", stiffness: 180, damping: 12, mass: 1 }; // zeta ~= 0.45
const CRITICAL: MotionSpringEasing = { type: "spring", stiffness: 100, damping: 20, mass: 1 }; // zeta = 1.0
const OVER: MotionSpringEasing = { type: "spring", stiffness: 100, damping: 40, mass: 1 }; // zeta = 2.0

describe("resolveSpringEasing closed form", () => {
  it("pins endpoints exactly: value(0) = 0 and value(1) = 1", () => {
    for (const easing of [UNDER, CRITICAL, OVER]) {
      const spring = resolveSpringEasing(easing);
      expect(spring(0)).toBe(0);
      expect(spring(1)).toBeCloseTo(1, 12);
      // clamped domain: t below 0 / above 1 pins to the endpoints.
      expect(spring(-0.5)).toBe(0);
      expect(spring(1.5)).toBeCloseTo(1, 12);
    }
  });

  it("matches an independent RK4 integration of the oscillator ODE", () => {
    for (const easing of [UNDER, CRITICAL, OVER]) {
      const spring = resolveSpringEasing(easing);
      const reference = rk4Reference(easing);
      for (let i = 0; i <= 40; i += 1) {
        const t = i / 40;
        expect(spring(t)).toBeCloseTo(reference(t), 4);
      }
    }
  });

  it("overshoots past the target for an under-damped spring", () => {
    const spring = resolveSpringEasing(UNDER);
    let maxValue = -Infinity;
    for (let i = 0; i <= 1000; i += 1) maxValue = Math.max(maxValue, spring(i / 1000));
    // A visible bounce: the eased value exceeds 1 somewhere inside the segment.
    expect(maxValue).toBeGreaterThan(1.05);
  });

  it("settles monotonically for critically and over-damped springs", () => {
    for (const easing of [CRITICAL, OVER]) {
      const spring = resolveSpringEasing(easing);
      let previous = -Infinity;
      let maxValue = -Infinity;
      for (let i = 0; i <= 1000; i += 1) {
        const value = spring(i / 1000);
        // Non-decreasing (allow a hair of floating-point slack).
        expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = value;
        maxValue = Math.max(maxValue, value);
      }
      // No overshoot: never meaningfully exceeds the target.
      expect(maxValue).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("is deterministic: identical params produce identical sampled curves", () => {
    const sample = (easing: MotionSpringEasing): number[] => {
      const spring = resolveSpringEasing(easing);
      return Array.from({ length: 101 }, (_, i) => spring(i / 100));
    };
    const first = sample(UNDER);
    const second = sample({ type: "spring", stiffness: 180, damping: 12, mass: 1 });
    expect(second).toEqual(first);
  });

  it("depends only on the damping ratio after segment normalization", () => {
    // Same zeta (26/(2*sqrt(170)) == 52/(2*sqrt(680)) ~= 0.997), different absolute scale.
    const a = resolveSpringEasing({ type: "spring", stiffness: 170, damping: 26, mass: 1 });
    const b = resolveSpringEasing({ type: "spring", stiffness: 680, damping: 52, mass: 1 });
    for (let i = 0; i <= 50; i += 1) {
      const t = i / 50;
      expect(a(t)).toBeCloseTo(b(t), 10);
    }
  });

  it("keeps a very low damping ratio bounded via the clamp and still settles", () => {
    const wild: MotionSpringEasing = { type: "spring", stiffness: 100000, damping: 1, mass: 1 }; // raw zeta ~= 0.0016
    expect(springDampingRatio(wild)).toBe(SPRING_MIN_DAMPING_RATIO);
    const spring = resolveSpringEasing(wild);
    expect(spring(0)).toBe(0);
    expect(spring(1)).toBeCloseTo(1, 12);
    for (let i = 0; i <= 100; i += 1) expect(Number.isFinite(spring(i / 100))).toBe(true);
  });

  it("honours a non-zero initial velocity", () => {
    const launched = resolveSpringEasing({ type: "spring", stiffness: 170, damping: 26, mass: 1, initialVelocity: 4 });
    const resting = resolveSpringEasing({ type: "spring", stiffness: 170, damping: 26, mass: 1, initialVelocity: 0 });
    // An outward initial velocity pushes the curve higher early in the segment.
    expect(launched(0.1)).toBeGreaterThan(resting(0.1));
  });
});

describe("spring easing validation", () => {
  it("accepts a well-formed spring with and without optional fields", () => {
    expect(validateSpringEasing({ type: "spring", stiffness: 170, damping: 26 })).toBeNull();
    expect(validateSpringEasing({ type: "spring", stiffness: 170, damping: 26, mass: 2, initialVelocity: -1 })).toBeNull();
  });

  it("rejects malformed springs with an honest, field-specific message", () => {
    expect(validateSpringEasing({ type: "spring", damping: 26 })).toBe("spring stiffness must be a positive finite number");
    expect(validateSpringEasing({ type: "spring", stiffness: -1, damping: 26 })).toBe("spring stiffness must be a positive finite number");
    expect(validateSpringEasing({ type: "spring", stiffness: 170, damping: 0 })).toBe("spring damping must be a positive finite number");
    expect(validateSpringEasing({ type: "spring", stiffness: 170, damping: 26, mass: 0 })).toBe("spring mass must be a positive finite number");
    expect(validateSpringEasing({ type: "spring", stiffness: 170, damping: 26, initialVelocity: Number.NaN })).toBe("spring initialVelocity must be a finite number");
    expect(validateSpringEasing({ type: "bounce", stiffness: 170, damping: 26 })).toBe('spring easing type must be "spring"');
    expect(validateSpringEasing(42)).toBe("spring easing must be an object");
  });

  it("guards the structural type predicate", () => {
    expect(isSpringEasing({ type: "spring", stiffness: 1, damping: 1 })).toBe(true);
    expect(isSpringEasing("spring-gentle")).toBe(false);
    expect(isSpringEasing(null)).toBe(false);
    expect(isSpringEasing([{ type: "spring" }])).toBe(false);
  });
});

describe("spring presets", () => {
  it("exposes gentle, snappy, and bouncy presets spanning the damping regimes", () => {
    expect(SPRING_PRESET_IDS).toEqual(["spring-gentle", "spring-snappy", "spring-bouncy"]);
    expect(springDampingRatio(SPRING_PRESETS["spring-gentle"])).toBeCloseTo(0.997, 2);
    expect(springDampingRatio(SPRING_PRESETS["spring-snappy"])).toBeCloseTo(0.690, 2);
    expect(springDampingRatio(SPRING_PRESETS["spring-bouncy"])).toBeCloseTo(0.447, 2);
  });

  it("resolves preset aliases to their param sets", () => {
    expect(springPresetEasing("spring-bouncy")).toEqual({ type: "spring", stiffness: 180, damping: 12, mass: 1 });
    expect(springPresetEasing("not-a-spring")).toBeNull();
  });

  it("produces a stable canonical token with defaults filled", () => {
    expect(describeSpringEasing({ type: "spring", stiffness: 170, damping: 26 })).toBe("spring(stiffness=170,damping=26,mass=1,velocity=0)");
    expect(describeSpringEasing({ type: "spring", stiffness: 170, damping: 26, mass: 1, initialVelocity: 0 })).toBe("spring(stiffness=170,damping=26,mass=1,velocity=0)");
  });
});
