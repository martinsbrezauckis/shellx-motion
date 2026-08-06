/**
 * Deciding whether a previously-rendered batch row can be reused instead of re-rendered.
 *
 * Kept separate from main.ts because these three functions form a self-contained concern.
 *
 * THE RULE THAT MATTERS HERE. A resumable row is one that previously produced usable output, and
 * that question is answered from the STATUS CONTRACT, not from a literal list. The original test was
 * `previous.status !== "passed"`; a successful row carrying an honest advisory report can be
 * `warning`, so literal equality would silently re-render usable output. Treating every status
 * other than `passed` as failure violates the shared status contract.
 *
 * Dependencies: `@shellx-motion/core` for the generated receipt-status -> job-outcome mapping.
 * Primary caller: the `render-batch` command in ./main.ts.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { jobOutcomeForReceiptStatus } from "@shellx-motion/core";

/** A plain object, or null for anything else. Local so this module does not depend on main.ts. */
function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function readBatchResumeJobs(receiptPath: string): Promise<Map<string, Record<string, unknown>>> {
  try {
    const parsed = JSON.parse(await readFile(receiptPath, "utf8"));
    const output = readRecord(readRecord(parsed)?.output);
    const jobs = output?.jobs;
    if (!Array.isArray(jobs)) return new Map();
    const byKey = new Map<string, Record<string, unknown>>();
    for (const job of jobs) {
      const record = readRecord(job);
      const idempotencyKey = record?.idempotencyKey;
      if (record && typeof idempotencyKey === "string") byKey.set(idempotencyKey, record);
    }
    return byKey;
  } catch (error) {
    if (readRecord(error)?.code === "ENOENT") return new Map();
    throw error;
  }
}

export function readBatchResumeMatch(previousJobs: Map<string, Record<string, unknown>>, idempotencyKey: string, outputPath: string): Record<string, unknown> | null {
  const previous = previousJobs.get(idempotencyKey);
  if (!previous) return null;
  if (previous.outputPath !== outputPath) return null;
  // A resumable row is one that previously produced usable output. Derived from the contract, not
  // from a literal list: under the unified status rule a successful row that carried an
  // honest advisory reports `warning`, and the old `!== "passed"` test refused to match it and
  // silently re-rendered everything. That is exactly the "treating status !== passed as failure"
  // mistake the Cut handoff note warns integrators about -- it bit us here first.
  // `skipped` is not a receipt status; it is this batch's own marker for a row resumed earlier.
  const previousStatus = typeof previous.status === "string" ? previous.status : "";
  const previouslyUsable = previousStatus === "skipped"
    || jobOutcomeForReceiptStatus(previousStatus) === "succeeded";
  if (!previouslyUsable) return null;
  const sourceReceiptPath = batchResumeSourceReceiptPath(previous);
  if (!sourceReceiptPath || !existsSync(sourceReceiptPath)) return null;
  if (!existsSync(outputPath)) return null;
  return previous;
}

export function batchResumeSourceReceiptPath(job: Record<string, unknown>): string | undefined {
  if (typeof job.receiptPath === "string") return job.receiptPath;
  const resume = readRecord(job.resume);
  return typeof resume?.sourceReceiptPath === "string" ? resume.sourceReceiptPath : undefined;
}
