/** Receipt mutation and verified private staging before class-owned post-stage observers. */
import type { DerivedFilePublicationEvidence, DerivedOutputPublication } from "./derived-output-publication";
import { heldOutputDirectoryState } from "./output-path-held-directory-authority";
import {
  assertReceiptBindsOutput,
  bindSecondaryArtifacts,
  normalizeReceiptArtifacts,
  rebindReceiptOutput,
  type PairedOutputArtifactSpec,
} from "./paired-output-receipt-publication-support";
import { markPairedOutputReceipt } from "./paired-output-receipt-verification";
import type { StagedSecondaryArtifact } from "./paired-output-receipt-secondary-stage";
import type { OperationReceipt } from "./types";

export async function stagePairedReceiptEvidence(input: Readonly<{
  receipt: OperationReceipt;
  outputEvidence: DerivedFilePublicationEvidence;
  paths: Readonly<{ stagedOutput: string; output: string; receipt: string }>;
  artifacts: Readonly<{ output: PairedOutputArtifactSpec; receipt: PairedOutputArtifactSpec; secondary: readonly StagedSecondaryArtifact[] }>;
  publications: Readonly<{ receipt: DerivedOutputPublication }>;
  storage: Readonly<{
    heldDirectoryAuthority: unknown;
    receiptMaxBytes: number | undefined;
    serialization: Readonly<{ serialize(receipt: OperationReceipt): string; maxBytes: number }> | undefined;
    writeStage(path: string, contents: string): Promise<void>;
  }>;
}>): Promise<DerivedFilePublicationEvidence> {
  rebindReceiptOutput(input.receipt, input.paths.stagedOutput, input.paths.output, input.outputEvidence);
  markPairedOutputReceipt(input.receipt, input.paths.receipt);
  bindSecondaryArtifacts(input.receipt, input.artifacts.secondary);
  normalizeReceiptArtifacts(input.receipt, input.paths.stagedOutput, input.paths.output, input.paths.receipt, input.artifacts.output, input.artifacts.receipt);
  assertReceiptBindsOutput(input.receipt, input.paths.output, input.outputEvidence);
  const serialized = input.storage.serialization ? input.storage.serialization.serialize(input.receipt) : `${JSON.stringify(input.receipt, null, 2)}\n`;
  if (typeof serialized !== "string" || (input.storage.serialization && Buffer.byteLength(serialized, "utf8") > input.storage.serialization.maxBytes)) {
    throw new Error("Paired receipt serialized bytes exceed their bounded publication limit.");
  }
  const receiptEvidence = heldOutputDirectoryState(input.storage.heldDirectoryAuthority)
    ? await input.publications.receipt.writePrivateFile(Buffer.from(serialized, "utf8"), { label: "Paired held receipt", maxBytes: input.storage.receiptMaxBytes ?? Number.MAX_SAFE_INTEGER })
    : await writeAndVerifyReceiptStage(input.publications.receipt, input.storage.writeStage, serialized);
  return receiptEvidence;
}

async function writeAndVerifyReceiptStage(
  publication: DerivedOutputPublication,
  writeStage: (path: string, contents: string) => Promise<void>,
  serialized: string,
): Promise<DerivedFilePublicationEvidence> {
  await writeStage(publication.stagingPath, serialized);
  return await publication.verifyFile();
}
