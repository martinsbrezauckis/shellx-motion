/** Compatibility facade: the paired-publication owner ships only from Core's closed internal subpath. */
export {
  assertPairedReceiptAcceptance,
  isPairedOutputReceiptDestinationError,
  pairedOutputReceiptDestinationErrorFields,
  PairedOutputReceiptCommitUncertainError,
  PairedOutputReceiptDestinationError,
  PairedOutputReceiptPublication,
  verifyPairedReceiptOutput
} from "@shellx-motion/core/internal/paired-output-receipt-publication";
export type {
  PairedOutputReceiptArtifact,
  PairedOutputReceiptPublicationOptions,
  PairedSecondaryArtifactInput
} from "@shellx-motion/core/internal/paired-output-receipt-publication";
