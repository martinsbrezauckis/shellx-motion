import { describe, expect, it } from "vitest";
import {
  DEFAULT_POINT_OPACITY,
  DEFAULT_POINT_SIZE,
  effectivePointCloudAtMs,
  MAX_POINT_CLOUD_BYTES_PER_LAYER,
  MAX_POINTS_PER_LAYER,
  MAX_POINT_SAMPLES_PER_LAYER,
  MAX_POINT_STATE_RECORDS_PER_LAYER,
  type MotionPointCloud,
} from "./motion-points";
import { loadSchema, validateDocument } from "./validate";

describe("bounded ordered points layers", () => {
  it("resolves stable index ordering, linear samples, and clamped endpoints deterministically", () => {
    const cloud: MotionPointCloud = {
      points: [
        { x: 10, y: 20, color: "#ff0000", size: 4, opacity: 0.5 },
        { x: 80, y: 10 },
      ],
      samples: [
        { atMs: 100, positions: [{ x: 10, y: 20 }, { x: 80, y: 10, size: 6, opacity: 0.2 }] },
        { atMs: 300, positions: [{ x: 30, y: 60, size: 8, opacity: 1 }, { x: 40, y: 70, size: 2, opacity: 0.8 }] },
      ],
    };

    expect(effectivePointCloudAtMs(cloud, 0)).toEqual([
      { x: 10, y: 20, color: "#ff0000", size: 4, opacity: 0.5 },
      { x: 80, y: 10, size: 6, opacity: 0.2 },
    ]);
    expect(effectivePointCloudAtMs(cloud, 200)).toEqual([
      { x: 20, y: 40, color: "#ff0000", size: 6, opacity: 0.75 },
      { x: 60, y: 40, size: 4, opacity: 0.5 },
    ]);
    expect(effectivePointCloudAtMs(cloud, 999)).toEqual([
      { x: 30, y: 60, color: "#ff0000", size: 8, opacity: 1 },
      { x: 40, y: 70, size: 2, opacity: 0.8 },
    ]);
    expect(effectivePointCloudAtMs({ points: [{ x: 1, y: 2 }] }, 0)).toEqual([
      { x: 1, y: 2, size: DEFAULT_POINT_SIZE, opacity: DEFAULT_POINT_OPACITY },
    ]);
  });

  it("admits a 4,201-point swarm with bounded samples through the public schema and semantic validator", async () => {
    const schema = await loadSchema("motion");
    const points = Array.from({ length: 4_201 }, (_item, index) => ({ x: index % 1920, y: Math.floor(index / 1920), size: 1 }));
    const samples = Array.from({ length: MAX_POINT_SAMPLES_PER_LAYER }, (_item, sampleIndex) => ({
      atMs: sampleIndex * 80,
      positions: points.map((point, index) => ({ x: point.x + sampleIndex, y: point.y + (index % 3), size: 1, opacity: 1 })),
    }));
    const result = await validateDocument(schema, motionWith({
      id: "swarm", type: "points", startMs: 0, durationMs: 1000,
      pointCloud: { points, samples },
    }));
    expect(result).toEqual({ ok: true });
  });

  it("admits the 65,536-point portable package maximum before host-specific render admission", async () => {
    const schema = await loadSchema("motion");
    const result = await validateDocument(schema, motionWith({
      id: "maximum-static-cloud", type: "points", startMs: 0, durationMs: 1000,
      pointCloud: { points: Array.from({ length: MAX_POINTS_PER_LAYER }, (_entry, index) => ({ x: index, y: 0 })) },
    }));
    expect(result).toEqual({ ok: true });
  });

  it("refuses non-deterministic sample shape, timing, unproven sizing, and unsafe aggregate budgets", async () => {
    const schema = await loadSchema("motion");
    const invalid = motionWith({
      id: "bad", type: "points", startMs: 100, durationMs: 200, width: 10,
      transform: { width: 20 },
      pointCloud: {
        points: [{ x: 0, y: 0 }],
        samples: [
          { atMs: 200, positions: [{ x: 0, y: 0, color: "#ffffff" }] },
          { atMs: 200, positions: [] },
        ],
      },
    });
    const result = await validateDocument(schema, invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/layers/0", message: expect.stringContaining("width and height") }),
      expect.objectContaining({ path: "/layers/0/transform", message: expect.stringContaining("transform width") }),
      expect.objectContaining({ path: "/layers/0/pointCloud/samples/0/positions/0/color", message: expect.stringContaining("static") }),
      expect.objectContaining({ path: "/layers/0/pointCloud/samples/1/atMs", message: expect.stringContaining("strictly increasing") }),
      expect.objectContaining({ path: "/layers/0/pointCloud/samples/1/positions", message: expect.stringContaining("exactly one") }),
    ]));

    const oversized = motionWith({
      id: "oversized", type: "points", startMs: 0, durationMs: 1000,
      pointCloud: { points: Array.from({ length: MAX_POINTS_PER_LAYER + 1 }, () => ({ x: 0, y: 0 })) },
    });
    const oversizedResult = await validateDocument(schema, oversized);
    expect(oversizedResult.ok).toBe(false);
    if (!oversizedResult.ok) expect(oversizedResult.errors).toContainEqual(expect.objectContaining({ path: "/layers/0/pointCloud/points" }));
  });

  it("caps canonical payload bytes and leaves the state-record ceiling source-visible", async () => {
    const schema = await loadSchema("motion");
    const oversized = motionWith({
      id: "too-many-bytes", type: "points", startMs: 0, durationMs: 1000,
      pointCloud: { points: [{ x: 0, y: 0 }], "x-padding": "a".repeat(MAX_POINT_CLOUD_BYTES_PER_LAYER) },
    });
    const result = await validateDocument(schema, oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.objectContaining({ path: "/layers/0/pointCloud", message: expect.stringContaining("payload") }));
    expect(MAX_POINT_STATE_RECORDS_PER_LAYER).toBe(524_288);
  });
});

function motionWith(layer: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_points",
    name: "Points test",
    durationMs: 1_000,
    fps: 25,
    width: 1_920,
    height: 1_080,
    layers: [layer],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
  };
}
