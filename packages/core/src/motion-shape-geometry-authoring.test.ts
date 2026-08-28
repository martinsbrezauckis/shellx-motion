import { describe, expect, it } from "vitest";
import {
  deleteMotionShapeGeometryPointRange,
  inspectMotionShapeGeometry,
  insertMotionShapeGeometryPoint,
  migrateLegacyMotionShapeGeometry,
  moveMotionShapeGeometryPoint,
  replaceMotionShapeGeometry,
  replaceMotionShapeGeometryPathData,
  updateMotionShapeGeometryArc,
  updateMotionShapeGeometryPoint,
} from "./motion-shape-geometry-authoring";
import { MOTION_SHAPE_GEOMETRY_SCHEMA } from "./motion-shape-geometry";
import type { MotionDocument, MotionLayer, MotionShapeGeometry } from "./types";

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };

function geometry(kind: string, fields: Record<string, unknown>): MotionShapeGeometry {
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind, viewBox: VIEW_BOX, ...fields } as MotionShapeGeometry;
}

function layer(value: MotionShapeGeometry = geometry("polyline", { points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }] })): MotionLayer {
  return {
    id: "ink",
    type: "shape",
    startMs: 0,
    durationMs: 1_000,
    geometry: value,
    style: { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" },
  };
}

function motion(shape: MotionLayer = layer()): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "shape-authoring",
    name: "Shape authoring",
    durationMs: 1_000,
    fps: 25,
    width: 100,
    height: 100,
    layers: [shape, { id: "other", type: "text", text: "Original", startMs: 0, durationMs: 1_000 }],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
  };
}

describe("typed v1 shape geometry authoring", () => {
  it("inspects cloned v1 geometry and replaces only a complete exact record", () => {
    const source = motion();
    const before = structuredClone(source);
    const inspected = inspectMotionShapeGeometry(source, { layerId: "ink" });
    expect(inspected).toMatchObject({ source: "v1", geometry: { kind: "polyline" }, resolved: { kind: "polyline", closed: false } });
    (inspected.geometry as Extract<MotionShapeGeometry, { points: Array<{ x: number; y: number }> }>).points[0].x = 37;
    expect(source).toEqual(before);

    const replaced = replaceMotionShapeGeometry(source, {
      layerId: "ink",
      geometry: geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }),
    });
    expect(replaced).toMatchObject({ action: "replaced", changedPaths: ["/layers/ink/geometry"] });
    expect(replaced.layer.geometry).toEqual(geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }));
    expect(source).toEqual(before);
    expect(() => replaceMotionShapeGeometry(source, {
      layerId: "ink", geometry: structuredClone(source.layers[0].geometry!),
    })).toThrow("did not change");
    expect(source).toEqual(before);
  });

  it("updates a stable point copy-on-write and preserves non-addressed layer state", () => {
    const source = motion();
    const before = structuredClone(source);
    const result = updateMotionShapeGeometryPoint(source, {
      layerId: "ink", index: 1, point: { x: 40, y: 60 },
    });

    expect(result).toMatchObject({ action: "updated", index: 1, changedPaths: ["/layers/ink/geometry/points/1"] });
    expect(result.layer.geometry).toMatchObject({ kind: "polyline", points: [{ x: 0, y: 0 }, { x: 40, y: 60 }, { x: 100, y: 0 }] });
    expect(source).toEqual(before);
    expect(result.motion.layers[1]).not.toBe(source.layers[1]);
  });

  it("inserts, reorders, and half-open deletes only within each contour kind's point limits", () => {
    const inserted = insertMotionShapeGeometryPoint(motion(), {
      layerId: "ink", index: 1, point: { x: 20, y: 20 },
    });
    expect((inserted.layer.geometry as Extract<MotionShapeGeometry, { points: unknown[] }>).points).toEqual([
      { x: 0, y: 0 }, { x: 20, y: 20 }, { x: 50, y: 50 }, { x: 100, y: 0 },
    ]);
    const moved = moveMotionShapeGeometryPoint(inserted.motion, { layerId: "ink", fromIndex: 1, toIndex: 2 });
    expect((moved.layer.geometry as Extract<MotionShapeGeometry, { points: unknown[] }>).points).toEqual([
      { x: 0, y: 0 }, { x: 50, y: 50 }, { x: 20, y: 20 }, { x: 100, y: 0 },
    ]);
    const deleted = deleteMotionShapeGeometryPointRange(moved.motion, {
      layerId: "ink", startIndex: 1, endIndexExclusive: 2,
    });
    expect(deleted.range).toEqual({ startIndex: 1, endIndexExclusive: 2 });
    expect((deleted.layer.geometry as Extract<MotionShapeGeometry, { points: unknown[] }>).points).toEqual([
      { x: 0, y: 0 }, { x: 20, y: 20 }, { x: 100, y: 0 },
    ]);

    const exactLine = motion(layer(geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] })));
    expect(() => insertMotionShapeGeometryPoint(exactLine, {
      layerId: "ink", index: 1, point: { x: 30, y: 30 },
    })).toThrow("cannot exceed 2");
    const polygon = motion(layer(geometry("polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] })));
    expect(() => deleteMotionShapeGeometryPointRange(polygon, {
      layerId: "ink", startIndex: 0, endIndexExclusive: 2,
    })).toThrow("leave at least 3");
  });

  it("refuses degeneracy, self-intersection, unknown fields, and illegal ranges without mutating source data", () => {
    const source = motion(layer(geometry("polygon", {
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    })));
    const before = structuredClone(source);
    expect(() => updateMotionShapeGeometryPoint(source, {
      layerId: "ink", index: 1, point: { x: 0, y: 0 },
    })).toThrow("adjacent duplicate");
    expect(() => moveMotionShapeGeometryPoint(source, { layerId: "ink", fromIndex: 1, toIndex: 2 })).toThrow("self-intersecting");
    expect(() => deleteMotionShapeGeometryPointRange(source, {
      layerId: "ink", startIndex: 1, endIndexExclusive: 1,
    })).toThrow("half-open interval");
    expect(() => replaceMotionShapeGeometry(source, {
      layerId: "ink",
      geometry: { ...geometry("line", { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }), arbitrary: true } as unknown as MotionShapeGeometry,
    })).toThrow("unknown field");
    expect(() => updateMotionShapeGeometryPoint(source, {
      layerId: "ink", index: 0, point: { x: 0, y: 0, ignored: true } as unknown as { x: number; y: number },
    })).toThrow("does not support ignored");
    expect(source).toEqual(before);
  });

  it("updates arc and sector scalars only through their bounded v1 records", () => {
    const source = motion(layer(geometry("sector", {
      center: { x: 50, y: 50 }, radius: 40, innerRadius: 10, startAngleDeg: 0, sweepAngleDeg: 180,
    })));
    const updated = updateMotionShapeGeometryArc(source, {
      layerId: "ink", center: { x: 55, y: 50 }, radius: 45, innerRadius: 12, startAngleDeg: 10,
    });
    expect(updated.layer.geometry).toMatchObject({
      kind: "sector", center: { x: 55, y: 50 }, radius: 45, innerRadius: 12, startAngleDeg: 10,
    });
    const before = structuredClone(updated.motion);
    expect(() => updateMotionShapeGeometryArc(updated.motion, { layerId: "ink", radius: 10 })).toThrow("innerRadius");
    expect(() => updateMotionShapeGeometryArc(source, { layerId: "ink", radius: 40 })).toThrow("did not change");
    expect(updated.motion).toEqual(before);

    const arc = motion(layer(geometry("arc", {
      center: { x: 50, y: 50 }, radius: 40, startAngleDeg: 0, sweepAngleDeg: 90,
    })));
    expect(() => updateMotionShapeGeometryArc(arc, { layerId: "ink", innerRadius: 1 })).toThrow("does not support innerRadius");
    expect(() => updateMotionShapeGeometryArc(arc, { layerId: "ink", center: { x: 5, y: 50 } })).toThrow("radius must stay inside");
  });

  it("replaces path data through the existing resolver and leaves failed source data intact", () => {
    const source = motion(layer(geometry("path", { data: "M 0 0 L 100 0 L 100 100 L 0 100 Z" })));
    const updated = replaceMotionShapeGeometryPathData(source, {
      layerId: "ink", data: "M 10 10 L 90 10 L 90 90 L 10 90 Z",
    });
    expect(updated.layer.geometry).toMatchObject({ kind: "path", data: "M 10 10 L 90 10 L 90 90 L 10 90 Z" });
    const before = structuredClone(updated.motion);
    expect(() => replaceMotionShapeGeometryPathData(updated.motion, {
      layerId: "ink", data: "M 0 0 L 100 100 L 0 100 L 100 0 Z",
    })).toThrow("self-intersecting");
    expect(updated.motion).toEqual(before);
  });

  it("inspects legacy contours but migrates legacy path data only through the explicit contour-preserving operation", () => {
    const legacy: MotionLayer = {
      id: "ink", type: "shape", shape: "freeform", startMs: 0, durationMs: 1_000,
      "x-path": "M 0 0 L 100 0 L 100 100 L 0 100 Z",
      "x-path-viewBox": "0 0 100 100",
      "x-path-fillRule": "nonzero",
      style: { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" },
    };
    const source = motion(legacy);
    const inspected = inspectMotionShapeGeometry(source, { layerId: "ink" });
    expect(inspected).toMatchObject({ source: "legacy", geometry: null, resolved: { kind: "legacy-path", closed: true } });
    expect(() => replaceMotionShapeGeometry(source, {
      layerId: "ink", geometry: geometry("path", { data: "M 0 0 L 100 0 L 100 100 L 0 100 Z" }),
    })).toThrow("migrateLegacy");

    const migrated = migrateLegacyMotionShapeGeometry(source, { layerId: "ink" });
    expect(migrated.migration).toMatchObject({ from: "legacy-path", legacyShape: "freeform", to: "path" });
    expect(migrated.migration?.resolvedContour).toEqual({
      viewBox: inspected.resolved.viewBox, closed: inspected.resolved.closed, vertices: inspected.resolved.vertices,
    });
    expect(migrated.layer).toMatchObject({ geometry: { kind: "path", data: legacy["x-path"] } });
    expect(migrated.layer.shape).toBeUndefined();
    expect(migrated.layer["x-path"]).toBeUndefined();
    expect(inspectMotionShapeGeometry(migrated.motion, { layerId: "ink" }).source).toBe("v1");

    const minimalLayer = structuredClone(legacy);
    minimalLayer.shape = "path";
    delete minimalLayer["x-path-viewBox"];
    delete minimalLayer["x-path-fillRule"];
    const minimalMigration = migrateLegacyMotionShapeGeometry(motion(minimalLayer), { layerId: "ink" });
    expect(minimalMigration.changedPaths).toEqual([
      "/layers/ink/geometry", "/layers/ink/shape", "/layers/ink/x-path",
    ]);
  });

  it("allows inspection of locked geometry but refuses all mutations on locked layers and tracks", () => {
    const locked = motion({ ...layer(), locked: true });
    expect(inspectMotionShapeGeometry(locked, { layerId: "ink" }).resolved.kind).toBe("polyline");
    expect(() => updateMotionShapeGeometryPoint(locked, {
      layerId: "ink", index: 1, point: { x: 40, y: 60 },
    })).toThrow("locked layer");
    const tracked = motion();
    tracked.tracks = [{ id: "shape-track", type: "overlay", locked: true, layerIds: ["ink"] }];
    expect(() => updateMotionShapeGeometryPoint(tracked, {
      layerId: "ink", index: 1, point: { x: 40, y: 60 },
    })).toThrow("locked track");
  });
});
