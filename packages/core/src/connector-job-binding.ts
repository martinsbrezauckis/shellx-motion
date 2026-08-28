/**
 * Closed, canonical connector-job binding data.  It deliberately has no executor, resolver, or
 * retry policy: a persisted request names only opaque host references and scalar choices.
 */
import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { motionJobFileKey, motionJobOwnerKey } from "./job-id-file";
import { assertMotionJobId } from "./job-registry";

export const MOTION_CONNECTOR_JOB_BINDING_SCHEMA = "shellx-motion/connector-job-binding@1" as const;
/** The whole canonical binding, including the self-hash, is capped at 96 KiB. */
export const MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES = 96 * 1024;

const SHA256 = /^[a-f0-9]{64}$/u;
const CAPABILITY_ID = /^[a-z][a-z0-9._:-]{0,119}@\d{1,8}$/u;
const SCHEMA_ID = /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9._/-]{0,95}@\d{1,8}$/u;
const REQUEST_FIELD_ID = /^[a-z][a-z0-9._:-]{0,127}$/u;
const MAX_CALLER_ID_CHARS = 256;
const MAX_REQUEST_FIELDS = 16;
const MAX_REQUEST_STRING_CHARS = 1_024;

/** The durable request shape cannot contain nested values, nulls, paths, URLs, or code. */
export type MotionConnectorJobBindingRequest = Readonly<Record<string, boolean | number | string>>;

export interface MotionConnectorJobBinding {
  readonly schema: typeof MOTION_CONNECTOR_JOB_BINDING_SCHEMA;
  readonly jobId: string;
  readonly callerId: string;
  readonly capabilityId: string;
  readonly descriptorRevision: number;
  readonly descriptorFingerprint: string;
  readonly requestSchemaId: string;
  readonly catalogFingerprint: string;
  readonly request: MotionConnectorJobBindingRequest;
  /** SHA-256 of every preceding field through canonical JSON, excluding this field itself. */
  readonly fingerprint: string;
}

/** Input a future authenticated Debug coordinator receives after generic request preparation. */
export interface MotionConnectorJobBindingInput {
  readonly jobId: string;
  readonly callerId: string;
  readonly capabilityId: string;
  readonly descriptorRevision: number;
  readonly descriptorFingerprint: string;
  readonly requestSchemaId: string;
  readonly catalogFingerprint: string;
  readonly request: Record<string, unknown>;
}

/**
 * Legacy public filename helper, retained for compatibility with callers that inspect or migrate
 * pre-owner-namespace binding files.  Journal storage must use
 * `motionConnectorJobOwnerBindingFileName` instead.
 */
export function motionConnectorJobBindingFileName(jobId: string): string {
  return `${motionJobFileKey(assertMotionJobId(jobId))}.connector-binding.json`;
}

/** Opaque, owner-qualified filename for journal storage of one authenticated job identity. */
export function motionConnectorJobOwnerBindingFileName(callerId: string, jobId: string): string {
  return `${motionJobOwnerKey(callerId, assertMotionJobId(jobId))}.connector-binding.json`;
}

/** Build one frozen, self-verifying binding before attempting any filesystem write. */
export function createMotionConnectorJobBinding(input: MotionConnectorJobBindingInput): MotionConnectorJobBinding {
  const content = {
    schema: MOTION_CONNECTOR_JOB_BINDING_SCHEMA,
    jobId: input.jobId,
    callerId: input.callerId,
    capabilityId: input.capabilityId,
    descriptorRevision: input.descriptorRevision,
    descriptorFingerprint: input.descriptorFingerprint,
    requestSchemaId: input.requestSchemaId,
    catalogFingerprint: input.catalogFingerprint,
    request: input.request
  };
  return parseMotionConnectorJobBinding({ ...content, fingerprint: canonicalJsonSha256(content) });
}

/**
 * Strictly parse a binding from disk or a caller.  The schema is closed so an executor, a retry
 * rule, a command, a resolved filesystem path, or a URL cannot enter persistent state by accident.
 */
export function parseMotionConnectorJobBinding(value: unknown): MotionConnectorJobBinding {
  const record = closedRecord(value, [
    "schema", "jobId", "callerId", "capabilityId", "descriptorRevision", "descriptorFingerprint",
    "requestSchemaId", "catalogFingerprint", "request", "fingerprint"
  ], "Connector job binding");
  if (record.schema !== MOTION_CONNECTOR_JOB_BINDING_SCHEMA) throw new Error("Unsupported connector job binding schema.");
  const content = {
    schema: MOTION_CONNECTOR_JOB_BINDING_SCHEMA,
    jobId: assertMotionJobId(record.jobId as string),
    callerId: callerId(record.callerId),
    capabilityId: capabilityId(record.capabilityId),
    descriptorRevision: boundedInteger(record.descriptorRevision, "Connector binding descriptorRevision", 1, 1_000_000),
    descriptorFingerprint: sha256(record.descriptorFingerprint, "Connector binding descriptorFingerprint"),
    requestSchemaId: schemaId(record.requestSchemaId),
    catalogFingerprint: sha256(record.catalogFingerprint, "Connector binding catalogFingerprint"),
    request: connectorRequest(record.request)
  };
  const fingerprint = sha256(record.fingerprint, "Connector binding fingerprint");
  if (fingerprint !== canonicalJsonSha256(content)) throw new Error("Connector job binding fingerprint does not match its canonical content.");
  return freezeBinding({ ...content, fingerprint });
}

/** Canonical SHA-256 of a binding excluding its self-hash. */
export function motionConnectorJobBindingFingerprint(value: Omit<MotionConnectorJobBinding, "fingerprint"> | MotionConnectorJobBinding): string {
  const { fingerprint: _fingerprint, ...content } = value as MotionConnectorJobBinding;
  return canonicalJsonSha256(content);
}

function freezeBinding(value: Omit<MotionConnectorJobBinding, "request"> & { request: Record<string, boolean | number | string> }): MotionConnectorJobBinding {
  return Object.freeze({ ...value, request: Object.freeze({ ...value.request }) });
}

function connectorRequest(value: unknown): Record<string, boolean | number | string> {
  if (!isPlainRecord(value)) throw new Error("Connector binding request must be a plain object.");
  const entries = Object.entries(value);
  if (entries.length > MAX_REQUEST_FIELDS) throw new Error(`Connector binding request may contain at most ${MAX_REQUEST_FIELDS} fields.`);
  const request: Record<string, boolean | number | string> = {};
  for (const [key, raw] of entries.sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (!REQUEST_FIELD_ID.test(key)) throw new Error("Connector binding request field id is invalid.");
    if (typeof raw === "boolean") request[key] = raw;
    else if (typeof raw === "number" && Number.isSafeInteger(raw)) request[key] = raw;
    else if (typeof raw === "string") request[key] = requestScalar(raw, key);
    else throw new Error(`Connector binding request field '${key}' must be an opaque scalar.`);
  }
  return request;
}

function requestScalar(value: string, field: string): string {
  if (Array.from(value).length === 0 || Array.from(value).length > MAX_REQUEST_STRING_CHARS) {
    throw new Error(`Connector binding request field '${field}' must be a bounded non-empty scalar string.`);
  }
  if (pathOrUrlLike(value)) throw new Error(`Connector binding request field '${field}' must not contain a resolved path or URL.`);
  return value;
}

function pathOrUrlLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || value.includes("/") || value.includes("\\")
    || value.startsWith("~") || /^[a-z]:/iu.test(value) || /^(?:https?|file|data|blob):/iu.test(value) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}

function closedRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`${label} contains unknown field '${unexpected}'.`);
  const missing = keys.find((key) => !(key in value));
  if (missing) throw new Error(`${label} requires field '${missing}'.`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function callerId(value: unknown): string {
  if (typeof value !== "string" || Array.from(value).length === 0 || Array.from(value).length > MAX_CALLER_ID_CHARS || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Connector binding callerId must be a bounded non-empty caller identity.");
  }
  return value;
}

function capabilityId(value: unknown): string {
  if (typeof value !== "string" || !CAPABILITY_ID.test(value)) throw new Error("Connector binding capabilityId must be a versioned capability id.");
  return value;
}

function schemaId(value: unknown): string {
  if (typeof value !== "string" || !SCHEMA_ID.test(value)) throw new Error("Connector binding requestSchemaId must be a versioned schema id.");
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${field} must be lowercase SHA-256 hex.`);
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  return Number(value);
}
