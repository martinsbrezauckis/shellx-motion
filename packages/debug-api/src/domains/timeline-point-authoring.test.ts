import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMotionPackage, type MotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { debugCommandDefinition } from "../command-registry.js";
import { dispatchTimelinePointAuthoringCommand } from "./timeline-point-authoring.js";
import { isTimelinePointCommand, readTimelinePointIntent, TIMELINE_POINT_COMMANDS } from "./timeline-points.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

describe("timeline point Debug intents", () => {
  it("keeps stable point identity, samples, and half-open ranges explicit across the closed command set", () => {
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.rangeInspect, { packageRoot: "/package", layerId: "stars", startIndex: 0, endIndexExclusive: 2 }))
      .toEqual({ ok: true, intent: { kind: "range-inspect", layerId: "stars", startIndex: 0, endIndexExclusive: 2 } });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.trajectoryInspect, { packageRoot: "/package", layerId: "stars", index: 1 }))
      .toEqual({ ok: true, intent: { kind: "trajectory-inspect", layerId: "stars", index: 1 } });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, common({ index: 1, insert: true, point: { x: 40, y: 50, color: "#ffffff", size: 3, opacity: 0.5 }, samplePositions: [{ x: 41, y: 51 }, { x: 42, y: 52, opacity: 0.4 }] })))
      .toEqual({ ok: true, intent: { kind: "upsert", layerId: "stars", index: 1, insert: true, point: { x: 40, y: 50, color: "#ffffff", size: 3, opacity: 0.5 }, samplePositions: [{ x: 41, y: 51 }, { x: 42, y: 52, opacity: 0.4 }] } });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.move, common({ fromIndex: 0, toIndex: 2 })))
      .toEqual({ ok: true, intent: { kind: "move", layerId: "stars", fromIndex: 0, toIndex: 2 } });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.delete, common({ index: 1 })))
      .toEqual({ ok: true, intent: { kind: "delete", layerId: "stars", index: 1 } });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.rangeDelete, common({ startIndex: 1, endIndexExclusive: 2 })))
      .toEqual({ ok: true, intent: { kind: "range-delete", layerId: "stars", startIndex: 1, endIndexExclusive: 2 } });
    expect(isTimelinePointCommand("motion.timeline.points.point.replace")).toBe(false);
    expect(Object.values(TIMELINE_POINT_COMMANDS).map((command) => debugCommandDefinition(command))).toEqual([
      expect.objectContaining({ permission: "read_motion", mutates: false }),
      expect.objectContaining({ permission: "read_motion", mutates: false }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
    ]);
  });

  it("refuses hostile point requests before package loading, copying, or receipt preparation", async () => {
    let packageLoads = 0;
    const hostile = await dispatchTimelinePointAuthoringCommand(
      TIMELINE_POINT_COMMANDS.upsert,
      common({ index: 0, point: { x: 1, y: 2, arbitrary: true } }),
      unavailableServices(() => { packageLoads += 1; }),
    );
    expect(hostile).toMatchObject({ ok: false, error: { code: "invalid_args", message: "point has unknown field arbitrary." } });
    expect(packageLoads).toBe(0);
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.move, common({ fromIndex: 1, toIndex: 1 })))
      .toEqual({ ok: false, problem: "fromIndex and toIndex must differ for a stable point move." });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.rangeDelete, common({ startIndex: 2, endIndexExclusive: 2 })))
      .toEqual({ ok: false, problem: "endIndexExclusive must be greater than startIndex for the half-open [startIndex, endIndexExclusive) range." });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, common({ index: 0, point: { x: Number.NaN, y: 2 } })))
      .toEqual({ ok: false, problem: "Arguments.point.x must be finite." });
    const accessor = common({ index: 0, point: { x: 1, y: 2 } });
    Object.defineProperty(accessor, "point", { enumerable: true, get: () => ({ x: 1, y: 2 }) });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, accessor))
      .toEqual({ ok: false, problem: "Arguments.point must be a data property." });
  });

  it("treats cyclic, reflective, and non-data Point arguments as invalid before production dispatch touches a package", async () => {
    const valid = common({ index: 0, point: { x: 1, y: 2 } });
    const validBefore = structuredClone(valid);
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, valid)).toMatchObject({ ok: true });
    expect(valid).toEqual(validBefore);

    const cyclicPoint: Record<string, unknown> = { x: 1, y: 2 };
    cyclicPoint.loop = cyclicPoint;
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, common({ index: 0, point: cyclicPoint })))
      .toEqual({ ok: false, problem: "Arguments.point.loop must not contain cycles." });

    const symbolPoint: Record<PropertyKey, unknown> = { x: 1, y: 2 };
    symbolPoint[Symbol("hidden")] = true;
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, common({ index: 0, point: symbolPoint })))
      .toEqual({ ok: false, problem: "Arguments.point must not contain symbol keys." });

    let getterReads = 0;
    const accessorPoint: Record<string, unknown> = { y: 2 };
    Object.defineProperty(accessorPoint, "x", { enumerable: true, get: () => { getterReads += 1; return 1; } });
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, common({ index: 0, point: accessorPoint })))
      .toEqual({ ok: false, problem: "Arguments.point.x must be a data property." });
    expect(getterReads).toBe(0);

    const sparsePositions = new Array<{ x: number; y: number }>(2);
    sparsePositions[0] = { x: 1, y: 2 };
    expect(readTimelinePointIntent(TIMELINE_POINT_COMMANDS.upsert, common({ index: 0, point: { x: 1, y: 2 }, samplePositions: sparsePositions })))
      .toEqual({ ok: false, problem: "Arguments.samplePositions must be a dense data array without extension fields." });

    let packageLoads = 0;
    let outputChecks = 0;
    const proxy = new Proxy(common({ index: 0, point: { x: 1, y: 2 } }), {
      ownKeys: () => { throw new Error("proxy reflection must not escape the parser"); },
    });
    const result = await dispatchTimelineStructuralCommand(TIMELINE_POINT_COMMANDS.upsert, proxy, {
      packageLoader: async () => { packageLoads += 1; throw new Error("hostile arguments must not load a package"); },
      isUnsafePackageOutputDirectory: async () => { outputChecks += 1; return false; },
      isEmptyOrAbsentDirectory: async () => { outputChecks += 1; return true; },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Arguments must be plain JSON data." } });
    expect(packageLoads).toBe(0);
    expect(outputChecks).toBe(0);
  });

  it("routes bounded inspections through the production structural dispatcher without receipts", async () => {
    const source = await writePackage();
    try {
      const range = await dispatchTimelineStructuralCommand(
        TIMELINE_POINT_COMMANDS.rangeInspect,
        { packageRoot: source, layerId: "stars", startIndex: 0, endIndexExclusive: 2 },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => inMemoryPointPackage(source) },
      );
      const trajectory = await dispatchTimelineStructuralCommand(
        TIMELINE_POINT_COMMANDS.trajectoryInspect,
        { packageRoot: source, layerId: "stars", index: 1 },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => inMemoryPointPackage(source) },
      );
      if (!range || !range.ok) throw new Error(range ? range.error.message : "expected point range inspection dispatch");
      if (!trajectory || !trajectory.ok) throw new Error(trajectory ? trajectory.error.message : "expected point trajectory inspection dispatch");
      expect(range).toMatchObject({ ok: true, result: { inspection: { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], samples: [{ atMs: 100, positions: [{ x: 11, y: 12 }, { x: 13, y: 14 }] }, { atMs: 900, positions: [{ x: 21, y: 22 }, { x: 23, y: 24 }] }] } } });
      expect(trajectory).toMatchObject({ ok: true, result: { inspection: { index: 1, history: "not_retained", samples: [{ atMs: 100, position: { x: 13, y: 14 } }, { atMs: 900, position: { x: 23, y: 24 } }] } } });
      expect(range && "receiptId" in range).toBe(false);
      expect(trajectory && "receiptId" in trajectory).toBe(false);
      expect(await readdir(source)).not.toContain("receipts");
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses an actually group-writable parent before Point COW publication while retaining exact evidence", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-m2605-point-cow-evidence-"));
    try {
      const anchor = await createTrustedWorkspaceAnchor(evidenceRoot);
      const source = await writePackage(join(evidenceRoot, "source"));
      const sourceManifest = await readFile(join(source, "manifest.json"), "utf8");
      const sourceMotion = await readFile(join(source, "motion.json"), "utf8");
      const outputRoot = join(evidenceRoot, "output-root");
      const unsafeParent = join(outputRoot, "group-writable");
      await mkdir(outputRoot, { mode: 0o700 });
      await mkdir(unsafeParent, { mode: 0o700 });
      await chmod(unsafeParent, 0o777);
      const services = evidenceServices(evidenceRoot, async () => inMemoryPointPackage(source), outputRoot);
      const range = await dispatchTimelineStructuralCommand(
        TIMELINE_POINT_COMMANDS.rangeInspect,
        { packageRoot: source, layerId: "stars", startIndex: 0, endIndexExclusive: 2 },
        services,
      );
      const trajectory = await dispatchTimelineStructuralCommand(
        TIMELINE_POINT_COMMANDS.trajectoryInspect,
        { packageRoot: source, layerId: "stars", index: 1 },
        services,
      );
      if (!range || !range.ok) throw new Error(range && !range.ok ? range.error.message : "expected Point range inspection result");
      if (!trajectory || !trajectory.ok) throw new Error(trajectory && !trajectory.ok ? trajectory.error.message : "expected Point trajectory inspection result");
      expect(range).toMatchObject({ ok: true, result: { inspection: { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } } });
      expect(trajectory).toMatchObject({ ok: true, result: { inspection: { history: "not_retained" } } });
      expect(await readdir(source)).not.toContain("receipts");

      const outDir = join(unsafeParent, "output");
      const result = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchTimelineStructuralCommand(
        TIMELINE_POINT_COMMANDS.upsert,
        common({ packageRoot: source, outDir, index: 1, point: { x: 30, y: 40 }, samplePositions: [{ x: 31, y: 41 }, { x: 32, y: 42 }] }),
        services,
      ));
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_points_failed", message: expect.stringMatching(/group- or world-writable/i) } });
      expect(existsSync(outDir)).toBe(false);
      expect(await readFile(join(source, "manifest.json"), "utf8")).toBe(sourceManifest);
      expect(await readFile(join(source, "motion.json"), "utf8")).toBe(sourceMotion);

      const hostileOut = join(evidenceRoot, "hostile-refusal-no-output");
      const hostile = new Proxy(common({ packageRoot: source, outDir: hostileOut, index: 0, point: { x: 1, y: 2 } }), {
        ownKeys: () => { throw new Error("hostile reflection must not reach package copy"); },
      });
      const refusal = await dispatchTimelineStructuralCommand(TIMELINE_POINT_COMMANDS.upsert, hostile, services);
      expect(refusal).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Arguments must be plain JSON data." } });
      expect(existsSync(hostileOut)).toBe(false);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

function common(values: Record<string, unknown> = {}): Record<string, unknown> { return { packageRoot: "/package", outDir: "/out", layerId: "stars", ...values }; }
function unavailableServices(onLoad: () => void) {
  return { packageLoader: async () => { onLoad(); throw new Error("invalid args must not load a package"); }, isUnsafePackageOutputDirectory: async () => false, isEmptyOrAbsentDirectory: async () => true };
}

function servicesFor() {
  return { authoringInputRoots: [tmpdir()], authoringOutputRoots: [tmpdir()], packageLoader: loadMotionPackage, isUnsafePackageOutputDirectory: async () => false, isEmptyOrAbsentDirectory: async (path: string) => (await readdir(path)).length === 0 };
}

async function writePackage(root?: string): Promise<string> {
  const packageRoot = root ?? await mkdtemp(join(tmpdir(), "shellx-motion-debug-points-source-"));
  if (!existsSync(packageRoot)) await mkdir(packageRoot, { mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "pkg_debug_points", name: "Debug points", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] } }, null, 2)}\n`);
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion_debug_points", name: "Debug points", durationMs: 1_000, fps: 25, width: 100, height: 100, layers: [{ id: "stars", type: "points", startMs: 0, durationMs: 1_000, pointCloud: { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }], samples: [{ atMs: 100, positions: [{ x: 11, y: 12 }, { x: 13, y: 14 }, { x: 15, y: 16 }] }, { atMs: 900, positions: [{ x: 21, y: 22 }, { x: 23, y: 24 }, { x: 25, y: 26 }] }] } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }, null, 2)}\n`);
  return packageRoot;
}

function evidenceServices(root: string, packageLoader = loadMotionPackage, outputRoot = root) {
  return {
    authoringInputRoots: [root], authoringOutputRoots: [outputRoot], packageLoader,
    isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async (path: string) => (await readdir(path).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      throw error;
    })).length === 0,
  };
}

function inMemoryPointPackage(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_debug_points", name: "Debug points", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_debug_points", name: "Debug points", durationMs: 1_000, fps: 25, width: 100, height: 100, layers: [{ id: "stars", type: "points", startMs: 0, durationMs: 1_000, pointCloud: { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }], samples: [{ atMs: 100, positions: [{ x: 11, y: 12 }, { x: 13, y: 14 }, { x: 15, y: 16 }] }, { atMs: 900, positions: [{ x: 21, y: 22 }, { x: 23, y: 24 }, { x: 25, y: 26 }] }] } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } },
  } as MotionPackage;
}
