/** Durable, validated event streams for coordinator-owned jobs. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { motionJobFileKey, motionJobOwnerKey } from "./job-id-file";

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

/** Atomic per-job snapshots, serialized so an older append can never overwrite a newer one. */
export class MotionJobEventStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly options: { writeSnapshot?: (path: string, serialized: string) => Promise<void> } = {}
  ) {}

  async write(input: { callerId: string; jobId: string; events: MotionJobCoordinatorEvent[] }): Promise<void> {
    const { callerId, jobId, events } = input;
    const serialized = serialize(events);
    const identity = motionJobOwnerKey(callerId, jobId);
    const previous = this.writes.get(identity) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true });
      const path = this.pathFor(callerId, jobId);
      await (this.options.writeSnapshot ?? writeSnapshotAtomic)(path, serialized);
    });
    this.writes.set(identity, write);
    try {
      await write;
    } finally {
      if (this.writes.get(identity) === write) this.writes.delete(identity);
    }
  }

  async read(input: { callerId: string; jobId: string; allowLegacy?: boolean }): Promise<MotionJobCoordinatorEvent[] | null> {
    const current = await this.readSnapshot(this.pathFor(input.callerId, input.jobId));
    if (current.found || !input.allowLegacy) return current.events;
    return (await this.readSnapshot(this.legacyPathFor(input.jobId))).events;
  }

  private async readSnapshot(path: string): Promise<{ found: boolean; events: MotionJobCoordinatorEvent[] | null }> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > MOTION_JOB_EVENT_MAX_BYTES) return { found: true, events: null };
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MOTION_JOB_EVENT_MAX_BYTES) return { found: true, events: null };
      const parsed = JSON.parse(raw) as unknown;
      return { found: true, events: isEventLog(parsed) ? parsed : null };
    } catch (error) {
      return { found: (error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT", events: null };
    }
  }

  private pathFor(callerId: string, jobId: string): string {
    return join(this.root, `${motionJobOwnerKey(callerId, jobId)}.events.json`);
  }

  private legacyPathFor(jobId: string): string {
    return join(this.root, `${motionJobFileKey(jobId)}.events.json`);
  }
}

async function writeSnapshotAtomic(path: string, serialized: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function serialize(events: MotionJobCoordinatorEvent[]): string {
  if (!isEventLog(events)) throw new Error("Motion job event log is invalid.");
  const serialized = `${JSON.stringify(events)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MOTION_JOB_EVENT_MAX_BYTES) throw new Error("Motion job event log exceeds its bounded size.");
  return serialized;
}

function isEventLog(value: unknown): value is MotionJobCoordinatorEvent[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_EVENTS
    && value.every((event, index) => isEvent(event) && event.seq === index + 1);
}

function isEvent(value: unknown): value is MotionJobCoordinatorEvent {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["schema", "seq", "atMs", "type", "data"].includes(key))) return false;
  const sequence = value.seq;
  if (value.schema !== "shellx-motion/job-event@1" || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1
    || typeof value.atMs !== "number" || !Number.isFinite(value.atMs) || typeof value.type !== "string" || !EVENT_TYPES.has(value.type)) return false;
  return value.data === undefined || isBoundedData(value.data);
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
