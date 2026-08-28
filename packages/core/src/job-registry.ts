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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultMotionJobLeaseRoot } from "./job-lease";
import { motionJobOwnerKey } from "./job-id-file";
import { compareCodeUnits } from "./canonical-json";
import type { JobOutcome, JobSkipCode } from "./generated/job-status";
import type { MotionJobFailure } from "./job-failure";
import type { MotionJobFrameLane } from "./job-frame-lane";
import {
  findUnambiguousMotionJobRecord,
  hasExclusiveOwnedLegacyMotionJobRecord,
  isCurrentMotionJobRecordFile,
  listMotionJobRecordFiles,
  pruneMotionJobRecords,
  readMotionJobRecord,
  removeOtherMotionJobRecords,
  writeMotionJobRecord
} from "./job-registry-storage";

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
  /** Optional final-render rasterizer. Omitted by legacy and non-final host jobs. */
  frameLane?: MotionJobFrameLane;
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
  error?: MotionJobFailure;
  /** Present if and only if outcome is "cancelled". */
  cancellation?: { requestedBy: string; reason?: string };
  /** Present if and only if outcome is "skipped". */
  skip?: { code: JobSkipCode; reason?: string };
  warnings: string[];
  /** Where the evidence for this job lives, when the operation wrote one. */
  receiptPath?: string;
  /** Exact final receipt id, retained even when the host does not persist it to a path. */
  receiptId?: string;
  /** A compact reference to producer evidence already contained by the final receipt. */
  producerEvidence?: { frameLane: MotionJobFrameLane; schema?: string };
  /** A retry is a new run, never a mutation of the source job. */
  lineage?: { priorJobId?: string; priorReceiptId?: string; retryAttempt?: number };
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
      await writeMotionJobRecord(this.root, record);
    } catch {
      this.degraded = true;
      return;
    }
    // A jobId may legitimately be reused by a host that names its own jobs. Without this, the two
    // runs would sit side by side under different end times and both answer the same lookup.
    await removeOtherMotionJobRecords(this.root, record);
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
  async amend(input: {
    callerId: string;
    jobId: string;
    patch: Pick<Partial<MotionJobRecord>, "receiptPath" | "warnings">;
  }): Promise<void>;
  /** @deprecated Pass `{ callerId, jobId, patch }`; ambiguous external ids are refused. */
  async amend(jobId: string, patch: Pick<Partial<MotionJobRecord>, "receiptPath" | "warnings">): Promise<void>;
  async amend(
    input: { callerId: string; jobId: string; patch: Pick<Partial<MotionJobRecord>, "receiptPath" | "warnings"> } | string,
    positionalPatch?: Pick<Partial<MotionJobRecord>, "receiptPath" | "warnings">
  ): Promise<void> {
    if (this.degraded) return;
    const authenticated = typeof input !== "string";
    const existing = authenticated
      ? await this.findRecord({ jobId: input.jobId, callerId: input.callerId })
      : await findUnambiguousMotionJobRecord(this.root, input);
    const patch = authenticated ? input.patch : positionalPatch;
    if (!existing || !patch || (authenticated && existing.callerId !== input.callerId)) return;
    const merged: MotionJobRecord = {
      ...existing,
      ...(patch.receiptPath ? { receiptPath: patch.receiptPath } : {}),
      ...(patch.warnings ? { warnings: [...existing.warnings, ...patch.warnings] } : {})
    };
    try {
      await writeMotionJobRecord(this.root, merged);
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
    const record = await this.findRecord(input);
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
    const files = (await listMotionJobRecordFiles(this.root)).sort((left, right) => right.endedAtMs - left.endedAtMs);
    const limit = Math.max(0, Math.min(input.limit ?? JOB_RECORD_RETENTION_COUNT, JOB_RECORD_RETENTION_COUNT));
    const visible: MotionJobRecord[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      if (visible.length >= limit) break;
      const record = await readMotionJobRecord(this.root, file.name);
      if (!record) continue;
      const current = isCurrentMotionJobRecordFile(file.name, record);
      // Old record paths were keyed by external job id alone.  They can only be read by their
      // stored owner; `scope: all` is not an owner selector and must not turn them into a
      // cross-owner compatibility leak.
      if (!current && record.callerId !== input.callerId) continue;
      if (current && input.scope !== "all" && record.callerId !== input.callerId) continue;
      const identity = motionJobOwnerKey(record.callerId, record.jobId);
      if (seen.has(identity)) continue;
      seen.add(identity);
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
    await pruneMotionJobRecords(this.root, this.now(), JOB_RECORD_RETENTION_MS, JOB_RECORD_RETENTION_COUNT);
  }

  /** Internal compatibility guard for ownerless legacy event snapshots. */
  async hasExclusiveOwnedLegacyEventRecord(input: { callerId: string; jobId: string }): Promise<boolean> {
    return await hasExclusiveOwnedLegacyMotionJobRecord(this.root, input);
  }

  /**
   * Find a record by job id.
   *
   * The id is verified against the file's contents rather than trusted from its name: two ids that
   * differ only in characters the filename encoding folds together (`a:b` and `a-b`) produce the
   * same prefix, and returning the wrong job's evidence would be worse than returning none.
   */
  private async findRecord(input: { jobId: string; callerId: string; scope?: "own" | "all" }): Promise<MotionJobRecord | null> {
    const candidates = (await listMotionJobRecordFiles(this.root))
      .sort((left, right) => right.endedAtMs - left.endedAtMs || compareCodeUnits(left.name, right.name));
    let deniedCurrent: MotionJobRecord | null = null;
    for (const candidate of candidates) {
      const record = await readMotionJobRecord(this.root, candidate.name);
      if (!record || record.jobId !== input.jobId) continue;
      const current = isCurrentMotionJobRecordFile(candidate.name, record);
      if (current && input.scope === "all") return record;
      if (current && record.callerId === input.callerId) return record;
      if (current) {
        deniedCurrent ??= record;
        continue;
      }
      // A pre-owner-namespace record is compatible only for the identity stored in the record.
      // Its path alone has no authenticated owner information, so it is never considered for an
      // `all` read of a different caller's tuple.
      if (!current && record.callerId === input.callerId) return record;
    }
    return deniedCurrent;
  }

}
