/** One admitted execution path for internal durable FFV1 segments and final concat delivery. */
import {
  defaultLocalMotionJobGovernor,
  LocalMotionJobError
} from "@shellx-motion/core";
import { bindStreamingFinalResourceEvidence } from "../streaming-final-encode-policy-stages.js";
import { normalizedStreamingCancellation } from "../streaming-foundation-helpers.js";
import { startStreamingFfmpegProcess } from "../streaming-process.js";
import { assertSegmentedPolicy } from "./segmented-final-adapter-evidence.js";
import { runSegmentedFinalAdmitted } from "./segmented-final-adapter-executor.js";
import { segmentedFinalCleanupCauses } from "./segmented-final-adapter-cleanup.js";
import type { AdmittedResourceFailureSidecar } from "./segmented-final-adapter-failure.js";
import {
  acquireSegmentedFinalLock,
  deriveSegmentedFinalPaths,
  SegmentedFinalStoreBusyError
} from "./segmented-final-adapter-store.js";
import { SegmentedFinalStoreAuthority } from "./segmented-final-store-authority.js";
import {
  SegmentedFinalAdapterFailure,
  type RenderSegmentedFinalInput,
  type RenderSegmentedFinalResult,
  type SegmentedFinalFailureEvidence,
  type SegmentedFinalTransportEvidence
} from "./segmented-final-adapter-types.js";

export type {
  RenderSegmentedFinalInput,
  RenderSegmentedFinalResult,
  SegmentedFinalAdapterFailure,
  SegmentedFinalTransportEvidence
} from "./segmented-final-adapter-types.js";

/** Internal executor. The public wrapper owns the closed caller contract and receipt projection. */
export async function renderSegmentedFinal(input: RenderSegmentedFinalInput): Promise<RenderSegmentedFinalResult> {
  let paths: ReturnType<typeof deriveSegmentedFinalPaths>;
  let releaseLock: (() => Promise<void>) | undefined;
  let authority: SegmentedFinalStoreAuthority | undefined;
  try {
    assertSegmentedPolicy(input);
    paths = deriveSegmentedFinalPaths(input.outputPath, input.package.rootPath);
    releaseLock = await acquireSegmentedFinalLock(paths);
    // GPU deliberately creates its pre-store browser verdict inside the one admitted job
    // before this durable root exists. Browser/native keep the historical early reservation.
    if (input.frameLane !== "gpu") authority = await SegmentedFinalStoreAuthority.acquire(paths, input.store.intent);
  } catch (error) {
    if (releaseLock) await releaseLock().catch(() => undefined);
    return fail(error instanceof SegmentedFinalStoreBusyError ? error.code : "segmented_final_preflight_failed", "preflight", error);
  }
  if (!authority && input.frameLane !== "gpu") return fail("segmented_final_preflight_failed", "preflight", new Error("Segmented final store authority was not acquired."));
  const governor = input.governor ?? defaultLocalMotionJobGovernor;
  const cancellation = normalizedStreamingCancellation(input.signal);
  let admittedPhase: SegmentedFinalFailureEvidence["phase"] = "preflight";
  let resourceSidecar: AdmittedResourceFailureSidecar | undefined;
  let discardEmptyStore = true;
  try {
    const execution = await governor.run(
      {
        lane: "ffmpeg",
        operation: input.operation ?? "ffmpeg.segmented-final-internal",
        scratchRoot: input.scratchRoot
          ?? (process.env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || ".scratch"),
        ...(cancellation.signal ? { signal: cancellation.signal } : {}),
        ...(input.callerId ? { callerId: input.callerId } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {})
      },
      async (job) => await runSegmentedFinalAdmitted(
        input,
        paths,
        authority,
        (acquired) => { authority = acquired; },
        job,
        governor.policy.maxProcessTreeRssBytes,
        input.processFactory ?? startStreamingFfmpegProcess,
        (phase) => { admittedPhase = phase; },
        (sidecar) => { resourceSidecar = sidecar; }
      )
    );
    if (!execution.value.ok) {
      return { ok: false, error: withResources(execution.value.failure, execution.evidence) };
    }
    discardEmptyStore = false;
    const bound = bindStreamingFinalResourceEvidence(execution.value.receiptEvidence, execution.evidence);
    return {
      ok: true,
      output: {
        sha256: bound.output.sha256,
        width: bound.output.width,
        height: bound.output.height,
        durationMs: bound.output.durationMs,
        codec: bound.output.codec,
        container: bound.output.container,
        preset: bound.output.preset
      },
      inputHashes: { ...bound.inputHashes },
      warnings: [...bound.warnings],
      resources: execution.evidence,
      transport: execution.value.transport,
      receiptEvidence: bound
    };
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      return localFailure(error, resourcePhase(error, resourceSidecar?.phase ?? admittedPhase), resourceSidecar);
    }
    return fail("segmented_final_failed", admittedPhase, error);
  } finally {
    cancellation.cleanup();
    if (discardEmptyStore && authority && input.store.intent === "create") await authority.discardEmptyStore().catch(() => undefined);
    if (releaseLock) await releaseLock().catch(() => undefined);
  }
}

function withResources(
  value: SegmentedFinalAdapterFailure,
  resources: NonNullable<SegmentedFinalFailureEvidence["resources"]>
): SegmentedFinalAdapterFailure {
  return new SegmentedFinalAdapterFailure(
    value.code,
    { ...value.evidence, resources },
    value.primaryCause,
    value.cleanupCauses
  );
}

function localFailure(
  error: LocalMotionJobError,
  phase: SegmentedFinalFailureEvidence["phase"],
  sidecar: AdmittedResourceFailureSidecar | undefined
): RenderSegmentedFinalResult {
  const cleanupCauses = segmentedFinalCleanupCauses(error);
  return {
    ok: false,
    error: new SegmentedFinalAdapterFailure(
      error.code,
      {
        phase,
        ...(sidecar?.transport ? { transport: sidecar.transport } : {}),
        ...(sidecar?.spool ? { spool: sidecar.spool } : {}),
        ...(sidecar?.partialOutput ? { partialOutput: sidecar.partialOutput } : {}),
        publication: sidecar?.publication ?? "not_published",
        ...(error.evidence ? { resources: error.evidence } : {})
      },
      error,
      [...(sidecar?.cleanupCauses ?? []), ...cleanupCauses]
    )
  };
}

function resourcePhase(error: LocalMotionJobError, admittedPhase: SegmentedFinalFailureEvidence["phase"]): SegmentedFinalFailureEvidence["phase"] {
  if (error.code === "job_cancelled") return "cancelled";
  if (error.code === "job_deadline_exceeded") return "deadline";
  return admittedPhase;
}

function fail(
  code: string,
  phase: SegmentedFinalFailureEvidence["phase"],
  primaryCause: unknown,
  cleanupCauses: readonly unknown[] = [],
  resources?: SegmentedFinalFailureEvidence["resources"]
): RenderSegmentedFinalResult {
  return {
    ok: false,
    error: new SegmentedFinalAdapterFailure(
      code,
      { phase, ...(resources ? { resources } : {}) },
      primaryCause,
      cleanupCauses
    )
  };
}
