import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionHostJob } from "./host-job";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry, type MotionJobRecord } from "./job-registry";
import { MotionJobView } from "./job-view";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const writeBoundary = vi.hoisted(() => ({ afterWrite: undefined as (() => Promise<void>) | undefined }));
vi.mock("./job-registry-storage", async () => {
  const actual = await vi.importActual<typeof import("./job-registry-storage")>("./job-registry-storage");
  return {
    ...actual,
    writeMotionJobRecord: async (...input: Parameters<typeof actual.writeMotionJobRecord>) => {
      await actual.writeMotionJobRecord(...input);
      await writeBoundary.afterWrite?.();
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  writeBoundary.afterWrite = undefined;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".scratch-host-job-terminal-acknowledgement-"));
  roots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  return {
    root,
    leases,
    records,
    view: new MotionJobView({ leases, records }),
    trusted: async <T>(operation: () => Promise<T>) => await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation)
  };
}

function record(jobId: string): MotionJobRecord {
  const endedAtMs = Date.now();
  return {
    schema: "shellx-motion/job-record@1", jobId, callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final",
    lifecycle: "ended", outcome: "succeeded", createdAtMs: endedAtMs - 10, startedAtMs: endedAtMs - 5,
    endedAtMs, durationMs: 10, queueWaitMs: 5, warnings: []
  };
}

describe("MotionHostJob terminal persistence acknowledgement", () => {
  it("acknowledges the exact terminal write while preserving the void-compatible registry API", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const acknowledged = record("cut:acknowledged-record");
      await expect(state.records.recordTerminalAcknowledged(acknowledged)).resolves.toBe(true);
      await expect(state.records.read({ jobId: acknowledged.jobId, callerId: acknowledged.callerId }))
        .resolves.toEqual({ ok: true, record: acknowledged });
      await expect(state.records.record(record("cut:legacy-void-record"))).resolves.toBeUndefined();
    });
  });

  it("returns false for this exact write when storage is unavailable or already degraded", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const blocker = join(state.root, "not-a-directory");
      await writeFile(blocker, "");
      const unavailable = new MotionJobRegistry({ recordRoot: join(blocker, "records") });

      await expect(unavailable.recordTerminalAcknowledged(record("cut:acknowledgement-unavailable"))).resolves.toBe(false);
      expect(unavailable.isDegraded).toBe(true);
      await expect(unavailable.recordTerminalAcknowledged(record("cut:acknowledgement-degraded"))).resolves.toBe(false);
      await expect(unavailable.record(record("cut:legacy-unavailable"))).resolves.toBeUndefined();
    });
  });

  it("rejects an acknowledgement when the retained record root changes after the atomic write", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const recordRoot = join(state.root, "replaced-records");
      const replacedRoot = join(state.root, "replaced-records-original");
      const replaced = new MotionJobRegistry({ recordRoot });
      writeBoundary.afterWrite = async () => {
        await rename(recordRoot, replacedRoot);
        await mkdir(recordRoot, { mode: 0o700 });
      };

      await expect(replaced.recordTerminalAcknowledged(record("cut:root-replaced-after-write"))).resolves.toBe(false);
      expect(replaced.isDegraded).toBe(true);
      expect(await readdir(replacedRoot)).toHaveLength(1);
      await expect(replaced.record(record("cut:legacy-root-replaced"))).resolves.toBeUndefined();
    });
  });

  it("reports a durable terminal record and frees the host lease", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const job = await MotionHostJob.begin({
        jobId: "cut:acknowledged-host", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases: state.leases, records: state.records
      });

      await expect(job.endAcknowledged("succeeded", { warnings: ["terminal warning"] })).resolves.toBe(true);
      expect(await state.leases.readLiveLeases()).toHaveLength(0);
      await expect(state.view.get({ jobId: job.jobId, callerId: job.callerId }))
        .resolves.toMatchObject({ ok: true, job: { state: "succeeded", warnings: ["terminal warning"] } });
    });
  });

  it("returns false without a record store and still frees the host lease", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const job = await MotionHostJob.begin({
        jobId: "cut:no-record-ack", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases: state.leases, records: null
      });

      await expect(job.endAcknowledged("succeeded")).resolves.toBe(false);
      expect(await state.leases.readLiveLeases()).toHaveLength(0);
      await expect(state.view.get({ jobId: job.jobId, callerId: job.callerId })).resolves.toEqual({ ok: false, code: "job_unknown" });
    });
  });

  it("releases only its exact capacity lease without inventing a terminal record", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const job = await MotionHostJob.begin({
        jobId: "cut:capacity-only-end", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases: state.leases, records: state.records
      });
      expect(job.hasPublishedLease()).toBe(true);

      await expect(job.releaseCapacityWithoutRecord()).resolves.toBeUndefined();
      await expect(job.releaseCapacityWithoutRecord()).resolves.toBeUndefined();
      expect(await state.leases.readLiveLeases()).toHaveLength(0);
      await expect(state.view.get({ jobId: job.jobId, callerId: job.callerId })).resolves.toEqual({ ok: false, code: "job_unknown" });
      // The first capacity-only operation is cached: a later terminal helper cannot rewrite history.
      await expect(job.endAcknowledged("failed", { error: { code: "invalid_args", message: "must not write a record" } })).resolves.toBe(false);
      await expect(state.view.get({ jobId: job.jobId, callerId: job.callerId })).resolves.toEqual({ ok: false, code: "job_unknown" });
    });
  });

  it("keeps the original pending lease when running promotion is unavailable and releases it capacity-only", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const announce = state.leases.announce.bind(state.leases);
      const onRunning = vi.fn();
      const announceSpy = vi.spyOn(state.leases, "announce").mockImplementation(async (input) => {
        return input.admitted ? null as never : await announce(input);
      });
      try {
        const job = await MotionHostJob.begin({
          jobId: "cut:promotion-unavailable", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final",
          leases: state.leases, records: state.records, onRunning
        });
        expect(job.hasPublishedLease()).toBe(true);
        await expect(job.markRunning()).rejects.toThrow("Motion host lease promotion is unavailable.");
        expect(onRunning).not.toHaveBeenCalled();
        expect(await state.leases.readLiveLeases()).toHaveLength(1);

        await job.releaseCapacityWithoutRecord();
        expect(await state.leases.readLiveLeases()).toHaveLength(0);
        await expect(state.view.get({ jobId: job.jobId, callerId: job.callerId })).resolves.toEqual({ ok: false, code: "job_unknown" });
      } finally {
        announceSpy.mockRestore();
      }
    });
  });

  it("keeps the exact lease when cancellation mutation is unavailable and releases it capacity-only", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const announce = state.leases.announce.bind(state.leases);
      const announceSpy = vi.spyOn(state.leases, "announce").mockImplementation(async (input) => {
        return input.cancelRequested ? null as never : await announce(input);
      });
      try {
        const job = await MotionHostJob.begin({
          jobId: "cut:cancellation-mutation-unavailable", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final",
          leases: state.leases, records: state.records
        });
        await expect(job.requestCancellation({ requestedBy: "cut:workspace-7", reason: "operator stopped" }))
          .rejects.toThrow("Motion host cancellation lease mutation is unavailable.");
        expect(await state.leases.readLiveLeases()).toHaveLength(1);

        await job.releaseCapacityWithoutRecord();
        expect(await state.leases.readLiveLeases()).toHaveLength(0);
      } finally {
        announceSpy.mockRestore();
      }
    });
  });

  it("returns false for unavailable terminal storage and still frees the host lease", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const blocker = join(state.root, "host-not-a-directory");
      await writeFile(blocker, "");
      const unavailable = new MotionJobRegistry({ recordRoot: join(blocker, "records") });
      const job = await MotionHostJob.begin({
        jobId: "cut:unavailable-record-ack", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases: state.leases, records: unavailable
      });

      await expect(job.endAcknowledged("succeeded")).resolves.toBe(false);
      expect(unavailable.isDegraded).toBe(true);
      expect(await state.leases.readLiveLeases()).toHaveLength(0);
    });
  });

  it("keeps legacy helpers void-compatible and shares the first acknowledgement without rewriting", async () => {
    const state = await fixture();
    await state.trusted(async () => {
      const job = await MotionHostJob.begin({
        jobId: "cut:duplicate-end", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases: state.leases, records: state.records
      });
      const write = vi.spyOn(state.records, "recordTerminalAcknowledged");

      const [first, duplicate] = await Promise.all([
        job.endAcknowledged("succeeded", { warnings: ["first outcome"] }),
        job.endAcknowledged("failed", { error: { code: "job_queue_timeout", message: "must not replace first outcome", retryable: true } })
      ]);

      expect(first).toBe(true);
      expect(duplicate).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      await expect(state.view.get({ jobId: job.jobId, callerId: job.callerId }))
        .resolves.toMatchObject({ ok: true, job: { state: "succeeded", warnings: ["first outcome"] } });
      await expect(job.succeeded()).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1);
      expect(await state.leases.readLiveLeases()).toHaveLength(0);
    });
  });
});
