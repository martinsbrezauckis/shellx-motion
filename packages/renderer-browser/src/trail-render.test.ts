import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPngFileRegion, loadMotionPackage } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "./index";

const tempDirs: string[] = [];

describe("browser point trail pixels", () => {
  afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("paints the bounded tapered lookback stroke behind its moving head", async () => {
    const root = await writeTrailPackage();
    const outDir = await makeTempDir();
    const rendered = await renderMotionBrowserFrame(await loadMotionPackage(root), { atMs: 500, outDir });
    if (rendered.ok !== true) throw new Error("trail browser render failed");

    const olderSegment = await luma(rendered.output.path, 26, 32);
    const newerSegment = await luma(rendered.output.path, 42, 32);
    const beforeHistory = await luma(rendered.output.path, 12, 32);
    expect(olderSegment).toBeGreaterThan(20);
    expect(newerSegment).toBeGreaterThan(45);
    expect(olderSegment).toBeLessThan(newerSegment * 0.65);
    expect(beforeHistory).toBeLessThan(4);
  }, 45_000);
});

async function writeTrailPackage(): Promise<string> {
  const root = await makeTempDir();
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_browser_trail", name: "Browser Trail", motion: "motion.json", assets: [],
    sourceApp: "shellx-motion", compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_browser_trail", name: "Browser Trail", durationMs: 1_000, fps: 30, width: 100, height: 64, background: "#000000",
    layers: [{
      id: "spark", type: "points", startMs: 0, durationMs: 1_000,
      effects: { trail: { durationMs: 500, samples: 3 } },
      pointCloud: {
        points: [{ x: 20, y: 32, color: "#ff0000", size: 8, opacity: 1 }],
        samples: [{ atMs: 0, positions: [{ x: 20, y: 32 }] }, { atMs: 1_000, positions: [{ x: 80, y: 32 }] }]
      }
    }],
    assets: [], provenance: { sourceApp: "test", createdBy: "trail-render-test" }
  }, null, 2)}\n`);
  return root;
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-trail-"));
  tempDirs.push(dir);
  return dir;
}

async function luma(path: string, x: number, y: number): Promise<number> {
  const region = await inspectPngFileRegion(path, { x, y, width: 4, height: 4 });
  if (!region.ok) throw new Error(`PNG region read failed: ${region.code}`);
  return region.luma.avg;
}
