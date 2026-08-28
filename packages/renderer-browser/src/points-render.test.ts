import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_CAPABILITY, inspectPngBuffer, inspectPngRegionBuffer, loadMotionPackage, matchRendererCapability, resolveMotionHostRenderCapacity } from "@shellx-motion/core";
import { renderGeneratedPointCloud } from "./generated-points";
import { createMotionBrowserRenderSession } from "./index";

const tempDirs: string[] = [];
const DENSE_HOST = resolveMotionHostRenderCapacity({
  env: {}, facts: { totalMemoryBytes: 64 * 1024 ** 3, freeMemoryBytes: 48 * 1024 ** 3, logicalCpuCount: 16 },
});

describe("browser points renderer", () => {
  afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("renders one ordered point canvas deterministically with representative coverage and sampled motion", async () => {
    const root = await writePointsPackage();
    const pkg = await loadMotionPackage(root);
    const outDir = await makeTempDir();

    expect(BROWSER_CAPABILITY.layerTypes).toContain("points");
    expect(BROWSER_CAPABILITY.features).toContain("points.viewport-batched");
    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    const layer = pkg.motion.layers.find((candidate) => candidate.id === "swarm")!;
    const markup = renderGeneratedPointCloud({ layer, atMs: 0, width: 96, height: 64, style: "position:absolute;", resolveColor: (color) => color });
    const encoded = /data-motion-points-config="([^"]+)"/.exec(markup)?.[1];
    const config = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as { points: Array<{ x: number; y: number; color: string }> };
    expect(markup.match(/<canvas/g)).toHaveLength(1);
    expect(markup).not.toContain("<span");
    expect(config.points).toHaveLength(20_001);
    expect(config.points.slice(0, 3)).toEqual([
      { x: 24, y: 32, color: "#ff0000", size: 18, opacity: 1 },
      { x: 24, y: 32, color: "#00ff00", size: 8, opacity: 1 },
      { x: 72, y: 24, color: "#0000ff", size: 8, opacity: 1 },
    ]);

    const session = await createMotionBrowserRenderSession(pkg, { hostCapacity: DENSE_HOST });
    const start = await session.renderFrame({ atMs: 0, outDir });
    const startAgain = await session.renderFrame({ atMs: 0, outDir });
    const middle = await session.renderFrame({ atMs: 500, outDir });
    await session.close();
    const startPng = await readFile(start.output.path);
    const middlePng = await readFile(middle.output.path);
    const startCoverage = inspectPngRegionBuffer(startPng, { x: 14, y: 18, width: 20, height: 28 });
    const middleCoverage = inspectPngRegionBuffer(middlePng, { x: 38, y: 18, width: 20, height: 28 });

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(middle.output.sha256);
    expect(start.receipt.warnings).toEqual([]);
    expect(inspectPngBuffer(startPng)).toMatchObject({ ok: true, blank: false });
    expect(startCoverage).toMatchObject({ ok: true, blank: false });
    expect(middleCoverage).toMatchObject({ ok: true, blank: false });
  });
});

async function writePointsPackage(): Promise<string> {
  const root = await makeTempDir();
  const pointCloud = pointCloudData();
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_browser_points", name: "Browser Points", motion: "motion.json", assets: [],
    sourceApp: "shellx-motion", compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion"] },
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_browser_points", name: "Browser Points", durationMs: 1_000, fps: 30, width: 96, height: 64, background: "#000000",
    layers: [{
      id: "swarm", type: "points", startMs: 0, durationMs: 1_000,
      pointCloud,
    }],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  }, null, 2)}\n`);
  return root;
}

function pointCloudData(): Record<string, unknown> {
  const points = [
    { x: 24, y: 32, color: "#ff0000", size: 18 },
    { x: 24, y: 32, color: "#00ff00", size: 8 },
    { x: 72, y: 24, color: "#0000ff", size: 8 },
    ...Array.from({ length: 19_998 }, (_item, index) => ({
      x: (index % 48) * 2 + 1, y: (Math.floor(index / 48) % 32) * 2 + 1, color: "#202020", size: 1,
    })),
  ];
  const positions = points.map((point) => ({ x: point.x, y: point.y }));
  return {
    points,
    samples: [
      { atMs: 0, positions },
      { atMs: 1_000, positions: positions.map((point, index) => index < 2
        ? { x: 72, y: 32 } : index === 2 ? { x: 24, y: 24 } : point) },
    ],
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-points-"));
  tempDirs.push(dir);
  return dir;
}
