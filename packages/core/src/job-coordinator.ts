/**
 * Persistent local coordinator for host-visible jobs.
 *
 * A lease makes work observable, but it cannot accept a stop request or remember how a retry was
 * submitted. This module owns those two responsibilities for one long-lived local host (the debug
 * server, an SDK host, or a CLI daemon). State is durable in the existing lease/record stores and
 * its bounded event log; the in-memory entry contains only the live AbortController and replay
 * capability, neither of which is safe to reconstruct after a process restart.
 */
import { dirname, join } from "node:path";
import type { MotionJobFrameLane } from "./job-frame-lane";
import { MotionJobEventStore, type MotionJobCoordinatorEvent } from "./job-event-store";
import { MotionJobLeaseDirectory } from "./job-lease";
import { assertMotionJobId, mintMotionJobId, MotionJobRegistry, type MotionJobRetryLineage } from "./job-registry";
import { motionJobOwnerKey } from "./job-id-file";
import { MotionJobView, type MotionJobStatus } from "./job-view";
import { MotionHostJob } from "./host-job";
import { MotionJobIdentityClaimHandle, MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { MotionCoordinatorClaimLifecycle } from "./job-coordinator-claim-lifecycle";
import {
  runCoordinatorExecution,
  type ActiveJob as ExecutionActiveJob,
  type MotionJobCoordinatorExecution,
  type ReplayableJob as ExecutionReplayableJob
} from "./job-coordinator-execution";
import { coordinatorTerminalEvidenceDetail } from "./job-coordinator-terminal-evidence";
import { persistCoordinatorCancellation } from "./job-coordinator-cancellation";
import { MotionJobCoordinatorPlannedSubmit, submittedEventData } from "./job-coordinator-planned-submit";
import { isMotionJobRecordText, MOTION_JOB_RECORD_MAX_CANCELLATION_REASON_CHARS } from "./job-record-contract";
import { coordinatorFailure as failure, defaultCoordinatorRoot, readCoordinatorPlannedJobState } from "./job-coordinator-support";
import { MotionRenderAdmissionStore } from "./render-admission-store";
import type { MotionRenderPlan } from "./render-plan";
import { MotionRenderPlanStore } from "./render-plan-store";
export type { MotionJobCoordinatorEvent } from "./job-event-store";
export type { MotionJobCoordinatorExecution } from "./job-coordinator-execution";

/** Public coordinator facade over the V2-blind execution state. */
export interface ActiveJob extends ExecutionActiveJob {
  submissionData?: Record<string, unknown>;
  renderPlan?: MotionRenderPlan;
}

/** Public coordinator facade for retained retry/replay state. */
export interface ReplayableJob extends ExecutionReplayableJob {
  submissionData?: Record<string, unknown>;
  renderPlan?: MotionRenderPlan;
}

export interface MotionJobCoordinatorSubmit {
  jobId?: string;
  callerId: string;
  lane: string;
  frameLane?: MotionJobFrameLane;
  operation: string;
  /** Bounded, path-free protocol binding written with the durable submitted event. */
  submissionData?: Record<string, unknown>;
  /** Host-derived V1 final-render identity, bound before events; never a path-bearing request. */
  renderPlan?: MotionRenderPlan;
  lineage?: MotionJobRetryLineage;
  /** Events that must exist after submission and before this job is allowed to execute. */
  initialEvents?: Array<{ type: "retry_submitted"; data: Record<string, unknown> }>;
  execute(signal: AbortSignal): Promise<MotionJobCoordinatorExecution>;
}

export interface MotionJobCoordinatorServices {
  leases?: MotionJobLeaseDirectory;
  records?: MotionJobRegistry;
  eventsRoot?: string;
  /** Trusted host-owned write-once admission class store. */
  renderAdmissions?: MotionRenderAdmissionStore;
  /** Trusted host-owned immutable-plan store. */
  renderPlans?: MotionRenderPlanStore;
  /** @internal Durable coordinator identity authority; never part of a public render request. */
  identityClaims?: MotionJobIdentityClaimStore;
  now?: () => number;
}
export type MotionJobCoordinatorResult<T> = { ok: true; value: T } | { ok: false; code: "job_unknown" | "job_not_visible" | "job_not_retryable" | "job_not_terminal" | "job_id_conflict" | "job_plan_invalid" | "job_plan_unresolved" | "capability_unavailable"; message: string };

export interface MotionJobCoordinatorSubmitValue {
  jobId: string;
  /** True only when this exact immutable planned submission was already accepted. */
  replayed?: true;
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
  private readonly planned: MotionJobCoordinatorPlannedSubmit;
  private readonly claimLifecycle: MotionCoordinatorClaimLifecycle;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveJob>();
  private readonly replay = new Map<string, ReplayableJob>();

  constructor(services: MotionJobCoordinatorServices = {}) {
    const coordinatorRoot = services.eventsRoot ? dirname(services.eventsRoot) : defaultCoordinatorRoot();
    this.leases = services.leases ?? new MotionJobLeaseDirectory();
    this.records = services.records ?? new MotionJobRegistry();
    this.view = new MotionJobView({ leases: this.leases, records: this.records });
    this.eventStore = new MotionJobEventStore(services.eventsRoot ?? join(coordinatorRoot, "job-events"));
    const claims = services.identityClaims ?? new MotionJobIdentityClaimStore({ claimRoot: join(coordinatorRoot, "job-identity-claims") });
    this.claimLifecycle = new MotionCoordinatorClaimLifecycle(this.active);
    this.planned = new MotionJobCoordinatorPlannedSubmit(services.renderPlans ?? new MotionRenderPlanStore({ planRoot: join(coordinatorRoot, "render-plans") }), services.renderAdmissions ?? new MotionRenderAdmissionStore({ admissionRoot: join(coordinatorRoot, "render-admissions") }), claims, {
      readJobState: async (jobId, callerId, identity) => await readCoordinatorPlannedJobState(this.active, this.view, jobId, callerId, identity),
      readSubmittedAcceptance: async (jobId, callerId) => await this.readSubmittedAcceptance(jobId, callerId),
      isLocallyReplayablePlanned: async (identity, planFingerprint) => {
        const active = this.active.get(identity);
        if (active?.renderPlan?.fingerprint !== planFingerprint || active.liveReplayable !== true || active.settling === true) return false;
        if (!await this.claimLifecycle.held(identity, active)) return false;
        // A terminal transition may have started while the durable held assertion was in flight.
        return active.liveReplayable === true && active.settling !== true && active.renderPlan?.fingerprint === planFingerprint;
      },
      submitReserved: async (input, jobId, identity, renderPlan, claim) => await this.submitReserved(input, jobId, identity, renderPlan, claim),
      retainUnresolvedClaim: (identity, claim) => this.claimLifecycle.retain(identity, claim)
    });
    this.now = services.now ?? Date.now;
  }

  jobView(): MotionJobView {
    return this.view;
  }

  async submit(input: MotionJobCoordinatorSubmit): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    const jobId = input.jobId === undefined ? mintMotionJobId(this.now()) : assertMotionJobId(input.jobId);
    const identity = motionJobOwnerKey(input.callerId, jobId);
    if (input.renderPlan !== undefined) return await this.planned.submit(input, jobId, identity);
    return await this.planned.submitPlanless(input, jobId, identity);
  }

  /** Called only while the caller-qualified identity is reserved. */
  private async submitReserved(
    input: MotionJobCoordinatorSubmit,
    jobId: string,
    identity: string,
    renderPlan: MotionRenderPlan | undefined,
    claim: MotionJobIdentityClaimHandle
  ): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    // Ownership transfers before the first await. From here the coordinator settles or retains it.
    this.claimLifecycle.retain(identity, claim);
    let job: MotionHostJob | undefined;
    try {
      let active!: ActiveJob;
      if (!await this.claimLifecycle.held(identity)) throw new Error("Motion job identity claim is unavailable.");
      job = await MotionHostJob.begin({
        jobId, callerId: input.callerId, lane: input.lane, ...(input.frameLane ? { frameLane: input.frameLane } : {}), operation: input.operation,
        ...(renderPlan ? { planFingerprint: renderPlan.fingerprint } : {}),
        leases: this.leases, records: this.records, now: this.now,
        onRunning: async () => await this.append(active, "running"),
        ...(input.lineage ? { lineage: input.lineage } : {})
      });
      if (!job.hasPublishedLease()) throw new Error("Motion host lease publication is unavailable.");
      if (!await this.claimLifecycle.advance(identity, "host_lease_published")) throw new Error("Motion job identity claim was lost after host lease publication.");
      active = {
        job, controller: new AbortController(), execute: input.execute, callerId: input.callerId, events: [],
        retryAttempt: input.lineage?.retryAttempt ?? 0, lane: input.lane, ...(input.frameLane ? { frameLane: input.frameLane } : {}), operation: input.operation,
        ...(input.submissionData ? { submissionData: structuredClone(input.submissionData) } : {}),
        ...(renderPlan ? { renderPlan } : {}),
        eventWrites: Promise.resolve()
      };
      // A submit response is only useful if a later request can read at least its first event.
      // Refuse before invoking the worker when the durable event log is unavailable.
      await this.append(active, "submitted", submittedEventData(input, renderPlan));
      for (const event of input.initialEvents ?? []) await this.append(active, event.type, event.data);
      if (!await this.claimLifecycle.advance(identity, "submitted", active)) throw new Error("Motion job identity claim was lost after submission evidence.");
      this.active.set(identity, active);
      this.claimLifecycle.startHeartbeat(identity);
      active.completion = this.run(identity, active);
      // No await: submission has a durable identity before expensive work starts.
      void active.completion;
      return { ok: true, value: { jobId } };
    } catch {
      // Without a held identity authority the coordinator cannot truthfully publish an outcome.
      // Free only the exact host lease; keep the durable claim fail-closed and write no record.
      await job?.releaseCapacityWithoutRecord();
      return failure("capability_unavailable", "Motion job event storage is unavailable; no render was started.");
    }
  }

  async cancel(input: { jobId: string; callerId: string; reason?: string }): Promise<MotionJobCoordinatorResult<{ job: MotionJobStatus }>> {
    const active = this.active.get(motionJobOwnerKey(input.callerId, input.jobId));
    if (!active) return await this.notActive(input.jobId, input.callerId);
    if (active.callerId !== input.callerId) return failure("job_not_visible", `Motion job ${input.jobId} belongs to another caller.`);
    // `settling` is the terminal linearization boundary. It is set synchronously before terminal
    // evidence I/O, so a late caller must observe the settled record rather than mutate its event
    // history or signal a worker whose outcome has already been selected.
    if (active.settling) {
      await active.completion?.catch(() => {});
      return await this.notActive(input.jobId, input.callerId);
    }
    if (!active.cancellation) {
      // Direct Core callers do not share Debug's transport validator. Preserve the terminal fact
      // while omitting a reason that cannot round-trip through the durable text contract.
      const reason = isMotionJobRecordText(input.reason, MOTION_JOB_RECORD_MAX_CANCELLATION_REASON_CHARS)
        ? input.reason
        : undefined;
      active.cancellation = { requestedBy: input.callerId, ...(reason ? { reason } : {}) };
      // This promise is published before its first await. Execution waits for it before selecting
      // a terminal outcome, so a cancellation that won this boundary writes its event before the
      // terminal event instead of racing behind it.
      active.cancellationOperation = persistCoordinatorCancellation(active, async (job, type, data) => await this.append(job, type, data));
    }
    const cancellationOperation = active.cancellationOperation;
    if (cancellationOperation) await cancellationOperation.catch(() => {});
    if (active.cancellationFailure) return failure("capability_unavailable", `Motion job ${input.jobId} was signalled to stop, but cancellation evidence could not be persisted: ${active.cancellationFailure}`);
    const status = await this.view.get({ jobId: input.jobId, callerId: input.callerId });
    return status.ok ? { ok: true, value: { job: status.job } } : failure(status.code === "job_expired" ? "job_unknown" : status.code, `Motion job ${input.jobId} could not be read.`);
  }

  async retry(input: { jobId: string; callerId: string; newJobId?: string }): Promise<MotionJobCoordinatorResult<{ jobId: string; priorJobId: string }>> {
    const identity = motionJobOwnerKey(input.callerId, input.jobId);
    // A terminal record becomes visible during endAcknowledged(), just before the coordinator
    // releases the identity claim and publishes this process-local retry capability.  Wait for
    // that final settlement when this coordinator still owns the live run; never synthesize a
    // retry from a terminal record whose claim/evidence settlement did not succeed.
    await this.active.get(identity)?.completion;
    const source = this.replay.get(identity);
    if (!source) return await this.notRetryable(input.jobId, input.callerId);
    if (source.callerId !== input.callerId) return failure("job_not_visible", `Motion job ${input.jobId} belongs to another caller.`);
    if (source.terminal !== "failed" || !source.retryable) return failure("job_not_retryable", `Motion job ${input.jobId} is not a retryable failed run.`);
    if (input.newJobId === input.jobId) return failure("job_not_retryable", "A retry must use a distinct job id so its source evidence remains immutable.");
    const next = await this.submit({
      ...(input.newJobId ? { jobId: input.newJobId } : {}), callerId: source.callerId, lane: source.lane, ...(source.frameLane ? { frameLane: source.frameLane } : {}), operation: source.operation,
      ...(source.submissionData ? { submissionData: source.submissionData } : {}),
      ...(source.renderPlan ? { renderPlan: source.renderPlan } : {}),
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
    const status = await this.view.get({ jobId: input.jobId, callerId: input.callerId });
    if (!status.ok) return failure(status.code === "job_expired" ? "job_unknown" : status.code, `Motion job ${input.jobId} could not be read.`);
    if (status.job.lifecycle === "ended") {
      terminalState = status.job.state;
      allowLegacyEvents = await this.records.hasExclusiveOwnedLegacyEventRecord({ jobId: input.jobId, callerId: input.callerId });
    }
    // A terminal record is durable before the coordinator can release its identity claim.  Once it
    // is visible, read the durable event snapshot even if cleanup has not yet removed `active`;
    // otherwise a concurrent disk tamper could be hidden by the in-memory cache.
    const events = terminalState ? await this.readEvents(input.callerId, input.jobId, allowLegacyEvents) : active?.events ?? await this.readEvents(input.callerId, input.jobId, allowLegacyEvents);
    if (!events) return failure("capability_unavailable", `Durable event evidence for Motion job ${input.jobId} is unavailable.`);
    if (terminalState && events.at(-1)?.type !== terminalState) {
      return failure("capability_unavailable", `Durable event evidence for Motion job ${input.jobId} has no terminal ${terminalState} transition.`);
    }
    if (terminalState) {
      const terminal = events.at(-1)!;
      const recordCommitted = status.job.committed === true;
      const eventCommitted = terminal.type === "failed" && terminal.data?.committed === true;
      if (recordCommitted !== eventCommitted) {
        return failure("capability_unavailable", `Durable event evidence for Motion job ${input.jobId} disagrees with its terminal publication uncertainty.`);
      }
    }
    return { ok: true, value: { events: events.filter((event) => event.seq > (input.after ?? 0)) } };
  }

  private async run(identity: string, active: ActiveJob): Promise<void> {
    try {
      await runCoordinatorExecution({
        append: async (job, type, data) => await this.append(job, type, data),
        claimHeld: async (key, job) => await this.claimLifecycle.held(key, job),
        advanceClaim: async (key, phase, job) => await this.claimLifecycle.advance(key, phase, job),
        releaseCapacityWithoutRecord: async (job) => await job.job.releaseCapacityWithoutRecord(),
        releaseTerminalClaim: async (key, job) => await this.claimLifecycle.releaseTerminal(key, job),
        terminalEvidenceDetail: (job, outcome, execution) => coordinatorTerminalEvidenceDetail({
          jobId: job.job.jobId,
          callerId: job.callerId,
          operation: job.operation,
          ...(active.renderPlan ? { renderPlan: active.renderPlan } : {})
        }, outcome, execution),
        publishReplay: (key, replay) => this.replay.set(key, {
          ...replay,
          ...(active.submissionData ? { submissionData: active.submissionData } : {}),
          ...(active.renderPlan ? { renderPlan: active.renderPlan } : {})
        })
      }, identity, active);
    } finally {
      this.active.delete(identity);
    }
  }

  private async append(active: ActiveJob, type: MotionJobCoordinatorEvent["type"], data?: Record<string, unknown>): Promise<void> {
    const write = active.eventWrites.catch(() => {}).then(async () => {
      const identity = motionJobOwnerKey(active.callerId, active.job.jobId);
      if (!await this.claimLifecycle.held(identity, active)) throw new Error("Motion job identity claim authority is unavailable.");
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

  private async readSubmittedAcceptance(jobId: string, callerId: string): Promise<import("./job-coordinator-planned-submit").MotionCoordinatorSubmittedAcceptance> {
    try {
      const events = await this.eventStore.read({ callerId, jobId });
      const plan = events?.[0]?.type === "submitted" ? events[0].data?.renderPlan : undefined;
      if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { kind: "missing" };
      const record = plan as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return keys.length === 2 && keys[0] === "fingerprint" && keys[1] === "schema"
        && typeof record.schema === "string" && typeof record.fingerprint === "string"
        ? { kind: "accepted", schema: record.schema, fingerprint: record.fingerprint }
        : { kind: "missing" };
    } catch {
      return { kind: "unavailable" };
    }
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
