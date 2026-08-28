/**
 * Host gate for normal delivery export: real H.264 MP4, visible motion, and preview parity.
 *
 * Success is judged against the canonical status contract, not against the word `passed`. This
 * fixture renders text with a font the host usually does not have and holds still for most of its
 * duration, so a correct engine delivers the MP4 and says so with a `warning` receipt. The gate
 * therefore accepts a warned success only when all four of these hold together — see
 * `scripts/render-smoke-status.ts` for why each is separately necessary:
 *   - the receipt status maps to job outcome `succeeded` (`schemas/job-status.json`),
 *   - the job store, read back through `shellx-motion job get`, says `outcome: succeeded`,
 *   - the MP4 on disk is real, non-empty, `ftyp`-signed media,
 *   - and each warning it carries is an advisory this smoke predicted.
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
const outDir = join(repoRoot, ".scratch", "render-mp4-smoke");
const framesRoot = join(outDir, "frames");
const posterQualityScratchRoot = join(outDir, "poster-quality-scratch");
const qualityScratchRoot = join(outDir, "quality-scratch");
const outputPath = join(outDir, "keyframed-lower-third.mp4");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Naming the job up front is what lets the outcome be read back from the per-user job store after
// the render returns, which is the only evidence that the run was RECORDED as a success.
const { jobId, callerId } = smokeJobIdentity("render-mp4");

const render = await runCli([
  "render",
  packageRoot,
  "--lane",
  "ffmpeg",
  "--out",
  outputPath,
  "--min-unique-frames",
  "2",
  "--job-id",
  jobId,
  "--caller-id",
  callerId
], { scratchRoot: framesRoot });

assert(render.ok, `MP4 render smoke failed: ${JSON.stringify(render, null, 2)}`);
assert(readObjectField(render, "command", "render.command") === "render", "unexpected render command");
assert(readObjectField(render, "lane", "render.lane") === "ffmpeg", "MP4 render must use the ffmpeg lane");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", "MP4 render must use browser frames");
assert(readObjectField(render, "preset", "render.preset") === "mp4-h264", "MP4 render preset mismatch");
assert(readObjectField(render, "outputPath", "render.outputPath") === outputPath, "MP4 output path mismatch");

const mp4Bytes = await readDeliveredMedia(outputPath, "MP4 render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "rendered output is not an MP4 container");

const renderOutput = readObject(readObjectField(render, "output", "render.output"), "render.output");
assert(readObjectField(renderOutput, "preset", "render.output.preset") === "mp4-h264", "render receipt output preset mismatch");
assert(readObjectField(renderOutput, "codec", "render.output.codec") === "h264", "render receipt output codec mismatch");
assert(readObjectField(renderOutput, "container", "render.output.container") === "mp4", "render receipt output container mismatch");
assert(readNumber(readObjectField(renderOutput, "width", "render.output.width"), "render.output.width") === 1280, "render receipt width mismatch");
assert(readNumber(readObjectField(renderOutput, "height", "render.output.height"), "render.output.height") === 720, "render receipt height mismatch");
const renderResources = readObject(readObjectField(renderOutput, "resources", "render.output.resources"), "render.output.resources");
assert(readObjectField(renderResources, "schema", "render.output.resources.schema") === "shellx-motion/local-job-resources@1", "render resource schema mismatch");
assert(readObjectField(renderResources, "lane", "render.output.resources.lane") === "ffmpeg", "render resource lane mismatch");
assert(readObjectField(renderResources, "state", "render.output.resources.state") === "passed", "render resource policy did not pass");
assert(readNumber(readObjectField(renderResources, "watchedProcessCount", "render.output.resources.watchedProcessCount"), "render.output.resources.watchedProcessCount") >= 1, "render resource policy did not watch FFmpeg");
const processContainment = readObject(readObjectField(renderResources, "processContainment", "render.output.resources.processContainment"), "render.output.resources.processContainment");
if (process.platform === "win32") {
  assert(readObjectField(processContainment, "mode", "render.output.resources.processContainment.mode") === "windows-job-object", "Windows MP4 render did not use native Job Object containment");
  assert(readObjectField(processContainment, "memoryLimit", "render.output.resources.processContainment.memoryLimit") === "job-commit", "Windows MP4 render did not bind the native job-commit limit");
  const launcher = readObject(readObjectField(processContainment, "launcher", "render.output.resources.processContainment.launcher"), "render.output.resources.processContainment.launcher");
  assert(/^[a-f0-9]{64}$/.test(String(readObjectField(launcher, "sha256", "render.output.resources.processContainment.launcher.sha256"))), "Windows MP4 render did not receipt the trusted launcher hash");
} else if (process.platform === "linux" || process.platform === "darwin") {
  assert(readObjectField(processContainment, "mode", "render.output.resources.processContainment.mode") === "unix-process-group", "Unix MP4 render did not use process-group containment");
}
assert(readObjectField(processContainment, "status", "render.output.resources.processContainment.status") === "enforced", "MP4 render process containment was not enforced");

const renderReceipt = readObject(readObjectField(render, "receipt", "render.receipt"), "render.receipt");
assert(readObjectField(renderReceipt, "operation", "render.receipt.operation") === "render.final", "render receipt operation mismatch");
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "MP4 render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const renderJob = await assertJobSucceeded(jobId, callerId, "MP4 render");
const renderArtifacts = readArray(readObjectField(renderReceipt, "artifacts", "render.receipt.artifacts"));
const mp4Artifact = renderArtifacts.find((artifact) => readObjectField(artifact, "mediaType", "artifact.mediaType") === "video/mp4");
assert(mp4Artifact, "render receipt missing video/mp4 artifact");
assert(readObjectField(mp4Artifact, "status", "mp4Artifact.status") === "available", "MP4 artifact must be available");

const frameTransport = readObject(readObjectField(renderOutput, "frameTransport", "render.output.frameTransport"), "render.output.frameTransport");
assert(readObjectField(frameTransport, "delivery", "render.output.frameTransport.delivery") === "streamed", "MP4 default render must use streamed frame delivery");
const frameCount = readNumber(readObjectField(frameTransport, "frameCount", "render.output.frameTransport.frameCount"), "render.output.frameTransport.frameCount");
assert(frameCount >= 2, "MP4 render must emit multiple frames");
assert(readObjectField(frameTransport, "retainedFrameCount", "render.output.frameTransport.retainedFrameCount") === 0, "MP4 streamed delivery must not retain source frames");

const posterQuality = await runCli([
  "quality-check",
  outputPath,
  "--at-ms",
  "0",
  "--expect-width",
  "1280",
  "--expect-height",
  "720",
  "--min-bright-pixels",
  "500",
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
  "3",
  "--min-psnr-db",
  "35"
], { scratchRoot: posterQualityScratchRoot });

assert(posterQuality.ok, `MP4 poster-frame quality-check failed: ${JSON.stringify(posterQuality, null, 2)}`);

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
  "3",
  "--min-psnr-db",
  "35"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `MP4 quality-check failed: ${JSON.stringify(quality, null, 2)}`);
assert(readObjectField(quality, "command", "quality.command") === "quality-check", "unexpected quality command");
const qualityMedia = readObject(readObjectField(quality, "media", "quality.media"), "quality.media");
assert(readObjectField(qualityMedia, "codec", "quality.media.codec") === "h264", "quality media codec mismatch");
assert(readNumber(readObjectField(qualityMedia, "width", "quality.media.width"), "quality.media.width") === 1280, "quality media width mismatch");
assert(readNumber(readObjectField(qualityMedia, "height", "quality.media.height"), "quality.media.height") === 720, "quality media height mismatch");
const visualDiff = readObject(readObjectField(quality, "visualDiff", "quality.visualDiff"), "quality.visualDiff");
assert(readNumber(readObjectField(visualDiff, "meanAbsoluteError", "quality.visualDiff.meanAbsoluteError"), "quality.visualDiff.meanAbsoluteError") <= 3, "MP4 preview parity mean diff too high");
const psnrDb = readObjectField(visualDiff, "psnrDb", "quality.visualDiff.psnrDb");
assert(psnrDb === null || readNumber(psnrDb, "quality.visualDiff.psnrDb") >= 35, "MP4 preview parity PSNR too low");

console.log(JSON.stringify({
  ok: true,
  command: "render-mp4:smoke",
  packageRoot,
  outputPath,
  preset: "mp4-h264",
  render: {
    receiptId: readObjectField(renderReceipt, "id", "render.receipt.id"),
    mediaType: "video/mp4",
    bytes: mp4Bytes.length,
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
    frames: frameCount,
    receiptStatus: renderSuccess.status,
    acceptedWarnings: renderSuccess.warnings,
    matchedAdvisories: renderSuccess.matchedAdvisories,
    job: { jobId, callerId, ...renderJob },
    resources: {
      state: readObjectField(renderResources, "state", "render.output.resources.state"),
      queueWaitMs: readObjectField(renderResources, "queueWaitMs", "render.output.resources.queueWaitMs"),
      durationMs: readObjectField(renderResources, "durationMs", "render.output.resources.durationMs"),
      peakProcessTreeRssBytes: readObjectField(renderResources, "peakProcessTreeRssBytes", "render.output.resources.peakProcessTreeRssBytes"),
      processContainment
    }
  },
  quality: {
    posterFramePath: readObjectField(posterQuality, "framePath", "posterQuality.framePath"),
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
