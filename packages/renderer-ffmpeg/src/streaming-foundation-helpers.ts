import {
  LocalMotionJobError,
  canonicalJson,
  type LocalMotionJobContext,
  type LocalMotionProcessContainmentEvidence,
  type LocalMotionRuntimeSandboxEvidence
} from "@shellx-motion/core";
import type { FfmpegCommand, FfmpegProcessResult } from "./index";
import { FFMPEG_TIMEOUT_EXIT_CODE, summarizeFfmpegDiagnostic } from "./ffmpeg-process-control";
import type {
  StreamingFfmpegFailureCode,
  StreamingFfmpegHandoffEvidence,
  StreamingProducerJobContext
} from "./streaming-foundation-types";

export type StreamingSuccessValue = {
  command: FfmpegCommand;
  output: FfmpegProcessResult;
  evidence: Omit<Extract<import("./streaming-foundation-types").StreamingFfmpegFinalResult, { ok: true }>["evidence"], "resources">;
};

export type StreamingGovernorValue =
  | { ok: true; value: StreamingSuccessValue }
  | { ok: false; failure: StreamingFailure; handoff: StreamingFfmpegHandoffEvidence };

export interface StreamingEvidenceReporter {
  reportProcessContainment(evidence: LocalMotionProcessContainmentEvidence): void;
  reportSandbox(evidence: LocalMotionRuntimeSandboxEvidence): void;
}

export class StreamingFailure extends Error {
  constructor(
    readonly code: Exclude<StreamingFfmpegFailureCode, import("@shellx-motion/core").LocalMotionJobErrorCode>,
    message: string,
    readonly process?: { exitCode: number; timedOut: boolean }
  ) {
    super(summarizeFfmpegDiagnostic(message));
    this.name = "StreamingFailure";
  }
}

export function encoderFailure(result: FfmpegProcessResult): StreamingFailure {
  const message = summarizeFfmpegDiagnostic(result.stderr) || `Streaming FFmpeg exited with code ${result.exitCode}.`;
  return new StreamingFailure("encoder_failed", message, {
    exitCode: result.exitCode,
    timedOut: result.exitCode === FFMPEG_TIMEOUT_EXIT_CODE
  });
}

export function asStreamingFailure(error: unknown): StreamingFailure {
  return error instanceof StreamingFailure
    ? error
    : new StreamingFailure("producer_failed", toError(error).message);
}

/** Bounded and redacted even for producer-originated Error messages. */
export function safeStreamingFailureMessage(error: unknown): string {
  return summarizeFfmpegDiagnostic(toError(error).message);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function normalizedStreamingCancellation(signal: AbortSignal | undefined): { signal: AbortSignal | undefined; cleanup(): void } {
  if (!signal) return { signal: undefined, cleanup() {} };
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason instanceof LocalMotionJobError
    ? signal.reason
    : new LocalMotionJobError("job_cancelled", "Streaming FFmpeg job was cancelled."));
  signal.addEventListener("abort", relay, { once: true });
  if (signal.aborted) relay();
  return { signal: controller.signal, cleanup: () => signal.removeEventListener("abort", relay) };
}

export function streamingProducerJobContext(
  job: LocalMotionJobContext,
  signal: AbortSignal,
  evidenceReporter: StreamingEvidenceReporter,
  maxProcessTreeRssBytes?: number
): StreamingProducerJobContext {
  return {
    admission: "pre-acquired",
    jobId: job.jobId,
    scratchRoot: job.scratchRoot,
    ...(maxProcessTreeRssBytes === undefined ? {} : { maxProcessTreeRssBytes }),
    signal,
    watchProcess: (pid) => job.watchProcess(pid),
    reportSandbox: evidenceReporter.reportSandbox
  };
}

export function createStreamingEvidenceReporter(job: LocalMotionJobContext): StreamingEvidenceReporter {
  let containment: LocalMotionProcessContainmentEvidence | undefined;
  let sandbox: LocalMotionRuntimeSandboxEvidence | undefined;
  return {
    reportProcessContainment(evidence) {
      if (!containment) {
        containment = evidence;
        job.reportProcessContainment(evidence);
        return;
      }
      if (!sameEvidence(containment, evidence)) {
        throw new StreamingFailure("streaming_evidence_conflict", "Streaming FFmpeg attempts reported conflicting process-containment evidence.");
      }
    },
    reportSandbox(evidence) {
      if (!sandbox) {
        sandbox = evidence;
        job.reportSandbox(evidence);
        return;
      }
      if (!sameEvidence(sandbox, evidence)) {
        throw new StreamingFailure("streaming_evidence_conflict", "Streaming producer attempts reported conflicting runtime-sandbox evidence.");
      }
    }
  };
}

function sameEvidence(left: object, right: object): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
