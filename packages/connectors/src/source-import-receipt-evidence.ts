import { dirname, join, resolve } from "node:path";
import { BoundedResourceBudget, readBudgetedStableFile } from "@shellx-motion/core";

export interface SourceImportReceiptEvidence {
  path: string;
  sha256: string;
  byteLength: number;
}

/** Read and bind the optional source-import receipt to the exact Markdown snapshot. */
export async function readSourceImportReceiptEvidence(input: {
  sourcePath: string;
  sourceInputRoot: string;
  sourceMarkdownHash: string;
  budget: BoundedResourceBudget;
}): Promise<SourceImportReceiptEvidence | undefined> {
  const sourcePath = resolve(input.sourcePath);
  const receiptPath = join(dirname(sourcePath), "receipts", "source-import.receipt.json");
  let snapshot;
  try {
    snapshot = await readBudgetedStableFile(receiptPath, {
      label: "Source import receipt",
      budget: input.budget,
      withinRoot: resolve(input.sourceInputRoot)
    });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new Error("Adjacent source import receipt must contain valid JSON.");
  }
  const receipt = recordValue(parsed);
  const inputHashes = recordValue(receipt?.inputHashes);
  const output = recordValue(receipt?.output);
  if (!receipt
    || receipt.schema !== "shellx-motion/receipt@1"
    || receipt.operation !== "source.import"
    || receipt.status !== "passed"
    || receipt.packageId !== "source_import"
    || inputHashes?.source !== input.sourceMarkdownHash
    || output?.sourceHash !== input.sourceMarkdownHash
    || typeof output.markdownPath !== "string"
    || resolve(output.markdownPath) !== sourcePath) {
    throw new Error("Adjacent source import receipt does not attest these exact source Markdown bytes.");
  }
  return { path: receiptPath, sha256: snapshot.sha256, byteLength: snapshot.byteLength };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
