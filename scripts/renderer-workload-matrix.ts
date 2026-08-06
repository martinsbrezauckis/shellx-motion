import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMotionPackage, type MotionPackage } from "../packages/core/src/index";
import { createMotionBrowserRenderSession } from "../packages/renderer-browser/src/index";

interface Workload {
  id: string;
  kind: "cold-still" | "warm-still" | "generated" | "alpha" | "media-heavy" | "browser";
  fixture?: string;
  durationMs?: number;
  fps?: number;
  frameCount: number;
  maxElapsedMs: number;
  minFramesPerSecond?: number;
  minCacheHits?: number;
  extended?: boolean;
}

const matrix = JSON.parse(
  await readFile(resolve("fixtures/benchmarks/renderer-browser-matrix.json"), "utf8")
) as { schema: string; workloads: Workload[] };
const extended = process.argv.includes("--extended") || process.env.SHELLX_MOTION_EXTENDED_BENCHMARK === "1";
const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-renderer-matrix-"));
const results: Array<Record<string, unknown>> = [];

try {
  for (const workload of matrix.workloads.filter((entry) => extended || !entry.extended)) {
    const pkg = workload.kind === "media-heavy"
      ? await createMediaHeavyPackage(join(tempRoot, "media-heavy"), workload)
      : await loadAndAdaptPackage(workload);
    const outDir = join(tempRoot, workload.id);
    await mkdir(outDir, { recursive: true });
    const session = await createMotionBrowserRenderSession(pkg);
    try {
      const requests = Array.from({ length: workload.frameCount }, (_, index) => ({
        atMs: workload.kind === "warm-still"
          ? 0
          : Math.min(pkg.motion.durationMs - 1, Math.floor(index * pkg.motion.durationMs / workload.frameCount)),
        outDir,
        outputPath: join(outDir, `${String(index).padStart(6, "0")}.png`)
      }));
      const startedAt = performance.now();
      const frames = workload.kind === "cold-still"
        ? [await session.renderFrame(requests[0])]
        : workload.kind === "warm-still"
          ? [await session.renderFrame(requests[0]), await session.renderFrame(requests[1])]
          : await session.renderFrames(requests, { maxConcurrency: 2, perFrameTimeoutMs: 30_000 });
      const elapsedMs = performance.now() - startedAt;
      const framesPerSecond = workload.frameCount / (elapsedMs / 1_000);
      const uniqueFrames = new Set(frames.map((frame) => frame.output.sha256)).size;
      const failures = [
        ...(elapsedMs > workload.maxElapsedMs ? [`elapsed ${elapsedMs.toFixed(2)}ms > ${workload.maxElapsedMs}ms`] : []),
        ...(workload.minFramesPerSecond && framesPerSecond < workload.minFramesPerSecond
          ? [`throughput ${framesPerSecond.toFixed(3)}fps < ${workload.minFramesPerSecond}fps`]
          : []),
        ...(session.metrics.browserLaunches !== 1 ? [`browser launches were ${session.metrics.browserLaunches}`] : []),
        ...(session.metrics.contextsCreated > 2 ? [`contexts were ${session.metrics.contextsCreated}`] : []),
        ...(session.metrics.frameCacheHits < (workload.minCacheHits ?? 0)
          ? [`cache hits ${session.metrics.frameCacheHits} < ${workload.minCacheHits}`]
          : [])
      ];
      const result = {
        id: workload.id,
        ok: failures.length === 0,
        width: pkg.motion.width,
        height: pkg.motion.height,
        durationMs: pkg.motion.durationMs,
        fps: pkg.motion.fps,
        frameCount: workload.frameCount,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        framesPerSecond: Number(framesPerSecond.toFixed(3)),
        uniqueFrames,
        metrics: session.metrics,
        failures
      };
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await session.close();
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => result.ok !== true);
process.stdout.write(`${JSON.stringify({
  schema: "shellx-motion/browser-render-matrix-result@1",
  extended,
  ok: failed.length === 0,
  workloadCount: results.length,
  failed: failed.map((result) => result.id)
}, null, 2)}\n`);
if (failed.length > 0) process.exitCode = 1;

async function loadAndAdaptPackage(workload: Workload): Promise<MotionPackage> {
  const loaded = await loadMotionPackage(resolve(workload.fixture!));
  const durationMs = workload.durationMs ?? loaded.motion.durationMs;
  const fps = workload.fps ?? loaded.motion.fps;
  const motion = structuredClone(loaded.motion);
  motion.width = 1920;
  motion.height = 1080;
  motion.durationMs = durationMs;
  motion.fps = fps;
  motion.layers = motion.layers.map((layer) => ({ ...layer, durationMs }));
  if (workload.kind === "alpha") delete motion.background;
  return { ...loaded, motion };
}

async function createMediaHeavyPackage(root: string, workload: Workload): Promise<MotionPackage> {
  const durationMs = workload.durationMs ?? 2_000;
  const fps = workload.fps ?? 30;
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, "assets", "pixel.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  );
  const assets = Array.from({ length: 24 }, (_, index) => ({
    schema: "shellx-motion/asset@1",
    id: `asset_${index}`,
    kind: "image",
    source: { path: "assets/pixel.png", mimeType: "image/png" },
    hash: { sha256: "benchmark-fixture" },
    size: { width: 1, height: 1 }
  }));
  const layers = assets.map((asset, index) => ({
    id: `image_${index}`,
    type: "image",
    assetId: asset.id,
    startMs: 0,
    durationMs,
    transform: {
      x: (index % 6) * 320,
      y: Math.floor(index / 6) * 270,
      width: 320,
      height: 270,
      opacity: 0.65 + (index % 3) * 0.15
    },
    fit: "fill"
  }));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_renderer_media_heavy",
    name: "Renderer media-heavy benchmark",
    motion: "motion.json",
    assets: ["assets/pixel.png"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_renderer_media_heavy",
    name: "Renderer media-heavy benchmark",
    durationMs,
    fps,
    width: 1920,
    height: 1080,
    background: "#0f172a",
    layers,
    assets,
    provenance: { sourceApp: "shellx-motion", createdBy: "renderer-benchmark" }
  }, null, 2)}\n`);
  return loadMotionPackage(root);
}
