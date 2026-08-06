/**
 * Host gate for the Canvas bridge export: a live Design Studio checkout emits a frame selection.
 *
 * This is the connector suite's EXACT-`passed` proof, and it is kept exact on purpose. The bridge
 * export reads Canvas state and writes JSON — it rasterizes nothing, so no font can fall back, no
 * glyph can be case-folded and no motion can be measured. There is therefore no advisory it could
 * honestly raise, and `assertWarningFreeSuccess` (not the widened `assertReceiptSucceeded`) is the
 * right rule: if this receipt ever warns, something new is happening and the suite must say so
 * rather than absorb it. See `scripts/render-smoke-status.ts` for why the suite must retain at least
 * one such assertion while its sibling gates accept named advisories.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { assertWarningFreeSuccess } from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const canvasRoot = process.env.SHELLX_CANVAS_ROOT
  ? resolve(process.env.SHELLX_CANVAS_ROOT)
  : resolve(repoRoot, "..", "shellx-canvas");
const bridgePath = join(canvasRoot, "app", "server", "motion-package.mjs");
const outDir = join(repoRoot, ".scratch", "connectors", "canvas-bridge-smoke");
const selectionPath = join(outDir, "canvas-frame-selection.json");

if (!existsSync(bridgePath)) {
  console.error(`Design Studio Motion bridge not found at ${bridgePath}.`);
  console.error("Set SHELLX_CANVAS_ROOT to a compatible Design Studio checkout.");
  process.exit(2);
}

await rm(outDir, { recursive: true, force: true });
process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS
  ? `${process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS}${delimiter}${canvasRoot}`
  : canvasRoot;

const result = await runCli([
  "connector",
  "canvas-bridge-export",
  canvasRoot,
  "--out",
  selectionPath,
  "--target",
  "smoke",
  "--project-name",
  "Canvas Bridge Smoke",
  "--frame-name",
  "Bridge Smoke",
  "--selected-ids",
  "rect-blue,heading",
  "--generated-at",
  "2026-07-02T00:00:00.000Z"
]);

assert(result.ok, `Canvas bridge smoke failed: ${JSON.stringify(result, null, 2)}`);
assert(result.command === "connector.canvas-bridge-export", `unexpected command: ${String(result.command)}`);
assert(result.schema === "shellx-motion/canvas-frame-selection@1", `unexpected schema: ${String(result.schema)}`);
assert(result.selectedFrameId === "frame_smoke", `unexpected selectedFrameId: ${String(result.selectedFrameId)}`);
assert.deepEqual(result.layerIds, ["rect-blue", "heading"]);

const receiptPath = readString(result.receiptPath, "receiptPath");
const artifacts = readArray(result.artifacts);
const selectionArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "canvas_frame_selection");
const receiptArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "connector_receipt");

assert(readObjectField(selectionArtifact, "path", "canvas_frame_selection.path") === selectionPath, "selection artifact path mismatch.");
assert(readObjectField(selectionArtifact, "primary", "canvas_frame_selection.primary") === true, "selection artifact should be primary.");
assert(readObjectField(receiptArtifact, "path", "connector_receipt.path") === receiptPath, "connector receipt artifact path mismatch.");

await stat(selectionPath);
await stat(receiptPath);

const selection = readJsonObject(await readFile(selectionPath, "utf8"), "frame selection");
const receipt = readJsonObject(await readFile(receiptPath, "utf8"), "canvas-bridge-export.receipt.json");

assert(readObjectField(selection, "schema", "selection.schema") === "shellx-motion/canvas-frame-selection@1", "selection schema mismatch.");
assert(readObjectField(selection, "selectedFrameId", "selection.selectedFrameId") === "frame_smoke", "selection frame id mismatch.");
assert(readObjectField(receipt, "operation", "receipt.operation") === "canvas.bridge_export", "receipt operation mismatch.");
const bridgeSuccess = assertWarningFreeSuccess(receipt, "Canvas bridge export");

console.log(JSON.stringify({
  ok: true,
  command: "connector.canvas-bridge-smoke",
  canvasRoot,
  bridgePath,
  selectionPath,
  receiptPath,
  connector: {
    receiptStatus: bridgeSuccess.status,
    jobOutcome: bridgeSuccess.outcome,
    acceptedWarnings: bridgeSuccess.warnings,
    matchedAdvisories: bridgeSuccess.matchedAdvisories
  },
  selectedFrameId: result.selectedFrameId,
  layerIds: result.layerIds,
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
