import { describe, expect, it } from "vitest";
import {
  assertTrackingAnalysis,
  unsupportedTrackingSettings,
  type TrackingAnalysisSettings,
  type TrackingMatrix3,
  type TrackingSourceIdentity,
} from "./tracking-analysis";
import { solveFixedTrackingAnalysis, type TrackingLumaFrame } from "./tracking-solver";

/**
 * `pyramidLevels: 2`, not 3. These fixtures draw 5-pixel crosses: at depth 3 a coarse pixel spans
 * 4 source pixels, so the feature is 1.25 coarse pixels wide and coarse-to-fine mis-associates
 * neighbouring crosses. That is a real property of the search, pinned by the
 * "pyramid depth is a real tradeoff" case below rather than hidden by picking a depth that works.
 * Before v2.0.0 this field said 3 and the solver ignored it, so the number here described nothing.
 */
const SETTINGS: TrackingAnalysisSettings = {
  startMs: 0,
  endMs: 200,
  stepMs: 100,
  direction: "forward",
  searchRadiusPx: 14,
  pyramidLevels: 2,
  maxIterations: 40,
  confidenceFloor: 0.7,
  deterministicSeed: 9,
};

describe("fixed bounded tracking solver", () => {
  it("solves known point translation from decoded luma frames", () => {
    const source = sourceIdentity(64, 48);
    const referencePoints = [{ x: 20, y: 20 }];
    const frames = [
      frame(0, source, referencePoints),
      frame(100, source, referencePoints.map((point) => ({ x: point.x + 4, y: point.y + 3 }))),
      frame(200, source, referencePoints.map((point) => ({ x: point.x + 8, y: point.y + 5 }))),
    ];

    const result = solveFixedTrackingAnalysis({
      id: "point_translation",
      source,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 12, y: 12, width: 16, height: 16 }, points: referencePoints },
      settings: SETTINGS,
      frames,
      createdAt: "2026-07-13T22:00:00.000Z",
    });

    assertTrackingAnalysis(result);
    expect(result).toMatchObject({ status: "succeeded", spans: [] });
    expect(result.samples.map((sample) => sample.matrix)).toEqual([
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [1, 0, 4, 0, 1, 3, 0, 0, 1],
      [1, 0, 8, 0, 1, 5, 0, 0, 1],
    ]);
  });

  it("solves known planar scale and rotation from multiple persistent patches", () => {
    const source = sourceIdentity(72, 56);
    const points = [{ x: 16, y: 14 }, { x: 54, y: 14 }, { x: 54, y: 42 }, { x: 16, y: 42 }];
    const expected = similarityAround({ x: 35, y: 28 }, 1.05, 5, 3, -2);
    const frames = [
      frame(0, source, points),
      frame(100, source, points.map((point) => project(expected, point))),
      frame(200, source, points.map((point) => project(expected, point))),
    ];

    const result = solveFixedTrackingAnalysis({
      id: "planar_similarity",
      source,
      mode: "planar",
      model: "similarity",
      reference: { atMs: 0, bounds: { x: 12, y: 10, width: 46, height: 36 }, points },
      settings: SETTINGS,
      frames,
      createdAt: "2026-07-13T22:01:00.000Z",
    });

    assertTrackingAnalysis(result);
    expect(result.status).toBe("succeeded");
    const matrix = result.samples[1].matrix!;
    expect(Math.hypot(matrix[0], matrix[3])).toBeCloseTo(1.05, 1);
    const solvedRotation = Math.atan2(matrix[3], matrix[0]) * 180 / Math.PI;
    expect(solvedRotation).toBeGreaterThan(3.5);
    expect(solvedRotation).toBeLessThan(6.5);
    expect(result.samples[1].residualErrorPx).toBeLessThan(1);
  });

  it("solves a bounded planar homography and records its residual", () => {
    const source = sourceIdentity(80, 64);
    const points = [
      { x: 16, y: 14 }, { x: 40, y: 12 }, { x: 64, y: 16 },
      { x: 18, y: 48 }, { x: 42, y: 50 }, { x: 62, y: 46 },
    ];
    const expected: TrackingMatrix3 = [1.01, 0.015, 2, -0.01, 0.99, 3, 0.0004, -0.00025, 1];
    const frames = [
      frame(0, source, points),
      frame(100, source, points.map((point) => project(expected, point))),
      frame(200, source, points.map((point) => project(expected, point))),
    ];

    const result = solveFixedTrackingAnalysis({
      id: "planar_homography",
      source,
      mode: "planar",
      model: "homography",
      reference: { atMs: 0, bounds: { x: 12, y: 8, width: 56, height: 46 }, points },
      settings: SETTINGS,
      frames,
      createdAt: "2026-07-13T22:02:00.000Z",
    });

    assertTrackingAnalysis(result);
    expect(result.status).toBe("succeeded");
    expect(result.samples[1].matrix).toHaveLength(9);
    expect(result.samples[1].residualErrorPx).toBeLessThan(1);
    expect(project(result.samples[1].matrix!, points[0]).x).toBeCloseTo(Math.round(project(expected, points[0]).x), 1);
  });

  it("marks a blank failure as lost and the next valid frame as recovered", () => {
    const source = sourceIdentity(64, 48);
    const points = [{ x: 20, y: 20 }];
    const blank = { atMs: 100, width: source.width, height: source.height, luma: new Uint8Array(source.width * source.height) };
    const result = solveFixedTrackingAnalysis({
      id: "point_recovery",
      source,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 12, y: 12, width: 16, height: 16 }, points },
      settings: SETTINGS,
      frames: [frame(0, source, points), blank, frame(200, source, [{ x: 26, y: 24 }])],
      createdAt: "2026-07-13T22:03:00.000Z",
    });

    assertTrackingAnalysis(result);
    expect(result.status).toBe("partial");
    expect(result.samples.map((sample) => sample.state)).toEqual(["tracked", "lost", "recovered"]);
    expect(result.spans).toEqual([
      { startMs: 100, endMs: 100, state: "lost", minConfidence: 0 },
      { startMs: 200, endMs: 200, state: "recovered", minConfidence: 1, maxResidualErrorPx: 0 },
    ]);
  });

  it("honors forward, backward, and both direction bounds around the reference frame", () => {
    const source = sourceIdentity(64, 48);
    const points = [{ x: 20, y: 20 }];
    const frames = [
      frame(0, source, [{ x: 18, y: 19 }]),
      frame(100, source, points),
      frame(200, source, [{ x: 23, y: 22 }]),
    ];
    const base = {
      id: "directional_point",
      source,
      mode: "point" as const,
      model: "translation" as const,
      reference: { atMs: 100, bounds: { x: 12, y: 12, width: 16, height: 16 }, points },
      settings: { ...SETTINGS },
      frames,
    };

    expect(solveFixedTrackingAnalysis({ ...base, settings: { ...SETTINGS, direction: "forward" } }).samples.map((sample) => sample.atMs)).toEqual([100, 200]);
    expect(solveFixedTrackingAnalysis({ ...base, settings: { ...SETTINGS, direction: "backward" } }).samples.map((sample) => sample.atMs)).toEqual([0, 100]);
    expect(solveFixedTrackingAnalysis({ ...base, settings: { ...SETTINGS, direction: "both" } }).samples.map((sample) => sample.atMs)).toEqual([0, 100, 200]);
  });

  it("rejects malformed frame buffers and work beyond the deterministic budget", () => {
    const source = sourceIdentity(64, 48);
    const points = [{ x: 20, y: 20 }];
    const request = {
      id: "bad_frames",
      source,
      mode: "point" as const,
      model: "translation" as const,
      reference: { atMs: 0, bounds: { x: 12, y: 12, width: 16, height: 16 }, points },
      settings: SETTINGS,
      frames: [{ atMs: 0, width: 64, height: 48, luma: new Uint8Array(2) }],
    };
    expect(() => solveFixedTrackingAnalysis(request)).toThrow("exactly one byte per pixel");
    expect(() => solveFixedTrackingAnalysis({
      ...request,
      settings: { ...SETTINGS, searchRadiusPx: 512, pyramidLevels: 1 },
      frames: Array.from({ length: 10 }, (_, index) => frame(index * 10, source, points)),
    })).toThrow("operation match budget");
  });

  it("refuses a pyramid deeper than the source can carry instead of quietly shortening it", () => {
    const source = sourceIdentity(64, 48);
    const points = [{ x: 20, y: 20 }];
    // 64x48 halves to 32x24 then 16x12; a fourth level would be 8x6, too small for one 7x7 patch.
    expect(() => solveFixedTrackingAnalysis({
      id: "too_deep",
      source,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 12, y: 12, width: 16, height: 16 }, points },
      settings: { ...SETTINGS, pyramidLevels: 4 },
      frames: [frame(0, source, points)],
    })).toThrow("Tracking pyramidLevels 4 is deeper than a 64x48 source supports");
  });

  it("spends pyramidLevels on the operation budget: the same request is refused at 1 and runs at 4", () => {
    // Identical in every other respect. At depth 1 the solver must scan (2*512+1)^2 full-resolution
    // candidates per point per frame and refuses the work; each extra level quarters that, and at
    // depth 4 the same search fits. This is the control doing something no caller could fake.
    const source = gradientSource(256, 192);
    const frames = Array.from({ length: 10 }, (_, index) => gradientFrame(index * 10, source, 64 + index, 64));
    const request = {
      id: "budget_by_depth",
      source,
      mode: "point" as const,
      model: "translation" as const,
      reference: { atMs: 0, bounds: { x: 40, y: 40, width: 48, height: 48 }, points: [{ x: 64, y: 64 }] },
      frames,
    };
    const settings = { ...SETTINGS, endMs: 200, searchRadiusPx: 512, maxIterations: 40 };

    expect(() => solveFixedTrackingAnalysis({ ...request, settings: { ...settings, pyramidLevels: 1 } }))
      .toThrow("operation match budget");
    const deep = solveFixedTrackingAnalysis({ ...request, settings: { ...settings, pyramidLevels: 4 }, createdAt: "2026-08-02T00:00:00.000Z" });
    assertTrackingAnalysis(deep);
    expect(deep.status).toBe("succeeded");
    expect(deep.samples.map((sample) => sample.matrix?.[2])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("pyramid depth is a real tradeoff, not free accuracy, on features smaller than a coarse pixel", () => {
    // The 6-point homography fixture again, solved at two depths. Depth 2 nails it; depth 3 makes a
    // coarse pixel 4 source pixels wide, wider than the 5-pixel crosses, and the search locks onto
    // the wrong cross. Asserted so nobody reads pyramidLevels as "higher is better".
    const source = sourceIdentity(80, 64);
    const points = [
      { x: 16, y: 14 }, { x: 40, y: 12 }, { x: 64, y: 16 },
      { x: 18, y: 48 }, { x: 42, y: 50 }, { x: 62, y: 46 },
    ];
    const expected: TrackingMatrix3 = [1.01, 0.015, 2, -0.01, 0.99, 3, 0.0004, -0.00025, 1];
    const request = {
      id: "depth_tradeoff",
      source,
      mode: "planar" as const,
      model: "homography" as const,
      reference: { atMs: 0, bounds: { x: 12, y: 8, width: 56, height: 46 }, points },
      frames: [
        frame(0, source, points),
        frame(100, source, points.map((point) => project(expected, point))),
        frame(200, source, points.map((point) => project(expected, point))),
      ],
      createdAt: "2026-08-02T00:00:00.000Z",
    };

    const shallow = solveFixedTrackingAnalysis({ ...request, settings: { ...SETTINGS, pyramidLevels: 2 } });
    const deep = solveFixedTrackingAnalysis({ ...request, settings: { ...SETTINGS, pyramidLevels: 3 } });

    expect(shallow.status).toBe("succeeded");
    expect(shallow.samples[1].residualErrorPx).toBeLessThan(1);
    expect(deep.status).toBe("partial");
    expect(deep.samples[1].state).toBe("low-confidence");
    expect(deep.samples[1].residualErrorPx).toBeGreaterThan(10);
    expect(deep.samples[1].matrix).not.toEqual(shallow.samples[1].matrix);
  });

  it("walks further than searchRadiusPx as maxIterations rises, and stops when it converges", () => {
    // A 41x41 gradient blob displaced 24 px with searchRadiusPx 8. One window cannot reach it; each
    // extra iteration re-centres on its own best match and climbs 2 more pixels down the gradient.
    const source = gradientSource(128, 96);
    const frames = [gradientFrame(0, source, 40, 40), gradientFrame(100, source, 64, 40)];
    const request = {
      id: "iteration_walk",
      source,
      mode: "point" as const,
      model: "translation" as const,
      reference: { atMs: 0, bounds: { x: 20, y: 20, width: 40, height: 40 }, points: [{ x: 40, y: 40 }] },
      frames,
      createdAt: "2026-08-02T00:00:00.000Z",
    };
    const settings = { ...SETTINGS, endMs: 100, searchRadiusPx: 8, pyramidLevels: 1 };
    const solve = (maxIterations: number) => solveFixedTrackingAnalysis({ ...request, settings: { ...settings, maxIterations } }).samples[1];

    expect(solve(1)).toMatchObject({ state: "lost", confidence: 0 });
    expect(solve(8).matrix?.[2]).toBe(22);
    expect(solve(12)).toMatchObject({ state: "tracked", confidence: 1 });
    expect(solve(12).matrix?.[2]).toBe(24);
    // Converged: more iterations cannot move a match that already beats its own neighbourhood.
    expect(solve(40)).toEqual(solve(12));
  });

  it("accepts deterministicSeed, reports it as inert, and returns the identical result for every seed", () => {
    const source = sourceIdentity(64, 48);
    const points = [{ x: 20, y: 20 }];
    const request = {
      id: "seed_is_inert",
      source,
      mode: "point" as const,
      model: "translation" as const,
      reference: { atMs: 0, bounds: { x: 12, y: 12, width: 16, height: 16 }, points },
      frames: [frame(0, source, points), frame(100, source, [{ x: 24, y: 23 }]), frame(200, source, [{ x: 28, y: 25 }])],
      createdAt: "2026-08-02T00:00:00.000Z",
    };
    const zero = solveFixedTrackingAnalysis({ ...request, settings: { ...SETTINGS, deterministicSeed: 0 } });
    const seeded = solveFixedTrackingAnalysis({ ...request, settings: { ...SETTINGS, deterministicSeed: 2_147_483_647 } });

    // Every sample is identical: the search consumes no randomness, so the seed cannot steer it.
    expect(seeded.samples).toEqual(zero.samples);
    expect(seeded.spans).toEqual(zero.spans);
    // The identity hash still separates the two requests, because it identifies the REQUEST.
    expect(seeded.settingsSha256).not.toBe(zero.settingsSha256);
    // And the caller is told, rather than left to infer it from identical output.
    expect(unsupportedTrackingSettings(zero.settings)).toEqual([]);
    expect(unsupportedTrackingSettings(seeded.settings)).toEqual([
      expect.objectContaining({ setting: "deterministicSeed", value: 2_147_483_647 }),
    ]);
  });
});

/** Source identity for the smooth-gradient fixtures, which are large enough to carry a deep pyramid. */
function gradientSource(width: number, height: number): TrackingSourceIdentity {
  return {
    assetId: "gradient_footage",
    sha256: "8".repeat(64),
    byteLength: width * height * 3,
    width,
    height,
    durationMs: 200,
  };
}

/**
 * A 41x41 blob whose luma falls off linearly with Chebyshev distance from its centre. Unlike the
 * 5-pixel crosses it has structure at every pyramid level and a gradient a re-centring search can
 * climb, which is what makes it a fair test of pyramidLevels and maxIterations.
 */
function gradientFrame(atMs: number, source: TrackingSourceIdentity, centreX: number, centreY: number): TrackingLumaFrame {
  const luma = new Uint8Array(source.width * source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const distance = Math.max(Math.abs(x - centreX), Math.abs(y - centreY));
      if (distance <= 20) luma[y * source.width + x] = 255 - distance * 12;
    }
  }
  return { atMs, width: source.width, height: source.height, luma };
}

function sourceIdentity(width: number, height: number): TrackingSourceIdentity {
  return {
    assetId: "synthetic_footage",
    sha256: "9".repeat(64),
    byteLength: width * height * 3,
    width,
    height,
    durationMs: 200,
  };
}

function frame(atMs: number, source: TrackingSourceIdentity, points: Array<{ x: number; y: number }>): TrackingLumaFrame {
  const luma = new Uint8Array(source.width * source.height);
  points.forEach((point, index) => drawPattern(luma, source.width, source.height, Math.round(point.x), Math.round(point.y), index));
  return { atMs, width: source.width, height: source.height, luma };
}

function drawPattern(luma: Uint8Array, width: number, height: number, x: number, y: number, seed: number) {
  const values = [255, 80 + seed * 17, 140 + seed * 11, 210 - seed * 13, 100 + seed * 19];
  const offsets = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
  offsets.forEach(([dx, dy], index) => {
    const px = x + dx;
    const py = y + dy;
    if (px >= 0 && py >= 0 && px < width && py < height) luma[py * width + px] = values[index];
  });
}

function similarityAround(center: { x: number; y: number }, scale: number, rotationDeg: number, tx: number, ty: number): TrackingMatrix3 {
  const radians = rotationDeg * Math.PI / 180;
  const a = scale * Math.cos(radians);
  const b = scale * Math.sin(radians);
  return [
    a, -b, center.x + tx - a * center.x + b * center.y,
    b, a, center.y + ty - b * center.x - a * center.y,
    0, 0, 1,
  ];
}

function project(matrix: TrackingMatrix3, point: { x: number; y: number }) {
  const divisor = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / divisor,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / divisor,
  };
}
