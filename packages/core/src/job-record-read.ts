import { readFile } from "node:fs/promises";
import { JOB_OUTCOMES, JOB_STATUS_CONTRACT, type JobOutcome, type JobSkipCode } from "./generated/job-status";
import { isMotionJobFrameLane, type MotionJobFrameLane } from "./job-frame-lane";
import { parseMotionJobEvidence, type MotionJobEvidence } from "./job-evidence";
import { parseMotionJobFailure, type MotionJobFailure } from "./job-failure";
import { UNATTRIBUTED_CALLER_ID } from "./job-lease";
import {
  isMotionJobRecordText,
  parseMotionJobRecordCancellation,
  parseMotionJobRecordWarnings,
  sameMotionJobRecordWarnings
} from "./job-record-contract";
import type { MotionJobRecord } from "./job-registry";
import { isPlainRecord, sha256, versionedSchemaId } from "./lifecycle-envelope-validation";

const JOB_ID = /^[a-z0-9._:-]+$/iu;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SKIP_CODES = new Set<string>(JOB_STATUS_CONTRACT.skipCodes.map((entry) => entry.code));

/** Read a terminal record only after its public projection fields pass the durable boundary. */
export async function readStoredMotionJobRecord(path: string): Promise<MotionJobRecord | null> {
  try {
    return parseStoredMotionJobRecord(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Parse one already-stabilized record leaf.
 *
 * This is a fail-closed boundary before a durable record reaches `MotionJobView`: it accepts
 * historical records that simply lack optional fields, but never repairs malformed terminal state
 * into an invented status, receipt link, or retry lineage. Retention supplies its own no-follow
 * read; this function owns only the durable value contract.
 */
export function parseStoredMotionJobRecord(raw: string): MotionJobRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return null;
    if (value(parsed, "schema") !== "shellx-motion/job-record@1") return null;

    const jobId = jobIdValue(value(parsed, "jobId"));
    const callerId = hasValue(parsed, "callerId") ? boundedText(value(parsed, "callerId"), 256) : UNATTRIBUTED_CALLER_ID;
    const lane = boundedText(value(parsed, "lane"), 128);
    const operation = boundedText(value(parsed, "operation"), 256);
    const outcome = terminalOutcome(value(parsed, "outcome"));
    const createdAtMs = nonNegativeSafeInteger(value(parsed, "createdAtMs"));
    const endedAtMs = nonNegativeSafeInteger(value(parsed, "endedAtMs"));
    const durationMs = nonNegativeSafeInteger(value(parsed, "durationMs"));
    const queueWaitMs = nonNegativeSafeInteger(value(parsed, "queueWaitMs"));
    const warnings = hasValue(parsed, "warnings") ? warningsValue(value(parsed, "warnings")) : [];
    if (jobId === null || callerId === null || lane === null || operation === null || outcome === null
      || createdAtMs === null || endedAtMs === null || durationMs === null || queueWaitMs === null || warnings === null
      || value(parsed, "lifecycle") !== "ended" || endedAtMs < createdAtMs || durationMs > endedAtMs - createdAtMs
      || queueWaitMs > durationMs) return null;

    const rawStartedAtMs = value(parsed, "startedAtMs");
    const startedAtMs = rawStartedAtMs === undefined ? undefined : nonNegativeSafeInteger(rawStartedAtMs);
    if (startedAtMs === null || (startedAtMs !== undefined && (startedAtMs < createdAtMs || startedAtMs > endedAtMs))) return null;

    const rawFrameLane = value(parsed, "frameLane");
    const frameLane = rawFrameLane === undefined ? undefined : frameLaneValue(rawFrameLane);
    if (frameLane === null) return null;

    const rawPlanFingerprint = value(parsed, "planFingerprint");
    let planFingerprint: string | undefined;
    if (rawPlanFingerprint !== undefined) {
      try {
        planFingerprint = sha256(rawPlanFingerprint, "Job record planFingerprint");
      } catch {
        return null;
      }
    }

    const rawError = value(parsed, "error");
    const error = rawError === undefined ? undefined : parseMotionJobFailure(rawError);
    if (error === null) return null;

    // Historical terminal records omit this field. A present marker is deliberately a literal
    // true and only describes a failed publication that may have become irreversible.
    const rawCommitted = value(parsed, "committed");
    if (rawCommitted !== undefined && rawCommitted !== true) return null;
    const committed = rawCommitted === true ? true : undefined;
    if (committed !== undefined && outcome !== "failed") return null;

    const rawCancellation = value(parsed, "cancellation");
    const cancellation = rawCancellation === undefined ? undefined : cancellationValue(rawCancellation);
    if (cancellation === null) return null;

    const rawSkip = value(parsed, "skip");
    const skip = rawSkip === undefined ? undefined : skipValue(rawSkip);
    if (skip === null || !hasTerminalOutcomeShape(outcome, error, cancellation, skip)) return null;

    const rawReceiptPath = value(parsed, "receiptPath");
    const receiptPath = rawReceiptPath === undefined ? undefined : receiptPathValue(rawReceiptPath);
    if (receiptPath === null) return null;

    const rawReceiptId = value(parsed, "receiptId");
    const receiptId = rawReceiptId === undefined ? undefined : receiptIdValue(rawReceiptId);
    if (receiptId === null) return null;

    const rawProducerEvidence = value(parsed, "producerEvidence");
    const producerEvidence = rawProducerEvidence === undefined ? undefined : producerEvidenceValue(rawProducerEvidence);
    if (producerEvidence === null) return null;

    const rawLineage = value(parsed, "lineage");
    const lineage = rawLineage === undefined ? undefined : lineageValue(rawLineage, jobId);
    if (lineage === null) return null;

    const rawEvidence = value(parsed, "evidence");
    let evidence: MotionJobEvidence | undefined;
    if (rawEvidence !== undefined) {
      try {
        evidence = parseMotionJobEvidence(rawEvidence);
      } catch {
        return null;
      }
      if (
        operation !== "render.final"
        || planFingerprint === undefined
        || evidence.jobId !== jobId
        || evidence.callerId !== callerId
        || evidence.outcome !== outcome
        || evidence.planFingerprint !== planFingerprint
        || !sameMotionJobRecordWarnings(warnings, evidence.warnings)
        || (receiptId !== undefined && !evidence.receiptIds.includes(receiptId))
        || (producerEvidence !== undefined && !sameProducerEvidence(producerEvidence, evidence.producerEvidence))
      ) return null;
      // A committed failure is deliberately an uncertainty marker, never an artifact claim.
      // Preserve an empty evidence envelope when one exists, but refuse even correctly hashed
      // artifact evidence at this durable read boundary.
      if (committed === true && evidence.artifacts.length !== 0) return null;
    }

    return {
      schema: "shellx-motion/job-record@1",
      jobId,
      callerId,
      lane,
      ...(frameLane === undefined ? {} : { frameLane }),
      operation,
      ...(planFingerprint === undefined ? {} : { planFingerprint }),
      lifecycle: "ended",
      outcome,
      createdAtMs,
      ...(startedAtMs === undefined ? {} : { startedAtMs }),
      endedAtMs,
      durationMs,
      queueWaitMs,
      ...(error === undefined ? {} : { error }),
      ...(committed === undefined ? {} : { committed }),
      ...(cancellation === undefined ? {} : { cancellation }),
      ...(skip === undefined ? {} : { skip }),
      warnings,
      ...(receiptPath === undefined ? {} : { receiptPath }),
      ...(receiptId === undefined ? {} : { receiptId }),
      ...(producerEvidence === undefined ? {} : { producerEvidence }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(lineage === undefined ? {} : { lineage })
    };
  } catch {
    return null;
  }
}

function value(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function hasValue(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function boundedText(value: unknown, maximum: number, pattern?: RegExp): string | null {
  return isMotionJobRecordText(value, maximum) && (pattern === undefined || pattern.test(value)) ? value : null;
}

function jobIdValue(value: unknown): string | null {
  return boundedText(value, 128, JOB_ID);
}

function receiptIdValue(value: unknown): string | null {
  return boundedText(value, 192, RECEIPT_ID);
}

/** Deprecated receipt paths are retained host-local text only; parsing never opens or resolves them. */
function receiptPathValue(value: unknown): string | null {
  return boundedText(value, 4_096);
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function terminalOutcome(value: unknown): JobOutcome | null {
  return typeof value === "string" && (JOB_OUTCOMES as readonly string[]).includes(value) ? value as JobOutcome : null;
}

function frameLaneValue(value: unknown): MotionJobFrameLane | null {
  return isMotionJobFrameLane(value) ? value : null;
}

function warningsValue(value: unknown): string[] | null {
  return parseMotionJobRecordWarnings(value);
}

function cancellationValue(value: unknown): NonNullable<MotionJobRecord["cancellation"]> | null {
  return parseMotionJobRecordCancellation(value);
}

function skipValue(value: unknown): NonNullable<MotionJobRecord["skip"]> | null {
  if (!isPlainRecord(value)) return null;
  const code = value.code;
  const reason = value.reason === undefined ? undefined : boundedText(value.reason, 4_096);
  if (typeof code !== "string" || !SKIP_CODES.has(code) || reason === null
    || Object.keys(value).some((key) => key !== "code" && key !== "reason")) return null;
  return { code: code as JobSkipCode, ...(reason === undefined ? {} : { reason }) };
}

function producerEvidenceValue(value: unknown): NonNullable<MotionJobRecord["producerEvidence"]> | null {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== "frameLane" && key !== "schema")) return null;
  const frameLane = frameLaneValue(value.frameLane);
  if (frameLane === null) return null;
  try {
    const schema = value.schema === undefined ? undefined : versionedSchemaId(value.schema, "Job record producer schema");
    return { frameLane, ...(schema === undefined ? {} : { schema }) };
  } catch {
    return null;
  }
}

function lineageValue(value: unknown, jobId: string): NonNullable<MotionJobRecord["lineage"]> | null {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== "priorJobId" && key !== "priorReceiptId" && key !== "retryAttempt")) return null;
  const priorJobId = jobIdValue(value.priorJobId);
  const priorReceiptId = value.priorReceiptId === undefined ? undefined : receiptIdValue(value.priorReceiptId);
  const retryAttempt = nonNegativeSafeInteger(value.retryAttempt);
  if (priorJobId === null || priorJobId === jobId || priorReceiptId === null || retryAttempt === null || retryAttempt < 1) return null;
  return { priorJobId, ...(priorReceiptId === undefined ? {} : { priorReceiptId }), retryAttempt };
}

function hasTerminalOutcomeShape(
  outcome: JobOutcome,
  error: MotionJobFailure | undefined,
  cancellation: MotionJobRecord["cancellation"],
  skip: MotionJobRecord["skip"]
): boolean {
  if (outcome === "failed") return cancellation === undefined && skip === undefined;
  if (outcome === "cancelled") return error === undefined && skip === undefined;
  if (outcome === "skipped") return error === undefined && cancellation === undefined;
  return error === undefined && cancellation === undefined && skip === undefined;
}

function sameProducerEvidence(
  recordEvidence: NonNullable<MotionJobRecord["producerEvidence"]>,
  evidence: MotionJobEvidence["producerEvidence"]
): boolean {
  return evidence !== null
    && recordEvidence.frameLane === evidence.frameLane
    && recordEvidence.schema === evidence.schema;
}
