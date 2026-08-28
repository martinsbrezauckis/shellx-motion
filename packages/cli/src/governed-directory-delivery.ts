/** Honest result boundary for governed directory-bundle publication. */
import {
  isPublicationCommitUncertain,
  type DerivedDirectoryPublicationEvidence,
  type DerivedOutputPublication,
  type PublicationCommitUncertainEvidence
} from "@shellx-motion/core";

/**
 * `rename` can succeed before DerivedOutputPublication's post-rename inventory proof fails.
 * The public directory is retained in that case, so a caller must report an uncertain delivery.
 */
export class DirectoryBundleCommitUncertainError extends Error {
  readonly code = "directory_bundle_commit_uncertain";
  readonly outputPath: string;
  /** Core-authenticated identity of the directory rename which may have committed. */
  readonly expectedPublication: PublicationCommitUncertainEvidence;

  constructor(expectedPublication: PublicationCommitUncertainEvidence, cause: unknown) {
    super("Directory bundle publication may have committed; inspect its receipt before retrying.", { cause });
    this.name = "DirectoryBundleCommitUncertainError";
    this.outputPath = expectedPublication.publicPath;
    this.expectedPublication = expectedPublication;
  }
}

/** Verify the closed private inventory before the one potentially-public directory rename. */
export async function publishGovernedDirectoryBundle(
  publication: DerivedOutputPublication,
  inventory: readonly string[]
): Promise<DerivedDirectoryPublicationEvidence> {
  const evidence = await publication.verifyDirectory(inventory);
  try {
    await publication.publishDirectory(evidence, inventory);
  } catch (error) {
    // Only Core's authenticated post-rename uncertainty says a public directory may
    // exist. A normal publication refusal happened before the irreversible step.
    if (isPublicationCommitUncertain(error)) {
      throw new DirectoryBundleCommitUncertainError(error.evidence, error);
    }
    throw error;
  }
  return evidence;
}
