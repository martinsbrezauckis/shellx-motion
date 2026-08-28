import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OutputDirectoryReservation } from "@shellx-motion/core";
import { readBatchResumeJobs } from "./batch-resume";

export type CliBatchOutputAdmission =
  | {
      ok: true;
      batchOutput: OutputDirectoryReservation;
      packagesRoot: string;
      renderRoot: string;
      receiptsRoot: string;
      previousBatchJobs: Map<string, Record<string, unknown>>;
    }
  | { ok: false; message: string };

/** Admit one retained private root before batch packages, media, or receipts are created. */
export async function admitCliBatchOutput(outDir: string, resume: boolean): Promise<CliBatchOutputAdmission> {
  let batchOutput: OutputDirectoryReservation;
  try {
    // Quality/workflow inputs may deliberately share this private root with generated children.
    batchOutput = await OutputDirectoryReservation.acquire(outDir, {
      allowExistingContents: true,
      requireExclusiveChildAuthority: true
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "render-batch output directory could not be admitted safely." };
  }
  const packagesRoot = join(outDir, "packages");
  const renderRoot = join(outDir, "render");
  const receiptsRoot = join(outDir, "receipts");
  await batchOutput.assertCurrent();
  const previousBatchJobs = resume ? await readBatchResumeJobs(join(receiptsRoot, "batch-render.receipt.json")) : new Map<string, Record<string, unknown>>();
  await batchOutput.assertCurrent();
  await mkdir(packagesRoot, { recursive: true, mode: 0o700 });
  await batchOutput.assertCurrent();
  await mkdir(renderRoot, { recursive: true, mode: 0o700 });
  await batchOutput.assertCurrent();
  await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
  return { ok: true, batchOutput, packagesRoot, renderRoot, receiptsRoot, previousBatchJobs };
}
