import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import {
  assertReceiptSucceeded,
  MOTION_DENSITY_ADVISORY,
  STATIC_SEQUENCE_ADVISORY
} from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures/packages/batch-card");
const outDir = join(repoRoot, ".scratch", "render-batch-smoke");
const inputsDir = join(outDir, "inputs");
const rowsPath = join(inputsDir, "rows.mixed-presets.json");
const qualityManifestPath = join(inputsDir, "quality-manifest.json");
const scratchRoot = join(outDir, "scratch");
const receiptPath = join(outDir, "receipts", "batch-render.receipt.json");
const reviewOutDir = join(outDir, "review");
const expectedPresetList = ["png-frame", "png-sequence", "mp4-h264"];

const expectedPresets = new Map([
  ["ada", "png-frame"],
  ["grace", "png-sequence"],
  ["linus", "mp4-h264"]
]);

await rm(outDir, { recursive: true, force: true });
await mkdir(inputsDir, { recursive: true });

await writeJsonFile(rowsPath, {
  schema: "shellx-motion/data-rows@1",
  rows: [
    {
      id: "ada",
      name: "Ada",
      background: "#0f172a",
      accent: "#38bdf8",
      render: { preset: "png-frame" }
    },
    {
      id: "grace",
      name: "Grace",
      background: "#111827",
      accent: "#22c55e",
      render: { preset: "png-sequence" }
    },
    {
      id: "linus",
      name: "Linus",
      background: "#020617",
      accent: "#facc15",
      render: { preset: "mp4-h264" }
    }
  ]
});

await writeJsonFile(qualityManifestPath, {
  schema: "shellx-motion/quality-manifest@1",
  samples: [
    {
      id: "{{rowId}} frame",
      atMs: 0,
      minBrightPixels: 0,
      minEdgePixels: 1,
      minNonTransparentPixels: 1,
      maxChangedPixels: 230400,
      maxMeanDiff: 4
    }
  ]
});

const result = await runCli([
  "render-batch",
  packageRoot,
  "--out",
  outDir,
  "--rows",
  rowsPath,
  "--quality-manifest",
  qualityManifestPath
], { scratchRoot });

assert(result.ok, `Batch render smoke failed: ${JSON.stringify(result, null, 2)}`);
assert(readObjectField(result, "command", "result.command") === "render-batch", "unexpected command name");
assert(readObjectField(result, "preset", "result.preset") === "mp4-h264", "unexpected fallback preset");
assert.deepEqual(readStringArray(readObjectField(result, "presets", "result.presets"), "result.presets"), expectedPresetList);
assert(readObjectField(result, "qualityManifestPath", "result.qualityManifestPath") === qualityManifestPath, "quality manifest path mismatch");

const jobs = readArray(readObjectField(result, "jobs", "result.jobs"));
assert(jobs.length === 3, `expected three batch jobs, got ${jobs.length}`);

for (const job of jobs) {
  const rowId = readString(readObjectField(job, "rowId", "job.rowId"), "job.rowId");
  const expectedPreset = expectedPresets.get(rowId);
  assert(expectedPreset, `unexpected row id ${rowId}`);
  assert(readObjectField(job, "preset", "job.preset") === expectedPreset, `unexpected preset for ${rowId}`);
  const outputPath = readString(readObjectField(job, "outputPath", "job.outputPath"), "job.outputPath");
  // Judged by the shared contract, not a hard-coded "passed": this field is typed in receipt
  // vocabulary and now follows the same escalation as the row receipt it mirrors, so a still card
  // legitimately reports `warning`. A row that FAILED still fails this assertion.
  const rowJobStatus = String(readObjectField(job, "status", "job.status"));
  assert(rowJobStatus === "passed" || rowJobStatus === "warning", `expected ${rowId} to succeed, got ${rowJobStatus}`);

  if (expectedPreset === "png-sequence") {
    await assertPngSequence(outputPath, rowId);
  } else if (expectedPreset === "mp4-h264") {
    await assertMp4File(outputPath, `${rowId} output`);
  } else {
    await assertPngFile(outputPath, `${rowId} output`);
  }

  const planReceiptPath = readString(readObjectField(job, "planReceiptPath", "job.planReceiptPath"), "job.planReceiptPath");
  const planReceipt = readJsonObject(await readFile(planReceiptPath, "utf8"), `${rowId} batch-row receipt`);
  assert(planReceiptPath.endsWith("batch-row.receipt.json"), `${rowId} plan receipt must be a batch-row.receipt.json`);
  assert(readObjectField(planReceipt, "operation", `${rowId} planReceipt.operation`) === "render.batch.row", `${rowId} batch row receipt operation mismatch`);
  const planOutput = readObject(readObjectField(planReceipt, "output", `${rowId} planReceipt.output`), `${rowId} planReceipt.output`);
  assert(readObjectField(planOutput, "preset", `${rowId} planReceipt.output.preset`) === expectedPreset, `${rowId} batch row receipt preset mismatch`);

  const renderReceiptPath = readString(readObjectField(job, "receiptPath", "job.receiptPath"), "job.receiptPath");
  const renderReceipt = readJsonObject(await readFile(renderReceiptPath, "utf8"), `${rowId} render receipt`);
  assert(readObjectField(renderReceipt, "operation", `${rowId} renderReceipt.operation`) === "render.final", `${rowId} render receipt operation mismatch`);
  // Acceptance follows the shared contract rule rather than a hard-coded `passed`: the batch-card
  // fixture is a still card by design, so a correct engine reports the static-sequence and
  // motion-density advisories on the rows it animates nothing in, and (since the  unified
  // status rule) the render receipt escalates on them. Declared here by anchored pattern; any OTHER
  // warning still fails this gate.
  assertReceiptSucceeded(renderReceipt, {
    label: `${rowId} render`,
    expectedAdvisories: [STATIC_SEQUENCE_ADVISORY, MOTION_DENSITY_ADVISORY]
  });
  const renderOutput = readObject(readObjectField(renderReceipt, "output", `${rowId} renderReceipt.output`), `${rowId} renderReceipt.output`);
  assert(readObjectField(renderOutput, "preset", `${rowId} renderReceipt.output.preset`) === expectedPreset, `${rowId} render receipt preset mismatch`);
  const renderArtifacts = readArray(readObjectField(renderReceipt, "artifacts", `${rowId} renderReceipt.artifacts`));
  const renderedMedia = renderArtifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "rendered_media" || readObjectField(artifact, "role", "artifact.role") === "still_frame");
  if (expectedPreset === "mp4-h264") {
    assert(readObjectField(renderedMedia, "mediaType", `${rowId} renderedMedia.mediaType`) === "video/mp4", `${rowId} MP4 artifact media type mismatch`);
  }

  const appliedManifestPath = readString(readObjectField(job, "qualityManifestAppliedPath", "job.qualityManifestAppliedPath"), "job.qualityManifestAppliedPath");
  const appliedManifest = readJsonObject(await readFile(appliedManifestPath, "utf8"), `${rowId} applied quality manifest`);
  const samples = readArray(readObjectField(appliedManifest, "samples", `${rowId} appliedManifest.samples`));
  const firstSample = readObject(samples[0], `${rowId} appliedManifest.samples[0]`);
  assert(readString(readObjectField(firstSample, "id", `${rowId} appliedManifest.samples[0].id`), `${rowId} sample id`).startsWith(rowId), `${rowId} row token was not materialized`);

  const qualityCheck = readObject(readObjectField(job, "qualityCheck", "job.qualityCheck"), "job.qualityCheck");
  assert(readObjectField(qualityCheck, "ok", "job.qualityCheck.ok") === true, `${rowId} quality check did not pass`);
  assert(readObjectField(qualityCheck, "manifestPath", "job.qualityCheck.manifestPath") === appliedManifestPath, `${rowId} quality check manifest mismatch`);
}

await stat(receiptPath);
const receipt = readJsonObject(await readFile(receiptPath, "utf8"), "batch receipt");
assert(readObjectField(receipt, "operation", "receipt.operation") === "render.batch", "batch receipt operation mismatch");
// The batch receipt goes through the same status rule as the row receipts it aggregates. Before
// that, it reported `passed` while those rows reported `warning` on the identical motion-density
// advisory. Judged by the shared contract, so a warned
// batch is accepted only when every actionable warning names an advisory this smoke declares --
// the same bar the row assertion above uses.
const batchEvidence = assertReceiptSucceeded(receipt, {
  label: "batch",
  expectedAdvisories: [MOTION_DENSITY_ADVISORY, STATIC_SEQUENCE_ADVISORY]
});
console.log(JSON.stringify({
  batchReceiptStatus: batchEvidence.status,
  batchJobOutcome: batchEvidence.outcome,
  batchMatchedAdvisories: batchEvidence.matchedAdvisories
}, null, 2));

const output = readObject(readObjectField(receipt, "output", "receipt.output"), "receipt.output");
assert(readObjectField(output, "preset", "receipt.output.preset") === "mp4-h264", "receipt fallback preset mismatch");
assert.deepEqual(readStringArray(readObjectField(output, "presets", "receipt.output.presets"), "receipt.output.presets"), expectedPresetList);
assert(readObjectField(output, "qualityManifestPath", "receipt.output.qualityManifestPath") === qualityManifestPath, "receipt quality manifest path mismatch");

const review = await runCli([
  "review-html-bundle",
  packageRoot,
  "--out",
  reviewOutDir,
  "--receipts-root",
  join(outDir, "receipts"),
  "--title",
  "Batch Smoke Review"
]);

assert(review.ok, `Review bundle smoke failed: ${JSON.stringify(review, null, 2)}`);
const htmlPath = readString(readObjectField(review, "htmlPath", "review.htmlPath"), "review.htmlPath");
assert(htmlPath.endsWith("review-html-bundle.html"), "unexpected review bundle HTML filename");
const html = await readFile(htmlPath, "utf8");
assert(html.includes("Batch Smoke Review"), "review bundle title missing");
assert(html.includes("render.batch"), "review bundle does not include the batch receipt");
assert(html.includes("Quality Gate"), "review bundle does not summarize quality gates");
assert(html.includes("pkg_batch_card_ada"), "review bundle missing ada row");
assert(html.includes("pkg_batch_card_grace"), "review bundle missing grace row");
assert(html.includes("pkg_batch_card_linus"), "review bundle missing linus MP4 row");

const reviewReceiptPath = readString(readObjectField(review, "receiptPath", "review.receiptPath"), "review.receiptPath");
const reviewReceipt = readJsonObject(await readFile(reviewReceiptPath, "utf8"), "review receipt");
assert(readObjectField(reviewReceipt, "operation", "reviewReceipt.operation") === "review.html.bundle", "review receipt operation mismatch");
const reviewOutput = readObject(readObjectField(reviewReceipt, "output", "reviewReceipt.output"), "reviewReceipt.output");
assert(readNumber(readObjectField(reviewOutput, "qualityGateCount", "reviewReceipt.output.qualityGateCount"), "review qualityGateCount") >= 1, "review receipt did not include quality gates");

console.log(JSON.stringify({
  ok: true,
  command: "render-batch:smoke",
  packageRoot,
  outDir,
  rowsPath,
  qualityManifestPath,
  scratchRoot,
  receiptPath,
  review: {
    htmlPath,
    receiptPath: reviewReceiptPath
  },
  jobs: jobs.map((job) => ({
    rowId: readObjectField(job, "rowId", "job.rowId"),
    packageId: readObjectField(job, "packageId", "job.packageId"),
    outputPath: readObjectField(job, "outputPath", "job.outputPath"),
    preset: readObjectField(job, "preset", "job.preset"),
    planReceiptPath: readObjectField(job, "planReceiptPath", "job.planReceiptPath"),
    receiptPath: readObjectField(job, "receiptPath", "job.receiptPath"),
    qualityManifestAppliedPath: readObjectField(job, "qualityManifestAppliedPath", "job.qualityManifestAppliedPath"),
    status: readObjectField(job, "status", "job.status")
  }))
}, null, 2));

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertPngFile(path: string, label: string): Promise<void> {
  await stat(path);
  const png = await readFile(path);
  assert(png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", `${label} is not a PNG`);
}

async function assertPngSequence(path: string, rowId: string): Promise<void> {
  const info = await stat(path);
  assert(info.isDirectory(), `${rowId} png-sequence output is not a directory`);
  const frames = (await readdir(path)).filter((entry) => /^\d{6}\.png$/.test(entry)).sort();
  assert(frames.length > 0, `${rowId} png-sequence output has no frames`);
  await assertPngFile(join(path, frames[0]), `${rowId} first sequence frame`);
}

async function assertMp4File(path: string, label: string): Promise<void> {
  const info = await stat(path);
  assert(info.isFile(), `${label} is not a file`);
  assert(path.endsWith(".mp4"), `${label} is not an MP4 path`);
  assert(info.size > 0, `${label} is empty`);
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

function readStringArray(value: unknown, label: string): string[] {
  const values = readArray(value);
  return values.map((entry, index) => readString(entry, `${label}[${index}]`));
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}

function readNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `missing ${label}`);
  return value;
}
