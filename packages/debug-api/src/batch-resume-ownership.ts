import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectDebugBatchResumeOutput } from "./batch-output-admission.js";
import type { MotionDebugResult } from "./command-registry.js";

export type DebugBatchResumeOutput = Awaited<ReturnType<typeof inspectDebugBatchResumeOutput>>;

export async function inspectDebugBatchResumeOwner(
  outDir: string,
  callerId: string | undefined
): Promise<
  | { ok: true; batchOutput: DebugBatchResumeOutput; jobs: Map<string, Record<string, unknown>> }
  | { ok: false; result: MotionDebugResult }
> {
  // Admit the retained output before comparing owner data so an unsafe directory is not an oracle.
  const batchOutput = await inspectDebugBatchResumeOutput(outDir);
  if (!callerId) return { ok: false, result: principalUnavailable() };
  try {
    const parsed = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8"));
    const output = record(record(parsed)?.output);
    if (typeof output?.callerId !== "string" || output.callerId !== callerId) {
      return { ok: false, result: ownerNotVisible() };
    }
    return { ok: true, batchOutput, jobs: resumeJobs(output.jobs) };
  } catch {
    return { ok: false, result: ownershipUnavailable() };
  }
}

function resumeJobs(value: unknown): Map<string, Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return byKey;
  for (const job of value) {
    const item = record(job);
    if (item && typeof item.idempotencyKey === "string") byKey.set(item.idempotencyKey, item);
  }
  return byKey;
}

function principalUnavailable(): MotionDebugResult {
  return refusal("capability_unavailable", "Batch resume requires a server-authenticated caller principal before retained output is reopened for writing.", "Configure a stable authenticated callerId on the host, then retry as the caller that created this batch.");
}

function ownerNotVisible(): MotionDebugResult {
  return refusal("job_not_visible", "The retained batch belongs to a different authenticated caller; Motion left its outputs unchanged.", "Resume as the original caller, or submit a fresh batch to a new output directory.");
}

function ownershipUnavailable(): MotionDebugResult {
  return refusal("capability_unavailable", "The retained batch has no verifiable authenticated caller ownership; Motion left its outputs unchanged.", "Start a fresh batch in a new output directory with a stable authenticated callerId.");
}

function refusal(code: "capability_unavailable" | "job_not_visible", message: string, suggestedAction: string): MotionDebugResult {
  return { ok: false, error: { code, message, suggestedAction }, warnings: [] };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
