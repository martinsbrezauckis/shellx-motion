import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OutputDirectoryReservation, OutputPathTopologyError } from "@shellx-motion/core";

export interface DebugBatchOutputRoots {
  batchOutput: OutputDirectoryReservation;
  packagesRoot: string;
  renderRoot: string;
  receiptsRoot: string;
  framesRoot: string;
}

export async function prepareDebugBatchOutput(
  outDir: string,
  options: { resume: boolean; keepFrames?: boolean },
  retainedResumeOutput?: OutputDirectoryReservation
): Promise<DebugBatchOutputRoots | null> {
  if (retainedResumeOutput && retainedResumeOutput.path !== resolve(outDir)) {
    throw new OutputPathTopologyError("Retained batch output authority does not match the requested output directory.", outDir);
  }
  const batchOutput = retainedResumeOutput ?? await acquireDebugBatchOutput(outDir, options.resume);
  if (!batchOutput) return null;
  const packagesRoot = join(outDir, "packages");
  const renderRoot = join(outDir, "render");
  const receiptsRoot = join(outDir, "receipts");
  const framesRoot = join(outDir, "frames");
  await batchOutput.assertCurrent();
  await mkdir(packagesRoot, { recursive: true, mode: 0o700 });
  await batchOutput.assertCurrent();
  await mkdir(renderRoot, { recursive: true, mode: 0o700 });
  await batchOutput.assertCurrent();
  await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
  if (options.keepFrames) {
    await batchOutput.assertCurrent();
    await mkdir(framesRoot, { recursive: true, mode: 0o700 });
  }
  return { batchOutput, packagesRoot, renderRoot, receiptsRoot, framesRoot };
}

/**
 * Reopen an existing batch output for ownership validation without creating any child directory.
 * The returned reservation is then retained through the caller-approved resume write sequence.
 */
export async function inspectDebugBatchResumeOutput(outDir: string): Promise<OutputDirectoryReservation> {
  return await OutputDirectoryReservation.acquire(outDir, {
    allowExistingContents: true,
    requireExisting: true,
    requireExclusiveChildAuthority: true
  });
}

export function debugBatchOutputTopologyError(error: unknown): OutputPathTopologyError | null {
  return error instanceof OutputPathTopologyError ? error : null;
}

async function acquireDebugBatchOutput(outDir: string, resume: boolean): Promise<OutputDirectoryReservation | null> {
  try {
    return await OutputDirectoryReservation.acquire(outDir, {
      allowExistingContents: resume,
      requireExclusiveChildAuthority: true
    });
  } catch (error) {
    if (error instanceof OutputPathTopologyError && error.message === "Output directory must be empty before this operation.") return null;
    throw error;
  }
}
