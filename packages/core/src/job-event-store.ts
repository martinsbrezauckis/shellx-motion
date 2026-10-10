/** Durable, validated event streams for coordinator-owned jobs. */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { motionJobFileKey, motionJobOwnerKey } from "./job-id-file";
import {
  MOTION_JOB_EVENT_MAX_BYTES,
  parseMotionJobCoordinatorEvents,
  serializeMotionJobCoordinatorEvents,
  type MotionJobCoordinatorEvent
} from "./job-event-serialization";
import { PrivateMotionRuntimeDirectory } from "./private-runtime-directory";

export { MOTION_JOB_EVENT_MAX_BYTES, MOTION_JOB_EVENT_MAX_DATA_BYTES, type MotionJobCoordinatorEvent } from "./job-event-serialization";

/** Atomic per-job snapshots, serialized so an older append can never overwrite a newer one. */
export class MotionJobEventStore {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly runtime: PrivateMotionRuntimeDirectory;

  constructor(
    private readonly root: string,
    private readonly options: { writeSnapshot?: (path: string, serialized: string) => Promise<void> } = {}
  ) {
    this.runtime = new PrivateMotionRuntimeDirectory(root);
  }

  async write(input: { callerId: string; jobId: string; events: MotionJobCoordinatorEvent[] }): Promise<void> {
    const { callerId, jobId, events } = input;
    const serialized = serializeMotionJobCoordinatorEvents(events);
    const identity = motionJobOwnerKey(callerId, jobId);
    const previous = this.writes.get(identity) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await this.runtime.assertCurrent();
      const path = this.pathFor(callerId, jobId);
      await (this.options.writeSnapshot ?? writeSnapshotAtomic)(path, serialized);
      await this.runtime.assertCurrent();
    });
    this.writes.set(identity, write);
    try {
      await write;
    } finally {
      if (this.writes.get(identity) === write) this.writes.delete(identity);
    }
  }

  async read(input: { callerId: string; jobId: string; allowLegacy?: boolean }): Promise<MotionJobCoordinatorEvent[] | null> {
    await this.runtime.assertCurrent();
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
      return { found: true, events: parseMotionJobCoordinatorEvents(parsed) };
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
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
