/**
 * Internal streamed-final compatibility wrapper.
 *
 * Preparation and finalization stay outside the package barrel so a future already-admitted
 * segmented encoder can share final-video policy without adopting the streaming transport.
 */
import { createGovernedFfmpegRunner } from "./index.js";
import { runStreamingFfmpegFinal } from "./streaming-foundation.js";
import type {
  StreamingFinalEncodePolicyInput,
  StreamingFinalEncodePolicyResult
} from "./streaming-final-encode-policy-types.js";
import {
  invalidateFailedHardwareAttempt,
  safePolicyDiagnostic
} from "./streaming-final-encode-policy-helpers.js";
import {
  bindStreamingFinalResourceEvidence,
  finalizeStreamingFinalEncodePolicy,
  prepareStreamingFinalEncodePolicy,
  releaseStreamingFinalMediaSnapshots
} from "./streaming-final-encode-policy-stages.js";

export {
  bindStreamingFinalResourceEvidence,
  finalizeStreamingFinalEncodePolicy,
  prepareStreamingFinalEncodePolicy,
  releaseStreamingFinalMediaSnapshots
} from "./streaming-final-encode-policy-stages.js";
export type {
  PreparedStreamingFinalEncodePolicy,
  StreamingFinalEncodeAdmittedPreflight,
  StreamingFinalEncodeExecutionEvidence,
  StreamingFinalEncodeFinalizationInput,
  StreamingFinalEncodeFinalizationResult,
  StreamingFinalEncodePolicyInput,
  StreamingFinalEncodePolicyResult,
  StreamingFinalEncodePreparationInput,
  StreamingFinalEncodePreparationResult,
  StreamingFinalFrameSequenceEvidence,
  StreamingFinalPartialOutputEvidence,
  StreamingFinalUnboundReceiptEvidence,
  StreamingFinalPolicyAttempt
} from "./streaming-final-encode-policy-types.js";

/**
 * Current streamed transport compatibility entry point. It alone selects the default governed
 * runner, executes the image2pipe foundation, and passes actual evidence to finalization.
 */
export async function runStreamingFinalEncodePolicy(input: StreamingFinalEncodePolicyInput): Promise<StreamingFinalEncodePolicyResult> {
  const runner = input.runner ?? createGovernedFfmpegRunner();
  const {
    runner: _providedRunner,
    produce: _produce,
    admittedPreflight,
    signal: _signal,
    governor: _governor,
    scratchRoot: _scratchRoot,
    operation: _operation,
    callerId: _callerId,
    jobId: _jobId,
    processFactory: _processFactory,
    ...policyFacts
  } = input;
  const preparation = admittedPreflight
    ? undefined
    : await prepareStreamingFinalEncodePolicy({ input: policyFacts, runner });
  if (preparation && !preparation.ok) return { ok: false, plannedAttempts: [], error: preparation.error };

  let prepared = preparation?.prepared;
  let releaseAdmitted: (() => Promise<void>) | undefined;
  try {
    const streamed = await runStreamingFfmpegFinal({
      frameCount: prepared?.frameCount ?? Math.ceil((input.durationMs / 1_000) * input.fps),
      durationMs: input.durationMs,
      fps: input.fps,
      width: input.width,
      height: input.height,
      ...(input.frameFormat ? { frameFormat: input.frameFormat } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(prepared ? { attempts: prepared.plannedAttempts.map((attempt) => ({ source: attempt.source, ...(attempt.encoder ? { encoder: attempt.encoder } : {}), command: attempt.command })), produce: input.produce } : {}),
      ...(admittedPreflight ? {
        admittedPrepare: async (context) => {
          const admitted = await admittedPreflight(context);
          releaseAdmitted = admitted.release;
          const admittedPreparation = await prepareStreamingFinalEncodePolicy({ input: admitted.input, runner: context.runner });
          if (!admittedPreparation.ok) throw new Error(admittedPreparation.error.message);
          prepared = admittedPreparation.prepared;
          return {
            attempts: prepared.plannedAttempts.map((attempt) => ({ source: attempt.source, ...(attempt.encoder ? { encoder: attempt.encoder } : {}), command: attempt.command })),
            produce: admitted.produce
          };
        }
      } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.governor ? { governor: input.governor } : {}),
      ...(input.scratchRoot ? { scratchRoot: input.scratchRoot } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.callerId ? { callerId: input.callerId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}),
      ...(input.processFactory ? { processFactory: input.processFactory } : {})
    });
    if (!streamed.ok) {
      if (prepared) invalidateFailedHardwareAttempt(prepared.cache, prepared.preset.hardwareEncode?.family, streamed.error.handoff?.attempts);
      return {
        ok: false,
        plannedAttempts: prepared?.plannedAttempts ?? [],
        error: {
          code: streamed.error.code,
          message: safePolicyDiagnostic(streamed.error.message),
          ...(streamed.error.process ? { process: streamed.error.process } : {}),
          ...(streamed.error.resources ? { resources: streamed.error.resources } : {}),
          ...(streamed.error.handoff ? { handoff: streamed.error.handoff } : {})
        }
      };
    }
    if (!prepared) {
      return {
        ok: false,
        plannedAttempts: [],
        error: { code: "streaming_metadata_invalid", message: "Streaming final encoder succeeded without its admitted preparation evidence." }
      };
    }

    const finalization = await finalizeStreamingFinalEncodePolicy({
      prepared,
      runner,
      execution: {
        command: streamed.command,
        output: streamed.output,
        attempts: streamed.evidence.attempts
      },
      frameSequence: {
        sha256: streamed.evidence.frameSequence.sha256,
        quality: streamed.evidence.quality
      }
    });
    if (!finalization.ok) {
      return {
        ok: false,
        plannedAttempts: prepared.plannedAttempts,
        error: {
          ...finalization.error,
          resources: streamed.evidence.resources,
          handoff: streamed.evidence
        }
      };
    }
    return {
      ok: true,
      command: finalization.command,
      plannedAttempts: prepared.plannedAttempts,
      handoff: streamed.evidence,
      receiptEvidence: bindStreamingFinalResourceEvidence(finalization.receiptEvidence, streamed.evidence.resources)
    };
  } finally {
    if (prepared) await releaseStreamingFinalMediaSnapshots(prepared.mediaSnapshots);
    await releaseAdmitted?.();
  }
}
