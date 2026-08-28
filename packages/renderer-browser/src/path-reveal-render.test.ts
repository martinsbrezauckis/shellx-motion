/**
 * Browser-pixel proof for the SVG dash lowering. Markup alone cannot establish the direction or
 * offset semantics of `pathLength`/dash arrays, so these sample rendered PNG pixels for each v1
 * window shape, including a curved path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPngFileRegion, loadMotionPackage, type MotionPathReveal } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "./index";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("browser SVG path reveal pixels", () => {
  it("renders full, partial, moving-window, empty, and curved reveal windows", async () => {
    const full = await renderReveal({ start: 0, end: 1 });
    expect(await patchLuma(full, 48, 42)).toBeGreaterThan(100);
    expect(await patchLuma(full, 340, 42)).toBeGreaterThan(100);

    const partial = await renderReveal({ start: 0.25, end: 0.75 });
    expect(await patchLuma(partial, 48, 42)).toBeLessThan(4);
    expect(await patchLuma(partial, 200, 42)).toBeGreaterThan(100);
    expect(await patchLuma(partial, 340, 42)).toBeLessThan(4);

    const movingWindow = await renderReveal({ start: 0.5, end: 0.75 });
    expect(await patchLuma(movingWindow, 120, 42)).toBeLessThan(4);
    expect(await patchLuma(movingWindow, 248, 42)).toBeGreaterThan(100);
    expect(await patchLuma(movingWindow, 340, 42)).toBeLessThan(4);

    const empty = await renderReveal({ start: 0.65, end: 0.2 });
    expect(await patchLuma(empty, 200, 42)).toBeLessThan(4);

    const curved = await renderReveal({ start: 0, end: 0.45 }, "M 20 260 C 20 20 380 20 380 260", 400, 300);
    expect(await patchLuma(curved, 48, 138)).toBeGreaterThan(80);
    expect(await patchLuma(curved, 340, 138)).toBeLessThan(4);
  }, 120_000);
});

async function renderReveal(reveal: MotionPathReveal, path = "M 0 50 H 400", width = 400, height = 100): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-path-reveal-"));
  const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-path-reveal-out-"));
  tempDirs.push(root, outDir);
  const motion = {
    schema: "shellx-motion/motion@1",
    id: "path_reveal_pixels",
    name: "Path reveal pixels",
    durationMs: 100,
    fps: 30,
    width,
    height,
    background: "#000000",
    assets: [],
    layers: [{
      id: "trace",
      type: "shape",
      shape: "path",
      startMs: 0,
      durationMs: 100,
      transform: { x: 0, y: 0, width, height },
      "x-path": path,
      "x-path-viewBox": `0 0 ${width} ${height}`,
      pathReveal: reveal,
      style: { fill: "transparent", stroke: "#ffffff", strokeWidth: 8, strokeLinecap: "butt" }
    }],
    provenance: { sourceApp: "shellx-motion", createdBy: "path-reveal-pixels" }
  };
  const manifest = {
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_path_reveal_pixels",
    name: "Path reveal pixels",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "motion.json"), `${JSON.stringify(motion, null, 2)}\n`);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = await renderMotionBrowserFrame(await loadMotionPackage(root), { atMs: 0, outDir });
  if (!result.ok) throw new Error("path reveal browser render failed");
  return result.output.path;
}

async function patchLuma(path: string, x: number, y: number): Promise<number> {
  const region = await inspectPngFileRegion(path, { x, y, width: 12, height: 12 });
  if (!region.ok) throw new Error(`PNG region read failed: ${region.code}`);
  return region.luma.avg;
}
