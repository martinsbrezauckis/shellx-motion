import { existsSync } from "node:fs";
import { jobOutcomeForReceiptStatus } from "@shellx-motion/core";
import type { MotionDebugResult } from "./command-registry.js";
import { normalizePublicationUncertainty } from "./publication-uncertainty.js";

export function readDebugBatchResumeMatch(
  previousJobs: Map<string, Record<string, unknown>>,
  idempotencyKey: unknown,
  outputPath: unknown
): Record<string, unknown> | null {
  if (typeof idempotencyKey !== "string" || typeof outputPath !== "string") return null;
  const previous = previousJobs.get(idempotencyKey);
  if (!previous || previous.outputPath !== outputPath) return null;
  const previousStatus = typeof previous.status === "string" ? previous.status : "";
  if (previousStatus !== "skipped" && jobOutcomeForReceiptStatus(previousStatus) !== "succeeded") return null;
  const sourceReceiptPath = debugBatchResumeSourceReceiptPath(previous);
  if (!sourceReceiptPath || !existsSync(sourceReceiptPath) || !existsSync(outputPath)) return null;
  return previous;
}

export function debugBatchRenderCounts(jobs: readonly Record<string, unknown>[], dryRun: boolean): { resumedRows: number; renderedRows: number } {
  const resumedRows = jobs.filter((job) => job.status === "skipped").length;
  return { resumedRows, renderedRows: dryRun ? 0 : jobs.length - resumedRows };
}

/** Reconciliation facts shared by normal failed-child and later-bookkeeping failure envelopes. */
export function debugBatchDeliveryFields(jobs: readonly Record<string, unknown>[]): Record<string, unknown> {
  const committedDeliveries = jobs
    .filter((job) => job.renderCommitted === true && typeof job.renderOutputPath === "string" && typeof job.renderReceiptPath === "string")
    .map((job) => ({ outputPath: job.renderOutputPath, receiptPath: job.renderReceiptPath }));
  const uncertainDeliveries = jobs
    .filter((job) => job.possiblyCommitted === true && Array.isArray(job.publicPaths))
    .map((job) => ({
      phase: typeof job.publicationCommitPhase === "string" ? job.publicationCommitPhase : "unknown",
      publicPaths: (job.publicPaths as unknown[]).filter((path): path is string => typeof path === "string"),
      ...(Array.isArray(job.expectedPublications) && job.expectedPublications.length > 0
        ? { expectedPublications: [...job.expectedPublications] }
        : {})
    }));
  return {
    ...(committedDeliveries.length > 0 ? { batchCommitted: true, committedDeliveries } : {}),
    ...(uncertainDeliveries.length > 0 ? { possiblyCommitted: true, uncertainDeliveries } : {})
  };
}

export function debugBatchRenderError(
  job: { row: { id: string }; manifest: { id: string } },
  renderResult: MotionDebugResult
): { code: string; message: string; suggestedAction?: string; detail?: unknown } {
  if (renderResult.ok) return { code: "render_batch_failed", message: `Batch row ${job.row.id} did not return a failed render result.` };
  return { ...renderResult.error, message: `Batch row ${job.row.id} (${job.manifest.id}) failed: ${renderResult.error.message}` };
}

/** Normalizes one delegated final-render result before batch bookkeeping can fail. */
export function debugBatchRenderedDelivery(result: MotionDebugResult): {
  renderPayload: Record<string, unknown> | undefined;
  renderQualityCheck: Record<string, unknown> | undefined;
  receiptPath: string | undefined;
  possiblyCommittedPaths: string[];
  rowWarnings: string[];
  uncertaintyFields: Record<string, unknown>;
} {
  const renderPayload = ownRecord(result.result);
  const renderQualityCheck = ownRecord(renderPayload?.qualityCheck);
  const receiptPath = typeof renderPayload?.receiptPath === "string" ? renderPayload.receiptPath : undefined;
  const rootError = result.ok ? undefined : ownRecord(result.error);
  const uncertainty = normalizePublicationUncertainty(
    result.ok ? renderPayload : undefined,
    rootError?.detail,
    rootError,
    renderPayload
  );
  const possiblyCommittedPaths = uncertainty?.publicPaths ? [...uncertainty.publicPaths] : [];
  const rowWarnings = [...new Set([
    ...debugResultWarnings(result),
    ...(possiblyCommittedPaths.length > 0 ? ["Render delivery may have committed; inspect the reported public evidence before retrying."] : [])
  ])];
  const uncertaintyFields = possiblyCommittedPaths.length > 0 ? {
    possiblyCommitted: true,
    publicationCommitPhase: uncertainty?.publicationCommitPhase ?? "output",
    publicPaths: possiblyCommittedPaths,
    ...(uncertainty && uncertainty.expectedPublications.length > 0
      ? { expectedPublications: [...uncertainty.expectedPublications] }
      : {})
  } : {};
  return { renderPayload, renderQualityCheck, receiptPath, possiblyCommittedPaths, rowWarnings, uncertaintyFields };
}

export function debugBatchResumeSourceReceiptPath(job: Record<string, unknown>): string | undefined {
  if (typeof job.receiptPath === "string") return job.receiptPath;
  const resume = ownRecord(job.resume);
  return typeof resume?.sourceReceiptPath === "string" ? resume.sourceReceiptPath : undefined;
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function debugResultWarnings(result: unknown): string[] {
  const record = ownRecord(result);
  if (!record) return [];
  if (Array.isArray(record.warnings)) return record.warnings.filter((warning): warning is string => typeof warning === "string");
  const receipt = ownRecord(record.receipt);
  return receipt && Array.isArray(receipt.warnings)
    ? receipt.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
}
