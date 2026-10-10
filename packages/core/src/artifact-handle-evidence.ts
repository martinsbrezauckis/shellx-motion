/** Closed, path-free artifact identity for job evidence. */
import {
  validateAttestedArtifactHandle,
  type AttestedArtifactHandle,
} from "./artifact-handle";

/** The complete artifact identity shape retained by MotionJobEvidenceArtifact. */
export interface AttestedArtifactHandleEvidence {
  readonly schema: "shellx-motion/artifact-handle@1";
  readonly id: string;
  readonly operationHash: string;
  readonly sha256: string;
}

/** Project a fully validated descriptor to the closed, path-free job-evidence identity. */
export function projectAttestedArtifactHandleEvidence(handle: AttestedArtifactHandle): AttestedArtifactHandleEvidence {
  validateAttestedArtifactHandle(handle);
  return Object.freeze({
    schema: "shellx-motion/artifact-handle@1" as const,
    id: handle.id,
    operationHash: handle.operationHash,
    sha256: handle.sha256,
  });
}
