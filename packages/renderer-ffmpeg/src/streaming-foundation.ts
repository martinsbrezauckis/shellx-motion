import {
  LocalMotionJobError,
  defaultLocalMotionJobGovernor,
  streamingFrameQualityHashRetentionCapacity,
  streamingFrameQualityPolicyRefusal
} from "@shellx-motion/core";
import {
  startStreamingFfmpegProcess,
  type StreamingFfmpegProcess
} from "./streaming-process";
import {
  asStreamingFailure,
  createStreamingEvidenceReporter,
  normalizedStreamingCancellation,
  StreamingFailure,
  streamingProducerJobContext,
  safeStreamingFailureMessage,
  toError,
  type StreamingGovernorValue
} from "./streaming-foundation-helpers";
import {
  streamingAttemptPolicyError,
  streamingCommandError,
  streamingMaxPngBytes,
  streamingMaxRgbaBytes,
  streamingMetadataError
} from "./streaming-foundation-validation";
import { runStreamingAttempt } from "./streaming-attempt";
import type {
  StreamingEncodeAttempt,
  StreamingEncodeAttemptOutcome,
  StreamingFfmpegFinalInput,
  StreamingFfmpegHandoffEvidence,
  StreamingFfmpegFinalResult,
  StreamingFrameSink,
  StreamingProducerJobContext
} from "./streaming-foundation-types";
export type {
  StreamingEncodeAttempt,
  StreamingFfmpegFailureCode,
  StreamingFfmpegFinalInput,
  StreamingFfmpegFinalResult,
  StreamingFrameProducer,
  StreamingFrame,
  StreamingFrameFormat,
  StreamingFrameSink,
  StreamingProducerJobContext,
  StreamingFfmpegAdmittedPreparation,
  StreamingFfmpegAdmittedPreparationContext,
  StreamingQualityManifestBoundary
} from "./streaming-foundation-types";
export { image2PipeCommandFromImageSequence, rawVideoCommandFromImageSequence } from "./streaming-command-input.js";

/** Explicitly refuses the one current quality-manifest feature that needs retained source frames. */
export function streamingQualityManifestCapability(): {
  exactSourceComparison: { supported: false; code: "streaming_quality_boundary_unsupported"; message: string };
} {
  return {
    exactSourceComparison: {
      supported: false,
      code: "streaming_quality_boundary_unsupported",
      message: "Streaming final delivery cannot yet perform quality-manifest exact source-frame comparison without materializing source PNGs."
    }
  };
}

/**
 * Starts FFmpeg before production, delivers each PNG or raw RGBA frame with real stdin drain
 * backpressure, and retains no source frame in the encoder handoff after a write resolves. It cannot
 * attest to a renderer-owned cache. A hardware failure reruns the producer once for the declared
 * software attempt instead of caching a full sequence. This primitive deliberately
 * does not select/probe encoders, measure loudness, prepare audio arguments, read delivered colour,
 * or construct final receipts, artifacts, and input hashes; one later policy/receipt adapter owns
 * those product-facing concerns for every adoption surface.
 */
export async function runStreamingFfmpegFinal(input: StreamingFfmpegFinalInput): Promise<StreamingFfmpegFinalResult> {
  const boundary = streamingQualityManifestCapability();
  if (input.qualityManifest?.exactSourceComparison === "required") {
    return { ok: false, error: boundary.exactSourceComparison };
  }
  const metadataError = streamingMetadataError(input);
  if (metadataError) return { ok: false, error: metadataError };
  const qualityPolicyRefusal = streamingFrameQualityPolicyRefusal(input.quality);
  if (qualityPolicyRefusal) return { ok: false, error: qualityPolicyRefusal };
  if (!input.admittedPrepare) {
    if (!input.attempts?.length || !input.produce) {
      return { ok: false, error: { code: "streaming_metadata_invalid", message: "Streaming FFmpeg requires attempts and a producer before encoder admission." } };
    }
    const policyError = streamingAttemptPolicyError(input.attempts);
    if (policyError) return { ok: false, error: policyError };
    const commandError = input.attempts.map((attempt) => streamingCommandError(attempt.command, input)).find(Boolean);
    if (commandError) return { ok: false, error: commandError };
  }

  const governor = input.governor ?? defaultLocalMotionJobGovernor;
  const factory = input.processFactory ?? startStreamingFfmpegProcess;
  const cancellation = normalizedStreamingCancellation(input.signal);
  let latestHandoff: StreamingFfmpegHandoffEvidence | undefined;
  try {
    const execution = await governor.run({
      lane: "ffmpeg",
      operation: input.operation ?? "ffmpeg.streamed-final",
      scratchRoot: input.scratchRoot ?? (process.env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || ".scratch"),
      signal: cancellation.signal,
      ...(input.callerId ? { callerId: input.callerId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {})
    }, async (job): Promise<StreamingGovernorValue> => {
      const evidenceReporter = createStreamingEvidenceReporter(job);
      const admittedRunner = async (command: StreamingEncodeAttempt["command"]) => {
        const process = await factory({
          command,
          signal: job.signal,
          watchProcess: job.watchProcess,
          reportProcessContainment: evidenceReporter.reportProcessContainment,
          scratchRoot: job.scratchRoot,
          maxProcessTreeRssBytes: governor.policy.maxProcessTreeRssBytes
        });
        return await process.end();
      };
      const admitted = input.admittedPrepare
        ? await input.admittedPrepare({
            job: streamingProducerJobContext(job, job.signal, evidenceReporter, governor.policy.maxProcessTreeRssBytes),
            runner: admittedRunner
          })
        : { attempts: input.attempts!, produce: input.produce! };
      const admittedPolicyError = streamingAttemptPolicyError(admitted.attempts);
      if (admittedPolicyError) throw new StreamingFailure(admittedPolicyError.code, admittedPolicyError.message);
      const admittedCommandError = admitted.attempts.map((attempt) => streamingCommandError(attempt.command, input)).find(Boolean);
      if (admittedCommandError) throw new StreamingFailure(admittedCommandError.code, admittedCommandError.message);
      const executionInput: StreamingFfmpegFinalInput & { attempts: readonly StreamingEncodeAttempt[]; produce: NonNullable<StreamingFfmpegFinalInput["produce"]> } = {
        ...input,
        attempts: admitted.attempts,
        produce: admitted.produce
      };
      const startProcess = (attempt: StreamingEncodeAttempt) => factory({
        command: attempt.command,
        signal: job.signal,
        watchProcess: job.watchProcess,
        reportProcessContainment: evidenceReporter.reportProcessContainment,
        scratchRoot: job.scratchRoot,
        maxProcessTreeRssBytes: governor.policy.maxProcessTreeRssBytes
      });
      const attempts: StreamingEncodeAttemptOutcome[] = [];
      let observedMaxConcurrentProducerWrites = 0;
      let maxBufferedInputBytes = 0;
      let inputHighWaterMarkBytes = 0;
      let writes = 0;
      let drainWaits = 0;
      let lastFailure: StreamingFailure | undefined;

      for (const [attemptIndex, attempt] of executionInput.attempts.entries()) {
        try {
          let process: StreamingFfmpegProcess;
          try {
            process = await startProcess(attempt);
          } catch (error) {
            if (error instanceof LocalMotionJobError || error instanceof StreamingFailure) throw error;
            throw new StreamingFailure("encoder_failed", toError(error).message);
          }
          const completed = await runStreamingAttempt({
            input: executionInput,
            attempt,
            process,
            signal: job.signal,
            job,
            maxProcessTreeRssBytes: governor.policy.maxProcessTreeRssBytes,
            evidenceReporter,
            observe: (event) => {
              observedMaxConcurrentProducerWrites = Math.max(observedMaxConcurrentProducerWrites, event.concurrentProducerWrites);
              maxBufferedInputBytes = Math.max(maxBufferedInputBytes, event.bufferedInputBytes);
              inputHighWaterMarkBytes = Math.max(inputHighWaterMarkBytes, event.inputHighWaterMarkBytes);
              writes += event.writes;
              drainWaits += event.drainWaits;
            }
          });
          attempts.push({ source: attempt.source, ...(attempt.encoder ? { encoder: attempt.encoder } : {}), outcome: "succeeded" });
          return { ok: true, value: {
            command: attempt.command,
            output: completed.output,
            evidence: {
              delivery: "streamed" as const,
              frameFormat: executionInput.frameFormat ?? "png",
              maxConcurrentProducerWrites: 1 as const,
              observedMaxConcurrentProducerWrites,
              maxBufferedInputBytes,
              inputHighWaterMarkBytes,
              backpressure: { writes, drainWaits },
              maxFrameBytesPerFrame: streamingMaxFrameBytes(executionInput),
              ...streamingFrameLimitEvidence(executionInput),
              encoderHandoffSourceFramesRetained: 0 as const,
              qualityPlaneSetCapacity: 2 as const,
              uniqueHashCapacity: streamingFrameQualityHashRetentionCapacity(executionInput.quality),
              attempts,
              frameSequence: completed.frameSequence,
              quality: completed.quality
            }
          } };
        } catch (error) {
          if (error instanceof LocalMotionJobError) {
            attempts.push({
              source: attempt.source,
              ...(attempt.encoder ? { encoder: attempt.encoder } : {}),
              outcome: "failed",
              failure: { code: error.code, message: safeStreamingFailureMessage(error) }
            });
            latestHandoff = streamingHandoffEvidence({
              input: executionInput,
              attempts,
              observedMaxConcurrentProducerWrites,
              maxBufferedInputBytes,
              inputHighWaterMarkBytes,
              writes,
              drainWaits
            });
            throw error;
          }
          lastFailure = asStreamingFailure(error);
          attempts.push({
            source: attempt.source,
            ...(attempt.encoder ? { encoder: attempt.encoder } : {}),
            outcome: "failed",
            failure: {
              code: lastFailure.code,
              message: lastFailure.message,
              ...(lastFailure.process ? { process: lastFailure.process } : {})
            }
          });
          // The only retry is the existing hardware -> software rule. Every source frame is
          // produced again; no frame cache, request array, or browser result list is retained.
          if (attempt.source === "hardware" && attemptIndex + 1 < executionInput.attempts.length && lastFailure.code === "encoder_failed") {
            continue;
          }
          const handoff = streamingHandoffEvidence({
            input: executionInput,
            attempts,
            observedMaxConcurrentProducerWrites,
            maxBufferedInputBytes,
            inputHighWaterMarkBytes,
            writes,
            drainWaits
          });
          latestHandoff = handoff;
          return {
            ok: false,
            failure: lastFailure,
            handoff
          };
        }
      }
      const handoff = streamingHandoffEvidence({
        input: executionInput,
        attempts,
        observedMaxConcurrentProducerWrites,
        maxBufferedInputBytes,
        inputHighWaterMarkBytes,
        writes,
        drainWaits
      });
      latestHandoff = handoff;
      return {
        ok: false,
        failure: lastFailure ?? new StreamingFailure("encoder_failed", "Streaming FFmpeg produced no encoder result."),
        handoff
      };
    });
    const value = execution.value;
    if (!value.ok) {
      return {
        ok: false,
        error: {
          code: value.failure.code,
          message: value.failure.message,
          ...(value.failure.process ? { process: value.failure.process } : {}),
          resources: execution.evidence,
          handoff: value.handoff
        }
      };
    }
    return {
      ok: true,
      command: value.value.command,
      output: value.value.output,
      evidence: { ...value.value.evidence, resources: execution.evidence }
    };
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: safeStreamingFailureMessage(error),
          ...(error.evidence ? { resources: error.evidence } : {}),
          ...(latestHandoff ? { handoff: latestHandoff } : {})
        }
      };
    }
    const failure = asStreamingFailure(error);
    return {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.process ? { process: failure.process } : {}),
        ...(latestHandoff ? { handoff: latestHandoff } : {})
      }
    };
  } finally {
    cancellation.cleanup();
  }
}

function streamingHandoffEvidence(input: {
  input: StreamingFfmpegFinalInput;
  attempts: StreamingEncodeAttemptOutcome[];
  observedMaxConcurrentProducerWrites: number;
  maxBufferedInputBytes: number;
  inputHighWaterMarkBytes: number;
  writes: number;
  drainWaits: number;
}): StreamingFfmpegHandoffEvidence {
  return {
    delivery: "streamed",
    frameFormat: input.input.frameFormat ?? "png",
    maxConcurrentProducerWrites: 1,
    observedMaxConcurrentProducerWrites: input.observedMaxConcurrentProducerWrites,
    maxBufferedInputBytes: input.maxBufferedInputBytes,
    inputHighWaterMarkBytes: input.inputHighWaterMarkBytes,
    maxFrameBytesPerFrame: streamingMaxFrameBytes(input.input),
    ...streamingFrameLimitEvidence(input.input),
    backpressure: { writes: input.writes, drainWaits: input.drainWaits },
    encoderHandoffSourceFramesRetained: 0,
    qualityPlaneSetCapacity: 2,
    uniqueHashCapacity: streamingFrameQualityHashRetentionCapacity(input.input.quality),
    attempts: input.attempts
  };
}

function streamingMaxFrameBytes(input: Pick<StreamingFfmpegFinalInput, "frameFormat" | "width" | "height">): number {
  return (input.frameFormat ?? "png") === "rgba"
    ? streamingMaxRgbaBytes(input.width, input.height)
    : streamingMaxPngBytes(input.width, input.height);
}

function streamingFrameLimitEvidence(input: Pick<StreamingFfmpegFinalInput, "frameFormat" | "width" | "height">):
  { maxPngBytesPerFrame: number } | { maxRgbaBytesPerFrame: number } {
  return (input.frameFormat ?? "png") === "rgba"
    ? { maxRgbaBytesPerFrame: streamingMaxRgbaBytes(input.width, input.height) }
    : { maxPngBytesPerFrame: streamingMaxPngBytes(input.width, input.height) };
}
