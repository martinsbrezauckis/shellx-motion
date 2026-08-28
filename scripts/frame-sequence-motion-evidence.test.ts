import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "../packages/core/src/quality";
import { inspectCompleteFrameSequenceMotionEvidence } from "./frame-sequence-motion-evidence";
import { evaluateMotionDensityAcceptance } from "./template-moving-proof-policy";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("complete frame-sequence motion evidence", () => {
  it("persists bounded, grain-resistant complete-sequence measurements from deterministic frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-sequence-evidence-"));
    tempDirs.push(dir);
    const frames = [
      checker(255, 0),
      checker(200, 20),
      checker(50, 230),
      checker(240, 10),
      checker(240, 10),
      checker(240, 10),
      checker(240, 10),
      checker(240, 10),
      checker(0, 255),
      checker(255, 0)
    ];
    const framePaths = await Promise.all(frames.map(async (frame, index) => {
      const path = join(dir, `${String(index).padStart(6, "0")}.png`);
      await writeFile(path, frame);
      return path;
    }));

    const evidence = await inspectCompleteFrameSequenceMotionEvidence({
      framePaths,
      durationMs: 1000,
      fps: 10
    });

    expect(evidence).toMatchObject({
      schema: "shellx-motion/frame-sequence-motion-evidence@1",
      analyzedFrameCount: 10,
      comparisons: 9,
      frozenRatio: 0.5,
      longestFrozenMs: 500,
      longestFrozenSpanMs: 500,
      frozenRunCount: 1,
      frozenRangeCount: 1,
      frozenRanges: [{ startMs: 300, endMs: 800, durationMs: 500, holds: 1 }],
      omittedFrozenRangeCount: 0,
      maxChangedPixelRatio: 1
    });
    expect(evidence.meanFrameDifference).toBeGreaterThan(0);
    expect(evidence.maxFrameDifference).toBeGreaterThan(0);
    expect(evidence.meanChangedPixelRatio).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toContain(dir);
  });

  it("refuses a sequence that did not pass Core inspection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-sequence-evidence-blank-"));
    tempDirs.push(dir);
    const path = join(dir, "000000.png");
    await writeFile(path, encodeRgbaPng(2, 2, Buffer.alloc(2 * 2 * 4)));

    await expect(inspectCompleteFrameSequenceMotionEvidence({
      framePaths: [path],
      durationMs: 1000,
      fps: 1
    })).rejects.toThrow("Frame sequence inspection failed: blank_frames.");
  });

  it("rejects grain-only and static alternates while preserving a legitimate continuously moving control", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-sequence-evidence-grain-"));
    tempDirs.push(dir);
    const grainOnlyPaths = await writeFrames(dir, "grain", Array.from({ length: 10 }, (_, index) => grainFrame(index + 1)));
    const compositionStaticPaths = await writeFrames(dir, "composition-static", Array.from({ length: 10 }, () => checker(110, 40)));
    const movingPaths = await writeFrames(dir, "moving", Array.from({ length: 10 }, (_, index) => checker(20 + index * 20, 230 - index * 20)));

    const grainOnly = await inspectCompleteFrameSequenceMotionEvidence({ framePaths: grainOnlyPaths, durationMs: 1000, fps: 10 });
    const compositionStatic = await inspectCompleteFrameSequenceMotionEvidence({ framePaths: compositionStaticPaths, durationMs: 1000, fps: 10 });
    const moving = await inspectCompleteFrameSequenceMotionEvidence({ framePaths: movingPaths, durationMs: 1000, fps: 10 });
    const compositionPolicy = {
      state: "calibrated" as const,
      analysis: "film-grain-stripped" as const,
      calibration: {
        frozenRatio: 0,
        longestFrozenMs: 0,
        longestFrozenSpanMs: 0,
        meanFrameDifference: 0.01,
        meanChangedPixelRatio: 0.01
      },
      maxFrozenRatio: 0,
      maxLongestFrozenMs: 0
    };

    // Raw grain changes every pixel, proving that raw pixel diversity is not a
    // composition-motion acceptance signal. The declared alternate is static
    // and therefore fails the same source-owned policy.
    expect(grainOnly.frozenRatio).toBe(0);
    expect(compositionStatic.frozenRatio).toBe(1);
    expect(evaluateMotionDensityAcceptance(compositionPolicy, compositionStatic)).toMatchObject({
      ok: false,
      code: "motion_density_below_policy"
    });
    expect(moving.frozenRatio).toBe(0);
    expect(evaluateMotionDensityAcceptance(compositionPolicy, moving)).toEqual({ ok: true });
  });
});

async function writeFrames(dir: string, prefix: string, frames: Buffer[]): Promise<string[]> {
  return Promise.all(frames.map(async (frame, index) => {
    const path = join(dir, `${prefix}-${String(index).padStart(6, "0")}.png`);
    await writeFile(path, frame);
    return path;
  }));
}

function checker(bright: number, dark: number): Buffer {
  return encodeRgbaPng(2, 2, Buffer.from([
    bright, bright, bright, 255,
    dark, dark, dark, 255,
    dark, dark, dark, 255,
    bright, bright, bright, 255
  ]));
}

/** Deterministic full-frame noise: the adversarial film-grain-only input. */
function grainFrame(seed: number, size = 16): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  let state = seed;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const value = 96 + (state & 31);
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return encodeRgbaPng(size, size, rgba);
}
