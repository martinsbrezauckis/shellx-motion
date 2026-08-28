/**
 * A freeze advisory may only be spoken when the measurement can resolve it.
 *
 * The freeze measurement declares a frozen run once consecutive still comparisons span
 * `policy.minFrozenMs` (300ms). When analysed frames are further apart than that, ONE pair of
 * similar frames instantly constitutes a "frozen run", and `frozenRatio` collapses to roughly 0% or
 * roughly 100% — a two-way split carrying no information. Connector previews, proof harnesses and
 * cheap fixtures all render at 2-4 fps, so without a resolution gate the advisory fires on renders
 * where it is pure artefact, and an advisory that is noise below some sampling rate teaches authors
 * to ignore the array it rides in.
 *
 * This protects the success-status invariant one level up: not a wrong status, but a claim the evidence cannot
 * back. The measurement is never suppressed — `summary.motion` always carries the full report, so
 * an verifier reads the numbers either way. Only the "verify this is intentional" sentence waits.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { inspectFrameSequence, motionDensityAdvisoryIsResolvable, MOTION_ADVISORY_COMPARISONS_PER_FROZEN_RUN } from "./quality";
import { MOTION_DENSITY_POLICY_DEFAULTS, type MotionDensityReport } from "./motion-density";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * 8-bit RGBA PNG: a dark field with one bright 4x4 block at `blockX`.
 *
 * Deliberately NOT a flat colour — a flat frame has zero luma range and the quality gate correctly
 * rejects the whole sequence as blank before motion is ever considered.
 */
function blockPng(width: number, height: number, blockX: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const bright = x >= blockX && x < blockX + 4 && y >= 2 && y < 6;
      const level = bright ? 245 : 10;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = level;
      raw[offset + 1] = level;
      raw[offset + 2] = level;
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Write a sequence that holds still for its second half, at a chosen fps.
 *
 * @returns The frame paths, in order.
 */
async function heldSequence(fps: number, durationMs: number): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-advisory-resolution-"));
  roots.push(root);
  const frameCount = Math.round((durationMs / 1000) * fps);
  const paths: string[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    // First half slides the bright block a pixel per frame; second half holds it dead still.
    const moving = index < frameCount / 2;
    const blockX = moving ? index % 12 : 0;
    const path = join(root, `frame-${String(index).padStart(4, "0")}.png`);
    await writeFile(path, blockPng(16, 8, blockX));
    paths.push(path);
  }
  return paths;
}

function analyzedReport(sampleIntervalMs: number): MotionDensityReport {
  return {
    status: "analyzed",
    coverage: "complete",
    frameCount: 10,
    comparisons: 9,
    stillComparisons: 9,
    sampleIntervalMs,
    durationMs: sampleIntervalMs * 10,
    meanFrameDifference: 0,
    maxFrameDifference: 0,
    meanChangedPixelRatio: 0,
    maxChangedPixelRatio: 0,
    policy: MOTION_DENSITY_POLICY_DEFAULTS,
    frozenMs: sampleIntervalMs * 9,
    frozenRatio: 0.9,
    longestFrozenMs: sampleIntervalMs * 9,
    longestFrozenSpanMs: sampleIntervalMs * 9,
    frozenRunCount: 1,
    frozenRanges: [],
    omittedRanges: 0
  };
}

describe("motionDensityAdvisoryIsResolvable", () => {
  it("requires the analysis to fit at least two comparisons inside the shortest reportable freeze", () => {
    const limit = MOTION_DENSITY_POLICY_DEFAULTS.minFrozenMs / MOTION_ADVISORY_COMPARISONS_PER_FROZEN_RUN;

    expect(motionDensityAdvisoryIsResolvable(analyzedReport(limit))).toBe(true);
    expect(motionDensityAdvisoryIsResolvable(analyzedReport(limit + 1))).toBe(false);
    // 2 fps — every connector preview and cheap fixture. Frozen by construction, not by content.
    expect(motionDensityAdvisoryIsResolvable(analyzedReport(500))).toBe(false);
    // 30 fps — the real render the measurement was built for.
    expect(motionDensityAdvisoryIsResolvable(analyzedReport(1000 / 30))).toBe(true);
  });

  it("still speaks for a single-frame sequence, where the claim is definitional", () => {
    // Zero comparisons: nothing was inferred across a gap, because there is no gap — the piece is
    // one picture. Rendering one frame for a one-second clip is a real defect worth naming.
    const single = { ...analyzedReport(1000), frameCount: 1, comparisons: 0, stillComparisons: 0 };
    expect(motionDensityAdvisoryIsResolvable(single)).toBe(true);
  });

  it("never withholds an unavailable report or sampled evidence", () => {
    // "Analysis did not run" must always be said; a sampled report already states it is sampled and
    // makes no duration claim, which is the honesty this gate enforces.
    expect(motionDensityAdvisoryIsResolvable({ status: "unavailable", reason: "decode failed" })).toBe(true);
    expect(motionDensityAdvisoryIsResolvable({
      status: "analyzed",
      coverage: "sampled",
      frameCount: 5,
      comparisons: 4,
      stillComparisons: 4,
      sampleIntervalMs: 3000,
      durationMs: 15_000,
      meanFrameDifference: 0,
      maxFrameDifference: 0,
      meanChangedPixelRatio: 0,
      maxChangedPixelRatio: 0,
      policy: MOTION_DENSITY_POLICY_DEFAULTS,
      stillIntervalRatio: 1
    })).toBe(true);
  });
});

describe("inspectFrameSequence advisory gating", () => {
  it("stays silent about a 2 fps sequence while still reporting the measurement", async () => {
    const framePaths = await heldSequence(2, 2000);

    const result = await inspectFrameSequence({ framePaths, durationMs: 2000, fps: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.filter((warning) => warning.includes("static for"))).toEqual([]);
    // The measurement is NOT suppressed — it is on the summary for anyone who wants the number.
    expect(result.summary.motion.status).toBe("analyzed");
    if (result.summary.motion.status !== "analyzed" || result.summary.motion.coverage !== "complete") return;
    expect(result.summary.motion.frozenRatio).toBeGreaterThan(0);
    expect(result.summary.motion.sampleIntervalMs).toBe(500);
  }, 45_000);

  it("still warns about a real hold once the analysis can resolve it", async () => {
    const framePaths = await heldSequence(24, 2000);

    const result = await inspectFrameSequence({ framePaths, durationMs: 2000, fps: 24 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((warning) => warning.includes("static for"))).toBe(true);
  }, 45_000);
});
