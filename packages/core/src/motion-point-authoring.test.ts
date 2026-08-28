import { describe, expect, it } from "vitest";
import {
  MAX_POINT_INSPECTION_POINTS,
  deleteMotionPoint,
  deleteMotionPointRange,
  inspectMotionPointRange,
  inspectMotionPointTrajectory,
  moveMotionPoint,
  upsertMotionPoint,
} from "./motion-point-authoring";
import type { MotionDocument, MotionLayer } from "./types";

function pointsLayer(): MotionLayer {
  return {
    id: "stars",
    type: "points",
    startMs: 0,
    durationMs: 1_000,
    effects: { trail: { durationMs: 300, samples: 3 } },
    pointCloud: {
      points: [
        { x: 1, y: 2, color: "#ff0000", size: 2 },
        { x: 3, y: 4, color: "#00ff00", size: 3 },
        { x: 5, y: 6, color: "#0000ff", size: 4 },
      ],
      samples: [
        { atMs: 100, positions: [{ x: 11, y: 12 }, { x: 13, y: 14 }, { x: 15, y: 16 }] },
        { atMs: 900, positions: [{ x: 21, y: 22 }, { x: 23, y: 24 }, { x: 25, y: 26 }] },
      ],
    },
  };
}

function motion(layer: MotionLayer = pointsLayer()): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "point_authoring",
    name: "Point authoring",
    durationMs: 1_000,
    fps: 25,
    width: 1920,
    height: 1080,
    layers: [layer, { id: "other", type: "shape", startMs: 0, durationMs: 1_000, shape: "ellipse" }],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
  };
}

describe("point authoring structural leaves", () => {
  it("replaces an existing stable point and all supplied authored sample positions without mutating the source", () => {
    const source = motion();
    const before = structuredClone(source);
    const result = upsertMotionPoint(source, {
      layerId: "stars",
      index: 1,
      point: { x: 30, y: 40, color: "#ffffff", size: 6, opacity: 0.5 },
      samplePositions: [{ x: 130, y: 140, size: 5 }, { x: 230, y: 240, opacity: 0.25 }],
    });

    expect(result.action).toBe("replaced");
    expect(result.index).toBe(1);
    expect(result.layer.pointCloud?.points[1]).toEqual({ x: 30, y: 40, color: "#ffffff", size: 6, opacity: 0.5 });
    expect(result.layer.pointCloud?.samples?.map((sample) => sample.positions[1])).toEqual([
      { x: 130, y: 140, size: 5 }, { x: 230, y: 240, opacity: 0.25 },
    ]);
    expect(result.layer.pointCloud?.points.map((point) => point.color)).toEqual(["#ff0000", "#ffffff", "#0000ff"]);
    expect(result.changedPaths).toEqual([
      "/layers/stars/pointCloud/points/1",
      "/layers/stars/pointCloud/samples/0/positions/1",
      "/layers/stars/pointCloud/samples/1/positions/1",
    ]);
    expect(source).toEqual(before);
    expect(result.motion.layers[1]).not.toBe(source.layers[1]);
  });

  it("requires explicit insertion and an exactly aligned sample-position vector", () => {
    const source = motion();
    expect(() => upsertMotionPoint(source, {
      layerId: "stars", index: 3, point: { x: 7, y: 8 },
    })).toThrow("0..2");
    expect(() => upsertMotionPoint(source, {
      layerId: "stars", index: 1, insert: true, point: { x: 7, y: 8 },
    })).toThrow("requires one samplePositions entry");
    expect(() => upsertMotionPoint(source, {
      layerId: "stars", index: 1, insert: true, point: { x: 7, y: 8 }, samplePositions: [{ x: 70, y: 80 }],
    })).toThrow("exactly 2 entries");

    const inserted = upsertMotionPoint(source, {
      layerId: "stars", index: 1, insert: true, point: { x: 7, y: 8, color: "#123456" },
      samplePositions: [{ x: 70, y: 80 }, { x: 170, y: 180 }],
    });
    expect(inserted.action).toBe("inserted");
    expect(inserted.layer.pointCloud?.points.map((point) => point.x)).toEqual([1, 7, 3, 5]);
    expect(inserted.layer.pointCloud?.samples?.map((sample) => sample.positions.map((position) => position.x))).toEqual([
      [11, 70, 13, 15], [21, 170, 23, 25],
    ]);

    const baseOnly = upsertMotionPoint(source, { layerId: "stars", index: 0, point: { x: 99, y: 98 } });
    expect(baseOnly.changedPaths).toEqual(["/layers/stars/pointCloud/points/0"]);
  });

  it("moves ordered identity and sample positions in lockstep", () => {
    const result = moveMotionPoint(motion(), { layerId: "stars", fromIndex: 0, toIndex: 2 });
    expect(result.action).toBe("moved");
    expect(result.layer.pointCloud?.points.map((point) => point.color)).toEqual(["#00ff00", "#0000ff", "#ff0000"]);
    expect(result.layer.pointCloud?.samples?.map((sample) => sample.positions.map((position) => position.x))).toEqual([
      [13, 15, 11], [23, 25, 21],
    ]);
    expect(() => moveMotionPoint(motion(), { layerId: "stars", fromIndex: 1, toIndex: 1 })).toThrow("did not change");
  });

  it("deletes exact half-open ranges across base and samples, and refuses an empty resulting cloud", () => {
    const result = deleteMotionPointRange(motion(), { layerId: "stars", startIndex: 1, endIndexExclusive: 3 });
    expect(result.action).toBe("deleted");
    expect(result.range).toEqual({ startIndex: 1, endIndexExclusive: 3 });
    expect(result.layer.pointCloud?.points).toEqual([{ x: 1, y: 2, color: "#ff0000", size: 2 }]);
    expect(result.layer.pointCloud?.samples?.map((sample) => sample.positions)).toEqual([
      [{ x: 11, y: 12 }], [{ x: 21, y: 22 }],
    ]);
    expect(() => deleteMotionPointRange(motion(), { layerId: "stars", startIndex: 0, endIndexExclusive: 3 })).toThrow("leave at least one");
    expect(() => deleteMotionPointRange(motion(), { layerId: "stars", startIndex: 2, endIndexExclusive: 2 })).toThrow("half-open interval");

    const single = deleteMotionPoint(motion(), { layerId: "stars", index: 1 });
    expect(single.layer.pointCloud?.points.map((point) => point.x)).toEqual([1, 5]);
  });

  it("refuses malformed edits and locked ownership before cloning or modifying the source", () => {
    const source = motion();
    const before = structuredClone(source);
    expect(() => upsertMotionPoint(source, {
      layerId: "stars", index: 0, point: { x: Number.NaN, y: 2 },
    })).toThrow("finite number");
    expect(() => upsertMotionPoint(source, {
      layerId: "stars", index: 0, point: { x: 1, y: 2, arbitrary: true } as unknown as { x: number; y: number },
    })).toThrow("does not support arbitrary");
    expect(() => upsertMotionPoint(source, {
      layerId: "stars", index: 0, point: { x: 1, y: 2 }, extra: "dropped",
    } as unknown as Parameters<typeof upsertMotionPoint>[1])).toThrow("does not support extra");
    expect(source).toEqual(before);

    const misaligned = motion();
    misaligned.layers[0].pointCloud?.samples?.[0].positions.pop();
    const misalignedBefore = structuredClone(misaligned);
    expect(() => deleteMotionPoint(misaligned, { layerId: "stars", index: 0 })).toThrow("valid point payload");
    expect(misaligned).toEqual(misalignedBefore);

    const locked = motion({ ...pointsLayer(), locked: true });
    expect(() => deleteMotionPoint(locked, { layerId: "stars", index: 0 })).toThrow("locked layer");
    const tracked = motion();
    tracked.tracks = [{ id: "locked-track", type: "video", locked: true, layerIds: ["stars"] }];
    expect(() => deleteMotionPoint(tracked, { layerId: "stars", index: 0 })).toThrow("locked track");
  });

  it("refuses hostile direct Point data before reading a frozen source or dropping caller-owned fields", () => {
    const source = motion();
    const before = structuredClone(source);
    freezeTree(source);

    const symbolPoint: Record<PropertyKey, unknown> = { x: 1, y: 2 };
    symbolPoint[Symbol("hidden")] = true;
    const hiddenPoint: Record<string, unknown> = { x: 1, y: 2 };
    Object.defineProperty(hiddenPoint, "dropped", { enumerable: false, value: true });
    let getterReads = 0;
    const accessorPoint: Record<string, unknown> = { y: 2 };
    Object.defineProperty(accessorPoint, "x", { enumerable: true, get: () => { getterReads += 1; return 1; } });
    const cyclicPoint: Record<string, unknown> = { x: 1, y: 2 };
    cyclicPoint.loop = cyclicPoint;
    const sparsePositions = new Array<{ x: number; y: number }>(2);
    sparsePositions[0] = { x: 1, y: 2 };
    const proxy = new Proxy({ layerId: "stars", index: 0, point: { x: 1, y: 2 } }, {
      ownKeys: () => { throw new Error("proxy reflection must remain contained"); },
    });

    const hostile: Array<[unknown, RegExp]> = [
      [{ layerId: "stars", index: 0, point: symbolPoint }, /symbol keys/],
      [{ layerId: "stars", index: 0, point: hiddenPoint }, /enumerable data properties/],
      [{ layerId: "stars", index: 0, point: accessorPoint }, /data properties/],
      [{ layerId: "stars", index: 0, point: cyclicPoint }, /cycles/],
      [{ layerId: "stars", index: 0, point: { x: 1, y: 2 }, samplePositions: sparsePositions }, /dense data array/],
      [proxy, /plain JSON data/],
    ];
    for (const [input, expected] of hostile) {
      expect(() => upsertMotionPoint(source, input as Parameters<typeof upsertMotionPoint>[1])).toThrow(expected);
    }
    expect(getterReads).toBe(0);
    expect(Object.isFrozen(source)).toBe(true);
    expect(source).toEqual(before);
  });

  it("bounds inspection to authored state and declares that no hidden trail history exists", () => {
    const source = motion();
    const range = inspectMotionPointRange(source, { layerId: "stars", startIndex: 1, endIndexExclusive: 3 });
    expect(range.points.map((point) => point.color)).toEqual(["#00ff00", "#0000ff"]);
    expect(range.samples.map((sample) => sample.positions.map((position) => position.x))).toEqual([[13, 15], [23, 25]]);
    expect(range.declaredTrail).toEqual({ durationMs: 300, samples: 3 });
    expect(range.trailBudget.activeVertexCeiling).toBe(9);
    range.points[0].x = 999;
    expect(source.layers[0].pointCloud?.points[1].x).toBe(3);

    const trajectory = inspectMotionPointTrajectory(motion(), { layerId: "stars", index: 1 });
    expect(trajectory).toMatchObject({
      point: { x: 3, y: 4, color: "#00ff00" },
      samples: [{ atMs: 100, position: { x: 13, y: 14 } }, { atMs: 900, position: { x: 23, y: 24 } }],
      history: "not_retained",
      declaredTrail: { durationMs: 300, samples: 3 },
    });

    const dense = motion({
      id: "dense", type: "points", startMs: 0, durationMs: 1_000,
      pointCloud: { points: Array.from({ length: MAX_POINT_INSPECTION_POINTS + 1 }, (_entry, index) => ({ x: index, y: 0 })) },
    });
    expect(() => inspectMotionPointRange(dense, {
      layerId: "dense", startIndex: 0, endIndexExclusive: MAX_POINT_INSPECTION_POINTS + 1,
    })).toThrow(`at most ${MAX_POINT_INSPECTION_POINTS}`);

    const locked = motion({ ...pointsLayer(), locked: true });
    expect(inspectMotionPointTrajectory(locked, { layerId: "stars", index: 0 }).point).toEqual({
      x: 1, y: 2, color: "#ff0000", size: 2,
    });
  });
});

function freezeTree<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) freezeTree(nested);
  }
  return Object.freeze(value);
}
