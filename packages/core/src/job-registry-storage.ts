/** Filesystem mechanics for terminal job records; registry policy stays in job-registry.ts. */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { motionJobOwnerKey } from "./job-id-file";
import { parseStoredMotionJobRecord, readStoredMotionJobRecord } from "./job-record-read";
import type { MotionJobRecord } from "./job-registry";

export interface MotionJobRecordFile {
  name: string;
  endedAtMs: number;
}

/** A current owner-qualified filename whose contents independently validated that identity. */
export interface ValidatedCurrentMotionJobRecordFile extends MotionJobRecordFile {
  record: MotionJobRecord;
}

const MOTION_JOB_RECORD_RETENTION_MAX_BYTES = 512 * 1024;

export async function writeMotionJobRecord(root: string, record: MotionJobRecord): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(root, motionJobRecordFileName(record.callerId, record.jobId, record.endedAtMs)), record);
}

export async function listMotionJobRecordFiles(root: string): Promise<MotionJobRecordFile[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries.flatMap((name) => {
    const parsed = /^(.+)--(\d+)\.job\.json$/.exec(name);
    return parsed ? [{ name, endedAtMs: Number(parsed[2]) }] : [];
  });
}

export async function readMotionJobRecord(root: string, name: string): Promise<MotionJobRecord | null> {
  return await readStoredMotionJobRecord(join(root, name));
}

export async function listValidatedCurrentMotionJobRecords(root: string): Promise<ValidatedCurrentMotionJobRecordFile[]> {
  const current: ValidatedCurrentMotionJobRecordFile[] = [];
  for (const file of await listMotionJobRecordFiles(root)) {
    const retained = await readCurrentMotionJobRecordForRetention(root, file.name);
    if (retained && isCurrentMotionJobRecordFile(file.name, retained.record)) current.push({ ...file, ...retained });
  }
  return current;
}

/** Compatibility lookup for the former caller-less amend(jobId, patch) API. */
export async function findUnambiguousMotionJobRecord(root: string, jobId: string): Promise<MotionJobRecord | null> {
  const matches: MotionJobRecord[] = [];
  for (const file of await listMotionJobRecordFiles(root)) {
    const record = await readMotionJobRecord(root, file.name);
    if (record?.jobId === jobId) matches.push(record);
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** True only when one legacy terminal record authorizes this caller to read the legacy event log. */
export async function hasExclusiveOwnedLegacyMotionJobRecord(
  root: string,
  input: { callerId: string; jobId: string }
): Promise<boolean> {
  const legacy: MotionJobRecord[] = [];
  let hasCurrentOwnedRecord = false;
  for (const file of await listMotionJobRecordFiles(root)) {
    const record = await readMotionJobRecord(root, file.name);
    if (!record || record.jobId !== input.jobId) continue;
    if (isCurrentMotionJobRecordFile(file.name, record)) {
      hasCurrentOwnedRecord ||= record.callerId === input.callerId;
    } else {
      legacy.push(record);
    }
  }
  return !hasCurrentOwnedRecord && legacy.length === 1 && legacy[0]!.callerId === input.callerId;
}

export function motionJobRecordFileName(callerId: string, jobId: string, endedAtMs: number): string {
  return `${motionJobOwnerKey(callerId, jobId)}--${Math.max(0, Math.floor(endedAtMs))}.job.json`;
}

export function isCurrentMotionJobRecordFile(name: string, record: MotionJobRecord): boolean {
  return name === motionJobRecordFileName(record.callerId, record.jobId, record.endedAtMs);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readCurrentMotionJobRecordForRetention(root: string, name: string): Promise<{ record: MotionJobRecord } | null> {
  try {
    const path = join(root, name);
    const before = await lstat(path);
    assertRetentionRecordFile(before);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      assertRetentionRecordFile(opened);
      if (!sameFile(before, opened)) return null;
      const raw = Buffer.allocUnsafe(opened.size + 1);
      let offset = 0;
      while (offset < raw.byteLength) {
        const { bytesRead } = await handle.read(raw, offset, raw.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      const lexicalAfter = await lstat(path);
      if (offset !== opened.size || !sameFile(opened, after) || !sameFile(after, lexicalAfter)) return null;
      const record = parseStoredMotionJobRecord(raw.subarray(0, offset).toString("utf8"));
      return record ? { record } : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function assertRetentionRecordFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !Number.isSafeInteger(metadata.size)
    || metadata.size < 2 || metadata.size > MOTION_JOB_RECORD_RETENTION_MAX_BYTES) {
    throw new Error("Motion job retention record must be a bounded single-link regular non-symlink file.");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
