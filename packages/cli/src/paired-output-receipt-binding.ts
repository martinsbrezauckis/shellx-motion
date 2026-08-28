/** Receipt shape and private-evidence binding for paired CLI delivery publication. */
import { isAbsolute } from "node:path";
import { relative, resolve, sep } from "node:path";
import type { DerivedFilePublicationEvidence, OperationReceipt, ReceiptArtifact } from "@shellx-motion/core";

export type PairedArtifactSpec = {
  role: ReceiptArtifact["role"];
  mediaType?: ReceiptArtifact["mediaType"];
  primary?: ReceiptArtifact["primary"];
};

export type BoundSecondaryArtifact = {
  publication: { outputPath: string };
  evidence: DerivedFilePublicationEvidence;
  artifact: ReceiptArtifact;
  inputHashKey: string;
};

export function bindSecondaryArtifacts(receipt: OperationReceipt, secondaryArtifacts: readonly BoundSecondaryArtifact[]): void {
  if (secondaryArtifacts.length === 0) return;
  const output = plainRecord(receipt.output);
  if (!output) throw new Error("Receipt output is required before binding secondary artifacts.");
  const inputHashes = { ...receipt.inputHashes };
  const pairedSecondaryArtifactHashes: Record<string, string> = {};
  for (const secondary of secondaryArtifacts) {
    const expected = inputHashes[secondary.inputHashKey];
    if (expected !== undefined && expected !== secondary.evidence.sha256) {
      throw new Error(`Receipt input hash ${secondary.inputHashKey} does not match the verified secondary artifact.`);
    }
    inputHashes[secondary.inputHashKey] = secondary.evidence.sha256;
    pairedSecondaryArtifactHashes[secondary.publication.outputPath] = secondary.evidence.sha256;
  }
  receipt.inputHashes = inputHashes;
  receipt.output = { ...output, pairedSecondaryArtifactHashes };
  receipt.artifacts = dedupeArtifacts([...(receipt.artifacts ?? []), ...secondaryArtifacts.map((secondary) => secondary.artifact)]);
}

export function assertPrivateSecondarySource(candidate: string, primaryStagePath: string): void {
  const root = resolve(primaryStagePath, "..");
  const source = resolve(candidate);
  const relation = relative(root, source);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation) || source === resolve(primaryStagePath)) {
    throw new Error("Paired secondary artifact escaped the private primary-output stage root.");
  }
}

export function normalizeReceiptArtifacts(
  receipt: OperationReceipt,
  stagedOutputPath: string,
  outputPath: string,
  receiptPath: string,
  outputArtifact: PairedArtifactSpec,
  receiptArtifact: PairedArtifactSpec
): void {
  receipt.artifacts = dedupeArtifacts([
    ...(receipt.artifacts ?? []).map((artifact) => ({
      ...artifact,
      path: resolve(artifact.path) === resolve(stagedOutputPath) ? outputPath : artifact.path
    })),
    { role: outputArtifact.role, path: outputPath, status: "available" as const, ...(outputArtifact.mediaType ? { mediaType: outputArtifact.mediaType } : {}), ...(outputArtifact.primary === undefined ? { primary: true } : { primary: outputArtifact.primary }) },
    { role: receiptArtifact.role, path: receiptPath, status: "available" as const, ...(receiptArtifact.mediaType ? { mediaType: receiptArtifact.mediaType } : {}) }
  ]);
}

export function rebindReceiptOutput(
  receipt: OperationReceipt,
  stagedOutputPath: string,
  outputPath: string,
  evidence: DerivedFilePublicationEvidence
): void {
  const output = plainRecord(receipt.output);
  if (!output || output.sha256 !== evidence.sha256) {
    throw new Error("Renderer receipt does not bind the verified private output SHA-256.");
  }
  const receiptPath = typeof output.path === "string" ? resolve(output.path) : undefined;
  if (receiptPath !== resolve(stagedOutputPath) && receiptPath !== outputPath) {
    throw new Error("Renderer receipt output path does not match the governed private stage.");
  }
  receipt.output = { ...output, path: outputPath };
}

export function assertReceiptBindsOutput(receipt: OperationReceipt, outputPath: string, evidence: DerivedFilePublicationEvidence): void {
  const output = plainRecord(receipt.output);
  if (!output || resolve(String(output.path ?? "")) !== outputPath || output.sha256 !== evidence.sha256) {
    throw new Error("Receipt does not bind the verified final output path and SHA-256.");
  }
}

function dedupeArtifacts(artifacts: ReceiptArtifact[]): ReceiptArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.role}\0${resolve(artifact.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
