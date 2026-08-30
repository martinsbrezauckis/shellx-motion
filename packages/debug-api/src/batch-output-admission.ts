import { join } from "node:path";
import { OutputDirectoryReservation, OutputPathTopologyError } from "@shellx-motion/core";

export interface DebugBatchOutputRoots {
  batchOutput: OutputDirectoryReservation;
  packagesOutput: OutputDirectoryReservation;
  renderOutput: OutputDirectoryReservation;
  receiptsOutput: OutputDirectoryReservation;
  framesOutput?: OutputDirectoryReservation;
  packagesRoot: string;
  renderRoot: string;
  receiptsRoot: string;
  framesRoot: string;
  /** Recheck the retained batch root and every descendant this batch will read or write. */
  assertCurrent(): Promise<void>;
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
  const packagesOutput = await acquireDebugBatchDescendant(packagesRoot, { resume: options.resume, requireExistingOnResume: true });
  await batchOutput.assertCurrent();
  const renderOutput = await acquireDebugBatchDescendant(renderRoot, { resume: options.resume, requireExistingOnResume: true });
  await batchOutput.assertCurrent();
  const receiptsOutput = await acquireDebugBatchDescendant(receiptsRoot, { resume: options.resume, requireExistingOnResume: true });
  const framesOutput = options.keepFrames ? await acquireDebugBatchDescendant(framesRoot, { resume: options.resume, requireExistingOnResume: false }) : undefined;
  const output = {
    batchOutput,
    packagesOutput,
    renderOutput,
    receiptsOutput,
    ...(framesOutput ? { framesOutput } : {}),
    packagesRoot,
    renderRoot,
    receiptsRoot,
    framesRoot,
    async assertCurrent(): Promise<void> {
      await batchOutput.assertCurrent();
      await packagesOutput.assertCurrent();
      await renderOutput.assertCurrent();
      await receiptsOutput.assertCurrent();
      await framesOutput?.assertCurrent();
    }
  } satisfies DebugBatchOutputRoots;
  await output.assertCurrent();
  return output;
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

async function acquireDebugBatchDescendant(path: string, options: { resume: boolean; requireExistingOnResume: boolean }): Promise<OutputDirectoryReservation> {
  return await OutputDirectoryReservation.acquire(path, options.resume
    ? { allowExistingContents: true, requirePrivate: true, ...(options.requireExistingOnResume ? { requireExisting: true } : {}) }
    : { allowExistingContents: false });
}
