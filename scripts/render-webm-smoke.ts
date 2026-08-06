/**
 * Host gate for Web delivery export: real non-alpha VP9 WebM plus preview parity.
 *
 * Same acceptance rule as the MP4 gate (`scripts/render-smoke-status.ts`): the receipt status must
 * map to job outcome `succeeded` under `schemas/job-status.json`, the job store must agree, the
 * WebM on disk must be real EBML-signed media, and a warned success must name an advisory this
 * smoke predicted. The fixture's font fallback and static-motion measurement are those advisories.
 */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import {
  assertJobSucceeded,
  assertReceiptSucceeded,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  readDeliveredMedia,
  smokeJobIdentity
} from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures/packages/keyframed-lower-third");
const outDir = join(repoRoot, ".scratch", "render-webm-smoke");
const framesRoot = join(outDir, "frames");
const qualityScratchRoot = join(outDir, "quality-scratch");
const outputPath = join(outDir, "keyframed-lower-third.webm");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const { jobId, callerId } = smokeJobIdentity("render-webm");

const render = await runCli([
  "render",
  packageRoot,
  "--lane",
  "ffmpeg",
  "--out",
  outputPath,
  "--preset",
  "webm-vp9",
  "--min-unique-frames",
  "2",
  "--job-id",
  jobId,
  "--caller-id",
  callerId
], { scratchRoot: framesRoot });

assert(render.ok, `WebM render smoke failed: ${JSON.stringify(render, null, 2)}`);
assert(readObjectField(render, "command", "render.command") === "render", "unexpected render command");
assert(readObjectField(render, "lane", "render.lane") === "ffmpeg", "WebM render must use the ffmpeg lane");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", "WebM render must use browser frames");
assert(readObjectField(render, "preset", "render.preset") === "webm-vp9", "WebM render preset mismatch");
assert(readObjectField(render, "outputPath", "render.outputPath") === outputPath, "WebM output path mismatch");

const webmBytes = await readDeliveredMedia(outputPath, "WebM render");
assert(webmBytes.subarray(0, 4).toString("hex") === "1a45dfa3", "rendered output is not a WebM/Matroska container");

const renderOutput = readObject(readObjectField(render, "output", "render.output"), "render.output");
assert(readObjectField(renderOutput, "preset", "render.output.preset") === "webm-vp9", "render receipt output preset mismatch");
assert(readObjectField(renderOutput, "codec", "render.output.codec") === "vp9", "render receipt output codec mismatch");
assert(readObjectField(renderOutput, "container", "render.output.container") === "webm", "render receipt output container mismatch");
assert(readNumber(readObjectField(renderOutput, "width", "render.output.width"), "render.output.width") === 1280, "render receipt width mismatch");
assert(readNumber(readObjectField(renderOutput, "height", "render.output.height"), "render.output.height") === 720, "render receipt height mismatch");

const renderReceipt = readObject(readObjectField(render, "receipt", "render.receipt"), "render.receipt");
assert(readObjectField(renderReceipt, "operation", "render.receipt.operation") === "render.final", "render receipt operation mismatch");
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "WebM render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const renderJob = await assertJobSucceeded(jobId, callerId, "WebM render");
const renderArtifacts = readArray(readObjectField(renderReceipt, "artifacts", "render.receipt.artifacts"));
const webmArtifact = renderArtifacts.find((artifact) => readObjectField(artifact, "mediaType", "artifact.mediaType") === "video/webm");
assert(webmArtifact, "render receipt missing video/webm artifact");
assert(readObjectField(webmArtifact, "status", "webmArtifact.status") === "available", "WebM artifact must be available");

const frames = readObject(readObjectField(render, "frames", "render.frames"), "render.frames");
assert(readNumber(readObjectField(frames, "count", "render.frames.count"), "render.frames.count") >= 2, "WebM render must emit multiple frames");

const quality = await runCli([
  "quality-check",
  outputPath,
  "--at-ms",
  "750",
  "--expect-width",
  "1280",
  "--expect-height",
  "720",
  "--min-bright-pixels",
  "1000",
  "--min-edge-pixels",
  "1000",
  "--min-non-transparent-pixels",
  "1000",
  "--preview-package",
  packageRoot,
  "--preview-lane",
  "browser",
  "--max-changed-pixels",
  "921600",
  "--max-mean-diff",
  "6",
  "--min-psnr-db",
  "28"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `WebM quality-check failed: ${JSON.stringify(quality, null, 2)}`);
assert(readObjectField(quality, "command", "quality.command") === "quality-check", "unexpected quality command");
const qualityMedia = readObject(readObjectField(quality, "media", "quality.media"), "quality.media");
assert(readObjectField(qualityMedia, "codec", "quality.media.codec") === "vp9", "quality media codec mismatch");
assert(readNumber(readObjectField(qualityMedia, "width", "quality.media.width"), "quality.media.width") === 1280, "quality media width mismatch");
assert(readNumber(readObjectField(qualityMedia, "height", "quality.media.height"), "quality.media.height") === 720, "quality media height mismatch");
const visualDiff = readObject(readObjectField(quality, "visualDiff", "quality.visualDiff"), "quality.visualDiff");
assert(readNumber(readObjectField(visualDiff, "meanAbsoluteError", "quality.visualDiff.meanAbsoluteError"), "quality.visualDiff.meanAbsoluteError") <= 6, "WebM preview parity mean diff too high");
const psnrDb = readObjectField(visualDiff, "psnrDb", "quality.visualDiff.psnrDb");
assert(psnrDb === null || readNumber(psnrDb, "quality.visualDiff.psnrDb") >= 28, "WebM preview parity PSNR too low");

console.log(JSON.stringify({
  ok: true,
  command: "render-webm:smoke",
  packageRoot,
  outputPath,
  preset: "webm-vp9",
  render: {
    receiptId: readObjectField(renderReceipt, "id", "render.receipt.id"),
    mediaType: "video/webm",
    bytes: webmBytes.length,
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
    frames: readObjectField(frames, "count", "render.frames.count"),
    receiptStatus: renderSuccess.status,
    acceptedWarnings: renderSuccess.warnings,
    matchedAdvisories: renderSuccess.matchedAdvisories,
    job: { jobId, callerId, ...renderJob }
  },
  quality: {
    framePath: readObjectField(quality, "framePath", "quality.framePath"),
    preview: readObjectField(quality, "preview", "quality.preview"),
    visualDiff,
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

function readNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `expected ${label} finite number, got ${typeof value}`);
  return value;
}
