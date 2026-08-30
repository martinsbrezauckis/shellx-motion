/**
 * What a caller can still learn about a job, and when.
 *
 * These exist because the previous surface was internally coherent and externally useless: the
 * governor minted one id for the lease and a different one for the evidence, so the id a caller
 * received addressed nothing; and the lease was removed on completion, so every finished job
 * answered `job_unknown`. Both were invisible to unit tests that only ever looked at one store.
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMotionJobGovernor, type LocalMotionJobPolicy } from "./job-governor";
import { MotionJobLeaseDirectory } from "./job-lease";
import {
  JOB_RECORD_RETENTION_COUNT,
  JOB_RECORD_RETENTION_MS,
  MotionJobRegistry,
  assertMotionJobId,
  mintMotionJobId,
  motionJobIdMintedAtMs,
  type MotionJobRecord
} from "./job-registry";
import { motionJobFileKey } from "./job-id-file";
import { pruneMotionJobRecords, writeMotionJobRecord } from "./job-registry-storage";
import { MotionJobView } from "./job-view";
import { MotionHostJob, runInMotionHostJob } from "./host-job";

const POLICY: LocalMotionJobPolicy = {
  maxConcurrentJobs: 1,
  maxQueueDepth: 4,
  maxQueueWaitMs: 2_000,
  maxWallClockMs: 2_000,
  minFreeScratchBytes: 100,
  scratchReservationBytes: 50,
  maxProcessTreeRssBytes: 64 * 1024 * 1024,
  rssPollIntervalMs: 25,
};

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stores(clock?: { now: number }) {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-registry-"));
  tempRoots.push(root);
  const now = clock ? () => clock.now : undefined;
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases"), ...(now ? { now } : {}) });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records"), ...(now ? { now } : {}) });
  return { root, leases, records, view: new MotionJobView({ leases, records }) };
}

/**
 * A record that is inside the retention window.
 *
 * Times are relative to now on purpose: an absolute fixture near the epoch is older than the
 * seven-day bound, so it is pruned the instant it is written and every read of it answers
 * job_unknown for reasons that have nothing to do with what the test is checking.
 */
const NOW = Date.now();
function endedRecord(overrides: Partial<MotionJobRecord> & Pick<MotionJobRecord, "jobId">): MotionJobRecord {
  return {
    schema: "shellx-motion/job-record@1",
    callerId: "cut:workspace-7",
    lane: "ffmpeg",
    operation: "render.final",
    lifecycle: "ended",
    outcome: "succeeded",
    createdAtMs: NOW - 2_000,
    startedAtMs: NOW - 1_990,
    endedAtMs: NOW - 1_000,
    durationMs: 990,
    queueWaitMs: 10,
    warnings: [],
    ...overrides
  };
}

describe("one job id", () => {
  it("uses the same id for the live lease and the resource evidence", async () => {
    // The defect this replaces: the lease and the evidence each got their own randomUUID, so an
    // agent handed evidence.jobId could not look up the job that produced it. Nothing failed —
    // the lookup simply always answered "unknown".
    const { leases, records } = await stores();
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000, leases, records });
    let observedLeaseId: string | undefined;

    const { evidence } = await governor.run(
      { lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test", callerId: "cut:workspace-7" },
      async () => { observedLeaseId = (await leases.readLiveLeases())[0]?.jobId; }
    );

    expect(observedLeaseId).toBeDefined();
    expect(evidence.jobId).toBe(observedLeaseId);
  });

  it("honours an id the caller chose, so a host holds the handle before the work starts", async () => {
    const { leases, records, view } = await stores();

    // The host names the job before anything runs. This is Motion's answer to learning a job id
    // before the work finishes: the handle exists first, so there is nothing to hand back.
    const job = await MotionHostJob.begin({
      jobId: "cut:render-42", callerId: "cut:workspace-7", lane: "browser", operation: "render.final", leases, records
    });
    expect(job.jobId).toBe("cut:render-42");
    // Queryable from the instant it is named — as `pending`, because no governed work has been
    // admitted yet. That is the point: the handle exists before the work does.
    await expect(view.get({ jobId: "cut:render-42", callerId: "cut:workspace-7" }))
      .resolves.toMatchObject({ ok: true, job: { jobId: "cut:render-42", state: "pending" } });

    await job.succeeded({ receiptPath: "/receipts/render-42.json" });

    await expect(view.get({ jobId: "cut:render-42", callerId: "cut:workspace-7" }))
      .resolves.toMatchObject({ ok: true, job: { jobId: "cut:render-42", state: "succeeded", receiptPath: "/receipts/render-42.json" } });
  });

  it("refuses an id that would not survive a round trip through a filename", async () => {
    // Sanitizing instead of rejecting would let "a/b" and "a-b" collapse onto one record file and
    // silently overwrite each other's evidence.
    expect(() => assertMotionJobId("cut/render-1")).toThrow(/Motion job id/);
    expect(() => assertMotionJobId("")).toThrow(/Motion job id/);
    expect(() => assertMotionJobId("x".repeat(129))).toThrow(/Motion job id/);
    expect(assertMotionJobId("cut:render_1.a-b")).toBe("cut:render_1.a-b");
  });

  it("carries its mint time in the id, which is what makes expiry knowable", () => {
    const mintedAtMs = 1_700_000_000_000;
    expect(motionJobIdMintedAtMs(mintMotionJobId(mintedAtMs))).toBe(mintedAtMs);
    // A caller-supplied id genuinely has no time in it, and guessing one would produce a confident
    // "expired" for a job that never existed.
    expect(motionJobIdMintedAtMs("cut:render-42")).toBeNull();
  });
});

describe("a job stays answerable after it ends", () => {
  it("answers a finished job from the record once its lease is gone", async () => {
    const { leases, records, view } = await stores();

    const job = await MotionHostJob.begin({ callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records });
    await job.succeeded();

    // The lease is deliberately gone: a finished job must not hold a slot.
    expect(await leases.readLiveLeases()).toHaveLength(0);
    const answer = await view.get({ jobId: job.jobId, callerId: "cut:workspace-7" });
    expect(answer).toMatchObject({ ok: true, job: { lifecycle: "ended", outcome: "succeeded", state: "succeeded" } });
  });

  it("records a job that failed, with the code a caller branches on", async () => {
    // A queue-full rejection is a real answer. Reporting it as job_unknown is indistinguishable
    // from a typo, and sends the caller looking for a mistake it did not make.
    const { leases, records, view } = await stores();
    const job = await MotionHostJob.begin({
      jobId: "cut:rejected-1", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records
    });

    await job.failed({ error: { code: "job_queue_full", message: "Motion job queue is full.", retryable: true } });

    const answer = await view.get({ jobId: "cut:rejected-1", callerId: "cut:workspace-7" });
    expect(answer).toMatchObject({ ok: true, job: { state: "failed", error: { code: "job_queue_full", retryable: true } } });
  });

  it("proves nothing ran by omitting startedAt on a skipped job", async () => {
    const { leases, records, view } = await stores();
    const job = await MotionHostJob.begin({
      jobId: "cut:skipped-1", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records
    });

    await job.skipped({ skip: { code: "already_satisfied" } });

    const answer = await view.get({ jobId: "cut:skipped-1", callerId: "cut:workspace-7" });
    expect(answer).toMatchObject({ ok: true, job: { state: "skipped", skip: { code: "already_satisfied" } } });
    // A resumed batch reporting 97 skipped rows as failures is how a working resume looks broken.
    expect((answer as { job: { startedAtMs?: number } }).job.startedAtMs).toBeUndefined();
  });

  it("reports a cancelled job as cancelled and never attaches an error to it", async () => {
    // The load-bearing invariant of the contract: a retry policy of `if (job.error?.retryable)`
    // must be structurally incapable of restarting something a human stopped.
    const { leases, records, view } = await stores();
    const job = await MotionHostJob.begin({
      jobId: "cut:cancelled-1", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records
    });

    await job.cancelled({ cancellation: { requestedBy: "cut:workspace-7", reason: "user pressed stop" } });

    const answer = await view.get({ jobId: "cut:cancelled-1", callerId: "cut:workspace-7" });
    expect(answer).toMatchObject({
      ok: true,
      job: { state: "cancelled", outcome: "cancelled", cancellation: { requestedBy: "cut:workspace-7", reason: "user pressed stop" } }
    });
    expect((answer as { job: { error?: unknown } }).job.error).toBeUndefined();
  });

  it("separates an expired job from one that never existed", async () => {
    const clock = { now: 10 * JOB_RECORD_RETENTION_MS };
    const { records, view } = await stores(clock);
    const longAgo = mintMotionJobId(clock.now - JOB_RECORD_RETENTION_MS - 1);
    const recent = mintMotionJobId(clock.now - 1_000);

    // Neither is on disk. The id's own timestamp is what separates the two answers, and the two
    // answers demand opposite responses: fall back to receipts, versus stop and re-read the id.
    await expect(view.get({ jobId: longAgo, callerId: "cut:workspace-7" })).resolves.toEqual({ ok: false, code: "job_expired" });
    await expect(view.get({ jobId: recent, callerId: "cut:workspace-7" })).resolves.toEqual({ ok: false, code: "job_unknown" });
  });

  it("attaches the receipt path the layer above discovered", async () => {
    const { records, view } = await stores();
    await records.record(endedRecord({ jobId: "cut:render-9" }));

    await records.amend({
      jobId: "cut:render-9",
      callerId: "cut:workspace-7",
      patch: { receiptPath: "/receipts/render-9.json", warnings: ["native text was case-folded"] }
    });

    await expect(view.get({ jobId: "cut:render-9", callerId: "cut:workspace-7" })).resolves.toMatchObject({
      ok: true,
      job: { receiptPath: "/receipts/render-9.json", warnings: ["native text was case-folded"], outcome: "succeeded" }
    });
  });

  it("keeps the deprecated positional amend API for exactly one owner-qualified record", async () => {
    const { records, view } = await stores();
    const jobId = "cut:legacy-amend";
    await records.record(endedRecord({ jobId, callerId: "cut:workspace-7" }));

    await records.amend(jobId, { receiptPath: "/receipts/legacy-amend.json" });
    await expect(view.get({ jobId, callerId: "cut:workspace-7" })).resolves.toMatchObject({
      ok: true, job: { receiptPath: "/receipts/legacy-amend.json" }
    });

    await records.record(endedRecord({ jobId, callerId: "design-studio:main", endedAtMs: NOW - 500 }));
    await records.amend(jobId, { warnings: ["must not cross owner boundary"] });
    await expect(view.get({ jobId, callerId: "cut:workspace-7" })).resolves.toMatchObject({ ok: true, job: { warnings: [] } });
    await expect(view.get({ jobId, callerId: "design-studio:main" })).resolves.toMatchObject({ ok: true, job: { warnings: [] } });
  });
});

describe("visibility survives the job", () => {
  it("keeps another host's finished work invisible", async () => {
    const { records, view } = await stores();
    await records.record(endedRecord({ jobId: "cut:render-1", callerId: "cut:workspace-7" }));

    await expect(view.get({ jobId: "cut:render-1", callerId: "design-studio:main" }))
      .resolves.toEqual({ ok: false, code: "job_not_visible" });
    await expect(view.list({ callerId: "design-studio:main" })).resolves.toEqual([]);
  });

  it("lets an explicitly granted operator scope read across callers", async () => {
    const { records, view } = await stores();
    await records.record(endedRecord({ jobId: "cut:render-1", callerId: "cut:workspace-7" }));
    await records.record(endedRecord({ jobId: "ds:render-1", callerId: "design-studio:main", endedAtMs: NOW - 500 }));

    const all = await view.list({ callerId: "operator", scope: "all" });
    expect(all.map((job) => job.jobId)).toEqual(["ds:render-1", "cut:render-1"]);
  });

  it("does not let a denied live job leak once it finishes", async () => {
    // Falling through from job_not_visible to the record store would let a caller learn the
    // outcome of a job it was refused, simply by waiting for it to end.
    const { leases, records, view } = await stores();
    await leases.announce({ jobId: "cut:render-1", lane: "ffmpeg", operation: "render.final", callerId: "cut:workspace-7", visibility: "host", admitted: true });
    await records.record(endedRecord({ jobId: "cut:render-1", callerId: "cut:workspace-7" }));

    await expect(view.get({ jobId: "cut:render-1", callerId: "design-studio:main" }))
      .resolves.toEqual({ ok: false, code: "job_not_visible" });
  });
});

describe("live and ended read as one list", () => {
  it("reports an unadmitted job as pending, and never claims it started", async () => {
    // The mapping that keeps a "rendering..." message from being a lie. A host job is announced
    // admitted today, so this shape is not yet produced by the render path — but `pending` is a
    // frozen part of the contract and the projection has to be right before anything emits it.
    const { leases, view } = await stores();
    await leases.announce({ jobId: "cut:queued-1", lane: "ffmpeg", operation: "render.final", callerId: "cut:workspace-7", visibility: "host" });

    const answer = await view.get({ jobId: "cut:queued-1", callerId: "cut:workspace-7" });
    expect(answer).toMatchObject({ ok: true, job: { lifecycle: "pending", state: "pending", outcome: null } });
    // The absence of startedAt is the machine-checkable proof that nothing has begun.
    expect((answer as { job: { startedAtMs?: number } }).job.startedAtMs).toBeUndefined();
  });

  it("waits as pending until its work is actually admitted, then reports running", async () => {
    // The gap this closes: a host job used to report "running" from the moment it was accepted, so
    // a caller queued behind a busy machine was told "rendering..." while nothing was produced.
    // What queues is the governed operation, so the host job now follows it.
    const { leases, records, view } = await stores();
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000, leases, records: null });

    const job = await MotionHostJob.begin({
      jobId: "cut:live-1", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records
    });

    // Accepted, nothing admitted yet: waiting, and honest about it.
    await expect(view.get({ jobId: "cut:live-1", callerId: "cut:workspace-7" })).resolves.toMatchObject({
      ok: true, job: { lifecycle: "pending", state: "pending" }
    });
    // pending must never claim a start time — that absence is the machine-checkable proof.
    const waiting = await view.get({ jobId: "cut:live-1", callerId: "cut:workspace-7" });
    expect((waiting as { job: { startedAtMs?: number } }).job.startedAtMs).toBeUndefined();

    let observedWhileWorking;
    await runInMotionHostJob(job, () => governor.run(
      { lane: "ffmpeg", operation: "ffmpeg.render", scratchRoot: ".scratch/test", callerId: "cut:workspace-7" },
      async () => { observedWhileWorking = await view.get({ jobId: "cut:live-1", callerId: "cut:workspace-7" }); }
    ));

    // Promoted the moment the governed operation held real capacity.
    expect(observedWhileWorking).toMatchObject({
      ok: true, job: { lifecycle: "running", state: "running", startedAtMs: expect.any(Number), pollAfterMs: expect.any(Number) }
    });
    await job.succeeded();
  });

  it("records no start time for a job that never got off the queue", async () => {
    // A job that failed while still waiting genuinely never ran. Reporting a startedAt for it would
    // make "it was queued the whole time" indistinguishable from "it ran and broke".
    const { leases, records, view } = await stores();
    const job = await MotionHostJob.begin({
      jobId: "cut:starved", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records
    });

    await job.failed({ error: { code: "job_queue_timeout", message: "waited past the deadline", retryable: true } });

    const answer = await view.get({ jobId: "cut:starved", callerId: "cut:workspace-7" });
    expect(answer).toMatchObject({ ok: true, job: { state: "failed", error: { code: "job_queue_timeout" } } });
    expect((answer as { job: { startedAtMs?: number } }).job.startedAtMs).toBeUndefined();
    // The whole life of the job was queue wait.
    expect((answer as { job: { queueWaitMs: number } }).job.queueWaitMs).toBeGreaterThanOrEqual(0);
  });

  it("never lets a host job consume rendering capacity", async () => {
    // A host job is a reporting record for work a caller asked for; the governed operations it
    // performs are the things that need slots. Counting the record itself would let a progress
    // entry block the very render it describes — which is exactly what happened: two host jobs
    // filled a cap of two and every real render waited out its queue deadline.
    const { leases, records } = await stores();
    const first = await MotionHostJob.begin({ jobId: "host-1", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records });
    const second = await MotionHostJob.begin({ jobId: "host-2", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", leases, records });

    const claim = await leases.claim({ jobId: "work-1", lane: "ffmpeg", operation: "ffmpeg.render", limit: 2, callerId: "cut:workspace-7" });

    expect(claim.admitted).toBe(true);
    await Promise.all([first.succeeded(), second.succeeded()]);
  });

  it("lists live work first, then finished work newest first", async () => {
    const { leases, records, view } = await stores();
    await leases.announce({ jobId: "live-1", lane: "ffmpeg", operation: "render.final", callerId: "cut:workspace-7", visibility: "host" });
    await records.record(endedRecord({ jobId: "old-1", endedAtMs: NOW - 9_000 }));
    await records.record(endedRecord({ jobId: "new-1", endedAtMs: NOW - 1_000 }));

    const jobs = await view.list({ callerId: "cut:workspace-7" });

    expect(jobs.map((job) => job.jobId)).toEqual(["live-1", "new-1", "old-1"]);
  });

  it("shows a job that is live again under a reused id exactly once", async () => {
    const { leases, records, view } = await stores();
    await records.record(endedRecord({ jobId: "cut:render-1" }));
    await leases.announce({ jobId: "cut:render-1", lane: "ffmpeg", operation: "render.final", callerId: "cut:workspace-7", visibility: "host" });

    const jobs = await view.list({ callerId: "cut:workspace-7" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId: "cut:render-1", lifecycle: "pending" });
  });

  it("does not dedupe a live caller's id against another caller's terminal id", async () => {
    const { leases, records, view } = await stores();
    const jobId = "host:shared-external-id";
    await records.record(endedRecord({ jobId, callerId: "cut:workspace-7" }));
    await leases.announce({ jobId, lane: "ffmpeg", operation: "render.final", callerId: "design-studio:main", visibility: "host" });

    await expect(view.get({ jobId, callerId: "cut:workspace-7" })).resolves.toMatchObject({ ok: true, job: { lifecycle: "ended", callerId: "cut:workspace-7" } });
    const jobs = await view.list({ callerId: "operator", scope: "all" });
    expect(jobs.filter((job) => job.jobId === jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ lifecycle: "pending", callerId: "design-studio:main" }),
      expect.objectContaining({ lifecycle: "ended", callerId: "cut:workspace-7" })
    ]));
  });
});

describe("a poll never catches a job mid-write", () => {
  it("keeps answering while the lease is heartbeated underneath it", async () => {
    // Found by running a real 15s render and polling it every 3 seconds: two polls reported the job
    // missing. `writeFile` truncates before it fills, so a reader can catch an empty file — and an
    // unparseable lease is treated as corrupt and DELETED, so a torn read did not merely blip, it
    // destroyed the lease and dropped the job's slot. Writes are a temp file plus a rename now.
    const { leases, records, view } = await stores();
    const run = await leases.announce({
      jobId: "cut:hammered", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", visibility: "host"
    });
    expect(run).not.toBeNull();

    // Heartbeat continuously while reading continuously. Without atomic writes this loses the job.
    let writing = true;
    const writer = (async () => {
      while (writing) await leases.heartbeat(run!);
    })();
    const answers = [];
    for (let attempt = 0; attempt < 400; attempt += 1) {
      answers.push(await view.get({ jobId: "cut:hammered", callerId: "cut:workspace-7" }));
    }
    writing = false;
    await writer;

    expect(answers.every((answer) => answer.ok)).toBe(true);
    await leases.release(run!);
  }, 45_000);

  it("leaves no temp files behind for a reader to mistake for a job", async () => {
    const { leases, records, root, view } = await stores();
    const run = await leases.announce({
      jobId: "cut:tidy", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", visibility: "host"
    });
    expect(run).not.toBeNull();
    await leases.heartbeat(run!);

    expect((await readdir(join(root, "leases"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await view.list({ callerId: "cut:workspace-7" })).toHaveLength(1);
    await leases.release(run!);
  });
});

describe("retention", () => {
  it("drops records past the age bound", async () => {
    const clock = { now: 10 * JOB_RECORD_RETENTION_MS };
    const { records, root } = await stores(clock);
    await records.record(endedRecord({ jobId: "fresh", endedAtMs: clock.now - 1_000 }));
    await records.record(endedRecord({ jobId: "aged", endedAtMs: clock.now - JOB_RECORD_RETENTION_MS - 1 }));

    await records.prune();

    // Assert the surviving job rather than the filename: the name encodes the end time so pruning
    // can be decided without reading every record, and that encoding is not the contract.
    expect(await readdir(join(root, "records"))).toHaveLength(1);
    expect((await records.list({ callerId: "cut:workspace-7" })).map((job) => job.jobId)).toEqual(["fresh"]);
  });

  it("drops the oldest records past the count bound", async () => {
    const clock = { now: 1_000_000 };
    const { records, root } = await stores(clock);
    const recordRoot = join(root, "records");
    // Seed the retained bound without asking the high-level record path to rescan the growing
    // directory after every fixture write. The one public write below is the behavior under test:
    // crossing the bound must prune exactly the oldest record and keep the new one.
    for (let index = 0; index < JOB_RECORD_RETENTION_COUNT; index += 1) {
      await writeMotionJobRecord(recordRoot, endedRecord({
        jobId: `job-${index}`,
        endedAtMs: clock.now - (JOB_RECORD_RETENTION_COUNT - index)
      }));
    }
    await records.record(endedRecord({ jobId: `job-${JOB_RECORD_RETENTION_COUNT}`, endedAtMs: clock.now }));

    const kept = await records.list({ callerId: "cut:workspace-7" });

    expect(kept).toHaveLength(JOB_RECORD_RETENTION_COUNT);
    expect(kept.some((job) => job.jobId === "job-0")).toBe(false);
    expect(kept.some((job) => job.jobId === `job-${JOB_RECORD_RETENTION_COUNT}`)).toBe(true);
  }, 45_000);

  it("applies the count bound per authenticated owner instead of pruning a quiet caller", async () => {
    const clock = { now: 2_000_000 };
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-retention-owner-"));
    tempRoots.push(root);
    const recordRoot = join(root, "records");
    const quiet = endedRecord({ jobId: "quiet-only", callerId: "quiet:workspace", endedAtMs: clock.now - 10_000 });
    await writeMotionJobRecord(recordRoot, quiet);
    for (let index = 0; index <= JOB_RECORD_RETENTION_COUNT; index += 1) {
      await writeMotionJobRecord(recordRoot, endedRecord({
        jobId: `noisy-${index}`,
        callerId: "noisy:workspace",
        endedAtMs: clock.now - (JOB_RECORD_RETENTION_COUNT - index)
      }));
    }

    await pruneMotionJobRecords(recordRoot, clock.now, JOB_RECORD_RETENTION_MS, JOB_RECORD_RETENTION_COUNT);
    const records = new MotionJobRegistry({ recordRoot, now: () => clock.now });
    await expect(records.read({ jobId: quiet.jobId, callerId: quiet.callerId }))
      .resolves.toMatchObject({ ok: true, record: { callerId: "quiet:workspace" } });
    expect((await records.list({ callerId: "noisy:workspace" })).length).toBe(JOB_RECORD_RETENTION_COUNT);
  }, 45_000);

  it.skipIf(process.platform === "win32")("creates terminal state with private directory and file modes", async () => {
    const { records, root } = await stores();
    await records.record(endedRecord({ jobId: "private-record" }));
    const recordRoot = join(root, "records");
    const [recordFile] = await readdir(recordRoot);

    expect((await stat(recordRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(recordRoot, recordFile!))).mode & 0o777).toBe(0o600);
  });

  it("keeps rendering when the record store cannot be written", async () => {
    // Recording is observability layered over rendering. A host with an unwritable runtime
    // directory must still be able to render; it simply cannot report afterwards.
    const { leases, root } = await stores();
    // A directory path whose parent is a regular file fails with ENOTDIR on every platform, which
    // a permission-based path does not (root, and Windows, disagree).
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "");
    const governor = new LocalMotionJobGovernor(POLICY, {
      freeScratchBytes: async () => 1_000,
      leases,
      records: new MotionJobRegistry({ recordRoot: join(blocker, "records") })
    });

    await expect(governor.run(
      { lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" },
      async () => "rendered"
    )).resolves.toMatchObject({ value: "rendered" });
  });
});

/**
 * One caller's terminal record must survive another caller's write.
 *
 * Record filenames once folded disallowed
 * characters to `-`, and `removeOtherFilesFor` prefix-deleted on that folded name without reading
 * what it was deleting. So caller B finishing `a-b` erased caller A's record of `a:b`. A's render
 * had genuinely succeeded, and every later query answered `job_unknown` — the precise outcome this
 * module's own header says makes a caller conclude Motion lost its work.
 *
 * `findRecord` already verified contents on the read path. The write path did not, and only one of
 * the two being careful is what made this reachable.
 */
describe("terminal records of colliding job ids", () => {
  it("names terminal state by the caller and external id together without exposing the caller in paths", async () => {
    const { records, root } = await stores();
    const jobId = "host:shared-external-id";
    const ownerA = "cut:workspace-a";
    const ownerB = "design-studio:workspace-b";

    await records.record(endedRecord({ jobId, callerId: ownerA, outcome: "failed", endedAtMs: NOW - 3_000 }));
    await records.record(endedRecord({ jobId, callerId: ownerB, outcome: "succeeded", endedAtMs: NOW - 2_000 }));

    await expect(records.read({ jobId, callerId: ownerA })).resolves.toMatchObject({ ok: true, record: { callerId: ownerA, outcome: "failed" } });
    await expect(records.read({ jobId, callerId: ownerB })).resolves.toMatchObject({ ok: true, record: { callerId: ownerB, outcome: "succeeded" } });
    expect((await records.list({ callerId: "operator", scope: "all" })).filter((record) => record.jobId === jobId)).toHaveLength(2);

    // A reused id replaces only this owner's prior terminal state, never the other owner's.
    await records.record(endedRecord({ jobId, callerId: ownerA, outcome: "succeeded", endedAtMs: NOW - 1_000 }));
    await expect(records.read({ jobId, callerId: ownerA })).resolves.toMatchObject({ ok: true, record: { outcome: "succeeded" } });
    await expect(records.read({ jobId, callerId: ownerB })).resolves.toMatchObject({ ok: true, record: { outcome: "succeeded", callerId: ownerB } });
    const files = await readdir(join(root, "records"));
    expect(files).toHaveLength(2);
    expect(files.some((name) => name.includes(ownerA) || name.includes(ownerB))).toBe(false);
  });

  it("reads a legacy terminal record only for its stored owner", async () => {
    const { records, root } = await stores();
    const jobId = "legacy:shared-id";
    const callerId = "cut:legacy-owner";
    const record = endedRecord({ jobId, callerId, endedAtMs: NOW - 1_000 });
    const recordRoot = join(root, "records");
    await mkdir(recordRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(recordRoot, `${motionJobFileKey(jobId)}--${record.endedAtMs}.job.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });

    await expect(records.read({ jobId, callerId })).resolves.toMatchObject({ ok: true, record: { callerId } });
    await expect(records.read({ jobId, callerId: "design-studio:other" })).resolves.toEqual({ ok: false, code: "job_unknown" });
    await expect(records.read({ jobId, callerId: "design-studio:other", scope: "all" })).resolves.toEqual({ ok: false, code: "job_unknown" });
  });

  it("does not delete another caller's record when ids fold to the same filename", async () => {
    const { records } = await stores();
    await records.record(endedRecord({ jobId: "a:b", callerId: "A", outcome: "succeeded" }));
    await records.record(endedRecord({ jobId: "a-b", callerId: "B", outcome: "succeeded" }));

    const first = await records.read({ jobId: "a:b", callerId: "A" });
    const second = await records.read({ jobId: "a-b", callerId: "B" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.ok && first.record.callerId).toBe("A");
    expect(second.ok && second.record.callerId).toBe("B");
  });

  it("still replaces a job's own earlier record when it is rewritten", async () => {
    const { records, root } = await stores();
    await records.record(endedRecord({ jobId: "same", callerId: "A", outcome: "failed", endedAtMs: NOW - 2_000 }));
    await records.record(endedRecord({ jobId: "same", callerId: "A", outcome: "succeeded", endedAtMs: NOW - 1_000 }));

    const files = await readdir(join(root, "records"));
    expect(files.length).toBe(1);
    const answer = await records.read({ jobId: "same", callerId: "A" });
    expect(answer.ok && answer.record.outcome).toBe("succeeded");
  });
});
