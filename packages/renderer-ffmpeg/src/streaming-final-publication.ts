import { createRenderReceipt, isPublicationCommitUncertain, type PublicationCommitUncertainEvidence } from "@shellx-motion/core";
import type { RenderStreamingFinalResult } from "./streaming-final-adapter-types.js";

export function streamingPublicationFailure(error: unknown): {
  code: string;
  message: string;
  possiblyCommitted?: true;
  publicPaths?: readonly string[];
  expectedPublication?: PublicationCommitUncertainEvidence;
} {
  if (isPublicationCommitUncertain(error)) {
    return {
      code: error.code,
      message: error.message,
      possiblyCommitted: true,
      publicPaths: [error.evidence.publicPath],
      expectedPublication: error.evidence
    };
  }
  return { code: (error as { code?: string }).code ?? "derived_output_publish_failed", message: error instanceof Error ? error.message : String(error) };
}

export function remapStreamingReceiptOutput(
  receipt: ReturnType<typeof createRenderReceipt>,
  stagingPath: string,
  outputPath: string
) {
  const output = receipt.output && typeof receipt.output === "object"
    ? { ...(receipt.output as Record<string, unknown>), path: outputPath }
    : receipt.output;
  return {
    ...receipt,
    output,
    artifacts: receipt.artifacts?.map((artifact) => artifact.path === stagingPath ? { ...artifact, path: outputPath } : artifact)
  };
}

export function redactAbortedStreamingOutput(result: Extract<RenderStreamingFinalResult, { ok: false }>): RenderStreamingFinalResult {
  const { partialOutput: _discardedPartialOutput, ...error } = result.error;
  return { ...result, error };
}
