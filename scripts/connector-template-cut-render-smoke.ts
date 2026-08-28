/**
 * Host gate for the rendered-media Template-to-Cut connector: a parameterised template becomes a
 * real MP4 and an attested Cut handoff.
 *
 * Acceptance follows the shared contract rule in `scripts/render-smoke-status.ts`, not a hard-coded
 * `passed`. The template carries text and animates, so on a host missing the package font, or one
 * whose frame-lane severity escalates, the honest receipt is a `warning` naming a font fallback
 * (browser preview lane) or the motion-density measurement, while the delivered MP4 is real. Both
 * receipts are accepted only alongside a named advisory.
 */
import assert from "node:assert/strict";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { verifyAttestedArtifactHandleReference, type AttestedArtifactHandleReference } from "../packages/core/src/index";
import {
  assertReceiptSucceeded,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  readDeliveredMedia
} from "./render-smoke-status";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceFixtureRoot = join(repoRoot, "fixtures/packages/editable-lower-third");
const scratchRoot = await preparePrivateRepoScratch(repoRoot);
const outDir = join(scratchRoot, "connectors", "template-cut-render-smoke");
const packageRoot = join(scratchRoot, "sources", "template-cut-render-smoke");
const qualityScratchRoot = join(scratchRoot, "quality", "template-cut-render-smoke");

await assertPrivateRepoScratchPath(repoRoot, outDir);
await assertPrivateRepoScratchPath(repoRoot, packageRoot);
await assertPrivateRepoScratchPath(repoRoot, qualityScratchRoot);
await rm(outDir, { recursive: true, force: true });
await rm(packageRoot, { recursive: true, force: true });
await rm(qualityScratchRoot, { recursive: true, force: true });
await cp(sourceFixtureRoot, packageRoot, { recursive: true });
await shortenTemplatePackage(packageRoot);

const result = await runCli([
  "connector",
  "template-to-cut",
  packageRoot,
  "--out",
  outDir,
  "--cut-import-mode",
  "rendered_media",
  "--set",
  "title=Template Render Smoke",
  "--set",
  "subtitle=Rendered by Motion",
  "--set",
  "accentColor=#22c55e"
]);

assert(result.ok, `Template-to-Cut rendered-media smoke failed: ${JSON.stringify(result, null, 2)}`);
assert.equal(Number((await stat(outDir)).mode) & 0o777, 0o700, "Template-to-Cut P2A delivery must publish a private 0700 root under umask 0002");

const template = readObject(result.template, "result.template");
const render = readObject(result.render, "result.render");
const artifacts = readArray(result.artifacts);
const renderedMedia = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media");
const artifactHandle = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "artifact_handle");
const cutPlanArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "cut_plan");
const packageDir = readString(result.packageDir, "packageDir");
const renderOutputPath = readString(readObjectField(render, "outputPath", "render.outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(result.receiptPath, "receiptPath");
const cutPlanPath = readString(result.cutPlanPath, "cutPlanPath");

assert.deepEqual(readObjectField(template, "changedParams", "template.changedParams"), ["title", "subtitle", "accentColor"]);
assert(readObjectField(render, "required", "render.required") === true, "Template-to-Cut rendered smoke should require rendered media.");
assert(readObjectField(render, "dryRun", "render.dryRun") === false, "Template-to-Cut rendered smoke must perform a real render.");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", `expected browser frame lane, got ${String(readObjectField(render, "frameLane", "render.frameLane"))}`);
assert(readObjectField(renderedMedia, "status", "rendered_media.status") === "available", "rendered_media artifact should be available.");
assert(readObjectField(renderedMedia, "mediaType", "rendered_media.mediaType") === "video/mp4", "rendered_media artifact should be video/mp4.");
assert(readObjectField(renderedMedia, "primary", "rendered_media.primary") === true, "rendered_media artifact should be primary.");
assert(readObjectField(artifactHandle, "status", "artifact_handle.status") === "available", "artifact_handle should be available.");
assert(readObjectField(cutPlanArtifact, "status", "cut_plan.status") === "available", "cut_plan artifact should be available.");

await stat(packageDir);
await stat(renderReceiptPath);
await stat(connectorReceiptPath);
await stat(cutPlanPath);
const mp4Bytes = await readDeliveredMedia(renderOutputPath, "Template-to-Cut render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "rendered Template-to-Cut output is not an MP4 container.");

const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), "render receipt");
const connectorReceipt = readJsonObject(await readFile(connectorReceiptPath, "utf8"), "connector receipt");
const cutPlan = readJsonObject(await readFile(cutPlanPath, "utf8"), "cut plan");

const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Template-to-Cut render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const connectorSuccess = assertReceiptSucceeded(connectorReceipt, {
  label: "Template-to-Cut connector",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
assert(readObjectField(cutPlan, "schema", "cutPlan.schema") === "shellx-motion/cut-import-plan@1", "cut import plan schema mismatch.");
assert(readObjectField(cutPlan, "mode", "cutPlan.mode") === "rendered_media", `expected rendered_media mode, got ${String(readObjectField(cutPlan, "mode", "cutPlan.mode"))}`);

const operations = readArray(readObjectField(cutPlan, "operations", "cutPlan.operations"));
const firstOperation = readObject(operations[0], "cutPlan.operations[0]");
const renderedMediaPlan = readObject(readObjectField(firstOperation, "renderedMedia", "operation.renderedMedia"), "operation.renderedMedia");
assert(readObjectField(renderedMediaPlan, "dryRun", "operation.renderedMedia.dryRun") === false, "cut plan must reference a real rendered artifact.");
const handleRef = readObject(readObjectField(renderedMediaPlan, "handle", "operation.renderedMedia.handle"), "operation.renderedMedia.handle");
const handlePath = join(outDir, readString(readObjectField(handleRef, "rootRelativePath", "handle.rootRelativePath"), "handle.rootRelativePath"));
const handle = readJsonObject(await readFile(handlePath, "utf8"), "artifact handle");
assert(join(outDir, readString(readObjectField(handle, "rootRelativePath", "artifactHandle.rootRelativePath"), "artifactHandle.rootRelativePath")) === renderOutputPath, "artifact handle media path mismatch.");
const verifiedArtifact = await verifyAttestedArtifactHandleReference(outDir, handleRef as unknown as AttestedArtifactHandleReference, { requiredReceiptRoles: ["render", "connector"] });

const quality = await runCli([
  "quality-check",
  renderOutputPath,
  "--at-ms",
  "800",
  "--expect-width",
  "1280",
  "--expect-height",
  "720",
  "--min-bright-pixels",
  "2000",
  "--min-edge-pixels",
  "1000",
  "--min-non-transparent-pixels",
  "2000",
  "--preview-package",
  packageDir,
  "--preview-lane",
  "browser",
  "--max-changed-pixels",
  "921600",
  "--max-mean-diff",
  "3",
  "--min-psnr-db",
  "35"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `Template-to-Cut rendered quality gate failed: ${JSON.stringify(quality, null, 2)}`);

console.log(JSON.stringify({
  ok: true,
  command: "connector.template-cut-render-smoke",
  packageRoot,
  packageDir,
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
  quality: {
    ok: quality.ok,
    command: quality.command
  },
  receiptPath: connectorReceiptPath,
  connector: {
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
  artifacts
}, null, 2));

function readJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  return readObject(parsed, label);
}

async function shortenTemplatePackage(root: string): Promise<void> {
  const motionPath = join(root, "motion.json");
  const motion = readJsonObject(await readFile(motionPath, "utf8"), "motion package") as Record<string, any>;
  motion.durationMs = 2000;
  motion.fps = 2;
  motion.layers = Array.isArray(motion.layers)
    ? motion.layers.map((layer: Record<string, any>) => ({ ...layer, durationMs: 2000 }))
    : motion.layers;
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
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

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
