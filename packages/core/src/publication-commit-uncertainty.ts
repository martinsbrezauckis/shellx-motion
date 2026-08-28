/**
 * Evidence for a publication whose final link or rename was attempted but could not be observed
 * to completion. Callers must never present this as a rolled-back output: the public pathname may
 * already name the admitted artifact, or a competing writer may have changed it after publication.
 */
import type { OutputPathIdentity } from "./output-path-topology";

export type PublicationCommitKind = "file" | "directory";

export interface PublicationCommitFileEvidence {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface PublicationCommitDirectoryEvidence {
  readonly sha256: string;
  readonly entryCount: number;
  /** Closed, normalized relative regular-file inventory admitted before the rename attempt. */
  readonly entries: readonly string[];
  /** Present only when a caller supplied Core's exact content-addressed closed-tree inventory. */
  readonly inventory?: readonly Readonly<{ path: string; sha256: string; byteLength: number }>[];
}

interface PublicationCommitUncertainEvidenceBase {
  /** Canonical public output pathname. Private stage and reservation paths are never exposed. */
  readonly publicPath: string;
  /** Identity of the verified private artifact immediately before the final operation. */
  readonly expectedIdentity: OutputPathIdentity;
}

/** `kind` and `expected` are intentionally correlated so reconciliation cannot mistake a tree for a file. */
export type PublicationCommitUncertainEvidence =
  | (PublicationCommitUncertainEvidenceBase & {
      readonly kind: "file";
      readonly expected: PublicationCommitFileEvidence;
    })
  | (PublicationCommitUncertainEvidenceBase & {
      readonly kind: "directory";
      readonly expected: PublicationCommitDirectoryEvidence;
    });

/**
 * The final link or rename was attempted, but a later operation failed. `evidence` identifies the
 * exact public target and artifact that may have been committed; it is observation, not a rollback
 * capability. Recovery must inspect that public path with independent authority.
 */
export class PublicationCommitUncertainError extends Error {
  readonly code = "publication_commit_uncertain" as const;
  readonly evidence: PublicationCommitUncertainEvidence;

  constructor(evidence: PublicationCommitUncertainEvidence, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Publication may have committed at ${evidence.publicPath}; final observation failed: ${reason}`, { cause });
    this.name = "PublicationCommitUncertainError";
    this.evidence = freezeEvidence(evidence);
    Object.setPrototypeOf(this, PublicationCommitUncertainError.prototype);
  }
}

export function isPublicationCommitUncertain(error: unknown): error is PublicationCommitUncertainError {
  return error instanceof PublicationCommitUncertainError;
}

function freezeEvidence(evidence: PublicationCommitUncertainEvidence): PublicationCommitUncertainEvidence {
  const expectedIdentity = Object.freeze({ ...evidence.expectedIdentity });
  if (evidence.kind === "file") {
    return Object.freeze({
      publicPath: evidence.publicPath,
      kind: "file" as const,
      expectedIdentity,
      expected: Object.freeze({ ...evidence.expected })
    });
  }
  return Object.freeze({
    publicPath: evidence.publicPath,
    kind: "directory" as const,
    expectedIdentity,
    expected: Object.freeze({
      ...evidence.expected,
      entries: Object.freeze([...evidence.expected.entries]),
      ...(evidence.expected.inventory ? { inventory: Object.freeze(evidence.expected.inventory.map((entry) => Object.freeze({ ...entry }))) } : {})
    })
  });
}
