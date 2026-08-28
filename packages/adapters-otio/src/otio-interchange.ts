import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  BoundedResourceBudget,
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  OutputDirectoryTransaction,
  acquireDerivedOutputPublication,
  hashBuffer,
  readBudgetedStableFile
} from "@shellx-motion/core";

export function serializeBoundedOtioTimeline(timeline: unknown): { timelineJson: string; otioSha256: string } {
  const timelineJson = `${JSON.stringify(timeline, null, 2)}\n`;
  if (Buffer.byteLength(timelineJson, "utf8") > DEFAULT_HOST_INTERCHANGE_LIMITS.maxFileBytes) {
    throw new Error(`OTIO export exceeds the ${DEFAULT_HOST_INTERCHANGE_LIMITS.maxFileBytes}-byte per-file limit.`);
  }
  return { timelineJson, otioSha256: hashBuffer(Buffer.from(timelineJson, "utf8")) };
}

export async function readOtioInterchangeInput(otioPath: string) {
  const budget = new BoundedResourceBudget(DEFAULT_HOST_INTERCHANGE_LIMITS, "OTIO interchange");
  return await readBudgetedStableFile(otioPath, {
    label: "OTIO input",
    budget,
    withinRoot: dirname(otioPath)
  });
}

export interface OtioExportOutputPublicationInput {
  otioPath: string;
  receiptPath: string;
  timelineJson: string;
  receiptJson: string;
}

/** Bounded test seam for publication races; production callers leave this empty. */
export interface OtioExportOutputPublicationServices {
  afterTimelinePublished?: () => Promise<void>;
}

/**
 * Publish the timeline before the receipt, retaining the timeline reservation until the receipt
 * is visible. A receipt must never outlive or point at a substituted timeline.
 */
export async function publishOtioExportOutputs(
  input: OtioExportOutputPublicationInput,
  services: OtioExportOutputPublicationServices = {}
): Promise<void> {
  if (resolve(input.otioPath) === resolve(input.receiptPath)) {
    throw new Error("OTIO timeline and receipt paths must differ.");
  }

  let timelinePublication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>> | undefined;
  let receiptPublication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>> | undefined;
  try {
    timelinePublication = await acquireDerivedOutputPublication({ outputPath: input.otioPath, kind: "file" });
    receiptPublication = await acquireDerivedOutputPublication({ outputPath: input.receiptPath, kind: "file" });

    await writeFile(timelinePublication.stagingPath, input.timelineJson, "utf8");
    await writeFile(receiptPublication.stagingPath, input.receiptJson, "utf8");
    const timelineEvidence = await timelinePublication.verifyFile();
    const receiptEvidence = await receiptPublication.verifyFile();

    await timelinePublication.publishFile(timelineEvidence, { retainReservation: true });
    await services.afterTimelinePublished?.();
    await receiptPublication.publishFile(receiptEvidence);
    await timelinePublication.abort().catch(() => undefined);
  } catch (error) {
    await receiptPublication?.abort().catch(() => undefined);
    // A timeline that reached its public path is deliberately never removed here: another process
    // may have replaced that path after publication, and the private reservation is the only state
    // this operation can safely clean up.
    await timelinePublication?.abort().catch(() => undefined);
    throw error;
  }
}

export interface OtioImportPackagePublicationInput {
  packageDir: string;
  manifestJson: string;
  motionFileName: string;
  motionJson: string;
  receiptJson: string;
}

/** Bounded test seam for a parent-replacement regression; production callers leave this empty. */
export interface OtioImportPackagePublicationServices {
  beforeCommit?: () => Promise<void>;
}

/** Build the complete OTIO import in a private stage, then atomically publish the package. */
export async function publishOtioImportPackage(
  input: OtioImportPackagePublicationInput,
  services: OtioImportPackagePublicationServices = {}
): Promise<void> {
  const transaction = await OutputDirectoryTransaction.create(input.packageDir);
  try {
    await mkdir(join(transaction.stagingPath, "receipts"), { recursive: true, mode: 0o700 });
    await writeFile(join(transaction.stagingPath, "manifest.json"), input.manifestJson, "utf8");
    await writeFile(join(transaction.stagingPath, input.motionFileName), input.motionJson, "utf8");
    await writeFile(join(transaction.stagingPath, "receipts", "otio-import.receipt.json"), input.receiptJson, "utf8");
    await services.beforeCommit?.();
    await transaction.commit();
    await transaction.assertPublishedCurrent();
  } catch (error) {
    await transaction.abort();
    throw error;
  }
}
