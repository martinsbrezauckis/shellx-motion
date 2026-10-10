/**
 * Shared durable terminal-record text contract.
 *
 * The host writer and record reader must agree here: terminal evidence is useful only when the
 * acknowledged bytes remain readable after the worker and its live lease are gone.
 */
import { isPlainRecord } from "./lifecycle-envelope-validation";

/** Matches the normal streamed-final adapter's deliberately retained warning capacity. */
export const MOTION_JOB_RECORD_MAX_WARNINGS = 64;
export const MOTION_JOB_RECORD_MAX_WARNING_CHARS = 512;
export const MOTION_JOB_RECORD_MAX_CANCELLATION_REQUESTED_BY_CHARS = 256;
export const MOTION_JOB_RECORD_MAX_CANCELLATION_REASON_CHARS = 4_096;

export interface MotionJobRecordCancellation {
  requestedBy: string;
  reason?: string;
}

/** Durable text excludes control delimiters so records retain one unambiguous JSON projection. */
export function isMotionJobRecordText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && Array.from(value).length >= 1
    && Array.from(value).length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Strict reader-side warning parser. A present malformed field invalidates the complete record. */
export function parseMotionJobRecordWarnings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MOTION_JOB_RECORD_MAX_WARNINGS) return null;
  return value.every((warning) => isMotionJobRecordText(warning, MOTION_JOB_RECORD_MAX_WARNING_CHARS))
    ? [...value]
    : null;
}

/**
 * Writer-side warning projection. Optional diagnostics must never make the terminal fact itself
 * unreadable; retain the bounded prefix that has the same contract as the durable reader.
 */
export function canonicalMotionJobRecordWarnings(value: readonly unknown[] | undefined): string[] {
  const warnings: string[] = [];
  for (const warning of value ?? []) {
    if (warnings.length === MOTION_JOB_RECORD_MAX_WARNINGS) break;
    if (isMotionJobRecordText(warning, MOTION_JOB_RECORD_MAX_WARNING_CHARS)) warnings.push(warning);
  }
  return warnings;
}

/** Evidence mirrors only survive when they contain the same canonical warning projection. */
export function sameMotionJobRecordWarnings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((warning, index) => warning === right[index]);
}

/** Strict reader-side cancellation parser. */
export function parseMotionJobRecordCancellation(value: unknown): MotionJobRecordCancellation | null {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== "requestedBy" && key !== "reason")) return null;
  const requestedBy = isMotionJobRecordText(value.requestedBy, MOTION_JOB_RECORD_MAX_CANCELLATION_REQUESTED_BY_CHARS)
    ? value.requestedBy
    : null;
  const reason = value.reason === undefined
    ? undefined
    : isMotionJobRecordText(value.reason, MOTION_JOB_RECORD_MAX_CANCELLATION_REASON_CHARS)
      ? value.reason
      : null;
  if (requestedBy === null || reason === null) return null;
  return { requestedBy, ...(reason === undefined ? {} : { reason }) };
}

/**
 * Writer-side cancellation projection. A host caller identity remains the fallback attribution;
 * malformed optional reason text is omitted rather than invalidating the terminal record.
 */
export function canonicalMotionJobRecordCancellation(
  value: { requestedBy?: unknown; reason?: unknown } | undefined,
  fallbackRequestedBy: string
): MotionJobRecordCancellation | undefined {
  const candidateRequestedBy = value?.requestedBy;
  const requestedBy = isMotionJobRecordText(candidateRequestedBy, MOTION_JOB_RECORD_MAX_CANCELLATION_REQUESTED_BY_CHARS)
    ? candidateRequestedBy
    : isMotionJobRecordText(fallbackRequestedBy, MOTION_JOB_RECORD_MAX_CANCELLATION_REQUESTED_BY_CHARS)
      ? fallbackRequestedBy
      : undefined;
  if (!requestedBy) return undefined;
  const candidateReason = value?.reason;
  const reason = isMotionJobRecordText(candidateReason, MOTION_JOB_RECORD_MAX_CANCELLATION_REASON_CHARS)
    ? candidateReason
    : undefined;
  return { requestedBy, ...(reason === undefined ? {} : { reason }) };
}
