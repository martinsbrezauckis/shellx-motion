import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCanvasBridgeFrameSelectionExport } from "../packages/connectors/src/index";
import { runCli } from "../packages/cli/src/main";
import { verifyAttestedArtifactHandleReference, type AttestedArtifactHandleReference } from "../packages/core/src/index";
import {
  assertReceiptSucceeded,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  readDeliveredMedia
} from "./render-smoke-status";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const canvasRoot = process.env.SHELLX_CANVAS_ROOT
  ? resolve(process.env.SHELLX_CANVAS_ROOT)
  : resolve(repoRoot, "..", "shellx-canvas");
const canvasBridgePath = join(canvasRoot, "app", "server", "motion-package.mjs");
const scratchRoot = await preparePrivateRepoScratch(repoRoot);
const outRoot = join(scratchRoot, "connectors", "canvas-real-project-cut");
const selectionPath = join(outRoot, "canvas-frame-selection.json");
const connectorOut = join(outRoot, "motion-to-cut");

if (!existsSync(canvasBridgePath)) {
  console.error(`Design Studio Motion bridge not found at ${canvasBridgePath}.`);
  console.error("Set SHELLX_CANVAS_ROOT to a compatible Design Studio checkout.");
  process.exit(2);
}

await assertPrivateRepoScratchPath(repoRoot, outRoot);
await assertPrivateRepoScratchPath(repoRoot, connectorOut);
await rm(outRoot, { recursive: true, force: true });

const canvasExport = await runCanvasBridgeFrameSelectionExport({
  canvasRoot,
  outPath: selectionPath,
  target: "sample",
  projectName: "Canvas Sample Project",
  frameName: "Story Hero",
  selectedIds: ["rect-blue", "heading"],
  generatedAt: new Date().toISOString(),
  trustedCanvasRoots: [canvasRoot]
});

console.log(JSON.stringify({
  ok: canvasExport.ok,
  command: "connector.canvas-frame-selection-export",
  canvasRoot,
  selectionPath,
  ...(canvasExport.ok
    ? { schema: canvasExport.schema, selectedFrameId: canvasExport.selectedFrameId, layerIds: canvasExport.layerIds }
    : { error: canvasExport.error })
}));

if (!canvasExport.ok) {
  process.exit(1);
}

const result = await runCli(["connector", "canvas-to-cut", selectionPath, "--out", connectorOut]);
assert(result.ok, `Canvas-to-Cut smoke failed: ${JSON.stringify(result, null, 2)}`);
assert.equal(Number((await stat(connectorOut)).mode) & 0o777, 0o700, "Canvas-to-Cut P2B delivery must publish a private 0700 root under umask 0002");

const render = readObject(result.render, "result.render");
const artifacts = readArray(result.artifacts);
const renderedMedia = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media");
const artifactHandle = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "artifact_handle");
const cutPlanArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "cut_plan");
const renderOutputPath = readString(readObjectField(render, "outputPath", "render.outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(result.receiptPath, "receiptPath");
const cutPlanPath = readString(result.cutPlanPath, "cutPlanPath");

assert(readObjectField(render, "required", "render.required") === true, "Canvas-to-Cut must require rendered media.");
assert(readObjectField(render, "dryRun", "render.dryRun") === false, "Canvas-to-Cut smoke must perform a real render.");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", `expected browser frame lane, got ${String(readObjectField(render, "frameLane", "render.frameLane"))}`);
assert(readObjectField(renderedMedia, "status", "rendered_media.status") === "available", "rendered_media artifact should be available.");
assert(readObjectField(renderedMedia, "mediaType", "rendered_media.mediaType") === "video/mp4", "rendered_media artifact should be video/mp4.");
assert(readObjectField(renderedMedia, "primary", "rendered_media.primary") === true, "rendered_media artifact should be primary.");
assert(readObjectField(artifactHandle, "status", "artifact_handle.status") === "available", "artifact_handle should be available.");
assert(readObjectField(cutPlanArtifact, "status", "cut_plan.status") === "available", "cut_plan artifact should be available.");

await stat(renderReceiptPath);
await stat(connectorReceiptPath);
await stat(cutPlanPath);
const mp4Bytes = await readDeliveredMedia(renderOutputPath, "Canvas-to-Cut render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "rendered Canvas-to-Cut output is not an MP4 container.");

const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), "render receipt");
const connectorReceipt = readJsonObject(await readFile(connectorReceiptPath, "utf8"), "connector receipt");
const cutPlan = readJsonObject(await readFile(cutPlanPath, "utf8"), "cut plan");
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Canvas-to-Cut render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const connectorSuccess = assertReceiptSucceeded(connectorReceipt, {
  label: "Canvas-to-Cut connector",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
assert(readObjectField(cutPlan, "schema", "cutPlan.schema") === "shellx-motion/cut-import-plan@1", "cut import plan schema mismatch.");
assert(readObjectField(cutPlan, "mode", "cutPlan.mode") === "rendered_media", `expected rendered_media mode, got ${String(readObjectField(cutPlan, "mode", "cutPlan.mode"))}`);

const operations = readArray(readObjectField(cutPlan, "operations", "cutPlan.operations"));
const firstOperation = readObject(operations[0], "cutPlan.operations[0]");
const renderedMediaPlan = readObject(readObjectField(firstOperation, "renderedMedia", "operation.renderedMedia"), "operation.renderedMedia");
assert(readObjectField(renderedMediaPlan, "dryRun", "operation.renderedMedia.dryRun") === false, "cut plan must reference a real rendered artifact.");
const handleRef = readObject(readObjectField(renderedMediaPlan, "handle", "operation.renderedMedia.handle"), "operation.renderedMedia.handle");
const handle = readJsonObject(await readFile(join(connectorOut, readString(readObjectField(handleRef, "rootRelativePath", "handle.rootRelativePath"), "handle.rootRelativePath")), "utf8"), "artifact handle");
assert(join(connectorOut, readString(readObjectField(handle, "rootRelativePath", "artifactHandle.rootRelativePath"), "artifactHandle.rootRelativePath")) === renderOutputPath, "artifact handle media path mismatch.");
const verifiedArtifact = await verifyAttestedArtifactHandleReference(connectorOut, handleRef as unknown as AttestedArtifactHandleReference, { requiredReceiptRoles: ["render", "connector"] });

console.log(JSON.stringify({
  ok: true,
  command: "connector.canvas-cut-smoke",
  canvasRoot,
  selectionPath,
  cutPlanPath,
  render: {
    required: readObjectField(render, "required", "render.required"),
    dryRun: readObjectField(render, "dryRun", "render.dryRun"),
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
    outputPath: renderOutputPath,
    receiptPath: renderReceiptPath,
    bytes: mp4Bytes.length,
    receiptStatus: renderSuccess.status,
    jobOutcome: renderSuccess.outcome,
    acceptedWarnings: renderSuccess.warnings,
    matchedAdvisories: renderSuccess.matchedAdvisories
  },
  connector: {
    receiptPath: connectorReceiptPath,
    receiptStatus: connectorSuccess.status,
    jobOutcome: connectorSuccess.outcome,
    acceptedWarnings: connectorSuccess.warnings,
    matchedAdvisories: connectorSuccess.matchedAdvisories
  },
  attestation: {
    id: readObjectField(handle, "id", "artifactHandle.id"),
    descriptorPath: verifiedArtifact.descriptorPath,
    mediaPath: verifiedArtifact.path,
    probe: verifiedArtifact.probe
  },
  artifacts,
  cutApplication: "not attempted; Motion returns a Cut import plan only"
}, null, 2));

function readJsonObject(text: string, label: string): object {
  return readObject(JSON.parse(text) as unknown, label);
}

function readObject(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label: string): unknown {
  return Reflect.get(readObject(value, label), key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
