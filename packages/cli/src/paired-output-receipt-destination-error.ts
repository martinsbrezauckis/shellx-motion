/**
 * Names the exact public member of a CLI output/receipt pair that could not be reserved.
 *
 * A final render has two independently no-clobber-protected names. Keeping the Core publication
 * code while identifying `media_output` versus `receipt_sidecar` lets a caller change the actual
 * conflicting path instead of being told that an otherwise-new media destination already exists.
 */
import { DerivedOutputPublicationError, type DerivedOutputPublicationErrorCode } from "@shellx-motion/core";

export type PairedOutputReceiptArtifact = "media_output" | "receipt_sidecar";

export class PairedOutputReceiptDestinationError extends Error {
  constructor(
    readonly code: DerivedOutputPublicationErrorCode,
    readonly artifact: PairedOutputReceiptArtifact,
    readonly path: string,
    readonly outputPath: string,
    readonly receiptPath: string,
    cause: DerivedOutputPublicationError
  ) {
    super(destinationMessage(code, artifact, path, cause.message), { cause });
    this.name = "PairedOutputReceiptDestinationError";
    Object.setPrototypeOf(this, PairedOutputReceiptDestinationError.prototype);
  }
}

/** Reclassify only Core's path-specific refusal; all other failures retain their original type. */
export function pairedOutputReceiptDestinationError(
  artifact: PairedOutputReceiptArtifact,
  outputPath: string,
  receiptPath: string,
  cause: unknown
): unknown {
  if (!(cause instanceof DerivedOutputPublicationError)) return cause;
  return new PairedOutputReceiptDestinationError(
    cause.code,
    artifact,
    cause.path,
    outputPath,
    receiptPath,
    cause
  );
}

export function isPairedOutputReceiptDestinationError(error: unknown): error is PairedOutputReceiptDestinationError {
  return error instanceof PairedOutputReceiptDestinationError;
}

/** Stable command-envelope vocabulary for a collision in either public pair member. */
export function pairedOutputReceiptDestinationErrorFields(error: PairedOutputReceiptDestinationError): {
  code: DerivedOutputPublicationErrorCode;
  message: string;
  artifact: PairedOutputReceiptArtifact;
  path: string;
} {
  return { code: error.code, message: error.message, artifact: error.artifact, path: error.path };
}

function destinationMessage(
  code: DerivedOutputPublicationErrorCode,
  artifact: PairedOutputReceiptArtifact,
  path: string,
  fallback: string
): string {
  const label = artifact === "media_output" ? "Render media output" : "Render receipt sidecar";
  if (code === "derived_output_exists") return `${label} already exists at ${path}; it was preserved rather than overwritten.`;
  if (code === "derived_output_busy") return `${label} is already being published at ${path}; wait for that publication to settle.`;
  return `${label} could not be reserved at ${path}: ${fallback}`;
}
