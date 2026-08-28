import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadMotionPackage, type MotionPackage } from "../packages/core/src/index";

export interface GeneratedBenchmarkWorkload {
  id: string;
  durationMs?: number;
  fps?: number;
}

export async function createNativeBenchmarkPackage(
  root: string,
  workload: GeneratedBenchmarkWorkload
): Promise<MotionPackage> {
  const durationMs = workload.durationMs ?? 2_000;
  const fps = workload.fps ?? 30;
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: `pkg_${workload.id}`,
    name: workload.id,
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["native"], hosts: ["motion"] }
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: `motion_${workload.id}`,
    name: workload.id,
    durationMs,
    fps,
    width: 1920,
    height: 1080,
    background: "#0f172a",
    layers: [{
      id: "panel",
      type: "shape",
      shape: "rect",
      fill: "#13d3ff",
      startMs: 0,
      durationMs,
      transform: { x: 600, y: 360, width: 720, height: 360, scale: 1, rotation: 0 }
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "renderer-benchmark" }
  });
  return loadMotionPackage(root);
}

export async function createMediaHeavyBenchmarkPackage(
  root: string,
  workload: GeneratedBenchmarkWorkload
): Promise<MotionPackage> {
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
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_renderer_media_heavy",
    name: "Renderer media-heavy benchmark",
    motion: "motion.json",
    assets: ["assets/pixel.png"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  });
  await writeJson(join(root, "motion.json"), {
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
  });
  return loadMotionPackage(root);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
