/**
 * Host gate for the lightweight animation preset: two real GIF renders, one per frame lane.
 *
 * Role: prove that `--preset gif` delivers a real, playable GIF on the lane a host would actually
 * use for a text package, and that the narrow native lane still delivers one for the packages it can
 * legitimately draw.
 *
 * This smoke must not force `--frame-lane native` on the
 * keyframed lower-third, which is a TEXT package. The native lane has a fixed uppercase ASCII
 * block-glyph set and no font rasterizer, so it refuses that package with
 * `native_text_not_deliverable` — correctly, since delivering case-folded text in the wrong font is
 * worse than refusing. The gate was asserting the engine's correct refusal was a failure.
 *
 * The fix is two renders rather than one, because they prove different things and neither alone is
 * the proof this gate is for:
 *
 *   - **Delivery lane (browser frames, keyframed lower-third).** The documented fixture, rendered
 *     the way a host renders it. It warns — the font is not installed and the lower third holds
 *     still after animating in — so it is accepted through the canonical warned-success rule in
 *     `scripts/render-smoke-status.ts`, never by simply widening the accepted status set.
 *   - **Native lane (procedural relationships, text-free).** Keeps the browserless frame path under
 *     gate, pointed at a package it can draw faithfully: one shape driven by a relationship graph,
 *     no text, no glyphs. This is the suite's exact-`passed` GIF proof.
 */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import {
  assertJobSucceeded,
  assertReceiptSucceeded,
  assertWarningFreeSuccess,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  readDeliveredMedia,
  smokeJobIdentity
} from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures/packages/keyframed-lower-third");
/** Text-free by construction: one shape layer driven by a procedural relationship graph. */
const nativePackageRoot = join(repoRoot, "fixtures/packages/procedural-relationships");
const outDir = join(repoRoot, ".scratch", "render-gif-smoke");
const framesRoot = join(outDir, "frames");
const qualityScratchRoot = join(outDir, "quality-scratch");
const outputPath = join(outDir, "keyframed-lower-third.gif");
const nativeFramesRoot = join(outDir, "native-frames");
const nativeQualityScratchRoot = join(outDir, "native-quality-scratch");
const nativeOutputPath = join(outDir, "procedural-relationships.gif");
/** The native fixture's own canvas; the delivery fixture is 1280x720. */
const nativeWidth = 320;
const nativeHeight = 180;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Delivery lane: browser frames, the documented fixture, a warned success.
// ---------------------------------------------------------------------------

const { jobId, callerId } = smokeJobIdentity("render-gif");

const render = await runCli([
  "render",
  packageRoot,
  "--lane",
  "ffmpeg",
  "--frame-lane",
  "browser",
  "--out",
  outputPath,
  "--preset",
  "gif",
  "--min-unique-frames",
  "2",
  "--job-id",
  jobId,
  "--caller-id",
  callerId
], { scratchRoot: framesRoot });

assert(render.ok, `GIF render smoke failed: ${JSON.stringify(render, null, 2)}`);
assert(readObjectField(render, "command", "render.command") === "render", "unexpected render command");
assert(readObjectField(render, "lane", "render.lane") === "ffmpeg", "GIF render must use the ffmpeg lane");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", "GIF delivery render must use browser frames");
assert(readObjectField(render, "preset", "render.preset") === "gif", "GIF render preset mismatch");
assert(readObjectField(render, "outputPath", "render.outputPath") === outputPath, "GIF output path mismatch");

const gifBytes = await readDeliveredMedia(outputPath, "GIF render");
assertGifSignature(gifBytes, "GIF render");

const renderOutput = readObject(readObjectField(render, "output", "render.output"), "render.output");
assert(readObjectField(renderOutput, "preset", "render.output.preset") === "gif", "render receipt output preset mismatch");
assert(readObjectField(renderOutput, "audio") === undefined, "GIF render output should not include audio");

const renderReceipt = readObject(readObjectField(render, "receipt", "render.receipt"), "render.receipt");
assert(readObjectField(renderReceipt, "operation", "render.receipt.operation") === "render.final", "render receipt operation mismatch");
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "GIF render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const renderJob = await assertJobSucceeded(jobId, callerId, "GIF render");
const renderArtifacts = readArray(readObjectField(renderReceipt, "artifacts", "render.receipt.artifacts"));
const gifArtifact = renderArtifacts.find((artifact) => readObjectField(artifact, "mediaType", "artifact.mediaType") === "image/gif");
assert(gifArtifact, "render receipt missing image/gif artifact");
assert(readObjectField(gifArtifact, "status", "gifArtifact.status") === "available", "GIF artifact must be available");

const quality = await runCli([
  "quality-check",
  outputPath,
  "--expect-width",
  "1280",
  "--expect-height",
  "720",
  "--at-ms",
  "750",
  "--min-edge-pixels",
  "1",
  "--min-non-transparent-pixels",
  "1"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `GIF quality-check failed: ${JSON.stringify(quality, null, 2)}`);
assert(readObjectField(quality, "command", "quality.command") === "quality-check", "unexpected quality command");
const qualityMedia = readObject(readObjectField(quality, "media", "quality.media"), "quality.media");
assert(readObjectField(qualityMedia, "codec", "quality.media.codec") === "gif", "quality media codec mismatch");
assert(readObjectField(qualityMedia, "width", "quality.media.width") === 1280, "quality media width mismatch");
assert(readObjectField(qualityMedia, "height", "quality.media.height") === 720, "quality media height mismatch");

// ---------------------------------------------------------------------------
// 2. Native frame lane: a package it can draw faithfully, and an exact `passed`.
// ---------------------------------------------------------------------------

const nativeIdentity = smokeJobIdentity("render-gif-native");

const nativeRender = await runCli([
  "render",
  nativePackageRoot,
  "--lane",
  "ffmpeg",
  "--frame-lane",
  "native",
  "--out",
  nativeOutputPath,
  "--preset",
  "gif",
  "--min-unique-frames",
  "2",
  "--job-id",
  nativeIdentity.jobId,
  "--caller-id",
  nativeIdentity.callerId
], { scratchRoot: nativeFramesRoot });

assert(nativeRender.ok, `Native-lane GIF render smoke failed: ${JSON.stringify(nativeRender, null, 2)}`);
assert(readObjectField(nativeRender, "frameLane", "nativeRender.frameLane") === "native", "native GIF render must use native frames");
assert(readObjectField(nativeRender, "preset", "nativeRender.preset") === "gif", "native GIF render preset mismatch");

const nativeGifBytes = await readDeliveredMedia(nativeOutputPath, "Native-lane GIF render");
assertGifSignature(nativeGifBytes, "Native-lane GIF render");

const nativeReceipt = readObject(readObjectField(nativeRender, "receipt", "nativeRender.receipt"), "nativeRender.receipt");
assert(readObjectField(nativeReceipt, "operation", "nativeRender.receipt.operation") === "render.final", "native render receipt operation mismatch");
// The one exact-`passed` assertion in this gate, pointed at a fixture with nothing to warn about:
// no text, so no font fallback and no case folding, and continuous motion, so no static advisory.
const nativeSuccess = assertWarningFreeSuccess(nativeReceipt, "Native-lane GIF render");
const nativeJob = await assertJobSucceeded(nativeIdentity.jobId, nativeIdentity.callerId, "Native-lane GIF render");
const nativeArtifacts = readArray(readObjectField(nativeReceipt, "artifacts", "nativeRender.receipt.artifacts"));
const nativeGifArtifact = nativeArtifacts.find((artifact) => readObjectField(artifact, "mediaType", "artifact.mediaType") === "image/gif");
assert(nativeGifArtifact, "native render receipt missing image/gif artifact");
assert(readObjectField(nativeGifArtifact, "status", "nativeGifArtifact.status") === "available", "native GIF artifact must be available");

const nativeQuality = await runCli([
  "quality-check",
  nativeOutputPath,
  "--expect-width",
  String(nativeWidth),
  "--expect-height",
  String(nativeHeight),
  "--at-ms",
  "1000",
  "--min-edge-pixels",
  "1",
  "--min-non-transparent-pixels",
  "1"
], { scratchRoot: nativeQualityScratchRoot });

assert(nativeQuality.ok, `Native-lane GIF quality-check failed: ${JSON.stringify(nativeQuality, null, 2)}`);
const nativeQualityMedia = readObject(readObjectField(nativeQuality, "media", "nativeQuality.media"), "nativeQuality.media");
assert(readObjectField(nativeQualityMedia, "codec", "nativeQuality.media.codec") === "gif", "native quality media codec mismatch");
assert(readObjectField(nativeQualityMedia, "width", "nativeQuality.media.width") === nativeWidth, "native quality media width mismatch");
assert(readObjectField(nativeQualityMedia, "height", "nativeQuality.media.height") === nativeHeight, "native quality media height mismatch");

console.log(JSON.stringify({
  ok: true,
  command: "render-gif:smoke",
  packageRoot,
  outputPath,
  preset: "gif",
  render: {
    receiptId: readObjectField(renderReceipt, "id", "render.receipt.id"),
    mediaType: "image/gif",
    bytes: gifBytes.length,
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
    receiptStatus: renderSuccess.status,
    acceptedWarnings: renderSuccess.warnings,
    matchedAdvisories: renderSuccess.matchedAdvisories,
    job: { jobId, callerId, ...renderJob }
  },
  quality: {
    framePath: readObjectField(quality, "framePath", "quality.framePath"),
    media: qualityMedia
  },
  nativeLane: {
    packageRoot: nativePackageRoot,
    outputPath: nativeOutputPath,
    receiptId: readObjectField(nativeReceipt, "id", "nativeRender.receipt.id"),
    mediaType: "image/gif",
    bytes: nativeGifBytes.length,
    frameLane: readObjectField(nativeRender, "frameLane", "nativeRender.frameLane"),
    receiptStatus: nativeSuccess.status,
    receiptWarnings: nativeSuccess.warnings,
    job: { jobId: nativeIdentity.jobId, callerId: nativeIdentity.callerId, ...nativeJob },
    quality: {
      framePath: readObjectField(nativeQuality, "framePath", "nativeQuality.framePath"),
      media: nativeQualityMedia
    }
  }
}, null, 2));

/** Both GIF revisions are accepted; anything else is not a GIF, whatever the extension says. */
function assertGifSignature(bytes: Buffer, label: string): void {
  const signature = bytes.subarray(0, 6).toString("ascii");
  assert(signature === "GIF87a" || signature === "GIF89a", `${label} output is not a GIF: ${signature}`);
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
