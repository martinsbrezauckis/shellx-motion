import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeTrackingAnalysis,
  createTrackingAnalysisLifecycle,
  createTrackingOperationReceipt,
  hashFile,
  loadMotionPackage,
  startTrackingAnalysis,
  trackingSettingsSha256,
  type TrackingAnalysis,
} from "@shellx-motion/core";
import { dispatchTrackingAuthoringCommand } from "./authoring-tracking.js";

const roots: string[] = [];

describe("persisted tracking authoring commands", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("requests, inspects, applies, verifies, and exactly detaches a package-local track", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-tracking-authoring-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const trackedRoot = join(root, "tracked");
    const appliedRoot = join(root, "applied");
    const detachedRoot = join(root, "detached");
    await writeTrackingPackage(sourceRoot);
    const services = {
      packageLoader: loadMotionPackage,
      trackingAnalyzer: async (input: any) => {
        const source = {
          assetId: input.assetId,
          sha256: await hashFile(input.sourcePath),
          byteLength: (await stat(input.sourcePath)).size,
          width: 64,
          height: 48,
          durationMs: 200,
        };
        const analysis = analysisFixture(input.id, source, input.reference, input.settings);
        const lifecycle = completeTrackingAnalysis(startTrackingAnalysis(createTrackingAnalysisLifecycle({ id: input.id, source })), analysis);
        return {
          ok: true as const,
          source,
          analysis,
          lifecycle,
          receipt: createTrackingOperationReceipt({ operation: "analysis.tracking.request", packageId: input.packageId, lifecycle, output: { analysis } }),
          resources: [],
        };
      },
      isUnsafePackageOutputDirectory: async (packageRoot: string, outputRoot: string) => resolve(packageRoot) === resolve(outputRoot),
      isEmptyOrAbsentDirectory: async (path: string) => {
        try { return (await readdir(path)).length === 0; } catch { return true; }
      },
    };
    const requestArgs = {
      packageRoot: sourceRoot,
      outDir: trackedRoot,
      analysisId: "plate_track",
      assetId: "plate",
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 8, y: 8, width: 16, height: 16 }, points: [{ x: 12, y: 12 }] },
      settings: { startMs: 0, endMs: 200, stepMs: 100, direction: "forward", searchRadiusPx: 8, pyramidLevels: 2, maxIterations: 20, confidenceFloor: 0.7, deterministicSeed: 7 },
    };

    const requested = await dispatchTrackingAuthoringCommand("motion.analysis.tracking.request", requestArgs, services);
    expect(requested).toMatchObject({ ok: true, result: { lifecycle: { state: "succeeded", attempt: 1 } } });
    expect(JSON.parse(await readFile(join(trackedRoot, "analysis/tracking/plate_track.lifecycle.json"), "utf8"))).toMatchObject({
      schema: "shellx-motion/tracking-lifecycle@1",
      id: "plate_track",
      lastGood: { samples: [{ atMs: 0 }, { atMs: 100 }, { atMs: 200 }] },
    });
    expect(await stat(join(sourceRoot, "analysis/tracking/plate_track.lifecycle.json")).catch(() => null)).toBeNull();

    const inspected = await dispatchTrackingAuthoringCommand("motion.analysis.tracking.inspect", { packageRoot: trackedRoot, analysisId: "plate_track" }, services);
    expect(inspected).toMatchObject({ ok: true, result: { current: true, source: { current: true } } });

    const applied = await dispatchTrackingAuthoringCommand("motion.analysis.tracking.apply", {
      packageRoot: trackedRoot,
      outDir: appliedRoot,
      analysisId: "plate_track",
      layerId: "footage",
    }, services);
    expect(applied).toMatchObject({
      ok: true,
      result: {
        layerId: "footage",
        plan: { status: "ready", fidelity: "exact-similarity" },
        attachment: { analysisId: "plate_track", previousKeyframes: { "transform.x": [{ atMs: 0, value: 40 }] } },
      },
    });

    const verified = await dispatchTrackingAuthoringCommand("motion.analysis.tracking.verify", { packageRoot: appliedRoot, layerId: "footage" }, services);
    expect(verified).toMatchObject({ ok: true, result: { verification: { attached: true, current: true, reasons: [] }, source: { current: true } } });

    const detached = await dispatchTrackingAuthoringCommand("motion.analysis.tracking.detach", {
      packageRoot: appliedRoot,
      outDir: detachedRoot,
      layerId: "footage",
    }, services);
    expect(detached).toMatchObject({ ok: true, result: { restoredPreviousKeyframes: true } });
    const detachedPackage = await loadMotionPackage(detachedRoot);
    expect(detachedPackage.motion.layers[0].keyframes).toEqual({ "transform.x": [{ atMs: 0, value: 40 }] });
    expect(detachedPackage.motion.layers[0]).not.toHaveProperty("x-tracking-stabilization");

    await writeFile(join(trackedRoot, "assets/plate.mp4"), "changed-source", "utf8");
    const stale = await dispatchTrackingAuthoringCommand("motion.analysis.tracking.inspect", { packageRoot: trackedRoot, analysisId: "plate_track" }, services);
    expect(stale).toMatchObject({ ok: true, result: { current: false, source: { current: false } } });
  });
});

async function writeTrackingPackage(root: string): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets/plate.mp4"), "fixture-video-bytes", "utf8");
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_tracking_authoring",
    name: "Tracking authoring fixture",
    motion: "motion.json",
    assets: ["assets/plate.mp4"],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "motion_tracking_authoring",
    name: "Tracking authoring fixture",
    durationMs: 200,
    fps: 10,
    width: 64,
    height: 48,
    layers: [{
      id: "footage",
      type: "video",
      assetId: "plate",
      startMs: 0,
      durationMs: 200,
      transform: { x: 40, y: 20, width: 64, height: 48, scale: 1, rotation: 0 },
      keyframes: { "transform.x": [{ atMs: 0, value: 40 }] },
    }],
    assets: [{ schema: "shellx-motion/asset@1", id: "plate", kind: "video", source: { path: "assets/plate.mp4", mimeType: "video/mp4" }, hash: { sha256: "fixture" } }],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" },
  });
}

function analysisFixture(
  id: string,
  source: TrackingAnalysis["source"],
  reference: TrackingAnalysis["reference"],
  settings: TrackingAnalysis["settings"],
): TrackingAnalysis {
  return {
    schema: "shellx-motion/tracking-analysis@1",
    id,
    source,
    mode: "point",
    model: "translation",
    status: "succeeded",
    reference,
    settings,
    settingsSha256: trackingSettingsSha256(settings),
    solver: { id: "fixture-solver", version: "1", implementationSha256: "a".repeat(64) },
    samples: [
      { atMs: 0, state: "tracked", confidence: 1, residualErrorPx: 0, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      { atMs: 100, state: "tracked", confidence: 1, residualErrorPx: 0, matrix: [1, 0, 3, 0, 1, 2, 0, 0, 1] },
      { atMs: 200, state: "tracked", confidence: 1, residualErrorPx: 0, matrix: [1, 0, 6, 0, 1, 4, 0, 0, 1] },
    ],
    spans: [],
    createdAt: "2026-07-14T00:30:00.000Z",
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
