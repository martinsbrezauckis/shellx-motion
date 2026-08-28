import type { PublicationCommitUncertainEvidence } from "@shellx-motion/core";

/**
 * A receipt-first pair can become uncertain at three distinct public phases.  Only the final
 * output phase is a possibly-delivered primary artifact; receipt and secondary phases preserve
 * evidence without falsely claiming that the primary became public.
 */
export class PairedOutputReceiptCommitUncertainError extends Error {
  readonly code = "paired_output_commit_uncertain";
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly phase: "receipt" | "secondary" | "output";
  readonly publicPaths: readonly string[];
  readonly expectedPublications: readonly PublicationCommitUncertainEvidence[];

  constructor(input: {
    outputPath: string;
    receiptPath: string;
    phase: "receipt" | "secondary" | "output";
    publicPaths: readonly string[];
    expectedPublications?: readonly PublicationCommitUncertainEvidence[];
    cause: unknown;
  }) {
    super(`${input.phase === "output" ? "Output" : input.phase === "receipt" ? "Receipt" : "Secondary evidence"} publication may have committed; inspect the reported public evidence before retrying.`, { cause: input.cause });
    this.name = "PairedOutputReceiptCommitUncertainError";
    this.outputPath = input.outputPath;
    this.receiptPath = input.receiptPath;
    this.phase = input.phase;
    this.publicPaths = Object.freeze([...new Set(input.publicPaths)]);
    this.expectedPublications = Object.freeze([...(input.expectedPublications ?? [])]);
  }
}
