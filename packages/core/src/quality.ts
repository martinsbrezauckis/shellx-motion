import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import {
  createMotionDensityAccumulator,
  type MotionDensityCoverage,
  type MotionDensityPolicy,
  type MotionDensityReport
} from "./motion-density";
import { motionDensityWarnings } from "./motion-density-warnings";

export interface PngQuality {
  ok: true;
  width: number;
  height: number;
  pixels: number;
  transparentPixels: number;
  transparentRatio: number;
  nonTransparentPixels: number;
  nonTransparentRatio: number;
  opaquePixels: number;
  opaqueRatio: number;
  blank: boolean;
  sha256: string;
  luma: { min: number; max: number; avg: number; range: number; darkPixels: number; darkRatio: number; brightPixels: number; brightRatio: number };
  /** Pixels whose maximum-minus-minimum RGB channel span is at least 32. */
  chroma: { pixels: number; ratio: number; channelSpanThreshold: 32 };
  edges: { pixels: number; ratio: number };
  rgbRange: { r: number; g: number; b: number };
}

export interface FrameQualitySummary {
  frameCount: number;
  blankFrames: number;
  minTransparentPixels: number;
  maxTransparentPixels: number;
  minNonTransparentPixels: number;
  maxNonTransparentPixels: number;
  minOpaquePixels: number;
  maxOpaquePixels: number;
  minDarkPixels: number;
  maxDarkPixels: number;
  minBrightPixels: number;
  maxBrightPixels: number;
  minLumaRange: number;
  maxLumaRange: number;
  minChromaPixels: number;
  maxChromaPixels: number;
  minEdgePixels: number;
  maxEdgePixels: number;
}

export interface PngRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PngVisualDiffResult =
  | {
      ok: true;
      width: number;
      height: number;
      pixels: number;
      changedPixels: number;
      changedRatio: number;
      meanAbsoluteError: number;
      meanSquaredError: number;
      rootMeanSquaredError: number;
      psnrDb: number | null;
      ssim: number;
      maxChannelDelta: number;
    }
  | {
      ok: false;
      code: "invalid_png" | "dimension_mismatch";
      message: string;
    };

export interface PngCompareOptions {
  compareAlpha?: boolean;
}

export type PngQualityResult =
  | PngQuality
  | { ok: false; code: "invalid_png" | "invalid_region"; message: string };

export type FrameSequenceQualityResult =
  | {
      ok: true;
      sampledFrames: PngQuality[];
      warnings: string[];
      summary: {
        frameCount: number;
        blankFrames: number;
        uniqueFrameHashes: number;
        durationMs: number;
        /**
         * How much of the piece actually moves, measured on the frames decoded by this very pass.
         * See motion-density.ts — the warnings this produces are already folded into `warnings`.
         */
        motion: MotionDensityReport;
      };
    }
  | {
      ok: false;
      code: "blank_frames" | "invalid_frame" | "no_frames" | "static_frames";
      message: string;
      warnings: string[];
      sampledFrames: PngQualityResult[];
    };

export interface FrameSequenceQualityPolicy {
  minDurationMs?: number;
  minUniqueFrameHashes?: number;
  /** Freeze-measurement tunables. Defaults documented on {@link MotionDensityPolicy}. */
  motion?: MotionDensityPolicy;
}

export async function inspectPngFile(path: string): Promise<PngQualityResult> {
  try {
    return inspectPngBuffer(await readFile(path));
  } catch (error) {
    return {
      ok: false,
      code: "invalid_png",
      message: `Unable to read frame ${path}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export async function inspectPngFileRegion(path: string, region: PngRegion): Promise<PngQualityResult> {
  return inspectPngRegionBuffer(await readFile(path), region);
}

export async function comparePngFiles(actualPath: string, expectedPath: string, options: PngCompareOptions = {}): Promise<PngVisualDiffResult> {
  const [actual, expected] = await Promise.all([readFile(actualPath), readFile(expectedPath)]);
  return comparePngBuffers(actual, expected, options);
}

export function comparePngBuffers(actualPng: Buffer, expectedPng: Buffer, options: PngCompareOptions = {}): PngVisualDiffResult {
  let actual: { width: number; height: number; rgba: Buffer };
  let expected: { width: number; height: number; rgba: Buffer };
  try {
    actual = decodePngRgba(actualPng);
    expected = decodePngRgba(expectedPng);
  } catch (error) {
    return {
      ok: false,
      code: "invalid_png",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  if (actual.width !== expected.width || actual.height !== expected.height) {
    return {
      ok: false,
      code: "dimension_mismatch",
      message: `PNG dimensions differ: actual ${actual.width}x${actual.height}, expected ${expected.width}x${expected.height}.`
    };
  }

  let changedPixels = 0;
  let totalDelta = 0;
  let totalSquaredDelta = 0;
  let maxChannelDelta = 0;
  const pixels = actual.width * actual.height;
  const channelCount = options.compareAlpha === false ? 3 : 4;
  const comparedChannelCount = pixels * channelCount;
  for (let offset = 0; offset < actual.rgba.length; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const delta = Math.abs(actual.rgba[offset + channel] - expected.rgba[offset + channel]);
      totalDelta += delta;
      totalSquaredDelta += delta * delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (delta > 0) pixelChanged = true;
    }
    if (pixelChanged) changedPixels += 1;
  }

  const ssim = calculateWindowedSsim(actual, expected, options.compareAlpha !== false);

  return {
    ok: true,
    width: actual.width,
    height: actual.height,
    pixels,
    changedPixels,
    changedRatio: pixels === 0 ? 0 : changedPixels / pixels,
    meanAbsoluteError: comparedChannelCount === 0 ? 0 : totalDelta / comparedChannelCount,
    meanSquaredError: comparedChannelCount === 0 ? 0 : totalSquaredDelta / comparedChannelCount,
    rootMeanSquaredError: comparedChannelCount === 0 ? 0 : Math.sqrt(totalSquaredDelta / comparedChannelCount),
    psnrDb: totalSquaredDelta === 0 || comparedChannelCount === 0
      ? null
      : 20 * Math.log10(255 / Math.sqrt(totalSquaredDelta / comparedChannelCount)),
    ssim,
    maxChannelDelta
  };
}

function calculateWindowedSsim(
  actual: { width: number; height: number; rgba: Buffer },
  expected: { width: number; height: number; rgba: Buffer },
  compareAlpha: boolean
): number {
  const windowSize = 8;
  let windowCount = 0;
  let ssimTotal = 0;
  for (let windowY = 0; windowY < actual.height; windowY += windowSize) {
    for (let windowX = 0; windowX < actual.width; windowX += windowSize) {
      const stats = {
        samples: 0,
        actualTotal: 0,
        expectedTotal: 0,
        actualSquaredTotal: 0,
        expectedSquaredTotal: 0,
        productTotal: 0
      };
      const maxY = Math.min(actual.height, windowY + windowSize);
      const maxX = Math.min(actual.width, windowX + windowSize);
      for (let y = windowY; y < maxY; y += 1) {
        for (let x = windowX; x < maxX; x += 1) {
          const offset = (y * actual.width + x) * 4;
          const actualLuma = premultipliedLuma(actual.rgba, offset, compareAlpha);
          const expectedLuma = premultipliedLuma(expected.rgba, offset, compareAlpha);
          stats.samples += 1;
          stats.actualTotal += actualLuma;
          stats.expectedTotal += expectedLuma;
          stats.actualSquaredTotal += actualLuma * actualLuma;
          stats.expectedSquaredTotal += expectedLuma * expectedLuma;
          stats.productTotal += actualLuma * expectedLuma;
        }
      }
      ssimTotal += calculateSsimWindow(stats);
      windowCount += 1;
    }
  }
  return windowCount === 0 ? 1 : Math.max(-1, Math.min(1, ssimTotal / windowCount));
}

function premultipliedLuma(rgba: Buffer, offset: number, compareAlpha: boolean): number {
  const alpha = compareAlpha ? rgba[offset + 3] / 255 : 1;
  return (0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]) * alpha;
}

function calculateSsimWindow(input: {
  samples: number;
  actualTotal: number;
  expectedTotal: number;
  actualSquaredTotal: number;
  expectedSquaredTotal: number;
  productTotal: number;
}): number {
  if (input.samples === 0) return 1;
  const actualMean = input.actualTotal / input.samples;
  const expectedMean = input.expectedTotal / input.samples;
  const actualVariance = Math.max(0, input.actualSquaredTotal / input.samples - actualMean * actualMean);
  const expectedVariance = Math.max(0, input.expectedSquaredTotal / input.samples - expectedMean * expectedMean);
  const covariance = input.productTotal / input.samples - actualMean * expectedMean;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const numerator = (2 * actualMean * expectedMean + c1) * (2 * covariance + c2);
  const denominator = (actualMean ** 2 + expectedMean ** 2 + c1) * (actualVariance + expectedVariance + c2);
  if (denominator === 0) return 1;
  return Math.max(-1, Math.min(1, numerator / denominator));
}

export function inspectPngBuffer(png: Buffer): PngQualityResult {
  try {
    const decoded = decodePngRgba(png);
    return inspectRgba(decoded, hashBuffer(png));
  } catch (error) {
    return {
      ok: false,
      code: "invalid_png",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function inspectPngRegionBuffer(png: Buffer, region: PngRegion): PngQualityResult {
  try {
    const decoded = decodePngRgba(png);
    const clipped = extractRgbaRegion(decoded, region);
    return inspectRgba(clipped, hashBuffer(clipped.rgba));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: message.startsWith("Invalid PNG region") ? "invalid_region" : "invalid_png",
      message
    };
  }
}

export function summarizeFrameQuality(frames: PngQuality[]): FrameQualitySummary {
  if (frames.length === 0) {
    return {
      frameCount: 0,
      blankFrames: 0,
      minTransparentPixels: 0,
      maxTransparentPixels: 0,
      minNonTransparentPixels: 0,
      maxNonTransparentPixels: 0,
      minOpaquePixels: 0,
      maxOpaquePixels: 0,
      minDarkPixels: 0,
      maxDarkPixels: 0,
      minBrightPixels: 0,
      maxBrightPixels: 0,
      minLumaRange: 0,
      maxLumaRange: 0,
      minChromaPixels: 0,
      maxChromaPixels: 0,
      minEdgePixels: 0,
      maxEdgePixels: 0
    };
  }

  return {
    frameCount: frames.length,
    blankFrames: frames.filter((frame) => frame.blank).length,
    minTransparentPixels: Math.min(...frames.map((frame) => frame.transparentPixels)),
    maxTransparentPixels: Math.max(...frames.map((frame) => frame.transparentPixels)),
    minNonTransparentPixels: Math.min(...frames.map((frame) => frame.nonTransparentPixels)),
    maxNonTransparentPixels: Math.max(...frames.map((frame) => frame.nonTransparentPixels)),
    minOpaquePixels: Math.min(...frames.map((frame) => frame.opaquePixels)),
    maxOpaquePixels: Math.max(...frames.map((frame) => frame.opaquePixels)),
    minDarkPixels: Math.min(...frames.map((frame) => frame.luma.darkPixels)),
    maxDarkPixels: Math.max(...frames.map((frame) => frame.luma.darkPixels)),
    minBrightPixels: Math.min(...frames.map((frame) => frame.luma.brightPixels)),
    maxBrightPixels: Math.max(...frames.map((frame) => frame.luma.brightPixels)),
    minLumaRange: Math.min(...frames.map((frame) => frame.luma.range)),
    maxLumaRange: Math.max(...frames.map((frame) => frame.luma.range)),
    minChromaPixels: Math.min(...frames.map((frame) => frame.chroma.pixels)),
    maxChromaPixels: Math.max(...frames.map((frame) => frame.chroma.pixels)),
    minEdgePixels: Math.min(...frames.map((frame) => frame.edges.pixels)),
    maxEdgePixels: Math.max(...frames.map((frame) => frame.edges.pixels))
  };
}

/**
 * Still comparisons that must fit inside the shortest reportable freeze before the freeze advisory
 * is worth saying out loud. Two is the minimum that puts an OBSERVATION inside the run rather than
 * only at its two endpoints.
 */
export const MOTION_ADVISORY_COMPARISONS_PER_FROZEN_RUN = 2;

/**
 * Whether a complete-coverage freeze measurement can RESOLVE the freeze it would report.
 *
 * The measurement declares a frozen run once consecutive still comparisons span
 * `policy.minFrozenMs` (300ms by default). When the analysed frames are further apart than that,
 * a SINGLE pair of similar frames instantly constitutes a "frozen run" — and a single comparison
 * says nothing about the interval between the two frames it compared, because nothing was observed
 * inside it. At 2 frames per second every render is "frozen" by construction, and `frozenRatio`
 * collapses to a two-way split (roughly 0% or roughly 100%) that carries no information.
 *
 * Connector previews, proof harnesses and cheap fixtures all render at 2-4 fps, so without this
 * gate the advisory fires on renders where it is pure artefact — and an advisory that is noise
 * below some sampling rate teaches authors to ignore the array it rides in. That is the same
 * trust defect as the success-status invariant, one level up: not a wrong status, but a wrong claim.
 *
 * The measurement itself is NOT gated. It always runs, and the complete report — sample interval,
 * frozen ratio, ranges — always reaches the caller on `summary.motion`, so an verifier can read the
 * numbers and judge for themselves. Only the English "verify this is intentional" sentence, which
 * asks a human or agent to act, waits until the numbers can back it.
 *
 * Sampled coverage is always allowed through: those warnings already state that they are sampled
 * evidence and make no duration claim, which is exactly the honesty this gate enforces.
 *
 * @param report The measurement produced for this sequence.
 * @returns True when the advisory may be emitted.
 */
export function motionDensityAdvisoryIsResolvable(report: MotionDensityReport): boolean {
  if (report.status === "unavailable") return true;
  if (report.coverage === "sampled") return true;
  // A single-frame sequence is not an interpolation problem — the whole piece IS that one picture,
  // so "it does not move" is definitional rather than inferred from a gap nothing was observed in.
  // That is a real defect worth naming (someone rendered one frame for a one-second clip), and it
  // is the one case where zero comparisons still back the claim.
  if (report.comparisons === 0) return true;
  if (report.sampleIntervalMs <= 0) return false;
  return report.sampleIntervalMs * MOTION_ADVISORY_COMPARISONS_PER_FROZEN_RUN <= report.policy.minFrozenMs;
}

export async function inspectFrameSequence(input: {
  framePaths: string[];
  durationMs: number;
  /**
   * Frames per second, used only to place each frame on the timeline for the motion measurement so
   * frozen ranges are reported in real time. Derived from frame count and duration when absent.
   */
  fps?: number;
} & FrameSequenceQualityPolicy): Promise<FrameSequenceQualityResult> {
  const warnings: string[] = [];
  const minDurationMs = input.minDurationMs ?? 1500;
  if (input.durationMs < minDurationMs) {
    warnings.push(`Rendered video is ${input.durationMs}ms; product review clips should be at least ${minDurationMs}ms.`);
  }
  if (input.framePaths.length === 0) {
    return {
      ok: false,
      code: "no_frames",
      message: "Rendered frame sequence has no sampled frames.",
      warnings,
      sampledFrames: []
    };
  }

  const { results: sampledFrames, motion } = await inspectAndMeasure(
    input.framePaths,
    frameTimestamps(input.framePaths.length, input.durationMs, input.fps),
    { durationMs: input.durationMs, coverage: "complete", policy: input.motion }
  );
  const invalid = sampledFrames.find((frame) => !frame.ok);
  if (invalid && !invalid.ok) {
    return {
      ok: false,
      code: "invalid_frame",
      message: invalid.message,
      warnings,
      sampledFrames
    };
  }

  const validFrames = sampledFrames.filter((frame): frame is PngQuality => frame.ok);
  const blankFrames = validFrames.filter((frame) => frame.blank).length;
  if (validFrames.length > 0 && blankFrames === validFrames.length) {
    return {
      ok: false,
      code: "blank_frames",
      message: "Rendered frame sequence is blank or visually empty.",
      warnings,
      sampledFrames
    };
  }

  const uniqueFrameHashes = new Set(validFrames.map((frame) => frame.sha256)).size;
  if (validFrames.length > 1 && uniqueFrameHashes === 1) {
    warnings.push("Rendered frame sequence is static; verify this is intentional before using it as product output.");
  }
  // Partial-freeze evidence. The all-frames-identical warning above only fires for a piece that
  // never changes at all; this is the finer-grained signal that catches a piece which moves for two
  // seconds and then holds — the failure mode that shipped three times without a word.
  //
  // Gated on the measurement being able to RESOLVE what it claims (see
  // {@link motionDensityAdvisoryIsResolvable}). The measurement itself always runs and always
  // reaches the caller on `summary.motion`; only the English advisory is withheld.
  if (motionDensityAdvisoryIsResolvable(motion)) warnings.push(...motionDensityWarnings(motion));
  const minUniqueFrameHashes = input.minUniqueFrameHashes ?? 0;
  if (minUniqueFrameHashes > 0 && uniqueFrameHashes < minUniqueFrameHashes) {
    return {
      ok: false,
      code: "static_frames",
      message: `Rendered frame sequence has ${uniqueFrameHashes} unique frame${uniqueFrameHashes === 1 ? "" : "s"}; expected at least ${minUniqueFrameHashes}.`,
      warnings,
      sampledFrames
    };
  }

  return {
    ok: true,
    sampledFrames: validFrames,
    warnings,
    summary: {
      frameCount: input.framePaths.length,
      blankFrames,
      uniqueFrameHashes,
      durationMs: input.durationMs,
      motion
    }
  };
}

/**
 * Measure motion across an arbitrary set of already-rendered frames — the cheap pre-render probe.
 *
 * `inspectFrameSequence` above answers the question for a full render because it is already
 * decoding every frame. This is the same measurement for callers that hold a handful of frames
 * instead: `motion.preview.strip` renders 5-60 frames across the timeline and never encodes
 * anything, so an agent can ask "does this actually move?" for a fraction of a render's cost.
 *
 * The coverage is reported as "sampled" and the resulting warnings say so — sparse samples cannot
 * back a frozen percentage, and claiming one would be exactly the kind of unbacked number this work
 * exists to remove.
 *
 * @param framePaths PNG frames in timeline order.
 * @param timestampsMs Timeline position of each frame, same length and order as `framePaths`.
 * @param options.durationMs Duration of the whole piece, for context in the report.
 * @param options.policy Freeze-measurement tunables.
 * @returns An analyzed report, or an `unavailable` report naming why it could not be measured.
 *   Never throws — a probe that cannot run must not break the caller.
 */
export async function analyzeFrameSequenceMotion(
  framePaths: string[],
  timestampsMs: number[],
  options: { durationMs: number; policy?: MotionDensityPolicy } = { durationMs: 0 }
): Promise<MotionDensityReport> {
  if (framePaths.length === 0) return { status: "unavailable", reason: "No frames were analyzed." };
  const { motion } = await inspectAndMeasure(framePaths, timestampsMs, {
    durationMs: options.durationMs,
    coverage: "sampled",
    policy: options.policy,
    summarize: false
  });
  return motion;
}

/**
 * Decode each frame exactly ONCE and drive both the per-frame quality summary and the streaming
 * motion measurement from that single decode. Decoding is the expensive step (~70ms for a 1080p
 * frame in this pure-JS decoder, so ~31s for a 15s 30fps piece); a second pass purely to measure
 * motion would have roughly doubled the analysis cost of every render, which is why the measurement
 * is folded in here rather than bolted on beside it.
 *
 * Frames are read with a one-frame lookahead so file I/O still overlaps the synchronous decode,
 * while memory stays bounded at two frame buffers plus the accumulator's two plane sets — the
 * previous `Promise.all` shape could not retain pixels for a frame-to-frame comparison without
 * holding the whole sequence in memory.
 *
 * A frame that cannot be read or decoded is recorded as an invalid frame for the quality gate AND
 * marks the motion measurement unavailable, so the caller never receives a motion verdict computed
 * from a partial sequence.
 *
 * @param summarize When false, per-frame quality summaries are skipped (the caller only wants
 *   motion), avoiding the extra full-frame statistics pass.
 */
async function inspectAndMeasure(
  framePaths: string[],
  timestampsMs: number[],
  options: { durationMs: number; coverage: MotionDensityCoverage; policy?: MotionDensityPolicy; summarize?: boolean }
): Promise<{ results: PngQualityResult[]; motion: MotionDensityReport }> {
  const motion = createMotionDensityAccumulator(options.policy);
  const summarize = options.summarize !== false;
  const results: PngQualityResult[] = [];
  const readAhead = (index: number): Promise<Buffer> | null => {
    if (index >= framePaths.length) return null;
    const pending = readFile(framePaths[index]);
    // Mark the lookahead handled so a read failure can never surface as an unhandled rejection
    // before the loop reaches (and reports) it.
    pending.catch(() => undefined);
    return pending;
  };

  let pending = readAhead(0);
  for (let index = 0; index < framePaths.length; index += 1) {
    const current = pending as Promise<Buffer>;
    pending = readAhead(index + 1);
    const path = framePaths[index];
    let bytes: Buffer;
    try {
      bytes = await current;
    } catch (error) {
      const message = `Unable to read frame ${path}: ${error instanceof Error ? error.message : String(error)}`;
      results.push({ ok: false, code: "invalid_png", message });
      motion.fail(message);
      continue;
    }
    let decoded: { width: number; height: number; rgba: Buffer };
    try {
      decoded = decodePngRgba(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ok: false, code: "invalid_png", message });
      motion.fail(message);
      continue;
    }
    if (summarize) results.push(inspectRgba(decoded, hashBuffer(bytes)));
    motion.observe(decoded, timestampsMs[index] ?? 0);
  }

  return { results, motion: motion.finish({ durationMs: options.durationMs, coverage: options.coverage }) };
}

/**
 * Timeline position of every frame in a complete sequence, matching the renderer's own
 * `frameTimestampMs` (`index * 1000 / fps`). When fps is not supplied it is derived from the frame
 * count and duration, which is exact for any sequence the renderer produced.
 */
function frameTimestamps(frameCount: number, durationMs: number, fps?: number): number[] {
  const effectiveFps = typeof fps === "number" && Number.isFinite(fps) && fps > 0
    ? fps
    : (durationMs > 0 ? (frameCount * 1000) / durationMs : 0);
  if (effectiveFps <= 0) return Array.from({ length: frameCount }, () => 0);
  return Array.from({ length: frameCount }, (_, index) => (index * 1000) / effectiveFps);
}

function inspectRgba(input: { width: number; height: number; rgba: Buffer }, sha256: string): PngQuality {
  let minLuma = 255;
  let maxLuma = 0;
  let totalLuma = 0;
  let darkPixels = 0;
  let brightPixels = 0;
  let transparentPixels = 0;
  let nonTransparentPixels = 0;
  let opaquePixels = 0;
  let chromaPixels = 0;
  const min = { r: 255, g: 255, b: 255 };
  const max = { r: 0, g: 0, b: 0 };

  for (let offset = 0; offset < input.rgba.length; offset += 4) {
    const a = input.rgba[offset + 3];
    if (a === 0) {
      transparentPixels += 1;
      continue;
    }
    if (a === 255) opaquePixels += 1;
    const r = input.rgba[offset];
    const g = input.rgba[offset + 1];
    const b = input.rgba[offset + 2];
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    totalLuma += luma;
    if (luma <= 55) darkPixels += 1;
    if (luma >= 200) brightPixels += 1;
    nonTransparentPixels += 1;
    min.r = Math.min(min.r, r);
    min.g = Math.min(min.g, g);
    min.b = Math.min(min.b, b);
    max.r = Math.max(max.r, r);
    max.g = Math.max(max.g, g);
    max.b = Math.max(max.b, b);
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 32) chromaPixels += 1;
  }

  const pixels = input.width * input.height;
  const transparentRatio = pixels === 0 ? 0 : transparentPixels / pixels;
  const nonTransparentRatio = pixels === 0 ? 0 : nonTransparentPixels / pixels;
  const opaqueRatio = pixels === 0 ? 0 : opaquePixels / pixels;
  const lumaRange = nonTransparentPixels === 0 ? 0 : maxLuma - minLuma;
  const rgbRange = {
    r: nonTransparentPixels === 0 ? 0 : max.r - min.r,
    g: nonTransparentPixels === 0 ? 0 : max.g - min.g,
    b: nonTransparentPixels === 0 ? 0 : max.b - min.b
  };
  const maxRgbRange = Math.max(rgbRange.r, rgbRange.g, rgbRange.b);
  const edgePixels = countEdgePixels(input);

  return {
    ok: true,
    width: input.width,
    height: input.height,
    pixels,
    transparentPixels,
    transparentRatio,
    nonTransparentPixels,
    nonTransparentRatio,
    opaquePixels,
    opaqueRatio,
    blank: nonTransparentRatio < 0.01 || (lumaRange <= 2 && maxRgbRange <= 2),
    sha256,
    luma: {
      min: nonTransparentPixels === 0 ? 0 : minLuma,
      max: nonTransparentPixels === 0 ? 0 : maxLuma,
      avg: nonTransparentPixels === 0 ? 0 : totalLuma / nonTransparentPixels,
      range: lumaRange,
      darkPixels,
      darkRatio: pixels === 0 ? 0 : darkPixels / pixels,
      brightPixels,
      brightRatio: pixels === 0 ? 0 : brightPixels / pixels
    },
    chroma: {
      pixels: chromaPixels,
      ratio: pixels === 0 ? 0 : chromaPixels / pixels,
      channelSpanThreshold: 32
    },
    edges: {
      pixels: edgePixels,
      ratio: pixels === 0 ? 0 : edgePixels / pixels
    },
    rgbRange
  };
}

function extractRgbaRegion(
  input: { width: number; height: number; rgba: Buffer },
  region: PngRegion
): { width: number; height: number; rgba: Buffer } {
  if (!Number.isInteger(region.x) || !Number.isInteger(region.y) || !Number.isInteger(region.width) || !Number.isInteger(region.height)) {
    throw new Error("Invalid PNG region: x, y, width, and height must be integers.");
  }
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    throw new Error("Invalid PNG region: x and y must be non-negative, width and height must be positive.");
  }
  if (region.x + region.width > input.width || region.y + region.height > input.height) {
    throw new Error(`Invalid PNG region: ${region.x},${region.y} ${region.width}x${region.height} exceeds ${input.width}x${input.height}.`);
  }

  const rgba = Buffer.alloc(region.width * region.height * 4);
  for (let y = 0; y < region.height; y += 1) {
    const sourceStart = ((region.y + y) * input.width + region.x) * 4;
    const sourceEnd = sourceStart + region.width * 4;
    input.rgba.copy(rgba, y * region.width * 4, sourceStart, sourceEnd);
  }
  return { width: region.width, height: region.height, rgba };
}

function countEdgePixels(input: { width: number; height: number; rgba: Buffer }): number {
  const threshold = 24;
  let edgePixels = 0;
  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      const offset = (y * input.width + x) * 4;
      const alpha = input.rgba[offset + 3];
      if (alpha === 0) continue;
      const luma = lumaAt(input.rgba, offset);
      let edge = false;
      if (x + 1 < input.width) {
        const rightOffset = offset + 4;
        edge = edge || Math.abs(luma - lumaAt(input.rgba, rightOffset)) >= threshold || Math.abs(alpha - input.rgba[rightOffset + 3]) >= threshold;
      }
      if (y + 1 < input.height) {
        const downOffset = ((y + 1) * input.width + x) * 4;
        edge = edge || Math.abs(luma - lumaAt(input.rgba, downOffset)) >= threshold || Math.abs(alpha - input.rgba[downOffset + 3]) >= threshold;
      }
      if (edge) edgePixels += 1;
    }
  }
  return edgePixels;
}

function lumaAt(rgba: Buffer, offset: number): number {
  return Math.round(0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]);
}

const CRC_TABLE = createCrcTable();

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePngRgba(png: Buffer): { width: number; height: number; rgba: Buffer } {
  assertPngSignature(png);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("PNG has truncated chunk header.");
    const length = png.readUInt32BE(offset);
    const typeBytes = png.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > png.length) throw new Error(`PNG chunk ${type} is truncated.`);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (actualCrc !== expectedCrc) throw new Error(`PNG chunk ${type} has invalid CRC.`);
    offset = chunkEnd;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaceMethod = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0) throw new Error("PNG has invalid dimensions.");
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}.`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type: ${colorType}.`);
  if (interlaceMethod !== 0) throw new Error(`Unsupported PNG interlace method: ${interlaceMethod}.`);

  const channels = colorType === 6 ? 4 : 3;
  const bytesPerPixel = channels;
  const stride = width * channels;

  // Both numbers below are attacker-controlled: every PNG this decoder sees is
  // package-controlled (quality-manifest baselines named by the template, and frames rendered from
  // package input). Each needs its own bound, because either guard alone leaves the other door open.
  //
  //   - dimensions: `width`/`height` are two UInt32BE fields out of IHDR that used to size
  //     `Buffer.alloc(width * height * 4)` directly. 100000x100000 asks for a 40 GB allocation
  //     before a single IDAT byte is read, from a file that can be a few hundred bytes.
  //   - inflated size: zlib reaches ~1029:1 on a run of zeros, so a 65 KB IDAT expands to 64 MiB
  //     regardless of what the header claims. A sane-looking header does not make the stream sane.
  //
  // The frame budget is deliberately the SAME ceiling the render lanes already work to, so this is a
  // bound rather than a wall: Motion renders up to 4K, and 3840x2160 RGBA is 33.2 MPix. Anything
  // larger is not a Motion frame.
  const MAX_FRAME_PIXELS = 3840 * 2160;
  if (width * height > MAX_FRAME_PIXELS) {
    throw new Error(
      `PNG dimensions ${width}x${height} exceed the ${MAX_FRAME_PIXELS}-pixel frame budget ` +
      "(3840x2160). Refusing before allocating a pixel buffer."
    );
  }

  // The exact size a valid image of these dimensions inflates to: one filter byte per scanline plus
  // the scanline itself. Anything beyond it is not data this image can use, so the cap is derived
  // from the header rather than being a second magic number -- and `maxOutputLength` makes zlib stop
  // at the boundary instead of after the memory is already gone.
  const expectedInflatedBytes = (stride + 1) * height;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedInflatedBytes });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PNG IDAT stream inflates past the ${expectedInflatedBytes} bytes its own IHDR declares ` +
      `(${width}x${height}): ${reason}`
    );
  }
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous: Buffer<ArrayBufferLike> = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const raw = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    const row = unfilterScanline(raw, previous, filter, bytesPerPixel);
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = channels === 4 ? row[source + 3] : 255;
    }
    previous = row;
  }

  return { width, height, rgba };
}

function unfilterScanline(raw: Buffer, previous: Buffer, filter: number, bytesPerPixel: number): Buffer {
  const row = Buffer.alloc(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    if (filter === 0) row[index] = raw[index];
    else if (filter === 1) row[index] = (raw[index] + left) & 0xff;
    else if (filter === 2) row[index] = (raw[index] + up) & 0xff;
    else if (filter === 3) row[index] = (raw[index] + Math.floor((left + up) / 2)) & 0xff;
    else if (filter === 4) row[index] = (raw[index] + paeth(left, up, upLeft)) & 0xff;
    else throw new Error(`Unsupported PNG filter: ${filter}.`);
  }
  return row;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function assertPngSignature(png: Buffer): void {
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("File is not a PNG image.");
  }
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Diff-image evidence (quality-manifest failure receipts).
//
// When a representative-frame comparison fails, a bare metric line ("PSNR 25.8 dB") cannot tell a
// reviewer WHETHER the failure is a uniform colour/range offset (whole-frame haze), a localized
// content/timing divergence (a moving element in the wrong place), or a structural break. So on
// failure we persist a diff image alongside the metric breakdown. The diff is a per-pixel,
// per-channel absolute-delta heat map amplified into the visible range: identical pixels are black,
// small deltas are dim, large deltas saturate. A uniform offset reads as a flat grey wash; a
// content/timing gap reads as bright silhouettes over black. This is deliberately a *visual*
// artifact — the numeric metrics remain the pass/fail authority.
// ---------------------------------------------------------------------------------------------

export type VisualDiffImageResult =
  | { ok: true; png: Buffer; width: number; height: number; maxChannelDelta: number }
  | { ok: false; code: "invalid_png" | "dimension_mismatch"; message: string };

/**
 * Build a diff heat-map PNG from two same-size images.
 *
 * @param actualPng   Encoded PNG of the decoded/delivered frame.
 * @param expectedPng Encoded PNG of the baseline (pre-encode renderer frame).
 * @param options.amplify Linear gain applied to each absolute channel delta before clamping to
 *   0-255 (default 6, so a 42-count delta already saturates a channel — matching the human
 *   just-noticeable range for SDR-BT.709 8-bit deltas). The alpha channel of the diff is opaque so
 *   the artifact renders on any background.
 * @returns Encoded RGBA PNG, or an error when inputs are invalid / mismatched in size.
 */
export function buildVisualDiffPng(
  actualPng: Buffer,
  expectedPng: Buffer,
  options: { amplify?: number } = {}
): VisualDiffImageResult {
  let actual: { width: number; height: number; rgba: Buffer };
  let expected: { width: number; height: number; rgba: Buffer };
  try {
    actual = decodePngRgba(actualPng);
    expected = decodePngRgba(expectedPng);
  } catch (error) {
    return { ok: false, code: "invalid_png", message: error instanceof Error ? error.message : String(error) };
  }
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return {
      ok: false,
      code: "dimension_mismatch",
      message: `PNG dimensions differ: actual ${actual.width}x${actual.height}, expected ${expected.width}x${expected.height}.`
    };
  }
  const amplify = options.amplify !== undefined && options.amplify > 0 ? options.amplify : 6;
  const diff = Buffer.alloc(actual.rgba.length);
  let maxChannelDelta = 0;
  for (let offset = 0; offset < actual.rgba.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(actual.rgba[offset + channel] - expected.rgba[offset + channel]);
      if (delta > maxChannelDelta) maxChannelDelta = delta;
      diff[offset + channel] = Math.min(255, Math.round(delta * amplify));
    }
    // Fold the alpha-channel delta into the red channel so transparency divergence is still visible,
    // then force the diff pixel opaque.
    const alphaDelta = Math.abs(actual.rgba[offset + 3] - expected.rgba[offset + 3]);
    if (alphaDelta > maxChannelDelta) maxChannelDelta = alphaDelta;
    diff[offset] = Math.min(255, diff[offset] + Math.round(alphaDelta * amplify));
    diff[offset + 3] = 255;
  }
  return {
    ok: true,
    png: encodeRgbaPng(actual.width, actual.height, diff),
    width: actual.width,
    height: actual.height,
    maxChannelDelta
  };
}

/**
 * Encode straight-alpha 8-bit RGBA pixels into a non-interlaced PNG (colour type 6, filter 0).
 * Minimal deflate-based encoder — the repository already decodes PNGs with zlib inflate; this is the
 * matching inverse so diff-image evidence needs no third-party image dependency.
 */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodeRgbaPng expected ${width * height * 4} bytes, received ${rgba.length}.`);
  }
  // Prepend a filter-type byte (0 = None) to each scanline, per the PNG spec.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rawRow = y * (1 + width * 4);
    raw[rawRow] = 0;
    rgba.copy(raw, rawRow + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method: adaptive (only filter 0 used)
  header[12] = 0; // interlace: none
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// Reuses the module-level crc32 (see createCrcTable/crc32 above) so PNG chunk CRCs match the decoder.
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}
