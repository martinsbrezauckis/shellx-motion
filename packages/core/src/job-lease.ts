/**
 * Machine-wide admission leases for expensive local jobs.
 *
 * Role: the job governor caps concurrency, but its counter lives in one process. Three callers —
 * a Cut agent, a Design Studio agent and a CLI invocation — each get the full cap, so a
 * "2 concurrent jobs" policy admits six renders and the memory ceiling multiplies with the number
 * of callers rather than holding. This module makes the cap hold across processes.
 *
 * How it works, and why there is no lock file:
 *   1. A process that wants a slot mints a per-run nonce and publishes its own lease directory.
 *      `jobId` is caller-facing and may repeat, while the nonce makes the mutable lease unique.
 *   2. It then lists every live lease and sorts them by (admitted, startedAt, jobId, runNonce) —
 *      a total order every process computes identically from the same directory.
 *   3. It admits itself only if its own rank is below the concurrency limit; otherwise it removes
 *      its lease and retries. On success it marks its own lease admitted before returning.
 * Two processes racing therefore reach the same conclusion about who goes first without ever
 * needing mutual exclusion, and a crash cannot leave a lock held.
 *
 * Sorting holders ahead of pending claims is what makes this converge rather than merely look
 * fair: without it a late claim whose jobId sorted lower would out-rank work that is already
 * running, and both would proceed.
 *
 * Safety posture: every filesystem operation here is best-effort. If the lease directory cannot
 * be created, read or written, admission falls back to process-local counting and reports
 * `machineWide: false`. Coordination is an optimisation over a correctness floor — a host with a
 * read-only or missing runtime directory must still be able to render.
 *
 * Scope is per-user (see the ruling in schemas/job-status.json): two different users on one
 * machine can still overcommit it. That gap is documented rather than silently carried; closing
 * it needs a shared location with a permissions model, which is a security decision.
 *
 * Dependencies: node:fs only. Primary caller: `LocalMotionJobGovernor` in job-governor.ts.
 */
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import {
  compareMotionJobLeaseRunNonce,
  isMotionJobLeaseRunNonce,
  mintMotionJobLeaseRun,
  MotionJobLeaseRunStorage,
  readMotionJobLeaseRecord,
  type MotionJobLeaseRun,
  writeMotionJobLeaseJsonAtomic
} from "./job-lease-run-storage";
import { visibleMotionJobLease, visibleMotionJobLeases } from "./job-lease-visibility";
import type { MotionJobFrameLane } from "./job-frame-lane";
import type { MotionJobLeaseRecord } from "./job-lease-types";

export type { MotionJobLeaseRun } from "./job-lease-run-storage";
export type { MotionJobLeaseRecord } from "./job-lease-types";

/** Owner recorded for work whose caller supplied no identity. */
export const UNATTRIBUTED_CALLER_ID = "unattributed";

/** A lease is considered abandoned once its holder stops refreshing it for this long. */
export const LEASE_STALE_AFTER_MS = 30_000;

/** How often a holder should refresh, comfortably inside LEASE_STALE_AFTER_MS. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

export interface MotionJobLeaseServices {
  now?: () => number;
  /** Overridden in tests; real implementation asks the OS whether the pid exists. */
  isProcessAlive?: (pid: number) => boolean;
  /** Overridden in tests and by hosts that place runtime state elsewhere. */
  leaseRoot?: string;
  pid?: number;
}

export interface LeaseClaimResult {
  /** True when this caller holds a machine-wide slot. */
  admitted: boolean;
  /** False when coordination was unavailable and process-local counting is the only bound. */
  machineWide: boolean;
  /** Live leases observed at decision time, including this caller's own when admitted. */
  observed: number;
  /** This caller's position in the machine-wide admission order, or null when uncoordinated. */
  rank: number | null;
  /** The per-run capability for lifecycle operations, or null when coordination is unavailable. */
  run: MotionJobLeaseRun | null;
}

/**
 * Where per-user runtime state lives.
 *
 * Per-user rather than machine-wide on purpose: a shared location would need a permissions model
 * and is a security-boundary decision. `XDG_RUNTIME_DIR` is preferred because it is already
 * user-private and cleaned on logout; the fallbacks keep Windows and bare containers working.
 */
export function defaultMotionJobLeaseRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SHELLX_MOTION_LEASE_ROOT?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  if (xdg) return join(xdg, "shellx-motion", "job-leases");
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) return join(localAppData, "shellx-motion", "job-leases");
  // Namespaced by user so a multi-user machine does not mix leases into one world-writable path.
  return join(tmpdir(), `shellx-motion-leases-${safeUserToken()}`);
}

function safeUserToken(): string {
  try {
    const info = userInfo();
    if (typeof info.uid === "number" && info.uid >= 0) return String(info.uid);
    if (info.username) return info.username.replace(/[^a-z0-9_-]+/gi, "-");
  } catch {
    // userInfo throws on some restricted containers; fall through to the home-path token.
  }
  return homedir().replace(/[^a-z0-9_-]+/gi, "-").slice(-32) || "shared";
}


/**
 * Coordinates admission across every Motion process belonging to one user.
 *
 * Instances are cheap and hold no open handles; the directory is the shared state.
 */
export class MotionJobLeaseDirectory {
  private readonly root: string;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly pid: number;
  private readonly runs: MotionJobLeaseRunStorage;
  /** Latches once a filesystem operation fails, so a broken directory is not retried per job. */
  private degraded = false;

  constructor(services: MotionJobLeaseServices = {}) {
    this.root = services.leaseRoot ?? defaultMotionJobLeaseRoot();
    this.now = services.now ?? Date.now;
    this.isProcessAlive = services.isProcessAlive ?? defaultIsProcessAlive;
    this.pid = services.pid ?? process.pid;
    this.runs = new MotionJobLeaseRunStorage(this.root, this.pid);
  }

  /** True once coordination has failed and process-local counting is the only bound in force. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Publish a job as waiting, before it has a slot.
   *
   * Without this a queued job has no file on disk between retries, so asking Motion about work it
   * is about to run answers `job_unknown` — the one answer that makes a caller conclude the job was
   * lost. Announcing makes `pending` a state a host can actually observe, and fixes the queue order
   * at request time rather than re-racing it on every retry.
   *
   * Best-effort like everything else here: a failure degrades to process-local admission.
   */
  async announce(input: {
    jobId: string;
    lane: string;
    frameLane?: MotionJobFrameLane;
    operation: string;
    callerId?: string;
    visibility?: "host" | "internal";
    admitted?: boolean;
    cancelRequested?: { requestedBy: string; reason?: string; requestedAtMs: number };
    /** Reuse the capability returned by the first announce when promoting or retrying this run. */
    run?: MotionJobLeaseRun;
  }): Promise<MotionJobLeaseRun | null> {
    if (this.degraded) return null;
    const now = this.now();
    const run = input.run ?? mintMotionJobLeaseRun(input.jobId);
    if (run.jobId !== input.jobId || !isMotionJobLeaseRunNonce(run.runNonce)) return null;
    try {
      await mkdir(this.root, { recursive: true });
      // Re-announcing a job (pending -> running) must NOT reset its request time. `startedAtMs` is
      // when the job asked for capacity, and `queueWaitMs` is derived as admittedAtMs - startedAtMs;
      // recomputing it on promotion made every live queued job report a queue wait of 0 and a
      // createdAtMs seconds later than the truth, while the terminal record — built from a different
      // source — reported the real wait. The live view is the one a caller polls, so it was the
      // wrong one to be lying. Preserving admittedAtMs likewise keeps first-admission, not latest.
      const existing = input.run ? await this.readRunLease(run) : null;
      // A supplied capability may update only its own live directory. In particular, a delayed
      // promotion must not recreate a run that has already ended.
      if (input.run && (!existing || existing.jobId !== input.jobId || existing.runNonce !== run.runNonce)) return null;
      const carried = existing?.jobId === input.jobId ? existing : null;
      const startedAtMs = carried?.startedAtMs ?? now;
      const admittedAtMs = carried?.admittedAtMs ?? now;
      const record: MotionJobLeaseRecord = {
        schema: "shellx-motion/job-lease@1",
        jobId: input.jobId,
        runNonce: run.runNonce,
        pid: this.pid,
        lane: input.lane,
        ...(input.frameLane ? { frameLane: input.frameLane } : {}),
        operation: input.operation,
        callerId: input.callerId ?? UNATTRIBUTED_CALLER_ID,
        visibility: input.visibility ?? "internal",
        startedAtMs,
        heartbeatAtMs: now,
        // A host job is not queued by the machine cap — the governed operations it performs are.
        // Marking it admitted is what makes it report "running" rather than "pending" forever.
        ...(input.admitted ? { admittedAtMs } : {}),
        ...(input.cancelRequested ?? carried?.cancelRequested
          ? { cancelRequested: input.cancelRequested ?? carried?.cancelRequested }
          : {}),
        admitted: input.admitted === true
      };
      if (input.run) {
        await writeMotionJobLeaseJsonAtomic(this.runs.recordPath(run), record, this.pid);
      } else {
        await this.runs.publish(run, record);
      }
      return run;
    } catch {
      this.degraded = true;
      return null;
    }
  }

  /**
   * Try to take a machine-wide slot.
   *
   * Writes this caller's lease, then decides by rank. On any filesystem failure the caller is
   * admitted with `machineWide: false` rather than blocked — see the safety posture above.
   *
   * `retainPending` keeps a losing claim's lease on disk as a visible pending job instead of
   * removing it. It never keeps a *slot* — an unadmitted lease always sorts behind every holder —
   * so capacity is unchanged either way. Callers that do not pass it get the original behaviour,
   * where a rejected claim leaves nothing behind at all.
   */
  async claim(input: {
    jobId: string;
    lane: string;
    operation: string;
    limit: number;
    callerId?: string;
    retainPending?: boolean;
    /** Capability returned by `announce` for this exact run. */
    run?: MotionJobLeaseRun;
  }): Promise<LeaseClaimResult> {
    if (this.degraded) return { admitted: true, machineWide: false, observed: 0, rank: null, run: null };
    const run = input.run ?? await this.announce({
      jobId: input.jobId,
      lane: input.lane,
      operation: input.operation,
      ...(input.callerId ? { callerId: input.callerId } : {})
    });
    if (!run) {
      return this.degraded
        ? { admitted: true, machineWide: false, observed: 0, rank: null, run: null }
        : { admitted: false, machineWide: true, observed: 0, rank: null, run: null };
    }
    const record = await this.readRunLease(run);
    if (!record || record.jobId !== input.jobId || record.runNonce !== run.runNonce) {
      return { admitted: false, machineWide: true, observed: 0, rank: null, run };
    }
    const now = this.now();
    let allLive: MotionJobLeaseRecord[];
    try {
      allLive = await this.readLiveLeases();
    } catch {
      this.degraded = true;
      return { admitted: true, machineWide: false, observed: 0, rank: null, run: null };
    }
    // Host jobs are reporting records, not admissions: one `shellx-motion render` is a host job PLUS the
    // several governed operations it performs, and counting the reporting record against capacity
    // would let a progress entry block the very work it describes. Observed directly — two host
    // jobs filled a cap of two, and every real render then waited out its queue deadline.
    const live = allLive.filter((entry) => entry.visibility !== "host");
    // The total order every process derives identically from the same directory. Holders first,
    // then oldest request, jobId and run nonce — the last three break ties without a coordinator.
    live.sort((left, right) =>
      Number(right.admitted) - Number(left.admitted)
      || left.startedAtMs - right.startedAtMs
      || (left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0)
      || compareMotionJobLeaseRunNonce(left.runNonce, right.runNonce));
    const rank = live.findIndex((entry) => entry.jobId === run.jobId && entry.runNonce === run.runNonce);
    // A missing own lease means someone reaped it as stale mid-claim; treat as not admitted.
    if (rank < 0) {
      await this.release(run);
      return { admitted: false, machineWide: true, observed: live.length, rank: null, run };
    }
    if (rank < input.limit) {
      // Publish the promotion before returning, so any process reading next sees a holder rather
      // than a pending claim it might out-rank.
      record.admitted = true;
      record.admittedAtMs = now;
      try {
        await writeMotionJobLeaseJsonAtomic(this.runs.recordPath(run), record, this.pid);
      } catch {
        this.degraded = true;
        return { admitted: true, machineWide: false, observed: live.length, rank, run: null };
      }
      return { admitted: true, machineWide: true, observed: live.length, rank, run };
    }
    // The lease stays only when the caller asked to remain visible while waiting. It holds no slot
    // either way; the difference is whether a host can see that the job still exists.
    if (!input.retainPending) await this.release(run);
    return { admitted: false, machineWide: true, observed: live.length, rank, run };
  }

  /** Refresh a held lease so other processes do not reap it as abandoned. */
  async heartbeat(run: MotionJobLeaseRun | string): Promise<void> {
    if (this.degraded) return;
    try {
      const record = typeof run === "string"
        ? await this.readLegacyLease(run)
        : await this.readRunLease(run);
      if (!record) return;
      record.heartbeatAtMs = this.now();
      await writeMotionJobLeaseJsonAtomic(
        typeof run === "string" ? this.runs.legacyRecordPath(run) : this.runs.recordPath(run),
        record,
        this.pid
      );
    } catch {
      // A failed heartbeat is survivable: the lease ages out and other processes proceed.
    }
  }

  /**
   * Give up a slot. Safe to call for a lease that was never written or already removed.
   *
   * Reads before deleting so a file that names a different job is left alone. The injective path
   * encoding already makes that impossible for a job id; this covers the case it does not — a
   * lease file written by an older build under the old folded name, which a release must not take
   * with it.
   */
  async release(run: MotionJobLeaseRun | string): Promise<void> {
    if (this.degraded) return;
    try {
      if (typeof run === "string") {
        const existing = await this.readLegacyLease(run);
        if (!existing || existing.jobId !== run) return;
        await rm(this.runs.legacyRecordPath(run), { force: true });
        return;
      }
      const existing = await this.readRunLease(run);
      if (!existing || existing.jobId !== run.jobId || existing.runNonce !== run.runNonce) return;
      // The directory is the no-recreate boundary: a heartbeat which started before this removal
      // cannot atomically rename its update back into existence because its parent is gone.
      await this.runs.release(run);
    } catch {
      // Leaving the file behind is survivable: it ages out via the staleness rule.
    }
  }

  /** Live leases held anywhere on this machine by this user, newest reap applied. */
  async readLiveLeases(): Promise<MotionJobLeaseRecord[]> {
    const cutoff = this.now() - LEASE_STALE_AFTER_MS;
    return this.runs.readLive((path) => readMotionJobLeaseRecord(path, UNATTRIBUTED_CALLER_ID), (record) => record.heartbeatAtMs < cutoff || !this.isProcessAlive(record.pid));
  }

  /**
   * Live work this caller is allowed to see.
   *
   * A **boundary, not a filter**: an agent embedded in Cut must not be able to enumerate Design
   * Studio's jobs by asking differently. Scheduling is global — every lease counts against the
   * machine-wide cap regardless of owner — while visibility is per-owner. The two are separate
   * on purpose, because capacity is a property of the machine and evidence is a property of the
   * requester.
   *
   * `scope: "all"` is the deliberate, auditable escape hatch for an operator surface; callers
   * that pass it must have been granted it, and the decision is the transport's to make, not
   * this module's.
   */
  async readVisibleLeases(input: { callerId: string; scope?: "own" | "all" }): Promise<MotionJobLeaseRecord[]> {
    return visibleMotionJobLeases(await this.readLiveLeases(), input);
  }

  /**
   * Look up one job, distinguishing "no such job" from "not yours".
   *
   * The distinction costs one enum member and prevents a whole class of wrong conclusions: an
   * agent told a job it did not own is `job_unknown` concludes Motion lost the work.
   */
  async readVisibleLease(input: { jobId: string; callerId: string; scope?: "own" | "all" }): Promise<
    { ok: true; lease: MotionJobLeaseRecord } | { ok: false; code: "job_unknown" | "job_not_visible" }
  > {
    return visibleMotionJobLease(await this.readLiveLeases(), input);
  }

  private async readRunLease(run: MotionJobLeaseRun): Promise<MotionJobLeaseRecord | null> {
    if (!isMotionJobLeaseRunNonce(run.runNonce)) return null;
    const record = await readMotionJobLeaseRecord(this.runs.recordPath(run), UNATTRIBUTED_CALLER_ID);
    return record?.jobId === run.jobId && record.runNonce === run.runNonce ? record : null;
  }

  /** Old callers with only a job id can touch old flat records, never a nonce-protected run. */
  private async readLegacyLease(jobId: string): Promise<MotionJobLeaseRecord | null> {
    const record = await readMotionJobLeaseRecord(this.runs.legacyRecordPath(jobId), UNATTRIBUTED_CALLER_ID);
    return record?.jobId === jobId && record.runNonce === undefined ? record : null;
  }
}

/**
 * Whether a pid is still running.
 *
 * `kill(pid, 0)` performs the permission and existence check without delivering a signal. EPERM
 * means the process exists but belongs to another user, which still counts as alive.
 */
/**
 * The stable owner key for a caller, derived from the actor the transport observed.
 *
 * Falls back to `${transport}:${label}` so a host that supplies no explicit id still gets an
 * identity that is stable across its processes — unlike a pid or a per-connection session id.
 */
export function motionCallerId(actor: { callerId?: string; transport?: string; label?: string } | undefined): string {
  const explicit = actor?.callerId?.trim();
  if (explicit) return explicit;
  const transport = actor?.transport?.trim();
  const label = actor?.label?.trim();
  if (transport && label) return `${transport}:${label}`;
  if (label) return label;
  if (transport) return transport;
  return UNATTRIBUTED_CALLER_ID;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
