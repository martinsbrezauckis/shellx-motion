/** One Chromium proof that a cutout bake paints its declared samples, not a live hierarchy. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bakeCutoutRig, hashBuffer, inspectPngFileRegion, loadMotionPackage, type MotionDocument } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "./index.js";
import { makeRgbaPngFixture } from "./test-support/png-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("browser cutout rig sampled pixels", () => {
  it("Chromium renders the cropped part at both declared sample times", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-cutout-rig-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-cutout-rig-out-"));
    roots.push(root, outDir);
    const png = makeRgbaPngFixture(4, 2, Array.from({ length: 8 }, (_, index) => {
      const green = index % 4 >= 2;
      return green ? { r: 0, g: 255, b: 0, a: 255 } : { r: 255, g: 0, b: 0, a: 255 };
    }));
    const source: MotionDocument = {
      schema: "shellx-motion/motion@1", id: "browser_cutout", name: "Browser cutout", durationMs: 200, fps: 10,
      width: 12, height: 8, background: "#000000", assets: [],
      layers: [{
        id: "source", type: "image", assetRef: "assets/source.png", trackId: "main", startMs: 0, durationMs: 200,
        transform: { x: 0, y: 0, width: 4, height: 2, scale: 1, rotation: 0, originX: 0, originY: 0 },
      }],
      tracks: [{ id: "main", type: "overlay", layerIds: ["source"] }], provenance: { sourceApp: "test", createdBy: "test" },
    };
    const baked = bakeCutoutRig(source, "source", {
      schema: "shellx-motion/cutout-rig@1", sampleEveryFrames: 1,
      nodes: [{
        layerId: "spark", stackIndex: 0, crop: { x: 2, y: 0, width: 2, height: 2 }, origin: { x: 0, y: 0 },
        poses: [
          { atMs: 0, x: 2, y: 3, scale: 1, rotation: 0 },
          { atMs: 100, x: 6, y: 3, scale: 1, rotation: 0 },
        ],
      }],
    }, { assetRef: "assets/source.png", width: 4, height: 2, sha256: hashBuffer(png) });
    await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "assets", "source.png"), png);
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      schema: "shellx-motion/package-manifest@1", id: "pkg_browser_cutout", name: "Browser cutout", motion: "motion.json",
      assets: ["assets/source.png"], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] },
    }));
    await writeFile(join(root, "motion.json"), JSON.stringify(baked.motion));
    const pkg = await loadMotionPackage(root);

    const first = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir, outputPath: join(outDir, "first.png") });
    const second = await renderMotionBrowserFrame(pkg, { atMs: 100, outDir, outputPath: join(outDir, "second.png") });
    if (!first.ok || !second.ok) throw new Error("browser cutout rig raster failed");
    expect(await luma(first.output.path, 3, 4)).toBeGreaterThan(100);
    expect(await luma(first.output.path, 7, 4)).toBeLessThan(4);
    expect(await luma(second.output.path, 3, 4)).toBeLessThan(4);
    expect(await luma(second.output.path, 7, 4)).toBeGreaterThan(100);
  }, 120_000);
});

async function luma(path: string, x: number, y: number): Promise<number> {
  const region = await inspectPngFileRegion(path, { x, y, width: 1, height: 1 });
  if (!region.ok) throw new Error(`PNG region read failed: ${region.code}`);
  return region.luma.avg;
}
