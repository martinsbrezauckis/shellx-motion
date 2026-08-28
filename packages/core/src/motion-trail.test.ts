import { describe, expect, it } from "vitest";
import { BROWSER_CAPABILITY, NATIVE_CAPABILITY, matchRendererCapability, requiredLayerFeatures } from "./capabilities";
import { createMotionParticleEvaluator } from "./particle-evaluator";
import {
  MAX_ACTIVE_TRAIL_VERTICES,
  MotionTrailDrawBudgetError,
  evaluateMotionTrail,
  planMotionTrailStroke,
} from "./motion-trail";
import { inspectMotionTrailBudget, validateMotionTrailLayers } from "./motion-trail-validation";
import { setTimelineLayerRichControl } from "./rich-controls";
import type { MotionDocument, MotionLayer } from "./types";
import { loadSchema, validateDocument } from "./validate";

describe("bounded motion trails", () => {
  it("samples ordered point history deterministically with a newer-vertex taper", () => {
    const layer = pointTrailLayer();
    const first = evaluateMotionTrail({ layer, atMs: 1_000 });
    const second = evaluateMotionTrail({ layer, atMs: 1_000 });

    expect(first).toEqual(second);
    expect(first.vertices).toBe(3);
    expect(first.segments).toEqual([
      { x0: 50, y0: 20, x1: 75, y1: 20, width: 6, opacity: 0.5, color: "#8dfcff" },
      { x0: 75, y0: 20, x1: 100, y1: 20, width: 6, opacity: 1, color: "#8dfcff" }
    ]);
  });

  it("starts particle history at the current cycle and attaches trails to particle centres", () => {
    const layer = particleTrailLayer();
    const atMs = 550;
    const evaluator = createMotionParticleEvaluator({ emitter: layer.emitter!, atMs, startMs: layer.startMs, width: 100, height: 100 });
    const cycleStart = evaluator.cycleStartAt(0, atMs);
    const born = evaluator.sampleAt(0, cycleStart);
    const head = evaluator.sampleAt(0, atMs);
    const geometry = evaluateMotionTrail({ layer, atMs, particleDimensions: { width: 100, height: 100 } });

    expect(geometry.vertices).toBe(3);
    expect(geometry.segments[0]).toMatchObject({ x0: born.x + born.size / 2, y0: born.y + born.size / 2 });
    expect(geometry.segments.at(-1)).toMatchObject({ x1: head.x + head.size / 2, y1: head.y + head.size / 2, opacity: 1 });
    expect(geometry.segments[0]!.x0).not.toBe(evaluator.sampleAt(0, Math.max(0, cycleStart - 1)).x + born.size / 2);
  });

  it("keeps transformed widths exact, accounts for radius at clip edges, rotates work, and refuses excessive CPU strokes", () => {
    const wide = planMotionTrailStroke({
      segments: [{ x0: -10, y0: 10, x1: -10, y1: 11, width: 400, opacity: 1 }],
      transform: { x: 0, y: 0, scale: 1, originX: 0, originY: 0 },
      clip: { width: 100, height: 100 }
    });
    expect(wide.segments).toHaveLength(1);
    expect(wide.segments[0]!.width).toBe(400);

    const rotated = planMotionTrailStroke({
      segments: [{ x0: 5, y0: 0, x1: 15, y1: 0, width: 2, opacity: 1 }],
      transform: { x: 10, y: 10, scale: 1, originX: 0, originY: 0, rotation: 90 },
      clip: { width: 100, height: 100 }
    });
    expect(rotated.segments[0]).toMatchObject({ x0: 10, y0: 15, x1: 10, y1: 25 });

    expect(() => planMotionTrailStroke({
      segments: [{ x0: 0, y0: 0, x1: 10_000, y1: 0, width: 500, opacity: 1 }],
      transform: { x: 0, y: 0, scale: 1, originX: 0, originY: 0 },
      clip: { width: 10_000, height: 1_000 }
    })).toThrow(expect.objectContaining({ code: "trail_draw_budget_exceeded" } satisfies Partial<MotionTrailDrawBudgetError>));
  });

  it("validates only plain data, bounded owners, and the concurrent vertex ceiling without reading accessors", async () => {
    const schema = await loadSchema("motion");
    const accepted = await validateDocument(schema, motionWith(pointTrailLayer()));
    expect(accepted).toEqual({ ok: true });
    expect(requiredLayerFeatures(pointTrailLayer())).toContain("effect.trail");
    expect(matchRendererCapability(motionWith(pointTrailLayer()), BROWSER_CAPABILITY)).toMatchObject({ ok: true, lane: "browser" });
    expect(matchRendererCapability(motionWith(pointTrailLayer()), NATIVE_CAPABILITY)).toMatchObject({ ok: true, lane: "native" });

    const wrongOwner = { ...pointTrailLayer(), type: "shape" };
    const unknownTrailField = { ...pointTrailLayer(), effects: { trail: { durationMs: 200, samples: 3, formula: "not-data" } } };
    const keyframed = { ...pointTrailLayer(), keyframes: { "effects.trail.durationMs": [{ atMs: 0, value: 200 }] } };
    for (const layer of [wrongOwner, unknownTrailField, keyframed]) {
      const result = await validateDocument(schema, motionWith(layer));
      expect(result.ok).toBe(false);
    }

    let trailGetterRead = false;
    const direct = pointTrailLayer() as unknown as Record<string, unknown>;
    const effects = direct.effects as Record<string, unknown>;
    Object.defineProperty(effects, "trail", {
      enumerable: true,
      get() { trailGetterRead = true; throw new Error("trail getter must not run"); }
    });
    const directErrors: Array<{ path: string; message: string }> = [];
    validateMotionTrailLayers([direct], directErrors);
    expect(trailGetterRead).toBe(false);
    expect(directErrors).toContainEqual(expect.objectContaining({ path: "/layers/0/effects/trail", message: "must be a data property" }));

    const maximum = Math.floor(MAX_ACTIVE_TRAIL_VERTICES / 2);
    const overflow = pointTrailLayer({
      pointCloud: { points: Array.from({ length: maximum + 1 }, () => ({ x: 0, y: 0 })) },
      effects: { trail: { durationMs: 100, samples: 2 } }
    });
    const budgetErrors: Array<{ path: string; message: string }> = [];
    validateMotionTrailLayers([overflow], budgetErrors);
    expect(budgetErrors).toContainEqual(expect.objectContaining({ path: "/layers", message: expect.stringContaining("concurrent trail vertex budget") }));
    expect(inspectMotionTrailBudget([pointTrailLayer()])).toMatchObject({ activeVertexCeiling: 3, activeSegmentCeiling: 2, longestDurationMs: 500, maxSamples: 3 });
  });

  it("exposes only static rich trail fields on their existing owner", () => {
    const duration = setTimelineLayerRichControl(motionWith(pointTrailLayer()), {
      layerId: "points", path: "effects.trail.durationMs", value: 750
    });
    expect(duration.layer.effects?.trail?.durationMs).toBe(750);
    expect(() => setTimelineLayerRichControl(motionWith(pointTrailLayer()), {
      layerId: "points", path: "effects.trail.samples", value: 9
    })).toThrow("must be between 2 and 8");
    expect(() => setTimelineLayerRichControl(motionWith({ ...pointTrailLayer(), type: "shape" }), {
      layerId: "points", path: "effects.trail.durationMs", value: 100
    })).toThrow("only on particles and points");
  });
});

function pointTrailLayer(overrides: Partial<MotionLayer> = {}): MotionLayer {
  return {
    id: "points",
    type: "points",
    startMs: 0,
    durationMs: 1_100,
    pointCloud: {
      points: [{ x: 0, y: 20, color: "#8dfcff", size: 6, opacity: 1 }],
      samples: [{ atMs: 0, positions: [{ x: 0, y: 20 }] }, { atMs: 1_000, positions: [{ x: 100, y: 20 }] }]
    },
    effects: { trail: { durationMs: 500, samples: 3 } },
    ...overrides
  };
}

function particleTrailLayer(): MotionLayer {
  return {
    id: "particles",
    type: "particles",
    startMs: 0,
    durationMs: 1_100,
    emitter: {
      seed: 14,
      count: 1,
      lifetimeMs: 200,
      color: "#ffffff",
      minSize: 10,
      maxSize: 10,
      minSpeed: 80,
      maxSpeed: 80,
      direction: 0,
      spread: 0,
      fadeOut: false
    },
    effects: { trail: { durationMs: 500, samples: 3 } }
  };
}

function motionWith(layer: MotionLayer): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "trail_probe",
    name: "Trail probe",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 100,
    background: "#000000",
    assets: [],
    layers: [layer],
    provenance: { sourceApp: "shellx-motion", createdBy: "trail-test" }
  };
}
