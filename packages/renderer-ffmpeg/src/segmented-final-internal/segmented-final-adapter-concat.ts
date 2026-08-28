/** Actual ordered final-delivery attempts over one already-verified concat list. */
import { LocalMotionJobError, type LocalMotionJobContext } from "@shellx-motion/core";
import type { StreamingFinalPolicyAttempt } from "../streaming-final-encode-policy-types.js";
import type { StreamingEvidenceReporter } from "../streaming-foundation-helpers.js";
import type { StreamingEncodeAttemptOutcome } from "../streaming-foundation-types.js";
import type { StreamingFfmpegProcessFactory } from "../streaming-process.js";
import { partialOutput, removeUnpublishedStage } from "./segmented-final-adapter-store.js";
import type { FfmpegProcessResult } from "../index.js";

export interface SegmentedConcatAttemptsResult {
  attempts: StreamingEncodeAttemptOutcome[];
  output?: FfmpegProcessResult;
  cleanupCauses: unknown[];
  partial?: Awaited<ReturnType<typeof partialOutput>>;
  stagingCleanup: "not_started" | "missing" | "removed" | "retained";
  primaryCause?: unknown;
}

/** A hardware failure may retry only the policy-prepared software attempt over the same list. */
export async function runSegmentedConcatAttempts(
  attempts: readonly StreamingFinalPolicyAttempt[],
  stagingPath: string,
  job: LocalMotionJobContext,
  factory: StreamingFfmpegProcessFactory,
  reporter: StreamingEvidenceReporter,
  onLocalJobError: (details: {
    attempts: StreamingEncodeAttemptOutcome[];
    partial: Awaited<ReturnType<typeof partialOutput>>;
    stagingCleanup: SegmentedConcatAttemptsResult["stagingCleanup"];
    cleanupCauses: unknown[];
  }) => void
): Promise<SegmentedConcatAttemptsResult> {
  const outcomes: StreamingEncodeAttemptOutcome[] = [];
  const cleanupCauses: unknown[] = [];
  let stagingCleanup: SegmentedConcatAttemptsResult["stagingCleanup"] = "not_started";

  for (const [index, attempt] of attempts.entries()) {
    let output: FfmpegProcessResult | undefined;
    let attemptCause: unknown;
    try {
      const process = await factory({
        command: attempt.command,
        signal: job.signal,
        watchProcess: job.watchProcess,
        reportProcessContainment: reporter.reportProcessContainment
      });
      output = await process.end();
    } catch (error) {
      if (error instanceof LocalMotionJobError) {
        outcomes.push({
          source: attempt.source,
          ...(attempt.encoder ? { encoder: attempt.encoder } : {}),
          outcome: "failed",
          failure: {
            code: error.code,
            message: "Segmented final FFmpeg concat attempt was interrupted by the admitted job."
          }
        });
        const partial = await partialOutput(stagingPath);
        const cleanup = await removeUnpublishedStage(stagingPath);
        stagingCleanup = cleanup.outcome;
        if (cleanup.cause !== undefined) cleanupCauses.push(cleanup.cause);
        onLocalJobError({
          attempts: [...outcomes],
          partial,
          stagingCleanup,
          cleanupCauses: [...cleanupCauses]
        });
        throw error;
      }
      attemptCause = error;
    }

    if (output?.exitCode === 0) {
      return {
        attempts: [
          ...outcomes,
          {
            source: attempt.source,
            ...(attempt.encoder ? { encoder: attempt.encoder } : {}),
            outcome: "succeeded"
          }
        ],
        output,
        cleanupCauses,
        stagingCleanup
      };
    }

    outcomes.push({
      source: attempt.source,
      ...(attempt.encoder ? { encoder: attempt.encoder } : {}),
      outcome: "failed",
      failure: {
        code: "encoder_failed",
        message: "Segmented final FFmpeg concat attempt failed.",
        ...(output ? { process: { exitCode: output.exitCode, timedOut: false } } : {})
      }
    });

    const partial = await partialOutput(stagingPath);
    const nextIsPreparedSoftware = attempt.source === "hardware" && attempts[index + 1]?.source === "software";
    const cleanup = await removeUnpublishedStage(stagingPath);
    stagingCleanup = cleanup.outcome;
    if (cleanup.cause !== undefined) cleanupCauses.push(cleanup.cause);

    // A retained/hostile staging path is never reused: FFmpeg could overwrite or follow it.
    if (cleanup.outcome === "retained") {
      return { attempts: outcomes, cleanupCauses, partial, stagingCleanup, primaryCause: attemptCause };
    }
    if (!nextIsPreparedSoftware) {
      return { attempts: outcomes, cleanupCauses, partial, stagingCleanup, primaryCause: attemptCause };
    }
  }

  return {
    attempts: outcomes,
    cleanupCauses,
    partial: await partialOutput(stagingPath),
    stagingCleanup
  };
}
