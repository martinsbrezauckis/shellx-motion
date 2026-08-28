import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCutoutRigAuthoringCommand } from "./authoring-cutout-rig.js";
import { dispatchCapabilitiesCommand } from "./capabilities.js";

const PNG_2X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64",
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cutout rig authoring command", () => {
  it("writes one copy-on-write sampled bake with source identity and cadence evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-cutout-rig-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const outDir = join(root, "baked");
    await writeSourcePackage(sourceRoot);
    const sourceMotion = await readFile(join(sourceRoot, "motion.json"), "utf8");

    const result = await dispatchCutoutRigAuthoringCommand("motion.timeline.cutout.rig.bake", {
      packageRoot: sourceRoot,
      outDir,
      sourceLayerId: "source",
      rig: rig(),
      createdBy: "debug-test",
    }, {
      packageLoader: loadMotionPackage,
      authoringInputRoots: [root],
      authoringOutputRoots: [root],
    });

    expect(result).toMatchObject({
      ok: true,
      visibleState: { panel: "timeline", operation: "timeline.cutout.rig.bake", outputLayerIds: ["hand"] },
      result: {
        packageRoot: outDir,
        source: { layerId: "source", assetRef: "assets/source.png", width: 2, height: 1 },
        outputLayerIds: ["hand"],
        changedPaths: ["/layers", "/tracks"],
        cadence: { bakedSampleCount: 1, activeWindow: { startMs: 0, endMsExclusive: 100 } },
      },
    });
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(sourceMotion);
    expect((await loadMotionPackage(outDir)).motion.layers).toEqual([expect.objectContaining({
      id: "hand", type: "image", crop: { x: 1, y: 0, width: 1, height: 1 },
    })]);
    const capabilities = await dispatchCapabilitiesCommand("motion.capabilities.match", { packageRoot: outDir });
    expect(capabilities).toMatchObject({
      ok: true,
      result: {
        packageId: "pkg_cutout_source",
        matches: expect.arrayContaining([
          expect.objectContaining({ lane: "native", ok: true }),
          expect.objectContaining({ lane: "browser", ok: true }),
        ]),
      },
    });
  });

  it("refuses a source with animation before it stages an output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-cutout-refusal-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const outDir = join(root, "baked");
    await writeSourcePackage(sourceRoot, { "transform.x": [{ atMs: 0, value: 0 }] });

    const result = await dispatchCutoutRigAuthoringCommand("motion.timeline.cutout.rig.bake", {
      packageRoot: sourceRoot, outDir, sourceLayerId: "source", rig: rig(),
    }, { packageLoader: loadMotionPackage, authoringInputRoots: [root], authoringOutputRoots: [root] });

    expect(result).toMatchObject({ ok: false, error: { code: "cutout_rig_bake_failed", message: expect.stringMatching(/static image/i) } });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function rig() {
  return {
    schema: "shellx-motion/cutout-rig@1", sampleEveryFrames: 1,
    nodes: [{
      layerId: "hand", stackIndex: 0, crop: { x: 1, y: 0, width: 1, height: 1 }, origin: { x: 0, y: 0 },
      poses: [{ atMs: 0, x: 4, y: 5, scale: 1, rotation: 0 }],
    }],
  };
}

async function writeSourcePackage(root: string, keyframes?: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "source.png"), PNG_2X1);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_cutout_source", name: "Source", motion: "motion.json",
    assets: ["assets/source.png"], sourceApp: "test", compatibility: { lanes: ["native", "browser"], hosts: ["motion"] },
  }));
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_cutout_source", name: "Source", durationMs: 100, fps: 10,
    width: 16, height: 16, assets: [],
    layers: [{
      id: "source", type: "image", assetRef: "assets/source.png", trackId: "main", startMs: 0, durationMs: 100,
      transform: { x: 2, y: 3, width: 2, height: 1, scale: 1, rotation: 0, originX: 1, originY: 0.5 },
      ...(keyframes ? { keyframes } : {}),
    }],
    tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }], provenance: { sourceApp: "test", createdBy: "test" },
  }));
}
