/** Preserves primary outcomes while reaping every admitted segmented resource. */
import type { LocalMotionJobError } from "@shellx-motion/core";
import { SegmentedFinalAdapterFailure } from "./segmented-final-adapter-types.js";
import type { SegmentedFinalAdmittedValue } from "./segmented-final-adapter-executor.js";

export async function settleSegmentedFinalAdmittedCleanup(input: {
  result: SegmentedFinalAdmittedValue | undefined;
  thrown: unknown;
  releases: readonly Promise<void>[];
}): Promise<SegmentedFinalAdmittedValue> {
  const releases = await Promise.allSettled(input.releases);
  const cleanupCauses = releases.flatMap((release) => release.status === "rejected" ? [release.reason] : []);
  if (input.thrown !== undefined) {
    if (cleanupCauses.length > 0) {
      // Keep a typed governor error outermost so the adapter preserves terminal
      // cancellation/deadline/RSS classification while retaining both cleanups.
      Object.defineProperty(input.thrown, "segmentedFinalCleanupCauses", {
        value: Object.freeze([...cleanupCauses]), configurable: false, enumerable: false, writable: false
      });
    }
    throw input.thrown;
  }
  if (!input.result) throw new Error("Segmented final operation ended without a result.");
  if (cleanupCauses.length === 0) return input.result;
  if (!input.result.ok) {
    return {
      ok: false,
      failure: new SegmentedFinalAdapterFailure(
        input.result.failure.code,
        input.result.failure.evidence,
        input.result.failure.primaryCause,
        [...input.result.failure.cleanupCauses, ...cleanupCauses]
      )
    };
  }
  throw new AggregateError(cleanupCauses, "Segmented final completed but admitted resource cleanup failed.");
}

/** The adapter reads this non-enumerable field only for a typed job failure. */
export function segmentedFinalCleanupCauses(error: LocalMotionJobError): readonly unknown[] {
  return (error as LocalMotionJobError & { segmentedFinalCleanupCauses?: readonly unknown[] }).segmentedFinalCleanupCauses ?? [];
}
