/** Internal bounded event-log codec shared by the writer and exact evidence readers. */

export const MOTION_JOB_EVENT_MAX_BYTES = 256 * 1024;
export const MOTION_JOB_EVENT_MAX_DATA_BYTES = 8 * 1024;
const MAX_EVENTS = 1_024;
const MAX_DATA_DEPTH = 4;
const MAX_DATA_KEYS = 32;
const MAX_DATA_ARRAY = 64;
const EVENT_TYPES = new Set(["submitted", "running", "cancel_requested", "succeeded", "failed", "cancelled", "retry_submitted"]);

export interface MotionJobCoordinatorEvent {
  schema: "shellx-motion/job-event@1";
  seq: number;
  atMs: number;
  type: "submitted" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "retry_submitted";
  data?: Record<string, unknown>;
}

/** Exact event writer bytes; callers retain the historical JSON.stringify ordering contract. */
export function serializeMotionJobCoordinatorEvents(events: MotionJobCoordinatorEvent[]): string {
  if (!isMotionJobCoordinatorEventLog(events)) throw new Error("Motion job event log is invalid.");
  const serialized = `${JSON.stringify(events)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MOTION_JOB_EVENT_MAX_BYTES) throw new Error("Motion job event log exceeds its bounded size.");
  return serialized;
}

/** Parse only the bounded event records accepted by the durable writer. */
export function parseMotionJobCoordinatorEvents(value: unknown): MotionJobCoordinatorEvent[] | null {
  return isMotionJobCoordinatorEventLog(value) ? value : null;
}

export function isMotionJobCoordinatorEventLog(value: unknown): value is MotionJobCoordinatorEvent[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_EVENTS
    && value.every((event, index) => isMotionJobCoordinatorEvent(event) && event.seq === index + 1);
}

function isMotionJobCoordinatorEvent(value: unknown): value is MotionJobCoordinatorEvent {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["schema", "seq", "atMs", "type", "data"].includes(key))) return false;
  const sequence = value.seq;
  if (value.schema !== "shellx-motion/job-event@1" || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1
    || typeof value.atMs !== "number" || !Number.isFinite(value.atMs) || typeof value.type !== "string" || !EVENT_TYPES.has(value.type)) return false;
  if (value.data === undefined) return true;
  if (!isBoundedData(value.data)) return false;
  // `committed` is a reserved terminal-failure marker, not generic event metadata. Keeping
  // this rule in the common codec prevents a durable stream from smuggling the marker onto a
  // submitted, successful, cancelled, or retry event before stricter readers see it.
  return !Object.hasOwn(value.data, "committed") || (value.type === "failed" && value.data.committed === true);
}

function isBoundedData(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value) || !isBoundedJson(value, 0)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MOTION_JOB_EVENT_MAX_DATA_BYTES;
  } catch {
    return false;
  }
}

function isBoundedJson(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MOTION_JOB_EVENT_MAX_DATA_BYTES;
  if (depth >= MAX_DATA_DEPTH) return false;
  if (Array.isArray(value)) return value.length <= MAX_DATA_ARRAY && value.every((entry) => isBoundedJson(entry, depth + 1));
  return isPlainRecord(value) && Object.keys(value).length <= MAX_DATA_KEYS && Object.values(value).every((entry) => isBoundedJson(entry, depth + 1));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
