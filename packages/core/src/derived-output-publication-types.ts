/** Public contracts for identity-bound final-output publication. */
export type DerivedOutputKind = "file" | "directory";

export type DerivedOutputPublicationErrorCode =
  | "derived_output_busy"
  | "derived_output_exists"
  | "derived_output_unsafe_parent"
  | "derived_output_stage_invalid"
  | "derived_output_publish_failed";

export class DerivedOutputPublicationError extends Error {
  constructor(readonly code: DerivedOutputPublicationErrorCode, message: string, readonly path: string) {
    super(message);
    this.name = "DerivedOutputPublicationError";
    Object.setPrototypeOf(this, DerivedOutputPublicationError.prototype);
  }
}

export interface DerivedOutputPublicationInput {
  outputPath: string;
  kind: DerivedOutputKind;
  /**
   * Explicit overwrite intent. File force may remove the admitted previous file before the final
   * link attempt; a later failure never restores that previous public pathname. Directory force
   * remains unavailable; `replaceEmptyDirectory` is the narrower empty-placeholder transaction.
   */
  force?: boolean;
  /**
   * Admit an existing empty directory as a caller-owned placeholder. The exact directory is moved
   * into the private reservation only at the final publication boundary and restored on every
   * pre-rename failure. Non-empty directories, files, and symbolic links remain refusals.
   */
  replaceEmptyDirectory?: boolean;
}

export interface DerivedFilePublicationEvidence {
  sha256: string;
  byteLength: number;
}

export interface DerivedDirectoryPublicationEvidence {
  sha256: string;
  entryCount: number;
}
