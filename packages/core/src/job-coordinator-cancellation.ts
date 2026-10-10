import type { MotionJobCoordinatorEvent } from "./job-event-store";
import type { ActiveJob } from "./job-coordinator-execution";
import { persistenceMessage } from "./job-coordinator-support";

/**
 * Persist one accepted cancellation before interrupting the worker that owns the live lease.
 *
 * The caller publishes the returned operation synchronously. Terminal selection then waits for
 * this operation, so the cancellation event cannot follow a terminal event that it preceded.
 */
export async function persistCoordinatorCancellation(
  active: ActiveJob,
  append: (active: ActiveJob, type: MotionJobCoordinatorEvent["type"], data?: Record<string, unknown>) => Promise<void>
): Promise<void> {
  let persistenceFailure: unknown;
  try {
    await active.job.requestCancellation(active.cancellation!);
  } catch (error) {
    persistenceFailure = error;
  }
  try {
    await append(active, "cancel_requested", active.cancellation!);
  } catch (error) {
    persistenceFailure ??= error;
  } finally {
    // This controller belongs to the worker this coordinator started. Stop it even when
    // persistence failed; callers receive the failure rather than a false acknowledgement.
    active.controller.abort(new Error("Motion job cancellation was requested."));
  }
  if (persistenceFailure) active.cancellationFailure = persistenceMessage(persistenceFailure);
}
