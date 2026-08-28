import { isPublicationCommitUncertain } from "@shellx-motion/core";
import type { PairedOutputReceiptCommitUncertainError } from "./paired-output-receipt-commit-uncertainty.js";

export function pairedPublicationUncertaintyFields(
  error: PairedOutputReceiptCommitUncertainError,
  primaryFlag: "renderCommitUncertain" | "previewCommitUncertain"
): Record<string, unknown> {
  const evidence = {
    publicationCommitPhase: error.phase,
    publicPaths: [...error.publicPaths],
    ...(error.expectedPublications.length > 0 ? { expectedPublications: error.expectedPublications } : {})
  };
  return error.phase === "output"
    ? { [primaryFlag]: true, outputPath: error.outputPath, receiptPath: error.receiptPath, ...evidence }
    : { possiblyCommitted: true, ...evidence };
}

export function pairedPublicationUncertaintyError(error: PairedOutputReceiptCommitUncertainError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    publicationCommitPhase: error.phase,
    publicPaths: [...error.publicPaths],
    ...(error.expectedPublications.length > 0 ? { expectedPublications: error.expectedPublications } : {})
  };
}

/** Core evidence for non-render package/archive/review publications. */
export function corePublicationUncertaintyFields(error: unknown): Record<string, unknown> | undefined {
  if (!isPublicationCommitUncertain(error)) return undefined;
  const expectedPublications = [error.evidence];
  return {
    possiblyCommitted: true,
    publicPaths: [error.evidence.publicPath],
    expectedPublications,
    error: {
      code: error.code,
      message: error.message,
      publicationCommitPhase: "output",
      publicPaths: [error.evidence.publicPath],
      expectedPublications
    }
  };
}
