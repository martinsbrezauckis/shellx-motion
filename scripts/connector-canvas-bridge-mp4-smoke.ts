/**
 * Host gate for the full Canvas bridge path: live Canvas state -> frame selection -> real MP4.
 *
 * Two acceptance rules, matched to what each stage can honestly report:
 *   - The bridge export writes JSON and rasterizes nothing, so it keeps the exact
 *     `assertWarningFreeSuccess` proof (same reasoning as `connector-canvas-bridge-smoke.ts`).
 *   - The MP4 render and the connector receipt that aggregates it are judged by the shared contract
 *     rule in `scripts/render-smoke-status.ts`: a mostly-still Canvas frame legitimately measures as
 *     static, and a host without the heading's font legitimately falls back, so a `warning` naming
 *     one of those is a delivered success. Any other warning still fails.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import {
  assertReceiptSucceeded,
  assertWarningFreeSuccess,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  readDeliveredMedia
} from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const canvasRoot = process.env.SHELLX_CANVAS_ROOT
  ? resolve(process.env.SHELLX_CANVAS_ROOT)
  : resolve(repoRoot, "..", "shellx-canvas");
const bridgePath = join(canvasRoot, "app", "server", "motion-package.mjs");
const outRoot = join(repoRoot, ".scratch", "connectors", "canvas-bridge-mp4-smoke");
const selectionPath = join(outRoot, "canvas-frame-selection.json");
const mp4OutDir = join(outRoot, "mp4-export");
const qualityScratchRoot = join(outRoot, "quality-scratch");

if (!existsSync(bridgePath)) {
  console.error(`Design Studio Motion bridge not found at ${bridgePath}.`);
  console.error("Set SHELLX_CANVAS_ROOT to a compatible Design Studio checkout.");
  process.exit(2);
}

await rm(outRoot, { recursive: true, force: true });
process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS
  ? `${process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS}${delimiter}${canvasRoot}`
  : canvasRoot;

const bridge = await runCli([
  "connector",
  "canvas-bridge-export",
  canvasRoot,
  "--out",
  selectionPath,
  "--target",
  "smoke_mp4",
  "--project-name",
  "Canvas Bridge MP4 Smoke",
  "--frame-name",
  "Bridge MP4 Smoke",
  "--selected-ids",
  "rect-blue,heading",
  "--generated-at",
  "2026-07-02T00:00:00.000Z"
]);

assert(bridge.ok, `Canvas bridge export failed: ${JSON.stringify(bridge, null, 2)}`);
assert(bridge.command === "connector.canvas-bridge-export", `unexpected bridge command: ${String(bridge.command)}`);
assert(bridge.selectedFrameId === "frame_smoke_mp4", `unexpected selectedFrameId: ${String(bridge.selectedFrameId)}`);

const bridgeReceiptPath = readString(bridge.receiptPath, "bridge.receiptPath");
await stat(bridgeReceiptPath);
const bridgeReceipt = readJsonObject(await readFile(bridgeReceiptPath, "utf8"), "bridge export receipt");
assert(readObjectField(bridgeReceipt, "operation", "bridgeReceipt.operation") === "canvas.bridge_export", "bridge receipt operation mismatch.");
// Exact: a JSON-only export has nothing it could honestly warn about.
const bridgeSuccess = assertWarningFreeSuccess(bridgeReceipt, "Canvas bridge export");

const exportResult = await runCli([
  "connector",
  "canvas-to-mp4",
  selectionPath,
  "--out",
  mp4OutDir,
  "--preset",
  "mp4-h264"
]);

assert(exportResult.ok, `Canvas bridge MP4 export failed: ${JSON.stringify(exportResult, null, 2)}`);
assert(exportResult.command === "connector.canvas-to-mp4", `unexpected export command: ${String(exportResult.command)}`);

const render = readObject(exportResult.render, "exportResult.render");
const packageDir = readString(exportResult.packageDir, "packageDir");
const renderOutputPath = readString(readObjectField(render, "outputPath", "render.outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(exportResult.receiptPath, "receiptPath");
const resourceCatalogPath = readString(exportResult.resourceCatalogPath, "resourceCatalogPath");
const artifacts = readArray(exportResult.artifacts);
const renderedMedia = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media");

assert(readObjectField(render, "dryRun", "render.dryRun") === false, "Canvas bridge MP4 smoke must perform a real render.");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", `expected browser frame lane, got ${String(readObjectField(render, "frameLane", "render.frameLane"))}`);
assert(connectorReceiptPath.endsWith("canvas-mp4-export.receipt.json"), `unexpected connector receipt path: ${connectorReceiptPath}`);
assert(readObjectField(renderedMedia, "status", "rendered_media.status") === "available", "rendered_media artifact should be available.");
assert(readObjectField(renderedMedia, "primary", "rendered_media.primary") === true, "rendered_media artifact should be primary.");

await stat(packageDir);
await stat(resourceCatalogPath);
await stat(renderReceiptPath);
await stat(connectorReceiptPath);
const mp4Bytes = await readDeliveredMedia(renderOutputPath, "Canvas bridge MP4 render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "rendered Canvas bridge output is not an MP4 container.");

const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), "render receipt");
const connectorReceipt = readJsonObject(await readFile(connectorReceiptPath, "utf8"), "connector receipt");
const resourceCatalog = readJsonObject(await readFile(resourceCatalogPath, "utf8"), "resource catalog");

const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Canvas bridge MP4 render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const connectorSuccess = assertReceiptSucceeded(connectorReceipt, {
  label: "Canvas bridge MP4 connector",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
assert(readObjectField(resourceCatalog, "schema", "resourceCatalog.schema") === "shellx-motion/resource-catalog@1", "resource catalog schema mismatch.");

const quality = await runCli([
  "quality-check",
  renderOutputPath,
  "--at-ms",
  "800",
  "--expect-width",
  "1280",
  "--expect-height",
  "800",
  "--min-edge-pixels",
  "1000",
  "--min-non-transparent-pixels",
  "1000",
  "--preview-package",
  packageDir,
  "--preview-lane",
  "browser",
  "--compare-rgb-only",
  "--max-changed-pixels",
  "1024000",
  "--max-mean-diff",
  "4",
  "--min-psnr-db",
  "34"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `Canvas bridge MP4 quality gate failed: ${JSON.stringify(quality, null, 2)}`);

console.log(JSON.stringify({
  ok: true,
  command: "connector.canvas-bridge-mp4-smoke",
  canvasRoot,
  bridgePath,
  selectionPath,
  packageDir,
  resourceCatalogPath,
  render: {
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
  bridge: {
    receiptPath: bridgeReceiptPath,
    receiptStatus: bridgeSuccess.status,
    jobOutcome: bridgeSuccess.outcome,
    acceptedWarnings: bridgeSuccess.warnings
  },
  connector: {
    receiptStatus: connectorSuccess.status,
    jobOutcome: connectorSuccess.outcome,
    acceptedWarnings: connectorSuccess.warnings,
    matchedAdvisories: connectorSuccess.matchedAdvisories
  },
  artifacts
}, null, 2));

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
