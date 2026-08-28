import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  options: { resume: boolean; keepFrames?: boolean }
): Promise<DebugBatchOutputRoots | null> {
  const batchOutput = await acquireDebugBatchOutput(outDir, options.resume);
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
