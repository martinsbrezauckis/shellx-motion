/**
 * Machine-wide admission leases for expensive local jobs.
 *
 * Role: the job governor caps concurrency, but its counter lives in one process. Three callers —
 * a Cut agent, a Design Studio agent and a CLI invocation — each get the full cap, so a
 * "2 concurrent jobs" policy admits six renders and the memory ceiling multiplies with the number
 * of callers rather than holding. This module makes the cap hold across processes.
 *
 * How it works, and why there is no lock file:
 *   1. A process that wants a slot writes its own lease file (exclusive create; the job id is
 *      unique, so this never contends).
 *   2. It then lists every live lease and sorts them by (admitted, startedAt, jobId) — a total
 *      order every process computes identically from the same directory.
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
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { motionJobFileKey } from "./job-id-file";

/** Owner recorded for work whose caller supplied no identity. */
export const UNATTRIBUTED_CALLER_ID = "unattributed";

/** A lease is considered abandoned once its holder stops refreshing it for this long. */
export const LEASE_STALE_AFTER_MS = 30_000;

/** How often a holder should refresh, comfortably inside LEASE_STALE_AFTER_MS. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

export interface MotionJobLeaseRecord {
  schema: "shellx-motion/job-lease@1";
  jobId: string;
  pid: number;
  lane: string;
  operation: string;
  /**
   * Who this work belongs to. Assigned at creation and enforced on read.
   *
   * Host-chosen and stable across processes, which is what a process id or session id cannot be:
   * a fresh CLI process would otherwise be unable to see the job it started a second ago.
   */
  callerId: string;
  /**
   * Whether a host asked for this work, or Motion took it on to do that work.
   *
   * One `shellx-motion render` runs six governed operations: a browser frame pass, two ffmpeg capability
   * probes and three encodes. All six need capacity, so all six hold leases. None of them is what
   * the host asked for — it asked for one render — and listing them as jobs shows an operator
   * "ffmpeg.version" as work in progress.
   *
   * Capacity counts every lease. `motion.job.*` reports only the host ones. Defaults to "internal"
   * so a lease written by an older build is never mistaken for something a host is waiting on.
   */
  visibility?: "host" | "internal";
  /**
   * When this job asked for capacity — not when it began running.
   *
   * This is the queue-order key: ties in the admission order break on jobId. A job that is
   * announced and then waits keeps its original value, which is what makes waiting first-come
   * rather than a repeated race between retrying processes.
   */
  startedAtMs: number;
  /**
   * When this job was actually admitted, present only once it holds a slot.
   *
   * Separate from `startedAtMs` because the gap between the two is exactly the queue wait a caller
   * asks about, and because "pending" and "running" are different answers to "what is my job doing".
   */
  admittedAtMs?: number;
  heartbeatAtMs: number;
  /**
   * Whether this lease currently holds a slot.
   *
   * Load-bearing for convergence: an admitted lease always sorts ahead of a pending one, so a
   * later claimant can never displace a holder that is already running. Without it, a claim
   * whose jobId happened to sort lower would out-rank live work and both would run.
   */
  admitted: boolean;
}

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
 * Write a lease so a concurrent reader never sees it half-written.
 *
 * `writeFile` truncates and then fills, so a reader polling during a heartbeat can read an empty or
 * partial file. That is not theoretical: a live render polled every 3s intermittently reported
 * `job_unknown`, because an unparseable lease is treated as corrupt and DELETED — so a torn read
 * did not merely blip, it destroyed the lease and dropped the job's slot.
 *
 * Writing to a sibling temp file and renaming makes the swap atomic on POSIX and on Windows, so a
 * reader sees either the previous content or the new content and never a mixture.
 */
async function writeJsonAtomic(path: string, value: unknown, pid: number): Promise<void> {
  // The pid keeps two processes from colliding on one temp name.
  const temporary = `${path}.${pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "w" });
  await rename(temporary, path);
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
  /** Latches once a filesystem operation fails, so a broken directory is not retried per job. */
  private degraded = false;

  constructor(services: MotionJobLeaseServices = {}) {
    this.root = services.leaseRoot ?? defaultMotionJobLeaseRoot();
    this.now = services.now ?? Date.now;
    this.isProcessAlive = services.isProcessAlive ?? defaultIsProcessAlive;
    this.pid = services.pid ?? process.pid;
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
  async announce(input: { jobId: string; lane: string; operation: string; callerId?: string; visibility?: "host" | "internal"; admitted?: boolean }): Promise<void> {
    if (this.degraded) return;
    const now = this.now();
    try {
      await mkdir(this.root, { recursive: true });
      // Re-announcing a job (pending -> running) must NOT reset its request time. `startedAtMs` is
      // when the job asked for capacity, and `queueWaitMs` is derived as admittedAtMs - startedAtMs;
      // recomputing it on promotion made every live queued job report a queue wait of 0 and a
      // createdAtMs seconds later than the truth, while the terminal record — built from a different
      // source — reported the real wait. The live view is the one a caller polls, so it was the
      // wrong one to be lying. Preserving admittedAtMs likewise keeps first-admission, not latest.
      const existing = await this.readLease(this.leasePath(input.jobId));
      const carried = existing?.jobId === input.jobId ? existing : null;
      const startedAtMs = carried?.startedAtMs ?? now;
      const admittedAtMs = carried?.admittedAtMs ?? now;
      await writeJsonAtomic(this.leasePath(input.jobId), {
        schema: "shellx-motion/job-lease@1",
        jobId: input.jobId,
        pid: this.pid,
        lane: input.lane,
        operation: input.operation,
        callerId: input.callerId ?? UNATTRIBUTED_CALLER_ID,
        visibility: input.visibility ?? "internal",
        startedAtMs,
        heartbeatAtMs: now,
        // A host job is not queued by the machine cap — the governed operations it performs are.
        // Marking it admitted is what makes it report "running" rather than "pending" forever.
        ...(input.admitted ? { admittedAtMs } : {}),
        admitted: input.admitted === true
      } satisfies MotionJobLeaseRecord, this.pid);
    } catch {
      this.degraded = true;
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
  async claim(input: { jobId: string; lane: string; operation: string; limit: number; callerId?: string; retainPending?: boolean }): Promise<LeaseClaimResult> {
    if (this.degraded) return { admitted: true, machineWide: false, observed: 0, rank: null };
    const announced = input.retainPending ? await this.readLease(this.leasePath(input.jobId)) : null;
    const now = this.now();
    // Reusing the announced request time is what preserves queue position across retries; minting
    // a fresh one would send a waiting job to the back of the line every time it lost.
    const startedAtMs = announced?.startedAtMs ?? now;
    const record: MotionJobLeaseRecord = {
      schema: "shellx-motion/job-lease@1",
      jobId: input.jobId,
      pid: this.pid,
      lane: input.lane,
      operation: input.operation,
      callerId: input.callerId ?? UNATTRIBUTED_CALLER_ID,
      // Always an admission. A host job never claims — it announces once and is reported, never
      // ranked, which is what keeps a progress record from occupying a rendering slot.
      visibility: announced?.visibility === "host" ? "host" : "internal",
      startedAtMs,
      heartbeatAtMs: now,
      admitted: false
    };
    try {
      await mkdir(this.root, { recursive: true });
      await writeJsonAtomic(this.leasePath(input.jobId), record, this.pid);
    } catch {
      this.degraded = true;
      return { admitted: true, machineWide: false, observed: 0, rank: null };
    }
    let allLive: MotionJobLeaseRecord[];
    try {
      allLive = await this.readLiveLeases();
    } catch {
      this.degraded = true;
      return { admitted: true, machineWide: false, observed: 0, rank: null };
    }
    // Host jobs are reporting records, not admissions: one `shellx-motion render` is a host job PLUS the
    // several governed operations it performs, and counting the reporting record against capacity
    // would let a progress entry block the very work it describes. Observed directly — two host
    // jobs filled a cap of two, and every real render then waited out its queue deadline.
    const live = allLive.filter((entry) => entry.visibility !== "host");
    // The total order every process derives identically from the same directory. Holders first,
    // then oldest request, then jobId — the last two break ties without a coordinator.
    live.sort((left, right) =>
      Number(right.admitted) - Number(left.admitted)
      || left.startedAtMs - right.startedAtMs
      || (left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0));
    const rank = live.findIndex((entry) => entry.jobId === input.jobId);
    // A missing own lease means someone reaped it as stale mid-claim; treat as not admitted.
    if (rank < 0) {
      await this.release(input.jobId);
      return { admitted: false, machineWide: true, observed: live.length, rank: null };
    }
    if (rank < input.limit) {
      // Publish the promotion before returning, so any process reading next sees a holder rather
      // than a pending claim it might out-rank.
      record.admitted = true;
      record.admittedAtMs = now;
      try {
        await writeJsonAtomic(this.leasePath(input.jobId), record, this.pid);
      } catch {
        this.degraded = true;
        return { admitted: true, machineWide: false, observed: live.length, rank };
      }
      return { admitted: true, machineWide: true, observed: live.length, rank };
    }
    // The lease stays only when the caller asked to remain visible while waiting. It holds no slot
    // either way; the difference is whether a host can see that the job still exists.
    if (!input.retainPending) await this.release(input.jobId);
    return { admitted: false, machineWide: true, observed: live.length, rank };
  }

  /** Refresh a held lease so other processes do not reap it as abandoned. */
  async heartbeat(jobId: string): Promise<void> {
    if (this.degraded) return;
    try {
      const record = await this.readLease(this.leasePath(jobId));
      if (!record) return;
      record.heartbeatAtMs = this.now();
      await writeJsonAtomic(this.leasePath(jobId), record, this.pid);
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
  async release(jobId: string): Promise<void> {
    if (this.degraded) return;
    try {
      const path = this.leasePath(jobId);
      const existing = await this.readLease(path);
      if (existing && existing.jobId !== jobId) return;
      await rm(path, { force: true });
    } catch {
      // Leaving the file behind is survivable: it ages out via the staleness rule.
    }
  }

  /** Live leases held anywhere on this machine by this user, newest reap applied. */
  async readLiveLeases(): Promise<MotionJobLeaseRecord[]> {
    const entries = await readdir(this.root).catch(() => [] as string[]);
    const cutoff = this.now() - LEASE_STALE_AFTER_MS;
    const live: MotionJobLeaseRecord[] = [];
    for (const entry of entries) {
      // `.tmp` siblings are in-flight atomic writes, not leases.
      if (!entry.endsWith(".lease.json")) continue;
      const path = join(this.root, entry);
      const record = await this.readLease(path);
      // An unreadable or malformed lease is not evidence of running work; drop it rather than
      // let a corrupt file permanently consume a slot.
      if (!record) {
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      const abandoned = record.heartbeatAtMs < cutoff || !this.isProcessAlive(record.pid);
      if (abandoned) {
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      live.push(record);
    }
    return live;
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
    const live = await this.readLiveLeases();
    // Internal admissions are filtered here rather than at the call site so no reporting surface
    // can accidentally show an ffmpeg capability probe as a job a host is waiting on.
    const host = live.filter((entry) => entry.visibility === "host");
    if (input.scope === "all") return host;
    return host.filter((entry) => entry.callerId === input.callerId);
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
    const live = await this.readLiveLeases();
    const found = live.find((entry) => entry.jobId === input.jobId && entry.visibility === "host");
    if (!found) return { ok: false, code: "job_unknown" };
    if (input.scope !== "all" && found.callerId !== input.callerId) return { ok: false, code: "job_not_visible" };
    return { ok: true, lease: found };
  }

  /**
   * The one file that belongs to this job.
   *
   * Uses the injective encoding rather than folding disallowed characters to `-`: the folding form
   * mapped `cut:render-42` and `cut-render-42` — both legal, and the first is the id this product
   * documents to Cut — onto one file, so one caller's write destroyed another caller's live lease.
   * See `job-id-file.ts` for the full reasoning.
   */
  private leasePath(jobId: string): string {
    return join(this.root, `${motionJobFileKey(jobId)}.lease.json`);
  }

  private async readLease(path: string): Promise<MotionJobLeaseRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<MotionJobLeaseRecord>;
      if (parsed?.schema !== "shellx-motion/job-lease@1") return null;
      if (typeof parsed.jobId !== "string" || typeof parsed.pid !== "number") return null;
      if (typeof parsed.startedAtMs !== "number" || typeof parsed.heartbeatAtMs !== "number") return null;
      if (typeof parsed.admitted !== "boolean") return null;
      // Older leases predate owner attribution; treat them as unattributed rather than dropping
      // them, since they still represent real work holding real capacity.
      if (typeof parsed.callerId !== "string") parsed.callerId = UNATTRIBUTED_CALLER_ID;
      return parsed as MotionJobLeaseRecord;
    } catch {
      return null;
    }
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
