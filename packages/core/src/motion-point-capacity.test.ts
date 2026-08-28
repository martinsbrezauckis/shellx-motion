import { describe, expect, it } from "vitest";
import { resolveMotionHostRenderCapacity } from "./host-render-capacity";
import {
  assertMotionPointCapacity,
  motionPointCapacityEvidence,
  MotionPointCapacityError,
} from "./motion-point-capacity";

const GIB = 1024 ** 3;

describe("host-admitted point capacity", () => {
  it("accepts dense layers on a high-memory host and preserves exact usage", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 64 * GIB, freeMemoryBytes: 48 * GIB, logicalCpuCount: 16 },
    });
    const layers = [pointLayer(50_000)];
    expect(assertMotionPointCapacity(layers, capacity)).toMatchObject({
      status: "fit",
      tier: "maximum",
      usage: { maxPointsInLayer: 50_000, totalPoints: 50_000 },
      limits: { maxPointsPerLayer: 65_536 },
    });
  });

  it("refuses the same package on a portable host without truncating it", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 16 * GIB, freeMemoryBytes: 7 * GIB, logicalCpuCount: 8 },
    });
    const layers = [pointLayer(50_000)];
    const evidence = motionPointCapacityEvidence(layers, capacity);
    expect(evidence).toMatchObject({
      status: "refused",
      tier: "portable",
      usage: { maxPointsInLayer: 50_000 },
      limits: { maxPointsPerLayer: 8_192 },
    });
    expect(() => assertMotionPointCapacity(layers, capacity)).toThrow(expect.objectContaining({
      code: "job_input_budget_exceeded",
      capacityCode: "point_capacity_exceeded",
      pointCapacity: evidence,
    } satisfies Partial<MotionPointCapacityError>));
  });

  it("accounts for sampled state records as well as head count", () => {
    const capacity = resolveMotionHostRenderCapacity({
      env: {},
      facts: { totalMemoryBytes: 32 * GIB, freeMemoryBytes: 24 * GIB, logicalCpuCount: 8 },
    });
    const layer = pointLayer(16_000);
    layer.pointCloud.samples = Array.from({ length: 12 }, (_entry, index) => ({
      atMs: index,
      positions: Array.from({ length: 16_000 }, () => ({ x: 0, y: 0 })),
    }));
    expect(motionPointCapacityEvidence([layer], capacity)).toMatchObject({
      status: "refused",
      usage: { maxPointsInLayer: 16_000, maxStateRecordsInLayer: 208_000 },
    });
  });
});

function pointLayer(count: number): {
  type: "points";
  pointCloud: { points: Array<{ x: number; y: number }>; samples?: unknown[] };
} {
  return {
    type: "points",
    pointCloud: { points: Array.from({ length: count }, (_entry, index) => ({ x: index, y: 0 })) },
  };
}
