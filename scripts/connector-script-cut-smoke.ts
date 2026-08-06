/**
 * Host gate for the Script-to-Cut connector: a scripted video becomes a real MP4 plus a Cut plan.
 *
 * Acceptance follows the shared contract rule in `scripts/render-smoke-status.ts` rather than a
 * hard-coded `passed`. This connector previews on the native lane and renders through ffmpeg with
 * browser frames, so a correct engine delivers the MP4 and reports two honest advisories — the
 * native lane case-folded the lowercase frame text, and the keyframed fixture holds still — which
 * put both the render receipt and the aggregated connector receipt in `warning`. Under the current contract
 * the two cannot disagree: one rule in `@shellx-motion/core` (`receiptStatusForWarnings`) decides
 * every receipt status, so the render receipt no longer stays `passed` while the connector receipt
 * aggregating the same advisory warns. Both are accepted only WITH a named advisory; an unexplained
 * warning still fails.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const outDir = join(repoRoot, ".scratch", "connectors", "script-cut-smoke");
const scriptPath = join(outDir, "storyboard.json");
const qualityScratchRoot = join(outDir, "quality-scratch");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");

const result = await runCli([
  "connector",
  "script-to-cut",
  scriptPath,
  "--out",
  outDir
]);

assert(result.ok, `Script-to-Cut smoke failed: ${JSON.stringify(result, null, 2)}`);

const render = readObject(result.render, "result.render");
const artifacts = readArray(result.artifacts);
const renderedMedia = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media");
const cutPlanArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "cut_plan");
const renderOutputPath = readString(readObjectField(render, "outputPath", "render.outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(result.receiptPath, "receiptPath");
const cutPlanPath = readString(result.cutPlanPath, "cutPlanPath");

assert(readObjectField(render, "required", "render.required") === true, "Script-to-Cut smoke should require rendered media for the default Cut mode.");
assert(readObjectField(render, "dryRun", "render.dryRun") === false, "Script-to-Cut smoke must perform a real render.");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", `expected browser frame lane, got ${String(readObjectField(render, "frameLane", "render.frameLane"))}`);
assert(readObjectField(renderedMedia, "status", "rendered_media.status") === "available", "rendered_media artifact should be available.");
assert(readObjectField(renderedMedia, "mediaType", "rendered_media.mediaType") === "video/mp4", "rendered_media artifact should be video/mp4.");
assert(readObjectField(renderedMedia, "primary", "rendered_media.primary") === true, "rendered_media artifact should be primary.");
assert(readObjectField(cutPlanArtifact, "status", "cut_plan.status") === "available", "cut_plan artifact should be available.");

await stat(readString(result.packageDir, "packageDir"));
await stat(renderReceiptPath);
await stat(connectorReceiptPath);
await stat(cutPlanPath);
const mp4Bytes = await readDeliveredMedia(renderOutputPath, "Script-to-Cut render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "rendered output is not an MP4 container.");

const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), "render receipt");
const connectorReceipt = readJsonObject(await readFile(connectorReceiptPath, "utf8"), "connector receipt");
const cutPlan = readJsonObject(await readFile(cutPlanPath, "utf8"), "cut plan");

// The render receipt covers the ffmpeg lane over browser frames: a missing font family and the
// fixture's own stillness are the only advisories it may carry.
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Script-to-Cut render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
// The connector receipt aggregates the native PREVIEW pass on top of that render, so it additionally
// carries the native lane's case-folding advisory. Listing all three here is what the connector
// genuinely does, not a widening: any warning outside these three still fails this gate.
const connectorSuccess = assertReceiptSucceeded(connectorReceipt, {
  label: "Script-to-Cut connector",
  expectedAdvisories: [NATIVE_CASE_FOLD_ADVISORY, FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
assert(readObjectField(cutPlan, "schema", "cutPlan.schema") === "shellx-motion/cut-import-plan@1", "cut import plan schema mismatch.");
assert(readObjectField(cutPlan, "mode", "cutPlan.mode") === "rendered_media", `expected rendered_media mode, got ${String(readObjectField(cutPlan, "mode", "cutPlan.mode"))}`);

const quality = await runCli([
  "quality-check",
  renderOutputPath,
  "--at-ms",
  "800",
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
  readString(result.packageDir, "packageDir"),
  "--preview-lane",
  "browser",
  "--max-changed-pixels",
  "230400",
  "--max-mean-diff",
  "4",
  "--min-psnr-db",
  "34"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `Script-to-Cut quality gate failed: ${JSON.stringify(quality, null, 2)}`);

console.log(JSON.stringify({
  ok: true,
  command: "connector.script-cut-smoke",
  scriptPath,
  packageDir: result.packageDir,
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
  artifacts
}, null, 2));

function scriptedVideo(): unknown {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "smoke-demo",
    name: "Script-to-Cut Smoke",
    sourceApp: "shellx-motion",
    workflow: "generate",
    width: 640,
    height: 360,
    fps: 24,
    frames: [
      {
        id: "hook",
        title: "Generate in Cut",
        body: "Motion plans the rendered media handoff",
        durationMs: 1600,
        background: "#0f172a",
        accent: "#38bdf8"
      },
      {
        id: "cta",
        title: "Apply to timeline",
        caption: "Canvas is optional for scripted videos",
        durationMs: 1600,
        background: "#111827",
        accent: "#22c55e"
      }
    ]
  };
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
