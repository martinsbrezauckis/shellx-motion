import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMotionPackage, MOTION_SHAPE_GEOMETRY_SCHEMA, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import {
  dispatchTimelineShapeGeometryAuthoringCommand,
  type TimelineShapeGeometryAuthoringCore,
} from "./timeline-shape-geometry-authoring.js";
import {
  isTimelineShapeGeometryCommand,
  readTimelineShapeGeometryIntent,
  TIMELINE_SHAPE_GEOMETRY_COMMANDS,
} from "./timeline-shape-geometry.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;
const geometry = {
  schema: MOTION_SHAPE_GEOMETRY_SCHEMA,
  kind: "polygon",
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
} as const;

describe("timeline shape geometry Debug intents", () => {
  it("parses the complete closed command vocabulary without dropping field-specific input", () => {
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.inspect, { packageRoot: "/package", layerId: "shape" }))
      .toEqual({ ok: true, intent: { kind: "inspect", layerId: "shape" } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.replace, common({ geometry })))
      .toEqual({ ok: true, intent: { kind: "replace", layerId: "shape", geometry } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointUpdate, common({ index: 1, point: { x: 40, y: 50 } })))
      .toEqual({ ok: true, intent: { kind: "point-update", layerId: "shape", index: 1, point: { x: 40, y: 50 } } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointInsert, common({ index: 1, point: { x: 30, y: 30 } })))
      .toEqual({ ok: true, intent: { kind: "point-insert", layerId: "shape", index: 1, point: { x: 30, y: 30 } } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointMove, common({ fromIndex: 1, toIndex: 2 })))
      .toEqual({ ok: true, intent: { kind: "point-move", layerId: "shape", fromIndex: 1, toIndex: 2 } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointRangeDelete, common({ startIndex: 1, endIndexExclusive: 2 })))
      .toEqual({ ok: true, intent: { kind: "point-range-delete", layerId: "shape", startIndex: 1, endIndexExclusive: 2 } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.arcUpdate, common({ center: { x: 50, y: 50 }, radius: 20 })))
      .toEqual({ ok: true, intent: { kind: "arc-update", layerId: "shape", center: { x: 50, y: 50 }, radius: 20 } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pathReplace, common({ data: "M 0 0 L 10 10 Z" })))
      .toEqual({ ok: true, intent: { kind: "path-replace", layerId: "shape", data: "M 0 0 L 10 10 Z" } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.migrateLegacy, common()))
      .toEqual({ ok: true, intent: { kind: "migrate-legacy", layerId: "shape" } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashSet, common({ strokeDasharray: [4, 2, 1], strokeDashoffset: -1 })))
      .toEqual({ ok: true, intent: { kind: "dash-set", layerId: "shape", strokeDasharray: [4, 2, 1], strokeDashoffset: -1 } });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashRemove, common()))
      .toEqual({ ok: true, intent: { kind: "dash-remove", layerId: "shape" } });
    expect(isTimelineShapeGeometryCommand("motion.timeline.shape.geometry.migrate-legacy")).toBe(false);
  });

  it("refuses unknown, malformed, accessor, and no-op-shaped requests before package loading", async () => {
    let packageLoads = 0;
    const hostile = await dispatchTimelineShapeGeometryAuthoringCommand(
      TIMELINE_SHAPE_GEOMETRY_COMMANDS.replace,
      common({ geometry: { ...geometry, accidental: true } }),
      unavailableServices(() => { packageLoads += 1; }),
    );
    expect(hostile).toMatchObject({ ok: false, error: { code: "invalid_args", message: "geometry has unknown field accidental." } });
    expect(packageLoads).toBe(0);
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointRangeDelete, common({ startIndex: 2, endIndexExclusive: 2 })))
      .toEqual({ ok: false, problem: "endIndexExclusive must be greater than startIndex for the half-open [startIndex, endIndexExclusive) range." });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.arcUpdate, common()))
      .toEqual({ ok: false, problem: "Arc update requires at least one changed control." });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pathReplace, common({ data: "M 0 0", force: true })))
      .toEqual({ ok: false, problem: "Unknown argument: force." });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashSet, common({ strokeDasharray: [4, Number.NaN] })))
      .toEqual({ ok: false, problem: "Arguments.strokeDasharray[1] must be finite." });
    const accessor = common({ data: "M 0 0" });
    Object.defineProperty(accessor, "data", { enumerable: true, get: () => "M 10 10" });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.pathReplace, accessor))
      .toEqual({ ok: false, problem: "Arguments.data must be a data property." });
    const arrayAccessor = common({ geometry: structuredClone(geometry) as unknown as Record<string, unknown> });
    const points = (arrayAccessor.geometry as { points: Array<{ x: number; y: number }> }).points;
    Object.defineProperty(points, "0", { enumerable: true, get: () => ({ x: 0, y: 0 }) });
    expect(readTimelineShapeGeometryIntent(TIMELINE_SHAPE_GEOMETRY_COMMANDS.replace, arrayAccessor))
      .toEqual({ ok: false, problem: "Arguments.geometry.points[0] must be a data property." });
  });

  it("uses the public Core geometry-authoring export on the production inspection path", async () => {
    const source = await mkdtemp(join(tmpdir(), "shellx-motion-debug-shape-geometry-inspect-"));
    try {
      const result = await dispatchTimelineShapeGeometryAuthoringCommand(
        TIMELINE_SHAPE_GEOMETRY_COMMANDS.inspect,
        { packageRoot: source, layerId: "shape" },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => inMemoryPackage(source) },
      );
      expect(result).toMatchObject({
        ok: true,
        result: { inspection: { layerId: "shape", source: "v1", geometry: { kind: "polygon" } } },
      });
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  atomicCOW("keeps inspect read-only and publishes every mutation as one COW receipt with migration/range evidence", async () => {
    const source = await writePackage();
    const outputs: string[] = [source];
    const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
    const authoring = fakeGeometryAuthoring(calls);
    try {
      const inspected = await dispatchTimelineShapeGeometryAuthoringCommand(
        TIMELINE_SHAPE_GEOMETRY_COMMANDS.inspect,
        { packageRoot: source, layerId: "shape" },
        servicesFor(authoring),
      );
      expect(inspected).toMatchObject({ ok: true, result: { inspection: { layerId: "shape", source: "v1" } } });
      expect(await readdir(source)).not.toContain("receipts");

      for (const entry of mutationCases()) {
        const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-shape-geometry-out-"));
        outputs.push(outDir);
        const result = await dispatchTimelineShapeGeometryAuthoringCommand(entry.command, common({ packageRoot: source, outDir, ...entry.args }), servicesFor(authoring));
        expect(result).toMatchObject({ ok: true, result: { action: entry.action, layerId: "shape" } });
        const receipt = JSON.parse(await readFile(join(outDir, "receipts", `${entry.receiptStem}.receipt.json`), "utf8"));
        expect(receipt).toMatchObject({ operation: entry.command.slice("motion.".length), status: "passed", output: { action: entry.action, layerId: "shape" } });
        if (entry.action === "deleted") expect(receipt.output).toMatchObject({ range: { startIndex: 1, endIndexExclusive: 2 }, rangeSemantics: "[startIndex, endIndexExclusive)" });
        if (entry.action === "migrated") expect(receipt.output).toMatchObject({ migration: { from: "legacy-path", to: "path", resolvedContour: { closed: true } } });
        expect((await loadMotionPackage(outDir)).motion.id).toBe("motion_debug_shape_geometry");
      }
      expect(calls.map((call) => call.operation)).toEqual(["inspect", "replace", "point-update", "point-insert", "point-move", "point-range-delete", "arc-update", "path-replace", "migrate-legacy", "dash-set", "dash-remove"]);
    } finally {
      await Promise.all(outputs.map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });
});

function common(values: Record<string, unknown> = {}): Record<string, unknown> {
  return { packageRoot: "/package", outDir: "/out", layerId: "shape", ...values };
}

function inMemoryPackage(root: string): MotionPackage {
  return {
    root,
    manifest: {
      schema: "shellx-motion/package-manifest@1", id: "pkg_debug_shape_geometry", name: "Debug shape geometry",
      motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] },
    },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_debug_shape_geometry", name: "Debug shape geometry",
      durationMs: 500, fps: 30, width: 100, height: 100,
      layers: [{ id: "shape", type: "shape", startMs: 0, durationMs: 500, geometry }], assets: [],
      provenance: { sourceApp: "test", createdBy: "test" },
    },
  } as unknown as MotionPackage;
}

function unavailableServices(onLoad: () => void) {
  return {
    packageLoader: async () => {
      onLoad();
      throw new Error("must not load a package for invalid arguments");
    },
    isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async () => true,
  };
}

function mutationCases() {
  return [
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.replace, args: { geometry }, action: "replaced", receiptStem: "timeline-shape-geometry-replace" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointUpdate, args: { index: 1, point: { x: 40, y: 50 } }, action: "updated", receiptStem: "timeline-shape-geometry-point-update" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointInsert, args: { index: 1, point: { x: 40, y: 50 } }, action: "inserted", receiptStem: "timeline-shape-geometry-point-insert" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointMove, args: { fromIndex: 1, toIndex: 2 }, action: "moved", receiptStem: "timeline-shape-geometry-point-move" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointRangeDelete, args: { startIndex: 1, endIndexExclusive: 2 }, action: "deleted", receiptStem: "timeline-shape-geometry-point-range-delete" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.arcUpdate, args: { radius: 20 }, action: "updated", receiptStem: "timeline-shape-geometry-arc-update" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.pathReplace, args: { data: "M 0 0 L 10 10 Z" }, action: "replaced", receiptStem: "timeline-shape-geometry-path-replace" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.migrateLegacy, args: {}, action: "migrated", receiptStem: "timeline-shape-geometry-migrate-legacy" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashSet, args: { strokeDasharray: [4, 2], strokeDashoffset: 1 }, action: "dash-set", receiptStem: "timeline-shape-geometry-dash-set" },
    { command: TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashRemove, args: {}, action: "dash-removed", receiptStem: "timeline-shape-geometry-dash-remove" },
  ] as const;
}

function fakeGeometryAuthoring(calls: Array<{ operation: string; input: Record<string, unknown> }>): TimelineShapeGeometryAuthoringCore {
  const mutation = (operation: string, action: "replaced" | "updated" | "inserted" | "moved" | "deleted" | "migrated" | "dash-set" | "dash-removed") => (motion: MotionDocument, input: Record<string, unknown>) => {
    calls.push({ operation, input: structuredClone(input) });
    const layer = structuredClone(motion.layers[0]);
    return {
      motion: structuredClone(motion), layerId: layer.id, layer, action, changedPaths: [`/layers/${layer.id}/geometry`],
      ...(operation === "point-range-delete" ? { range: { startIndex: 1, endIndexExclusive: 2 } } : {}),
      ...(operation === "migrate-legacy" ? { migration: { from: "legacy-path" as const, legacyShape: "path" as const, to: "path" as const, resolvedContour: { viewBox: geometry.viewBox, closed: true, vertices: geometry.points } } } : {}),
    };
  };
  return {
    inspectMotionShapeGeometry: (motion, input) => {
      calls.push({ operation: "inspect", input });
      return { layerId: input.layerId, source: "v1", geometry: structuredClone(motion.layers[0].geometry), strokeDash: null, resolved: { closed: true } };
    },
    replaceMotionShapeGeometry: mutation("replace", "replaced"),
    updateMotionShapeGeometryPoint: mutation("point-update", "updated"),
    insertMotionShapeGeometryPoint: mutation("point-insert", "inserted"),
    moveMotionShapeGeometryPoint: mutation("point-move", "moved"),
    deleteMotionShapeGeometryPointRange: mutation("point-range-delete", "deleted"),
    updateMotionShapeGeometryArc: mutation("arc-update", "updated"),
    replaceMotionShapeGeometryPathData: mutation("path-replace", "replaced"),
    migrateLegacyMotionShapeGeometry: mutation("migrate-legacy", "migrated"),
    setMotionShapeGeometryDash: mutation("dash-set", "dash-set"),
    removeMotionShapeGeometryDash: mutation("dash-remove", "dash-removed"),
  };
}

function servicesFor(shapeGeometryAuthoring: TimelineShapeGeometryAuthoringCore) {
  return {
    authoringInputRoots: [tmpdir()], authoringOutputRoots: [tmpdir()], shapeGeometryAuthoring,
    packageLoader: loadMotionPackage,
    isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async (path: string) => (await readdir(path)).length === 0,
  };
}

async function writePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-shape-geometry-source-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_debug_shape_geometry", name: "Debug shape geometry", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] },
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_debug_shape_geometry", name: "Debug shape geometry", durationMs: 500, fps: 30, width: 100, height: 100,
    layers: [{ id: "shape", type: "shape", startMs: 0, durationMs: 500, geometry }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  }, null, 2)}\n`);
  return root;
}
