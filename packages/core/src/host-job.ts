/**
 * The job a host asked for, as distinct from the work Motion does to satisfy it.
 *
 * Role: `LocalMotionJobGovernor` governs *resource admissions*. One `shellx-motion render` produces six of
 * them — a browser frame pass, two ffmpeg capability probes and three encodes — because each needs
 * a slice of the machine. That is the right unit for capacity and the wrong unit for reporting: the
 * host asked for one render, and a job list showing it "ffmpeg.version" as work in progress is
 * describing Motion's internals rather than answering the question.
 *
 * This module is the host's unit. One handle spans an entire invocation, carries the id the host
 * chose, and ends exactly once with one of the contract's four outcomes.
 *
 * The division of labour, stated plainly:
 *   - Every governed operation takes a lease, so capacity is counted honestly.
 *   - Only a host job is reported by `motion.job.get` / `motion.job.list`.
 *   - Only a host job leaves a terminal record, so retention holds real answers rather than
 *     thousands of capability probes.
 *
 * Why a handle rather than a wrapper function: a render's outcome is decided in several places —
 * a quality gate can fail after the encode succeeded — and an explicit `succeeded`/`failed` call at
 * the point the decision is made is harder to get wrong than inferring it from a thrown error.
 *
 * Dependencies: job-lease.ts, job-registry.ts. Primary callers: the CLI render commands and the
 * Debug API render handlers.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { LEASE_HEARTBEAT_INTERVAL_MS, MotionJobLeaseDirectory, type MotionJobLeaseRun, UNATTRIBUTED_CALLER_ID } from "./job-lease";
import { MotionJobRegistry, assertMotionJobId, mintMotionJobId, type MotionJobRecord } from "./job-registry";
import type { JobOutcome, JobSkipCode } from "./generated/job-status";
import type { MotionJobFrameLane } from "./job-frame-lane";
import { motionJobFailure, type MotionJobFailureInput } from "./job-failure";

export interface MotionHostJobInput {
  /** The id the host chose. Omit to have Motion mint one, which `jobId` then reports back. */
  jobId?: string;
  callerId?: string;
  lane: string;
  /** Optional rasterizer inside a final-video delivery lane. */
  frameLane?: MotionJobFrameLane;
  /** What the host asked for, in the receipt operation vocabulary — "render.final", not "ffmpeg.render". */
  operation: string;
  /** Optional immutable lineage for a newly submitted retry. */
  lineage?: MotionJobRecord["lineage"];
  /** Internal observer used by a durable coordinator to append the real admission transition. */
  onRunning?: () => Promise<void> | void;
  leases?: MotionJobLeaseDirectory | null;
  records?: MotionJobRegistry | null;
  now?: () => number;
}

/**
 * The host job the current work belongs to.
 *
 * Async-local rather than a parameter because the link has to cross every layer between the command
 * dispatch and the governor — renderers, encoders, adapters — none of which have any business
 * knowing about job reporting. Threading an id through all of them would put a reporting concern in
 * a dozen signatures and would be forgotten at the first new call site.
 */
const HOST_JOB_CONTEXT = new AsyncLocalStorage<MotionHostJob>();

/** Run `fn` with `job` as the ambient host job, so governed work underneath can find it. */
export function runInMotionHostJob<T>(job: MotionHostJob, fn: () => Promise<T>): Promise<T> {
  return HOST_JOB_CONTEXT.run(job, fn);
}

/** The host job this work belongs to, or undefined when it was not started by one. */
export function currentMotionHostJob(): MotionHostJob | undefined {
  return HOST_JOB_CONTEXT.getStore();
}

export interface MotionHostJobEnd {
  receiptPath?: string;
  receiptId?: string;
  producerEvidence?: { frameLane: MotionJobFrameLane; schema?: string };
  warnings?: string[];
  error?: MotionJobFailureInput;
  cancellation?: { requestedBy: string; reason?: string };
  skip?: { code: JobSkipCode; reason?: string };
}

/**
 * A live host job. Ends exactly once.
 *
 * Repeated `end` calls are ignored rather than throwing: this is reporting, and a double-end in an
 * error path must never be the reason a render that actually worked reports a failure.
 */
export class MotionHostJob {
  private ended = false;
  private heartbeat: NodeJS.Timeout | undefined;
  /**
   * When the first governed operation this job owns was admitted.
   *
   * Undefined means the job has capacity-waited its whole life so far and has produced nothing —
   * which is exactly what `pending` means, and why a caller must not be told "rendering".
   */
  private admittedAtMs: number | undefined;

  private constructor(
    readonly jobId: string,
    readonly callerId: string,
    private readonly lane: string,
    private readonly frameLane: MotionJobFrameLane | undefined,
    private readonly operation: string,
    private readonly lineage: MotionJobRecord["lineage"] | undefined,
    private readonly onRunning: (() => Promise<void> | void) | undefined,
    private readonly startedAtMs: number,
    private readonly leases: MotionJobLeaseDirectory | null,
    /** Capability for this exact live run; absent only when best-effort coordination degraded. */
    private leaseRun: MotionJobLeaseRun | null,
    private readonly records: MotionJobRegistry | null,
    private readonly now: () => number
  ) {}

  /** Announce a host job as running and start refreshing its lease. */
  static async begin(input: MotionHostJobInput): Promise<MotionHostJob> {
    const now = input.now ?? Date.now;
    const startedAtMs = now();
    const jobId = input.jobId === undefined ? mintMotionJobId(startedAtMs) : assertMotionJobId(input.jobId);
    const callerId = input.callerId ?? UNATTRIBUTED_CALLER_ID;
    const leases = input.leases === undefined ? new MotionJobLeaseDirectory() : input.leases;
    const records = input.records === undefined ? new MotionJobRegistry() : input.records;
    // Announced PENDING. A host job does not queue for the machine cap itself, but the governed
    // operations it performs do — and until one of them is admitted, nothing is being produced.
    // `markRunning()` promotes it the moment the first one starts. Reporting "running" from the
    // outset would tell a caller "rendering..." while its work sits in a queue.
    const leaseRun = await leases?.announce({ jobId, lane: input.lane, ...(input.frameLane ? { frameLane: input.frameLane } : {}), operation: input.operation, callerId, visibility: "host", admitted: false }) ?? null;
    const job = new MotionHostJob(jobId, callerId, input.lane, input.frameLane, input.operation, input.lineage, input.onRunning, startedAtMs, leases, leaseRun, records, now);
    if (leases && leaseRun) {
      // Unref'd: refreshing a lease must never be the reason a process stays alive.
      job.heartbeat = setInterval(() => { void leases.heartbeat(leaseRun); }, LEASE_HEARTBEAT_INTERVAL_MS);
      job.heartbeat.unref?.();
    }
    return job;
  }

  /**
   * Promote this job from waiting to working.
   *
   * Called by the governor when the first operation belonging to this job is admitted. Idempotent:
   * a render performs several governed operations and only the first one changes anything.
   */
  async markRunning(): Promise<void> {
    if (this.ended || this.admittedAtMs !== undefined) return;
    this.admittedAtMs = this.now();
    if (!this.leaseRun) return;
    this.leaseRun = await this.leases?.announce({
      jobId: this.jobId, lane: this.lane, ...(this.frameLane ? { frameLane: this.frameLane } : {}), operation: this.operation,
      callerId: this.callerId, visibility: "host", admitted: true, run: this.leaseRun
    }) ?? null;
    await this.onRunning?.();
  }

  /**
   * Publish accepted cancellation intent without changing the lifecycle early.
   *
   * The worker still owns the terminal transition. This is what prevents a query from claiming a
   * job is cancelled while its encoder is still alive and unwinding.
   */
  async requestCancellation(input: { requestedBy: string; reason?: string }): Promise<void> {
    if (this.ended || !this.leaseRun) return;
    const cancellation = { requestedBy: input.requestedBy, ...(input.reason ? { reason: input.reason } : {}), requestedAtMs: this.now() };
    this.leaseRun = await this.leases?.announce({
      jobId: this.jobId, lane: this.lane, ...(this.frameLane ? { frameLane: this.frameLane } : {}), operation: this.operation,
      callerId: this.callerId, visibility: "host", admitted: this.admittedAtMs !== undefined,
      cancelRequested: cancellation, run: this.leaseRun
    }) ?? null;
  }

  async succeeded(detail: Pick<MotionHostJobEnd, "receiptPath" | "warnings"> = {}): Promise<void> {
    await this.end("succeeded", detail);
  }

  async failed(detail: Pick<MotionHostJobEnd, "receiptPath" | "warnings" | "error">): Promise<void> {
    await this.end("failed", detail);
  }

  async cancelled(detail: Pick<MotionHostJobEnd, "cancellation" | "warnings"> = {}): Promise<void> {
    await this.end("cancelled", detail);
  }

  async skipped(detail: Pick<MotionHostJobEnd, "skip" | "warnings">): Promise<void> {
    await this.end("skipped", detail);
  }

  /**
   * Record the outcome, release the lease, stop the heartbeat.
   *
   * Every failure here is swallowed. Reporting is layered over rendering: a host with an unwritable
   * runtime directory must still be able to render, it simply cannot report afterwards.
   */
  async end(outcome: JobOutcome, detail: MotionHostJobEnd = {}): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const endedAtMs = this.now();
    const record: MotionJobRecord = {
      schema: "shellx-motion/job-record@1",
      jobId: this.jobId,
      callerId: this.callerId,
      lane: this.lane,
      ...(this.frameLane ? { frameLane: this.frameLane } : {}),
      operation: this.operation,
      lifecycle: "ended",
      outcome,
      createdAtMs: this.startedAtMs,
      // Present only if work actually began. A job that failed or was cancelled while still waiting
      // for capacity never started, and the contract makes the absence of startedAt the
      // machine-checkable proof of that.
      ...(this.admittedAtMs !== undefined ? { startedAtMs: this.admittedAtMs } : {}),
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - this.startedAtMs),
      queueWaitMs: this.admittedAtMs === undefined ? Math.max(0, endedAtMs - this.startedAtMs) : Math.max(0, this.admittedAtMs - this.startedAtMs),
      // Present if and only if the outcome is "failed"; absent on cancelled, which is what stops an
      // agent's `if (job.error?.retryable) retry()` from restarting work a human stopped.
      ...(outcome === "failed" && detail.error
        ? { error: motionJobFailure(detail.error, { code: "invalid_args", message: detail.error.message }) }
        : {}),
      ...(outcome === "cancelled" ? { cancellation: detail.cancellation ?? { requestedBy: this.callerId } } : {}),
      ...(outcome === "skipped" && detail.skip ? { skip: detail.skip } : {}),
      warnings: detail.warnings ?? [],
      ...(detail.receiptPath ? { receiptPath: detail.receiptPath } : {}),
      ...(detail.receiptId ? { receiptId: detail.receiptId } : {}),
      ...(detail.producerEvidence ? { producerEvidence: detail.producerEvidence } : {}),
      ...(this.lineage ? { lineage: this.lineage } : {})
    };
    try {
      await this.records?.record(record);
    } catch {
      // See above: losing the record must not fail the work it describes.
    }
    if (this.leaseRun) await this.leases?.release(this.leaseRun);
  }
}
