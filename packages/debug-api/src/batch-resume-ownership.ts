import { lstat, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { OutputPathTopologyError, jobOutcomeForReceiptStatus } from "@shellx-motion/core";
import type { DebugBatchOutputRoots } from "./batch-output-admission.js";
import type { MotionDebugResult } from "./command-registry.js";

export async function inspectDebugBatchResumeOwner(
  batchOutput: DebugBatchOutputRoots,
  callerId: string | undefined
): Promise<
  | { ok: true; jobs: Map<string, Record<string, unknown>> }
  | { ok: false; result: MotionDebugResult }
> {
  // Admit the retained output before comparing owner data so an unsafe directory is not an oracle.
  if (!callerId) return { ok: false, result: principalUnavailable() };
  try {
    const aggregatePath = join(batchOutput.receiptsRoot, "batch-render.receipt.json");
    const parsed = await readExactResumeReceipt(aggregatePath, batchOutput.receiptsRoot, "Batch resume aggregate receipt");
    const output = record(record(parsed)?.output);
    if (typeof output?.callerId !== "string" || output.callerId !== callerId) {
      return { ok: false, result: ownerNotVisible() };
    }
    const jobs = await resumeJobs(output.jobs, batchOutput);
    await batchOutput.assertCurrent();
    return { ok: true, jobs };
  } catch (error) {
    if (error instanceof OutputPathTopologyError) return { ok: false, result: retainedOutputUnsafe(error.message) };
    return { ok: false, result: ownershipUnavailable() };
  }
}

/** Recheck the exact row artifacts immediately before the batch records a skipped resume row. */
export async function assertDebugBatchResumeArtifacts(
  batchOutput: DebugBatchOutputRoots,
  job: Record<string, unknown>
): Promise<string> {
  const outputPath = typeof job.outputPath === "string" ? job.outputPath : undefined;
  const sourceReceiptPath = sourceReceiptPathFor(job);
  if (!outputPath || !sourceReceiptPath) {
    throw new OutputPathTopologyError("Retained resumable batch row has no exact artifact descendants; Motion left the batch unchanged.", batchOutput.renderRoot);
  }
  await batchOutput.assertCurrent();
  await assertExactResumeArtifact(outputPath, batchOutput.renderRoot, "Retained batch output");
  await readExactResumeReceipt(sourceReceiptPath, batchOutput.receiptsRoot, "Retained batch row receipt");
  await batchOutput.assertCurrent();
  return sourceReceiptPath;
}

async function resumeJobs(value: unknown, batchOutput: DebugBatchOutputRoots): Promise<Map<string, Record<string, unknown>>> {
  const byKey = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return byKey;
  for (const job of value) {
    const item = record(job);
    if (!item || typeof item.idempotencyKey !== "string") continue;
    const outputPath = typeof item.outputPath === "string" ? item.outputPath : undefined;
    if (!outputPath) throw new OutputPathTopologyError("Retained batch row has no exact output descendant; Motion left the batch unchanged.", batchOutput.renderRoot);
    assertExactDirectDescendant(batchOutput.renderRoot, outputPath, "Retained batch output");
    const sourceReceiptPath = sourceReceiptPathFor(item);
    const resumable = item.status === "skipped" || jobOutcomeForReceiptStatus(typeof item.status === "string" ? item.status : "") === "succeeded";
    if (resumable) {
      if (!sourceReceiptPath) throw new OutputPathTopologyError("Retained resumable batch row has no exact receipt descendant; Motion left the batch unchanged.", batchOutput.receiptsRoot);
      await assertDebugBatchResumeArtifacts(batchOutput, item);
    }
    byKey.set(item.idempotencyKey, item);
  }
  return byKey;
}

function sourceReceiptPathFor(job: Record<string, unknown>): string | undefined {
  if (typeof job.receiptPath === "string") return job.receiptPath;
  const resume = record(job.resume);
  return typeof resume?.sourceReceiptPath === "string" ? resume.sourceReceiptPath : undefined;
}

function assertExactDirectDescendant(root: string, path: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const descendant = relative(resolvedRoot, resolvedPath);
  if (!descendant || descendant === ".." || descendant.startsWith(`..${sep}`) || descendant.includes(sep) || basename(resolvedPath) !== descendant) {
    throw new OutputPathTopologyError(`${label} must be one exact non-linked descendant of its retained batch root.`, path);
  }
  return resolvedPath;
}

async function assertExactResumeArtifact(path: string, root: string, label: string): Promise<void> {
  const resolvedPath = assertExactDirectDescendant(root, path, label);
  const before = await lstat(resolvedPath);
  if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
    throw new OutputPathTopologyError(`${label} must be a regular non-linked retained artifact.`, resolvedPath);
  }
  const after = await lstat(resolvedPath);
  if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new OutputPathTopologyError(`${label} changed while Motion reopened the retained batch; Motion left it unchanged.`, resolvedPath);
  }
}

async function readExactResumeReceipt(path: string, root: string, label: string): Promise<unknown> {
  const resolvedPath = assertExactDirectDescendant(root, path, label);
  const before = await lstat(resolvedPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new OutputPathTopologyError(`${label} must be a regular non-linked retained artifact.`, resolvedPath);
  }
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  const after = await lstat(resolvedPath);
  if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new OutputPathTopologyError(`${label} changed while Motion reopened the retained batch; Motion left it unchanged.`, resolvedPath);
  }
  return parsed;
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

function retainedOutputUnsafe(message: string): MotionDebugResult {
  return refusal("invalid_args", message, "Start a fresh batch in a new output directory; retained rows must remain exact non-linked descendants.");
}

function refusal(code: "capability_unavailable" | "invalid_args" | "job_not_visible", message: string, suggestedAction: string): MotionDebugResult {
  return { ok: false, error: { code, message, suggestedAction }, warnings: [] };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
