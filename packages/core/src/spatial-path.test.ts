import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deleteLayerSpatialPosition,
  interpolateSpatialPosition,
  moveLayerSpatialPosition,
  readMotionSpatialPath,
  upsertLayerSpatialPosition,
  validateSpatialKeyframes,
} from "./spatial-path";
import { effectiveLayerAtMs, interpolateNumber } from "./timeline";
import { compileTrackingStabilization, type TrackingAnalysis } from "./tracking-analysis";
import type { MotionEasing, MotionLayer } from "./types";

function layer(): MotionLayer {
  return {
    id: "subject",
    type: "shape",
    startMs: 0,
    durationMs: 1_000,
    keyframes: {
      "transform.x": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 1_000, value: 100, easing: "linear" },
      ],
      "transform.y": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 1_000, value: 0, easing: "linear" },
      ],
    },
  };
}

/** 0 -> 1000 on X and 0 -> 500 on Y over one second, with no tangent metadata. */
function pairedMove(easing: MotionEasing = "linear"): MotionLayer {
  return {
    id: "subject",
    type: "shape",
    startMs: 0,
    durationMs: 1_000,
    keyframes: {
      "transform.x": [
        { atMs: 0, value: 0, easing },
        { atMs: 1_000, value: 1_000, easing },
      ],
      "transform.y": [
        { atMs: 0, value: 0, easing },
        { atMs: 1_000, value: 500, easing },
      ],
    },
  };
}

/**
 * The symmetric arch used throughout the timing assertions: (0,0) to (100,0)
 * with both handles pushed 100px up, so its cubic control polygon is
 * (0,0) (0,100) (100,100) (100,0) and its total length is exactly 200.
 */
function arch(): MotionLayer {
  const start = upsertLayerSpatialPosition(layer(), {
    atMs: 0, x: 0, y: 0, easing: "linear",
    spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 0, y: 100 } },
  });
  return upsertLayerSpatialPosition(start.layer, {
    atMs: 1_000, x: 100, y: 0, easing: "linear",
    spatial: { mode: "broken", in: { x: 0, y: 100 }, out: { x: 0, y: 0 } },
  }).layer;
}

/**
 * The arch evaluated at a raw Bézier parameter — which is what the sampler did
 * with authored progress before arc-length timing, and what it still does with
 * progress that overshoots the segment. Written in the same Bernstein form and
 * operation order the sampler uses, so equality against it is exact.
 */
function archAtParameter(s: number): { x: number; y: number } {
  const u = 1 - s;
  const uu = u * u;
  const ss = s * s;
  const w1 = 3 * uu * s;
  const w2 = 3 * u * ss;
  const w3 = ss * s;
  return { x: w2 * 100 + w3 * 100, y: w1 * 100 + w2 * 100 };
}

/** Isolates the sampler from `resolveEasing` so the assertions pin geometry only. */
const identityEase = (_easing: MotionEasing | undefined, t: number): number => t;

describe("spatial motion paths", () => {
  it("upserts paired position values and renders their cubic geometry", () => {
    const first = upsertLayerSpatialPosition(layer(), {
      atMs: 0,
      x: 0,
      y: 0,
      easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 0, y: 100 } },
    });
    const second = upsertLayerSpatialPosition(first.layer, {
      atMs: 1_000,
      x: 100,
      y: 0,
      easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 100 }, out: { x: 0, y: 0 } },
    });

    expect(first.action).toBe("replaced");
    expect(first.changedPaths).toHaveLength(2);
    expect(readMotionSpatialPath(second.layer)?.map(({ atMs, x, y }) => ({ atMs, x, y }))).toEqual([
      { atMs: 0, x: 0, y: 0 },
      { atMs: 1_000, x: 100, y: 0 },
    ]);
    expect(effectiveLayerAtMs(second.layer, 500).transform).toMatchObject({ x: 50, y: 75 });
  });

  it("uses deterministic auto handles without mutating stored metadata", () => {
    const start = upsertLayerSpatialPosition(layer(), {
      atMs: 0, x: 0, y: 0,
      spatial: { mode: "auto", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } },
    });
    const middle = upsertLayerSpatialPosition(start.layer, {
      atMs: 500, x: 50, y: 100,
      spatial: { mode: "auto", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } },
    });
    const end = upsertLayerSpatialPosition(middle.layer, {
      atMs: 1_000, x: 100, y: 0,
      spatial: { mode: "auto", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } },
    });
    const points = readMotionSpatialPath(end.layer)!;

    expect(points[1].spatial).toEqual({ mode: "auto", in: { x: -100 / 6, y: 0 }, out: { x: 100 / 6, y: 0 } });
    expect(end.layer.keyframes?.["transform.x"]?.[1].spatial?.out).toEqual({ x: 0, y: 0 });
  });

  it("moves and deletes both coordinate lanes atomically", () => {
    const moved = moveLayerSpatialPosition(layer(), { fromMs: 1_000, toMs: 750 });
    expect(moved.action).toBe("moved");
    expect(moved.layer.keyframes?.["transform.x"]?.map((frame) => frame.atMs)).toEqual([0, 750]);
    expect(moved.layer.keyframes?.["transform.y"]?.map((frame) => frame.atMs)).toEqual([0, 750]);

    const deleted = deleteLayerSpatialPosition(moved.layer, { atMs: 0 });
    expect(deleted.action).toBe("deleted");
    expect(deleted.layer.keyframes?.["transform.x"]).toHaveLength(1);
    expect(deleted.layer.keyframes?.["transform.y"]).toHaveLength(1);
  });

  it("rejects half-pairs, invalid smooth handles, and y-owned metadata", () => {
    const half = layer();
    half.keyframes?.["transform.y"]?.splice(0, 1);
    expect(() => upsertLayerSpatialPosition(half, { atMs: 0, x: 1, y: 2 })).toThrow("aligned");
    expect(() => upsertLayerSpatialPosition(layer(), {
      atMs: 0,
      x: 0,
      y: 0,
      spatial: { mode: "smooth", in: { x: -10, y: 0 }, out: { x: 0, y: 10 } },
    })).toThrow("collinear and opposite");

    const invalid = layer();
    invalid.keyframes!["transform.y"]![0].spatial = { mode: "linear", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } };
    const errors: Array<{ path: string; message: string }> = [];
    validateSpatialKeyframes(invalid, "/layers/0", errors);
    expect(errors).toContainEqual({ path: "/layers/0/keyframes/transform.y/0/spatial", message: "is owned by the aligned transform.x keyframe" });
  });

  it("rejects globally misaligned position lanes before any addressed mutation", () => {
    const missingElsewhere = layer();
    missingElsewhere.keyframes!["transform.y"]!.splice(0, 1);
    expect(() => upsertLayerSpatialPosition(missingElsewhere, { atMs: 1_000, x: 20, y: 30 })).toThrow("globally aligned");
    expect(() => moveLayerSpatialPosition(missingElsewhere, { fromMs: 1_000, toMs: 800 })).toThrow("globally aligned");
    expect(() => deleteLayerSpatialPosition(missingElsewhere, { atMs: 1_000 })).toThrow("globally aligned");

    const easingDrift = layer();
    easingDrift.keyframes!["transform.y"]![0].easing = "ease-in";
    expect(() => upsertLayerSpatialPosition(easingDrift, { atMs: 1_000, x: 20, y: 30 })).toThrow("timestamps and easing");

    const nonNumeric = layer();
    nonNumeric.keyframes!["transform.y"]![0].value = "bad";
    expect(() => deleteLayerSpatialPosition(nonNumeric, { atMs: 1_000 })).toThrow("numeric X/Y");

    const duplicated = layer();
    duplicated.keyframes!["transform.x"]!.push({ ...duplicated.keyframes!["transform.x"]![0] });
    duplicated.keyframes!["transform.y"]!.push({ ...duplicated.keyframes!["transform.y"]![0] });
    expect(() => upsertLayerSpatialPosition(duplicated, { atMs: 1_000, x: 20, y: 30 })).toThrow("numeric X/Y");
  });
});

describe("spatial path time parameterisation", () => {
  // Regression guard for the collapsed-cubic defect: with both handles zero the
  // Bezier reduced to smoothstep(t) = 3t^2 - 2t^3, which equals t only at
  // t = 0, 0.5 and 1. Every assertion below therefore samples off the midpoint.
  it("advances a straight paired move by the authored progress, not by smoothstep", () => {
    const straight = pairedMove();

    expect(interpolateSpatialPosition(straight, 100, identityEase)).toEqual({ x: 100, y: 50 });
    expect(interpolateSpatialPosition(straight, 250, identityEase)).toEqual({ x: 250, y: 125 });
    expect(interpolateSpatialPosition(straight, 500, identityEase)).toEqual({ x: 500, y: 250 });
    expect(interpolateSpatialPosition(straight, 750, identityEase)).toEqual({ x: 750, y: 375 });
    expect(interpolateSpatialPosition(straight, 900, identityEase)).toEqual({ x: 900, y: 450 });
    // The values the defect produced, spelled out so a reintroduction is obvious.
    expect(interpolateSpatialPosition(straight, 250, identityEase)).not.toEqual({ x: 156.25, y: 78.125 });
    expect(interpolateSpatialPosition(straight, 750, identityEase)).not.toEqual({ x: 843.75, y: 421.875 });
  });

  it("applies a non-linear authored easing exactly once and matches the single-lane result bit for bit", () => {
    const easeIn = pairedMove("ease-in"); // resolveEasing("ease-in") is t * t.

    expect(effectiveLayerAtMs(easeIn, 250).transform).toMatchObject({ x: 62.5, y: 31.25 });
    expect(effectiveLayerAtMs(easeIn, 500).transform).toMatchObject({ x: 250, y: 125 });
    expect(effectiveLayerAtMs(easeIn, 750).transform).toMatchObject({ x: 562.5, y: 281.25 });
    // Same easing arriving through a custom sampler, independent of resolveEasing.
    expect(interpolateSpatialPosition(easeIn, 250, (_easing, t) => t * t)).toEqual({ x: 62.5, y: 31.25 });

    // A single numeric lane is the reference implementation for eased motion, so
    // a paired move must agree with it exactly rather than approximately.
    for (const atMs of [100, 250, 333, 500, 750, 900]) {
      const paired = effectiveLayerAtMs(easeIn, atMs).transform;
      expect(paired?.x).toBe(interpolateNumber(easeIn.keyframes!["transform.x"], atMs));
      expect(paired?.y).toBe(interpolateNumber(easeIn.keyframes!["transform.y"], atMs));
    }
  });

  it("still bends genuinely curved segments, including one-sided handles", () => {
    const start = upsertLayerSpatialPosition(layer(), {
      atMs: 0, x: 0, y: 0, easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 0, y: 100 } },
    });
    const curved = upsertLayerSpatialPosition(start.layer, {
      atMs: 1_000, x: 100, y: 0, easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 100 }, out: { x: 0, y: 0 } },
    }).layer;

    // Y is keyed 0 -> 0, so any non-zero Y is the spatial handles bending the path.
    // The quarter samples are arc-length timed: a quarter of the TIME now buys a
    // quarter of the 200-unit arch rather than a quarter of the curve parameter,
    // which used to cover 59.375 units. The midpoint is unmoved because this arch
    // is symmetric about x = 50, so half the length falls at s = 0.5 exactly.
    expect(interpolateSpatialPosition(curved, 250, identityEase)).toEqual({ x: 10.589254302501772, y: 48.35239517939101 });
    expect(interpolateSpatialPosition(curved, 500, identityEase)).toEqual({ x: 50, y: 75 });
    expect(interpolateSpatialPosition(curved, 750, identityEase)).toEqual({ x: 89.41074569749823, y: 48.35239517939101 });

    // Boundary of the straight-chord shortcut: one zero handle is not a chord.
    const oneSided = upsertLayerSpatialPosition(start.layer, {
      atMs: 1_000, x: 100, y: 0, easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } },
    }).layer;
    expect(interpolateSpatialPosition(oneSided, 250, identityEase)).toEqual({ x: 7.678700876016349, y: 35.12135529043108 });
    expect(interpolateSpatialPosition(oneSided, 750, identityEase)).toEqual({ x: 72.23460485781857, y: 23.58744734807229 });
  });

  /**
   * The values pinned above are checked here against a calculation that shares
   * nothing with the implementation: 60-decimal-digit Romberg integration of
   * |P'(s)| plus bisection, cross-checked for the arch against its closed form.
   *
   * The arch admits one because its speed is a perfect square. With w = s(1-s),
   * |P'|^2 = 600^2 w^2 + 300^2 (1 - 4w) = 300^2 (1 - 2w)^2, so
   * |P'| = 300 (1 - 2s + 2s^2), L(s) = 300 (s - s^2 + (2/3) s^3) and L(1) = 200.
   * Solving L(s) = 200t is then the cubic 2s^3 - 3s^2 + 3s - 2t = 0, whose
   * Cardano root at t = 1/4 is s = 1/2 + (cbrt(sqrt 2 - 1) - cbrt(sqrt 2 + 1))/2
   * = 0.20196418100833923844..., giving x = 100 s^2 (3 - 2s) and y = 300 s(1 - s).
   * The one-sided curve has no elementary closed form and is the numeric result.
   */
  it("agrees with an independently derived arc-length reference", () => {
    const start = upsertLayerSpatialPosition(layer(), {
      atMs: 0, x: 0, y: 0, easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 0, y: 100 } },
    });
    const curved = upsertLayerSpatialPosition(start.layer, {
      atMs: 1_000, x: 100, y: 0, easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 100 }, out: { x: 0, y: 0 } },
    }).layer;
    const oneSided = upsertLayerSpatialPosition(start.layer, {
      atMs: 1_000, x: 100, y: 0, easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } },
    }).layer;

    const reference: Array<[MotionLayer, number, number, number]> = [
      [curved, 250, 10.58925430250177153307918784, 48.35239517939100675560341981],
      [curved, 500, 50, 75],
      [curved, 750, 89.41074569749822846692081215, 48.35239517939100675560341981],
      [oneSided, 250, 7.678700876016344683936936638, 35.12135529043107563374872085],
      [oneSided, 500, 40.64008745339114010329424427, 41.54036047822946098085724723],
      [oneSided, 750, 72.23460485781855695487762984, 23.58744734807229894319823051],
    ];
    for (const [target, atMs, x, y] of reference) {
      const sampled = interpolateSpatialPosition(target, atMs, identityEase)!;
      expect(Math.abs(sampled.x - x)).toBeLessThan(1e-12);
      expect(Math.abs(sampled.y - y)).toBeLessThan(1e-12);
    }
  });

  /**
   * The defining behaviour: even time steps must cover even distance. Measured
   * end to end through the sampler as straight-line distance between consecutive
   * samples. A chord slightly understates the arc it subtends, and that
   * understatement varies with curvature, which is what sets the tolerance here
   * rather than any solver error -- the same property asserted against true arc
   * length in spatial-arc-length.test.ts holds to 3e-12.
   */
  it("travels a curved segment at constant speed under linear easing", () => {
    const curved = arch();
    const samples = 512;
    const spread = (parameterise: (progress: number) => { x: number; y: number }) => {
      const steps: number[] = [];
      let previous = parameterise(0);
      for (let index = 1; index <= samples; index += 1) {
        const current = parameterise(index / samples);
        steps.push(Math.hypot(current.x - previous.x, current.y - previous.y));
        previous = current;
      }
      return Math.max(...steps) / Math.min(...steps) - 1;
    };

    expect(spread((progress) => interpolateSpatialPosition(curved, progress * 1_000, identityEase)!)).toBeLessThan(1e-4);
    // What it replaced: advancing by curve parameter made the layer cover ground
    // almost twice as fast at the ends of this arch as through its middle.
    expect(spread((progress) => archAtParameter(progress))).toBeGreaterThan(0.9);
  });

  /**
   * Timing changed; geometry did not. Every sample must still lie on the authored
   * arch, checked against its exact implicit relation rather than by fitting a
   * parameter: with m = y/300 the curve gives s = (x/100 + m) / (1 + 2m), so a
   * point is on the curve exactly when that s reproduces both coordinates.
   */
  it("keeps the curve's shape while changing the clock along it", () => {
    const curved = arch();
    for (let index = 0; index <= 200; index += 1) {
      const sample = interpolateSpatialPosition(curved, (index / 200) * 1_000, identityEase)!;
      const m = sample.y / 300;
      const s = (sample.x / 100 + m) / (1 + 2 * m);
      expect(Math.abs(s * (1 - s) - m)).toBeLessThan(1e-12);
      expect(Math.abs(archAtParameter(s).x - sample.x)).toBeLessThan(1e-12);
      expect(Math.abs(archAtParameter(s).y - sample.y)).toBeLessThan(1e-12);
    }
    // Endpoints stay exactly on the authored anchors.
    expect(interpolateSpatialPosition(curved, 0, identityEase)).toEqual({ x: 0, y: 0 });
    expect(interpolateSpatialPosition(curved, 1_000, identityEase)).toEqual({ x: 100, y: 0 });
  });

  it("keeps overshooting easings on the extrapolated curve", () => {
    const curved = arch();
    // An easing that overshoots leaves the authored arc, where there is no
    // distance to measure, so the sampler keeps the polynomial extrapolation it
    // always had: progress passes through as the curve parameter unchanged.
    expect(interpolateSpatialPosition(curved, 500, () => 1.25)).toEqual(archAtParameter(1.25));
    expect(interpolateSpatialPosition(curved, 500, () => -0.25)).toEqual(archAtParameter(-0.25));
    // ...and it is continuous with the reparameterised interior at both ends.
    expect(interpolateSpatialPosition(curved, 500, () => 1)).toEqual({ x: 100, y: 0 });
    expect(interpolateSpatialPosition(curved, 500, () => 0)).toEqual({ x: 0, y: 0 });
  });

  it("keeps handles that lie along the chord exact instead of merely close", () => {
    // Arc-length timing makes a handle parallel to the chord a no-op: it can no
    // longer change the speed, and it never changed the shape. That case is
    // solved in closed form, so round coordinates stay round rather than
    // acquiring solver residue.
    const start = upsertLayerSpatialPosition(layer(), {
      atMs: 0, x: 0, y: 0, easing: "linear",
      spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 300, y: 150 } },
    });
    const aligned = upsertLayerSpatialPosition(start.layer, {
      atMs: 1_000, x: 1_000, y: 500, easing: "linear",
      spatial: { mode: "broken", in: { x: -200, y: -100 }, out: { x: 0, y: 0 } },
    }).layer;

    expect(interpolateSpatialPosition(aligned, 100, identityEase)).toEqual({ x: 100, y: 50 });
    expect(interpolateSpatialPosition(aligned, 250, identityEase)).toEqual({ x: 250, y: 125 });
    expect(interpolateSpatialPosition(aligned, 750, identityEase)).toEqual({ x: 750, y: 375 });
    expect(interpolateSpatialPosition(aligned, 900, identityEase)).toEqual({ x: 900, y: 450 });
  });

  it("leaves single-axis animation on the numeric lane", () => {
    const xOnly: MotionLayer = { ...pairedMove(), keyframes: { "transform.x": pairedMove().keyframes!["transform.x"]! } };

    expect(interpolateSpatialPosition(xOnly, 250, identityEase)).toBeNull();
    expect(effectiveLayerAtMs(xOnly, 250).transform).toMatchObject({ x: 250 });
    expect(effectiveLayerAtMs(xOnly, 750).transform).toMatchObject({ x: 750 });
  });

  it("samples compiled tracking stabilization lanes at their authored linear rate", async () => {
    // Resolved from this module rather than the process cwd so the fixture is
    // found whether vitest is launched from the package or the workspace root.
    const analysis = JSON.parse(
      await readFile(fileURLToPath(new URL("../../../fixtures/tracking/similarity-known.tracking.json", import.meta.url)), "utf8"),
    ) as TrackingAnalysis;
    const [segment] = compileTrackingStabilization({ analysis, targetLayerId: "plate" }).segments;
    // Compiled stabilization emits aligned linear X/Y lanes with no tangent
    // metadata, so every tracked layer took the collapsed-cubic path.
    const stabilized: MotionLayer = {
      id: "plate",
      type: "shape",
      startMs: 0,
      durationMs: 1_000,
      keyframes: {
        "transform.x": segment.keyframes["transform.x"],
        "transform.y": segment.keyframes["transform.y"],
      },
    };

    expect(segment.keyframes["transform.x"]).toMatchObject([{ atMs: 0, value: 0 }, { atMs: 100, value: -10 }]);
    expect(effectiveLayerAtMs(stabilized, 25).transform).toMatchObject({ x: -2.5, y: -1.25 });
    expect(effectiveLayerAtMs(stabilized, 50).transform).toMatchObject({ x: -5, y: -2.5 });
    expect(effectiveLayerAtMs(stabilized, 75).transform).toMatchObject({ x: -7.5, y: -3.75 });
  });
});
