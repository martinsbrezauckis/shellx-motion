/** Translate paired-delivery reservation failures without losing the collided public artifact. */
import {
  isPairedOutputReceiptDestinationError,
  pairedOutputReceiptDestinationErrorFields
} from "./paired-output-receipt-publication.js";

export function renderPairedPublicationFailure(error: unknown): Record<string, unknown> {
  return isPairedOutputReceiptDestinationError(error)
    ? pairedOutputReceiptDestinationErrorFields(error)
    : {
        code: (error as { code?: string }).code ?? "derived_output_publish_failed",
        message: error instanceof Error ? error.message : String(error)
      };
}
