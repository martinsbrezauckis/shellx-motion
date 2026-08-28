import {
  batchQualityInputEvidence,
  hashBuffer,
  prepareBatchQualityManifestSnapshot,
  publishBatchQualityManifestSnapshot,
  type BatchQualityInputEvidence,
  type OperationReceipt,
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugResult } from "./command-registry.js";

export async function retainDebugQualityManifestForEvaluation(input: {
  sourcePath: string;
  targetRoot: string;
  packageId: string;
  packageDir: string;
  outputPath: string;
}) {
  const snapshot = await prepareBatchQualityManifestSnapshot({
    sourcePath: input.sourcePath,
    interpolate: false,
    context: {
      values: {}, rowId: "single", rowIndex: 0,
      rowHash: hashBuffer(Buffer.from(resolve(input.sourcePath), "utf8")),
      packageId: input.packageId, packageDir: input.packageDir, outputPath: input.outputPath,
    },
  });
  const published = await publishBatchQualityManifestSnapshot({
    snapshot,
    targetRoot: join(input.targetRoot, snapshot.closureSha256.slice(0, 24)),
  });
  return { snapshot, published, evidence: batchQualityInputEvidence(snapshot) };
}

export function debugQualityInputHashes(input: BatchQualityInputEvidence): Record<string, string> {
  return {
    qualityManifest: input.manifestSha256,
    qualityManifestMaterialized: input.materializedManifestSha256,
    qualityBaselines: input.baselinesSha256,
    qualityInputs: input.closureSha256,
  };
}

export function debugQualityManifestDisplayPaths(
  retained: Awaited<ReturnType<typeof retainDebugQualityManifestForEvaluation>>,
  manifestPath: string,
): { manifestPath: string; baselinePath: (appliedPath: string) => string } {
  const baselines = new Map(retained.published.baselines.map((baseline) => [baseline.appliedPath, baseline.sourcePath]));
  return { manifestPath: resolve(manifestPath), baselinePath: (appliedPath) => baselines.get(appliedPath) ?? appliedPath };
}

export function displayDebugQualitySampleFrames<T extends { framePath?: string }>(
  samples: readonly T[],
  displayPath?: (physicalPath: string) => string,
): T[] {
  return samples.map((sample) => sample.framePath && displayPath ? { ...sample, framePath: displayPath(sample.framePath) } : sample);
}

export function attachDebugQualityInputs(
  result: MotionDebugResult,
  manifestPath: string,
  appliedPath: string,
  qualityInputs: BatchQualityInputEvidence,
): MotionDebugResult {
  const evidence = { qualityManifestPath: manifestPath, qualityManifestAppliedPath: appliedPath, qualityInputs };
  if (result.ok) return { ...result, result: { ...(record(result.result) ?? {}), ...evidence } };
  return { ...result, error: { ...result.error, detail: { ...(record(result.error.detail) ?? {}), ...evidence } } };
}

export function readDebugQualityInputs(result: MotionDebugResult): BatchQualityInputEvidence | null {
  const container = result.ok ? record(result.result) : record(result.error.detail);
  const value = record(container?.qualityInputs);
  if (!value
    || typeof value.manifestSha256 !== "string"
    || typeof value.materializedManifestSha256 !== "string"
    || typeof value.baselinesSha256 !== "string"
    || typeof value.closureSha256 !== "string") return null;
  return {
    manifestSha256: value.manifestSha256,
    materializedManifestSha256: value.materializedManifestSha256,
    baselinesSha256: value.baselinesSha256,
    closureSha256: value.closureSha256,
  };
}

export async function enrichDebugRenderReceiptWithQualityManifest(
  receipt: OperationReceipt,
  qualityManifestPath: string,
  qualityCheck: MotionDebugResult,
): Promise<void> {
  const qualityInputs = readDebugQualityInputs(qualityCheck);
  if (!qualityInputs) throw new Error("Quality evaluation did not return an exact retained input closure.");
  receipt.inputHashes = { ...receipt.inputHashes, ...debugQualityInputHashes(qualityInputs) };
  const qualityResult = qualityCheck.ok ? record(qualityCheck.result) : record(qualityCheck.error.detail);
  receipt.output = {
    ...(record(receipt.output) ?? {}), qualityManifestPath,
    ...(typeof qualityResult?.qualityManifestAppliedPath === "string" ? { qualityManifestAppliedPath: qualityResult.qualityManifestAppliedPath } : {}),
    qualityCheck: { status: qualityCheck.ok ? "passed" : "failed" },
  };
  receipt.status = qualityCheck.ok ? receipt.status : "failed";
  receipt.warnings = [...new Set([...receipt.warnings, ...resultWarnings(qualityCheck)])];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function resultWarnings(value: unknown): string[] {
  const item = record(value);
  if (!item) return [];
  const source = Array.isArray(item.warnings) ? item.warnings : record(item.receipt)?.warnings;
  return Array.isArray(source) ? source.filter((entry): entry is string => typeof entry === "string") : [];
}
