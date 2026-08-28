import type { OperationReceipt } from "@shellx-motion/core";
import type { MotionDebugResult } from "../command-registry.js";
import { corePublicationUncertainty } from "../publication-uncertainty.js";

export function sourceAuthoringCommandFailure(code: string, error: unknown): MotionDebugResult {
  const uncertainty = corePublicationUncertainty(error);
  if (uncertainty) {
    return {
      ok: false,
      error: {
        code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "publication_commit_uncertain",
        message: error instanceof Error ? error.message : "Publication commit may have completed.",
        detail: uncertainty
      },
      result: uncertainty,
      warnings: []
    };
  }
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}

/** The local directory and in-bundle receipt were verified before this observer failed. */
export function sourceCommittedObserverFailure(
  code: "source_import_receipt_observer_failed" | "source_storyboard_receipt_observer_failed",
  error: unknown,
  input: {
    outputPath: string;
    receiptPath: string;
    receipt: OperationReceipt;
    artifacts: readonly unknown[];
    output: Record<string, unknown>;
  }
): MotionDebugResult {
  const detail = {
    sourceCommitted: true,
    publicPaths: [input.outputPath],
    receiptPath: input.receiptPath,
    receiptId: input.receipt.id,
    artifacts: input.artifacts
  };
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      detail
    },
    result: {
      sourceCommitted: true,
      outputPath: input.outputPath,
      publicPaths: [input.outputPath],
      receiptPath: input.receiptPath,
      receiptId: input.receipt.id,
      artifacts: input.artifacts,
      receipt: input.receipt,
      ...input.output
    },
    warnings: ["Source artifacts were committed locally, but the host receipt observer failed. Inspect the reported receipt before retrying."]
  };
}
