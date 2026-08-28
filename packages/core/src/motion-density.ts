/**
 * motion-density.ts — measure how much a rendered piece actually MOVES, and say so out loud.
 *
 * ROLE
 * ----
 * A motion package can be structurally perfect — right frame count, right duration, right size,
 * renders clean, `package.validate` says valid — and still be visually frozen for most of its
 * runtime. Every signal an author (especially an agent author) can see says "success", so the
 * defect is invisible: an external agent asked for a "visually dense, continuously moving" 15s
 * piece and shipped one that was static for ~92% of its duration across three rounds, each round
 * worse than the last, because nothing in the engine ever told it.
 *
 * This module is the missing measurement. It consumes decoded frames, reports how much of the
 * piece is frozen and WHERE, and hands back warning strings. It never fails anything: a static
 * title card is legitimate output. The defect being fixed is SILENCE, not static-ness.
 *
 * METRIC — verifier-comparable without being blind to small moving regions
 * ------------------------------------------------------------------------
 * The first signal re-implements ffmpeg `freezedetect`:
 *
 *   mafd = SAD(current, reference) over the Y, Cb and Cr planes / sample count / 256
 *
 * Whole-frame MAFD alone calls thin chart lines, captions and path reveals frozen. The second signal
 * counts full-resolution luma pixels that differ from the adjacent frame by more than
 * `changedPixelDelta`. A comparison is still only when reference-frame MAFD AND adjacent-frame
 * changed-pixel fraction are quiet, catching both slow drift and small moving regions.
 *
 * Other deliberate differences from ffmpeg:
 *   - We measure the renderer's own frames, before encoding. That is the authoritative picture:
 *     codec quantisation can only add noise to a freeze, never remove one.
 *   - Chroma is included (subsampled 2x2, as yuv420p does). A pure hue change at constant luma is
 *     real motion, and a luma-only metric would report it as frozen — an unbacked claim.
 * Colour conversion uses BT.709 full range, matching the rest of this package's luma maths. Against
 * a limited-range yuv420p encode the absolute mafd scale differs by ~15%; that is far below any
 * threshold that separates "frozen" from "moving", and freeze boundaries are unaffected.
 *
 * COST
 * ----
 * The accumulator takes ALREADY-DECODED frames. Its intended caller is
 * `inspectFrameSequence` in quality.ts, which decodes every frame anyway — so measuring motion adds
 * one arithmetic pass over pixels the renderer already produced, and no second decode of anything.
 * Memory is bounded at two frames' planes plus one previous-frame luma plane.
 *
 * DETERMINISM
 * -----------
 * Every accumulation is integer; exactly one division produces each ratio; every number that can
 * reach a receipt or an agent-visible surface is rounded through {@link roundMotionValue}. No
 * locale-sensitive formatting, no `toLocaleString`, no float text interpolation without rounding.
 * The same frames produce the same verdict on any machine.
 *
 * PRIMARY CALLERS
 * ---------------
 *   - `packages/core/src/quality.ts` (`inspectFrameSequence`) — full render, every frame.
 *   - `packages/debug-api/src/domains/render-preview-advanced.ts` (`motion.preview.strip`) — the
 *     cheap pre-render probe, sampled frames.
 */

import {
  allocatePlanes,
  changedLumaPixelRatio,
  fillPlanesFromRgba,
  meanAbsoluteFrameDifference,
  type MotionDensityFrame,
  type MotionPlanes
} from "./motion-density-planes";

// Re-exported so callers have a single import site for the whole measurement surface.
export type { MotionDensityFrame } from "./motion-density-planes";

/** Tunables for the freeze measurement and for when it is worth warning about. */
export interface MotionDensityPolicy {
  /** mafd (0..1) at or below which a frame counts as unchanged. Default 0.003. */
  noiseThreshold?: number;
  /** Luma byte delta above which a full-resolution pixel counts as changed. Default 2. */
  changedPixelDelta?: number;
  /** Changed-pixel fraction at or below which an interval is area-quiet. Default 0.001. */
  changedPixelRatio?: number;
  /** Shortest still run reported as a frozen range, in ms. Default 300. */
  minFrozenMs?: number;
  /** Frozen fraction (0..1) at or above which a warning is emitted. Default 0.25. */
  warnFrozenRatio?: number;
  /** Longest single frozen run (ms) at or above which a warning is emitted. Default 2000. */
  warnLongestFrozenMs?: number;
  /** Maximum frozen ranges listed in the report and warning text. Default 8. */
  maxReportedRanges?: number;
}

/** Resolved policy — every field present, as echoed back on an analyzed report. */
export type ResolvedMotionDensityPolicy = Required<MotionDensityPolicy>;

/**
 * A stretch of the timeline the picture did not visibly move through.
 *
 * `holds` is why this is a *span* and not simply a run. A long freeze is routinely broken by a
 * single frame whose accumulated drift just crosses the noise floor — one sub-perceptual step, then
 * the picture stops again. FFmpeg reports each of those as a separate freeze; one measured render
 * produced five back-to-back freezes between 1.03s and 9.80s. Listing them separately is
 * faithful but unreadable, so back-to-back freezes are presented as one span carrying the number of
 * holds inside it. `startMs`/`endMs` remain exact; `holds > 1` is the honest note that the picture
 * did take a barely-visible step somewhere inside.
 */
export interface MotionFrozenRange {
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Uninterrupted freezes merged into this span. 1 means a single clean freeze. */
  holds: number;
}

/**
 * Whether the measurement saw every rendered frame ("complete") or a sparse sample of the timeline
 * ("sampled"). A sampled measurement cannot claim a frozen percentage — two identical samples 3s
 * apart do not prove the 3s between them were still — so its report and warnings talk about
 * sampled intervals instead. Keeping that distinction in the type is what stops a cheap probe from
 * being read as a full-render verdict.
 */
export type MotionDensityCoverage = "complete" | "sampled";

interface MotionDensityMeasurement {
  status: "analyzed";
  /** Frames actually compared. */
  frameCount: number;
  /** Frame-to-reference comparisons made (frameCount - 1, or 0 for a single frame). */
  comparisons: number;
  /** Comparisons whose mafd was within the noise threshold. */
  stillComparisons: number;
  /** Nominal ms between analyzed frames. */
  sampleIntervalMs: number;
  durationMs: number;
  /** Mean and peak mafd across all comparisons, rounded to 6dp. */
  meanFrameDifference: number;
  maxFrameDifference: number;
  /** Mean and peak fraction of materially changed full-resolution luma pixels. */
  meanChangedPixelRatio: number;
  maxChangedPixelRatio: number;
  policy: ResolvedMotionDensityPolicy;
}

/** Every frame was compared, so the timeline can be spoken about in seconds and percentages. */
export interface MotionDensityComplete extends MotionDensityMeasurement {
  coverage: "complete";
  /** Total ms inside frozen runs of at least `minFrozenMs`. */
  frozenMs: number;
  /** frozenMs / durationMs, rounded to 6dp. */
  frozenRatio: number;
  /** Longest single uninterrupted freeze — directly comparable to an ffmpeg freeze_duration. */
  longestFrozenMs: number;
  /** Longest merged span of back-to-back freezes. See {@link MotionFrozenRange}. */
  longestFrozenSpanMs: number;
  /** Uninterrupted freezes counted, before merging into spans. */
  frozenRunCount: number;
  /** Frozen spans in timeline order, capped at `policy.maxReportedRanges` (longest kept). */
  frozenRanges: MotionFrozenRange[];
  /** Spans omitted from `frozenRanges` by the cap. */
  omittedRanges: number;
}

/**
 * Only a sample of the timeline was compared, so there is no frozen percentage and no frozen range
 * — and this type deliberately does not have the fields to express one. Two identical samples 0.5s
 * apart do not prove the 0.5s between them held still, and an earlier draft of this module happily
 * reported "100% frozen" for a piece that moved on every single sample precisely because it reused
 * the complete-coverage arithmetic here. What a sample CAN back is how many of the gaps it looked
 * across showed no change, which is what it reports.
 */
export interface MotionDensitySampled extends MotionDensityMeasurement {
  coverage: "sampled";
  /** stillComparisons / comparisons, rounded to 6dp. */
  stillIntervalRatio: number;
}

export type MotionDensityAnalyzed = MotionDensityComplete | MotionDensitySampled;

/**
 * Analysis could not run. Emitted instead of a zero-valued report so a reader is never handed a
 * default that reads as "fine" — the honesty rule this module exists to serve.
 */
export interface MotionDensityUnavailable {
  status: "unavailable";
  reason: string;
}

export type MotionDensityReport = MotionDensityAnalyzed | MotionDensityUnavailable;

export const MOTION_DENSITY_POLICY_DEFAULTS: ResolvedMotionDensityPolicy = {
  noiseThreshold: 0.003,
  changedPixelDelta: 2,
  changedPixelRatio: 0.001,
  minFrozenMs: 300,
  warnFrozenRatio: 0.25,
  warnLongestFrozenMs: 2000,
  maxReportedRanges: 8
};

/** Hard ceiling for retained range evidence, even when an untrusted caller requests more. */
export const MAX_MOTION_DENSITY_REPORTED_RANGES = 64;

export function resolveMotionDensityPolicy(policy: MotionDensityPolicy = {}): ResolvedMotionDensityPolicy {
  return {
    noiseThreshold: finitePositiveOr(policy.noiseThreshold, MOTION_DENSITY_POLICY_DEFAULTS.noiseThreshold, true),
    changedPixelDelta: Math.min(255, finitePositiveOr(policy.changedPixelDelta, MOTION_DENSITY_POLICY_DEFAULTS.changedPixelDelta, true)),
    changedPixelRatio: Math.min(1, finitePositiveOr(policy.changedPixelRatio, MOTION_DENSITY_POLICY_DEFAULTS.changedPixelRatio, true)),
    minFrozenMs: finitePositiveOr(policy.minFrozenMs, MOTION_DENSITY_POLICY_DEFAULTS.minFrozenMs, true),
    warnFrozenRatio: finitePositiveOr(policy.warnFrozenRatio, MOTION_DENSITY_POLICY_DEFAULTS.warnFrozenRatio, true),
    warnLongestFrozenMs: finitePositiveOr(policy.warnLongestFrozenMs, MOTION_DENSITY_POLICY_DEFAULTS.warnLongestFrozenMs, true),
    maxReportedRanges: Math.min(
      MAX_MOTION_DENSITY_REPORTED_RANGES,
      Math.max(1, Math.floor(finitePositiveOr(policy.maxReportedRanges, MOTION_DENSITY_POLICY_DEFAULTS.maxReportedRanges, false)))
    )
  };
}

function finitePositiveOr(value: number | undefined, fallback: number, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0 || (!allowZero && value <= 0)) return fallback;
  return value;
}

/**
 * Round a measured value to a fixed number of decimals so the same frames yield the same digits
 * everywhere. Ratios and mafd values are 6dp; anything coarser hides real differences between a
 * frozen and a barely-moving piece.
 */
export function roundMotionValue(value: number, decimals = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Streaming freeze measurement. Holds at most two frames' planes, whatever the sequence length. */
export interface MotionDensityAccumulator {
  /** Feed one decoded frame at its timeline position. Frames must arrive in timeline order. */
  observe(frame: MotionDensityFrame, atMs: number): void;
  /** Abandon the measurement with an honest reason (e.g. a frame that could not be decoded). */
  fail(reason: string): void;
  /** Close the measurement. `durationMs` bounds the final open run. */
  finish(input: { durationMs: number; coverage: MotionDensityCoverage }): MotionDensityReport;
}

export function createMotionDensityAccumulator(policy: MotionDensityPolicy = {}): MotionDensityAccumulator {
  const resolved = resolveMotionDensityPolicy(policy);
  // Two plane sets, allocated once and ping-ponged: `scratch` receives the incoming frame, and on a
  // change the two swap so the new reference costs no allocation. Over a 450-frame render this
  // avoids ~1.3 GB of short-lived typed-array garbage.
  let reference: MotionPlanes | null = null;
  let scratch: MotionPlanes | null = null;
  let previousLuma: Uint8Array | null = null;
  let referenceAtMs = 0;
  let frameCount = 0;
  let comparisons = 0;
  let stillComparisons = 0;
  let differenceTotal = 0;
  let maxDifference = 0;
  let changedPixelRatioTotal = 0;
  let maxChangedPixelRatio = 0;
  let firstAtMs = 0;
  let lastAtMs = 0;
  let failure: string | null = null;
  // A complete render may have one still run per frame. Keep only the current mergeable span and
  // the fixed-cap best evidence instead of an O(frameCount) run list.
  let activeSpan: MotionFrozenRange | undefined;
  const reportedSpans: MotionFrozenRange[] = [];
  let frozenMs = 0;
  let longestFrozenMs = 0;
  let longestFrozenSpanMs = 0;
  let frozenRunCount = 0;
  let frozenSpanCount = 0;
  let finished: MotionDensityReport | undefined;

  const retainCompletedSpan = () => {
    if (!activeSpan) return;
    frozenSpanCount += 1;
    longestFrozenSpanMs = Math.max(longestFrozenSpanMs, activeSpan.durationMs);
    insertReportedSpan(reportedSpans, activeSpan, resolved.maxReportedRanges);
    activeSpan = undefined;
  };
  const observeClosedRun = (startMs: number, endMs: number) => {
    const durationMs = Math.round(endMs - startMs);
    if (durationMs < resolved.minFrozenMs) {
      retainCompletedSpan();
      return;
    }
    const run = { startMs: Math.round(startMs), endMs: Math.round(endMs), durationMs };
    frozenMs += run.durationMs;
    longestFrozenMs = Math.max(longestFrozenMs, run.durationMs);
    frozenRunCount += 1;
    if (activeSpan?.endMs === run.startMs) {
      activeSpan.endMs = run.endMs;
      activeSpan.durationMs = activeSpan.endMs - activeSpan.startMs;
      activeSpan.holds += 1;
      return;
    }
    retainCompletedSpan();
    activeSpan = { ...run, holds: 1 };
  };

  return {
    observe(frame, atMs) {
      if (failure || finished) return;
      if (reference && (reference.width !== frame.width || reference.height !== frame.height)) {
        failure = `Frame size changed mid-sequence (${reference.width}x${reference.height} -> ${frame.width}x${frame.height}).`;
        return;
      }
      let planes: MotionPlanes;
      try {
        const target = reference ? scratch : null;
        planes = fillPlanesFromRgba(frame, target);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        return;
      }
      if (!reference) {
        reference = planes;
        scratch = allocatePlanes(frame.width, frame.height);
        previousLuma = planes.y.slice();
        referenceAtMs = atMs;
        firstAtMs = atMs;
        lastAtMs = atMs;
        frameCount = 1;
        return;
      }
      frameCount += 1;
      lastAtMs = atMs;
      const difference = meanAbsoluteFrameDifference(planes, reference);
      const changedPixelRatio = changedLumaPixelRatio(planes.y, previousLuma!, resolved.changedPixelDelta);
      previousLuma!.set(planes.y);
      comparisons += 1;
      differenceTotal += difference;
      if (difference > maxDifference) maxDifference = difference;
      changedPixelRatioTotal += changedPixelRatio;
      if (changedPixelRatio > maxChangedPixelRatio) maxChangedPixelRatio = changedPixelRatio;
      if (difference <= resolved.noiseThreshold && changedPixelRatio <= resolved.changedPixelRatio) {
        stillComparisons += 1;
        return;
      }
      // The picture changed: close the run that started at the reference frame, then make this frame
      // the new reference by swapping the two plane sets (no reallocation).
      if (atMs > referenceAtMs) observeClosedRun(referenceAtMs, atMs);
      scratch = reference;
      reference = planes;
      referenceAtMs = atMs;
    },
    fail(reason) {
      if (!finished && !failure) failure = reason;
    },
    finish({ durationMs, coverage }) {
      if (finished) return finished;
      if (failure) return (finished = { status: "unavailable", reason: failure });
      if (frameCount === 0) return (finished = { status: "unavailable", reason: "No frames were analyzed." });
      const measurement: MotionDensityMeasurement = {
        status: "analyzed",
        frameCount,
        comparisons,
        stillComparisons,
        sampleIntervalMs: frameCount > 1 ? roundMotionValue((lastAtMs - firstAtMs) / (frameCount - 1), 3) : 0,
        durationMs: Math.round(durationMs),
        meanFrameDifference: comparisons > 0 ? roundMotionValue(differenceTotal / comparisons) : 0,
        maxFrameDifference: roundMotionValue(maxDifference),
        meanChangedPixelRatio: comparisons > 0 ? roundMotionValue(changedPixelRatioTotal / comparisons) : 0,
        maxChangedPixelRatio: roundMotionValue(maxChangedPixelRatio),
        policy: resolved
      };
      if (coverage === "sampled") {
        return (finished = {
          ...measurement,
          coverage: "sampled",
          stillIntervalRatio: comparisons > 0 ? roundMotionValue(stillComparisons / comparisons) : 0
        });
      }

      // The final run stays open to the end of the piece: the picture really is still from the last
      // change through to the end of the video.
      const finalEndMs = Math.max(referenceAtMs, durationMs);
      if (finalEndMs > referenceAtMs) observeClosedRun(referenceAtMs, finalEndMs);
      retainCompletedSpan();
      const reported = [...reportedSpans].sort((a, b) => a.startMs - b.startMs);
      return (finished = {
        ...measurement,
        coverage: "complete",
        frozenMs,
        frozenRatio: roundMotionValue(frozenMs / Math.max(1, Math.round(durationMs))),
        longestFrozenMs,
        longestFrozenSpanMs,
        frozenRunCount,
        frozenRanges: reported,
        omittedRanges: frozenSpanCount - reported.length
      });
    }
  };
}

/** Keep the longest spans with a stable timestamp tie break, in constant bounded state. */
function insertReportedSpan(spans: MotionFrozenRange[], span: MotionFrozenRange, cap: number): void {
  spans.push({ ...span });
  spans.sort((a, b) => (b.durationMs - a.durationMs) || (a.startMs - b.startMs));
  if (spans.length > cap) spans.pop();
}
