/**
 * Run-scoped storage primitives for machine-wide job leases.
 *
 * A caller-facing job id can be reused, so the mutable lease needs a second, per-run identity.
 * Each nonce gets its own directory. Removing that directory is the no-recreate boundary: an old
 * heartbeat cannot write through a released parent or into a successor's differently named run.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { motionJobFileKey } from "./job-id-file";
import type { MotionJobLeaseRecord } from "./job-lease-types";
import { isMotionJobFrameLane } from "./job-frame-lane";
import { PrivateMotionRuntimeDirectory } from "./private-runtime-directory";

/** Opaque identity of one live lease run, never exposed by the caller-facing job-status contract. */
export interface MotionJobLeaseRun {
  jobId: string;
  runNonce: string;
}

/** Mint a new filesystem-safe capability for one lease lifecycle. */
export function mintMotionJobLeaseRun(jobId: string): MotionJobLeaseRun {
  return { jobId, runNonce: randomUUID() };
}

/** Reject malformed identities before they can be made part of a filesystem path. */
export function isMotionJobLeaseRunNonce(value: string): boolean {
  return /^[a-f0-9-]{8,128}$/i.test(value);
}

/** Final deterministic tie-breaker when two callers chose the same public job id and timestamp. */
export function compareMotionJobLeaseRunNonce(left: string | undefined, right: string | undefined): number {
  const leftValue = left ?? "";
  const rightValue = right ?? "";
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

/** Write one record atomically without colliding with overlapping heartbeats from the same pid. */
export async function writeMotionJobLeaseJsonAtomic(path: string, value: unknown, pid: number): Promise<void> {
  const temporary = `${path}.${pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Read one lease only after its persisted shape passes the storage boundary checks. */
export async function readMotionJobLeaseRecord(path: string, unattributedCallerId: string): Promise<MotionJobLeaseRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const schema = ownValue(parsed, "schema");
    const jobId = jobIdValue(ownValue(parsed, "jobId"));
    const pid = positiveSafeInteger(ownValue(parsed, "pid"));
    const lane = boundedString(ownValue(parsed, "lane"), 128);
    const frameLane = ownValue(parsed, "frameLane");
    const operation = boundedString(ownValue(parsed, "operation"), 256);
    const caller = ownValue(parsed, "callerId");
    const visibility = ownValue(parsed, "visibility");
    const startedAtMs = nonNegativeSafeInteger(ownValue(parsed, "startedAtMs"));
    const admittedAtMs = ownValue(parsed, "admittedAtMs");
    const heartbeatAtMs = nonNegativeSafeInteger(ownValue(parsed, "heartbeatAtMs"));
    const admitted = ownValue(parsed, "admitted");
    const runNonce = ownValue(parsed, "runNonce");
    const cancellation = ownValue(parsed, "cancelRequested");
    if (schema !== "shellx-motion/job-lease@1") return null;
    if (jobId === null || pid === null || lane === null || operation === null) return null;
    if (frameLane !== undefined && !isMotionJobFrameLane(frameLane)) return null;
    const callerId = caller === undefined ? unattributedCallerId : boundedString(caller, 256);
    if (callerId === null) return null;
    if (visibility !== undefined && visibility !== "host" && visibility !== "internal") return null;
    if (startedAtMs === null || heartbeatAtMs === null) return null;
    const admittedAt = admittedAtMs === undefined ? undefined : nonNegativeSafeInteger(admittedAtMs);
    if (admittedAt === null) return null;
    if (typeof admitted !== "boolean") return null;
    if ((admittedAt === undefined) === admitted) return null;
    if (runNonce !== undefined && (typeof runNonce !== "string" || !isMotionJobLeaseRunNonce(runNonce))) return null;
    let cancelRequested: MotionJobLeaseRecord["cancelRequested"];
    if (cancellation !== undefined) {
      if (cancellation === null || typeof cancellation !== "object" || Array.isArray(cancellation)) return null;
      const requestedBy = boundedString(ownValue(cancellation, "requestedBy"), 256);
      const requestedAtMs = nonNegativeSafeInteger(ownValue(cancellation, "requestedAtMs"));
      const reason = ownValue(cancellation, "reason");
      if (requestedBy === null || requestedAtMs === null) return null;
      const boundedReason = reason === undefined ? undefined : boundedString(reason, 4_096);
      if (boundedReason === null) return null;
      cancelRequested = { requestedBy, requestedAtMs, ...(boundedReason === undefined ? {} : { reason: boundedReason }) };
    }
    // Records from before owner attribution remain live work, but never become visible to everyone.
    return {
      schema,
      jobId,
      ...(runNonce === undefined ? {} : { runNonce }),
      pid,
      lane,
      ...(frameLane === undefined ? {} : { frameLane }),
      operation,
      callerId,
      ...(visibility === undefined ? {} : { visibility }),
      startedAtMs,
      ...(admittedAt === undefined ? {} : { admittedAtMs: admittedAt }),
      heartbeatAtMs,
      ...(cancelRequested === undefined ? {} : { cancelRequested }),
      admitted
    };
  } catch {
    return null;
  }
}

function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength ? value : null;
}

function jobIdValue(value: unknown): string | null {
  const jobId = boundedString(value, 128);
  return jobId !== null && /^[a-z0-9._:-]+$/i.test(jobId) ? jobId : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveSafeInteger(value: unknown): number | null {
  const integer = nonNegativeSafeInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}

/** Filesystem layout and publication operations for nonce-protected modern lease runs. */
export class MotionJobLeaseRunStorage {
  private readonly runtime: PrivateMotionRuntimeDirectory;

  constructor(
    private readonly root: string,
    private readonly pid: number
  ) {
    this.runtime = new PrivateMotionRuntimeDirectory(root);
  }

  async assertCurrent(): Promise<void> {
    await this.runtime.assertCurrent();
  }

  recordPath(run: MotionJobLeaseRun): string {
    return join(this.directoryPath(run), "lease.json");
  }

  legacyRecordPath(jobId: string): string {
    return join(this.root, `${motionJobFileKey(jobId)}.lease.json`);
  }

  entryRecordPath(entry: string): string {
    return join(this.root, entry, "lease.json");
  }

  entryDirectoryPath(entry: string): string {
    return join(this.root, entry);
  }

  async publish(run: MotionJobLeaseRun, record: unknown): Promise<void> {
    await this.assertCurrent();
    const directory = this.directoryPath(run);
    const temporary = `${directory}.${this.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(temporary, { mode: 0o700 });
      await writeFile(join(temporary, "lease.json"), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Publish a complete directory in one rename so readers never see a half-created record.
      await rename(temporary, directory);
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }

  async release(run: MotionJobLeaseRun): Promise<void> {
    await this.assertCurrent();
    await rm(this.directoryPath(run), { recursive: true, force: true });
  }

  /** Read modern and legacy entries, deleting only records that ceased to be live evidence. */
  async readLive<T>(readRecord: (path: string) => Promise<T | null>, isAbandoned: (record: T) => boolean): Promise<T[]> {
    await this.assertCurrent();
    const entries = await readdir(this.root).catch(() => [] as string[]);
    const live: T[] = [];
    for (const entry of entries) {
      const modern = entry.endsWith(".lease");
      const legacy = entry.endsWith(".lease.json");
      if (!modern && !legacy) continue;
      const path = modern ? this.entryRecordPath(entry) : join(this.root, entry);
      const record = await readRecord(path);
      if (record && !isAbandoned(record)) {
        live.push(record);
        continue;
      }
      await rm(modern ? this.entryDirectoryPath(entry) : path, { recursive: modern, force: true }).catch(() => {});
    }
    return live;
  }

  private directoryPath(run: MotionJobLeaseRun): string {
    return join(this.root, `${motionJobFileKey(run.jobId)}--${run.runNonce}.lease`);
  }
}
