import { isPublicationCommitUncertain, type PublicationCommitUncertainEvidence } from "@shellx-motion/core";

export interface GpuPreviewPublicationUncertainty {
  readonly code: "publication_commit_uncertain";
  readonly message: string;
  readonly possiblyCommitted: true;
  readonly publicPaths: readonly string[];
  readonly expectedPublications: readonly PublicationCommitUncertainEvidence[];
}

/** Keep a Core post-link failure intact at the direct public GPU renderer boundary. */
export function gpuPreviewPublicationUncertainty(error: unknown): GpuPreviewPublicationUncertainty | undefined {
  if (!isPublicationCommitUncertain(error)) return undefined;
  return {
    code: error.code,
    message: error.message,
    possiblyCommitted: true,
    publicPaths: [error.evidence.publicPath],
    expectedPublications: [error.evidence]
  };
}
