/**
 * spring.ts — closed-form damped-spring easing for MotionIR.
 *
 * Role: provides the pure, deterministic evaluation, validation, presets, and
 * canonical description for `{ type: "spring", ... }` easings. This module owns
 * the spring MATH only; the wiring into the general easing resolver, keyframe
 * interpolation, and preset registry lives in `timeline.ts`, which both render
 * lanes (native + browser) inherit through `effectiveLayerAtMs`. Nothing here
 * touches I/O, time, or randomness, so `resolveSpringEasing(params)(t)` is a
 * pure function of `(t, params)` — a hard requirement for receipt determinism.
 *
 * Dependencies: type-only import of `MotionSpringEasing` from `./types`.
 * Primary callers: `timeline.ts` (resolveEasing / isSupportedEasing / presets),
 * `validate.ts` (via timeline's `readEasingValidationError`), `renderer-ffmpeg`
 * (audio volume automation samples this through `resolveEasing`), and the
 * debug-api easing panel (canonical token via `describeSpringEasing`).
 *
 * ---------------------------------------------------------------------------
 * PARAMETERIZATION (why stiffness / damping / mass)
 * ---------------------------------------------------------------------------
 * Modern tools split into two camps: the physical triple
 * (stiffness/damping/mass — React Spring, Framer Motion `type:"spring"`,
 * react-native-reanimated, Rive) and the perceptual pair (duration/bounce —
 * SwiftUI `Spring(duration:bounce:)`, newer Framer). The perceptual pair is a
 * documented *reparameterization* of the physical triple, and CSS `linear()`
 * spring generators simply *sample* a physical spring into a piecewise-linear
 * output. The review's G2 gap names "mass/stiffness/damping" explicitly, and
 * the physical triple is the lingua franca every authoring tool accepts, so it
 * is the single canonical param set here. Designer-facing convenience is
 * delivered through named presets (see `SPRING_PRESETS`) rather than a second
 * competing param set — keeping validation and serialization unambiguous.
 *
 * ---------------------------------------------------------------------------
 * SEGMENT-DURATION SEMANTICS (constraint: springs are physical, segments are [0,1])
 * ---------------------------------------------------------------------------
 * A keyframe segment supplies a normalized progress `t in [0,1]`; MotionIR must
 * stay portable, so the spring is normalized to *settle within its own
 * segment*: the real keyframe spacing IS the spring's duration. We evaluate the
 * standard damped oscillator in a dimensionless time `tau in [0,1]` and pick the
 * normalized natural frequency so the dominant decay mode reaches the settle
 * tolerance exactly at `tau = 1`.
 *
 * A consequence worth stating plainly: once a spring is forced to settle at the
 * segment end, the normalized curve shape is governed *only* by the damping
 * ratio `zeta = damping / (2*sqrt(stiffness*mass))` (plus optional initial
 * velocity). Two springs with the same `zeta` but different absolute stiffness
 * (e.g. 170/26 vs 680/52) produce the identical normalized curve — their
 * real-world difference is settle *speed*, which the segment duration already
 * fixes. Authors change the *character* (overshoot / bounce count) by changing
 * the damping-to-stiffness relationship, not the absolute magnitudes. This is
 * the correct, portable behavior for a bounded keyframe segment.
 *
 * Regimes by `zeta`: `< 1` under-damped (overshoot), `= 1` critically damped
 * (fastest monotonic settle), `> 1` over-damped (slow monotonic settle).
 *
 * ---------------------------------------------------------------------------
 * OUTPUT NORMALIZATION (value(0)=0, value(1)=1, documented overshoot)
 * ---------------------------------------------------------------------------
 * Let `d(tau)` be the displacement from target with `d(0) = -1` (start),
 * `d(inf) = 0` (settled), `d'(0) = initialVelocity`. The raw eased value is
 * `r(tau) = 1 + d(tau)`, so `r(0) = 0` exactly. We return `r(tau)/r(1)`:
 *   - `value(0) = 0` exactly (0 / r(1)),
 *   - `value(1) = 1` exactly (r(1) / r(1)),
 *   - dividing by the positive scalar `r(1)` (~1 within the settle tolerance)
 *     preserves monotonicity for critically/over-damped springs and preserves
 *     under-damped OVERSHOOT: `value(tau)` deliberately exceeds 1 (and may dip
 *     slightly below 0) between the endpoints — that is the spring's physical
 *     overshoot, applied to the keyframe delta by the interpolator.
 */
import type { MotionEasing, MotionSpringEasing } from "./types";

/** Default oscillator mass when `mass` is omitted (matches React Spring / Framer). */
export const DEFAULT_SPRING_MASS = 1;
/** Default normalized initial velocity (fraction of the segment delta per unit tau). */
export const DEFAULT_SPRING_INITIAL_VELOCITY = 0;
/**
 * Settle tolerance: the dominant decay mode is mapped to reach this fraction of
 * the initial displacement at `tau = 1`. 1e-3 = "within 0.1% of target". Exposed
 * as a constant so the closed form and any external sampler agree bit-for-bit.
 */
export const SPRING_SETTLE_TOLERANCE = 1e-3;
/**
 * Lower clamp on the effective damping ratio. Below this, the forced-settle
 * normalization would cram an unbounded number of oscillations into the segment
 * (e.g. zeta=0.01 => ~100 bounces), which reads as noise and aliases the audio
 * sampler. Springs stay well-behaved and deterministic; validation still only
 * requires positive stiffness/damping/mass.
 */
export const SPRING_MIN_DAMPING_RATIO = 0.05;

/** Allowed keys on a spring easing object (for reference / tooling). */
const SPRING_KEYS = new Set(["type", "stiffness", "damping", "mass", "initialVelocity"]);

/** Named preset ids that resolve to spring param sets (data-level aliases). */
export type SpringPresetId = "spring-gentle" | "spring-snappy" | "spring-bouncy";

/**
 * Named spring presets, exposed wherever named easings are listed. Each resolves
 * to a physical param set; the trailing comment records its damping ratio.
 */
export const SPRING_PRESETS: Record<SpringPresetId, MotionSpringEasing> = {
  // zeta = 26 / (2*sqrt(170*1)) ~= 0.997 — near-critical, smooth, no perceptible overshoot.
  "spring-gentle": { type: "spring", stiffness: 170, damping: 26, mass: 1 },
  // zeta = 20 / (2*sqrt(210*1)) ~= 0.690 — quick settle with a small confident overshoot.
  "spring-snappy": { type: "spring", stiffness: 210, damping: 20, mass: 1 },
  // zeta = 12 / (2*sqrt(180*1)) ~= 0.447 — pronounced overshoot / visible bounce.
  "spring-bouncy": { type: "spring", stiffness: 180, damping: 12, mass: 1 }
};

/** Ordered preset ids, for deterministic listing. */
export const SPRING_PRESET_IDS: SpringPresetId[] = ["spring-gentle", "spring-snappy", "spring-bouncy"];

/**
 * Resolve a spring preset alias (e.g. "spring-gentle") to its param set.
 * @returns a shared preset object, or null if `id` is not a spring preset.
 */
export function springPresetEasing(id: string): MotionSpringEasing | null {
  return Object.prototype.hasOwnProperty.call(SPRING_PRESETS, id) ? SPRING_PRESETS[id as SpringPresetId] : null;
}

/**
 * Structural type guard: true when `value` is an object literal tagged
 * `type: "spring"`. Structural only — parameter validity is checked by
 * {@link validateSpringEasing}.
 */
export function isSpringEasing(value: unknown): value is MotionSpringEasing {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { type?: unknown }).type === "spring";
}

/**
 * Validate a spring easing object's parameters and ranges.
 * @param value untrusted candidate (already known/assumed to be a spring shape).
 * @returns null if valid, otherwise an honest, field-specific error message.
 */
export function validateSpringEasing(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "spring easing must be an object";
  const record = value as Record<string, unknown>;
  if (record.type !== "spring") return 'spring easing type must be "spring"';
  if (!isPositiveFinite(record.stiffness)) return "spring stiffness must be a positive finite number";
  if (!isPositiveFinite(record.damping)) return "spring damping must be a positive finite number";
  if (record.mass !== undefined && !isPositiveFinite(record.mass)) return "spring mass must be a positive finite number";
  if (record.initialVelocity !== undefined && !isFiniteNumber(record.initialVelocity)) return "spring initialVelocity must be a finite number";
  return null;
}

/**
 * Canonical, stable string description of a spring easing — used as a grouping
 * key wherever easings are string-keyed (the debug-api easing panel) and as a
 * human-readable label. Missing optional fields are filled with their defaults
 * so identical springs (regardless of omitted defaults) share one token.
 */
export function describeSpringEasing(easing: MotionSpringEasing): string {
  const mass = easing.mass ?? DEFAULT_SPRING_MASS;
  const velocity = easing.initialVelocity ?? DEFAULT_SPRING_INITIAL_VELOCITY;
  return `spring(stiffness=${easing.stiffness},damping=${easing.damping},mass=${mass},velocity=${velocity})`;
}

/**
 * Canonical string token for any easing, for object-safe comparison and
 * string-keyed introspection (spatial-lane easing alignment, the debug-api
 * easing panel). String easings are returned trimmed; spring objects become a
 * stable `spring(...)` descriptor; absent/empty easing collapses to "linear".
 * Lives here (not timeline.ts) so lower-level modules can import it without a
 * cycle.
 */
export function easingToken(easing: MotionEasing | undefined): string {
  if (isSpringEasing(easing)) return describeSpringEasing(easing);
  return typeof easing === "string" && easing.trim().length > 0 ? easing.trim() : "linear";
}

/**
 * Effective damping ratio `zeta = c / (2*sqrt(k*m))`, clamped to
 * {@link SPRING_MIN_DAMPING_RATIO}. Exported for tests / introspection.
 */
export function springDampingRatio(easing: MotionSpringEasing): number {
  const mass = easing.mass ?? DEFAULT_SPRING_MASS;
  const zeta = easing.damping / (2 * Math.sqrt(easing.stiffness * mass));
  if (!Number.isFinite(zeta) || zeta <= 0) return SPRING_MIN_DAMPING_RATIO;
  return Math.max(zeta, SPRING_MIN_DAMPING_RATIO);
}

/**
 * Build the closed-form easing function for a spring.
 *
 * Returns `(t) => value`, `t` clamped to `[0,1]`, with `value(0)=0`,
 * `value(1)=1`, and overshoot beyond `[0,1]` for under-damped springs. Pure and
 * deterministic. Assumes the params already passed {@link validateSpringEasing}
 * (defaults are applied for omitted mass / initialVelocity).
 */
export function resolveSpringEasing(easing: MotionSpringEasing): (t: number) => number {
  const velocity = easing.initialVelocity ?? DEFAULT_SPRING_INITIAL_VELOCITY;
  const zeta = springDampingRatio(easing);
  const settleLn = Math.log(1 / SPRING_SETTLE_TOLERANCE);

  // Normalized natural frequency omega, chosen so the dominant (slowest) decay
  // mode reaches SPRING_SETTLE_TOLERANCE exactly at tau = 1. All three branches
  // agree at zeta = 1 (omega = settleLn), so the mapping is continuous in zeta.
  let omega: number;
  if (zeta < 1) {
    omega = settleLn / zeta; // envelope e^{-zeta*omega*tau}: zeta*omega = settleLn
  } else if (zeta === 1) {
    omega = settleLn;
  } else {
    omega = settleLn / (zeta - Math.sqrt(zeta * zeta - 1)); // slow over-damped mode |r_slow| = settleLn
  }

  // Displacement d(tau) from target: d(0) = -1, d'(0) = velocity, d(inf) = 0.
  let displacement: (tau: number) => number;
  if (zeta < 1) {
    // Under-damped: d = e^{-zeta*omega*tau} (A cos(wd*tau) + B sin(wd*tau)).
    const dampedFreq = omega * Math.sqrt(1 - zeta * zeta);
    const coefficientA = -1; // d(0) = A = -1
    const coefficientB = (velocity + zeta * omega * coefficientA) / dampedFreq; // d'(0) = -zeta*omega*A + B*wd = velocity
    displacement = (tau) =>
      Math.exp(-zeta * omega * tau) * (coefficientA * Math.cos(dampedFreq * tau) + coefficientB * Math.sin(dampedFreq * tau));
  } else if (zeta === 1) {
    // Critically damped: d = (A + B*tau) e^{-omega*tau}.
    const coefficientA = -1; // d(0) = A = -1
    const coefficientB = velocity + omega * coefficientA; // d'(0) = B - omega*A = velocity
    displacement = (tau) => (coefficientA + coefficientB * tau) * Math.exp(-omega * tau);
  } else {
    // Over-damped: d = A e^{r1*tau} + B e^{r2*tau}, r1 slow, r2 fast (both < 0).
    const disc = Math.sqrt(zeta * zeta - 1);
    const rateSlow = -omega * (zeta - disc);
    const rateFast = -omega * (zeta + disc);
    // A + B = -1 (d(0)); A*r1 + B*r2 = velocity (d'(0)).
    const coefficientB = (velocity + rateSlow) / (rateFast - rateSlow);
    const coefficientA = -1 - coefficientB;
    displacement = (tau) => coefficientA * Math.exp(rateSlow * tau) + coefficientB * Math.exp(rateFast * tau);
  }

  const rawValue = (tau: number): number => 1 + displacement(tau);
  const endValue = rawValue(1);
  // r(1) is ~1 within the settle tolerance; guard the pathological near-zero case.
  const normalizer = Math.abs(endValue) < 1e-9 ? 1 : endValue;

  return (t: number): number => {
    // Pin endpoints exactly. Mathematically rawValue(0)=0, but the over-damped
    // coefficient reconstruction (A = -1 - B) leaves a sub-epsilon residue in
    // floating point, so clamp both ends explicitly for exact 0 / 1.
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return rawValue(t) / normalizer;
  };
}

/** True for a finite number strictly greater than zero. */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** True for any finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
