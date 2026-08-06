import { arcLengthParameter, chordAlignedSegment } from "./spatial-arc-length";
import { easingToken } from "./spring";
import type { MotionEasing, MotionKeyframe, MotionLayer } from "./types";
import type {
  MotionSpatialHandle,
  MotionSpatialInterpolation,
  MotionSpatialPathPoint,
  MotionSpatialTangentMode,
} from "./spatial-path-types";

const MAX_COORDINATE = 1_000_000;
const MODES = new Set<MotionSpatialTangentMode>(["linear", "smooth", "broken", "auto"]);
const ZERO = Object.freeze({ x: 0, y: 0 });

export interface LayerSpatialPositionUpsert {
  atMs: number;
  x: number;
  y: number;
  easing?: MotionEasing;
  spatial?: MotionSpatialInterpolation;
}

export interface LayerSpatialPositionMove { fromMs: number; toMs: number }
export interface LayerSpatialPositionDelete { atMs: number }

export interface LayerSpatialPositionResult {
  layer: MotionLayer;
  changedPaths: string[];
  action: "inserted" | "replaced" | "moved" | "deleted";
  point?: MotionSpatialPathPoint;
}

export function upsertLayerSpatialPosition(layer: MotionLayer, input: LayerSpatialPositionUpsert): LayerSpatialPositionResult {
  assertEditableLayer(layer);
  assertGloballyAlignedPositionLanes(layer);
  assertTimestamp(input.atMs, "atMs");
  assertCoordinate(input.x, "x");
  assertCoordinate(input.y, "y");
  const xFrames = cloneFrames(layer.keyframes?.["transform.x"]);
  const yFrames = cloneFrames(layer.keyframes?.["transform.y"]);
  const xIndex = xFrames.findIndex((frame) => frame.atMs === input.atMs);
  const yIndex = yFrames.findIndex((frame) => frame.atMs === input.atMs);
  if ((xIndex === -1) !== (yIndex === -1)) throw new Error("Spatial position requires aligned transform.x and transform.y keyframes.");
  const previous = xIndex >= 0 ? readSpatial(xFrames[xIndex].spatial) : null;
  const spatial = normalizeSpatial(input.spatial ?? previous ?? linearSpatial());
  const easing = input.easing ?? (xIndex >= 0 ? xFrames[xIndex].easing : undefined);
  const xFrame: MotionKeyframe = { atMs: input.atMs, value: input.x, ...(easing ? { easing } : {}), spatial };
  const yFrame: MotionKeyframe = { atMs: input.atMs, value: input.y, ...(easing ? { easing } : {}) };
  if (xIndex < 0) { xFrames.push(xFrame); yFrames.push(yFrame); }
  else { xFrames[xIndex] = xFrame; yFrames[yIndex] = yFrame; }
  sortFrames(xFrames); sortFrames(yFrames);
  return {
    layer: withPositionFrames(layer, xFrames, yFrames),
    changedPaths: changedPaths(layer.id, input.atMs),
    action: xIndex < 0 ? "inserted" : "replaced",
    point: { atMs: input.atMs, x: input.x, y: input.y, ...(easing ? { easing } : {}), spatial },
  };
}

export function moveLayerSpatialPosition(layer: MotionLayer, input: LayerSpatialPositionMove): LayerSpatialPositionResult {
  assertEditableLayer(layer);
  assertGloballyAlignedPositionLanes(layer);
  assertTimestamp(input.fromMs, "fromMs");
  assertTimestamp(input.toMs, "toMs");
  if (input.fromMs === input.toMs) throw new Error("Spatial position move did not change timestamp.");
  const xFrames = cloneFrames(layer.keyframes?.["transform.x"]);
  const yFrames = cloneFrames(layer.keyframes?.["transform.y"]);
  const xIndex = xFrames.findIndex((frame) => frame.atMs === input.fromMs);
  const yIndex = yFrames.findIndex((frame) => frame.atMs === input.fromMs);
  if (xIndex < 0 || yIndex < 0) throw new Error(`No aligned spatial position found at ${input.fromMs}ms.`);
  if (xFrames.some((frame) => frame.atMs === input.toMs) || yFrames.some((frame) => frame.atMs === input.toMs)) {
    throw new Error(`Spatial position already exists at ${input.toMs}ms.`);
  }
  xFrames[xIndex] = { ...xFrames[xIndex], atMs: input.toMs };
  yFrames[yIndex] = { ...yFrames[yIndex], atMs: input.toMs };
  sortFrames(xFrames); sortFrames(yFrames);
  return {
    layer: withPositionFrames(layer, xFrames, yFrames),
    changedPaths: [...changedPaths(layer.id, input.fromMs), ...changedPaths(layer.id, input.toMs)],
    action: "moved",
  };
}

export function deleteLayerSpatialPosition(layer: MotionLayer, input: LayerSpatialPositionDelete): LayerSpatialPositionResult {
  assertEditableLayer(layer);
  assertGloballyAlignedPositionLanes(layer);
  assertTimestamp(input.atMs, "atMs");
  const xFrames = cloneFrames(layer.keyframes?.["transform.x"]);
  const yFrames = cloneFrames(layer.keyframes?.["transform.y"]);
  const xIndex = xFrames.findIndex((frame) => frame.atMs === input.atMs);
  const yIndex = yFrames.findIndex((frame) => frame.atMs === input.atMs);
  if (xIndex < 0 || yIndex < 0) throw new Error(`No aligned spatial position found at ${input.atMs}ms.`);
  xFrames.splice(xIndex, 1); yFrames.splice(yIndex, 1);
  return {
    layer: withPositionFrames(layer, xFrames, yFrames),
    changedPaths: changedPaths(layer.id, input.atMs),
    action: "deleted",
  };
}

export function readMotionSpatialPath(layer: MotionLayer): MotionSpatialPathPoint[] | null {
  const xFrames = layer.keyframes?.["transform.x"];
  const yFrames = layer.keyframes?.["transform.y"];
  if (!xFrames || !yFrames || xFrames.length < 2 || xFrames.length !== yFrames.length) return null;
  const sortedX = [...xFrames].sort((a, b) => a.atMs - b.atMs);
  const sortedY = [...yFrames].sort((a, b) => a.atMs - b.atMs);
  const points: MotionSpatialPathPoint[] = [];
  for (let index = 0; index < sortedX.length; index += 1) {
    const x = sortedX[index]; const y = sortedY[index];
    if (x.atMs !== y.atMs || typeof x.value !== "number" || typeof y.value !== "number") return null;
    if (easingToken(x.easing) !== easingToken(y.easing)) return null;
    points.push({ atMs: x.atMs, x: x.value, y: y.value, ...(x.easing ? { easing: x.easing } : {}), spatial: normalizeSpatial(readSpatial(x.spatial) ?? linearSpatial()) });
  }
  return resolveAutoHandles(points);
}

/**
 * Samples the resolved spatial path at `atMs`.
 *
 * Time parameterisation and path shape are deliberately separated here, because
 * conflating them re-eases the motion: it silently applied smoothstep to every
 * straight paired move (see `straightSegment`) and it made curved segments speed
 * up and slow down wherever the control points spread out. `ease` maps
 * normalised segment time to the authored eased progress; that progress is then
 * a fraction of DISTANCE ALONG THE SEGMENT, never a raw curve parameter. Three
 * ways of turning it into a point, in order of preference:
 *
 * - Straight segment (both handles zero): the analytic chord sample. Exact.
 * - Chord-aligned segment (handles exactly on the chord, pointing forward): also
 *   the analytic chord sample, because arc-length timing makes such handles a
 *   no-op. Exact — see `chordAlignedSegment`.
 * - Genuinely curved segment: the eased progress is converted to a Bézier
 *   parameter by `arcLengthParameter` and the authored cubic is evaluated there.
 *   The traced locus is byte-for-byte the same curve as any other
 *   parameterisation of it; only the clock along it changes, so `linear` now
 *   means constant speed. That conversion is numeric — arc length of a cubic is
 *   an elliptic integral — but bit-reproducible; see `spatial-arc-length.ts`.
 */
export function interpolateSpatialPosition(layer: MotionLayer, atMs: number, ease: (value: MotionEasing | undefined, t: number) => number): MotionSpatialHandle | null {
  const points = readMotionSpatialPath(layer);
  if (!points) return null;
  if (atMs <= points[0].atMs) return { x: points[0].x, y: points[0].y };
  const last = points.at(-1)!;
  if (atMs >= last.atMs) return { x: last.x, y: last.y };
  const exact = points.find((point) => point.atMs === atMs);
  if (exact) return { x: exact.x, y: exact.y };
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]; const to = points[index + 1];
    if (atMs <= from.atMs || atMs >= to.atMs) continue;
    const raw = (atMs - from.atMs) / (to.atMs - from.atMs);
    const t = ease(from.easing, Math.max(0, Math.min(1, raw)));
    if (straightSegment(from, to)) return linearPoint(from, to, t);
    const outgoing = add(from, from.spatial.out);
    const incoming = add(to, to.spatial.in);
    if (chordAlignedSegment(from, outgoing, incoming, to)) return linearPoint(from, to, t);
    return cubicPoint(from, outgoing, incoming, to, arcLengthParameter(from, outgoing, incoming, to, t));
  }
  return { x: last.x, y: last.y };
}

export function cloneMotionKeyframe(keyframe: MotionKeyframe): MotionKeyframe {
  const spatial = readSpatial(keyframe.spatial);
  return { atMs: keyframe.atMs, value: keyframe.value, ...(keyframe.easing ? { easing: keyframe.easing } : {}), ...(spatial ? { spatial: normalizeSpatial(spatial) } : {}) };
}

export function validateSpatialKeyframes(layerValue: unknown, path: string, errors: Array<{ path: string; message: string }>): void {
  const layer = record(layerValue); const keyframes = record(layer?.keyframes);
  if (!keyframes) return;
  const xFrames = Array.isArray(keyframes["transform.x"]) ? keyframes["transform.x"] : [];
  const yFrames = Array.isArray(keyframes["transform.y"]) ? keyframes["transform.y"] : [];
  for (let index = 0; index < xFrames.length; index += 1) {
    const frame = record(xFrames[index]);
    if (!frame || !("spatial" in frame)) continue;
    const error = spatialError(frame.spatial);
    if (error) errors.push({ path: `${path}/keyframes/transform.x/${index}/spatial`, message: error });
    const pair = yFrames.find((candidate) => record(candidate)?.atMs === frame.atMs);
    if (!pair) errors.push({ path: `${path}/keyframes/transform.x/${index}/spatial`, message: "requires an aligned transform.y keyframe" });
  }
  for (let index = 0; index < yFrames.length; index += 1) {
    const frame = record(yFrames[index]);
    if (frame && "spatial" in frame) errors.push({ path: `${path}/keyframes/transform.y/${index}/spatial`, message: "is owned by the aligned transform.x keyframe" });
  }
}

function resolveAutoHandles(points: MotionSpatialPathPoint[]): MotionSpatialPathPoint[] {
  return points.map((point, index) => {
    if (point.spatial.mode !== "auto") return point;
    const previous = points[Math.max(0, index - 1)]; const next = points[Math.min(points.length - 1, index + 1)];
    const tangent = { x: (next.x - previous.x) / 6, y: (next.y - previous.y) / 6 };
    return { ...point, spatial: { mode: "auto", in: { x: -tangent.x || 0, y: -tangent.y || 0 }, out: tangent } };
  });
}

function normalizeSpatial(value: MotionSpatialInterpolation): MotionSpatialInterpolation {
  const mode = MODES.has(value.mode) ? value.mode : "linear";
  if (mode === "linear") return linearSpatial();
  const incoming = normalizeHandle(value.in); const outgoing = normalizeHandle(value.out);
  if (mode === "smooth" && !collinearOpposite(incoming, outgoing)) throw new Error("Smooth spatial handles must be collinear and opposite.");
  return { mode, in: incoming, out: outgoing };
}

function readSpatial(value: unknown): MotionSpatialInterpolation | null {
  const item = record(value); const incoming = record(item?.in); const outgoing = record(item?.out);
  return item && MODES.has(item.mode as MotionSpatialTangentMode) && incoming && outgoing
    ? { mode: item.mode as MotionSpatialTangentMode, in: { x: Number(incoming.x), y: Number(incoming.y) }, out: { x: Number(outgoing.x), y: Number(outgoing.y) } } : null;
}

function spatialError(value: unknown): string | null {
  const spatial = readSpatial(value);
  if (!spatial) return "must declare a supported mode plus finite in/out handles";
  try { normalizeSpatial(spatial); return null; } catch (error) { return error instanceof Error ? error.message : "is invalid"; }
}

function linearSpatial(): MotionSpatialInterpolation { return { mode: "linear", in: { ...ZERO }, out: { ...ZERO } }; }
function normalizeHandle(value: MotionSpatialHandle): MotionSpatialHandle { assertCoordinate(value.x, "handle x"); assertCoordinate(value.y, "handle y"); return { x: value.x, y: value.y }; }
function collinearOpposite(a: MotionSpatialHandle, b: MotionSpatialHandle): boolean { return Math.abs(a.x * b.y - a.y * b.x) < 0.001 && a.x * b.x + a.y * b.y <= 0.001; }
function add(point: { x: number; y: number }, handle: MotionSpatialHandle): MotionSpatialHandle { return { x: point.x + handle.x, y: point.y + handle.y }; }

/**
 * True when a segment's control polygon collapses onto its two anchors, i.e.
 * the outgoing handle of `from` and the incoming handle of `to` are both zero.
 * `linear` tangent mode always normalises to zero handles, and `auto` resolves
 * to zero on a flat neighbourhood, so this is the common authored case.
 *
 * Such a segment is geometrically the straight chord, but its cubic
 * parameterisation is degenerate and must not be used as a clock. With p1 = p0
 * and p2 = p3 the Bernstein form reduces to
 *
 *   P(t) = u³·p0 + 3u²t·p0 + 3ut²·p3 + t³·p3        (u = 1 − t)
 *        = p0·u²(u + 3t)      + p3·t²(3u + t)
 *        = p0·(1 − 3t² + 2t³) + p3·(3t² − 2t³)
 *
 * so the point advances by smoothstep(t) = 3t² − 2t³ rather than by t. Feeding
 * the already-eased progress into that cubic therefore composed the authored
 * easing with an unrequested ease-in-out: authored `linear` rendered as
 * smoothstep, authored `ease-in` (t²) rendered as smoothstep(t²), and so on.
 * smoothstep(t) = t only at t = 0, 0.5 and 1, which is why a midpoint-only
 * assertion never observed it.
 *
 * Blast radius before the fix: every layer keyed on both `transform.x` and
 * `transform.y` (the most common authored move) plus every tracked/stabilized
 * layer, whose compiled lanes are aligned linear-easing pairs with no handles.
 */
function straightSegment(from: MotionSpatialPathPoint, to: MotionSpatialPathPoint): boolean {
  return from.spatial.out.x === 0 && from.spatial.out.y === 0 && to.spatial.in.x === 0 && to.spatial.in.y === 0;
}

/**
 * Straight-chord sample at eased progress `t`.
 *
 * Uses exactly the `a + (b − a)·t` form `interpolateNumber` applies to a single
 * numeric lane, so a paired X/Y move is bit-identical to the same move authored
 * on one lane only, and round coordinates stay round (t = 0.25 of 0 → 1000 is
 * 250, not 249.999…). Multiply/add only: no iteration, no transcendental, no
 * approximation entering hashed render output.
 *
 * This is also the exact answer under arc-length timing, not merely a shortcut
 * around it: on a straight forward traversal, distance along the curve is
 * distance along the chord, so "t of the way by distance" IS `a + (b - a)·t`.
 * The equivalent statement for a genuinely curved segment has no closed form, so
 * `arcLengthParameter` solves it numerically — the reason to keep every segment
 * that can stay on this path on this path.
 */
function linearPoint(from: MotionSpatialPathPoint, to: MotionSpatialPathPoint, t: number): MotionSpatialHandle {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/**
 * Curved segments only. Position at Bézier parameter `s` — which callers get
 * from `arcLengthParameter`, so it is a distance fraction re-expressed as a
 * curve parameter, not the authored progress itself.
 *
 * Bernstein form, evaluated with plain multiplication. The `**` operator it used
 * to use is *implementation-approximated* by ECMA-262 rather than correctly
 * rounded, and `u ** 3 !== u * u * u` for roughly a quarter of all doubles in
 * V8, so it was a cross-engine hash hazard sitting in hashed render output. The
 * squared terms are unaffected either way (`u ** 2 === u * u` always, since a
 * correctly rounded square is a single rounding), so only the two cubed terms
 * move, by at most one ulp.
 */
function cubicPoint(p0: MotionSpatialHandle, p1: MotionSpatialHandle, p2: MotionSpatialHandle, p3: MotionSpatialHandle, s: number): MotionSpatialHandle {
  const u = 1 - s;
  const uu = u * u;
  const ss = s * s;
  const w0 = uu * u;
  const w1 = 3 * uu * s;
  const w2 = 3 * u * ss;
  const w3 = ss * s;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}
function cloneFrames(frames: MotionKeyframe[] | undefined): MotionKeyframe[] { return (frames ?? []).map(cloneMotionKeyframe); }
function sortFrames(frames: MotionKeyframe[]): void { frames.sort((a, b) => a.atMs - b.atMs); }
function withPositionFrames(layer: MotionLayer, x: MotionKeyframe[], y: MotionKeyframe[]): MotionLayer { const keyframes = { ...(layer.keyframes ?? {}) }; if (x.length) keyframes["transform.x"] = x; else delete keyframes["transform.x"]; if (y.length) keyframes["transform.y"] = y; else delete keyframes["transform.y"]; if (Object.keys(keyframes).length) return { ...layer, keyframes }; const { keyframes: _discarded, ...withoutKeyframes } = layer; return withoutKeyframes; }
function changedPaths(layerId: string, atMs: number): string[] { return [`/layers/${layerId}/keyframes/transform.x/${atMs}`, `/layers/${layerId}/keyframes/transform.y/${atMs}`]; }
function assertEditableLayer(layer: MotionLayer): void { if (layer.locked) throw new Error(`Layer ${layer.id} is locked.`); }
function assertGloballyAlignedPositionLanes(layer: MotionLayer): void {
  const xFrames = cloneFrames(layer.keyframes?.["transform.x"]).sort((a, b) => a.atMs - b.atMs);
  const yFrames = cloneFrames(layer.keyframes?.["transform.y"]).sort((a, b) => a.atMs - b.atMs);
  if (xFrames.length !== yFrames.length) throw new Error("Spatial position requires globally aligned transform.x and transform.y keyframes.");
  const times = new Set<number>();
  for (let index = 0; index < xFrames.length; index += 1) {
    const x = xFrames[index]; const y = yFrames[index];
    if (times.has(x.atMs) || x.atMs !== y.atMs || typeof x.value !== "number" || !Number.isFinite(x.value)
      || typeof y.value !== "number" || !Number.isFinite(y.value)
      || easingToken(x.easing) !== easingToken(y.easing) || y.spatial !== undefined) {
      throw new Error("Spatial position requires globally aligned numeric X/Y timestamps and easing, with tangent metadata owned by transform.x.");
    }
    times.add(x.atMs);
  }
}
function assertTimestamp(value: number, label: string): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`); }
function assertCoordinate(value: number, label: string): void { if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) throw new Error(`${label} must be a finite number between -${MAX_COORDINATE} and ${MAX_COORDINATE}.`); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
