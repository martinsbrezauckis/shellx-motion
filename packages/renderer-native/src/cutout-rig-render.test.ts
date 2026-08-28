/** CPU-raster proof that the declared sampled bake paints the cropped cutout at each sample. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bakeCutoutRig, hashBuffer, type MotionDocument } from "@shellx-motion/core";
import { decodeNativePngRgba, encodePng } from "./native-png.js";
import { renderNativePreviewFrame } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native cutout rig sampled pixels", () => {
  it("CPU-renders the cropped green part at each declared sample time", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-native-cutout-rig-"));
    roots.push(root);
    const png = encodePng(2, 1, Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]));
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1", id: "native_cutout", name: "Native cutout",
      durationMs: 200, fps: 10, width: 12, height: 8, background: "#00000000", assets: [],
      layers: [{
        id: "source", type: "image", assetRef: "assets/source.png", trackId: "main", startMs: 0, durationMs: 200,
        transform: { x: 0, y: 0, width: 2, height: 1, scale: 1, rotation: 0, originX: 0, originY: 0 },
      }],
      tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }], provenance: { sourceApp: "test", createdBy: "test" },
    };
    const baked = bakeCutoutRig(motion, "source", {
      schema: "shellx-motion/cutout-rig@1", sampleEveryFrames: 1,
      nodes: [{
        layerId: "spark", stackIndex: 0, crop: { x: 1, y: 0, width: 1, height: 1 }, origin: { x: 0, y: 0 },
        poses: [
          { atMs: 0, x: 2, y: 3, scale: 1, rotation: 0 },
          { atMs: 100, x: 6, y: 3, scale: 1, rotation: 0 },
        ],
      }],
    }, { assetRef: "assets/source.png", width: 2, height: 1, sha256: hashBuffer(png) });
    await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "assets", "source.png"), png);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      schema: "shellx-motion/package-manifest@1", id: "pkg_native_cutout", name: "Native cutout", motion: "motion.json",
      assets: ["assets/source.png"], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] },
    }));
    await writeFile(join(root, "motion.json"), JSON.stringify(baked.motion));

    const first = await renderNativePreviewFrame({ packageRoot: root, atMs: 0 });
    const second = await renderNativePreviewFrame({ packageRoot: root, atMs: 100 });
    if (!first.ok || !second.ok) throw new Error("native cutout rig raster failed");
    expect(pixel(first.frame.png, 2, 3)).toEqual([0, 255, 0, 255]);
    expect(pixel(first.frame.png, 6, 3)).toEqual([0, 0, 0, 0]);
    expect(pixel(second.frame.png, 2, 3)).toEqual([0, 0, 0, 0]);
    expect(pixel(second.frame.png, 6, 3)).toEqual([0, 255, 0, 255]);
  });
});

function pixel(png: Buffer, x: number, y: number): number[] {
  const image = decodeNativePngRgba(png);
  const offset = (y * image.width + x) * 4;
  return [...image.rgba.subarray(offset, offset + 4)];
}
