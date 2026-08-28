/** Internal sequential FFV1 range spool. No final concat, delivery encode, or receipt surface lives here. */
import { dirname } from "node:path";
import {
  defaultLocalMotionJobGovernor,
  LocalMotionJobError,
} from "@shellx-motion/core";
import { buildLosslessSegmentIntermediateCommand } from "./lossless-segment-concat-command.js";
import { fingerprintResolvedMotionPackageContent } from "./package-content-fingerprint.js";
import { createRenderSegmentStore, resumeRenderSegmentStore, type RenderSegmentStore } from "./render-segment-store.js";
import { segmentFrameSequenceSha256 } from "./render-segment-store-identity.js";
import { createRenderSegmentSpoolFrameSink } from "./render-segment-spool-frame-sink.js";
import type { RenderSegmentRange, RenderSegmentReadbackVerificationInput } from "./render-segment-store-types.js";
import { verifyPreAdmittedLosslessSegment } from "./segment-ffprobe-readback.js";
import {
  assertSpoolFacts,
  cleanupCurrentTemporaryArtifact,
  failureFor,
  operationLifecycle,
  phaseFor,
  SegmentSpoolOperationError,
  stoppedError,
  throwIfStopped
} from "./render-segment-spool-helpers.js";
import {
  createStreamingEvidenceReporter,
  normalizedStreamingCancellation,
  streamingProducerJobContext
} from "../streaming-foundation-helpers.js";
import { startStreamingFfmpegProcess, type StreamingFfmpegProcess } from "../streaming-process.js";
import type {
  RenderSegmentSpoolAdmittedInput,
  RenderSegmentSpoolFailureCode,
  RenderSegmentSpoolFailureEvidence,
  RenderSegmentSpoolInput,
  RenderSegmentSpoolPhase,
  RenderSegmentSpoolResult
} from "./render-segment-spool-types.js";
import type { RenderSegmentRangeProducer } from "./render-segment-spool-types.js";
import {
  assertSegmentProducerConsistency,
  combinedSegmentProducerEvidence,
  requireSegmentProducerEvidence
} from "./render-segment-producer-evidence.js";
export type {
  RenderSegmentRangeProducer,
  RenderSegmentRangeProducerFactory,
  RenderSegmentSpoolAdmittedInput,
  RenderSegmentSpoolInput,
  RenderSegmentSpoolResult
} from "./render-segment-spool-types.js";
import { RenderSegmentSpoolFailure } from "./render-segment-spool-types.js";
export { RenderSegmentSpoolFailure } from "./render-segment-spool-types.js";

/**
 * Standalone internal wrapper. It acquires exactly one FFmpeg governor job; a later final adapter
 * may instead call {@link spoolRenderSegmentsAdmitted} under its own one logical admission.
 */
export async function spoolRenderSegments(input: RenderSegmentSpoolInput): Promise<RenderSegmentSpoolResult> {
  const governor = input.governor ?? defaultLocalMotionJobGovernor;
  const cancellation = normalizedStreamingCancellation(input.signal);
  let admittedFailure: Extract<RenderSegmentSpoolResult, { ok: false }> | undefined;
  try {
    const execution = await governor.run({
      lane: "ffmpeg",
      operation: input.operation ?? "ffmpeg.resumable-segment-spool",
      scratchRoot: input.scratchRoot ?? (process.env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || ".scratch"),
      ...(cancellation.signal ? { signal: cancellation.signal } : {}),
      ...(input.callerId ? { callerId: input.callerId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {})
    }, async (job) => {
      const admitted = await spoolRenderSegmentsAdmitted({
        package: input.package,
        timeline: input.timeline,
        frameLane: input.frameLane,
        producer: input.producer,
        plan: input.plan,
        store: input.store,
        createRangeProducer: input.createRangeProducer,
        ...(input.processFactory ? { processFactory: input.processFactory } : {}),
        ...(input.verifyReadback ? { verifyReadback: input.verifyReadback } : {}),
        ...(input.deadlineAtMs !== undefined ? { deadlineAtMs: input.deadlineAtMs } : {}),
        job
      });
      // An admitted primitive reports bounded failure details. Its owning governor must rethrow
      // Core resource errors so job evidence never falsely records a passed operation.
      if (!admitted.ok) {
        admittedFailure = admitted;
        if (job.signal.aborted) throw job.signal.reason ?? stoppedError(job.signal);
        if (isLocalJobError(admitted.error.primaryCause)) throw admitted.error.primaryCause;
      }
      return admitted;
    });
    return execution.value.ok
      ? { ...execution.value, resources: execution.evidence }
      : { ...execution.value, resources: execution.evidence };
  } catch (error) {
    if (admittedFailure && isLocalJobError(error)) {
      return { ...admittedFailure, ...(error.evidence ? { resources: error.evidence } : {}) };
    }
    return {
      ok: false,
      error: failureFor(error, phaseFor(error, "store"), null, 0, { attempted: false, outcome: "not_needed" }),
      ...(isLocalJobError(error) && error.evidence ? { resources: error.evidence } : {})
    };
  } finally {
    cancellation.cleanup();
  }
}

/** Pre-admitted primitive: it never consults or calls a governor. */
export async function spoolRenderSegmentsAdmitted(input: RenderSegmentSpoolAdmittedInput): Promise<RenderSegmentSpoolResult> {
  const reporter = input.evidenceReporter ?? createStreamingEvidenceReporter(input.job);
  const processFactory = input.processFactory ?? startStreamingFfmpegProcess;
  const probe = input.verifyReadback ?? verifyPreAdmittedLosslessSegment;
  let lifecycle: ReturnType<typeof operationLifecycle> | undefined;
  let store: RenderSegmentStore | undefined;
  let range: RenderSegmentRange | null = null;
  let temporaryPath: string | undefined;
  let observedMaxConcurrentPngHandoffs = 0;
  let verifiedPrefixSegments = 0;
  try {
    assertSpoolFacts(input);
    lifecycle = operationLifecycle(input.job.signal, input.deadlineAtMs);
    const job = { ...input.job, signal: lifecycle.signal };
    throwIfStopped(lifecycle.signal);
    let source;
    try {
      source = await fingerprintResolvedMotionPackageContent(input.package.rootPath, {
        ...(input.package.inputHashes ? { expectedFileHashes: input.package.inputHashes } : {})
      });
    } catch (error) {
      throw new SegmentSpoolOperationError("source_fingerprint", error);
    }
    throwIfStopped(lifecycle.signal);
    const storeInput = {
      rootPath: input.store.rootPath,
      plan: input.plan,
      package: { id: input.package.id, manifestSha256: input.package.manifestSha256, contentSha256: source.sha256 },
      frameLane: input.frameLane,
      producer: input.producer,
      timeline: timelineFacts(input),
      intermediate: { container: "matroska", codec: "ffv1", extension: ".mkv" },
      ...(input.delivery ? { delivery: input.delivery } : {}),
      verifyReadback: async (readbackInput: RenderSegmentReadbackVerificationInput) => await probe({
        ...readbackInput,
        job,
        processFactory,
        reportProcessContainment: reporter.reportProcessContainment
      })
    };
    store = input.store.intent === "create"
      ? await createRenderSegmentStore(storeInput)
      : await resumeRenderSegmentStore({ ...storeInput, ...(input.resumeRecovery ? { recovery: input.resumeRecovery } : {}) });
    verifiedPrefixSegments = store.completedCount;
    for (let index = store.nextIndex; index !== null; index = store.nextIndex) {
      range = input.plan.ranges[index];
      temporaryPath = store.temporaryArtifactPath(index);
      const observation = await spoolOneRange({ input, job, reporter, processFactory, store, range, temporaryPath, signal: lifecycle.signal });
      observedMaxConcurrentPngHandoffs = Math.max(observedMaxConcurrentPngHandoffs, observation);
      temporaryPath = undefined;
    }
    throwIfStopped(lifecycle.signal);
    let finalSource;
    try {
      finalSource = await fingerprintResolvedMotionPackageContent(input.package.rootPath, {
        ...(input.package.inputHashes ? { expectedFileHashes: input.package.inputHashes } : {})
      });
    } catch (error) {
      throw new SegmentSpoolOperationError("source_recheck", error);
    }
    // Two bounded scans catch persistent concurrent edits, not a filesystem snapshot: a complete
    // edit-and-restore between them remains a residual for a later package-lock/snapshot design.
    if (finalSource.sha256 !== source.sha256) throw new SegmentSpoolOperationError("source_recheck", "Package content changed during the segment spool.");
    return {
      ok: true,
      manifest: store.manifest,
      packageContent: finalSource,
      handoff: {
        delivery: "resumable-ffv1-segments",
        sequential: true,
        maxConcurrentPngHandoffs: 1,
        observedMaxConcurrentPngHandoffs
      },
      resume: { verifiedPrefixSegments },
      producer: combinedSegmentProducerEvidence(store.manifest)
    };
  } catch (error) {
    const cleanup = await cleanupCurrentTemporaryArtifact(temporaryPath);
    const interrupted = lifecycle?.signal.aborted ? stoppedError(lifecycle.signal) : undefined;
    const phase = interrupted ? phaseFor(interrupted, "cancelled") : error instanceof SegmentSpoolOperationError ? error.phase : phaseFor(error, store ? "checkpoint" : "store");
    const primary = interrupted ?? (error instanceof SegmentSpoolOperationError ? error.primaryCause : error);
    return {
      ok: false,
      error: failureFor(primary, phase, range, store?.completedCount ?? 0, cleanup, [
        ...(interrupted ? [error] : []),
        ...(error instanceof SegmentSpoolOperationError && error.cleanupCause !== undefined ? [error.cleanupCause] : [])
      ])
    };
  } finally {
    lifecycle?.cleanup();
  }
}

async function spoolOneRange(input: {
  input: RenderSegmentSpoolAdmittedInput;
  job: RenderSegmentSpoolAdmittedInput["job"];
  reporter: ReturnType<typeof createStreamingEvidenceReporter>;
  processFactory: NonNullable<RenderSegmentSpoolAdmittedInput["processFactory"]>;
  store: RenderSegmentStore;
  range: RenderSegmentRange;
  temporaryPath: string;
  signal: AbortSignal;
}): Promise<number> {
  let process: StreamingFfmpegProcess | undefined;
  let producer: RenderSegmentRangeProducer | undefined;
  try {
    producer = await input.input.createRangeProducer({
      range: { index: input.range.index, startFrameIndex: input.range.startFrame, endFrameIndexExclusive: input.range.endFrameExclusive },
      timeline: input.input.timeline,
      frameLane: input.input.frameLane
    });
    let command;
    try {
      command = buildLosslessSegmentIntermediateCommand({
        segmentDirectory: dirname(input.temporaryPath),
        segmentIndex: input.range.index,
        frameCount: input.range.frameCount,
        fps: input.input.timeline.fps,
        ...(input.input.frameLane === "gpu" ? {
          frameFormat: "rgba" as const,
          width: input.input.timeline.width,
          height: input.input.timeline.height
        } : {}),
        temporaryOutputPath: input.temporaryPath
      }).command;
      process = await input.processFactory({
        command,
        signal: input.signal,
        watchProcess: input.job.watchProcess,
        reportProcessContainment: input.reporter.reportProcessContainment
      });
    } catch (error) {
      throw new SegmentSpoolOperationError("encoder", error);
    }
    let inputEnded = false;
    const earlyClose = process.closed.then((result) => {
      if (!inputEnded) throw new SegmentSpoolOperationError("encoder", "Segment FFmpeg closed before the range completed.");
      return result;
    });
    const handoff = createRenderSegmentSpoolFrameSink({
      process,
      range: input.range,
      timeline: input.input.timeline,
      frameLane: input.input.frameLane,
      signal: input.signal
    });
    const producerJob = streamingProducerJobContext(
      input.job,
      input.signal,
      input.reporter,
      input.input.frameLane === "gpu" ? input.input.maxProcessTreeRssBytes : undefined
    );
    await Promise.race([producer.produce(handoff.sink, producerJob), earlyClose]);
    throwIfStopped(input.signal);
    handoff.assertComplete();
    const producerEvidence = requireSegmentProducerEvidence(producer.evidence, input.input.frameLane);
    assertSegmentProducerConsistency(input.store.manifest.producer, producerEvidence);
    inputEnded = true;
    const output = await process.end();
    if (output.exitCode !== 0) throw new SegmentSpoolOperationError("encoder", "Segment FFmpeg exited unsuccessfully.");
    try {
      await input.store.commit({
        index: input.range.index,
        temporaryArtifactPath: input.temporaryPath,
        frameSequenceSha256: segmentFrameSequenceSha256({ range: input.range, frameHashes: handoff.frameHashes }),
        frameHashes: handoff.frameHashes,
        blankFrameCount: handoff.blankFrameCount,
        producer: producerEvidence
      });
    } catch (error) {
      throw new SegmentSpoolOperationError("checkpoint", error);
    }
    return handoff.observedMaxConcurrentPngHandoffs;
  } catch (error) {
    let cleanupCause: unknown;
    try {
      await process?.abort(error instanceof Error ? error : new Error("Segment spool failed."));
    } catch (cleanupError) {
      cleanupCause = cleanupError;
    }
    try {
      await producer?.abort?.();
    } catch (cleanupError) {
      cleanupCause = cleanupCause === undefined
        ? cleanupError
        : new AggregateError([cleanupCause, cleanupError], "Segment encoder and range-producer cleanup both failed.");
    }
    if (error instanceof SegmentSpoolOperationError) {
      if (cleanupCause === undefined) throw error;
      throw new SegmentSpoolOperationError(error.phase, error.primaryCause, cleanupCause);
    }
    throw new SegmentSpoolOperationError(phaseFor(error, "producer"), error, cleanupCause);
  }
}

function timelineFacts(input: RenderSegmentSpoolAdmittedInput) {
  const { motionSha256, durationMs, fps, width, height } = input.timeline;
  return { motionSha256, durationMs, fps, width, height };
}

function isLocalJobError(value: unknown): value is LocalMotionJobError {
  return value instanceof LocalMotionJobError;
}
