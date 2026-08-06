import assert from "node:assert/strict";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import {
  assertMp4Container,
  assertNoCriticalQualityWarnings,
  copyToWindowsDownloads,
  findArtifact,
  readArray,
  readJsonObjectFile,
  readNumber,
  readObjectField,
  readRecord,
  readString,
  runQualityGate,
  writeJson
} from "./real-workflow-media-quality";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const selectionPath = resolve(optionValue("--selection") ?? join(repoRoot, "fixtures", "canvas", "feature-announcement.frame-selection.json"));
const outRoot = join(repoRoot, ".scratch", "real-workflows", "canvas-feature-announcement");
const evidencePath = join(outRoot, "evidence.json");

await stat(selectionPath);
const selection = await readJsonObjectFile(selectionPath, "Canvas feature selection");
assert.equal(selection.schema, "shellx-canvas/frame-selection@1");
const selectedFrameId = readString(readObjectField(selection, "selectedFrameId", "selection.selectedFrameId"), "selection.selectedFrameId");
const frames = readArray(readObjectField(selection, "frames", "selection.frames"), "selection.frames")
  .map((frame, index) => readRecord(frame, `selection.frames[${index}]`));
const selectedFrame = frames.find((frame) => frame.id === selectedFrameId);
assert(selectedFrame, `selected Canvas frame not found: ${selectedFrameId}`);
const layers = readArray(readObjectField(selectedFrame, "layers", "selectedFrame.layers"), "selectedFrame.layers");
assert(layers.length >= 12, "Canvas workflow fixture should include a designed multi-stage board.");
const width = readNumber(readObjectField(selectedFrame, "width", "selectedFrame.width"), "selectedFrame.width");
const height = readNumber(readObjectField(selectedFrame, "height", "selectedFrame.height"), "selectedFrame.height");
const durationMs = readNumber(readObjectField(selectedFrame, "durationMs", "selectedFrame.durationMs"), "selectedFrame.durationMs");

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

const result = await runCli([
  "connector",
  "canvas-to-mp4",
  selectionPath,
  "--out",
  outRoot,
  "--preset",
  "mp4-h264"
]);

assert(result.ok, `Canvas feature workflow failed: ${JSON.stringify(result, null, 2)}`);
const cutPlanPath = readString(readObjectField(result, "cutPlanPath", "result.cutPlanPath"), "result.cutPlanPath");
const render = readRecord(readObjectField(result, "render", "result.render"), "result.render");
assert.equal(readObjectField(render, "dryRun", "render.dryRun"), false);
assert.equal(readObjectField(render, "frameLane", "render.frameLane"), "browser");
assert.equal(readObjectField(render, "preset", "render.preset"), "mp4-h264");

const renderedMedia = findArtifact(readObjectField(result, "artifacts", "result.artifacts"), "rendered_media");
assert.equal(renderedMedia.status, "available");
assert.equal(renderedMedia.mediaType, "video/mp4");
assert.equal(renderedMedia.primary, true);

const packageDir = readString(readObjectField(result, "packageDir", "result.packageDir"), "result.packageDir");
const resourceCatalogPath = readString(readObjectField(result, "resourceCatalogPath", "result.resourceCatalogPath"), "result.resourceCatalogPath");
const renderPath = readString(readObjectField(render, "outputPath", "render.outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(readObjectField(result, "receiptPath", "result.receiptPath"), "result.receiptPath");

await stat(packageDir);
await stat(resourceCatalogPath);
await stat(renderPath);
await stat(renderReceiptPath);
await stat(connectorReceiptPath);
await stat(cutPlanPath);
const mp4 = await assertMp4Container(renderPath, "Canvas feature render");

const renderReceipt = await readJsonObjectFile(renderReceiptPath, "Canvas feature render receipt");
const connectorReceipt = await readJsonObjectFile(connectorReceiptPath, "Canvas feature connector receipt");
const resourceCatalog = await readJsonObjectFile(resourceCatalogPath, "Canvas feature resource catalog");
const cutPlan = await readJsonObjectFile(cutPlanPath, "Canvas feature Cut import plan");
assert.equal(renderReceipt.status, "passed", `expected passed render receipt, got ${String(renderReceipt.status)}`);
assert.equal(connectorReceipt.status, "passed", `expected passed connector receipt, got ${String(connectorReceipt.status)}`);
assert.equal(resourceCatalog.schema, "shellx-motion/resource-catalog@1");
assert.equal(cutPlan.schema, "shellx-motion/cut-import-plan@1");
assert.equal(cutPlan.mode, "rendered_media");
assertNoCriticalQualityWarnings(renderReceipt.warnings, "Canvas feature render receipt");

const qualityStart = await runQualityGate({
  runCli,
  mediaPath: renderPath,
  packageDir,
  scratchRoot: join(outRoot, "quality-start"),
  atMs: 0,
  width,
  height,
  label: "Canvas feature start"
});
const qualityMiddle = await runQualityGate({
  runCli,
  mediaPath: renderPath,
  packageDir,
  scratchRoot: join(outRoot, "quality-middle"),
  atMs: 4600,
  width,
  height,
  label: "Canvas feature middle"
});
const qualityFinal = await runQualityGate({
  runCli,
  mediaPath: renderPath,
  packageDir,
  scratchRoot: join(outRoot, "quality-final"),
  atMs: Math.min(9000, durationMs - 1),
  width,
  height,
  label: "Canvas feature final"
});
const copied = await copyToWindowsDownloads(renderPath, "shellx-canvas-feature-announcement.mp4");

const evidence = {
  ok: true,
  command: "real-workflow.canvas-feature-announcement",
  selectionPath,
  selectedFrameId,
  packageDir,
  resourceCatalogPath,
  renderPath,
  renderReceiptPath,
  connectorReceiptPath,
  cutPlanPath,
  copied,
  render: {
    bytes: mp4.bytes,
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
    preset: readObjectField(render, "preset", "render.preset"),
    durationMs,
    width,
    height
  },
  canvas: {
    layerCount: layers.length,
    project: readObjectField(selection, "project", "selection.project")
  },
  quality: {
    start: { ok: qualityStart.ok, framePath: qualityStart.framePath },
    middle: { ok: qualityMiddle.ok, framePath: qualityMiddle.framePath },
    final: { ok: qualityFinal.ok, framePath: qualityFinal.framePath }
  }
};
await writeJson(evidencePath, evidence);
console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
