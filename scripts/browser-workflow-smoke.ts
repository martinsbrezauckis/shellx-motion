import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outDir = join(repoRoot, ".scratch", "browser-workflow-smoke");
const packageRoot = join(outDir, "interactive-package");
const workflowPath = join(outDir, "workflow.json");
const catalogPath = join(outDir, "browser-workflows.catalog.json");
const recordingManifestPath = join(outDir, "browser-recording.manifest.json");
const secretText = "SHELLX_MOTION_SECRET_DO_NOT_LEAK";
const expectedStatusText = `Accepted ${secretText.length} chars`;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await writeInteractivePackage(packageRoot);
await writeJsonFile(workflowPath, {
  schema: "shellx-motion/browser-workflow@1",
  viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
  networkPolicy: "blocked-unless-declared",
  steps: [
    { action: "click", selector: "#prompt" },
    { action: "type", selector: "#prompt", text: secretText },
    { action: "click", selector: "#apply" },
    { action: "verify", selector: "#state", text: expectedStatusText }
  ],
  cursor: { visible: false }
});

const result = await runCli([
  "capture-browser",
  packageRoot,
  "--out",
  outDir,
  "--at-ms",
  "500",
  "--workflow",
  workflowPath,
  "--recording-manifest",
  recordingManifestPath,
  "--recording-samples",
  "2"
]);

assert(result.ok, `Browser workflow smoke failed: ${JSON.stringify(result, null, 2)}`);
assert(readObjectField(result, "command", "result.command") === "capture-browser", "unexpected command name");

const outputPath = readString(readObjectField(result, "outputPath", "result.outputPath"), "result.outputPath");
const receiptPath = readString(readObjectField(result, "receiptPath", "result.receiptPath"), "result.receiptPath");
const workflowTracePath = readString(readObjectField(result, "workflowTracePath", "result.workflowTracePath"), "result.workflowTracePath");
const resultRecordingManifestPath = readString(
  readObjectField(result, "recordingManifestPath", "result.recordingManifestPath"),
  "result.recordingManifestPath"
);
const artifacts = readArray(readObjectField(result, "artifacts", "result.artifacts"));
const workflowTraceArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "browser_workflow_trace");
const recordingManifestArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "browser_recording_manifest");

assert(workflowTraceArtifact, "missing browser_workflow_trace artifact");
assert(readObjectField(workflowTraceArtifact, "status", "browser_workflow_trace.status") === "available", "workflow trace artifact must be available");
assert(recordingManifestArtifact, "missing browser_recording_manifest artifact");
assert(readObjectField(recordingManifestArtifact, "status", "browser_recording_manifest.status") === "available", "recording manifest artifact must be available");
assert(resultRecordingManifestPath === recordingManifestPath, "result recording manifest path mismatch");

await stat(outputPath);
await stat(receiptPath);
await stat(workflowTracePath);
await stat(recordingManifestPath);

const png = await readFile(outputPath);
assert(png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "browser workflow output is not a PNG");

const receipt = readJsonObject(await readFile(receiptPath, "utf8"), "preview receipt");
const trace = readJsonObject(await readFile(workflowTracePath, "utf8"), "workflow trace");
const recordingManifest = readJsonObject(await readFile(recordingManifestPath, "utf8"), "recording manifest");
const inputHashes = readObject(readObjectField(receipt, "inputHashes", "receipt.inputHashes"), "receipt.inputHashes");
const workflowHash = readString(readObjectField(inputHashes, "workflow", "receipt.inputHashes.workflow"), "receipt.inputHashes.workflow");

assert(readObjectField(trace, "schema", "trace.schema") === "shellx-motion/browser-workflow-trace@1", "workflow trace schema mismatch");
assert(readObjectField(trace, "workflowHash", "trace.workflowHash") === workflowHash, "workflow trace hash mismatch");
assert(readObjectField(trace, "stepCount", "trace.stepCount") === 4, "workflow trace should include click/type/click/verify steps");

assert(readObjectField(recordingManifest, "schema", "recordingManifest.schema") === "shellx-motion/browser-recording-manifest@1", "recording manifest schema mismatch");
assert(readObjectField(recordingManifest, "mode", "recordingManifest.mode") === "deterministic-browser-frame-samples", "recording manifest mode mismatch");
assert(readObjectField(recordingManifest, "packageId", "recordingManifest.packageId") === "pkg_browser_workflow_redaction", "recording manifest package mismatch");
assert(readObjectField(recordingManifest, "motionId", "recordingManifest.motionId") === "motion_browser_workflow_redaction", "recording manifest motion mismatch");
assert(readObjectField(recordingManifest, "sampleCount", "recordingManifest.sampleCount") === 2, "recording manifest sample count mismatch");
assert(readObjectField(recordingManifest, "durationMs", "recordingManifest.durationMs") === 2000, "recording manifest duration mismatch");
assert(readObjectField(recordingManifest, "width", "recordingManifest.width") === 640, "recording manifest width mismatch");
assert(readObjectField(recordingManifest, "height", "recordingManifest.height") === 360, "recording manifest height mismatch");
const recordingWorkflow = readObject(readObjectField(recordingManifest, "workflow", "recordingManifest.workflow"), "recordingManifest.workflow");
assert(readObjectField(recordingWorkflow, "hash", "recordingManifest.workflow.hash") === workflowHash, "recording manifest workflow hash mismatch");
assert(readObjectField(recordingWorkflow, "tracePath", "recordingManifest.workflow.tracePath") === workflowTracePath, "recording manifest workflow trace path mismatch");
const recordingFrames = readArray(readObjectField(recordingManifest, "frames", "recordingManifest.frames"));
assert(recordingFrames.length === 2, `expected two recording manifest frames, got ${recordingFrames.length}`);
const firstRecordingFrame = readObject(recordingFrames[0], "recordingManifest.frames[0]");
const secondRecordingFrame = readObject(recordingFrames[1], "recordingManifest.frames[1]");
assert(readObjectField(firstRecordingFrame, "index", "recordingManifest.frames[0].index") === 0, "first recording frame index mismatch");
assert(readObjectField(firstRecordingFrame, "atMs", "recordingManifest.frames[0].atMs") === 0, "first recording frame timestamp mismatch");
assert(readObjectField(secondRecordingFrame, "index", "recordingManifest.frames[1].index") === 1, "second recording frame index mismatch");
assert(readObjectField(secondRecordingFrame, "atMs", "recordingManifest.frames[1].atMs") === 2000, "second recording frame timestamp mismatch");
assert(readObjectField(firstRecordingFrame, "format", "recordingManifest.frames[0].format") === "png", "first recording frame format mismatch");
assert(readObjectField(secondRecordingFrame, "format", "recordingManifest.frames[1].format") === "png", "second recording frame format mismatch");
assert(readString(readObjectField(firstRecordingFrame, "sha256", "recordingManifest.frames[0].sha256"), "recordingManifest.frames[0].sha256").length === 64, "first recording frame hash mismatch");
assert(readString(readObjectField(secondRecordingFrame, "sha256", "recordingManifest.frames[1].sha256"), "recordingManifest.frames[1].sha256").length === 64, "second recording frame hash mismatch");
await stat(readString(readObjectField(firstRecordingFrame, "path", "recordingManifest.frames[0].path"), "recordingManifest.frames[0].path"));
await stat(readString(readObjectField(secondRecordingFrame, "path", "recordingManifest.frames[1].path"), "recordingManifest.frames[1].path"));

const traceSteps = readArray(readObjectField(trace, "steps", "trace.steps"));
assert(traceSteps.length === 4, `expected four workflow trace steps, got ${traceSteps.length}`);
const typeStep = readObject(traceSteps[1], "trace.steps[1]");
const typeAction = readObject(readObjectField(typeStep, "action", "trace.steps[1].action"), "trace.steps[1].action");
assert(readObjectField(typeStep, "status", "trace.steps[1].status") === "passed", "type step did not pass");
assert(readObjectField(typeAction, "action", "trace.steps[1].action.action") === "type", "type step action mismatch");
assert(readObjectField(typeAction, "selector", "trace.steps[1].action.selector") === "#prompt", "type step selector mismatch");
assert(readObjectField(typeAction, "textLength", "trace.steps[1].action.textLength") === secretText.length, "type step text length mismatch");
assert(!Object.hasOwn(typeAction, "text"), "type step leaked raw text");

const verifyStep = readObject(traceSteps[3], "trace.steps[3]");
const verifyAction = readObject(readObjectField(verifyStep, "action", "trace.steps[3].action"), "trace.steps[3].action");
assert(readObjectField(verifyStep, "status", "trace.steps[3].status") === "passed", "verify step did not pass");
assert(readObjectField(verifyAction, "action", "trace.steps[3].action.action") === "verify", "verify step action mismatch");
assert(readObjectField(verifyAction, "selector", "trace.steps[3].action.selector") === "#state", "verify step selector mismatch");
assert(readObjectField(verifyAction, "hasText", "trace.steps[3].action.hasText") === true, "verify step should preserve hasText metadata");
assert(!Object.hasOwn(verifyAction, "text"), "verify step leaked raw text");

const serializedEvidence = JSON.stringify({ result, receipt, trace });
assert(!serializedEvidence.includes(secretText), "browser workflow evidence leaked typed text");
assert(!serializedEvidence.includes(expectedStatusText), "browser workflow evidence leaked verify text");

const catalogFirst = await captureWithCatalog("catalog-first");
const catalogSecond = await captureWithCatalog("catalog-second");
await writeInteractivePackage(packageRoot, { label: "Prompt Drift" });
const catalogChanged = await captureWithCatalog("catalog-changed", true);
const catalog = readJsonObject(await readFile(catalogPath, "utf8"), "browser workflow catalog");
const catalogEntries = readArray(readObjectField(catalog, "entries", "catalog.entries"));
const catalogEntry = readObject(catalogEntries[0], "catalog.entries[0]");
const catalogHistory = readArray(readObjectField(catalogEntry, "history", "catalog.entries[0].history"));
const firstDrift = readObject(readObjectField(catalogFirst, "workflowDrift", "catalogFirst.workflowDrift"), "catalogFirst.workflowDrift");
const matchedDrift = readObject(readObjectField(catalogSecond, "workflowDrift", "catalogSecond.workflowDrift"), "catalogSecond.workflowDrift");
const changedDrift = readObject(readObjectField(catalogChanged, "workflowDrift", "catalogChanged.workflowDrift"), "catalogChanged.workflowDrift");
const catalogArtifacts = readArray(readObjectField(catalogSecond, "artifacts", "catalogSecond.artifacts"));
const catalogArtifact = catalogArtifacts.find((artifact) => readObjectField(artifact, "role", "catalogArtifact.role") === "browser_workflow_catalog");
const driftError = readObject(readObjectField(catalogChanged, "error", "catalogChanged.error"), "catalogChanged.error");

assert(readObjectField(firstDrift, "status", "new.status") === "new", "first catalog capture should create a new baseline");
assert(readObjectField(matchedDrift, "status", "matched.status") === "matched", "second catalog capture should match the baseline");
assert(readObjectField(changedDrift, "status", "changed.status") === "changed", "mutated package should report catalog drift");
assert(readObjectField(catalogChanged, "ok", "catalogChanged.ok") === false, "fail-on-drift should fail changed browser workflow captures");
assert(readObjectField(driftError, "code", "catalogChanged.error.code") === "browser_workflow_drift_detected", "drift failure should use typed error code");
assert(readObjectField(catalogArtifact, "status", "browser_workflow_catalog.status") === "available", "catalog artifact must be available");
assert(catalogEntries.length === 1, `expected one catalog entry, got ${catalogEntries.length}`);
assert(catalogHistory.length === 3, `expected three catalog snapshots, got ${catalogHistory.length}`);
assert(readObjectField(catalogEntry, "workflowHash", "catalogEntry.workflowHash") === workflowHash, "catalog entry workflow hash mismatch");
assert(!JSON.stringify({ catalogFirst, catalogSecond, catalogChanged, catalog }).includes(secretText), "browser workflow catalog evidence leaked typed text");
assert(!JSON.stringify({ catalogFirst, catalogSecond, catalogChanged, catalog }).includes(expectedStatusText), "browser workflow catalog evidence leaked verify text");

console.log(JSON.stringify({
  ok: true,
  command: "browser:capture-smoke",
  packageRoot,
  workflowPath,
  outputPath,
  receiptPath,
  workflowTracePath,
  workflowHash,
  recordingManifest: {
    path: recordingManifestPath,
    sampleCount: readObjectField(recordingManifest, "sampleCount", "recordingManifest.sampleCount"),
    frameCount: recordingFrames.length
  },
  redaction: {
    typedTextLength: secretText.length,
    verifyHasText: true
  },
  catalog: {
    path: catalogPath,
    entryCount: catalogEntries.length,
    historyCount: catalogHistory.length,
    firstStatus: readObjectField(firstDrift, "status", "firstDrift.status"),
    matchedStatus: readObjectField(matchedDrift, "status", "matchedDrift.status"),
    changedStatus: readObjectField(changedDrift, "status", "changedDrift.status"),
    failOnDriftCode: readObjectField(driftError, "code", "driftError.code")
  },
  artifacts
}, null, 2));

async function captureWithCatalog(name: string, failOnDrift = false): Promise<object> {
  const args = [
    "capture-browser",
    packageRoot,
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
  const capture = await runCli(args);
  assert(readObjectField(capture, "command", `${name}.command`) === "capture-browser", `${name} command mismatch`);
  if (!failOnDrift) {
    assert(readObjectField(capture, "ok", `${name}.ok`) === true, `${name} catalog capture failed: ${JSON.stringify(capture, null, 2)}`);
  }
  return readObject(capture, name);
}

async function writeInteractivePackage(root: string, options: { label?: string } = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeJsonFile(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_browser_workflow_redaction",
    name: "Browser Workflow Redaction Fixture",
    motion: "motion.json",
    assets: ["card.html"],
    sourceApp: "shellx-motion",
    compatibility: {
      lanes: ["browser"],
      hosts: ["motion"]
    }
  });
  await writeJsonFile(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "motion_browser_workflow_redaction",
    name: "Browser Workflow Redaction Fixture",
    durationMs: 2000,
    fps: 30,
    width: 640,
    height: 360,
    background: "#0f172a",
    layers: [
      {
        id: "interactive-card",
        type: "web",
        source: "card.html",
        startMs: 0,
        durationMs: 2000,
        allowedOrigins: []
      }
    ],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "browser-workflow-smoke" }
  });
  await writeFile(join(root, "card.html"), interactiveHtml(options), "utf8");
}

function interactiveHtml(options: { label?: string } = {}): string {
  const label = options.label ?? "Prompt";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Browser Workflow Redaction</title>
    <style>
      body { margin: 0; background: #0f172a; color: #f8fafc; font: 24px sans-serif; }
      main { box-sizing: border-box; width: 640px; height: 360px; padding: 40px; display: grid; gap: 18px; align-content: center; }
      label { display: grid; gap: 8px; }
      input, button { width: 360px; font: inherit; padding: 12px 14px; border-radius: 6px; border: 0; }
      button { background: #38bdf8; color: #082f49; font-weight: 700; }
      #state { color: #bbf7d0; font-weight: 700; }
    </style>
  </head>
  <body data-composition-id="interactive-card" data-start="0" data-duration="2000">
    <main>
      <label>${label} <input id="prompt" type="password" autocomplete="off"></label>
      <button id="apply">Apply</button>
      <div id="state">Ready</div>
    </main>
    <script>
      document.querySelector("#apply").addEventListener("click", () => {
        const length = document.querySelector("#prompt").value.length;
        document.querySelector("#state").textContent = "Accepted " + length + " chars";
      });
    </script>
  </body>
</html>
`;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  return readObject(parsed, label);
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
