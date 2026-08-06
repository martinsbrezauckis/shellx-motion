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
 * METRIC — deliberately the same one an verifier would reach for
 * -------------------------------------------------------------
 * ffmpeg's `freezedetect` filter is what anyone checking this claim will run, so this module
 * re-implements its metric rather than inventing a private one:
 *
 *   mafd = SAD(current, reference) over the Y, Cb and Cr planes / sample count / 256
 *
 * and a frame counts as "still" when `mafd <= noiseThreshold`. Crucially the comparison is against
 * the REFERENCE frame (the first frame of the current still run), not against the immediately
 * previous frame — exactly as `vf_freezedetect.c` does — so a slow drift accumulates and correctly
 * breaks the run instead of hiding under a per-frame threshold forever. When a frame differs, it
 * becomes the new reference. Defaults (`noiseThreshold` 0.003, `minFrozenMs` 300) match the
 * `freezedetect=n=0.003:d=0.3` invocation used in the regression that motivated this work, so a receipt
 * number can be checked against ffmpeg directly.
 *
 * Two deliberate differences from ffmpeg, both in the direction of MORE truth:
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
 * Memory is bounded at two frames' worth of planes regardless of sequence length.
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
  minFrozenMs: 300,
  warnFrozenRatio: 0.25,
  warnLongestFrozenMs: 2000,
  maxReportedRanges: 8
};

export function resolveMotionDensityPolicy(policy: MotionDensityPolicy = {}): ResolvedMotionDensityPolicy {
  return {
    noiseThreshold: finitePositiveOr(policy.noiseThreshold, MOTION_DENSITY_POLICY_DEFAULTS.noiseThreshold, true),
    minFrozenMs: finitePositiveOr(policy.minFrozenMs, MOTION_DENSITY_POLICY_DEFAULTS.minFrozenMs, true),
    warnFrozenRatio: finitePositiveOr(policy.warnFrozenRatio, MOTION_DENSITY_POLICY_DEFAULTS.warnFrozenRatio, true),
    warnLongestFrozenMs: finitePositiveOr(policy.warnLongestFrozenMs, MOTION_DENSITY_POLICY_DEFAULTS.warnLongestFrozenMs, true),
    maxReportedRanges: Math.max(1, Math.floor(finitePositiveOr(policy.maxReportedRanges, MOTION_DENSITY_POLICY_DEFAULTS.maxReportedRanges, false)))
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
  let referenceAtMs = 0;
  let frameCount = 0;
  let comparisons = 0;
  let stillComparisons = 0;
  let differenceTotal = 0;
  let maxDifference = 0;
  let firstAtMs = 0;
  let lastAtMs = 0;
  let failure: string | null = null;
  const runs: Array<{ startMs: number; endMs: number }> = [];

  return {
    observe(frame, atMs) {
      if (failure) return;
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
        referenceAtMs = atMs;
        firstAtMs = atMs;
        lastAtMs = atMs;
        frameCount = 1;
        return;
      }
      frameCount += 1;
      lastAtMs = atMs;
      const difference = meanAbsoluteFrameDifference(planes, reference);
      comparisons += 1;
      differenceTotal += difference;
      if (difference > maxDifference) maxDifference = difference;
      if (difference <= resolved.noiseThreshold) {
        stillComparisons += 1;
        return;
      }
      // The picture changed: close the run that started at the reference frame, then make this frame
      // the new reference by swapping the two plane sets (no reallocation).
      if (atMs > referenceAtMs) runs.push({ startMs: referenceAtMs, endMs: atMs });
      scratch = reference;
      reference = planes;
      referenceAtMs = atMs;
    },
    fail(reason) {
      if (!failure) failure = reason;
    },
    finish({ durationMs, coverage }) {
      if (failure) return { status: "unavailable", reason: failure };
      if (frameCount === 0) return { status: "unavailable", reason: "No frames were analyzed." };
      const measurement: MotionDensityMeasurement = {
        status: "analyzed",
        frameCount,
        comparisons,
        stillComparisons,
        sampleIntervalMs: frameCount > 1 ? roundMotionValue((lastAtMs - firstAtMs) / (frameCount - 1), 3) : 0,
        durationMs: Math.round(durationMs),
        meanFrameDifference: comparisons > 0 ? roundMotionValue(differenceTotal / comparisons) : 0,
        maxFrameDifference: roundMotionValue(maxDifference),
        policy: resolved
      };
      if (coverage === "sampled") {
        return {
          ...measurement,
          coverage: "sampled",
          stillIntervalRatio: comparisons > 0 ? roundMotionValue(stillComparisons / comparisons) : 0
        };
      }

      const closed = [...runs];
      // The final run stays open to the end of the piece: the picture really is still from the last
      // change through to the end of the video.
      const finalEndMs = Math.max(referenceAtMs, durationMs);
      if (finalEndMs > referenceAtMs) closed.push({ startMs: referenceAtMs, endMs: finalEndMs });
      const frozen = closed
        .map((run) => ({ startMs: Math.round(run.startMs), endMs: Math.round(run.endMs), durationMs: Math.round(run.endMs - run.startMs) }))
        .filter((run) => run.durationMs >= resolved.minFrozenMs);
      const frozenMs = frozen.reduce((total, run) => total + run.durationMs, 0);
      const longestFrozenMs = frozen.reduce((longest, run) => Math.max(longest, run.durationMs), 0);
      const spans = mergeContiguousRuns(frozen);
      const longestFrozenSpanMs = spans.reduce((longest, span) => Math.max(longest, span.durationMs), 0);
      // Longest first so the cap keeps the spans an author most needs to see; ties broken by start
      // time so the ordering is total and machine-stable rather than dependent on sort stability.
      const ordered = [...spans].sort((a, b) => (b.durationMs - a.durationMs) || (a.startMs - b.startMs));
      const reported = ordered.slice(0, resolved.maxReportedRanges).sort((a, b) => a.startMs - b.startMs);
      return {
        ...measurement,
        coverage: "complete",
        frozenMs,
        frozenRatio: roundMotionValue(frozenMs / Math.max(1, Math.round(durationMs))),
        longestFrozenMs,
        longestFrozenSpanMs,
        frozenRunCount: frozen.length,
        frozenRanges: reported,
        omittedRanges: spans.length - reported.length
      };
    }
  };
}

/**
 * Merge freezes that end exactly where the next begins into one span, counting the holds. Runs
 * arrive in timeline order, so a single forward pass suffices.
 */
function mergeContiguousRuns(runs: Array<{ startMs: number; endMs: number; durationMs: number }>): MotionFrozenRange[] {
  const spans: MotionFrozenRange[] = [];
  for (const run of runs) {
    const previous = spans[spans.length - 1];
    if (previous && previous.endMs === run.startMs) {
      previous.endMs = run.endMs;
      previous.durationMs = previous.endMs - previous.startMs;
      previous.holds += 1;
      continue;
    }
    spans.push({ startMs: run.startMs, endMs: run.endMs, durationMs: run.durationMs, holds: 1 });
  }
  return spans;
}
