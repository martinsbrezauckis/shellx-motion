import { describe, expect, it } from "vitest";
import {
  createMotionDensityAccumulator,
  MAX_MOTION_DENSITY_REPORTED_RANGES,
  resolveMotionDensityPolicy,
  roundMotionValue,
  type MotionDensityComplete,
  type MotionDensityFrame,
  type MotionDensityReport,
  type MotionDensitySampled
} from "./motion-density";
import { motionDensityWarnings } from "./motion-density-warnings";

/**
 * Build a solid-colour RGBA frame. Small frames keep the tests fast; the metric is a per-sample
 * mean, so it behaves identically at 8x8 and at 1920x1080.
 */
function solidFrame(rgb: [number, number, number], alpha = 255, size = 8): MotionDensityFrame {
  const rgba = new Uint8Array(size * size * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = rgb[0];
    rgba[offset + 1] = rgb[1];
    rgba[offset + 2] = rgb[2];
    rgba[offset + 3] = alpha;
  }
  return { width: size, height: size, rgba };
}

/** A frame where a single pixel differs — the smallest possible real change. */
function onePixelFrame(base: [number, number, number], pixel: [number, number, number], size = 8): MotionDensityFrame {
  const frame = solidFrame(base, 255, size);
  frame.rgba[0] = pixel[0];
  frame.rgba[1] = pixel[1];
  frame.rgba[2] = pixel[2];
  return frame;
}

function thinLineFrame(size = 128, changedPixels = 20): MotionDensityFrame {
  const frame = solidFrame([0, 0, 0], 255, size);
  for (let index = 0; index < changedPixels; index += 1) {
    const offset = index * 4;
    frame.rgba[offset] = 255;
    frame.rgba[offset + 1] = 255;
    frame.rgba[offset + 2] = 255;
  }
  return frame;
}

/** Feed frames at a fixed cadence and close the measurement. */
function analyze(
  frames: MotionDensityFrame[],
  options: {
    fps?: number;
    durationMs?: number;
    coverage?: "complete" | "sampled";
    policy?: Parameters<typeof createMotionDensityAccumulator>[0];
  } = {}
): MotionDensityReport {
  const fps = options.fps ?? 30;
  const accumulator = createMotionDensityAccumulator(options.policy);
  frames.forEach((frame, index) => accumulator.observe(frame, (index * 1000) / fps));
  return accumulator.finish({
    durationMs: options.durationMs ?? (frames.length * 1000) / fps,
    coverage: options.coverage ?? "complete"
  });
}

function complete(report: MotionDensityReport): MotionDensityComplete {
  if (report.status !== "analyzed" || report.coverage !== "complete") {
    throw new Error(`expected a complete measurement, received ${JSON.stringify(report)}`);
  }
  return report;
}

function sampled(report: MotionDensityReport): MotionDensitySampled {
  if (report.status !== "analyzed" || report.coverage !== "sampled") {
    throw new Error(`expected a sampled measurement, received ${JSON.stringify(report)}`);
  }
  return report;
}

describe("motion density measurement", () => {
  it("reports a sequence that never changes as fully frozen", () => {
    const report = complete(analyze(Array.from({ length: 60 }, () => solidFrame([20, 90, 200])), { durationMs: 2000 }));

    expect(report.comparisons).toBe(59);
    expect(report.stillComparisons).toBe(59);
    expect(report.frozenRatio).toBe(1);
    expect(report.frozenRanges).toEqual([{ startMs: 0, endMs: 2000, durationMs: 2000, holds: 1 }]);
    expect(report.maxFrameDifference).toBe(0);
  });

  it("reports a sequence that changes every frame as not frozen at all", () => {
    const frames = Array.from({ length: 60 }, (_, index) => solidFrame([index * 4, 255 - index * 4, 120]));
    const report = complete(analyze(frames, { durationMs: 2000 }));

    expect(report.stillComparisons).toBe(0);
    expect(report.frozenMs).toBe(0);
    expect(report.frozenRatio).toBe(0);
    expect(report.frozenRanges).toEqual([]);
    expect(motionDensityWarnings(report)).toEqual([]);
  });

  it("locates the frozen stretch inside a piece that moves and then holds", () => {
    // 30 moving frames (0.000s-0.967s), then 60 identical frames (1.000s-3.000s).
    const moving = Array.from({ length: 30 }, (_, index) => solidFrame([index * 8, 40, 60]));
    const held = Array.from({ length: 60 }, () => solidFrame([255, 40, 60]));
    const report = complete(analyze([...moving, ...held], { durationMs: 3000 }));

    // The freeze is anchored on the first held frame (index 30, 1000ms), not on the last moving one.
    expect(report.frozenRanges).toEqual([{ startMs: 1000, endMs: 3000, durationMs: 2000, holds: 1 }]);
    expect(report.frozenMs).toBe(2000);
    expect(report.frozenRatio).toBeCloseTo(0.667, 3);
    expect(report.longestFrozenMs).toBe(2000);
  });

  it("counts a change as still only when both calibrated signals are quiet", () => {
    // One pixel of 64 changing by 255 is a mean absolute difference of about 0.0125 across the
    // planes — above the 0.003 default. The same change at a 0.05 threshold is below it.
    const frames = [solidFrame([0, 0, 0]), onePixelFrame([0, 0, 0], [255, 255, 255])];

    expect(complete(analyze(frames, { durationMs: 100 })).stillComparisons).toBe(0);
    expect(complete(analyze(frames, {
      durationMs: 100,
      policy: { noiseThreshold: 0.05, changedPixelRatio: 0.02 }
    })).stillComparisons).toBe(1);
  });

  it("recognizes thin graphic motion even when whole-frame mean difference is quiet", () => {
    const frames = [solidFrame([0, 0, 0], 255, 128), thinLineFrame()];
    const report = complete(analyze(frames, { durationMs: 100 }));

    expect(report.maxFrameDifference).toBeLessThan(report.policy.noiseThreshold);
    expect(report.maxChangedPixelRatio).toBeGreaterThan(report.policy.changedPixelRatio);
    expect(report.stillComparisons).toBe(0);
  });

  it("does not treat one changed high-resolution pixel as meaningful motion", () => {
    const frames = [solidFrame([0, 0, 0], 255, 128), onePixelFrame([0, 0, 0], [255, 255, 255], 128)];
    const report = complete(analyze(frames, { durationMs: 100 }));

    expect(report.maxFrameDifference).toBeLessThan(report.policy.noiseThreshold);
    expect(report.maxChangedPixelRatio).toBeLessThan(report.policy.changedPixelRatio);
    expect(report.stillComparisons).toBe(1);
  });

  it("measures changed pixels between adjacent frames rather than accumulating their area", () => {
    const frames = [solidFrame([0, 0, 0], 255, 128), thinLineFrame(128, 10), thinLineFrame(128, 20)];
    const report = complete(analyze(frames, { durationMs: 100 }));

    expect(report.maxFrameDifference).toBeLessThan(report.policy.noiseThreshold);
    expect(report.maxChangedPixelRatio).toBeLessThan(report.policy.changedPixelRatio);
    expect(report.stillComparisons).toBe(2);
  });

  it("measures a hue change at constant luma as real movement", () => {
    // Chroma is why this metric includes the Cb/Cr planes: these two colours have very close luma,
    // so a luma-only measurement would call a hue cycle frozen — an unbacked claim.
    const report = complete(analyze([solidFrame([0, 128, 255]), solidFrame([255, 110, 0])], { durationMs: 100 }));

    expect(report.stillComparisons).toBe(0);
    expect(report.maxFrameDifference).toBeGreaterThan(0.003);
  });

  it("compares against the run's reference frame so slow drift eventually breaks the freeze", () => {
    // Each step is 1/255 of the range — far under the noise floor per frame. Compared only against
    // the previous frame this would read as frozen forever; against the reference it breaks.
    const frames = Array.from({ length: 40 }, (_, index) => solidFrame([index, index, index]));
    const report = complete(analyze(frames, { durationMs: 1333 }));

    expect(report.stillComparisons).toBeLessThan(report.comparisons);
    expect(report.frozenRatio).toBeLessThan(1);
  });

  it("merges back-to-back freezes into one span and records how many holds it contains", () => {
    // Two 1s holds separated by a single changed frame: two runs, presented as one span.
    const first = Array.from({ length: 30 }, () => solidFrame([10, 10, 10]));
    const second = Array.from({ length: 30 }, () => solidFrame([200, 60, 10]));
    const report = complete(analyze([...first, ...second], { durationMs: 2000 }));

    expect(report.frozenRunCount).toBe(2);
    expect(report.frozenRanges).toEqual([{ startMs: 0, endMs: 2000, durationMs: 2000, holds: 2 }]);
    expect(report.longestFrozenSpanMs).toBe(2000);
  });

  it("ignores freezes shorter than the reporting minimum", () => {
    // Six-frame (200ms) holds, under the 300ms default.
    const frames: MotionDensityFrame[] = [];
    for (let block = 0; block < 10; block += 1) {
      for (let repeat = 0; repeat < 6; repeat += 1) frames.push(solidFrame([block * 25, 30, 30]));
    }
    const report = complete(analyze(frames, { durationMs: 2000 }));

    expect(report.frozenRunCount).toBe(0);
    expect(report.frozenMs).toBe(0);
  });

  it("treats transparent pixels as the black an encoder would flatten them to", () => {
    const report = complete(analyze([solidFrame([255, 255, 255], 0), solidFrame([0, 0, 0], 255)], { durationMs: 100 }));

    expect(report.stillComparisons).toBe(1);
  });

  it("says analysis did not run instead of reporting a zero that reads as fine", () => {
    const accumulator = createMotionDensityAccumulator();
    accumulator.observe(solidFrame([10, 10, 10]), 0);
    accumulator.fail("frame 000004.png could not be decoded");
    const report = accumulator.finish({ durationMs: 1000, coverage: "complete" });

    expect(report).toEqual({ status: "unavailable", reason: "frame 000004.png could not be decoded" });
    expect(motionDensityWarnings(report)).toEqual([
      "Motion density was not measured (frame 000004.png could not be decoded) — this render carries no evidence about whether it moves."
    ]);
  });

  it("marks a mid-sequence frame size change unavailable rather than measuring nonsense", () => {
    const accumulator = createMotionDensityAccumulator();
    accumulator.observe(solidFrame([10, 10, 10], 255, 8), 0);
    accumulator.observe(solidFrame([10, 10, 10], 255, 16), 33);
    const report = accumulator.finish({ durationMs: 1000, coverage: "complete" });

    expect(report.status).toBe("unavailable");
    if (report.status !== "unavailable") return;
    expect(report.reason).toContain("Frame size changed mid-sequence");
  });

  it("reports no frames as unavailable", () => {
    const report = createMotionDensityAccumulator().finish({ durationMs: 1000, coverage: "complete" });

    expect(report).toEqual({ status: "unavailable", reason: "No frames were analyzed." });
  });
});

describe("motion density sampled coverage", () => {
  it("never reports a frozen percentage or a frozen range from sparse samples", () => {
    // Regression guard. An earlier draft ran the complete-coverage run arithmetic over sampled
    // frames and reported "100% frozen, 1 span" for a strip whose every sample differed, because
    // each changed sample closed a "run" as long as the sampling gap.
    const frames = Array.from({ length: 12 }, (_, index) => solidFrame([index * 20, 40, 90]));
    const report = sampled(analyze(frames, { fps: 2.2, durationMs: 5000, coverage: "sampled" }));

    expect(report.stillComparisons).toBe(0);
    expect(report.stillIntervalRatio).toBe(0);
    expect(report).not.toHaveProperty("frozenMs");
    expect(report).not.toHaveProperty("frozenRatio");
    expect(report).not.toHaveProperty("frozenRanges");
    expect(motionDensityWarnings(report)).toEqual([]);
  });

  it("reports the fraction of sampled intervals that showed no change", () => {
    const moving = Array.from({ length: 4 }, (_, index) => solidFrame([index * 60, 40, 90]));
    const held = Array.from({ length: 8 }, () => solidFrame([180, 40, 90]));
    const report = sampled(analyze([...moving, ...held], { fps: 2.2, durationMs: 5000, coverage: "sampled" }));

    expect(report.comparisons).toBe(11);
    expect(report.stillComparisons).toBe(8);
    expect(report.stillIntervalRatio).toBeCloseTo(0.727, 3);
  });
});

describe("motion density warnings", () => {
  it("warns with the frozen percentage and the ranges when a piece is substantially static", () => {
    const moving = Array.from({ length: 15 }, (_, index) => solidFrame([index * 16, 20, 20]));
    const held = Array.from({ length: 75 }, () => solidFrame([240, 20, 20]));
    const report = analyze([...moving, ...held], { durationMs: 3000 });

    const warnings = motionDensityWarnings(report);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Rendered motion is static for 83.3% of its duration");
    expect(warnings[0]).toContain("2.500s of 3.000s");
    expect(warnings[0]).toContain("Frozen (s): 0.500-3.000");
    expect(warnings[0]).toContain("Verify this is intentional");
  });

  it("warns about a single long hold even when the piece mostly moves", () => {
    // 2.5s of movement, one 2.1s hold, then movement again: 40% frozen would not trip the ratio
    // rule at a 0.6 threshold, but a hold that long is still worth saying out loud.
    const before = Array.from({ length: 75 }, (_, index) => solidFrame([index * 3, 40, 90]));
    const held = Array.from({ length: 63 }, () => solidFrame([225, 40, 90]));
    const after = Array.from({ length: 72 }, (_, index) => solidFrame([225 - index * 3, 40, 90]));
    const report = analyze([...before, ...held, ...after], { durationMs: 7000, policy: { warnFrozenRatio: 0.6 } });

    const warnings = motionDensityWarnings(report);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Rendered motion stops for");
    expect(warnings[0]).toContain("Verify this hold is intentional");
  });

  it("stays silent for a piece that moves throughout", () => {
    const frames = Array.from({ length: 90 }, (_, index) => solidFrame([index * 2, 255 - index * 2, 128]));

    expect(motionDensityWarnings(analyze(frames, { durationMs: 3000 }))).toEqual([]);
  });

  it("labels sampled evidence as sampled and never claims a frozen percentage from it", () => {
    const report = analyze(Array.from({ length: 5 }, () => solidFrame([12, 34, 56])), {
      fps: 0.4,
      durationMs: 15000,
      coverage: "sampled"
    });

    const warnings = motionDensityWarnings(report);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Preview strip saw no visible change across 4 of 4 sampled intervals");
    expect(warnings[0]).toContain("5 frames every 2.500s");
    expect(warnings[0]).toContain("sampled evidence, not a full-render measurement");
    expect(warnings[0]).not.toContain("% of its duration");
  });

  it("stays silent on a sampled probe that saw movement throughout", () => {
    const frames = Array.from({ length: 5 }, (_, index) => solidFrame([index * 50, 20, 20]));
    const report = analyze(frames, { fps: 0.4, durationMs: 15000, coverage: "sampled" });

    expect(motionDensityWarnings(report)).toEqual([]);
  });
});

describe("motion density determinism", () => {
  it("produces byte-identical reports for the same frames", () => {
    const build = (): MotionDensityFrame[] => [
      solidFrame([13, 77, 191]),
      solidFrame([13, 77, 191]),
      solidFrame([200, 12, 40]),
      solidFrame([200, 12, 40])
    ];

    expect(JSON.stringify(analyze(build(), { durationMs: 1000 })))
      .toBe(JSON.stringify(analyze(build(), { durationMs: 1000 })));
  });

  it("rounds every measured value to a fixed number of decimals", () => {
    const report = complete(analyze([solidFrame([0, 0, 0]), solidFrame([1, 1, 1]), solidFrame([90, 3, 200])], { durationMs: 100 }));

    for (const value of [
      report.frozenRatio, report.meanFrameDifference, report.maxFrameDifference,
      report.meanChangedPixelRatio, report.maxChangedPixelRatio
    ]) {
      expect(value).toBe(roundMotionValue(value));
      expect(String(value).replace(/^-?\d*\.?/, "").length).toBeLessThanOrEqual(6);
    }
  });

  it("formats warning numbers without locale-dependent separators", () => {
    const report = analyze(Array.from({ length: 40 }, () => solidFrame([9, 9, 9])), { durationMs: 12345 });
    const warning = motionDensityWarnings(report)[0];

    expect(warning).toBeDefined();
    expect(warning).toMatch(/\d+\.\d{3}s/);
    expect(warning).not.toMatch(/\d,\d/);
  });

  it("falls back to documented defaults for missing or nonsensical policy values", () => {
    expect(resolveMotionDensityPolicy({})).toEqual({
      noiseThreshold: 0.003,
      changedPixelDelta: 2,
      changedPixelRatio: 0.001,
      minFrozenMs: 300,
      warnFrozenRatio: 0.25,
      warnLongestFrozenMs: 2000,
      maxReportedRanges: 8
    });
    expect(resolveMotionDensityPolicy({ noiseThreshold: Number.NaN, maxReportedRanges: 0 })).toMatchObject({
      noiseThreshold: 0.003,
      maxReportedRanges: 8
    });
  });

  it("caps the reported spans and says how many it left out", () => {
    // Ten 400ms holds separated by single changed frames -> ten spans, three reported.
    const frames: MotionDensityFrame[] = [];
    for (let block = 0; block < 10; block += 1) {
      for (let repeat = 0; repeat < 12; repeat += 1) frames.push(solidFrame([block * 25, 30, 30]));
      frames.push(solidFrame([block * 25 + 12, 200, 30]));
    }
    const report = complete(analyze(frames, { durationMs: 4333, policy: { maxReportedRanges: 3 } }));

    expect(report.frozenRanges).toHaveLength(3);
    expect(report.frozenRanges.map((range) => range.startMs)).toEqual([0, 433, 867]);
    expect(report.omittedRanges).toBeGreaterThan(0);
    expect(motionDensityWarnings(report)[0]).toContain(`(+${report.omittedRanges} shorter)`);
  });

  it("clamps caller range capacity and keeps a long alternating render at a fixed top-K", () => {
    const frames: MotionDensityFrame[] = [];
    for (let block = 0; block < MAX_MOTION_DENSITY_REPORTED_RANGES + 20; block += 1) {
      for (let repeat = 0; repeat < 10; repeat += 1) frames.push(solidFrame([(block * 2) % 255, 30, 30]));
      frames.push(solidFrame([(block * 2 + 120) % 255, 200, 30]));
    }
    const report = complete(analyze(frames, {
      durationMs: frames.length * 100,
      fps: 10,
      policy: { minFrozenMs: 300, maxReportedRanges: Number.MAX_SAFE_INTEGER }
    }));

    expect(report.policy.maxReportedRanges).toBe(MAX_MOTION_DENSITY_REPORTED_RANGES);
    expect(report.frozenRanges).toHaveLength(MAX_MOTION_DENSITY_REPORTED_RANGES);
    expect(report.omittedRanges).toBeGreaterThan(0);
  });

  it("caches a complete result when finish is called again", () => {
    const accumulator = createMotionDensityAccumulator();
    accumulator.observe(solidFrame([10, 10, 10]), 0);
    accumulator.observe(solidFrame([10, 10, 10]), 1_000);
    const first = accumulator.finish({ durationMs: 2_000, coverage: "complete" });
    expect(accumulator.finish({ durationMs: 2_000, coverage: "complete" })).toEqual(first);
  });
});
