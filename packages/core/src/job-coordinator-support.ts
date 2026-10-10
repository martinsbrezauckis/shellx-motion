/** Internal event/result projections shared by the persistent job coordinator. */
import type {
  ActiveJob,
  MotionJobCoordinatorExecution,
} from "./job-coordinator-execution";
import type { MotionJobCoordinatorResult } from "./job-coordinator";
import type { MotionJobFailure } from "./job-failure";
import { defaultMotionRuntimeRoot } from "./job-lease";
import type { MotionCoordinatorPresence } from "./job-coordinator-planned-submit";
import type { MotionJobView } from "./job-view";

export function defaultCoordinatorRoot(): string {
  const explicit = process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT?.trim();
  return explicit || defaultMotionRuntimeRoot();
}

export function coordinatorFailure<T>(code: Exclude<MotionJobCoordinatorResult<T>, { ok: true }> ["code"], message: string): MotionJobCoordinatorResult<T> {
  return { ok: false, code, message };
}

type PlannedActiveJob = ActiveJob & { renderPlan?: { readonly fingerprint: string } };

export async function readCoordinatorPlannedJobState(active: ReadonlyMap<string, PlannedActiveJob>, view: MotionJobView, jobId: string, callerId: string, identity: string): Promise<MotionCoordinatorPresence> {
  const current = active.get(identity);
  if (current) {
    // endAcknowledged publishes the terminal record immediately before claim settlement removes
    // the in-memory entry.  Preserve live visibility, but expose that durable terminal fact so a
    // compatible legacy same-id submission can wait for release instead of treating it as active.
    const status = await view.get({ jobId, callerId });
    if (status.ok && status.job.lifecycle === "ended") {
      return { kind: "present", terminal: true, ...(status.job.planFingerprint ? { planFingerprint: status.job.planFingerprint } : {}) };
    }
    return { kind: "present", terminal: false, ...(current.renderPlan ? { planFingerprint: current.renderPlan.fingerprint } : {}) };
  }
  try {
    const status = await view.get({ jobId, callerId });
    return status.ok
      ? { kind: "present", terminal: status.job.lifecycle === "ended", ...(status.job.planFingerprint ? { planFingerprint: status.job.planFingerprint } : {}) }
      : { kind: "missing" };
  } catch {
    return { kind: "unavailable" };
  }
}

export function successEventData(execution: MotionJobCoordinatorExecution): Record<string, unknown> | undefined {
  const data = {
    ...(execution.receiptId ? { receiptId: execution.receiptId } : {}),
    ...(execution.producerEvidence ? { producerEvidence: execution.producerEvidence } : {})
  };
  return Object.keys(data).length > 0 ? data : undefined;
}

export function failureEventData(error: MotionJobFailure, execution?: MotionJobCoordinatorExecution): Record<string, unknown> {
  return {
    code: error.code, retryable: error.retryable,
    ...(error.remedy ? { remedy: error.remedy } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(execution?.committed === true ? { committed: true } : {})
  };
}

export function persistenceMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 256 ? `${message.slice(0, 253)}...` : message;
}
