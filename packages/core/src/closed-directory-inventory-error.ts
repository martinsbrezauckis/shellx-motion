import { DerivedOutputPublicationError } from "./derived-output-publication-types";

/** A topology or identity change means pathname-recursive cleanup is no longer safe. */
export class ClosedDirectoryInventoryAmbiguityError extends DerivedOutputPublicationError {
  readonly cleanupUnsafe = true;

  constructor(message: string, path: string) {
    super("derived_output_stage_invalid", message, path);
    this.name = "ClosedDirectoryInventoryAmbiguityError";
    Object.setPrototypeOf(this, ClosedDirectoryInventoryAmbiguityError.prototype);
  }
}

export function isClosedDirectoryInventoryAmbiguity(error: unknown): error is ClosedDirectoryInventoryAmbiguityError {
  return error instanceof ClosedDirectoryInventoryAmbiguityError;
}
