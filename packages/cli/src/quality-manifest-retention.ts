import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { join, resolve } from "node:path";
import { batchQualityInputEvidence, prepareBatchQualityManifestSnapshot, publishBatchQualityManifestSnapshot } from "./batch-quality-manifest";
import type { CliResult } from "./main.js";

export async function retainQualityManifestForEvaluation(
  sourcePath: string,
  targetRoot: string,
  context: { packageId: string; packageDir: string; outputPath: string },
) {
  const snapshot = await prepareBatchQualityManifestSnapshot({
    sourcePath,
    interpolate: false,
    context: {
      values: {}, rowId: "single", rowIndex: 0, rowHash: hashBuffer(Buffer.from(sourcePath, "utf8")),
      packageId: context.packageId, packageDir: context.packageDir, outputPath: context.outputPath,
    },
  });
  const published = await publishBatchQualityManifestSnapshot({
    snapshot,
    targetRoot: join(targetRoot, snapshot.closureSha256.slice(0, 24)),
  });
  return { snapshot, published, evidence: batchQualityInputEvidence(snapshot) };
}

export function remapRetainedQualityInputPaths(
  value: unknown,
  retained: Awaited<ReturnType<typeof retainQualityManifestForEvaluation>>,
  manifestPath: string,
): void {
  const replacements = new Map<string, string>([
    [retained.published.appliedPath, resolve(manifestPath)],
    ...retained.published.baselines.map((baseline) => [baseline.appliedPath, baseline.sourcePath] as const),
  ]);
  remapExactPaths(value, replacements);
}

export async function enrichRenderReceiptWithQualityManifest(
  receipt: OperationReceipt,
  qualityManifestPath: string,
  qualityCheck: CliResult,
): Promise<void> {
  const qualityInputs = record(qualityCheck.qualityInputs);
  if (!qualityInputs || typeof qualityInputs.manifestSha256 !== "string" || typeof qualityInputs.baselinesSha256 !== "string") {
    throw new Error("Quality evaluation did not return an exact retained input closure.");
  }
  receipt.inputHashes = {
    ...receipt.inputHashes,
    qualityManifest: qualityInputs.manifestSha256,
    qualityManifestMaterialized: String(qualityInputs.materializedManifestSha256),
    qualityBaselines: qualityInputs.baselinesSha256,
    qualityInputs: String(qualityInputs.closureSha256),
  };
  receipt.output = {
    ...(record(receipt.output) ?? {}),
    qualityManifestPath,
    ...(typeof qualityCheck.qualityManifestAppliedPath === "string" ? { qualityManifestAppliedPath: qualityCheck.qualityManifestAppliedPath } : {}),
    qualityCheck: {
      status: qualityCheck.ok ? "passed" : "failed",
      ...(qualityCheck.ok ? {} : { failedSample: summarizeFailedQualitySample(qualityCheck) }),
    },
  };
  receipt.status = qualityCheck.ok ? receipt.status : "failed";
  receipt.warnings = [...new Set([...receipt.warnings, ...warnings(qualityCheck)])];
}

function remapExactPaths(value: unknown, replacements: ReadonlyMap<string, string>): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string") (value as Record<string, unknown>)[key] = replacements.get(child) ?? child;
    else remapExactPaths(child, replacements);
  }
}

function summarizeFailedQualitySample(qualityCheck: CliResult): Record<string, unknown> | undefined {
  const samples = Array.isArray(qualityCheck.samples) ? qualityCheck.samples : [];
  const failed = samples.map(record).find((sample) => sample?.ok === false);
  if (!failed) return undefined;
  const error = record(failed.error);
  const visualDiff = record(failed.visualDiff);
  return {
    id: failed.id,
    ...(typeof failed.atMs === "number" ? { atMs: failed.atMs } : {}),
    ...(typeof failed.deliveryFrameIndex === "number" ? { deliveryFrameIndex: failed.deliveryFrameIndex } : {}),
    ...(error ? { code: error.code, message: error.message } : {}),
    ...(typeof failed.framePath === "string" ? { framePath: failed.framePath } : {}),
    ...(typeof failed.baselinePath === "string" ? { baselinePath: failed.baselinePath } : {}),
    ...(typeof failed.diffPath === "string" ? { diffPath: failed.diffPath } : {}),
    ...(visualDiff ? { metrics: {
      changedPixels: visualDiff.changedPixels, meanAbsoluteError: visualDiff.meanAbsoluteError,
      rootMeanSquaredError: visualDiff.rootMeanSquaredError, psnrDb: visualDiff.psnrDb,
      ssim: visualDiff.ssim, maxChannelDelta: visualDiff.maxChannelDelta,
    } } : {}),
  };
}

function warnings(value: unknown): string[] {
  const item = record(value);
  if (!item) return [];
  const source = Array.isArray(item.warnings) ? item.warnings : record(item.receipt)?.warnings;
  return Array.isArray(source) ? source.filter((entry): entry is string => typeof entry === "string") : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
