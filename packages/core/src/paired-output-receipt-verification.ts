/**
 * Reader-side acceptance for the receipt-first CLI delivery contract.
 *
 * A pair cannot make two independently named files physically atomic. A marked receipt may
 * therefore survive a crash before its final output link, but it must never be presented as a
 * completed render unless its public primary and every marked secondary evidence file still match
 * the receipt. Unmarked historical receipts deliberately retain their existing reader semantics.
 */
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hashFile } from "./receipts";
import type { OperationReceipt } from "./types";

const PAIRED_OUTPUT_RECEIPT_SCHEMA = "shellx-motion/paired-output-receipt@1";

export function isPairedOutputReceipt(receiptPath: string, receipt: OperationReceipt): boolean {
  const output = plainRecord(receipt.output);
  const marker = plainRecord(output?.pairedOutputReceiptPublication);
  return marker?.schema === PAIRED_OUTPUT_RECEIPT_SCHEMA
    && typeof marker.receiptPath === "string"
    && resolve(marker.receiptPath) === resolve(receiptPath);
}

/** Reject a marked receipt-only crash state; no-op for every legacy/unpaired receipt. */
export async function verifyPairedReceiptOutputIfMarked(receiptPath: string, receipt: OperationReceipt): Promise<void> {
  if (!hasPairedOutputReceiptMarker(receipt)) return;
  if (!isPairedOutputReceipt(receiptPath, receipt)) throw new Error("Paired receipt marker is not the exact supported version/path binding.");
  await verifyPairedReceiptOutput(receiptPath, receipt);
}

/** Verify a receipt explicitly claimed as a paired CLI delivery. */
export async function verifyPairedReceiptOutput(receiptPath: string, receipt: OperationReceipt): Promise<void> {
  const { outputPath, sha256, secondaryArtifactHashes } = assertPairedReceiptAcceptance(receiptPath, receipt);
  if (await hashRegularFile(outputPath) !== sha256) throw new Error("Paired receipt output SHA-256 does not match the public artifact.");
  await Promise.all(Object.entries(secondaryArtifactHashes).map(async ([path, expected]) => {
    if (await hashRegularFile(path) !== expected) throw new Error("Paired receipt secondary artifact SHA-256 does not match the public evidence.");
  }));
}

/** Pure paired-delivery shape check; callers additionally hash the returned public paths. */
export function assertPairedReceiptAcceptance(receiptPath: string, receipt: OperationReceipt): {
  outputPath: string;
  sha256: string;
  secondaryArtifactHashes: Record<string, string>;
} {
  if (!isPairedOutputReceipt(receiptPath, receipt)) throw new Error("Receipt is not marked as a paired CLI delivery.");
  const output = plainRecord(receipt.output);
  const outputPath = typeof output?.path === "string" ? resolve(output.path) : undefined;
  const sha256 = typeof output?.sha256 === "string" ? output.sha256 : undefined;
  if (!outputPath || !/^[a-f0-9]{64}$/.test(sha256 ?? "")) throw new Error("Paired receipt does not bind a final output path and SHA-256.");
  if (dirname(outputPath) !== dirname(resolve(receiptPath))) throw new Error("Paired receipt output must share the receipt's governed parent directory.");
  const artifacts = receipt.artifacts ?? [];
  if (!artifacts.some((artifact) => resolve(artifact.path) === resolve(receiptPath) && artifact.status === "available" && (artifact.role === "preview_receipt" || artifact.role === "render_receipt"))) {
    throw new Error("Paired receipt does not self-identify its public receipt artifact.");
  }
  if (!artifacts.some((artifact) => resolve(artifact.path) === outputPath && artifact.status === "available" && (artifact.role === "preview_frame" || artifact.role === "still_frame" || artifact.role === "rendered_media"))) {
    throw new Error("Paired receipt does not identify its public output artifact.");
  }
  const pairedSecondaryArtifactHashes = plainRecord(output!.pairedSecondaryArtifactHashes) ?? {};
  for (const [path, expected] of Object.entries(pairedSecondaryArtifactHashes)) {
    if (dirname(resolve(path)) !== dirname(outputPath) || !/^[a-f0-9]{64}$/.test(String(expected)) || !artifacts.some((artifact) => resolve(artifact.path) === resolve(path) && artifact.status === "available")) {
      throw new Error("Paired receipt secondary artifact binding is invalid.");
    }
  }
  return { outputPath, sha256: sha256!, secondaryArtifactHashes: pairedSecondaryArtifactHashes as Record<string, string> };
}

export function markPairedOutputReceipt(receipt: OperationReceipt, receiptPath: string): void {
  const output = plainRecord(receipt.output);
  if (!output) throw new Error("Receipt output is required before marking paired delivery.");
  receipt.output = {
    ...output,
    pairedOutputReceiptPublication: { schema: PAIRED_OUTPUT_RECEIPT_SCHEMA, receiptPath: resolve(receiptPath) }
  };
}

function hasPairedOutputReceiptMarker(receipt: OperationReceipt): boolean {
  const output = plainRecord(receipt.output);
  return output !== undefined && Object.hasOwn(output, "pairedOutputReceiptPublication");
}

async function hashRegularFile(path: string): Promise<string> {
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("Paired receipt artifact must remain a regular non-symlink file.");
  return await hashFile(path);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
