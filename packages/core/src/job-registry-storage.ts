/** Filesystem mechanics for terminal job records; registry policy stays in job-registry.ts. */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { motionJobOwnerKey } from "./job-id-file";
import { readStoredMotionJobRecord } from "./job-record-read";
import type { MotionJobRecord } from "./job-registry";

export interface MotionJobRecordFile {
  name: string;
  endedAtMs: number;
}

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

export async function removeOtherMotionJobRecords(root: string, record: MotionJobRecord): Promise<void> {
  const keep = motionJobRecordFileName(record.callerId, record.jobId, record.endedAtMs);
  const candidates = (await listMotionJobRecordFiles(root)).filter((file) => file.name !== keep);
  await Promise.all(candidates.map(async (file) => {
    const stored = await readMotionJobRecord(root, file.name);
    if (!stored || stored.jobId !== record.jobId || stored.callerId !== record.callerId) return;
    await rm(join(root, file.name), { force: true }).catch(() => {});
  }));
}

export async function pruneMotionJobRecords(
  root: string,
  nowMs: number,
  retentionMs: number,
  retentionCount: number
): Promise<void> {
  const files = await listMotionJobRecordFiles(root);
  const cutoff = nowMs - retentionMs;
  const aged = files.filter((file) => file.endedAtMs < cutoff);
  const fresh = files.filter((file) => file.endedAtMs >= cutoff)
    .sort((left, right) => right.endedAtMs - left.endedAtMs);
  const freshByOwner = new Map<string, MotionJobRecordFile[]>();
  for (const file of fresh) {
    const record = await readMotionJobRecord(root, file.name);
    if (!record) continue;
    const owned = freshByOwner.get(record.callerId) ?? [];
    owned.push(file);
    freshByOwner.set(record.callerId, owned);
  }
  const overCount = [...freshByOwner.values()].flatMap((owned) => owned.slice(retentionCount));
  await Promise.all([...aged, ...overCount].map((file) =>
    rm(join(root, file.name), { force: true }).catch(() => {})));
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
