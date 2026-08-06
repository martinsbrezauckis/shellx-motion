import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures/packages/editable-lower-third");
const outDir = join(repoRoot, ".scratch", "render-jpeg-smoke");
const outputPath = join(outDir, "editable-lower-third.jpg");
const qualityScratchRoot = join(outDir, "quality-scratch");

// Host gate for still-frame sharing/thumbnail export: render a real JPEG frame.
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const render = await runCli([
  "render",
  packageRoot,
  "--lane",
  "ffmpeg",
  "--out",
  outputPath,
  "--preset",
  "jpeg-frame",
  "--at-ms",
  "750"
]);

assert(render.ok, `JPEG render smoke failed: ${JSON.stringify(render, null, 2)}`);
assert(readObjectField(render, "command", "render.command") === "render", "unexpected render command");
assert(readObjectField(render, "lane", "render.lane") === "image", "JPEG render must use the image lane");
assert(readObjectField(render, "preset", "render.preset") === "jpeg-frame", "JPEG render preset mismatch");
assert(readObjectField(render, "outputPath", "render.outputPath") === outputPath, "JPEG output path mismatch");

await stat(outputPath);
const jpegBytes = await readFile(outputPath);
assert(jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8 && jpegBytes[2] === 0xff, "rendered output is not a JPEG");

const renderOutput = readObject(readObjectField(render, "output", "render.output"), "render.output");
assert(readObjectField(renderOutput, "preset", "render.output.preset") === "jpeg-frame", "render receipt output preset mismatch");
assert(readObjectField(renderOutput, "codec", "render.output.codec") === "jpeg", "render receipt output codec mismatch");

const renderReceipt = readObject(readObjectField(render, "receipt", "render.receipt"), "render.receipt");
assert(readObjectField(renderReceipt, "operation", "render.receipt.operation") === "render.final", "render receipt operation mismatch");
assert(readObjectField(renderReceipt, "status", "render.receipt.status") === "passed", "render receipt did not pass");
const renderArtifacts = readArray(readObjectField(renderReceipt, "artifacts", "render.receipt.artifacts"));
const jpegArtifact = renderArtifacts.find((artifact) => readObjectField(artifact, "mediaType", "artifact.mediaType") === "image/jpeg");
assert(jpegArtifact, "render receipt missing image/jpeg artifact");
assert(readObjectField(jpegArtifact, "status", "jpegArtifact.status") === "available", "JPEG artifact must be available");

const quality = await runCli([
  "quality-check",
  outputPath,
  "--expect-width",
  "1280",
  "--expect-height",
  "720",
  "--min-edge-pixels",
  "1",
  "--min-non-transparent-pixels",
  "1"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `JPEG quality-check failed: ${JSON.stringify(quality, null, 2)}`);
assert(readObjectField(quality, "command", "quality.command") === "quality-check", "unexpected quality command");
const qualityMedia = readObject(readObjectField(quality, "media", "quality.media"), "quality.media");
assert(readObjectField(qualityMedia, "width", "quality.media.width") === 1280, "quality media width mismatch");
assert(readObjectField(qualityMedia, "height", "quality.media.height") === 720, "quality media height mismatch");

console.log(JSON.stringify({
  ok: true,
  command: "render-jpeg:smoke",
  packageRoot,
  outputPath,
  preset: "jpeg-frame",
  render: {
    receiptId: readObjectField(renderReceipt, "id", "render.receipt.id"),
    mediaType: "image/jpeg",
    frameLane: readObjectField(render, "frameLane", "render.frameLane")
  },
  quality: {
    framePath: readObjectField(quality, "framePath", "quality.framePath"),
    media: qualityMedia
  }
}, null, 2));

function readObject(value: unknown, label: string = "value"): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label = key): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}
