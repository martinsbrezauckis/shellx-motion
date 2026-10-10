/**
 * Terminal, path-free evidence for a previously admitted final-video job.
 *
 * The envelope deliberately projects an attested artifact to opaque identity fields only.  It is
 * not an artifact handle and therefore cannot disclose a root-relative path or become an output
 * authority.  Integrations may honestly have no historical envelope until they adopt this v1
 * primitive; this module does not rewrite existing job records or status responses.
 */
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { JOB_OUTCOMES, type JobOutcome } from "./generated/job-status";
import { assertMotionJobId } from "./job-registry";
import { MOTION_JOB_RECORD_MAX_WARNING_CHARS, MOTION_JOB_RECORD_MAX_WARNINGS } from "./job-record-contract";
import { closedRecord, closedRecordWithOptional, opaqueText, sha256, versionedSchemaId } from "./lifecycle-envelope-validation";

export const MOTION_JOB_EVIDENCE_SCHEMA = "shellx-motion/job-evidence@1" as const;
export const MOTION_JOB_EVIDENCE_MAX_BYTES = 32 * 1024;

const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ARTIFACT_ID = /^artifact-[a-f0-9]{24}$/u;

export interface MotionJobEvidenceArtifact {
  readonly schema: "shellx-motion/artifact-handle@1";
  readonly id: string;
  readonly operationHash: string;
  readonly sha256: string;
}

/** Bounded observed producer identity. `null` means no producer evidence was retained. */
export interface MotionJobProducerEvidence {
  readonly frameLane: "browser" | "native" | "gpu";
  readonly schema?: string;
}

export interface MotionJobEvidence {
  readonly schema: typeof MOTION_JOB_EVIDENCE_SCHEMA;
  readonly jobId: string;
  readonly callerId: string;
  readonly operation: "render.final";
  readonly planFingerprint: string;
  readonly outcome: JobOutcome;
  readonly warnings: readonly string[];
  readonly receiptIds: readonly string[];
  readonly producerEvidence: MotionJobProducerEvidence | null;
  readonly artifacts: readonly MotionJobEvidenceArtifact[];
  /** SHA-256 of all preceding fields through canonical JSON, excluding this field itself. */
  readonly fingerprint: string;
}

export interface MotionJobEvidenceInput {
  readonly jobId: string;
  readonly callerId: string;
  readonly operation: "render.final";
  readonly planFingerprint: string;
  readonly outcome: JobOutcome;
  readonly warnings: readonly string[];
  readonly receiptIds: readonly string[];
  readonly producerEvidence: MotionJobProducerEvidence | null;
  readonly artifacts: readonly MotionJobEvidenceArtifact[];
}

type MotionJobEvidenceContent = Omit<MotionJobEvidence, "fingerprint">;

/** Build one frozen, self-verifying terminal evidence envelope. */
export function createMotionJobEvidence(input: MotionJobEvidenceInput): MotionJobEvidence {
  const content = parseEvidenceInput(input);
  return freezeEvidence({ ...content, fingerprint: canonicalJsonSha256(content) });
}

/** Strictly parse terminal evidence from disk or an untrusted boundary. */
export function parseMotionJobEvidence(value: unknown): MotionJobEvidence {
  const record = closedRecord(value, [
    "schema", "jobId", "callerId", "operation", "planFingerprint", "outcome", "warnings", "receiptIds", "producerEvidence", "artifacts", "fingerprint"
  ], "Job evidence");
  const content = parseEvidenceContent(record);
  const fingerprint = sha256(record.fingerprint, "Job evidence fingerprint");
  if (fingerprint !== canonicalJsonSha256(content)) {
    throw new Error("Job evidence fingerprint does not match its canonical content.");
  }
  return freezeEvidence({ ...content, fingerprint });
}

/** Canonical SHA-256 of terminal evidence excluding its self-hash. */
export function motionJobEvidenceFingerprint(value: Omit<MotionJobEvidence, "fingerprint"> | MotionJobEvidence): string {
  const { fingerprint: _fingerprint, ...content } = value as MotionJobEvidence;
  return canonicalJsonSha256(content);
}

/** Canonical persisted bytes, bounded before an integration stores or transports them. */
export function serializeMotionJobEvidence(value: MotionJobEvidence): string {
  const evidence = parseMotionJobEvidence(value);
  const serialized = canonicalJson(evidence);
  if (Buffer.byteLength(serialized, "utf8") > MOTION_JOB_EVIDENCE_MAX_BYTES) {
    throw new Error(`Job evidence exceeds its ${MOTION_JOB_EVIDENCE_MAX_BYTES}-byte limit.`);
  }
  return serialized;
}

function parseEvidenceInput(value: MotionJobEvidenceInput): MotionJobEvidenceContent {
  const record = closedRecord(value, [
    "jobId", "callerId", "operation", "planFingerprint", "outcome", "warnings", "receiptIds", "producerEvidence", "artifacts"
  ], "Job evidence input");
  return parseEvidenceContent({ schema: MOTION_JOB_EVIDENCE_SCHEMA, ...record });
}

function parseEvidenceContent(record: Record<string, unknown>): MotionJobEvidenceContent {
  if (record.schema !== MOTION_JOB_EVIDENCE_SCHEMA) throw new Error("Unsupported job evidence schema.");
  if (record.operation !== "render.final") throw new Error("Job evidence operation must be render.final.");
  return {
    schema: MOTION_JOB_EVIDENCE_SCHEMA,
    jobId: assertMotionJobId(record.jobId as string),
    callerId: opaqueText(record.callerId, "Job evidence callerId", 1, 256, CALLER_ID),
    operation: "render.final",
    planFingerprint: sha256(record.planFingerprint, "Job evidence planFingerprint"),
    outcome: parseOutcome(record.outcome),
    warnings: parseWarnings(record.warnings),
    receiptIds: parseReceiptIds(record.receiptIds),
    producerEvidence: parseProducerEvidence(record.producerEvidence),
    artifacts: parseArtifacts(record.artifacts)
  };
}

function parseOutcome(value: unknown): JobOutcome {
  if (typeof value !== "string" || !(JOB_OUTCOMES as readonly string[]).includes(value)) {
    throw new Error("Job evidence outcome must be terminal.");
  }
  return value as JobOutcome;
}

function parseWarnings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MOTION_JOB_RECORD_MAX_WARNINGS) throw new Error(`Job evidence warnings must contain at most ${MOTION_JOB_RECORD_MAX_WARNINGS} entries.`);
  return Object.freeze(value.map((warning, index) => opaqueText(warning, `Job evidence warning ${index}`, 1, MOTION_JOB_RECORD_MAX_WARNING_CHARS)));
}

function parseReceiptIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Job evidence receiptIds must contain at most 64 entries.");
  const receiptIds = value.map((receiptId, index) => opaqueText(receiptId, `Job evidence receiptId ${index}`, 1, 192, RECEIPT_ID));
  if (new Set(receiptIds).size !== receiptIds.length) throw new Error("Job evidence receiptIds must not contain duplicates.");
  return Object.freeze(receiptIds);
}

function parseProducerEvidence(value: unknown): MotionJobProducerEvidence | null {
  if (value === null) return null;
  const record = closedRecordWithOptional(value, ["frameLane"], ["schema"], "Job evidence producerEvidence");
  if (record.frameLane !== "browser" && record.frameLane !== "native" && record.frameLane !== "gpu") {
    throw new Error("Job evidence producer frameLane is unsupported.");
  }
  return Object.freeze({
    frameLane: record.frameLane,
    ...(record.schema === undefined ? {} : { schema: versionedSchemaId(record.schema, "Job evidence producer schema") })
  });
}

function parseArtifacts(value: unknown): readonly MotionJobEvidenceArtifact[] {
  if (!Array.isArray(value) || value.length > 1) throw new Error("Job evidence artifacts must contain at most one primary artifact.");
  const artifacts = value.map((artifact, index) => {
    const record = closedRecord(artifact, ["schema", "id", "operationHash", "sha256"], `Job evidence artifact ${index}`);
    if (record.schema !== "shellx-motion/artifact-handle@1") throw new Error("Job evidence artifact schema is unsupported.");
    const id = opaqueText(record.id, "Job evidence artifact id", 1, 33, ARTIFACT_ID);
    return Object.freeze({
      schema: "shellx-motion/artifact-handle@1" as const,
      id,
      operationHash: sha256(record.operationHash, "Job evidence artifact operationHash"),
      sha256: sha256(record.sha256, "Job evidence artifact sha256")
    });
  });
  return Object.freeze(artifacts);
}

function freezeEvidence(value: MotionJobEvidence): MotionJobEvidence {
  return Object.freeze({
    ...value,
    warnings: Object.freeze([...value.warnings]),
    receiptIds: Object.freeze([...value.receiptIds]),
    producerEvidence: value.producerEvidence === null ? null : Object.freeze({ ...value.producerEvidence }),
    artifacts: Object.freeze(value.artifacts.map((artifact) => Object.freeze({ ...artifact })))
  });
}
