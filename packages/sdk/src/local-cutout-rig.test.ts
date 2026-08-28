import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local.js";

const PNG_2X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64",
);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local typed cutout rig SDK", () => {
  it("bakes a governed static PNG into ordinary cropped image layers with a persisted receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-cutout-rig-"));
    tempDirs.push(root);
    const packageRoot = join(root, "source");
    const outDir = join(root, "baked");
    await mkdir(join(packageRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(packageRoot, "assets", "source.png"), PNG_2X1);
    await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
      schema: "shellx-motion/package-manifest@1", id: "pkg_cutout_source", name: "Source",
      motion: "motion.json", assets: ["assets/source.png"], sourceApp: "test",
      compatibility: { lanes: ["native", "browser"], hosts: ["motion"] },
    }));
    await writeFile(join(packageRoot, "motion.json"), JSON.stringify({
      schema: "shellx-motion/motion@1", id: "motion_cutout_source", name: "Source",
      durationMs: 100, fps: 10, width: 16, height: 16, assets: [],
      layers: [{
        id: "source", type: "image", assetRef: "assets/source.png", trackId: "main", startMs: 0, durationMs: 100,
        transform: { x: 2, y: 3, width: 2, height: 1, scale: 1, rotation: 0, originX: 1, originY: 0.5 },
      }],
      tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }], provenance: { sourceApp: "test", createdBy: "test" },
    }));

    const sdk = createLocalMotionSdk({ authoringInputRoots: [root], authoringOutputRoots: [root] });
    const result = await sdk.cutoutRigBake({
      packageRoot, outDir, sourceLayerId: "source",
      rig: {
        schema: "shellx-motion/cutout-rig@1", sampleEveryFrames: 1,
        nodes: [{
          layerId: "hand", stackIndex: 0, crop: { x: 1, y: 0, width: 1, height: 1 }, origin: { x: 0, y: 0 },
          poses: [{ atMs: 0, x: 0, y: 0, scale: 1, rotation: 0 }],
        }],
      },
      createdBy: "sdk-test",
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        packageRoot: outDir,
        source: { layerId: "source", assetRef: "assets/source.png", width: 2, height: 1 },
        outputLayerIds: ["hand"],
        changedPaths: ["/layers", "/tracks"],
        receipt: { operation: "timeline.cutout.rig.bake", status: "passed" },
      },
    });
    if (!result.ok) throw new Error("expected local cutout rig bake");
    expect(result.output.cadence).toMatchObject({ bakedSampleCount: 1, activeWindow: { startMs: 0, endMsExclusive: 100 } });
  });
});
