/** Shared closed-value checks for path-free render lifecycle envelopes. */
const PATH_OR_URL_LIKE = /^(?:[a-z]:|[a-z][a-z0-9+.-]*:\/\/|(?:https?|file|data|blob):)/iu;
const SENSITIVE_TEXT = /(?:api[_-]?key|secret|password|credential|authorization|bearer|cookie|private[_-]?key)/iu;
const VERSIONED_SCHEMA_ID = /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9._-]{0,95}@\d{1,8}$/u;

export const MOTION_LIFECYCLE_SHA256 = /^[a-f0-9]{64}$/u;

export function closedRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unknown field '${unexpected}'.`);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing !== undefined) throw new Error(`${label} requires field '${missing}'.`);
  return value;
}

export function closedRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unknown field '${unexpected}'.`);
  const missing = required.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing !== undefined) throw new Error(`${label} requires field '${missing}'.`);
  return value;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function opaqueText(value: unknown, label: string, minimum: number, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || Array.from(value).length < minimum || Array.from(value).length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded text value.`);
  }
  if (pathOrUrlLike(value)) throw new Error(`${label} must not contain a local path or URL.`);
  if (SENSITIVE_TEXT.test(value)) throw new Error(`${label} must not contain secret-bearing data.`);
  if (pattern && !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function pathOrUrlLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || value.includes("/") || value.includes("\\")
    || value.startsWith("~") || PATH_OR_URL_LIKE.test(value);
}

export function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !MOTION_LIFECYCLE_SHA256.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex.`);
  }
  return value;
}

/** A constrained schema identifier has one namespace slash, never a filesystem path or URL. */
export function versionedSchemaId(value: unknown, label: string): string {
  if (typeof value !== "string" || Array.from(value).length === 0 || Array.from(value).length > 128
    || /[\u0000-\u001f\u007f]/u.test(value) || SENSITIVE_TEXT.test(value) || !VERSIONED_SCHEMA_ID.test(value)) {
    throw new Error(`${label} must be a bounded versioned schema identifier.`);
  }
  return value;
}

export function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}
