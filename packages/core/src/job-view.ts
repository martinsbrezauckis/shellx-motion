/**
 * The one place a caller's question "what is my job doing?" is answered.
 *
 * Role: a job's truth lives in two stores that are deliberately separate — a lease describing live
 * work, and a record describing finished work. A host must not have to know that, or to ask twice
 * and reconcile two shapes. This module reads both and projects them into a single object shaped by
 * the authored contract in schemas/job-status.json.
 *
 * Order matters: the live lease is consulted first. A job that is running now is running now, even
 * if a stale record from an earlier attempt shares its id — which is possible precisely because
 * callers are allowed to choose their own ids and may reuse one.
 *
 * The three query errors are distinguished rather than collapsed, because the contract makes each
 * demand a different response: `job_unknown` means stop and re-read the id, `job_expired` means
 * fall back to receipts, `job_not_visible` means ask as the owning caller. Collapsing them into
 * "not found" is what makes an agent conclude Motion lost its work.
 *
 * Dependencies: job-lease.ts and job-registry.ts. Primary callers: the `motion.job.*` debug
 * commands and the `shellx-motion job` CLI subcommands.
 */
import { MotionJobLeaseDirectory, type MotionJobLeaseRecord } from "./job-lease";
import { MotionJobRegistry, type MotionJobRecord } from "./job-registry";
import { projectJobState, type JobLifecycle, type JobOutcome, type JobState } from "./generated/job-status";

/** One job, however it is currently stored. Shaped by the contract, not by the storage. */
export interface MotionJobStatus {
  schema: "shellx-motion/job-status@1";
  jobId: string;
  callerId: string;
  lane: string;
  operation: string;
  lifecycle: JobLifecycle;
  /** Present if and only if lifecycle is "ended". */
  outcome: JobOutcome | null;
  /** The derived single token most callers switch on. Never accepted as an input. */
  state: JobState;
  createdAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  durationMs?: number;
  queueWaitMs?: number;
  /** The process holding this job, present only while it is live. */
  pid?: number;
  error?: MotionJobRecord["error"];
  cancellation?: MotionJobRecord["cancellation"];
  skip?: MotionJobRecord["skip"];
  warnings: string[];
  receiptPath?: string;
  /**
   * How long to wait before asking again. Absent once the job has ended, which is the machine-
   * readable way of saying "stop polling" — an agent that polls a terminal job forever is the
   * most common way this kind of API is misused.
   */
  pollAfterMs?: number;
}

export type MotionJobQueryFailure = { ok: false; code: "job_unknown" | "job_expired" | "job_not_visible" };
export type MotionJobQueryResult = { ok: true; job: MotionJobStatus } | MotionJobQueryFailure;

export interface MotionJobViewServices {
  leases?: MotionJobLeaseDirectory;
  records?: MotionJobRegistry;
}

/** Recommended poll interval for work still in flight, comfortably below the heartbeat period. */
const DEFAULT_POLL_AFTER_MS = 2_000;

/** Reads both job stores and answers as one. */
export class MotionJobView {
  private readonly leases: MotionJobLeaseDirectory;
  private readonly records: MotionJobRegistry;

  constructor(services: MotionJobViewServices = {}) {
    this.leases = services.leases ?? new MotionJobLeaseDirectory();
    this.records = services.records ?? new MotionJobRegistry();
  }

  /**
   * One job by id.
   *
   * `job_not_visible` from the live store is returned immediately rather than falling through to
   * the record store: a caller denied the live job must not be able to learn the same job's
   * outcome by waiting for it to finish and asking again.
   */
  async get(input: { jobId: string; callerId: string; scope?: "own" | "all" }): Promise<MotionJobQueryResult> {
    const live = await this.leases.readVisibleLease(input);
    if (live.ok) return { ok: true, job: statusFromLease(live.lease) };
    if (live.code === "job_not_visible") return { ok: false, code: "job_not_visible" };
    const ended = await this.records.read(input);
    return ended.ok ? { ok: true, job: statusFromRecord(ended.record) } : { ok: false, code: ended.code };
  }

  /**
   * Every job this caller may see, live work first and newest ended work after it.
   *
   * Live-first is the useful order for a host rendering a queue: the rows that still change are the
   * rows a user is watching.
   */
  async list(input: { callerId: string; scope?: "own" | "all"; limit?: number }): Promise<MotionJobStatus[]> {
    const [live, ended] = await Promise.all([
      this.leases.readVisibleLeases(input),
      this.records.list(input)
    ]);
    const liveIds = new Set(live.map((lease) => lease.jobId));
    const jobs = [
      ...live.sort((left, right) => left.startedAtMs - right.startedAtMs).map(statusFromLease),
      // A record for a job that is live again under a reused id would otherwise appear twice, once
      // running and once ended, which reads as two jobs.
      ...ended.filter((record) => !liveIds.has(record.jobId)).map(statusFromRecord)
    ];
    return input.limit === undefined ? jobs : jobs.slice(0, Math.max(0, input.limit));
  }
}

/** Project a live lease. `admitted` is the whole difference between pending and running. */
function statusFromLease(lease: MotionJobLeaseRecord): MotionJobStatus {
  const lifecycle: JobLifecycle = lease.admitted ? "running" : "pending";
  return {
    schema: "shellx-motion/job-status@1",
    jobId: lease.jobId,
    callerId: lease.callerId,
    lane: lease.lane,
    operation: lease.operation,
    lifecycle,
    outcome: null,
    state: projectJobState(lifecycle, null),
    createdAtMs: lease.startedAtMs,
    // Only a running job has actually started; a pending one has not, and saying otherwise turns a
    // "waiting for a slot" message into a false "rendering..." one.
    ...(lease.admittedAtMs !== undefined ? { startedAtMs: lease.admittedAtMs } : {}),
    ...(lease.admittedAtMs !== undefined ? { queueWaitMs: Math.max(0, lease.admittedAtMs - lease.startedAtMs) } : {}),
    pid: lease.pid,
    warnings: [],
    pollAfterMs: DEFAULT_POLL_AFTER_MS
  };
}

/** Project a terminal record. No `pollAfterMs`: there is nothing further to wait for. */
function statusFromRecord(record: MotionJobRecord): MotionJobStatus {
  return {
    schema: "shellx-motion/job-status@1",
    jobId: record.jobId,
    callerId: record.callerId,
    lane: record.lane,
    operation: record.operation,
    lifecycle: "ended",
    outcome: record.outcome,
    state: projectJobState("ended", record.outcome),
    createdAtMs: record.createdAtMs,
    ...(record.startedAtMs !== undefined ? { startedAtMs: record.startedAtMs } : {}),
    endedAtMs: record.endedAtMs,
    durationMs: record.durationMs,
    queueWaitMs: record.queueWaitMs,
    ...(record.error ? { error: record.error } : {}),
    ...(record.cancellation ? { cancellation: record.cancellation } : {}),
    ...(record.skip ? { skip: record.skip } : {}),
    warnings: record.warnings,
    ...(record.receiptPath ? { receiptPath: record.receiptPath } : {})
  };
}
