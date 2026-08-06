/**
 * motion-density-warnings.ts — the author-facing half of the freeze measurement.
 *
 * Split out of motion-density.ts to keep each module inside the strict size cap. This is the only
 * place a measurement turns into English, so the wording an author reads on a receipt can be
 * reviewed in one file.
 */
import {
  roundMotionValue,
  type MotionDensityComplete,
  type MotionDensityReport,
  type MotionFrozenRange
} from "./motion-density";

/**
 * Turn a report into the warning strings that ride the ordinary receipt `warnings` array.
 *
 * Rules, in order — at most one freeze warning is emitted so a receipt never says the same thing
 * twice:
 *   1. complete coverage, frozen fraction at/above `warnFrozenRatio` — the piece is substantially
 *      static. Carries the percentage, the total, and the frozen ranges.
 *   2. complete coverage, a single run at/above `warnLongestFrozenMs` — the piece moves overall but
 *      stops dead somewhere. (ffmpeg's own default notion of a freeze worth reporting is 2s.)
 *   3. sampled coverage, every sampled interval unchanged — the cheap probe saw no movement at all.
 *      Phrased as sampled evidence, because that is all it is.
 *   4. `status: "unavailable"` — say analysis did not run, and why.
 *
 * These are WARNINGS. A deliberately static title card is legitimate output; the author is told
 * what was measured and decides. Nothing here fails a render.
 */
export function motionDensityWarnings(report: MotionDensityReport): string[] {
  if (report.status === "unavailable") {
    return [`Motion density was not measured (${report.reason}) — this render carries no evidence about whether it moves.`];
  }
  if (report.coverage === "sampled") {
    if (report.comparisons > 0 && report.stillIntervalRatio >= report.policy.warnFrozenRatio) {
      return [
        `Preview strip saw no visible change across ${report.stillComparisons} of ${report.comparisons} sampled intervals`
        + ` (${report.frameCount} frames every ${formatSeconds(report.sampleIntervalMs)}s; mean absolute frame difference`
        + ` <= ${formatDifference(report.policy.noiseThreshold)} against the first unchanged frame).`
        + " This is sampled evidence, not a full-render measurement: raise frameCount or render to confirm."
      ];
    }
    return [];
  }
  if (report.frozenRatio >= report.policy.warnFrozenRatio) {
    return [
      `Rendered motion is static for ${formatPercent(report.frozenRatio)}% of its duration`
      + ` (${formatSeconds(report.frozenMs)}s of ${formatSeconds(report.durationMs)}s across ${report.frozenRunCount}`
      + ` frozen ${report.frozenRunCount === 1 ? "run" : "runs"}, longest ${formatSeconds(report.longestFrozenMs)}s).`
      + ` ${formatRanges(report)} Verify this is intentional;`
      + ` measured as mean absolute frame difference <= ${formatDifference(report.policy.noiseThreshold)} over runs of at least ${formatSeconds(report.policy.minFrozenMs)}s.`
    ];
  }
  if (report.longestFrozenSpanMs >= report.policy.warnLongestFrozenMs) {
    const longest = report.frozenRanges.reduce<MotionFrozenRange | null>(
      (best, range) => (best === null || range.durationMs > best.durationMs ? range : best),
      null
    );
    return [
      `Rendered motion stops for ${formatSeconds(report.longestFrozenSpanMs)}s`
      + (longest ? ` at ${formatSeconds(longest.startMs)}s-${formatSeconds(longest.endMs)}s` : "")
      + ` (${formatPercent(report.frozenRatio)}% of the piece is static overall). Verify this hold is intentional.`
    ];
  }
  return [];
}

function formatRanges(report: MotionDensityComplete): string {
  if (report.frozenRanges.length === 0) return "";
  const ranges = report.frozenRanges
    .map((range) => `${formatSeconds(range.startMs)}-${formatSeconds(range.endMs)}${range.holds > 1 ? ` (${range.holds} holds)` : ""}`)
    .join(", ");
  const omitted = report.omittedRanges > 0 ? ` (+${report.omittedRanges} shorter)` : "";
  return `Frozen (s): ${ranges}${omitted}.`;
}

/**
 * Fixed-decimal formatting. `Number.prototype.toFixed` is locale-independent by specification (it
 * always emits `.` and ASCII digits), unlike `toLocaleString`/`Intl` — so these numbers are safe to
 * write into a receipt on any machine.
 */
function formatSeconds(ms: number): string {
  return (Math.round(ms) / 1000).toFixed(3);
}

function formatPercent(ratio: number): string {
  return (Math.round(ratio * 1000) / 10).toFixed(1);
}

function formatDifference(value: number): string {
  return roundMotionValue(value).toFixed(6);
}
