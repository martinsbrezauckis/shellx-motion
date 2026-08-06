/**
 * spatial-arc-length.ts — arc-length reparameterisation for cubic spatial paths.
 *
 * Role: owns the map from *authored progress* to *Bézier parameter* for a curved
 * spatial path segment, so that a layer authored `easing: "linear"` travels the
 * curve at constant speed instead of accelerating wherever the control points
 * happen to spread out. Shape and timing stay separable: this module never
 * evaluates the curve's position, it only answers "which Bézier parameter is
 * `t` of the way along this segment by distance?". The caller feeds that
 * parameter into its unchanged position evaluator, so the traced locus is
 * exactly the same curve as before — only the clock along it changes.
 *
 * Dependencies: type-only import of `MotionSpatialHandle` from
 * `./spatial-path-types`. No I/O, no time, no randomness, no locale.
 * Primary caller: `interpolateSpatialPosition` in `./spatial-path.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NUMERIC, AND WHY THAT IS STILL DETERMINISTIC
 * ---------------------------------------------------------------------------
 * The speed of a cubic Bézier is |P'(s)| = sqrt(Q(s)), where Q is a quartic
 * polynomial. Its integral is an elliptic integral: for a general cubic there is
 * no closed form in elementary functions, so an exact reparameterisation cannot
 * be written down. `chordAlignedSegment` below carves out the sub-case that
 * *does* have one (see there); everything else is solved numerically here.
 *
 * "Numeric" is not the same as "non-deterministic". This solver is bit-exact and
 * reproducible on every conforming engine because:
 *
 *   1. It uses only `+`, `-`, `*`, `/` and `Math.sqrt`. IEEE-754 requires all
 *      five to be correctly rounded, and ECMA-262 requires `Math.sqrt` to return
 *      the correctly rounded result (tc39/ecma262#3345, merged 2024-08-17,
 *      which removed `sqrt` from the implementation-approximated list). Every
 *      other `Math` function, and the `**` operator, are *implementation-
 *      approximated* by the spec and are deliberately not used — not even
 *      `x ** 3`, which is measurably not equal to `x * x * x` in V8.
 *   2. Every loop runs a fixed, pinned number of iterations. There is no
 *      "iterate until converged" tolerance whose trip point could vary.
 *   3. It performs no string, date, collation or `Intl` work, so no locale or
 *      ICU version can reach the result.
 *
 * The consequence to be honest about: the answer is a correctly-rounded-inputs
 * approximation of a transcendental quantity, so a curved sample is no longer a
 * round decimal. `t = 0.5` of the symmetric fixture curve lands on 49.999…986
 * rather than exactly 50. That residue is ~1e-13 px, it is *identical on every
 * machine*, and it is the price of the curve being timed correctly at all.
 *
 * ---------------------------------------------------------------------------
 * PINNED PARAMETERS — THESE ARE PART OF THE RENDER CONTRACT
 * ---------------------------------------------------------------------------
 * `ARC_LENGTH_PANELS`, `ARC_LENGTH_SOLVER_STEPS` and the quadrature rule below
 * are NOT tuning knobs. They are inputs to hashed render output: changing any of
 * them moves every curved spatial sample in the last few digits and therefore
 * changes every content hash that covers a curved path. They are asserted
 * directly by `spatial-arc-length.test.ts` so that an edit fails a test with an
 * explanation rather than silently re-hashing a library of renders. Treat a
 * change here as a format revision, not an optimisation.
 */
import type { MotionSpatialHandle } from "./spatial-path-types";

/**
 * Number of equal-width panels the segment is split into for the cumulative
 * length table. Composite quadrature over panels (rather than one rule over the
 * whole segment) is what keeps accuracy when the speed has a kink — a curve with
 * a cusp, or the very common one-sided handle where the incoming handle is zero
 * and the speed reaches 0 at the endpoint.
 */
export const ARC_LENGTH_PANELS = 16;

/**
 * Fixed number of root-finding steps taken inside the located panel. Newton on a
 * monotone length function converges quadratically from a bracketed seed, so the
 * root is at machine precision after ~4 steps; the remainder is headroom for the
 * degenerate cases that fall back to bisection. The count is fixed rather than
 * tolerance-driven precisely so that the arithmetic sequence cannot vary.
 */
export const ARC_LENGTH_SOLVER_STEPS = 8;

/**
 * Half of an 8-point Gauss-Legendre rule on [-1, 1]: the four positive abscissae
 * and their weights, each used for the symmetric pair ±node. The rule integrates
 * polynomials up to degree 15 exactly; the integrand here is sqrt(quartic),
 * which is analytic wherever the speed is non-zero, so convergence is spectral.
 *
 * The digits are the roots of the degree-8 Legendre polynomial and the standard
 * weights 2 / ((1 - x²)·P₈'(x)²), verified against a 50-digit Newton solve of P₈
 * before being pinned here.
 */
const QUADRATURE_NODES = Object.freeze([
  0.1834346424956498049394761423601839806667,
  0.5255324099163289858177390491892463490419,
  0.7966664774136267395915539364758304368371,
  0.9602898564975362316835608685694729904282,
]);
const QUADRATURE_WEIGHTS = Object.freeze([
  0.3626837833783619829651504492771956121941,
  0.3137066458778872873379622019866013132603,
  0.2223810344533744705443559944262408844301,
  0.1012285362903762591525313543099621901154,
]);

/** Sample count per panel: each of the four entries above serves a ±pair. */
export const ARC_LENGTH_QUADRATURE_POINTS = QUADRATURE_NODES.length * 2;

/**
 * Control points of P'(s), the quadratic Bézier the cubic's derivative traces.
 * Held as loose numbers rather than points so the hot path allocates once per
 * segment sample instead of once per quadrature node.
 */
interface TangentControl {
  readonly x0: number; readonly y0: number;
  readonly x1: number; readonly y1: number;
  readonly x2: number; readonly y2: number;
}

/**
 * Bézier parameter at which the segment has travelled `t` of its own length.
 *
 * @param p0 - Segment start anchor.
 * @param p1 - Start anchor plus its outgoing handle.
 * @param p2 - End anchor plus its incoming handle.
 * @param p3 - Segment end anchor.
 * @param t  - Authored progress, already eased. Normally in [0, 1].
 * @returns The Bézier parameter to evaluate the curve at. Pure: no side effects.
 *
 * Edge cases, all deliberate:
 * - `t` outside [0, 1] is returned unchanged. Overshooting easings (springs,
 *   `back-out`) run past the segment end, and there is no authored geometry out
 *   there to measure — the curve is only defined as an arc on [0, 1]. Keeping
 *   the polynomial extrapolation that shipped before means overshoot stays
 *   bounded and unchanged, and the map is continuous at both ends because
 *   `t = 0` maps to 0 and `t = 1` maps to 1 either way. The alternative,
 *   extending at the boundary speed, divides by |P'(1)| — which is exactly zero
 *   for the very common "incoming handle is zero" segment. Rejected for that.
 * - `NaN` is returned unchanged, so a poisoned easing surfaces as `NaN`
 *   coordinates exactly as it did before rather than being masked.
 * - A zero-length segment (every control point coincident) has no arc to
 *   distribute, so `t` is returned unchanged instead of dividing by zero.
 */
export function arcLengthParameter(
  p0: MotionSpatialHandle,
  p1: MotionSpatialHandle,
  p2: MotionSpatialHandle,
  p3: MotionSpatialHandle,
  t: number,
): number {
  if (!(t > 0) || !(t < 1)) return t;
  const tangent: TangentControl = {
    x0: 3 * (p1.x - p0.x), y0: 3 * (p1.y - p0.y),
    x1: 3 * (p2.x - p1.x), y1: 3 * (p2.y - p1.y),
    x2: 3 * (p3.x - p2.x), y2: 3 * (p3.y - p2.y),
  };

  // Cumulative length at every panel boundary. `cumulative[i]` is the distance
  // from the segment start to s = i / ARC_LENGTH_PANELS.
  const cumulative: number[] = [0];
  for (let panel = 0; panel < ARC_LENGTH_PANELS; panel += 1) {
    const from = panel / ARC_LENGTH_PANELS;
    const to = (panel + 1) / ARC_LENGTH_PANELS;
    cumulative.push(cumulative[panel] + panelLength(tangent, from, to));
  }
  const total = cumulative[ARC_LENGTH_PANELS];
  if (!(total > 0)) return t;

  // Locate the panel holding the target distance. The table is non-decreasing
  // because it accumulates non-negative panel lengths, so this bracket is sound.
  const target = t * total;
  let panel = ARC_LENGTH_PANELS - 1;
  for (let index = 0; index < ARC_LENGTH_PANELS; index += 1) {
    if (target < cumulative[index + 1]) { panel = index; break; }
  }

  // Bracketed Newton inside the panel. The bracket is maintained on every step
  // and a Newton step that leaves it (or divides by a zero speed at a cusp) is
  // replaced by a bisection step, so the iteration cannot diverge or stall.
  const start = panel / ARC_LENGTH_PANELS;
  let low = start;
  let high = (panel + 1) / ARC_LENGTH_PANELS;
  const span = cumulative[panel + 1] - cumulative[panel];
  let s = span > 0 ? start + ((target - cumulative[panel]) / span) * (high - low) : (low + high) / 2;
  for (let step = 0; step < ARC_LENGTH_SOLVER_STEPS; step += 1) {
    const error = cumulative[panel] + panelLength(tangent, start, s) - target;
    if (error === 0) return s;
    if (error > 0) high = s; else low = s;
    const next = s - error / speedAt(tangent, s);
    s = next > low && next < high ? next : (low + high) / 2;
  }
  return s;
}

/**
 * True when arc-length timing has an exact closed form, because the segment is
 * geometrically the straight chord traversed forwards.
 *
 * @returns `true` only if all four control points are *exactly* collinear and
 * every derivative control point points along the chord, in which case the point
 * at distance fraction `t` is exactly `p0 + t·(p3 - p0)`.
 *
 * Why this is worth a branch: under arc-length timing, handles that lie along
 * the chord no longer bend or re-time anything — they are a no-op — and this
 * makes that exactly true rather than true to 1e-13. It keeps a whole class of
 * authored paths on exact arithmetic and out of the solver, so round coordinates
 * stay round. It is a strict generalisation of the both-handles-zero case.
 *
 * The collinearity test is exact float equality on the two cross products, which
 * is deliberately conservative: a curve that is merely *nearly* collinear fails
 * it and goes to the numeric solver, which is correct for it anyway. The
 * monotonicity test uses the Bernstein positivity argument — if the derivative's
 * three control points all project forwards onto the chord then P'(s) does too
 * for every s in [0, 1], so the traversal never doubles back and distance along
 * the curve equals distance along the chord. A zero-length chord is excluded:
 * there is no direction to project onto, and such a segment may still loop away
 * and return, which is not a chord.
 */
export function chordAlignedSegment(
  p0: MotionSpatialHandle,
  p1: MotionSpatialHandle,
  p2: MotionSpatialHandle,
  p3: MotionSpatialHandle,
): boolean {
  const chordX = p3.x - p0.x;
  const chordY = p3.y - p0.y;
  if (chordX === 0 && chordY === 0) return false;
  if ((p1.x - p0.x) * chordY - (p1.y - p0.y) * chordX !== 0) return false;
  if ((p2.x - p0.x) * chordY - (p2.y - p0.y) * chordX !== 0) return false;
  return (p1.x - p0.x) * chordX + (p1.y - p0.y) * chordY >= 0
    && (p2.x - p1.x) * chordX + (p2.y - p1.y) * chordY >= 0
    && (p3.x - p2.x) * chordX + (p3.y - p2.y) * chordY >= 0;
}

/**
 * Arc length over [from, to] by the pinned Gauss-Legendre rule.
 *
 * Each ±node pair is summed before being weighted so that the panel value does
 * not depend on the order the abscissae are visited, which keeps mirrored panels
 * of a symmetric curve bit-identical to each other.
 */
function panelLength(tangent: TangentControl, from: number, to: number): number {
  const half = (to - from) / 2;
  const middle = (from + to) / 2;
  let sum = 0;
  for (let index = 0; index < QUADRATURE_NODES.length; index += 1) {
    const offset = half * QUADRATURE_NODES[index];
    sum += QUADRATURE_WEIGHTS[index] * (speedAt(tangent, middle - offset) + speedAt(tangent, middle + offset));
  }
  return sum * half;
}

/**
 * |P'(s)|, the instantaneous speed. `P'` is the quadratic Bézier on the tangent
 * control points, evaluated in Bernstein form with plain multiplication so that
 * every operation is IEEE-754 correctly rounded.
 */
function speedAt(tangent: TangentControl, s: number): number {
  const u = 1 - s;
  const uu = u * u;
  const us = 2 * u * s;
  const ss = s * s;
  const x = uu * tangent.x0 + us * tangent.x1 + ss * tangent.x2;
  const y = uu * tangent.y0 + us * tangent.y1 + ss * tangent.y2;
  return Math.sqrt(x * x + y * y);
}
