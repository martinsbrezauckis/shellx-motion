/** The one already-admitted durable spool, concat, finalize, publish, and cleanup operation. */
import { LocalMotionJobError, type LocalMotionJobContext } from "@shellx-motion/core";
import { spoolRenderSegmentsAdmitted } from "./render-segment-spool.js";
import type { RenderSegmentSpoolFailureEvidence } from "./render-segment-spool-types.js";
import { prepareStreamingFinalEncodePolicy, releaseStreamingFinalMediaSnapshots } from "../streaming-final-encode-policy-stages.js";
import type { PreparedStreamingFinalEncodePolicy, StreamingFinalUnboundReceiptEvidence } from "../streaming-final-encode-policy-types.js";
import { createStreamingEvidenceReporter } from "../streaming-foundation-helpers.js";
import type { StreamingFfmpegProcessFactory } from "../streaming-process.js";
import { segmentedQuality } from "./segmented-final-adapter-evidence.js";
import { runSegmentedConcatAttempts, type SegmentedConcatAttemptsResult } from "./segmented-final-adapter-concat.js";
import { finishSegmentedFinalDelivery } from "./segmented-final-adapter-delivery.js";
import { admittedFailure, type AdmittedResourceFailureSidecar } from "./segmented-final-adapter-failure.js";
import {
  preAdmittedRunner,
  segmentedDeliveryFacts,
  segmentedFailureTransport,
  segmentedPolicyInput,
  segmentedResumeRecovery,
  transformSegmentedAttempts,
  type VerifiedTransportState
} from "./segmented-final-adapter-helpers.js";
import {
  assertConcatListHash,
  partialOutput,
  removeUnpublishedStage,
  verifySegmentArtifacts,
  writeConcatListAtomically,
  type SegmentedFinalPaths
} from "./segmented-final-adapter-store.js";
import { SegmentedFinalStoreAuthority } from "./segmented-final-store-authority.js";
import { settleSegmentedFinalAdmittedCleanup } from "./segmented-final-adapter-cleanup.js";
import type { PreparedSegmentedGpuHost } from "../segmented-final-gpu-host.js";
import { prepareAdmittedSegmentedGpuInput } from "../segmented-final-gpu-admission.js";
import {
  type RenderSegmentedFinalInput,
  type SegmentedFinalAdapterFailure,
  type SegmentedFinalFailureEvidence,
  type SegmentedFinalFailureTransportEvidence,
  type SegmentedFinalTransportEvidence
} from "./segmented-final-adapter-types.js";
export type SegmentedFinalAdmittedValue = { ok: true; receiptEvidence: StreamingFinalUnboundReceiptEvidence; transport: SegmentedFinalTransportEvidence }
  | { ok: false; failure: SegmentedFinalAdapterFailure };

/** Never creates an admission or resource receipt; that remains owned by the outer adapter. */
export async function runSegmentedFinalAdmitted(
  input: RenderSegmentedFinalInput,
  paths: SegmentedFinalPaths,
  authority: SegmentedFinalStoreAuthority | undefined,
  setAuthority: (authority: SegmentedFinalStoreAuthority) => void,
  job: LocalMotionJobContext,
  maxProcessTreeRssBytes: number,
  processFactory: StreamingFfmpegProcessFactory,
  setPhase: (phase: SegmentedFinalFailureEvidence["phase"]) => void,
  recordResourceFailure: (sidecar: AdmittedResourceFailureSidecar) => void
): Promise<SegmentedFinalAdmittedValue> {
  const reporter = createStreamingEvidenceReporter(job);
  let activeAuthority = authority;
  const guardedProcessFactory: StreamingFfmpegProcessFactory = async (processInput) => {
    if (!activeAuthority) throw new Error("Segmented final process execution started before durable store authority was acquired.");
    await activeAuthority.assertCurrent();
    return await processFactory(processInput);
  };
  const runner = preAdmittedRunner(job, guardedProcessFactory, reporter);
  let currentPhase: SegmentedFinalFailureEvidence["phase"] = "preflight";
  let verified: VerifiedTransportState | undefined;
  let concat: SegmentedConcatAttemptsResult | undefined;
  let concatState: SegmentedFinalFailureTransportEvidence["concat"] = { state: "not_created" };
  let stagingCleanup: SegmentedFinalFailureTransportEvidence["retention"]["stagingCleanup"] = "not_started";
  let publication: SegmentedFinalFailureTransportEvidence["publication"] = "not_published";
  let preparedPolicy: PreparedStreamingFinalEncodePolicy | undefined;
  let gpuHost: PreparedSegmentedGpuHost | undefined;
  let gpuRangeMaxProcessTreeRssBytes = maxProcessTreeRssBytes;
  let admittedInput = input;
  const updatePhase = (phase: SegmentedFinalFailureEvidence["phase"]) => {
    currentPhase = phase;
    setPhase(phase);
  };
  const provisionalFailure = () => segmentedFailureTransport(verified, {
    concat: concatState,
    attempts: concat?.attempts ?? [],
    stagingCleanup,
    publication
  });
  const recordLocalFailure = (details: {
    phase?: SegmentedFinalFailureEvidence["phase"];
    attempts?: SegmentedFinalFailureTransportEvidence["attempts"];
    partialOutput?: SegmentedFinalFailureEvidence["partialOutput"];
    cleanupCauses?: readonly unknown[];
    spool?: RenderSegmentSpoolFailureEvidence;
  } = {}) => {
    const attempts = details.attempts ?? concat?.attempts ?? [];
    recordResourceFailure({
      phase: details.phase ?? currentPhase,
      transport: segmentedFailureTransport(verified, {
        concat: concatState,
        attempts,
        stagingCleanup,
        publication
      }),
      ...(details.spool ? { spool: details.spool } : {}),
      ...(details.partialOutput ? { partialOutput: details.partialOutput } : {}),
      publication,
      cleanupCauses: details.cleanupCauses ?? []
    });
  };
  let result: SegmentedFinalAdmittedValue | undefined;
  let thrown: unknown;
  try {
    result = await (async (): Promise<SegmentedFinalAdmittedValue> => {
    updatePhase("preflight");
    if (input.frameLane === "gpu") {
      const preparedGpu = await prepareAdmittedSegmentedGpuInput({
        request: input, paths, authority: activeAuthority, setAuthority, job, maxProcessTreeRssBytes,
        runner: preAdmittedRunner(job, processFactory, reporter)
      });
      activeAuthority = preparedGpu.authority;
      gpuHost = preparedGpu.gpuHost;
      gpuRangeMaxProcessTreeRssBytes = preparedGpu.maxProcessTreeRssBytes;
      admittedInput = preparedGpu.admittedInput;
    }
    if (!activeAuthority || !admittedInput.producer || !admittedInput.createRangeProducer) {
      return { ok: false, failure: admittedFailure("segmented_final_policy_failed", "preflight", new Error("Segmented final admitted producer facts were unavailable.")) };
    }
    const admittedAuthority = activeAuthority;
    await admittedAuthority.assertCurrent();
    const preparation = await prepareStreamingFinalEncodePolicy({
      input: segmentedPolicyInput(admittedInput, paths, gpuHost),
      runner
    });
    if (!preparation.ok) {
      return {
        ok: false,
        failure: admittedFailure("segmented_final_policy_failed", "preflight", preparation.error)
      };
    }
    preparedPolicy = preparation.prepared;

    const delivery = await segmentedDeliveryFacts(admittedInput, paths.outputPath, preparation.prepared);
    updatePhase("spool");
    const spooled = await spoolRenderSegmentsAdmitted({
      package: admittedInput.package,
      timeline: admittedInput.timeline,
      frameLane: admittedInput.frameLane,
      producer: admittedInput.producer,
      plan: admittedInput.plan,
      store: { intent: admittedInput.store.intent, rootPath: paths.storeRoot },
      delivery,
      ...(admittedInput.store.intent === "resume" ? { resumeRecovery: segmentedResumeRecovery(paths) } : {}),
      createRangeProducer: admittedInput.createRangeProducer,
      processFactory: guardedProcessFactory,
      evidenceReporter: reporter,
      job,
      ...(admittedInput.frameLane === "gpu" ? { maxProcessTreeRssBytes: gpuRangeMaxProcessTreeRssBytes } : {}),
      ...(input.verifyReadback ? { verifyReadback: input.verifyReadback } : {}),
      ...(input.deadlineAtMs !== undefined ? { deadlineAtMs: input.deadlineAtMs } : {})
    });
    if (!spooled.ok) {
      if (spooled.error.primaryCause instanceof LocalMotionJobError) {
        recordLocalFailure({
          phase: "spool",
          spool: spooled.error.evidence,
          cleanupCauses: spooled.error.cleanupCauses
        });
        throw spooled.error.primaryCause;
      }
      return {
        ok: false,
        failure: admittedFailure(
          spooled.error.code,
          "spool",
          spooled.error.primaryCause,
          spooled.error.cleanupCauses
        )
      };
    }
    let segments: VerifiedTransportState["segments"];
    let quality: ReturnType<typeof segmentedQuality>;
    try {
      await admittedAuthority.assertCurrent();
      segments = await verifySegmentArtifacts(spooled.manifest, paths.storeRoot);
      verified = {
        manifest: spooled.manifest,
        segments,
        verifiedPrefixSegments: spooled.resume.verifiedPrefixSegments,
        observedMaxConcurrentPngHandoffs: spooled.handoff.observedMaxConcurrentPngHandoffs
      };
      quality = segmentedQuality(spooled.manifest, admittedInput.quality);
    } catch (error) {
      return {
        ok: false,
        failure: admittedFailure(
          "segmented_final_segment_integrity_failed",
          "spool",
          error,
          [],
          provisionalFailure()
        )
      };
    }
    updatePhase("concat");
    let transformed: ReturnType<typeof transformSegmentedAttempts>;
    let concatListSha256: string;
    try {
      await admittedAuthority.assertCurrent();
      transformed = transformSegmentedAttempts(
        preparation.prepared,
        (admittedInput.preset ?? "mp4-h264") as "mp4-h264" | "webm-vp9-alpha",
        paths,
        spooled.manifest,
        admittedInput.plan.frameCount
      );
      concatListSha256 = await writeConcatListAtomically(paths, transformed.contents);
      concatState = { state: "created", sha256: concatListSha256 };
      await assertConcatListHash(paths.concatListPath, concatListSha256);
    } catch (error) {
      return {
        ok: false,
        failure: admittedFailure(
          "segmented_final_concat_setup_failed",
          "concat",
          error,
          [],
          provisionalFailure()
        )
      };
    }
    concat = await runSegmentedConcatAttempts(
      transformed.attempts,
      paths.stagingPath,
      job,
      guardedProcessFactory,
      reporter,
      ({ attempts, partial, stagingCleanup: cleanupState, cleanupCauses }) => {
        stagingCleanup = cleanupState;
        recordLocalFailure({
          phase: "concat",
          attempts,
          partialOutput: partial,
          cleanupCauses
        });
      }
    );
    stagingCleanup = concat.stagingCleanup;
    try {
      await assertConcatListHash(paths.concatListPath, concatListSha256);
    } catch (error) {
      concatState = { state: "tampered", sha256: concatListSha256 };
      const partial = await partialOutput(paths.stagingPath);
      const cleanup = await removeUnpublishedStage(paths.stagingPath);
      stagingCleanup = cleanup.outcome;
      return {
        ok: false,
        failure: admittedFailure(
          "segmented_final_concat_list_tampered",
          "concat",
          error,
          [...concat.cleanupCauses, ...(cleanup.cause === undefined ? [] : [cleanup.cause])],
          provisionalFailure(),
          partial
        )
      };
    }
    if (!concat.output) {
      return {
        ok: false,
        failure: admittedFailure(
          "segment_concat_failed",
          "concat",
          concat.primaryCause ?? concat.attempts.at(-1) ?? new Error("No concat attempt ran"),
          concat.cleanupCauses,
          provisionalFailure(),
          concat.partial
        )
      };
    }
    const successfulConcat = { ...concat, output: concat.output };
    return await finishSegmentedFinalDelivery({
      prepared: preparation.prepared,
      transformed,
      concat: successfulConcat,
      paths,
      authority: admittedAuthority,
      manifest: spooled.manifest,
      segments,
      verifiedPrefixSegments: spooled.resume.verifiedPrefixSegments,
      observedMaxConcurrentPngHandoffs: spooled.handoff.observedMaxConcurrentPngHandoffs,
      producer: spooled.producer,
      quality,
      runner,
      concatListSha256,
      updatePhase,
      provisionalFailure,
      setStagingCleanup: (value) => { stagingCleanup = value; },
      setPublication: (value) => { publication = value; },
      recordLocalFailure,
      ...(input.privateOutputPublication ? { privateOutputPublication: input.privateOutputPublication } : {})
    });
    })();
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      thrown = error;
    } else {
      result = {
      ok: false,
      failure: admittedFailure(
        "segmented_final_failed",
        currentPhase,
        error,
        [],
        provisionalFailure()
      )
      };
    }
  }
  const policyToRelease = preparedPolicy;
  const hostToRelease = gpuHost;
  return await settleSegmentedFinalAdmittedCleanup({
    result,
    thrown,
    releases: [
      ...(policyToRelease ? [releaseStreamingFinalMediaSnapshots(policyToRelease.mediaSnapshots)] : []),
      ...(hostToRelease ? [hostToRelease.release()] : [])
    ]
  });
}
