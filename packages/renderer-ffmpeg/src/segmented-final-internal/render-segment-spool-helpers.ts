import { lstat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LocalMotionJobError } from "@shellx-motion/core";
import type { RenderSegmentRange } from "./render-segment-store-types.js";
import {
  RenderSegmentSpoolFailure,
  type RenderSegmentSpoolAdmittedInput,
  type RenderSegmentSpoolFailureCode,
  type RenderSegmentSpoolFailureEvidence,
  type RenderSegmentSpoolPhase
} from "./render-segment-spool-types.js";

export function assertSpoolFacts(input: RenderSegmentSpoolAdmittedInput): void {
  if (input.timeline.frameCount !== input.plan.frameCount) {
    throw new SegmentSpoolOperationError("store", "Segment plan does not match the canonical timeline frame count.");
  }
  const packageRoot = input.package.rootPath;
  const storeRoot = input.store.rootPath;
  if (!isAbsolute(packageRoot) || resolve(packageRoot) !== packageRoot || !isAbsolute(storeRoot) || resolve(storeRoot) !== storeRoot) {
    throw new SegmentSpoolOperationError("store", "Package and segment store roots must be resolved absolute paths.");
  }
  if (isWithin(packageRoot, storeRoot) || isWithin(storeRoot, packageRoot)) {
    throw new SegmentSpoolOperationError("store", "Package and segment store roots must not overlap.");
  }
  if (input.deadlineAtMs !== undefined && (!Number.isSafeInteger(input.deadlineAtMs) || input.deadlineAtMs <= 0)) {
    throw new SegmentSpoolOperationError("store", "Segment spool deadline must be a positive safe epoch millisecond value.");
  }
}

export function operationLifecycle(parent: AbortSignal, deadlineAtMs: number | undefined) {
  const controller = new AbortController();
  const relay = () => controller.abort(parent.reason);
  parent.addEventListener("abort", relay, { once: true });
  if (parent.aborted) relay();
  const deadlineReason = new LocalMotionJobError("job_deadline_exceeded", "Segment spool reached its deadline.");
  const timeout = deadlineAtMs === undefined || deadlineAtMs <= Date.now()
    ? undefined
    : setTimeout(() => controller.abort(deadlineReason), deadlineAtMs - Date.now());
  if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) controller.abort(deadlineReason);
  timeout?.unref?.();
  return { signal: controller.signal, cleanup: () => { parent.removeEventListener("abort", relay); if (timeout) clearTimeout(timeout); } };
}

export function throwIfStopped(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw stoppedError(signal);
}

export function stoppedError(signal: AbortSignal): LocalMotionJobError {
  if (!signal.aborted) return new LocalMotionJobError("job_cancelled", "Segment spool stopped unexpectedly.");
  if (signal.reason instanceof LocalMotionJobError) return signal.reason;
  return new LocalMotionJobError("job_cancelled", "Segment spool was cancelled.");
}

export async function cleanupCurrentTemporaryArtifact(path: string | undefined) {
  if (!path) return { attempted: false as const, outcome: "not_needed" as const };
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { attempted: true as const, outcome: "retained" as const };
    await unlink(path);
    return { attempted: true as const, outcome: "removed" as const };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { attempted: true as const, outcome: "missing" as const };
    return { attempted: true as const, outcome: "retained" as const, cause: error };
  }
}

export function phaseFor(error: unknown, fallback: RenderSegmentSpoolPhase): RenderSegmentSpoolPhase {
  if (error instanceof LocalMotionJobError) {
    if (error.code === "job_deadline_exceeded") return "deadline";
    return error.code === "job_cancelled" ? "cancelled" : "resource";
  }
  if (error instanceof SegmentSpoolOperationError) return error.phase;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  return code === "segment_readback_verification_failed" ? "checkpoint" : fallback;
}

export function failureFor(
  primaryCause: unknown,
  phase: RenderSegmentSpoolPhase,
  range: RenderSegmentRange | null,
  verifiedPrefixSegments: number,
  cleanup: { attempted: boolean; outcome: "not_needed" | "missing" | "removed" | "retained"; cause?: unknown },
  secondaryCauses: readonly unknown[] = []
) {
  const code: RenderSegmentSpoolFailureCode = phase === "source_fingerprint" ? "segment_source_fingerprint_failed"
    : phase === "source_recheck" ? "segment_source_changed"
      : phase === "producer" ? "segment_producer_failed"
        : phase === "frame_validation" ? "segment_frame_invalid"
          : phase === "encoder" ? "segment_encoder_failed"
            : phase === "deadline" ? "segment_deadline_exceeded"
              : phase === "cancelled" ? "segment_cancelled"
                : phase === "resource" ? "segment_resource_failed"
                  : phase === "store" ? "segment_store_failed" : "segment_checkpoint_failed";
  const evidence: RenderSegmentSpoolFailureEvidence = {
    phase,
    range: range ? { ...range } : null,
    verifiedPrefixSegments,
    retention: { verifiedPrefixPreserved: true, currentTemporaryArtifact: cleanup.outcome === "not_needed" ? "not_started" : cleanup.outcome },
    cleanup: { attempted: cleanup.attempted, outcome: cleanup.outcome },
    ...(primaryCause instanceof LocalMotionJobError ? { resourceCode: primaryCause.code } : {})
  };
  return new RenderSegmentSpoolFailure(code, evidence, primaryCause, [...secondaryCauses, cleanup.cause].filter((cause) => cause !== undefined));
}

export class SegmentSpoolOperationError extends Error {
  constructor(readonly phase: RenderSegmentSpoolPhase, readonly primaryCause: unknown, readonly cleanupCause?: unknown) {
    super(typeof primaryCause === "string" ? primaryCause : "Segment spool operation failed.", { cause: primaryCause });
    this.name = "SegmentSpoolOperationError";
    Object.setPrototypeOf(this, SegmentSpoolOperationError.prototype);
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}
