import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scratchRoot = await preparePrivateRepoScratch(repoRoot);
const outDir = join(scratchRoot, "browser-workflow-smoke");
const activePackageRoot = join(outDir, "active-package");
const sourceDataPackageRoot = join(repoRoot, "fixtures", "packages", "lower-third");
const dataPackageRoot = join(outDir, "data-only-package");
const captureOutDir = join(outDir, "data-only-capture");
const recordingCaptureOutDir = join(outDir, "data-only-recording");
const workflowPath = join(outDir, "workflow.json");
const recordingWorkflowPath = join(outDir, "recording-workflow.json");
const catalogPath = join(outDir, "browser-workflows.catalog.json");
const recordingManifestPath = join(recordingCaptureOutDir, "browser-recording.manifest.json");
const secretText = "SHELLX_MOTION_SECRET_DO_NOT_LEAK";

await assertPrivateRepoScratchPath(repoRoot, outDir);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true, mode: 0o700 });
await writeActivePackage(activePackageRoot);
await cp(sourceDataPackageRoot, dataPackageRoot, { recursive: true });
await writeJson(workflowPath, {
  schema: "shellx-motion/browser-workflow@1",
  viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  networkPolicy: "blocked-unless-declared",
  steps: [
    { action: "click", selector: "body" },
    { action: "type", selector: "body", text: secretText },
    { action: "verify", selector: "body", text: "Anna" }
  ],
  cursor: { visible: false }
});
await writeJson(recordingWorkflowPath, {
  schema: "shellx-motion/browser-workflow@1",
  viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  networkPolicy: "blocked-unless-declared",
  steps: [{ action: "verify", selector: "body" }],
  cursor: { visible: false }
});

// The shell CLI intentionally has no opaque host provenance authority. Keep that refusal in the
// host ladder so an active package can never regain trust merely by being local or test-authored.
const refused = await runCli(["capture-browser", activePackageRoot, "--out", join(outDir, "refused")]);
assert(refused.ok === false, "active package capture unexpectedly succeeded without host provenance");
const refusalError = readObject(readObjectField(refused, "error", "refused.error"), "refused.error");
assert(readObjectField(refusalError, "code", "refused.error.code") === "script_provenance_unresolved", "active package capture returned the wrong refusal");

// The same public command must still prove a real Chromium capture for ordinary data-only Motion.
const result = await runCli([
  "capture-browser",
  dataPackageRoot,
  "--out",
  captureOutDir,
  "--at-ms",
  "500",
  "--workflow",
  workflowPath
]);
assert(result.ok, `Data-only browser capture failed: ${JSON.stringify(result, null, 2)}`);
assert(readObjectField(result, "command", "result.command") === "capture-browser", "unexpected command name");

const outputPath = readString(readObjectField(result, "outputPath", "result.outputPath"), "result.outputPath");
const receiptPath = readString(readObjectField(result, "receiptPath", "result.receiptPath"), "result.receiptPath");
const workflowTracePath = readString(readObjectField(result, "workflowTracePath", "result.workflowTracePath"), "result.workflowTracePath");
const artifacts = readArray(readObjectField(result, "artifacts", "result.artifacts"));
assertArtifact(artifacts, "browser_workflow_trace");
await stat(outputPath);
await stat(receiptPath);
await stat(workflowTracePath);

const png = await readFile(outputPath);
assert(png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "browser capture output is not a PNG");
const receipt = readJsonObject(await readFile(receiptPath, "utf8"), "capture receipt");
const receiptOutput = readObject(readObjectField(receipt, "output", "receipt.output"), "receipt.output");
assertDataOnlyScriptExecution(readObjectField(receiptOutput, "scriptExecution", "receipt.output.scriptExecution"));
const trace = readJsonObject(await readFile(workflowTracePath, "utf8"), "workflow trace");
assert(readObjectField(trace, "schema", "trace.schema") === "shellx-motion/browser-workflow-trace@1", "workflow trace schema mismatch");
const traceSteps = readArray(readObjectField(trace, "steps", "trace.steps"));
assert(traceSteps.length === 3, `expected three workflow steps, got ${traceSteps.length}`);
const typeAction = readObject(readObjectField(readObject(traceSteps[1], "trace.steps[1]"), "action", "trace.steps[1].action"), "trace.steps[1].action");
assert(readObjectField(typeAction, "action", "trace.steps[1].action.action") === "type", "type action mismatch");
assert(readObjectField(typeAction, "textLength", "trace.steps[1].action.textLength") === secretText.length, "type textLength mismatch");
const verifyAction = readObject(readObjectField(readObject(traceSteps[2], "trace.steps[2]"), "action", "trace.steps[2].action"), "trace.steps[2].action");
assert(readObjectField(verifyAction, "hasText", "trace.steps[2].action.hasText") === true, "verify hasText mismatch");
assert(!JSON.stringify({ result, receipt, trace }).includes(secretText), "browser workflow evidence leaked typed text");

const recordingResult = await runCli([
  "capture-browser",
  dataPackageRoot,
  "--out",
  recordingCaptureOutDir,
  "--at-ms",
  "500",
  "--workflow",
  recordingWorkflowPath,
  "--recording-manifest",
  recordingManifestPath,
  "--recording-samples",
  "2"
]);
assert(recordingResult.ok, `Data-only browser recording failed: ${JSON.stringify(recordingResult, null, 2)}`);
assert(readObjectField(recordingResult, "recordingManifestPath", "recordingResult.recordingManifestPath") === recordingManifestPath, "recording manifest path mismatch");
assertArtifact(readArray(readObjectField(recordingResult, "artifacts", "recordingResult.artifacts")), "browser_recording_manifest");
await stat(recordingManifestPath);

const recording = readJsonObject(await readFile(recordingManifestPath, "utf8"), "recording manifest");
assert(readObjectField(recording, "schema", "recording.schema") === "shellx-motion/browser-recording-manifest@1", "recording manifest schema mismatch");
assert(readObjectField(recording, "mode", "recording.mode") === "deterministic-browser-frame-samples", "recording manifest mode mismatch");
assert(readObjectField(recording, "packageId", "recording.packageId") === "pkg_lower_third", "recording package mismatch");
assert(readObjectField(recording, "motionId", "recording.motionId") === "motion_lower_third", "recording motion mismatch");
const frames = readArray(readObjectField(recording, "frames", "recording.frames"));
assert(frames.length === 2, `expected two recording frames, got ${frames.length}`);
for (const [index, value] of frames.entries()) {
  const frame = readObject(value, `recording.frames[${index}]`);
  assert(readObjectField(frame, "index", `recording.frames[${index}].index`) === index, "recording frame index mismatch");
  assert(readObjectField(frame, "format", `recording.frames[${index}].format`) === "png", "recording frame format mismatch");
  assert(/^[a-f0-9]{64}$/.test(readString(readObjectField(frame, "sha256", `recording.frames[${index}].sha256`), "recording frame hash")), "recording frame hash mismatch");
  await stat(readString(readObjectField(frame, "path", `recording.frames[${index}].path`), "recording frame path"));
}

const catalogFirst = await captureWithCatalog("catalog-first");
const catalogSecond = await captureWithCatalog("catalog-second");
assert(readObjectField(catalogSecond, "workflowCatalogPath", "catalogSecond.workflowCatalogPath") === catalogPath, "workflow catalog path mismatch");
await stat(catalogPath);
await mutateDataOnlyPackageLabel();
const catalogChanged = await captureWithCatalog("catalog-changed", true);
const firstDrift = readObject(readObjectField(catalogFirst, "workflowDrift", "catalogFirst.workflowDrift"), "catalogFirst.workflowDrift");
const matchedDrift = readObject(readObjectField(catalogSecond, "workflowDrift", "catalogSecond.workflowDrift"), "catalogSecond.workflowDrift");
const changedDrift = readObject(readObjectField(catalogChanged, "workflowDrift", "catalogChanged.workflowDrift"), "catalogChanged.workflowDrift");
const driftError = readObject(readObjectField(catalogChanged, "error", "catalogChanged.error"), "catalogChanged.error");
assert(readObjectField(firstDrift, "status", "new.status") === "new", "first catalog capture should create a baseline");
assert(readObjectField(matchedDrift, "status", "matched.status") === "matched", "second catalog capture should match");
assert(readObjectField(changedDrift, "status", "changed.status") === "changed", "mutated data-only package should report drift");
assert(readObjectField(driftError, "code", "catalogChanged.error.code") === "browser_workflow_drift_detected", "drift refusal code mismatch");
assert(!JSON.stringify({ catalogFirst, catalogSecond, catalogChanged }).includes(secretText), "browser workflow catalog evidence leaked typed text");

console.log(JSON.stringify({
  ok: true,
  command: "browser:capture-smoke",
  activePackageRefusal: "script_provenance_unresolved",
  dataOnlyCapture: { outputPath, receiptPath, workflowTracePath, recordingManifestPath, frameCount: frames.length },
  catalog: {
    path: catalogPath,
    firstStatus: readObjectField(firstDrift, "status", "firstDrift.status"),
    matchedStatus: readObjectField(matchedDrift, "status", "matchedDrift.status"),
    changedStatus: readObjectField(changedDrift, "status", "changedDrift.status")
  }
}, null, 2));

async function captureWithCatalog(name: string, failOnDrift = false): Promise<object> {
  const args = [
    "capture-browser",
    dataPackageRoot,
    "--out",
    join(outDir, name),
    "--at-ms",
    "500",
    "--workflow",
    workflowPath,
    "--catalog",
    catalogPath
  ];
  if (failOnDrift) args.push("--fail-on-drift");
  const capture = readObject(await runCli(args), name);
  assert(readObjectField(capture, "command", `${name}.command`) === "capture-browser", `${name} command mismatch`);
  if (!failOnDrift) assert(readObjectField(capture, "ok", `${name}.ok`) === true, `${name} catalog capture failed`);
  return capture;
}

async function mutateDataOnlyPackageLabel(): Promise<void> {
  const path = join(dataPackageRoot, "motion.json");
  const motion = readJsonObject(await readFile(path, "utf8"), "data-only motion") as Record<string, unknown>;
  const layers = readArray(motion.layers);
  const title = readObject(layers[0], "data-only motion.layers[0]") as Record<string, unknown>;
  title.text = "Anna Drift";
  await writeJson(path, motion);
}

function assertArtifact(artifacts: unknown[], role: string): void {
  const artifact = artifacts.find((value) => readObjectField(value, "role", "artifact.role") === role);
  assert(artifact, `missing ${role} artifact`);
  assert(readObjectField(artifact, "status", `${role}.status`) === "available", `${role} artifact is unavailable`);
}

async function writeActivePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1", id: "pkg_browser_active_refusal", name: "Active browser refusal fixture",
    motion: "motion.json", assets: ["card.html"], sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1", id: "motion_browser_active_refusal", name: "Active browser refusal fixture",
    durationMs: 1_000, fps: 30, width: 640, height: 360, background: "#0f172a",
    layers: [{ id: "active-card", type: "web", source: "card.html", startMs: 0, durationMs: 1_000, allowedOrigins: [] }],
    assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "browser-capture-smoke" }
  });
  await writeFile(join(root, "card.html"), "<!doctype html><body>active<script>document.body.dataset.active='true'</script></body>\n", "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertDataOnlyScriptExecution(value: unknown): void {
  const evidence = readObject(value, "scriptExecution");
  assert(readObjectField(evidence, "detectedClass", "scriptExecution.detectedClass") === "data-only", "capture did not report data-only classification");
  assert(readObjectField(evidence, "activeMode", "scriptExecution.activeMode") === "data-only", "capture did not retain the data-only execution mode");
  assert.deepEqual(readObjectField(evidence, "sources", "scriptExecution.sources"), []);
}

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
