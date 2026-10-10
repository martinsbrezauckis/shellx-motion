/** Logical retention for quiet-host job queries; it never unlinks durable state. */
import { compareCodeUnits } from "./canonical-json";
import { listValidatedCurrentMotionJobRecords, type ValidatedCurrentMotionJobRecordFile } from "./job-registry-storage";

/**
 * Return current record filenames visible under the age and per-owner count bounds.
 *
 * The storage reader validates each owner-qualified leaf before using its body.  This is a query
 * projection only: files are deliberately preserved because a concurrent atomic amend cannot be
 * safely compared and unlinked without a writer/remover lock shared by every process.
 */
export async function retainedMotionJobRecordNames(
  root: string,
  nowMs: number,
  retentionMs: number,
  retentionCount: number
): Promise<ReadonlySet<string>> {
  return retainedMotionJobRecordNamesFromSnapshot(
    await listValidatedCurrentMotionJobRecords(root), nowMs, retentionMs, retentionCount
  );
}

/** Apply the ordinary logical-retention ordering to one caller-owned validated snapshot. */
export function retainedMotionJobRecordNamesFromSnapshot(
  records: readonly ValidatedCurrentMotionJobRecordFile[],
  nowMs: number,
  retentionMs: number,
  retentionCount: number
): ReadonlySet<string> {
  const cutoff = nowMs - retentionMs;
  const byOwner = new Map<string, ValidatedCurrentMotionJobRecordFile[]>();
  for (const record of records) {
    if (record.endedAtMs < cutoff) continue;
    const owned = byOwner.get(record.record.callerId) ?? [];
    owned.push(record);
    byOwner.set(record.record.callerId, owned);
  }
  const retained = new Set<string>();
  for (const owned of byOwner.values()) {
    owned.sort((left, right) => right.endedAtMs - left.endedAtMs || compareCodeUnits(left.name, right.name));
    for (const record of owned.slice(0, retentionCount)) retained.add(record.name);
  }
  return retained;
}
