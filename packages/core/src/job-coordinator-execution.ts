import type { MotionJobFailure } from "./job-failure";
import { motionJobFailure, motionJobFailureFromException } from "./job-failure";
import type { MotionJobFrameLane } from "./job-frame-lane";
import { runInMotionHostJob, type MotionHostJob, type MotionHostJobEnd } from "./host-job";
import type { MotionJobCoordinatorEvent } from "./job-event-store";
import { failureEventData, successEventData } from "./job-coordinator-support";

export interface MotionJobCoordinatorExecution {
  ok: boolean;
  /** Literal failure uncertainty after external publication became irreversible or may have occurred. */
  committed?: true;
  receiptPath?: string;
  receiptId?: string;
  /** Compact link to direct render producer evidence; the full evidence stays in the receipt. */
  producerEvidence?: { frameLane: MotionJobFrameLane; schema?: string };
  warnings?: string[];
  error?: Partial<MotionJobFailure> & { message: string };
}

/** Private callback owned by the coordinator that started this exact host job. */
interface MotionJobCoordinatorExecuteSignature {
  execute(signal: AbortSignal): Promise<MotionJobCoordinatorExecution>;
}

/** Preserves the historical method callback variance without importing the coordinator facade. */
export type MotionJobCoordinatorExecute = MotionJobCoordinatorExecuteSignature["execute"];

/**
 * The execution kernel's live state. Coordinator-only submission and render-plan bindings stay
 * at its caller boundary so this module cannot observe or act on them.
 */
export interface ActiveJob {
  job: MotionHostJob;
  controller: AbortController;
  execute: MotionJobCoordinatorExecute;
  callerId: string;
  events: MotionJobCoordinatorEvent[];
  cancellation?: { requestedBy: string; reason?: string };
  cancellationFailure?: string;
  /** Cancellation evidence fence published before its first await; terminal selection waits for it. */
  cancellationOperation?: Promise<void>;
  retryAttempt: number;
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  /** Set only after the durable executing phase; enables same-coordinator idempotent observation. */
  liveReplayable?: true;
  /** Set synchronously before terminal claim advancement, so no held claimant can be replayed mid-settlement. */
  settling?: true;
  completion?: Promise<void>;
  eventWrites: Promise<void>;
}

/** Process-local replay state produced only after a durable terminal transition. */
export interface ReplayableJob {
  callerId: string;
  execute: MotionJobCoordinatorExecute;
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  receiptId?: string;
  retryable: boolean;
  retryAttempt: number;
  terminal: "succeeded" | "failed" | "cancelled";
}

export interface MotionCoordinatorExecutionContext {
  append(active: ActiveJob, type: MotionJobCoordinatorEvent["type"], data?: Record<string, unknown>): Promise<void>;
  claimHeld(identity: string, active: ActiveJob): Promise<boolean>;
  advanceClaim(identity: string, phase: "executing" | "settling" | "terminal_evidence", active: ActiveJob): Promise<boolean>;
  releaseCapacityWithoutRecord(active: ActiveJob): Promise<void>;
  releaseTerminalClaim(identity: string, active: ActiveJob): Promise<boolean>;
  /** Existing coordinator-owned V1 evidence projection; the kernel receives no plan binding. */
  terminalEvidenceDetail(active: ActiveJob, outcome: "succeeded" | "failed" | "cancelled", execution?: MotionJobCoordinatorExecution): Readonly<Pick<MotionHostJobEnd, "evidence">>;
  publishReplay(identity: string, job: ReplayableJob): void;
}

export async function runCoordinatorExecution(context: MotionCoordinatorExecutionContext, identity: string, active: ActiveJob): Promise<void> {
  try {
    if (!await context.advanceClaim(identity, "executing", active)) {
      // No execution began and the claim transition itself was not durable. Do not invent a
      // terminal fact under uncertain authority; release only this host capacity lease.
      await context.releaseCapacityWithoutRecord(active);
      return;
    }
    // This marker permits only this coordinator's exact duplicate request to observe a live
    // accepted execution. Settlement clears it synchronously before any durable I/O.
    active.liveReplayable = true;
    // Cancellation can win while the durable executing-claim transition is in flight. Wait for
    // its published evidence/abort fence before starting a worker; no user executor may receive
    // an already-aborted signal merely because that claim write was slow.
    if (active.cancellationOperation) await active.cancellationOperation.catch(() => {});
    if (active.controller.signal.aborted) {
      await settle(context, identity, active, "cancelled", active.cancellation, cancelledDetail(context, active), {
        retryable: false, terminal: "cancelled"
      });
      return;
    }
    const execution = await runInMotionHostJob(active.job, async () => await active.execute(active.controller.signal));
    // A cancellation that won before terminal selection persists its own intent/event and signals
    // the worker before we choose an outcome. This keeps the cancellation event ordered before the
    // terminal event even when a worker completed while that durable write was in flight.
    if (active.cancellationOperation) await active.cancellationOperation.catch(() => {});
    if (active.controller.signal.aborted && execution.committed !== true) {
      await settle(context, identity, active, "cancelled", active.cancellation, cancelledDetail(context, active, execution), {
        receiptId: execution.receiptId, retryable: false, terminal: "cancelled"
      });
    } else if (execution.ok) {
      await settle(context, identity, active, "succeeded", successEventData(execution), successDetail(context, active, execution), {
        receiptId: execution.receiptId, retryable: false, terminal: "succeeded"
      });
    } else {
      const error = motionJobFailure(execution.error, { code: "invalid_args", message: "Motion job failed." });
      await settle(context, identity, active, "failed", failureEventData(error, execution), failureDetail(context, active, error, execution), {
        // A producer may truthfully report a retryable error, but a committed failure is a
        // stop-and-reconcile fact and must never mint this process's replay capability.
        receiptId: execution.receiptId, retryable: execution.committed === true ? false : error.retryable, terminal: "failed"
      });
    }
  } catch (error) {
    // The execute callback may reject in response to the cancellation signal. Preserve the same
    // pre-terminal fence on that path before choosing cancelled versus an ordinary failure.
    if (active.cancellationOperation) await active.cancellationOperation.catch(() => {});
    if (active.controller.signal.aborted) {
      await settle(context, identity, active, "cancelled", active.cancellation, {
        cancellation: active.cancellation ?? { requestedBy: active.callerId }, ...context.terminalEvidenceDetail(active, "cancelled")
      }, { retryable: false, terminal: "cancelled" });
    } else {
      const failure = motionJobFailureFromException(error, { code: "invalid_args", message: "Motion job execution failed.", retryable: false });
      await settle(context, identity, active, "failed", failureEventData(failure), {
        error: failure, ...context.terminalEvidenceDetail(active, "failed")
      }, { retryable: failure.retryable, terminal: "failed" });
    }
  }
}

async function settle(
  context: MotionCoordinatorExecutionContext,
  identity: string,
  active: ActiveJob,
  outcome: "succeeded" | "failed" | "cancelled",
  eventData: Record<string, unknown> | undefined,
  detail: MotionHostJobEnd,
  replay: Pick<ReplayableJob, "receiptId" | "retryable" | "terminal">
): Promise<void> {
  // A failed durable phase advance must remain visibly non-replayable. Set this in memory before
  // awaiting it so neither a local nor a sibling submission can infer a stable live outcome.
  active.settling = true;
  active.liveReplayable = undefined;
  // Claim this irreversible transition before terminal event I/O. A peer may replay an accepted
  // local execution, but no held claimant is replayable while terminal evidence is uncertain.
  if (!await context.advanceClaim(identity, "settling", active)) {
    await context.releaseCapacityWithoutRecord(active);
    return;
  }
  try {
    await context.append(active, outcome, eventData);
  } catch {
    // Free host capacity but retain the claim: there is no durable terminal event to replay.
    await context.releaseCapacityWithoutRecord(active);
    return;
  }
  if (!await context.advanceClaim(identity, "terminal_evidence", active)) {
    await context.releaseCapacityWithoutRecord(active);
    return;
  }
  // The record write itself is claim-guarded. If authority is lost, ending still frees capacity.
  if (!await context.claimHeld(identity, active)) {
    await context.releaseCapacityWithoutRecord(active);
    return;
  }
  if (!await active.job.endAcknowledged(outcome, detail)) return;
  if (!await context.releaseTerminalClaim(identity, active)) return;
  context.publishReplay(identity, replayable(active, replay));
}

function replayable(active: ActiveJob, detail: Pick<ReplayableJob, "receiptId" | "retryable" | "terminal">): ReplayableJob {
  return {
    callerId: active.callerId,
    execute: active.execute,
    lane: active.lane,
    ...(active.frameLane ? { frameLane: active.frameLane } : {}),
    operation: active.operation,
    retryAttempt: active.retryAttempt,
    ...detail
  };
}

function cancelledDetail(context: MotionCoordinatorExecutionContext, active: ActiveJob, execution?: MotionJobCoordinatorExecution): MotionHostJobEnd {
  return {
    cancellation: active.cancellation ?? { requestedBy: active.callerId },
    ...(execution?.receiptId ? { receiptId: execution.receiptId } : {}),
    ...(execution?.producerEvidence ? { producerEvidence: execution.producerEvidence } : {}),
    ...(execution?.warnings ? { warnings: execution.warnings } : {}),
    ...context.terminalEvidenceDetail(active, "cancelled", execution)
  };
}

function successDetail(context: MotionCoordinatorExecutionContext, active: ActiveJob, execution: MotionJobCoordinatorExecution): MotionHostJobEnd {
  return {
    ...(execution.receiptPath ? { receiptPath: execution.receiptPath } : {}),
    ...(execution.receiptId ? { receiptId: execution.receiptId } : {}),
    ...(execution.producerEvidence ? { producerEvidence: execution.producerEvidence } : {}),
    ...(execution.warnings ? { warnings: execution.warnings } : {}),
    ...context.terminalEvidenceDetail(active, "succeeded", execution)
  };
}

function failureDetail(context: MotionCoordinatorExecutionContext, active: ActiveJob, error: MotionJobFailure, execution: MotionJobCoordinatorExecution): MotionHostJobEnd {
  return {
    ...(execution.receiptPath ? { receiptPath: execution.receiptPath } : {}),
    ...(execution.receiptId ? { receiptId: execution.receiptId } : {}),
    ...(execution.producerEvidence ? { producerEvidence: execution.producerEvidence } : {}),
    ...(execution.warnings ? { warnings: execution.warnings } : {}),
    ...(execution.committed === true ? { committed: true } : {}),
    error, ...context.terminalEvidenceDetail(active, "failed", execution)
  };
}
