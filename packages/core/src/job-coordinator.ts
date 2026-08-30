/**
 * Persistent local coordinator for host-visible jobs.
 *
 * A lease makes work observable, but it cannot accept a stop request or remember how a retry was
 * submitted. This module owns those two responsibilities for one long-lived local host (the debug
 * server, an SDK host, or a CLI daemon). State is durable in the existing lease/record stores and
 * its bounded event log; the in-memory entry contains only the live AbortController and replay
 * capability, neither of which is safe to reconstruct after a process restart.
 */
import { join } from "node:path";
import { motionJobFailure, motionJobFailureFromException, type MotionJobFailure } from "./job-failure";
import type { MotionJobFrameLane } from "./job-frame-lane";
import { MotionJobEventStore, type MotionJobCoordinatorEvent } from "./job-event-store";
import { defaultMotionRuntimeRoot, MotionJobLeaseDirectory } from "./job-lease";
import { assertMotionJobId, mintMotionJobId, MotionJobRegistry } from "./job-registry";
import { motionJobOwnerKey } from "./job-id-file";
import { MotionJobView, type MotionJobStatus } from "./job-view";
import { runInMotionHostJob, MotionHostJob } from "./host-job";
export type { MotionJobCoordinatorEvent } from "./job-event-store";

export interface MotionJobCoordinatorExecution {
  ok: boolean;
  /** True only after an atomic external publication became irreversible. */
  committed?: boolean;
  receiptPath?: string;
  receiptId?: string;
  /** Compact link to direct render producer evidence; the full evidence stays in the receipt. */
  producerEvidence?: { frameLane: MotionJobFrameLane; schema?: string };
  warnings?: string[];
  error?: Partial<MotionJobFailure> & { message: string };
}

export interface MotionJobCoordinatorSubmit {
  jobId?: string;
  callerId: string;
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  /** Bounded, path-free protocol binding written with the durable submitted event. */
  submissionData?: Record<string, unknown>;
  lineage?: { priorJobId?: string; priorReceiptId?: string; retryAttempt?: number };
  /** Events that must exist after submission and before this job is allowed to execute. */
  initialEvents?: Array<{ type: "retry_submitted"; data: Record<string, unknown> }>;
  execute(signal: AbortSignal): Promise<MotionJobCoordinatorExecution>;
}

export interface MotionJobCoordinatorServices {
  leases?: MotionJobLeaseDirectory;
  records?: MotionJobRegistry;
  eventsRoot?: string;
  now?: () => number;
}

export type MotionJobCoordinatorResult<T> = { ok: true; value: T } | { ok: false; code: "job_unknown" | "job_not_visible" | "job_not_retryable" | "job_not_terminal" | "capability_unavailable"; message: string };

interface ActiveJob {
  job: MotionHostJob;
  controller: AbortController;
  execute: MotionJobCoordinatorSubmit["execute"];
  callerId: string;
  events: MotionJobCoordinatorEvent[];
  cancellation?: { requestedBy: string; reason?: string };
  cancellationFailure?: string;
  retryAttempt: number;
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  submissionData?: Record<string, unknown>;
  completion?: Promise<void>;
  eventWrites: Promise<void>;
}

interface ReplayableJob {
  callerId: string;
  execute: MotionJobCoordinatorSubmit["execute"];
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  submissionData?: Record<string, unknown>;
  receiptId?: string;
  retryable: boolean;
  retryAttempt: number;
  terminal: "succeeded" | "failed" | "cancelled";
}

/**
 * One process-owned coordinator. Its process lifetime is intentional: only the owner of an
 * AbortController can truthfully signal the render/process tree it started.
 */
export class MotionJobCoordinator {
  private readonly leases: MotionJobLeaseDirectory;
  private readonly records: MotionJobRegistry;
  private readonly view: MotionJobView;
  private readonly eventStore: MotionJobEventStore;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveJob>();
  private readonly reserved = new Set<string>();
  private readonly replay = new Map<string, ReplayableJob>();

  constructor(services: MotionJobCoordinatorServices = {}) {
    this.leases = services.leases ?? new MotionJobLeaseDirectory();
    this.records = services.records ?? new MotionJobRegistry();
    this.view = new MotionJobView({ leases: this.leases, records: this.records });
    this.eventStore = new MotionJobEventStore(services.eventsRoot ?? join(defaultCoordinatorRoot(), "job-events"));
    this.now = services.now ?? Date.now;
  }

  jobView(): MotionJobView {
    return this.view;
  }

  async submit(input: MotionJobCoordinatorSubmit): Promise<MotionJobCoordinatorResult<{ jobId: string }>> {
    const jobId = input.jobId === undefined ? mintMotionJobId(this.now()) : assertMotionJobId(input.jobId);
    const identity = motionJobOwnerKey(input.callerId, jobId);
    if (this.active.has(identity) || this.reserved.has(identity)) return failure("job_not_terminal", `Motion job ${jobId} is already active.`);
    // Reserve before the first await: concurrent callers cannot both begin this id.
    this.reserved.add(identity);
    let job: MotionHostJob | undefined;
    try {
      let active!: ActiveJob;
      job = await MotionHostJob.begin({
        jobId, callerId: input.callerId, lane: input.lane, ...(input.frameLane ? { frameLane: input.frameLane } : {}), operation: input.operation,
        leases: this.leases, records: this.records, now: this.now,
        onRunning: async () => await this.append(active, "running"),
        ...(input.lineage ? { lineage: input.lineage } : {})
      });
      active = {
        job, controller: new AbortController(), execute: input.execute, callerId: input.callerId, events: [],
        retryAttempt: input.lineage?.retryAttempt ?? 0, lane: input.lane, ...(input.frameLane ? { frameLane: input.frameLane } : {}), operation: input.operation,
        ...(input.submissionData ? { submissionData: structuredClone(input.submissionData) } : {}),
        eventWrites: Promise.resolve()
      };
      // A submit response is only useful if a later request can read at least its first event.
      // Refuse before invoking the worker when the durable event log is unavailable.
      await this.append(active, "submitted", { operation: input.operation, ...(input.submissionData ?? {}), ...(input.lineage ? { lineage: input.lineage } : {}) });
      for (const event of input.initialEvents ?? []) await this.append(active, event.type, event.data);
      this.active.set(identity, active);
      active.completion = this.run(identity, active);
      // No await: submission has a durable identity before expensive work starts.
      void active.completion;
      return { ok: true, value: { jobId } };
    } catch {
      await job?.failed({ error: { code: "capability_unavailable", message: "Motion job event storage is unavailable.", retryable: false } });
      return failure("capability_unavailable", "Motion job event storage is unavailable; no render was started.");
    } finally {
      this.reserved.delete(identity);
    }
  }

  async cancel(input: { jobId: string; callerId: string; reason?: string }): Promise<MotionJobCoordinatorResult<{ job: MotionJobStatus }>> {
    const active = this.active.get(motionJobOwnerKey(input.callerId, input.jobId));
    if (!active) return await this.notActive(input.jobId, input.callerId);
    if (active.callerId !== input.callerId) return failure("job_not_visible", `Motion job ${input.jobId} belongs to another caller.`);
    if (!active.cancellation) {
      active.cancellation = { requestedBy: input.callerId, ...(input.reason ? { reason: input.reason } : {}) };
      let persistenceFailure: unknown;
      try {
        await active.job.requestCancellation(active.cancellation);
      } catch (error) {
        persistenceFailure = error;
      }
      try {
        await this.append(active, "cancel_requested", active.cancellation);
      } catch (error) {
        persistenceFailure ??= error;
      } finally {
        // This controller belongs to the worker this coordinator started. Stop it even when
        // persistence failed; callers receive the failure rather than a false acknowledgement.
        active.controller.abort(new Error("Motion job cancellation was requested."));
      }
      if (persistenceFailure) {
        active.cancellationFailure = persistenceMessage(persistenceFailure);
        return failure("capability_unavailable", `Motion job ${input.jobId} was signalled to stop, but cancellation evidence could not be persisted: ${active.cancellationFailure}`);
      }
    }
    if (active.cancellationFailure) return failure("capability_unavailable", `Motion job ${input.jobId} was signalled to stop, but cancellation evidence could not be persisted: ${active.cancellationFailure}`);
    const status = await this.view.get({ jobId: input.jobId, callerId: input.callerId });
    return status.ok ? { ok: true, value: { job: status.job } } : failure(status.code === "job_expired" ? "job_unknown" : status.code, `Motion job ${input.jobId} could not be read.`);
  }

  async retry(input: { jobId: string; callerId: string; newJobId?: string }): Promise<MotionJobCoordinatorResult<{ jobId: string; priorJobId: string }>> {
    const source = this.replay.get(motionJobOwnerKey(input.callerId, input.jobId));
    if (!source) return await this.notRetryable(input.jobId, input.callerId);
    if (source.callerId !== input.callerId) return failure("job_not_visible", `Motion job ${input.jobId} belongs to another caller.`);
    if (source.terminal !== "failed" || !source.retryable) return failure("job_not_retryable", `Motion job ${input.jobId} is not a retryable failed run.`);
    if (input.newJobId === input.jobId) return failure("job_not_retryable", "A retry must use a distinct job id so its source evidence remains immutable.");
    const next = await this.submit({
      ...(input.newJobId ? { jobId: input.newJobId } : {}), callerId: source.callerId, lane: source.lane, ...(source.frameLane ? { frameLane: source.frameLane } : {}), operation: source.operation,
      ...(source.submissionData ? { submissionData: source.submissionData } : {}),
      lineage: { priorJobId: input.jobId, ...(source.receiptId ? { priorReceiptId: source.receiptId } : {}), retryAttempt: source.retryAttempt + 1 },
      initialEvents: [{ type: "retry_submitted", data: { priorJobId: input.jobId, retryAttempt: source.retryAttempt + 1 } }],
      execute: source.execute
    });
    if (!next.ok) return next;
    return { ok: true, value: { jobId: next.value.jobId, priorJobId: input.jobId } };
  }

  async events(input: { jobId: string; callerId: string; after?: number }): Promise<MotionJobCoordinatorResult<{ events: MotionJobCoordinatorEvent[] }>> {
    const active = this.active.get(motionJobOwnerKey(input.callerId, input.jobId));
    if (active && active.callerId !== input.callerId) return failure("job_not_visible", `Motion job ${input.jobId} belongs to another caller.`);
    let terminalState: string | undefined;
    let allowLegacyEvents = false;
    if (!active) {
      const status = await this.view.get({ jobId: input.jobId, callerId: input.callerId });
      if (!status.ok) return failure(status.code === "job_expired" ? "job_unknown" : status.code, `Motion job ${input.jobId} could not be read.`);
      if (status.job.lifecycle === "ended") {
        terminalState = status.job.state;
        allowLegacyEvents = await this.records.hasExclusiveOwnedLegacyEventRecord({ jobId: input.jobId, callerId: input.callerId });
      }
    }
    const events = active?.events ?? await this.readEvents(input.callerId, input.jobId, allowLegacyEvents);
    if (!events) return failure("capability_unavailable", `Durable event evidence for Motion job ${input.jobId} is unavailable.`);
    if (terminalState && events.at(-1)?.type !== terminalState) {
      return failure("capability_unavailable", `Durable event evidence for Motion job ${input.jobId} has no terminal ${terminalState} transition.`);
    }
    return { ok: true, value: { events: events.filter((event) => event.seq > (input.after ?? 0)) } };
  }

  private async run(identity: string, active: ActiveJob): Promise<void> {
    let execution: MotionJobCoordinatorExecution | undefined;
    try {
      // `render.final` promotes this host job only when the shared governor admits its first
      // expensive operation. Do not promote it merely because the coordinator invoked the
      // callback: that callback may still be waiting on the governor, and calling it `running`
      // would make the live API lie.
      execution = await runInMotionHostJob(active.job, async () => await active.execute(active.controller.signal));
      if (active.controller.signal.aborted && execution.committed !== true) {
        await this.append(active, "cancelled", active.cancellation);
        await active.job.cancelled({ cancellation: active.cancellation ?? { requestedBy: active.callerId }, ...(execution.warnings ? { warnings: execution.warnings } : {}) });
        this.replay.set(identity, replayable(active, { receiptId: execution.receiptId, retryable: false, terminal: "cancelled" }));
      } else if (execution.ok) {
        await this.append(active, "succeeded", successEventData(execution));
        await active.job.succeeded({ ...(execution.receiptPath ? { receiptPath: execution.receiptPath } : {}), ...(execution.receiptId ? { receiptId: execution.receiptId } : {}), ...(execution.producerEvidence ? { producerEvidence: execution.producerEvidence } : {}), ...(execution.warnings ? { warnings: execution.warnings } : {}) });
        this.replay.set(identity, replayable(active, { receiptId: execution.receiptId, retryable: false, terminal: "succeeded" }));
      } else {
        const error = motionJobFailure(execution.error, { code: "invalid_args", message: "Motion job failed." });
        await this.append(active, "failed", failureEventData(error));
        await active.job.failed({
          ...(execution.receiptPath ? { receiptPath: execution.receiptPath } : {}),
          ...(execution.warnings ? { warnings: execution.warnings } : {}),
          error
        });
        this.replay.set(identity, replayable(active, { receiptId: execution.receiptId, retryable: error.retryable, terminal: "failed" }));
      }
    } catch (error) {
      if (active.controller.signal.aborted) {
        // The event store can disappear after an accepted cancellation. End the worker truthfully
        // even then; `events()` fails closed instead of replaying a partial log as complete.
        await this.append(active, "cancelled", active.cancellation).catch(() => {});
        await active.job.cancelled({ cancellation: active.cancellation ?? { requestedBy: active.callerId } });
        this.replay.set(identity, replayable(active, { retryable: false, terminal: "cancelled" }));
      } else {
        const failure = motionJobFailureFromException(error, {
          code: "invalid_args", message: "Motion job execution failed.", retryable: false
        });
        await this.append(active, "failed", failureEventData(failure)).catch(() => {});
        await active.job.failed({ error: failure });
        this.replay.set(identity, replayable(active, { retryable: failure.retryable, terminal: "failed" }));
      }
    } finally {
      this.active.delete(identity);
    }
  }

  private async append(active: ActiveJob, type: MotionJobCoordinatorEvent["type"], data?: Record<string, unknown>): Promise<void> {
    const write = active.eventWrites.catch(() => {}).then(async () => {
      const eventData = active.frameLane ? { frameLane: active.frameLane, ...(data ?? {}) } : data;
      const event: MotionJobCoordinatorEvent = { schema: "shellx-motion/job-event@1", seq: active.events.length + 1, atMs: this.now(), type, ...(eventData ? { data: eventData } : {}) };
      const next = [...active.events, event];
      await this.eventStore.write({ callerId: active.callerId, jobId: active.job.jobId, events: next });
      // In-memory events are a read-through of committed evidence, never a speculative queue.
      active.events.push(event);
    });
    active.eventWrites = write;
    await write;
  }

  private async readEvents(callerId: string, jobId: string, allowLegacy = false): Promise<MotionJobCoordinatorEvent[] | null> {
    return await this.eventStore.read({ callerId, jobId, allowLegacy });
  }

  private async notActive(jobId: string, callerId: string): Promise<MotionJobCoordinatorResult<{ job: MotionJobStatus }>> {
    const status = await this.view.get({ jobId, callerId });
    if (!status.ok) return failure(status.code === "job_expired" ? "job_unknown" : status.code, `Motion job ${jobId} could not be read.`);
    return failure("job_not_terminal", `Motion job ${jobId} has already settled and cannot be cancelled.`);
  }

  private async notRetryable(jobId: string, callerId: string): Promise<MotionJobCoordinatorResult<{ jobId: string; priorJobId: string }>> {
    const status = await this.view.get({ jobId, callerId });
    if (!status.ok) return failure(status.code === "job_expired" ? "job_unknown" : status.code, `Motion job ${jobId} could not be read.`);
    return failure("job_not_retryable", `Motion job ${jobId} has no replay capability in this coordinator session.`);
  }
}

function defaultCoordinatorRoot(): string {
  const explicit = process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT?.trim();
  if (explicit) return explicit;
  return defaultMotionRuntimeRoot();
}

function failure<T>(code: Exclude<MotionJobCoordinatorResult<T>, { ok: true }> ["code"], message: string): MotionJobCoordinatorResult<T> {
  return { ok: false, code, message };
}

function replayable(active: ActiveJob, detail: Pick<ReplayableJob, "receiptId" | "retryable" | "terminal">): ReplayableJob {
  return {
    callerId: active.callerId,
    execute: active.execute,
    lane: active.lane,
    ...(active.frameLane ? { frameLane: active.frameLane } : {}),
    operation: active.operation,
    ...(active.submissionData ? { submissionData: active.submissionData } : {}),
    retryAttempt: active.retryAttempt,
    ...detail
  };
}

function successEventData(execution: MotionJobCoordinatorExecution): Record<string, unknown> | undefined {
  const data = {
    ...(execution.receiptId ? { receiptId: execution.receiptId } : {}),
    ...(execution.producerEvidence ? { producerEvidence: execution.producerEvidence } : {})
  };
  return Object.keys(data).length > 0 ? data : undefined;
}

function failureEventData(error: MotionJobFailure): Record<string, unknown> {
  return {
    code: error.code,
    retryable: error.retryable,
    ...(error.remedy ? { remedy: error.remedy } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {})
  };
}

function persistenceMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 256 ? `${message.slice(0, 253)}...` : message;
}
