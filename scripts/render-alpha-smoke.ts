import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outDir = join(repoRoot, ".scratch", "render-alpha-smoke");
const packageRoot = join(outDir, "package");
const qualityManifestPath = join(outDir, "quality-manifest.json");
const renderTargets = [
  { preset: "webm-vp9-alpha", outputPath: join(outDir, "render", "webm-vp9-alpha", "alpha-overlay.webm"), mediaType: "video/webm" },
  { preset: "mov-prores", outputPath: join(outDir, "render", "mov-prores", "alpha-overlay.mov"), mediaType: "video/quicktime" }
] as const;

await rm(outDir, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

await writeJson(join(packageRoot, "manifest.json"), {
  schema: "shellx-motion/package-manifest@1",
  id: "pkg_alpha_overlay_smoke",
  name: "Alpha Overlay Smoke",
  motion: "motion.json",
  assets: [],
  sourceApp: "shellx-motion",
  compatibility: {
    lanes: ["native", "ffmpeg"],
    hosts: ["canvas", "cut", "motion"]
  }
});

await writeJson(join(packageRoot, "motion.json"), {
  schema: "shellx-motion/motion@1",
  id: "motion_alpha_overlay_smoke",
  name: "Alpha Overlay Smoke",
  durationMs: 1600,
  fps: 12,
  width: 320,
  height: 180,
  background: "transparent",
  layers: [
    {
      id: "panel",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1600,
      width: 224,
      height: 52,
      transform: { x: 32, y: 96, scale: 1 },
      style: { fill: "#13d3ff", radius: 8 }
    },
    {
      id: "accent",
      type: "shape",
      shape: "rect",
      startMs: 400,
      durationMs: 1200,
      width: 152,
      height: 10,
      transform: { x: 52, y: 118, scale: 1 },
      style: { fill: "#ffffff", radius: 5 }
    }
  ],
  assets: [],
  provenance: {
    sourceApp: "shellx-motion",
    createdBy: "render-alpha-smoke"
  }
});

await writeJson(qualityManifestPath, {
  schema: "shellx-motion/quality-manifest@1",
  samples: [
    {
      id: "alpha_overlay",
      atMs: 800,
      minTransparentPixels: 20000,
      minNonTransparentPixels: 9000,
      maxChangedPixels: 15000,
      maxMeanDiff: 1,
      minPsnrDb: 35,
      regions: [
        { id: "transparent_corner", x: 0, y: 0, width: 80, height: 60, minTransparentPixels: 4000 },
        { id: "visible_panel", x: 32, y: 96, width: 224, height: 52, minNonTransparentPixels: 9000 }
      ]
    }
  ]
});

const validated = await runCli(["validate", packageRoot]);
assert(validated.ok, `Alpha smoke package validation failed: ${JSON.stringify(validated, null, 2)}`);

const outputs = [];
for (const target of renderTargets) {
  const rendered = await runCli([
    "render",
    packageRoot,
    "--out",
    target.outputPath,
    "--preset",
    target.preset,
    "--quality-manifest",
    qualityManifestPath
  ]);
  assert(rendered.ok, `Alpha smoke ${target.preset} render failed: ${JSON.stringify(rendered, null, 2)}`);
  await stat(target.outputPath);

  const quality = await runCli([
    "quality-check",
    target.outputPath,
    "--manifest",
    qualityManifestPath,
    "--preview-package",
    packageRoot
  ], { scratchRoot: join(outDir, "quality", target.preset) });
  assert(quality.ok, `Alpha smoke ${target.preset} quality check failed: ${JSON.stringify(quality, null, 2)}`);

  const receipt = readObjectField(rendered, "receipt", "rendered.receipt");
  const output = readObject(readObjectField(receipt, "output", "receipt.output"), "receipt.output");
  const renderArtifacts = readArray(readObjectField(receipt, "artifacts", "render.receipt.artifacts"));
  const renderedMedia = renderArtifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media");
  assert(readObjectField(output, "preset", "receipt.output.preset") === target.preset, `alpha smoke ${target.preset} preset mismatch`);
  assert(readObjectField(renderedMedia, "path", "rendered_media.path") === target.outputPath, `alpha smoke ${target.preset} artifact path mismatch`);
  assert(readObjectField(renderedMedia, "status", "rendered_media.status") === "available", `alpha smoke ${target.preset} artifact should be available.`);
  assert(readObjectField(renderedMedia, "mediaType", "rendered_media.mediaType") === target.mediaType, `alpha smoke ${target.preset} media type mismatch`);
  assert(readObjectField(renderedMedia, "primary", "rendered_media.primary") === true, `alpha smoke ${target.preset} artifact should be primary.`);
  outputs.push({
    preset: target.preset,
    outputPath: target.outputPath,
    mediaType: target.mediaType,
    receiptId: readObjectField(receipt, "id", "receipt.id"),
    qualitySamples: readObjectField(quality, "samples", "quality.samples")
  });
}

console.log(JSON.stringify({
  ok: true,
  command: "render-alpha:smoke",
  packageRoot,
  qualityManifestPath,
  outputs
}, null, 2));

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readObject(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label: string): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}
