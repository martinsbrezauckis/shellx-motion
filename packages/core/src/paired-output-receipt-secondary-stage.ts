/** Private secondary-artifact staging for paired receipt publication. */
import { resolve, dirname } from "node:path";
import { type DerivedFilePublicationEvidence, type DerivedOutputPublication } from "./derived-output-publication";
import { assertPrivateSecondarySource, type BoundSecondaryArtifact, type PairedSecondaryArtifactInput } from "./paired-output-receipt-publication-support";
import type { ReceiptArtifact } from "./types";

export type StagedSecondaryArtifact = BoundSecondaryArtifact & { publication: DerivedOutputPublication };

export async function stagePairedSecondaryArtifact(input: PairedSecondaryArtifactInput, context: {
  outputPath: string;
  receiptPath: string;
  primaryStagePath: string;
  existingPaths: readonly string[];
  inspect(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  acquire(input: { outputPath: string; kind: "file"; force: boolean }): Promise<DerivedOutputPublication>;
  copy(source: string, destination: string): Promise<void>;
}): Promise<StagedSecondaryArtifact> {
  const outputPath = resolve(input.outputPath);
  if (outputPath === context.outputPath || outputPath === context.receiptPath || dirname(outputPath) !== dirname(context.outputPath) || context.existingPaths.includes(outputPath)) {
    throw new Error("Paired secondary artifact destination must be distinct from every paired publication name.");
  }
  let publication: DerivedOutputPublication | undefined;
  try {
    assertPrivateSecondarySource(input.stagedPath, context.primaryStagePath);
    const sourceFacts = await context.inspect(resolve(input.stagedPath));
    if (!sourceFacts.isFile() || sourceFacts.isSymbolicLink()) throw new Error("Paired secondary artifact must be a regular non-symlink private stage file.");
    publication = await context.acquire({ outputPath, kind: "file", force: false });
    await context.copy(resolve(input.stagedPath), publication.stagingPath);
    const evidence: DerivedFilePublicationEvidence = await publication.verifyFile();
    const artifact: ReceiptArtifact = { role: input.artifact.role, path: outputPath, status: "available", ...(input.artifact.mediaType ? { mediaType: input.artifact.mediaType } : {}), ...(input.artifact.primary === undefined ? {} : { primary: input.artifact.primary }) };
    return { publication, evidence, artifact, inputHashKey: input.inputHashKey };
  } catch (error) {
    await publication?.abort().catch(() => undefined);
    throw error;
  }
}
