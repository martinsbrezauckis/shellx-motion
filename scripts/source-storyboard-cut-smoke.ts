/**
 * Host gate for the source-driven path: an imported source becomes a reviewable storyboard, a real
 * MP4, and a Cut handoff.
 *
 * Acceptance follows the shared contract rule in `scripts/render-smoke-status.ts`. Before the
 *  class sweep this smoke `stat`ed its receipts and never read their STATUS — the opposite
 * face of the same defect as its siblings' hard-coded `passed`: those rejected an honest `warning`,
 * this one would have accepted an honest `failed`. Both receipts are now judged, and judged the same
 * way: `passed`, or `warning` together with an advisory this run can legitimately produce (the
 * native preview lane case-folds the storyboard's lowercase text; the storyboard frames hold still).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import {
  assertReceiptSucceeded,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  NATIVE_CASE_FOLD_ADVISORY,
  readDeliveredMedia
} from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outRoot = join(repoRoot, ".scratch", "source-storyboard-cut-smoke");
const sourceImportDir = join(outRoot, "source-import");
const sourceCutDir = join(outRoot, "source-cut");
const receiptsRoot = join(outRoot, "host-receipts");

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

const imported = await runCli([
  "debug",
  "source-import",
  "--tier",
  "write_local",
  "--trusted-local-tier",
  "--url",
  "https://github.com/nexu-io/html-video",
  "--kind",
  "repo",
  "--title",
  "html-video reference workflow",
  "--markdown",
  sourceMarkdown(),
  "--out",
  sourceImportDir,
  "--receipts-root",
  receiptsRoot
]);

assert(imported.ok, `Source import failed: ${JSON.stringify(imported, null, 2)}`);
const importResult = readObject(imported.result, "source import result");
const markdownPath = readString(readObjectField(importResult, "markdownPath"), "markdownPath");
const sourceImportReceiptPath = readString(readObjectField(importResult, "receiptPath"), "source import receiptPath");
await stat(markdownPath);
await stat(sourceImportReceiptPath);

const connector = await runCli([
  "connector",
  "source-to-cut",
  markdownPath,
  "--out",
  sourceCutDir,
  "--max-frames",
  "3",
  "--frame-duration-ms",
  "1400",
  "--width",
  "640",
  "--height",
  "360",
  "--fps",
  "24"
]);

assert(connector.ok, `Source-to-Cut connector failed: ${JSON.stringify(connector, null, 2)}`);
const storyboardResult = readObject(connector.storyboard, "source storyboard result");
const scriptPath = readString(readObjectField(storyboardResult, "scriptPath"), "scriptPath");
const sourceStoryboardReceiptPath = readString(readObjectField(storyboardResult, "receiptPath"), "source storyboard receiptPath");
await stat(scriptPath);
await stat(sourceStoryboardReceiptPath);

const scriptedVideo = readJsonObject(await readFile(scriptPath, "utf8"), "scripted video");
const frames = readArray(readObjectField(scriptedVideo, "frames"), "scripted video frames");
assert(frames.length === 3, `expected 3 source-derived frames, got ${frames.length}`);
assert(readObjectField(scriptedVideo, "workflow") === "source-to-scripted-video", "scripted video workflow should preserve source workflow.");
assert(readObjectField(readObject(readObjectField(scriptedVideo, "review"), "scripted video review"), "required") === true, "source storyboard should require review.");

for (const [index, frame] of frames.entries()) {
  const frameRecord = readObject(frame, `frame ${index}`);
  assert(readObjectField(frameRecord, "reviewStatus") === "needs-review", `frame ${index} must require review.`);
  const refs = readArray(readObjectField(frameRecord, "sourceRefs"), `frame ${index} sourceRefs`);
  assert(refs.length === 1, `frame ${index} should carry one source ref.`);
  assert(readObjectField(readObject(refs[0], `frame ${index} sourceRef`), "url") === "https://github.com/nexu-io/html-video", `frame ${index} source URL mismatch.`);
}

const render = readObject(connector.render, "connector render");
const artifacts = readArray(connector.artifacts, "connector artifacts");
const renderOutputPath = readString(readObjectField(render, "outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(connector.receiptPath, "connector receiptPath");
const cutPlanPath = readString(connector.cutPlanPath, "cutPlanPath");

assert(readObjectField(render, "required") === true, "source storyboard connector must require rendered media for default Cut import.");
assert(readObjectField(render, "dryRun") === false, "source storyboard connector smoke must perform a real render.");
assert(readObjectField(render, "frameLane") === "browser", `expected browser frame lane, got ${String(readObjectField(render, "frameLane"))}`);
assert(hasArtifact(artifacts, "scripted_video", "available"), "scripted_video artifact should be available.");
assert(hasArtifact(artifacts, "motion_package", "available"), "motion_package artifact should be available.");
assert(hasArtifact(artifacts, "rendered_media", "available"), "rendered_media artifact should be available.");
assert(hasArtifact(artifacts, "cut_plan", "available"), "cut_plan artifact should be available.");
assert(hasArtifact(artifacts, "source_to_cut_receipt", "available"), "source_to_cut_receipt artifact should be available.");

await stat(cutPlanPath);
const mp4Bytes = await readDeliveredMedia(renderOutputPath, "Source storyboard render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "source storyboard output is not an MP4 container.");

const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), "render receipt");
const connectorReceipt = readJsonObject(await readFile(connectorReceiptPath, "utf8"), "connector receipt");

// The render receipt covers the ffmpeg lane over browser frames.
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Source storyboard render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
// The connector receipt aggregates the native preview pass on top of it, so it can additionally
// carry the native lane's case-folding advisory — and nothing beyond these three.
const connectorSuccess = assertReceiptSucceeded(connectorReceipt, {
  label: "Source storyboard connector",
  expectedAdvisories: [NATIVE_CASE_FOLD_ADVISORY, FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});

const packageDir = readString(connector.packageDir, "packageDir");
const scriptCompileReceipt = readJsonObject(await readFile(join(packageDir, "receipts", "script-compile.receipt.json"), "utf8"), "script compile receipt");
const compileOutput = readObject(readObjectField(scriptCompileReceipt, "output"), "script compile output");
const storyboardSummary = readObject(readObjectField(compileOutput, "storyboard"), "script compile storyboard summary");
assert(readObjectField(storyboardSummary, "reviewRequired") === true, "compiled package should preserve reviewRequired storyboard metadata.");
assert(readObjectField(storyboardSummary, "sourceRefCount") === 3, "compiled package should preserve per-frame source refs.");

const qualityScratchRoot = join(outRoot, "quality-scratch");
const quality = await runCli([
  "quality-check",
  renderOutputPath,
  "--at-ms",
  "1200",
  "--expect-width",
  "640",
  "--expect-height",
  "360",
  "--min-bright-pixels",
  "1000",
  "--min-edge-pixels",
  "300",
  "--min-non-transparent-pixels",
  "1000",
  "--preview-package",
  packageDir,
  "--preview-lane",
  "browser",
  "--max-changed-pixels",
  "230400",
  "--max-mean-diff",
  "4",
  "--min-psnr-db",
  "33"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `Source storyboard quality gate failed: ${JSON.stringify(quality, null, 2)}`);

console.log(JSON.stringify({
  ok: true,
  command: "source-storyboard:smoke",
  source: {
    markdownPath,
    receiptPath: sourceImportReceiptPath
  },
  storyboard: {
    scriptPath,
    receiptPath: sourceStoryboardReceiptPath,
    frameCount: frames.length
  },
  connector: {
    packageDir,
    cutPlanPath,
    receiptPath: connectorReceiptPath,
    receiptStatus: connectorSuccess.status,
    jobOutcome: connectorSuccess.outcome,
    acceptedWarnings: connectorSuccess.warnings,
    matchedAdvisories: connectorSuccess.matchedAdvisories,
    render: {
      outputPath: renderOutputPath,
      receiptPath: renderReceiptPath,
      bytes: mp4Bytes.length,
      receiptStatus: renderSuccess.status,
      jobOutcome: renderSuccess.outcome,
      acceptedWarnings: renderSuccess.warnings,
      matchedAdvisories: renderSuccess.matchedAdvisories
    }
  },
  quality: {
    ok: quality.ok,
    command: quality.command
  }
}, null, 2));

function sourceMarkdown(): string {
  return [
    "## HTML video workflows",
    "The reference project demonstrates a source-driven flow where an HTML composition can become video output through deterministic capture and encoding.",
    "",
    "## Agent inputs",
    "Prompt, link, and repository inputs should be normalized into a reviewable storyboard before any timeline mutation happens.",
    "",
    "## ShellX placement",
    "Motion keeps the durable package, receipt, source refs, and Cut handoff separate so Canvas remains optional for scripted videos."
  ].join("\n");
}

function hasArtifact(artifacts: unknown[], role: string, status: string): boolean {
  return artifacts.some((artifact) => {
    const record = readObject(artifact, "artifact");
    return readObjectField(record, "role") === role && readObjectField(record, "status") === status;
  });
}

function readJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  return readObject(parsed, label);
}

function readObject(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

function readArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `expected ${label} array`);
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
