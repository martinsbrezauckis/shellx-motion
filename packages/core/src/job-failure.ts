/** Bounded terminal failure metadata shared by renders, connectors, Debug/MCP and host records. */
import { JOB_STATUS_CONTRACT, type JobErrorCode, type JobRemedyKind } from "./generated/job-status";

export const MOTION_JOB_FAILURE_CODE_MAX_CHARS = 96;
export const MOTION_JOB_FAILURE_MESSAGE_MAX_CHARS = 2_048;
export const MOTION_JOB_FAILURE_ACTION_MAX_CHARS = 1_024;
export const MOTION_JOB_FAILURE_RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1_000;

const CODE = /^[a-z][a-z0-9_.:-]{0,95}$/u;
const KNOWN = new Map<string, { retryable: boolean; remedy: JobRemedyKind }>(
  JOB_STATUS_CONTRACT.errorCodes.map((entry) => [entry.code, { retryable: entry.retryable, remedy: entry.remedy }])
);
const REMEDIES = new Set<JobRemedyKind>(JOB_STATUS_CONTRACT.remedyKinds.map((entry) => entry.kind));

/**
 * Known core codes keep their authored retry policy. A future capability-owned code remains a
 * bounded string and carries its producer-declared policy instead of being collapsed to a core code.
 */
export interface MotionJobFailure {
  code: string;
  message: string;
  retryable: boolean;
  remedy?: JobRemedyKind;
  retryAfterMs?: number;
  suggestedAction?: string;
}

/** Live producer input; normalization fills the mandatory retry policy before durable storage. */
export interface MotionJobFailureInput {
  code: string;
  message: string;
  retryable?: boolean;
  remedy?: JobRemedyKind;
  retryAfterMs?: number;
  suggestedAction?: string;
}

export function isKnownMotionJobErrorCode(code: string): code is JobErrorCode {
  return KNOWN.has(code);
}

/** Normalize a live producer result. Malformed identities use the caller's explicit safe fallback. */
export function motionJobFailure(
  value: unknown,
  fallback: { code: string; message: string; retryable?: boolean }
): MotionJobFailure {
  const record = plainRecord(value);
  const fallbackCode = validCode(fallback.code) ?? "invalid_args";
  const code = validCode(record?.code) ?? fallbackCode;
  const known = KNOWN.get(code);
  const retryable = known?.retryable ?? (typeof record?.retryable === "boolean" ? record.retryable : fallback.retryable === true);
  const message = boundedText(record?.message, MOTION_JOB_FAILURE_MESSAGE_MAX_CHARS)
    ?? boundedText(fallback.message, MOTION_JOB_FAILURE_MESSAGE_MAX_CHARS)
    ?? "Motion job failed.";
  const suppliedRemedy = remedy(record?.remedy);
  const retryAfterMs = retryable ? retryDelay(record?.retryAfterMs) : undefined;
  const suggestedAction = boundedText(record?.suggestedAction, MOTION_JOB_FAILURE_ACTION_MAX_CHARS);
  return Object.freeze({
    code,
    message,
    retryable,
    ...(known?.remedy ? { remedy: known.remedy } : suppliedRemedy ? { remedy: suppliedRemedy } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(suggestedAction ? { suggestedAction } : {})
  });
}

/**
 * Normalize an exception at an asynchronous execution boundary. Exceptions are not durable
 * payloads: accept only the typed failure fields, never a stack, cause, detail object, or a
 * path-bearing human string. An exception without a bounded opaque code receives the caller's
 * authored fallback instead of forwarding a host/runtime error.
 */
export function motionJobFailureFromException(
  value: unknown,
  fallback: { code: string; message: string; retryable?: boolean }
): MotionJobFailure {
  const record = exceptionRecord(value);
  const code = validCode(record?.code);
  if (!code) return motionJobFailure(undefined, fallback);
  const message = safeExceptionText(record?.message, MOTION_JOB_FAILURE_MESSAGE_MAX_CHARS);
  const suppliedRemedy = remedy(record?.remedy);
  const retryAfterMs = retryDelay(record?.retryAfterMs);
  const suggestedAction = safeExceptionText(record?.suggestedAction, MOTION_JOB_FAILURE_ACTION_MAX_CHARS);
  return motionJobFailure({
    code,
    ...(message ? { message } : {}),
    ...(typeof record?.retryable === "boolean" ? { retryable: record.retryable } : {}),
    ...(suppliedRemedy ? { remedy: suppliedRemedy } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(suggestedAction ? { suggestedAction } : {})
  }, fallback);
}

/** Strict durable-boundary parser. Unknown codes are valid; malformed or contradictory data is not. */
export function parseMotionJobFailure(value: unknown): MotionJobFailure | null {
  const record = plainRecord(value);
  if (!record || Object.keys(record).some((key) => !["code", "message", "retryable", "remedy", "retryAfterMs", "suggestedAction"].includes(key))) return null;
  const code = validCode(record.code);
  const message = boundedText(record.message, MOTION_JOB_FAILURE_MESSAGE_MAX_CHARS, false);
  if (!code || !message || typeof record.retryable !== "boolean") return null;
  const known = KNOWN.get(code);
  if (known && record.retryable !== known.retryable) return null;
  const suppliedRemedy = record.remedy === undefined ? undefined : remedy(record.remedy);
  if (record.remedy !== undefined && !suppliedRemedy) return null;
  if (known && suppliedRemedy && suppliedRemedy !== known.remedy) return null;
  const retryAfterMs = record.retryAfterMs === undefined ? undefined : retryDelay(record.retryAfterMs);
  if (record.retryAfterMs !== undefined && (retryAfterMs === undefined || record.retryable !== true)) return null;
  const suggestedAction = record.suggestedAction === undefined
    ? undefined
    : boundedText(record.suggestedAction, MOTION_JOB_FAILURE_ACTION_MAX_CHARS, false);
  if (record.suggestedAction !== undefined && !suggestedAction) return null;
  return Object.freeze({
    code,
    message,
    retryable: record.retryable,
    ...(known?.remedy ? { remedy: known.remedy } : suppliedRemedy ? { remedy: suppliedRemedy } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(suggestedAction ? { suggestedAction } : {})
  });
}

function validCode(value: unknown): string | undefined {
  return typeof value === "string" && Array.from(value).length <= MOTION_JOB_FAILURE_CODE_MAX_CHARS && CODE.test(value) ? value : undefined;
}

function remedy(value: unknown): JobRemedyKind | undefined {
  return typeof value === "string" && REMEDIES.has(value as JobRemedyKind) ? value as JobRemedyKind : undefined;
}

function retryDelay(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MOTION_JOB_FAILURE_RETRY_AFTER_MAX_MS ? Number(value) : undefined;
}

function boundedText(value: unknown, maxChars: number, truncate = true): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  if (!clean || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(clean)) return undefined;
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  return truncate ? chars.slice(0, maxChars).join("") : undefined;
}

function safeExceptionText(value: unknown, maxChars: number): string | undefined {
  const text = boundedText(value, maxChars);
  // Runtime exception messages commonly embed POSIX, Windows, UNC, URI, home-relative, or
  // package-relative paths. The durable job error is public protocol data, so conservatively
  // reject any line-break or path separator rather than attempting to enumerate every spelling.
  return text && !/[\r\n\\/]/u.test(text) ? text : undefined;
}

function exceptionRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  // Deliberately copy only fields declared by the public terminal-error contract. This supports
  // Error subclasses (whose `message` is non-enumerable) without serializing stack/cause/detail.
  return {
    code: exceptionField(candidate, "code"),
    message: exceptionField(candidate, "message"),
    retryable: exceptionField(candidate, "retryable"),
    remedy: exceptionField(candidate, "remedy"),
    retryAfterMs: exceptionField(candidate, "retryAfterMs"),
    suggestedAction: exceptionField(candidate, "suggestedAction")
  };
}

function exceptionField(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}
