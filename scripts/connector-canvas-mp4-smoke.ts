/**
 * Host gate for the Canvas-to-MP4 connector: a Canvas frame selection becomes a real, attested MP4.
 *
 * Acceptance follows the shared contract rule in `scripts/render-smoke-status.ts` rather than a
 * hard-coded `passed`. This connector has no preview pass — it renders straight through the ffmpeg
 * lane over browser frames — so the two advisories it can honestly raise are a font fallback for the
 * heading text and the motion-density measurement of a mostly-still Canvas frame. A `warning` naming
 * either is a delivered success; a warning naming neither is not.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { readAttestedArtifactHandle, verifyAttestedArtifactHandle } from "../packages/core/src/index";
import {
  assertReceiptSucceeded,
  FONT_FALLBACK_ADVISORY,
  MOTION_DENSITY_ADVISORY,
  readDeliveredMedia
} from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const selectionPath = join(repoRoot, "fixtures/canvas/shape-text-frame-selection.json");
const outDir = join(repoRoot, ".scratch", "connectors", "canvas-mp4-smoke");
const smokeSelectionPath = join(outDir, "animated-frame-selection.json");
const qualityScratchRoot = join(outDir, "quality-scratch");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await writeJson(smokeSelectionPath, animatedCanvasSelection(await readJsonObjectFile(selectionPath, "Canvas frame selection")));

const result = await runCli([
  "connector",
  "canvas-to-mp4",
  smokeSelectionPath,
  "--out",
  outDir,
  "--preset",
  "mp4-h264"
]);

assert(result.ok, `Canvas-to-MP4 smoke failed: ${JSON.stringify(result, null, 2)}`);
const cutPlanPath = readString(result.cutPlanPath, "cutPlanPath");

const render = readObject(result.render, "result.render");
const artifacts = readArray(result.artifacts);
const renderedMedia = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media");
const artifactHandleArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "artifact_handle");
const renderOutputPath = readString(readObjectField(render, "outputPath", "render.outputPath"), "render.outputPath");
const renderReceiptPath = readString(readObjectField(render, "receiptPath", "render.receiptPath"), "render.receiptPath");
const connectorReceiptPath = readString(result.receiptPath, "receiptPath");
const resourceCatalogPath = readString(result.resourceCatalogPath, "resourceCatalogPath");
const artifactHandlePath = readString(readObjectField(artifactHandleArtifact, "path", "artifact_handle.path"), "artifact_handle.path");

assert(readObjectField(render, "dryRun", "render.dryRun") === false, "Canvas-to-MP4 smoke must perform a real render.");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", `expected browser frame lane, got ${String(readObjectField(render, "frameLane", "render.frameLane"))}`);
assert(readObjectField(render, "preset", "render.preset") === "mp4-h264", `expected mp4-h264 preset, got ${String(readObjectField(render, "preset", "render.preset"))}`);
assert(readObjectField(renderedMedia, "status", "rendered_media.status") === "available", "rendered_media artifact should be available.");
assert(readObjectField(renderedMedia, "mediaType", "rendered_media.mediaType") === "video/mp4", "rendered_media artifact should be video/mp4.");
assert(readObjectField(renderedMedia, "primary", "rendered_media.primary") === true, "rendered_media artifact should be primary.");

await stat(readString(result.packageDir, "packageDir"));
await stat(renderReceiptPath);
await stat(connectorReceiptPath);
await stat(resourceCatalogPath);
await stat(cutPlanPath);
const mp4Bytes = await readDeliveredMedia(renderOutputPath, "Canvas-to-MP4 render");
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "rendered Canvas-to-MP4 output is not an MP4 container.");

const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), "render receipt");
const connectorReceipt = readJsonObject(await readFile(connectorReceiptPath, "utf8"), "connector receipt");
const resourceCatalog = readJsonObject(await readFile(resourceCatalogPath, "utf8"), "resource catalog");
const cutPlan = readJsonObject(await readFile(cutPlanPath, "utf8"), "Cut import plan");
const artifactHandle = await readAttestedArtifactHandle(artifactHandlePath);
const verifiedArtifact = await verifyAttestedArtifactHandle(outDir, artifactHandle, { requiredReceiptRoles: ["render", "connector"] });

const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Canvas-to-MP4 render",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const connectorSuccess = assertReceiptSucceeded(connectorReceipt, {
  label: "Canvas-to-MP4 connector",
  expectedAdvisories: [FONT_FALLBACK_ADVISORY, MOTION_DENSITY_ADVISORY]
});
assert(readObjectField(resourceCatalog, "schema", "resourceCatalog.schema") === "shellx-motion/resource-catalog@1", "resource catalog schema mismatch.");
assert(readObjectField(cutPlan, "schema", "cutPlan.schema") === "shellx-motion/cut-import-plan@1", "Cut plan schema mismatch.");
assert(readObjectField(cutPlan, "mode", "cutPlan.mode") === "rendered_media", "Canvas MP4 Cut plan must use rendered_media mode.");
const cutOperations = readArray(readObjectField(cutPlan, "operations", "cutPlan.operations"));
const cutRenderedMedia = readObject(readObjectField(cutOperations[0], "renderedMedia", "cutPlan.operations[0].renderedMedia"), "cutPlan renderedMedia");
assert(
  JSON.stringify(readObjectField(cutRenderedMedia, "handle", "cutPlan renderedMedia.handle")) === JSON.stringify(result.artifactHandle?.reference),
  "Canvas MP4 Cut plan must reuse the attested artifact handle."
);

const quality = await runCli([
  "quality-check",
  renderOutputPath,
  "--at-ms",
  "500",
  "--expect-width",
  "640",
  "--expect-height",
  "360",
  "--min-bright-pixels",
  "1000",
  "--min-edge-pixels",
  "200",
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

assert(quality.ok, `Canvas-to-MP4 quality gate failed: ${JSON.stringify(quality, null, 2)}`);

console.log(JSON.stringify({
  ok: true,
  command: "connector.canvas-mp4-smoke",
  selectionPath,
  smokeSelectionPath,
  packageDir: result.packageDir,
  resourceCatalogPath,
  render: {
    dryRun: readObjectField(render, "dryRun", "render.dryRun"),
    frameLane: readObjectField(render, "frameLane", "render.frameLane"),
    preset: readObjectField(render, "preset", "render.preset"),
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
  cutPlanPath,
  attestation: {
    id: artifactHandle.id,
    descriptorPath: artifactHandlePath,
    mediaPath: verifiedArtifact.path,
    probe: verifiedArtifact.probe
  },
  artifacts
}, null, 2));

async function readJsonObjectFile(path: string, label: string): Promise<object> {
  return readJsonObject(await readFile(path, "utf8"), label);
}

function readJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  return readObject(parsed, label);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function animatedCanvasSelection(selection: object): object {
  const frames = readArray(readObjectField(selection, "frames", "selection.frames"));
  const firstFrame = readObject(frames[0], "selection.frames[0]");
  Object.assign(firstFrame, {
    durationMs: 1800,
    fps: 6
  });
  const layers = readArray(readObjectField(firstFrame, "layers", "selection.frames[0].layers"));
  for (const layer of layers) {
    if (typeof layer !== "object" || layer === null || Array.isArray(layer)) continue;
    Object.assign(layer, {
      transitions: {
        in: { type: "slide", direction: "down", distance: 24, durationMs: 320, easing: "ease-out" },
        out: { type: "fade", durationMs: 260, easing: "ease-in" }
      },
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "ease-out" },
          { atMs: 320, value: 1 },
          { atMs: 1320, value: 1, easing: "ease-in" },
          { atMs: 1800, value: 0 }
        ]
      }
    });
  }
  return selection;
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
