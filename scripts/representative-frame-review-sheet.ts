/**
 * Build the private, human-only R5 representative-frame review set.
 *
 * This is deliberately downstream of rendering: it refuses incomplete or mismatched retained
 * artifacts, composes deterministic SVG sheets, and records their identities. It never renders a
 * Motion package and it never records visual acceptance.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGovernedFfmpegRunner,
  frameExtractionArgs,
  probeMedia,
  resolveFfmpegExecutable,
  type FfmpegRunner
} from "../packages/renderer-ffmpeg/src/index";
import {
  OutputDirectoryTransaction,
  readBoundedStableFile,
  writeVerifiedBoundedFile
} from "../packages/core/src";
import { hashBuffer, hashFile, hashFramePaths } from "../packages/core/src/receipts";
import { inspectPngBuffer } from "../packages/core/src/quality";
import { PUBLIC_PRODUCT_TEMPLATE_DIRS } from "./template-product-pack-catalog";
import { assertReceiptSucceeded, MOTION_DENSITY_ADVISORY } from "./render-smoke-status";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REVIEW_SCHEMA = "shellx-motion/representative-frame-review@1";
const MAX_REVIEW_FRAME_BYTES = 64 * 1024 * 1024;
const PRODUCT_METRIC_BATCH_ROWS = [
  "motion_renderer_lane",
  "cut_generate_lane",
  "canvas_export_lane"
] as const;
const PRODUCT_METRIC_BATCH_OUTPUTS: Record<(typeof PRODUCT_METRIC_BATCH_ROWS)[number], { width: number; height: number }> = {
  motion_renderer_lane: { width: 1920, height: 1080 },
  cut_generate_lane: { width: 1920, height: 1080 },
  canvas_export_lane: { width: 1080, height: 1080 }
};

type JsonRecord = Record<string, unknown>;

export interface BatchFrameExtraction {
  artifactPath: string;
  frameIndex: number;
  outputPath: string;
}

export interface RepresentativeFrameReviewInput {
  /** Immutable candidate source revision. It is intentionally supplied, not guessed from a checkout. */
  sourceRevision: string;
  /** Retained output of `pnpm run template-pack:proof -- --retain-artifacts`. */
  proofRoot: string;
  /** Output of the three-row Product Metric `render-batch` command. */
  batchRoot: string;
  /** An absent or empty, caller-owned private destination. */
  outRoot: string;
  /** Test seam; production uses exact decoded delivered frames. */
  extractBatchFrame?: (input: BatchFrameExtraction) => Promise<void>;
}

export interface RepresentativeFrameReviewResult {
  schema: typeof REVIEW_SCHEMA;
  metadataPath: string;
  sheets: Array<{ id: string; path: string; cellCount: number }>;
  coverage: {
    promotedFamilies: number;
    promotedCells: number;
    productMetricBatchRows: number;
    productMetricBatchCells: number;
    totalCells: number;
  };
}

interface ReviewFrame {
  atMs: number;
  deliveryFrameIndex: number;
  /** Path relative to the sheet's own root. */
  path: string;
  sha256: string;
}

interface ReviewSubject {
  id: string;
  label: string;
  width: number;
  height: number;
  frames: ReviewFrame[];
  metadata: JsonRecord;
}

/**
 * Compose the complete 60-cell R5 review set from retained proof artifacts.
 *
 * The public output is a one-shot directory transaction. Input refusal or an invalid staged frame
 * leaves an absent destination absent (or a caller-owned empty destination empty), and reviewers
 * cannot observe a half-built sheet tree.
 */
export async function writeRepresentativeFrameReviewSet(
  input: RepresentativeFrameReviewInput
): Promise<RepresentativeFrameReviewResult> {
  assert(/^[a-f0-9]{40}$/i.test(input.sourceRevision), "--source-revision must be one full 40-character Git revision.");
  const proofRoot = resolve(input.proofRoot);
  const batchRoot = resolve(input.batchRoot);
  const outRoot = resolve(input.outRoot);
  const transaction = await OutputDirectoryTransaction.create(outRoot);
  try {
    const stageRoot = transaction.stagingPath;
    const promoted = await readPromotedProof({ proofRoot, outRoot: stageRoot });
    const batch = await readProductMetricBatch({
      batchRoot,
      outRoot: stageRoot,
      extractBatchFrame: input.extractBatchFrame ?? createExactDeliveredFrameExtractor(stageRoot)
    });
    const promotedCells = promoted.subjects.flatMap((subject) => subject.frames);
    const batchCells = batch.subjects.flatMap((subject) => subject.frames);
    assert.equal(promotedCells.length, PUBLIC_PRODUCT_TEMPLATE_DIRS.length * 4,
      "R5 promoted proof must yield four declared representative frames for every public family.");
    assert.equal(batchCells.length, PRODUCT_METRIC_BATCH_ROWS.length * 4,
      "R5 Product Metric batch proof must yield four declared representative frames for every row.");

    const sheetsRoot = join(stageRoot, "sheets");
    const promotedSheetPath = join(sheetsRoot, "promoted-template-representative-review.svg");
    const batchSheetPath = join(sheetsRoot, "product-metric-batch-representative-review.svg");
    await writeReviewSheet({
      path: promotedSheetPath,
      rootForFramePaths: stageRoot,
      title: "ShellX Motion promoted template representative-frame review",
      subtitle: "Human review required — four declared beats for each promoted family",
      subjects: promoted.subjects
    });
    await writeReviewSheet({
      path: batchSheetPath,
      rootForFramePaths: stageRoot,
      title: "ShellX Motion Product Metric batch representative-frame review",
      subtitle: "Human review required — two FHD rows and one square row",
      subjects: batch.subjects
    });

    const metadataPath = join(stageRoot, "representative-review.json");
    const metadata = {
      schema: REVIEW_SCHEMA,
      source: { revision: input.sourceRevision },
      scope: {
        publicProductFamilies: [...PUBLIC_PRODUCT_TEMPLATE_DIRS],
        productMetricBatchRows: [...PRODUCT_METRIC_BATCH_ROWS],
        automaticVisualAcceptance: "absent",
        humanReview: {
          required: true,
          status: "pending",
          criteria: [
            "visual variety and meaningful motion across declared beats",
            "text fit, safe areas, crop, and contrast",
            "no blank, placeholder, or repeated-static frame",
            "FHD and square Product Metric reflow remain coherent",
            "audio-launch is reviewed audibly in the final MP4 separately"
          ]
        }
      },
      coverage: {
        promotedFamilies: promoted.subjects.length,
        promotedCells: promotedCells.length,
        productMetricBatchRows: batch.subjects.length,
        productMetricBatchCells: batchCells.length,
        totalCells: promotedCells.length + batchCells.length
      },
      sheets: [
        { id: "promoted-template-representative-review", path: relative(stageRoot, promotedSheetPath), cellCount: promotedCells.length },
        { id: "product-metric-batch-representative-review", path: relative(stageRoot, batchSheetPath), cellCount: batchCells.length }
      ],
      promotedProof: promoted.metadata,
      productMetricBatch: batch.metadata
    };
    await writeJson(metadataPath, metadata);
    await transaction.commit();
    return {
      schema: REVIEW_SCHEMA,
      metadataPath: relative(stageRoot, metadataPath),
      sheets: metadata.sheets,
      coverage: metadata.coverage
    };
  } catch (error) {
    await transaction.abort();
    throw error;
  }
}

async function readPromotedProof(input: { proofRoot: string; outRoot: string }): Promise<{
  subjects: ReviewSubject[];
  metadata: JsonRecord;
}> {
  const evidencePath = join(input.proofRoot, "evidence.json");
  const evidence = await readJsonRecord(evidencePath, "promoted proof evidence");
  assert.equal(evidence.schema, "shellx-motion/template-moving-proof@1", "promoted proof evidence has an unexpected schema.");
  assert.equal(evidence.ok, true, "promoted proof evidence must be successful.");
  const retention = readRecord(evidence.retention, "promoted proof evidence.retention");
  assert.equal(retention.state, "retained", "promoted proof must use --retain-artifacts before representative review.");
  const profile = readRecord(evidence.proofProfile, "promoted proof evidence.proofProfile");
  assert.deepEqual(readStringArray(profile.selectedTemplateDirs, "promoted proof selectedTemplateDirs"), [...PUBLIC_PRODUCT_TEMPLATE_DIRS],
    "promoted proof must cover exactly the public product family contract in canonical order.");
  const policy = readRecord(evidence.policy, "promoted proof evidence.policy");
  const policySource = readString(policy.source, "promoted proof policy.source");
  const policySha256 = readSha256(policy.sha256, "promoted proof policy.sha256");
  const evidenceSha256 = await hashFile(evidencePath);
  const proofEntries = readArray(evidence.templates, "promoted proof evidence.templates");
  assert.equal(proofEntries.length, PUBLIC_PRODUCT_TEMPLATE_DIRS.length, "promoted proof evidence must contain every public family exactly once.");

  const entriesByFamily = new Map<string, JsonRecord>();
  for (const value of proofEntries) {
    const entry = readRecord(value, "promoted proof template entry");
    const family = readString(entry.packageDirName, "promoted proof template.packageDirName");
    assert(!entriesByFamily.has(family), `promoted proof repeats ${family}.`);
    entriesByFamily.set(family, entry);
  }

  const subjects: ReviewSubject[] = [];
  const identities: JsonRecord[] = [];
  for (const family of PUBLIC_PRODUCT_TEMPLATE_DIRS) {
    const entry = entriesByFamily.get(family);
    assert(entry, `promoted proof is missing ${family}.`);
    const packageRoot = safeChildPath(input.proofRoot, join("packages", family), `${family} retained package`);
    const packageIdentity = await readPackageIdentity(packageRoot, `${family} retained package`);
    const declaredTimes = representativeTimes(packageIdentity.template, `${family} template`);
    assert.equal(declaredTimes.length, 4, `${family} must declare exactly four representative frames for R5 review.`);
    const outputPath = safeChildPath(input.proofRoot, readString(entry.outputPath, `${family} evidence.outputPath`), `${family} rendered artifact`);
    const receiptPath = safeChildPath(input.proofRoot, readString(entry.receiptPath, `${family} evidence.receiptPath`), `${family} retained receipt`);
    const evidenceReceiptSha256 = readSha256(entry.receiptSha256, `${family} evidence.receiptSha256`);
    assert.equal(await hashFile(receiptPath), evidenceReceiptSha256, `${family} retained receipt does not match evidence receiptSha256.`);
    const receipt = await readJsonRecord(receiptPath, `${family} retained receipt`);
    const receiptOutput = readRecord(receipt.output, `${family} retained receipt.output`);
    assert.equal(resolve(readString(receiptOutput.path, `${family} retained receipt.output.path`)), outputPath,
      `${family} retained receipt is not bound to the evidence artifact.`);
    const artifactSha256 = readSha256(receiptOutput.sha256, `${family} retained receipt.output.sha256`);
    assert.equal(await hashFile(outputPath), artifactSha256, `${family} rendered artifact hash does not match its final receipt.`);
    const renderedPackageId = safeId(readString(receipt.packageId, `${family} retained receipt.packageId`), `${family} retained receipt.packageId`);
    const framesDir = safeChildPath(input.proofRoot, join("frames", family, renderedPackageId), `${family} retained source frames`);
    const sequenceFrames = await listSequenceFrames(framesDir, `${family} retained source frames`);
    const motion = packageIdentity.motion;
    const fps = readPositiveNumber(motion.fps, `${family} materialized motion.fps`);
    const durationMs = readPositiveNumber(motion.durationMs, `${family} materialized motion.durationMs`);
    const width = readPositiveNumber(motion.width, `${family} materialized motion.width`);
    const height = readPositiveNumber(motion.height, `${family} materialized motion.height`);
    const expectedFrameCount = Math.ceil((durationMs / 1000) * fps);
    assert.equal(sequenceFrames.length, expectedFrameCount, `${family} retained frame count no longer matches its materialized source.`);
    await assertFrameSequenceReceiptBinding({
      label: family,
      receipt,
      framesDir,
      sequenceFrames,
      fps,
      durationMs,
      width,
      height,
      qualityManifestPath: packageIdentity.qualityManifestPath
    });
    const frames = await materializePromotedRepresentativeFrames({
      outRoot: input.outRoot,
      sourceFramesRoot: framesDir,
      family,
      sequenceFrames,
      declaredTimes,
      fps,
      durationMs,
      label: family
    });
    subjects.push({ id: family, label: family, width, height, frames, metadata: {} });
    identities.push({
      family,
      package: packageIdentity.identity,
      finalArtifact: { path: relative(input.proofRoot, outputPath), sha256: artifactSha256 },
      finalReceipt: {
        id: readString(receipt.id, `${family} retained receipt.id`),
        path: relative(input.proofRoot, receiptPath),
        sha256: evidenceReceiptSha256,
        status: readString(receipt.status, `${family} retained receipt.status`)
      },
      frameSequence: {
        path: relative(input.proofRoot, framesDir),
        sha256: readSha256(readRecord(receipt.inputHashes, `${family} retained receipt.inputHashes`).frames,
          `${family} retained receipt.inputHashes.frames`),
        frameCount: sequenceFrames.length,
        fps,
        durationMs
      },
      representativeFrames: frames
    });
  }
  return {
    subjects,
    metadata: {
      evidence: { path: "evidence.json", sha256: evidenceSha256 },
      policy: { source: policySource, sha256: policySha256 },
      families: identities
    }
  };
}

async function readProductMetricBatch(input: {
  batchRoot: string;
  outRoot: string;
  extractBatchFrame: (input: BatchFrameExtraction) => Promise<void>;
}): Promise<{ subjects: ReviewSubject[]; metadata: JsonRecord }> {
  const aggregateReceiptPath = join(input.batchRoot, "receipts", "batch-render.receipt.json");
  const aggregateReceipt = await readJsonRecord(aggregateReceiptPath, "Product Metric batch receipt");
  assert.equal(aggregateReceipt.schema, "shellx-motion/receipt@1", "Product Metric batch receipt has an unexpected schema.");
  assert.equal(aggregateReceipt.operation, "render.batch", "Product Metric batch receipt must be render.batch.");
  assertProductMetricReceiptSucceeded(aggregateReceipt, "Product Metric batch receipt");
  const output = readRecord(aggregateReceipt.output, "Product Metric batch receipt.output");
  assert.equal(output.rows, PRODUCT_METRIC_BATCH_ROWS.length, "Product Metric batch must contain exactly three rows.");
  const jobs = readArray(output.jobs, "Product Metric batch receipt.output.jobs").map((value) => readRecord(value, "Product Metric batch job"));
  assert.equal(jobs.length, PRODUCT_METRIC_BATCH_ROWS.length, "Product Metric batch receipt must describe exactly three jobs.");
  const jobsByRow = new Map<string, JsonRecord>();
  for (const job of jobs) {
    const rowId = readString(job.rowId, "Product Metric batch job.rowId");
    assert(!jobsByRow.has(rowId), `Product Metric batch repeats ${rowId}.`);
    jobsByRow.set(rowId, job);
  }

  const subjects: ReviewSubject[] = [];
  const rows: JsonRecord[] = [];
  for (const rowId of PRODUCT_METRIC_BATCH_ROWS) {
    const job = jobsByRow.get(rowId);
    assert(job, `Product Metric batch is missing ${rowId}.`);
    assertProductMetricReceiptSucceeded(job, `${rowId} batch render`);
    assertQualityPassed(job, `${rowId} batch render`);
    assert.equal(job.frameLane, "browser", `${rowId} batch render must use the browser frame lane for R5 parity.`);
    const packageId = safeId(readString(job.packageId, `${rowId} batch packageId`), `${rowId} batch packageId`);
    const packageRoot = safeChildPath(input.batchRoot, join("packages", packageId), `${rowId} materialized package`);
    const packageIdentity = await readPackageIdentity(packageRoot, `${rowId} materialized package`);
    const declaredTimes = representativeTimes(packageIdentity.template, `${rowId} materialized template`);
    assert.equal(declaredTimes.length, 4, `${rowId} must declare exactly four representative frames for R5 review.`);
    const outputPath = safeChildPath(input.batchRoot, readString(job.outputPath, `${rowId} batch outputPath`), `${rowId} batch output`);
    assert(pathWithin(join(input.batchRoot, "render"), outputPath), `${rowId} batch output must stay under render/.`);
    const receiptPath = safeChildPath(input.batchRoot, readString(job.receiptPath, `${rowId} batch receiptPath`), `${rowId} batch final receipt`);
    assert(pathWithin(join(input.batchRoot, "receipts"), receiptPath), `${rowId} batch final receipt must stay under receipts/.`);
    const receipt = await readJsonRecord(receiptPath, `${rowId} batch final receipt`);
    assert.equal(receipt.operation, "render.final", `${rowId} batch child receipt must be render.final.`);
    assertProductMetricReceiptSucceeded(receipt, `${rowId} batch child receipt`);
    assert.equal(readString(receipt.packageId, `${rowId} batch child receipt.packageId`), packageId,
      `${rowId} batch final receipt package identity does not match its aggregate job.`);
    const receiptOutput = readRecord(receipt.output, `${rowId} batch final receipt.output`);
    assertQualityPassed(receiptOutput, `${rowId} batch child receipt.output`);
    assert.equal(resolve(readString(receiptOutput.path, `${rowId} batch final receipt.output.path`)), outputPath,
      `${rowId} batch child receipt is not bound to the aggregate output artifact.`);
    const artifactSha256 = readSha256(receiptOutput.sha256, `${rowId} batch final receipt.output.sha256`);
    assert.equal(await hashFile(outputPath), artifactSha256, `${rowId} batch final artifact hash does not match its final receipt.`);
    const motion = packageIdentity.motion;
    const fps = readPositiveNumber(motion.fps, `${rowId} materialized motion.fps`);
    const durationMs = readPositiveNumber(motion.durationMs, `${rowId} materialized motion.durationMs`);
    const width = readPositiveNumber(motion.width, `${rowId} materialized motion.width`);
    const height = readPositiveNumber(motion.height, `${rowId} materialized motion.height`);
    const expectedOutput = PRODUCT_METRIC_BATCH_OUTPUTS[rowId];
    assert.equal(width, expectedOutput.width, `${rowId} materialized package must be ${expectedOutput.width} pixels wide for R5 review.`);
    assert.equal(height, expectedOutput.height, `${rowId} materialized package must be ${expectedOutput.height} pixels high for R5 review.`);
    assert.equal(receiptOutput.width, width, `${rowId} final receipt width does not match its materialized package.`);
    assert.equal(receiptOutput.height, height, `${rowId} final receipt height does not match its materialized package.`);
    const frames = await Promise.all(declaredTimes.map(async (atMs) => {
      const deliveryFrameIndex = sequenceFrameIndexForAtMs(atMs, durationMs, fps);
      const framePath = safeChildPath(input.outRoot, join("batch-delivered-frames", rowId, `${String(atMs).padStart(6, "0")}ms.png`),
        `${rowId} delivered representative frame at ${atMs}ms`);
      await mkdir(dirname(framePath), { recursive: true, mode: 0o700 });
      await input.extractBatchFrame({ artifactPath: outputPath, frameIndex: deliveryFrameIndex, outputPath: framePath });
      const delivered = await readVerifiedPng(framePath, `${rowId} decoded representative frame at ${atMs}ms`, input.outRoot);
      return {
        atMs,
        deliveryFrameIndex,
        path: relative(input.outRoot, framePath),
        sha256: delivered.sha256
      };
    }));
    subjects.push({ id: rowId, label: rowId, width, height, frames, metadata: {} });
    rows.push({
      rowId,
      rowHash: readSha256(job.rowHash, `${rowId} batch rowHash`),
      package: packageIdentity.identity,
      finalArtifact: { path: relative(input.batchRoot, outputPath), sha256: artifactSha256 },
      finalReceipt: {
        id: readString(receipt.id, `${rowId} batch final receipt.id`),
        path: relative(input.batchRoot, receiptPath),
        sha256: await hashFile(receiptPath),
        status: readString(receipt.status, `${rowId} batch final receipt.status`)
      },
      representativeFrames: frames
    });
  }
  return {
    subjects,
    metadata: {
      aggregateReceipt: {
        id: readString(aggregateReceipt.id, "Product Metric batch receipt.id"),
        path: "receipts/batch-render.receipt.json",
        sha256: await hashFile(aggregateReceiptPath),
        inputHashes: readRecord(aggregateReceipt.inputHashes, "Product Metric batch receipt.inputHashes")
      },
      rows
    }
  };
}

function assertProductMetricReceiptSucceeded(receipt: JsonRecord, label: string): void {
  // A Product Metric advisory is accepted only through the generated receipt-to-job outcome
  // mapping and the anchored warning allowlist shared by render smokes. This keeps failed,
  // skipped, cancelled, malformed, and newly introduced warning evidence fail-closed.
  assertReceiptSucceeded(receipt, {
    label,
    expectedAdvisories: [MOTION_DENSITY_ADVISORY]
  });
}

function assertQualityPassed(value: JsonRecord, label: string): void {
  const qualityCheck = readRecord(value.qualityCheck, `${label}.qualityCheck`);
  assert.equal(qualityCheck.status, "passed", `${label} quality check must be passed.`);
}

function createExactDeliveredFrameExtractor(outRoot: string): (input: BatchFrameExtraction) => Promise<void> {
  const runner = createGovernedFfmpegRunner({
    scratchRoot: outRoot,
    operation: "representative-frame-review-sheet.ffmpeg"
  });
  return async (input) => await extractExactDeliveredFrame(input, runner);
}

async function extractExactDeliveredFrame(input: BatchFrameExtraction, runner: FfmpegRunner): Promise<void> {
  const media = await probeMedia(input.artifactPath, {
    runner,
    inputRoots: [dirname(input.artifactPath)],
    admittedQualityInput: true
  });
  const command = {
    executable: resolveFfmpegExecutable(),
    args: ["-y", ...frameExtractionArgs(media, input.artifactPath, input.outputPath, {
      frameIndex: input.frameIndex,
      admittedQualityInput: true
    })],
    shell: false as const
  };
  const result = await runner(command);
  assert.equal(result.exitCode, 0, `FFmpeg could not decode delivered frame ${input.frameIndex}: ${result.stderr || result.stdout || "unknown error"}`);
}

async function readPackageIdentity(packageRoot: string, label: string): Promise<{
  motion: JsonRecord;
  template: JsonRecord;
  qualityManifestPath: string;
  identity: JsonRecord;
}> {
  const manifestPath = join(packageRoot, "manifest.json");
  const motionPath = join(packageRoot, "motion.json");
  const templatePath = join(packageRoot, "template.json");
  const manifest = await readJsonRecord(manifestPath, `${label} manifest`);
  const motion = await readJsonRecord(motionPath, `${label} motion`);
  const template = await readJsonRecord(templatePath, `${label} template`);
  const qualityRef = readString(readRecord(readRecord(template.metadata, `${label} template.metadata`).qualityTargets,
    `${label} template.metadata.qualityTargets`).manifest, `${label} template quality manifest`);
  assert(!qualityRef.includes("..") && !qualityRef.startsWith("/") && !qualityRef.startsWith("\\"), `${label} quality manifest must be package-local.`);
  const qualityManifestPath = safeChildPath(packageRoot, qualityRef, `${label} quality manifest`);
  await assertExistingFile(qualityManifestPath, `${label} quality manifest`);
  return {
    motion,
    template,
    qualityManifestPath,
    identity: {
      manifestId: readString(manifest.id, `${label} manifest.id`),
      manifestSha256: await hashFile(manifestPath),
      motionSha256: await hashFile(motionPath),
      templateSha256: await hashFile(templatePath),
      qualityManifest: { path: qualityRef, sha256: await hashFile(qualityManifestPath) }
    }
  };
}

async function assertFrameSequenceReceiptBinding(input: {
  label: string;
  receipt: JsonRecord;
  framesDir: string;
  sequenceFrames: string[];
  fps: number;
  durationMs: number;
  width: number;
  height: number;
  qualityManifestPath: string;
}): Promise<void> {
  const inputHashes = readRecord(input.receipt.inputHashes, `${input.label} retained receipt.inputHashes`);
  const expectedFramesSha256 = readSha256(inputHashes.frames, `${input.label} retained receipt.inputHashes.frames`);
  const expectedManifestSha256 = readSha256(inputHashes.qualityManifest, `${input.label} retained receipt.inputHashes.qualityManifest`);
  const actualFramesSha256 = hashBuffer(Buffer.from(JSON.stringify({
    framesDir: input.framesDir,
    framePattern: "%06d.png",
    frameCount: input.sequenceFrames.length,
    frameHashes: await hashFramePaths(input.sequenceFrames),
    fps: input.fps,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs
  }), "utf8"));
  assert.equal(actualFramesSha256, expectedFramesSha256, `${input.label} retained frames no longer match the final receipt identity.`);
  assert.equal(await hashFile(input.qualityManifestPath), expectedManifestSha256,
    `${input.label} materialized quality manifest no longer matches the final receipt identity.`);
}

/** Copy receipt-bound promoted PNGs into the portable review tree; SVGs never reach back into proof roots. */
async function materializePromotedRepresentativeFrames(input: {
  outRoot: string;
  sourceFramesRoot: string;
  family: string;
  sequenceFrames: string[];
  declaredTimes: number[];
  fps: number;
  durationMs: number;
  label: string;
}): Promise<ReviewFrame[]> {
  return await Promise.all(input.declaredTimes.map(async (atMs) => {
    const deliveryFrameIndex = sequenceFrameIndexForAtMs(atMs, input.durationMs, input.fps);
    const sourcePath = input.sequenceFrames[deliveryFrameIndex];
    assert(sourcePath, `${input.label} is missing representative frame ${deliveryFrameIndex + 1} for ${atMs}ms.`);
    const source = await readVerifiedPng(sourcePath, `${input.label} representative frame at ${atMs}ms`, input.sourceFramesRoot);
    const framePath = safeChildPath(input.outRoot, join("promoted-delivered-frames", input.family, `${String(atMs).padStart(6, "0")}ms.png`),
      `${input.label} portable representative frame at ${atMs}ms`);
    await writeVerifiedBoundedFile(framePath, source.bytes, {
      label: `${input.label} portable representative frame at ${atMs}ms`,
      maxBytes: MAX_REVIEW_FRAME_BYTES,
      withinRoot: input.outRoot,
      expectedSha256: source.sha256
    });
    const copied = await readVerifiedPng(framePath, `${input.label} portable representative frame at ${atMs}ms`, input.outRoot);
    assert.equal(copied.sha256, source.sha256, `${input.label} portable representative frame at ${atMs}ms did not preserve source bytes.`);
    return {
      atMs,
      deliveryFrameIndex,
      path: relative(input.outRoot, framePath),
      sha256: copied.sha256
    };
  }));
}

function representativeTimes(template: JsonRecord, label: string): number[] {
  const targets = readRecord(readRecord(template.metadata, `${label}.metadata`).qualityTargets, `${label}.metadata.qualityTargets`);
  const times = readArray(targets.representativeFramesMs, `${label}.metadata.qualityTargets.representativeFramesMs`)
    .map((value, index) => readNonNegativeNumber(value, `${label}.representativeFramesMs[${index}]`));
  assert(times.length > 0, `${label} must declare representativeFramesMs.`);
  assert.deepEqual([...times].sort((a, b) => a - b), times, `${label} representativeFramesMs must be strictly ordered.`);
  assert.equal(new Set(times).size, times.length, `${label} representativeFramesMs must be unique.`);
  return times;
}

function sequenceFrameIndexForAtMs(atMs: number, durationMs: number, fps: number): number {
  const frameCount = Math.max(1, Math.ceil((durationMs / 1000) * fps));
  if (!Number.isFinite(atMs) || atMs <= 0) return 0;
  const clampedAtMs = Math.min(atMs, Math.max(0, durationMs - 1));
  return Math.max(0, Math.min(Math.round((clampedAtMs / 1000) * fps), frameCount - 1));
}

async function listSequenceFrames(path: string, label: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const frames = entries
    .filter((entry) => entry.isFile() && /^\d{4,}\.png$/i.test(entry.name))
    .map((entry) => join(path, entry.name))
    .sort();
  assert(frames.length > 0, `${label} contains no retained PNG sequence.`);
  return frames;
}

async function writeReviewSheet(input: {
  path: string;
  /** Review-frame paths are held relative to this metadata root, never relative to a source checkout. */
  rootForFramePaths: string;
  title: string;
  subtitle: string;
  subjects: ReviewSubject[];
}): Promise<void> {
  const columns = 4;
  const tileW = 320;
  const tileH = 210;
  const labelH = 42;
  const rowH = tileH + labelH + 24;
  const margin = 32;
  const width = margin * 2 + columns * tileW + (columns - 1) * 20;
  const height = margin * 2 + 78 + input.subjects.length * rowH;
  const cells = input.subjects.flatMap((subject, subjectIndex) => subject.frames.map((frame, frameIndex) => {
    const x = margin + frameIndex * (tileW + 20);
    const y = margin + 78 + subjectIndex * rowH;
    const framePath = resolve(input.rootForFramePaths, frame.path);
    const href = escapeXml(relative(dirname(input.path), framePath).replaceAll("\\", "/"));
    return [
      `<g>`,
      `<rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="8" fill="#101820"/>`,
      `<image href="${href}" x="${x}" y="${y}" width="${tileW}" height="${tileH}" preserveAspectRatio="xMidYMid meet"/>`,
      `<text x="${x}" y="${y + tileH + 20}" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="800">${escapeXml(subject.label)} · ${frame.atMs}ms</text>`,
      `<text x="${x}" y="${y + tileH + 38}" fill="#9fb2bf" font-family="Inter, Arial, sans-serif" font-size="12">${subject.width}×${subject.height} · delivered frame ${frame.deliveryFrameIndex + 1}</text>`,
      `</g>`
    ].join("");
  }));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(input.title)}">`,
    `<rect width="${width}" height="${height}" fill="#071014"/>`,
    `<text x="${margin}" y="${margin + 28}" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="850">${escapeXml(input.title)}</text>`,
    `<text x="${margin}" y="${margin + 54}" fill="#9fb2bf" font-family="Inter, Arial, sans-serif" font-size="15">${escapeXml(input.subtitle)}</text>`,
    ...cells,
    `</svg>`
  ].join("\n");
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  await writeFile(input.path, `${svg}\n`, "utf8");
}

async function readVerifiedPng(path: string, label: string, withinRoot: string): Promise<{ bytes: Buffer; sha256: string }> {
  const file = await readBoundedStableFile(path, {
    label,
    maxBytes: MAX_REVIEW_FRAME_BYTES,
    withinRoot,
    requireSingleLink: true
  });
  const inspected = inspectPngBuffer(file.bytes);
  assert(inspected.ok, `${label} is not a readable PNG: ${inspected.ok ? "" : inspected.message}`);
  return { bytes: file.bytes, sha256: file.sha256 };
}

async function assertExistingFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), `${label} must be a non-symlink file.`);
}

function safeChildPath(root: string, candidate: string, label: string): string {
  const resolvedCandidate = resolve(root, candidate);
  assert(pathWithin(root, resolvedCandidate), `${label} escaped its governed artifact root.`);
  return resolvedCandidate;
}

function pathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rootWithSeparator = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(rootWithSeparator);
}

async function readJsonRecord(path: string, label: string): Promise<JsonRecord> {
  await assertExistingFile(path, label);
  try {
    return readRecord(JSON.parse(await readFile(path, "utf8")), label);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readRecord(value: unknown, label: string): JsonRecord {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object.`);
  return value as JsonRecord;
}

function readArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array.`);
  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  return readArray(value, label).map((entry, index) => readString(entry, `${label}[${index}]`));
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string.`);
  return value;
}

function readPositiveNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, `${label} must be a positive finite number.`);
  return value;
}

function readNonNegativeNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be a non-negative finite number.`);
  return value;
}

function readSha256(value: unknown, label: string): string {
  const hash = readString(value, label);
  assert(/^[a-f0-9]{64}$/i.test(hash), `${label} must be a SHA-256 digest.`);
  return hash;
}

function safeId(value: string, label: string): string {
  assert(/^[A-Za-z0-9_-]+$/.test(value), `${label} must be a safe package identifier.`);
  return value;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sourceRevision = optionValue(argv, "--source-revision");
  const proofRoot = optionValue(argv, "--proof-root");
  const batchRoot = optionValue(argv, "--batch-root");
  const outRoot = optionValue(argv, "--out");
  assert(sourceRevision, "--source-revision is required.");
  assert(proofRoot, "--proof-root is required.");
  assert(batchRoot, "--batch-root is required.");
  assert(outRoot, "--out is required.");
  const result = await writeRepresentativeFrameReviewSet({ sourceRevision, proofRoot, batchRoot, outRoot });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
