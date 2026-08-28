/**
 * Host gate for captions: import through the action path, then render final media.
 *
 * Acceptance follows the shared contract rule in `scripts/render-smoke-status.ts`. The captioned
 * package inherits the source fixture's font fallback and static-motion advisories, so a correct
 * engine delivers the MP4 with a `warning` receipt — which maps to job outcome `succeeded`. The gate
 * checks that mapping, reads the job store back, proves the MP4 bytes are real, and requires the
 * warning to be one of the advisories predicted here.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "../packages/core/src/output-path-trusted-workspace";
import {
  assertJobSucceeded,
  assertReceiptSucceeded,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  readDeliveredMedia,
  smokeJobIdentity
} from "./render-smoke-status";
import { renderingSamplesProofRoot } from "./rendering-samples-proof-root";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceFixturePackageRoot = join(repoRoot, "fixtures/packages/keyframed-lower-third");
const outDir = renderingSamplesProofRoot(join(repoRoot, ".scratch", "render-caption-smoke"));
const sourcePackageRoot = join(outDir, "source-package");
const inputsDir = join(outDir, "inputs");
const captionsPath = join(inputsDir, "captions.srt");
const packageRoot = join(outDir, "package");
const framesRoot = join(outDir, "frames");
const qualityScratchRoot = join(outDir, "quality-scratch");
const outputPath = join(outDir, "caption-lower-third.mp4");

await rm(outDir, { recursive: true, force: true });
await mkdir(inputsDir, { recursive: true });
await cp(sourceFixturePackageRoot, sourcePackageRoot, { recursive: true, errorOnExist: true, force: false });
const workspaceAuthority = await createTrustedWorkspaceAnchor(outDir);
const inWorkspace = async <T>(operation: () => Promise<T>): Promise<T> => await withTrustedWorkspaceAnchor(workspaceAuthority, operation);
await writeFile(
  captionsPath,
  [
    "1",
    "00:00:00,000 --> 00:00:01,200",
    "First caption",
    "",
    "2",
    "00:00:01,300 --> 00:00:02,600",
    "Second caption"
  ].join("\n"),
  "utf8"
);

const imported = await inWorkspace(async () => await runCli([
  "debug",
  "caption-import",
  "--tier",
  "edit_motion",
  "--trusted-local-tier",
  "--package",
  sourcePackageRoot,
  "--out",
  packageRoot,
  "--captions-file",
  captionsPath,
  "--format",
  "srt",
  "--track",
  "captions",
  "--layer-prefix",
  "cap",
  "--created-by",
  "render-caption-smoke"
]));

assert(imported.ok, `Caption import smoke failed: ${JSON.stringify(imported, null, 2)}`);
assert(readObjectField(imported, "command", "imported.command") === "debug.caption-import", "unexpected caption import command");
const importResult = readObject(readObjectField(imported, "result", "imported.result"), "imported.result");
assert(readObjectField(importResult, "cueCount", "imported.result.cueCount") === 2, "caption import cue count mismatch");
assert(readObjectField(importResult, "trackId", "imported.result.trackId") === "captions", "caption track mismatch");
assert(readArray(readObjectField(importResult, "insertedLayerIds", "imported.result.insertedLayerIds")).join(",") === "cap_0001,cap_0002", "caption layer ids mismatch");

const motion = readJsonObject(await readFile(join(packageRoot, "motion.json"), "utf8"), "patched motion");
const layers = readArray(readObjectField(motion, "layers", "motion.layers"));
assert(layers.some((layer) => readObjectField(layer, "id", "layer.id") === "cap_0001" && readObjectField(layer, "type", "layer.type") === "caption"), "patched package missing cap_0001 caption");
assert(layers.some((layer) => readObjectField(layer, "id", "layer.id") === "cap_0002" && readObjectField(layer, "text", "layer.text") === "Second caption"), "patched package missing second caption text");
const tracks = readArray(readObjectField(motion, "tracks", "motion.tracks"));
assert(tracks.some((track) => readObjectField(track, "id", "track.id") === "captions"), "patched package missing captions track");

const validated = await inWorkspace(async () => await runCli(["validate", packageRoot]));
assert(validated.ok, `Caption package validation failed: ${JSON.stringify(validated, null, 2)}`);

const { jobId, callerId } = smokeJobIdentity("render-caption");

const render = await inWorkspace(async () => await runCli([
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
], { scratchRoot: framesRoot }));

assert(render.ok, `Caption render smoke failed: ${JSON.stringify(render, null, 2)}`);
assert(readObjectField(render, "command", "render.command") === "render", "unexpected render command");
assert(readObjectField(render, "lane", "render.lane") === "ffmpeg", "caption render must use ffmpeg");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", "caption render must use browser frames");
assert(readObjectField(render, "preset", "render.preset") === "mp4-h264", "caption render preset mismatch");

const mp4Bytes = await readDeliveredMedia(outputPath, "Caption render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "captioned output is not an MP4 container");
const renderReceipt = readObject(readObjectField(render, "receipt", "render.receipt"), "render.receipt");
assert(readObjectField(renderReceipt, "operation", "render.receipt.operation") === "render.final", "render receipt operation mismatch");
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Caption render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const renderJob = await assertJobSucceeded(jobId, callerId, "Caption render");
const renderArtifacts = readArray(readObjectField(renderReceipt, "artifacts", "render.receipt.artifacts"));
const mp4Artifact = renderArtifacts.find((artifact) => readObjectField(artifact, "mediaType", "artifact.mediaType") === "video/mp4");
assert(mp4Artifact, "render receipt missing video/mp4 artifact");
assert(readObjectField(mp4Artifact, "status", "mp4Artifact.status") === "available", "captioned MP4 artifact must be available");

const quality = await inWorkspace(async () => await runCli([
  "quality-check",
  outputPath,
  "--at-ms",
  "500",
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
], { scratchRoot: qualityScratchRoot }));

assert(quality.ok, `Caption quality-check failed: ${JSON.stringify(quality, null, 2)}`);
assert(readObjectField(quality, "command", "quality.command") === "quality-check", "unexpected quality command");
const qualityMedia = readObject(readObjectField(quality, "media", "quality.media"), "quality.media");
assert(readObjectField(qualityMedia, "codec", "quality.media.codec") === "h264", "quality media codec mismatch");
const visualDiff = readObject(readObjectField(quality, "visualDiff", "quality.visualDiff"), "quality.visualDiff");
assert(readNumber(readObjectField(visualDiff, "meanAbsoluteError", "quality.visualDiff.meanAbsoluteError"), "quality.visualDiff.meanAbsoluteError") <= 3, "caption preview parity mean diff too high");

console.log(JSON.stringify({
  ok: true,
  command: "render-caption:smoke",
  sourceFixturePackageRoot,
  sourcePackageRoot,
  captionsPath,
  packageRoot,
  outputPath,
  import: {
    trackId: readObjectField(importResult, "trackId", "import.result.trackId"),
    insertedLayerIds: readObjectField(importResult, "insertedLayerIds", "import.result.insertedLayerIds")
  },
  render: {
    receiptId: readObjectField(renderReceipt, "id", "render.receipt.id"),
    mediaType: "video/mp4",
    bytes: mp4Bytes.length,
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
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

function readJsonObject(source: string, label: string): object {
  return readObject(JSON.parse(source), label);
}

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
