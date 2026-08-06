import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
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
const scriptPath = resolve(optionValue("--script") ?? join(repoRoot, "fixtures", "workflows", "advanced-effects.scripted-video.json"));
const outRoot = join(repoRoot, ".scratch", "real-workflows", "advanced-effects");
const evidencePath = join(outRoot, "evidence.json");

await stat(scriptPath);
const campaign = await readJsonObjectFile(scriptPath, "Advanced effects scripted-video");
assert.equal(campaign.schema, "shellx-motion/scripted-video@1");
assert.equal(campaign.workflow, "advanced-effects-real-render");
const frames = readArray(readObjectField(campaign, "frames", "campaign.frames"), "campaign.frames")
  .map((frame, index) => readRecord(frame, `campaign.frames[${index}]`));
assert(frames.length >= 3, "Advanced effects campaign must contain at least three frames.");
const effectTypes = new Set(frames.flatMap((frame) =>
  readArray(readObjectField(frame, "effects", "campaign.frame.effects"), "campaign.frame.effects")
    .map((effect, index) => readString(readObjectField(effect, "type", `campaign.frame.effects[${index}].type`), `campaign.frame.effects[${index}].type`))
));
for (const requiredEffect of ["rain", "signalPulse", "cameraPush", "particleField", "scanSweep"]) {
  assert(effectTypes.has(requiredEffect), `Advanced effects campaign must include ${requiredEffect}.`);
}
const width = readNumber(readObjectField(campaign, "width", "campaign.width"), "campaign.width");
const height = readNumber(readObjectField(campaign, "height", "campaign.height"), "campaign.height");
const durationMs = frames.reduce((total, frame, index) =>
  total + readNumber(readObjectField(frame, "durationMs", `campaign.frames[${index}].durationMs`), `campaign.frames[${index}].durationMs`),
0);

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

const result = await runCli([
  "connector",
  "script-to-cut",
  scriptPath,
  "--out",
  outRoot,
  "--cut-import-mode",
  "rendered_media"
]);

assert(result.ok, `Advanced effects workflow failed: ${JSON.stringify(result, null, 2)}`);
const render = readRecord(readObjectField(result, "render", "result.render"), "result.render");
assert.equal(readObjectField(render, "required", "render.required"), true);
assert.equal(readObjectField(render, "dryRun", "render.dryRun"), false);
assert.equal(readObjectField(render, "frameLane", "render.frameLane"), "browser");

const renderedMedia = findArtifact(readObjectField(result, "artifacts", "result.artifacts"), "rendered_media");
assert.equal(renderedMedia.status, "available");
assert.equal(renderedMedia.mediaType, "video/mp4");
assert.equal(renderedMedia.primary, true);

const packageDir = readString(readObjectField(result, "packageDir", "result.packageDir"), "result.packageDir");
const manifestPath = join(packageDir, "manifest.json");
const renderPath = readString(readObjectField(render, "outputPath", "render.outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const cutPlanPath = readString(readObjectField(result, "cutPlanPath", "result.cutPlanPath"), "result.cutPlanPath");
const connectorReceiptPath = readString(readObjectField(result, "receiptPath", "result.receiptPath"), "result.receiptPath");

await stat(packageDir);
await stat(manifestPath);
await stat(renderPath);
await stat(renderReceiptPath);
await stat(cutPlanPath);
await stat(connectorReceiptPath);
const mp4 = await assertMp4Container(renderPath, "Advanced effects render");

const renderReceipt = await readJsonObjectFile(renderReceiptPath, "Advanced effects render receipt");
const connectorReceipt = await readJsonObjectFile(connectorReceiptPath, "Advanced effects connector receipt");
const cutPlan = await readJsonObjectFile(cutPlanPath, "Advanced effects Cut plan");
const manifest = await readJsonObjectFile(manifestPath, "Advanced effects package manifest");
const packageId = readString(readObjectField(manifest, "id", "manifest.id"), "manifest.id");
assert.equal(renderReceipt.status, "passed", `expected passed render receipt, got ${String(renderReceipt.status)}`);
assert.equal(connectorReceipt.status, "passed", `expected passed connector receipt, got ${String(connectorReceipt.status)}`);
assert.equal(cutPlan.schema, "shellx-motion/cut-import-plan@1");
assert.equal(cutPlan.mode, "rendered_media");
assertNoCriticalQualityWarnings(renderReceipt.warnings, "Advanced effects render receipt");
const intraSceneMotion = await assertIntraSceneMotion(join(outRoot, "frames", packageId));

const qualityStart = await runQualityGate({
  runCli,
  mediaPath: renderPath,
  packageDir,
  scratchRoot: join(outRoot, "quality-start"),
  atMs: 0,
  width,
  height,
  label: "Advanced effects start"
});
const qualityMiddle = await runQualityGate({
  runCli,
  mediaPath: renderPath,
  packageDir,
  scratchRoot: join(outRoot, "quality-middle"),
  atMs: Math.floor(durationMs / 2),
  width,
  height,
  label: "Advanced effects middle"
});
const qualityFinal = await runQualityGate({
  runCli,
  mediaPath: renderPath,
  packageDir,
  scratchRoot: join(outRoot, "quality-final"),
  atMs: Math.max(0, durationMs - 500),
  width,
  height,
  label: "Advanced effects final"
});
const copied = await copyToWindowsDownloads(renderPath, "shellx-advanced-effects-showcase.mp4");

const evidence = {
  ok: true,
  command: "real-workflow.advanced-effects",
  campaignScriptPath: scriptPath,
  packageDir,
  renderPath,
  renderReceiptPath,
  cutPlanPath,
  connectorReceiptPath,
  copied,
  render: {
    bytes: mp4.bytes,
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
    durationMs,
    width,
    height
  },
  effects: {
    frameCount: frames.length,
    effectCount: frames.reduce((total, frame) => total + readArray(readObjectField(frame, "effects", "campaign.frame.effects"), "campaign.frame.effects").length, 0),
    effectTypes: [...effectTypes].sort(),
    intraSceneMotion
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

async function assertIntraSceneMotion(framesDir: string): Promise<{ sampledFrames: string[]; uniqueHashCount: number }> {
  const sampledFrames = ["000001.png", "000030.png", "000060.png"];
  const hashes = await Promise.all(sampledFrames.map(async (frameName) => {
    const bytes = await readFile(join(framesDir, frameName));
    return createHash("sha256").update(bytes).digest("hex");
  }));
  const uniqueHashCount = new Set(hashes).size;
  assert(uniqueHashCount >= 2, `Advanced effects first scene should animate within a scene; sampled frames had ${uniqueHashCount} unique hashes.`);
  return { sampledFrames, uniqueHashCount };
}
