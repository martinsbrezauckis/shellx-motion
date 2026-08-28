import type { OperationReceipt } from "@shellx-motion/core";

/**
 * Replace output evidence for a publication stage that the caller must abort and delete.
 *
 * An encode can have produced a hashable stage before a mandatory final gate rejects it. Once the
 * publication transaction deletes that stage, its old path, hash, and primary delivery artifact are
 * no longer truthful receipt evidence. Keep only a path-free failure statement; callers may append
 * non-file transport facts after this function returns.
 */
export function redactAbortedFinalOutputEvidence(
  receipt: OperationReceipt,
  failure: { code: string; message: string }
): OperationReceipt {
  const previousOutput = receipt.output;
  const stagingPath = typeof previousOutput === "object" && previousOutput !== null && !Array.isArray(previousOutput)
    && typeof (previousOutput as Record<string, unknown>).path === "string"
    ? (previousOutput as Record<string, unknown>).path as string
    : undefined;
  receipt.status = "failed";
  receipt.output = {
    publication: "aborted",
    failure: { code: failure.code, message: failure.message }
  };
  receipt.artifacts = receipt.artifacts?.filter((artifact) => artifact.role !== "rendered_media"
    && artifact.role !== "browser_capture_html"
    && !(artifact.role === "still_frame" && artifact.primary)
    && artifact.path !== stagingPath);
  // Still receipts carry their delivered-file hash under inputHashes.frame. It stops being true
  // once a mandatory quality gate aborts and removes that file; source and quality hashes remain.
  if (receipt.lane === "image" && receipt.inputHashes.frame !== undefined) {
    const { frame: _abortedStillFrameHash, ...inputHashes } = receipt.inputHashes;
    receipt.inputHashes = inputHashes;
  }
  // Browser capture HTML is a private companion artifact owned by the same publication.
  // Its digest cannot remain attested after the publication transaction removes that companion.
  if (receipt.inputHashes["browser-capture-html"] !== undefined) {
    const { "browser-capture-html": _abortedBrowserCaptureHash, ...inputHashes } = receipt.inputHashes;
    receipt.inputHashes = inputHashes;
  }
  return receipt;
}
