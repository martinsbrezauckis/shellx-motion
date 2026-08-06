/**
 * Terminal job records — what a caller can still learn after the work is over.
 *
 * Role: `MotionJobLeaseDirectory` describes work that is *live*. Its file is removed the moment a
 * job ends, which is correct for admission (a finished job must not hold a slot) and useless for
 * reporting: the agent that asked for a render is almost always asking *after* it finished. Without
 * a record that outlives the lease, every completed job answers `job_unknown` — indistinguishable
 * from a typo, and the one answer the status contract explicitly warns leads a caller to conclude
 * Motion lost its work.
 *
 * This module is the other half: when a job ends, its outcome is written here, and it stays
 * readable until retention prunes it.
 *
 * Why the ids are timestamped: retention makes `job_expired` a real possibility, and the contract
 * requires it to be distinguishable from `job_unknown` because the two demand opposite responses
 * (fall back to receipts, versus stop and re-read the submission). A Motion-minted id embeds its
 * own mint time, so an id we have never seen can be compared against the prune horizon and
 * answered exactly, without keeping an unbounded tombstone index that would defeat retention.
 * A caller-supplied id carries no such time, and is answered `job_unknown` — documented, not
 * silently approximated.
 *
 * Visibility is the same boundary the lease directory enforces, for the same reason: an agent
 * embedded in Cut must not enumerate Design Studio's history by asking differently.
 *
 * Safety posture: every filesystem operation is best-effort, matching job-lease.ts. Recording is an
 * observability feature layered over rendering, and a host with an unwritable runtime directory
 * must still be able to render — it simply cannot report afterwards.
 *
 * Dependencies: node:fs and the generated job-status contract. Primary caller:
 * `LocalMotionJobGovernor` in job-governor.ts (writes) and the `motion.job.*` debug commands (read).
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { UNATTRIBUTED_CALLER_ID, defaultMotionJobLeaseRoot } from "./job-lease";
import { motionJobFileKey } from "./job-id-file";
import type { JobErrorCode, JobOutcome, JobSkipCode } from "./generated/job-status";

/** Retention, per the ruling in schemas/job-status.json: whichever bound binds first. */
export const JOB_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const JOB_RECORD_RETENTION_COUNT = 1_000;

/** Prefix every Motion-minted job id carries, so a supplied id is distinguishable from ours. */
const MINTED_JOB_ID_PREFIX = "motion-job-";

/**
 * A job that will not change again.
 *
 * Deliberately flat and self-describing: it is read by a different process from the one that wrote
 * it, often a different version, so it carries its own schema tag and no references to live state.
 */
export interface MotionJobRecord {
  schema: "shellx-motion/job-record@1";
  jobId: string;
  callerId: string;
  lane: string;
  operation: string;
  /** Always "ended". Present so a record and a live lease project into one shape without a branch. */
  lifecycle: "ended";
  outcome: JobOutcome;
  createdAtMs: number;
  /** Absent when the job never ran — the machine-checkable proof that `skipped` really skipped. */
  startedAtMs?: number;
  endedAtMs: number;
  durationMs: number;
  queueWaitMs: number;
  /** Present if and only if outcome is "failed". The contract's load-bearing invariant. */
  error?: { code: JobErrorCode; message: string; retryable: boolean };
  /** Present if and only if outcome is "cancelled". */
  cancellation?: { requestedBy: string; reason?: string };
  /** Present if and only if outcome is "skipped". */
  skip?: { code: JobSkipCode; reason?: string };
  warnings: string[];
  /** Where the evidence for this job lives, when the operation wrote one. */
  receiptPath?: string;
}

export interface MotionJobRegistryServices {
  now?: () => number;
  /** Overridden in tests and by hosts that place runtime state elsewhere. */
  recordRoot?: string;
}

/** Where terminal records live: beside the leases, so one runtime directory holds all job state. */
export function defaultMotionJobRecordRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SHELLX_MOTION_JOB_RECORD_ROOT?.trim();
  if (explicit) return explicit;
  return join(defaultMotionJobLeaseRoot(env), "..", "job-records");
}

/**
 * Mint a job id that carries its own creation time.
 *
 * The timestamp is base36 and fixed-width-ish, which keeps ids sortable by age and lets an unknown
 * id be classified against the prune horizon. Randomness still dominates uniqueness — the time
 * component is for classification, never for collision avoidance.
 */
export function mintMotionJobId(nowMs: number = Date.now()): string {
  return `${MINTED_JOB_ID_PREFIX}${Math.max(0, Math.floor(nowMs)).toString(36)}-${randomUUID()}`;
}

/**
 * Recover the mint time from a Motion-minted id, or null for a caller-supplied one.
 *
 * Returning null rather than guessing is the point: a caller-supplied id genuinely carries no time,
 * and inventing one would produce a confident `job_expired` for a job that never existed.
 */
export function motionJobIdMintedAtMs(jobId: string): number | null {
  if (!jobId.startsWith(MINTED_JOB_ID_PREFIX)) return null;
  const stamp = jobId.slice(MINTED_JOB_ID_PREFIX.length).split("-")[0];
  if (!stamp || !/^[0-9a-z]{1,12}$/.test(stamp)) return null;
  const parsed = Number.parseInt(stamp, 36);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A caller-supplied job id must be safe as a filename and stable across processes.
 *
 * Rejecting rather than sanitizing is deliberate: two ids that differ only in rejected characters
 * would sanitize to one file and silently overwrite each other's evidence.
 */
export function assertMotionJobId(jobId: string): string {
  if (typeof jobId !== "string" || jobId.length < 1 || jobId.length > 128 || !/^[a-z0-9._:-]+$/i.test(jobId)) {
    throw new Error("Motion job id must be 1..128 characters of letters, digits, dot, underscore, colon or hyphen.");
  }
  return jobId;
}

/**
 * Write a record so a concurrent reader never sees it half-written.
 *
 * Same reasoning as the lease directory: `writeFile` truncates before it fills, and a reader
 * polling at the wrong moment gets a partial file. Renaming a fully-written sibling is atomic.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "w" });
  await rename(temporary, path);
}



/** Per-user store of finished work, pruned by age and count. */
export class MotionJobRegistry {
  private readonly root: string;
  private readonly now: () => number;
  /** Latches once a filesystem operation fails, so a broken directory is not retried per job. */
  private degraded = false;

  constructor(services: MotionJobRegistryServices = {}) {
    this.root = services.recordRoot ?? defaultMotionJobRecordRoot();
    this.now = services.now ?? Date.now;
  }

  /** True once recording has failed; rendering continues, reporting does not. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Persist a finished job, then prune.
   *
   * Pruning on write rather than on read keeps queries cheap and bounds growth at the only moment
   * the directory actually grows.
   */
  async record(record: MotionJobRecord): Promise<void> {
    if (this.degraded) return;
    try {
      await mkdir(this.root, { recursive: true });
      await writeJsonAtomic(this.recordPath(record.jobId, record.endedAtMs), record);
    } catch {
      this.degraded = true;
      return;
    }
    // A jobId may legitimately be reused by a host that names its own jobs. Without this, the two
    // runs would sit side by side under different end times and both answer the same lookup.
    await this.removeOtherFilesFor(record.jobId, record.endedAtMs);
    await this.prune();
  }

  /**
   * Attach detail a later layer learned, without rewriting the outcome.
   *
   * The governor owns resources and knows how a job ended; it does not know where the receipt was
   * written, because receipts are produced above it. Rather than push receipt paths down into the
   * resource layer, the layer that writes one amends the record afterwards. A no-op when the record
   * is gone, which is the honest result for a job whose evidence has already been pruned.
   */
  async amend(jobId: string, patch: Pick<Partial<MotionJobRecord>, "receiptPath" | "warnings">): Promise<void> {
    if (this.degraded) return;
    const existing = await this.findRecord(jobId);
    if (!existing) return;
    const merged: MotionJobRecord = {
      ...existing,
      ...(patch.receiptPath ? { receiptPath: patch.receiptPath } : {}),
      ...(patch.warnings ? { warnings: [...existing.warnings, ...patch.warnings] } : {})
    };
    try {
      await writeJsonAtomic(this.recordPath(jobId, merged.endedAtMs), merged);
    } catch {
      this.degraded = true;
    }
  }

  /**
   * Look up one finished job, distinguishing the three ways a lookup can come up empty.
   *
   * `job_expired` versus `job_unknown` is not a cosmetic distinction: the first says "your job ran,
   * the evidence aged out, look at the receipts", the second says "this id never existed here".
   */
  async read(input: { jobId: string; callerId: string; scope?: "own" | "all" }): Promise<
    { ok: true; record: MotionJobRecord } | { ok: false; code: "job_unknown" | "job_expired" | "job_not_visible" }
  > {
    const record = await this.findRecord(input.jobId);
    if (!record) {
      const mintedAtMs = motionJobIdMintedAtMs(input.jobId);
      // Only an id whose age we can actually read may be called expired.
      const expired = mintedAtMs !== null && mintedAtMs < this.now() - JOB_RECORD_RETENTION_MS;
      return { ok: false, code: expired ? "job_expired" : "job_unknown" };
    }
    if (input.scope !== "all" && record.callerId !== input.callerId) return { ok: false, code: "job_not_visible" };
    return { ok: true, record };
  }

  /**
   * Finished work this caller may see, newest first.
   *
   * Ordering comes from the filenames, so only the records actually returned are read. A host
   * asking for the last twenty jobs reads twenty files, not the whole retained history.
   */
  async list(input: { callerId: string; scope?: "own" | "all"; limit?: number }): Promise<MotionJobRecord[]> {
    const files = (await this.listFiles()).sort((left, right) => right.endedAtMs - left.endedAtMs);
    const limit = Math.max(0, Math.min(input.limit ?? JOB_RECORD_RETENTION_COUNT, JOB_RECORD_RETENTION_COUNT));
    const visible: MotionJobRecord[] = [];
    for (const file of files) {
      if (visible.length >= limit) break;
      const record = await this.readRecord(join(this.root, file.name));
      if (!record) continue;
      if (input.scope !== "all" && record.callerId !== input.callerId) continue;
      visible.push(record);
    }
    return visible;
  }

  /**
   * Drop records past either retention bound.
   *
   * Decided entirely from filenames, which is why the end time is encoded in them: pruning ran on
   * every write, and reading every record to decide made writing a job O(retained jobs). At the
   * 1000-record bound that was a thousand file reads per render.
   *
   * Age is applied first so a quiet week still expires, then count, so a busy hour still bounds the
   * directory. Applying only one of the two leaves an unbounded case in each direction.
   */
  async prune(): Promise<void> {
    if (this.degraded) return;
    const files = await this.listFiles();
    const cutoff = this.now() - JOB_RECORD_RETENTION_MS;
    const aged = files.filter((file) => file.endedAtMs < cutoff);
    const fresh = files.filter((file) => file.endedAtMs >= cutoff)
      .sort((left, right) => right.endedAtMs - left.endedAtMs);
    const overflow = fresh.slice(JOB_RECORD_RETENTION_COUNT);
    await Promise.all([...aged, ...overflow].map((file) =>
      rm(join(this.root, file.name), { force: true }).catch(() => {})));
  }

  /** Every record file with its end time, read from the name alone. */
  private async listFiles(): Promise<Array<{ name: string; endedAtMs: number }>> {
    const entries = await readdir(this.root).catch(() => [] as string[]);
    return entries.flatMap((name) => {
      const parsed = /^(.+)--(\d+)\.job\.json$/.exec(name);
      return parsed ? [{ name, endedAtMs: Number(parsed[2]) }] : [];
    });
  }

  /**
   * Find a record by job id.
   *
   * The id is verified against the file's contents rather than trusted from its name: two ids that
   * differ only in characters the filename encoding folds together (`a:b` and `a-b`) produce the
   * same prefix, and returning the wrong job's evidence would be worse than returning none.
   */
  private async findRecord(jobId: string): Promise<MotionJobRecord | null> {
    const prefix = `${motionJobFileKey(jobId)}--`;
    const candidates = (await this.listFiles())
      .filter((file) => file.name.startsWith(prefix))
      .sort((left, right) => right.endedAtMs - left.endedAtMs);
    for (const candidate of candidates) {
      const record = await this.readRecord(join(this.root, candidate.name));
      if (record?.jobId === jobId) return record;
    }
    return null;
  }

  /**
   * Remove earlier files for a job that has just been rewritten under a new end time.
   *
   * Every candidate is read and its stored `jobId` checked before deletion. `findRecord` already
   * verified contents on the READ path while this delete trusted the filename prefix alone, and
   * that asymmetry was the whole defect: under the old folded encoding a second caller writing
   * `a-b` prefix-matched and deleted the terminal record of a different caller's `a:b`, so a job
   * that had genuinely succeeded answered `job_unknown` for good. The prefix is injective now;
   * confirming before an irreversible delete is what keeps a future encoding change from
   * re-opening it.
   */
  private async removeOtherFilesFor(jobId: string, keepEndedAtMs: number): Promise<void> {
    const prefix = `${motionJobFileKey(jobId)}--`;
    const candidates = (await this.listFiles()).filter((file) =>
      file.name.startsWith(prefix) && file.endedAtMs !== keepEndedAtMs);
    await Promise.all(candidates.map(async (file) => {
      const path = join(this.root, file.name);
      const record = await this.readRecord(path);
      // An unreadable file under this job's own prefix is this job's own corrupt leftover; a
      // readable one naming another job is not ours to delete.
      if (record && record.jobId !== jobId) return;
      await rm(path, { force: true }).catch(() => {});
    }));
  }

  private recordPath(jobId: string, endedAtMs: number): string {
    return join(this.root, `${motionJobFileKey(jobId)}--${Math.max(0, Math.floor(endedAtMs))}.job.json`);
  }

  private async readRecord(path: string): Promise<MotionJobRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<MotionJobRecord>;
      if (parsed?.schema !== "shellx-motion/job-record@1") return null;
      if (typeof parsed.jobId !== "string" || typeof parsed.endedAtMs !== "number") return null;
      if (typeof parsed.outcome !== "string") return null;
      // Records written before owner attribution still describe real work; treat them as
      // unattributed rather than dropping evidence a caller may be waiting on.
      if (typeof parsed.callerId !== "string") parsed.callerId = UNATTRIBUTED_CALLER_ID;
      if (!Array.isArray(parsed.warnings)) parsed.warnings = [];
      return parsed as MotionJobRecord;
    } catch {
      return null;
    }
  }
}
