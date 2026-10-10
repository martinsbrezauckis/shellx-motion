import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage, loadSchemaSync, validateDocumentSync } from "@shellx-motion/core";
import { exportMotionPackageToOtio, importOtioTimelineToMotionPackage } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OTIO timing regressions", () => {
  it("preserves an unsupported layer interval as a warned OTIO gap", async () => {
    const { packageRoot, sourceCanonicalMotionSchemaValidation } = await writeUnsupportedLayerPackage();
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-otio-unsupported-gap-"));
    const outPath = join(root, "timeline.otio");
    const importedPackageDir = join(root, "imported");
    tempDirs.push(packageRoot, root);

    const exported = await exportMotionPackageToOtio({ packageRoot, outPath });
    const timeline = JSON.parse(await readFile(outPath, "utf8")) as Record<string, any>;
    const videoTrack = timeline.tracks.children.find((track: { kind: string }) => track.kind === "Video");
    const imported = await importOtioTimelineToMotionPackage({ otioPath: outPath, packageDir: importedPackageDir });
    const importedPackage = await loadMotionPackage(imported.packageDir);

    expect(sourceCanonicalMotionSchemaValidation).toEqual({ ok: true });
    expect(exported).toMatchObject({ clipCount: 1, gapCount: 1, warningCount: 1 });
    expect(exported.warnings).toEqual(["motion.layers.scene: Motion layer type is not mapped to OTIO yet."]);
    expect(videoTrack.children).toMatchObject([
      { OTIO_SCHEMA: "Gap.1", source_range: { duration: { value: 24, rate: 24 } } },
      { OTIO_SCHEMA: "Clip.2", metadata: { shellx_motion: { layerId: "title" } } }
    ]);
    expect(importedPackage.motion.layers.find((layer) => layer.id === "title")).toMatchObject({ startMs: 1_000 });
  });
});

async function writeUnsupportedLayerPackage(): Promise<{ packageRoot: string; sourceCanonicalMotionSchemaValidation: { ok: true } }> {
  const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-otio-unsupported-package-"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_otio_unsupported",
    name: "OTIO Unsupported",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion", "shellx-cut"] }
  }, null, 2)}\n`, "utf8");
  const motion = {
    schema: "shellx-motion/motion@1",
    id: "motion_otio_unsupported",
    name: "OTIO Unsupported",
    durationMs: 2_000,
    fps: 24,
    width: 1_280,
    height: 720,
    background: "#111827",
    tracks: [{ id: "video_main", type: "video", name: "Video Main", order: 0, layerIds: ["scene", "title"] }],
    layers: [
      {
        id: "scene",
        type: "scene3d",
        trackId: "video_main",
        startMs: 0,
        durationMs: 1_000,
        scene3d: {
          schema: "shellx-motion/scene3d@1",
          backgroundColor: "#020617",
          camera: { position: [0, 1, 5], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
          lighting: { ambient: 0.2, direction: [0, -1, -1], intensity: 1, color: "#ffffff" },
          objects: [{ id: "cube", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#ffffff" }]
        }
      },
      { id: "title", type: "text", trackId: "video_main", text: "On time", startMs: 1_000, durationMs: 1_000,
        transform: { x: 96, y: 84 }, style: { color: "#ffffff", fontSize: 72 } }
    ],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "adapter-test" }
  };
  const sourceCanonicalMotionSchemaValidation = validateDocumentSync(loadSchemaSync("motion"), motion);
  if (!sourceCanonicalMotionSchemaValidation.ok) {
    throw new Error(`test fixture must satisfy the public Motion schema: ${sourceCanonicalMotionSchemaValidation.errors[0]?.path}`);
  }
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  await loadMotionPackage(packageRoot);
  return { packageRoot, sourceCanonicalMotionSchemaValidation };
}
