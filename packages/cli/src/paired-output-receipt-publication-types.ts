import type { DerivedOutputPublication } from "@shellx-motion/core";
import type { PairedArtifactSpec } from "./paired-output-receipt-binding.js";

export type PairedOutputArtifactSpec = PairedArtifactSpec;

/** Public acquisition and deterministic test seams for a receipt-bound file pair. */
export interface PairedOutputReceiptPublicationOptions {
  outputPath: string;
  receiptPath: string;
  outputArtifact: PairedOutputArtifactSpec;
  receiptArtifact: PairedOutputArtifactSpec;
  forceOutput?: boolean;
  forceReceipt?: boolean;
  faults?: {
    afterReceiptPreflight?: () => Promise<void> | void;
    afterReceiptStaged?: () => Promise<void> | void;
    beforeReceiptCommit?: () => Promise<void> | void;
    afterReceiptCommitted?: () => Promise<void> | void;
    beforeOutputCommit?: () => Promise<void> | void;
    afterOutputCommitAttempt?: () => Promise<void> | void;
  };
  /** Internal deterministic-test hooks. CLI production never supplies these. */
  testHooks?: {
    acquirePublication?: (input: { outputPath: string; kind: "file"; force: boolean }) => Promise<DerivedOutputPublication>;
    writeReceiptStage?: (path: string, contents: string) => Promise<void>;
    copySecondaryStage?: (source: string, destination: string) => Promise<void>;
    inspectSecondaryStage?: (path: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  };
}

/** Renderer-produced evidence that must become public before its receipt-bound primary output. */
export interface PairedSecondaryArtifactInput {
  stagedPath: string;
  outputPath: string;
  artifact: PairedOutputArtifactSpec;
  inputHashKey: string;
}
