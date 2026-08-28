import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionPackage, OperationReceipt } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import {
  applyTimelineShapeGeometryKeyframeIntent,
  dispatchTimelineShapeGeometryKeyframeAuthoringCommand,
  type TimelineShapeGeometryKeyframeAuthoringServices,
} from "./timeline-shape-geometry-keyframes-authoring.js";
import {
  isTimelineShapeGeometryKeyframeCommand,
  readTimelineShapeGeometryKeyframeIntent,
  TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS,
} from "./timeline-shape-geometry-keyframes.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;
const topologyRefusal = hasAtomicCOWAuthority(tmpdir()) ? it.skip : it;
const GEOMETRY = (y = 0) => ({ schema: "shellx-motion/shape-geometry@1" as const, kind: "line" as const, viewBox: { x: 0, y: 0, width: 100, height: 100 }, points: [{ x: 0, y }, { x: 100, y }] as [{ x: number; y: number }, { x: number; y: number }] });
const SNAPSHOT = (atUs: number, y = 0, easing?: string) => ({ atUs, geometry: GEOMETRY(y), ...(easing ? { easing } : {}) });

describe("timeline shape geometry keyframe Debug boundary", () => {
  it("parses the closed exact-atUs vocabulary without a generic keyframe route", () => {
    expect(readTimelineShapeGeometryKeyframeIntent(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.inspect, { packageRoot: "/package", layerId: "shape" }))
      .toEqual({ ok: true, intent: { kind: "inspect", packageRoot: "/package", layerId: "shape" } });
    expect(readTimelineShapeGeometryKeyframeIntent(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert, common({ snapshot: SNAPSHOT(500_000, 20, "ease-in") })))
      .toMatchObject({ ok: true, intent: { kind: "upsert", layerId: "shape", snapshot: { atUs: 500_000, geometry: { kind: "line" }, easing: "ease-in" } } });
    expect(readTimelineShapeGeometryKeyframeIntent(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.delete, common({ atUs: 500_000 })))
      .toEqual({ ok: true, intent: { kind: "delete", edit: { packageRoot: "/package", outDir: "/out" }, layerId: "shape", atUs: 500_000 } });
    expect(readTimelineShapeGeometryKeyframeIntent(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.move, common({ fromAtUs: 0, toAtUs: 750_000 })))
      .toEqual({ ok: true, intent: { kind: "move", edit: { packageRoot: "/package", outDir: "/out" }, layerId: "shape", fromAtUs: 0, toAtUs: 750_000 } });
    expect(isTimelineShapeGeometryKeyframeCommand("motion.timeline.keyframe.upsert")).toBe(false);
    expect(readTimelineShapeGeometryKeyframeIntent(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.move, common({ fromAtUs: 7, toAtUs: 7 })))
      .toEqual({ ok: false, problem: "fromAtUs and toAtUs must differ for an ordered snapshot move." });
  });

  it("refuses hostile, malformed, generic, and caller receipt-root input before package loading", async () => {
    let loads = 0;
    const services = unavailableServices(() => { loads += 1; });
    const invalid = await dispatchTimelineShapeGeometryKeyframeAuthoringCommand(
      TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert,
      common({ snapshot: { ...SNAPSHOT(0), unexpected: true } }), services,
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const callerRoot = await dispatchTimelineShapeGeometryKeyframeAuthoringCommand(
      TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.delete, common({ atUs: 0, receiptsRoot: "/caller-must-not-choose" }), services,
    );
    expect(callerRoot).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Unknown argument: receiptsRoot." } });
    const noHostRoot = await dispatchTimelineShapeGeometryKeyframeAuthoringCommand(
      TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert, common({ snapshot: SNAPSHOT(0) }), services,
    );
    expect(noHostRoot).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: "Shape geometry keyframe mutations require a host-configured receiptsRoot." } });
    const hostile = new Proxy(common({ snapshot: SNAPSHOT(0) }), { ownKeys() { throw new Error("must not reach package loading"); } });
    const refusal = await dispatchTimelineShapeGeometryKeyframeAuthoringCommand(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert, hostile, services);
    expect(refusal).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await dispatchTimelineShapeGeometryKeyframeAuthoringCommand("motion.timeline.keyframe.upsert", common({ snapshot: SNAPSHOT(0) }), services)).toBeNull();
    expect(loads).toBe(0);
  });

  it("uses the Core inspection and exact shape-only mutation exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-geometry-keyframes-inspect-"));
    try {
      const inspected = await dispatchTimelineStructuralCommand(
        TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.inspect, { packageRoot: root, layerId: "shape" },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => packageFor(root) },
      );
      expect(inspected).toMatchObject({ ok: true, result: { inspection: { layerId: "shape", geometryKeyframes: null, staticGeometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
      const first = applyTimelineShapeGeometryKeyframeIntent(motion(), { kind: "upsert", edit: edit(), layerId: "shape", snapshot: SNAPSHOT(0) }, {});
      const second = applyTimelineShapeGeometryKeyframeIntent(first.motion, { kind: "upsert", edit: edit(), layerId: "shape", snapshot: SNAPSHOT(1_000, 20, "ease-in") }, {});
      const moved = applyTimelineShapeGeometryKeyframeIntent(second.motion, { kind: "move", edit: edit(), layerId: "shape", fromAtUs: 1_000, toAtUs: 500 }, {});
      const deleted = applyTimelineShapeGeometryKeyframeIntent(moved.motion, { kind: "delete", edit: edit(), layerId: "shape", atUs: 500 }, {});
      expect([first.action, second.action, moved.action, deleted.action]).toEqual(["inserted", "inserted", "moved", "deleted"]);
      expect(deleted.layer.geometryKeyframes?.keyframes.map((entry) => entry.atUs)).toEqual([0]);
      expect(deleted.outputMotionSha256).toBe(Core.canonicalJsonSha256(deleted.motion));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  atomicCOW("publishes one host-receipted atomic COW mutation with static, sequence, and output identities", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-geometry-keyframes-cow-"));
    const source = await writePackage(join(evidenceRoot, "source"));
    const outDir = join(evidenceRoot, "output");
    const sourceBytes = await readFile(join(source, "motion.json"));
    try {
      const result = await dispatchTimelineStructuralCommand(
        TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert, common({ packageRoot: source, outDir, snapshot: SNAPSHOT(0), createdBy: "test" }),
        cowServices(evidenceRoot),
      );
      expect(result).toMatchObject({ ok: true, result: { action: "inserted", outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), geometryKeyframes: { staticGeometrySha256: expect.stringMatching(/^[a-f0-9]{64}$/), sourceSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
      if (!result || !result.ok) throw new Error("expected successful shape geometry keyframe COW result");
      const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-shape-geometry-keyframes-upsert.receipt.json"), "utf8"));
      const reopened = await Core.loadMotionPackage(outDir);
      expect(receipt).toMatchObject({ operation: "timeline.shape.geometry-keyframes.upsert", status: "passed", inputHashes: { "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/) }, output: { outputMotionSha256: Core.canonicalJsonSha256(reopened.motion), geometryKeyframes: { staticGeometrySha256: Core.canonicalJsonSha256(GEOMETRY()), sourceSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
      expect(result.result).toHaveProperty("hostReceiptPath");
      expect(await readFile(join(source, "motion.json"))).toEqual(sourceBytes);
    } finally { await rm(evidenceRoot, { recursive: true, force: true }); }
  });

  topologyRefusal("truthfully retains the managed-WSL topology refusal without source or output mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-geometry-keyframes-topology-"));
    const source = await writePackage(join(root, "source"));
    const outDir = join(root, "output-refused");
    const before = await readFile(join(source, "motion.json"));
    try {
      const result = await dispatchTimelineStructuralCommand(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert, common({ packageRoot: source, outDir, snapshot: SNAPSHOT(0) }), cowServices(root));
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_shape_geometry_keyframes_failed", message: expect.stringContaining("Output parent is owned by an unrelated POSIX principal.") } });
      expect(existsSync(outDir)).toBe(false);
      expect(await readFile(join(source, "motion.json"))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function common(values: Record<string, unknown> = {}): Record<string, unknown> { return { packageRoot: "/package", outDir: "/out", layerId: "shape", ...values }; }
function edit() { return { packageRoot: "/package", outDir: "/out" }; }
function motion(): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "debug-geometry-keyframes", name: "Debug geometry keyframes", durationMs: 1_000, fps: 25, width: 100, height: 100, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "shape", type: "shape", startMs: 0, durationMs: 1_000, geometry: GEOMETRY(), style: { stroke: "#fff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" } }] } as unknown as MotionDocument;
}
function packageFor(root: string): MotionPackage {
  return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg-debug-geometry-keyframes", name: "Debug geometry keyframes", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, motion: motion() };
}
function unavailableServices(onLoad: () => void): TimelineShapeGeometryKeyframeAuthoringServices {
  return { packageLoader: async () => { onLoad(); throw new Error("invalid input must not load package"); }, isUnsafePackageOutputDirectory: async () => false, isEmptyOrAbsentDirectory: async () => true };
}
function cowServices(receiptsRoot: string): TimelineShapeGeometryKeyframeAuthoringServices {
  return {
    authoringInputRoots: [tmpdir()], authoringOutputRoots: [tmpdir()], receiptsRoot,
    packageLoader: Core.loadMotionPackage, isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async (path) => !existsSync(path) || (await readdir(path)).length === 0,
    writeReceipt: async (root, receipt: OperationReceipt) => { const path = join(root, `${receipt.id}.json`); await writeFile(path, `${JSON.stringify(receipt)}\n`); return path; },
  };
}
async function writePackage(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const pkg = packageFor(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(pkg.motion, null, 2)}\n`);
  return root;
}
