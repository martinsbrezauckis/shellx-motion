import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionJobCoordinator, type MotionJobCoordinatorExecution } from "./job-coordinator";
import { MotionJobIdentityClaimHandle, MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const roots: string[] = [];
const CALLER_ID = "cut:workspace";

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function coordinator() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-cancellation-"));
  roots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  const eventsRoot = join(root, "events");
  const jobs = new MotionJobCoordinator({
    leases, records, eventsRoot,
    identityClaims: new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") })
  });
  await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
    const initialized = await jobs.submit({
      jobId: "cut:cancellation-test-initialization", callerId: "cut:cancellation-test-initialization",
      lane: "test", operation: "test.initialization", execute: async () => ({ ok: true })
    });
    if (!initialized.ok) throw new Error("Could not initialize retained coordinator authority.");
    await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:cancellation-test-initialization", callerId: "cut:cancellation-test-initialization" }),
      (status) => status.ok && status.job.state === "succeeded"
    );
    await settleSuccessfulJob(jobs, "cut:cancellation-test-initialization", "cut:cancellation-test-initialization");
  });
  return { leases, records, eventsRoot, jobs };
}

async function submitStoppable(jobs: MotionJobCoordinator, jobId: string) {
  let entered!: () => void;
  const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
  let observedAbort!: () => void;
  const abortObserved = new Promise<void>((resolve) => { observedAbort = resolve; });
  let settleWorker!: () => void;
  const workerSettled = new Promise<void>((resolve) => { settleWorker = resolve; });
  const submitted = await jobs.submit({
    jobId, callerId: CALLER_ID, lane: "ffmpeg", operation: "render.final",
    execute: async (signal) => await new Promise((resolve) => {
      entered();
      signal.addEventListener("abort", () => observedAbort(), { once: true });
      void workerSettled.then(() => resolve({ ok: false, error: { code: "job_cancelled", message: "worker saw coordinator signal" } }));
    })
  });
  await executionEntered;
  return { submitted, abortObserved, settleWorker };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for coordinator cancellation state.");
}

async function settleSuccessfulJob(jobs: MotionJobCoordinator, jobId: string, callerId: string): Promise<void> {
  // A known-success retry waits for settlement and starts no new work.
  await expect(jobs.retry({ jobId, callerId })).resolves.toMatchObject({ ok: false, code: "job_not_retryable" });
  await expect(jobs.jobView().get({ jobId, callerId })).resolves.toMatchObject({ ok: true, job: { state: "succeeded" } });
}

describe("MotionJobCoordinator cancellation", () => {
  it("omits a control-bearing direct Core reason while retaining readable terminal evidence", async () => {
    const { jobs } = await coordinator();
    const worker = await submitStoppable(jobs, "cut:direct-control-reason");

    await expect(jobs.cancel({ jobId: "cut:direct-control-reason", callerId: CALLER_ID, reason: "line one\nline two" })).resolves.toMatchObject({ ok: true });
    await worker.abortObserved;
    worker.settleWorker();

    await expect(eventually(
      async () => await jobs.jobView().get({ jobId: "cut:direct-control-reason", callerId: CALLER_ID }),
      (answer) => answer.ok && answer.job.state === "cancelled"
    )).resolves.toMatchObject({ ok: true, job: { cancellation: { requestedBy: CALLER_ID } } });
    const events = await jobs.events({ jobId: "cut:direct-control-reason", callerId: CALLER_ID });
    expect(events).toMatchObject({ ok: true });
    expect(events.ok && events.value.events.find((entry) => entry.type === "cancel_requested")?.data).toEqual({ requestedBy: CALLER_ID });
  });

  it("shares one persistence failure with concurrent cancellation callers and still signals the worker", async () => {
    const { jobs, leases } = await coordinator();
    const worker = await submitStoppable(jobs, "cut:lease-cancel-failure");
    const announce = leases.announce.bind(leases);
    vi.spyOn(leases, "announce").mockImplementation(async (input) => {
      if (input.cancelRequested) throw new Error("lease storage offline");
      return await announce(input);
    });

    await expect(Promise.all([
      jobs.cancel({ jobId: "cut:lease-cancel-failure", callerId: CALLER_ID }),
      jobs.cancel({ jobId: "cut:lease-cancel-failure", callerId: CALLER_ID })
    ])).resolves.toEqual([
      expect.objectContaining({ ok: false, code: "capability_unavailable" }),
      expect.objectContaining({ ok: false, code: "capability_unavailable" })
    ]);
    await worker.abortObserved;
    worker.settleWorker();
    await eventually(async () => await jobs.jobView().get({ jobId: "cut:lease-cancel-failure", callerId: CALLER_ID }), (answer) => answer.ok && answer.job.state === "cancelled");
  });

  it("waits for cancellation evidence when an executing worker throws before its abort is published", async () => {
    const { jobs, leases } = await coordinator();
    const jobId = "cut:throw-during-cancel-fence";
    let entered!: () => void;
    const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let throwWorker!: () => void;
    const workerMayThrow = new Promise<void>((resolve) => { throwWorker = resolve; });
    let cancellationLeaseEntered!: () => void;
    const cancellationLease = new Promise<void>((resolve) => { cancellationLeaseEntered = resolve; });
    let releaseCancellationLease!: () => void;
    const cancellationLeaseReleased = new Promise<void>((resolve) => { releaseCancellationLease = resolve; });
    const announce = leases.announce.bind(leases);
    const announceSpy = vi.spyOn(leases, "announce").mockImplementation(async (input) => {
      if (input.cancelRequested) {
        cancellationLeaseEntered();
        await cancellationLeaseReleased;
      }
      return await announce(input);
    });
    try {
      await expect(jobs.submit({
        jobId, callerId: CALLER_ID, lane: "ffmpeg", operation: "render.final",
        execute: async () => { entered(); await workerMayThrow; throw new Error("worker failed before cancellation abort"); }
      })).resolves.toMatchObject({ ok: true, value: { jobId } });
      await executionEntered;

      const cancellation = jobs.cancel({ jobId, callerId: CALLER_ID, reason: "operator stopped export" });
      await cancellationLease;
      throwWorker();
      releaseCancellationLease();

      await expect(cancellation).resolves.toMatchObject({ ok: true });
      await expect(eventually(
        async () => await jobs.jobView().get({ jobId, callerId: CALLER_ID }),
        (answer) => answer.ok && answer.job.state === "cancelled"
      )).resolves.toMatchObject({ ok: true, job: { cancellation: { requestedBy: CALLER_ID } } });
      await expect(jobs.events({ jobId, callerId: CALLER_ID })).resolves.toMatchObject({
        ok: true,
        value: { events: [expect.objectContaining({ type: "submitted" }), expect.objectContaining({ type: "cancel_requested" }), expect.objectContaining({ type: "cancelled" })] }
      });
    } finally {
      releaseCancellationLease?.();
      announceSpy.mockRestore();
    }
  });

  it("recovers a terminal cancellation when cancel-event storage returns before worker settlement", async () => {
    const { jobs, eventsRoot, leases } = await coordinator();
    const worker = await submitStoppable(jobs, "cut:event-cancel-failure");
    // Restore the original identity-bound directory after the temporary outage.
    // Removing and recreating it instead depends on accidental inode reuse and
    // asks the retained event-store authority to accept a replacement root.
    const retainedEventsRoot = `${eventsRoot}-retained`;
    await rename(eventsRoot, retainedEventsRoot);
    await writeFile(eventsRoot, "not a directory");

    await expect(jobs.cancel({ jobId: "cut:event-cancel-failure", callerId: CALLER_ID })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
    await worker.abortObserved;
    const visible = await jobs.events({ jobId: "cut:event-cancel-failure", callerId: CALLER_ID });
    expect(visible).toMatchObject({ ok: true });
    expect(visible.ok && visible.value.events.some((entry) => entry.type === "cancel_requested")).toBe(false);
    await rm(eventsRoot, { force: true });
    await rename(retainedEventsRoot, eventsRoot);
    worker.settleWorker();
    await eventually(async () => await leases.readLiveLeases(), (live) => live.length === 0);
    await expect(jobs.jobView().get({ jobId: "cut:event-cancel-failure", callerId: CALLER_ID }))
      .resolves.toMatchObject({ ok: true, job: { state: "cancelled", cancellation: { requestedBy: CALLER_ID } } });
    await expect(jobs.events({ jobId: "cut:event-cancel-failure", callerId: CALLER_ID }))
      .resolves.toMatchObject({ ok: true, value: { events: [expect.objectContaining({ type: "submitted" }), expect.objectContaining({ type: "cancelled" })] } });
  });

  it("does not invoke a worker when cancellation wins during the executing-claim transition", async () => {
    const { jobs } = await coordinator();
    const jobId = "cut:cancel-before-execute";
    const advance = MotionJobIdentityClaimHandle.prototype.advance;
    let executingClaimEntered!: () => void;
    const executingClaim = new Promise<void>((resolve) => { executingClaimEntered = resolve; });
    let releaseExecutingClaim!: () => void;
    const executingReleased = new Promise<void>((resolve) => { releaseExecutingClaim = resolve; });
    let paused = true;
    const advanceSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "advance").mockImplementation(async function (this: MotionJobIdentityClaimHandle, phase) {
      if (paused && phase === "executing") {
        paused = false;
        executingClaimEntered();
        await executingReleased;
      }
      return await advance.call(this, phase);
    });
    const execute = vi.fn(async () => ({ ok: true }));
    try {
      await expect(jobs.submit({
        jobId, callerId: CALLER_ID, lane: "ffmpeg", operation: "render.final", execute
      })).resolves.toMatchObject({ ok: true, value: { jobId } });
      await executingClaim;

      const cancellation = jobs.cancel({ jobId, callerId: CALLER_ID, reason: "operator stopped before spawn" });
      releaseExecutingClaim();

      await expect(cancellation).resolves.toMatchObject({ ok: true });
      await eventually(async () => await jobs.jobView().get({ jobId, callerId: CALLER_ID }), (answer) => answer.ok && answer.job.state === "cancelled");
      expect(execute).not.toHaveBeenCalled();
      await expect(jobs.events({ jobId, callerId: CALLER_ID })).resolves.toMatchObject({
        ok: true,
        value: { events: [expect.objectContaining({ type: "submitted" }), expect.objectContaining({ type: "cancel_requested" }), expect.objectContaining({ type: "cancelled" })] }
      });
    } finally {
      releaseExecutingClaim?.();
      advanceSpy.mockRestore();
    }
  });

  it.each([
    { label: "success", state: "succeeded", execution: { ok: true } },
    { label: "failure", state: "failed", execution: { ok: false, error: { code: "job_queue_timeout", message: "capacity unavailable" } } }
  ] satisfies { label: string; state: "succeeded" | "failed"; execution: MotionJobCoordinatorExecution }[])(
    "waits for %s terminal completion instead of appending cancellation after its terminal event",
    async ({ label, state, execution }) => {
      const { jobs, records } = await coordinator();
      const jobId = `cut:late-cancel-${label}`;
      let finishWorker!: () => void;
      const workerFinished = new Promise<void>((resolve) => { finishWorker = resolve; });
      let terminalRecordEntered!: () => void;
      const recordEntered = new Promise<void>((resolve) => { terminalRecordEntered = resolve; });
      let releaseTerminalRecord!: () => void;
      const terminalRecordReleased = new Promise<void>((resolve) => { releaseTerminalRecord = resolve; });
      const writeTerminal = records.recordTerminalAcknowledged.bind(records);
      vi.spyOn(records, "recordTerminalAcknowledged").mockImplementation(async (record) => {
        if (record.jobId === jobId) {
          terminalRecordEntered();
          await terminalRecordReleased;
        }
        return await writeTerminal(record);
      });
      await expect(jobs.submit({
        jobId, callerId: CALLER_ID, lane: "ffmpeg", operation: "render.final",
        execute: async () => { await workerFinished; return execution; }
      })).resolves.toMatchObject({ ok: true, value: { jobId } });

      finishWorker();
      await recordEntered;
      const lateCancel = jobs.cancel({ jobId, callerId: CALLER_ID, reason: "too late" });
      releaseTerminalRecord();

      await expect(lateCancel).resolves.toMatchObject({ ok: false, code: "job_not_terminal" });
      await expect(jobs.jobView().get({ jobId, callerId: CALLER_ID })).resolves.toMatchObject({ ok: true, job: { state } });
      await expect(jobs.events({ jobId, callerId: CALLER_ID })).resolves.toMatchObject({
        ok: true, value: { events: [expect.objectContaining({ type: "submitted" }), expect.objectContaining({ type: state })] }
      });
      if (state === "succeeded") await settleSuccessfulJob(jobs, jobId, CALLER_ID);
    }
  );

  it("does not append a second cancellation after cancelled terminal settlement starts", async () => {
    const { jobs, records } = await coordinator();
    const jobId = "cut:late-cancel-cancelled";
    const worker = await submitStoppable(jobs, jobId);
    let terminalRecordEntered!: () => void;
    const recordEntered = new Promise<void>((resolve) => { terminalRecordEntered = resolve; });
    let releaseTerminalRecord!: () => void;
    const terminalRecordReleased = new Promise<void>((resolve) => { releaseTerminalRecord = resolve; });
    const writeTerminal = records.recordTerminalAcknowledged.bind(records);
    vi.spyOn(records, "recordTerminalAcknowledged").mockImplementation(async (record) => {
      if (record.jobId === jobId) {
        terminalRecordEntered();
        await terminalRecordReleased;
      }
      return await writeTerminal(record);
    });

    const firstCancel = jobs.cancel({ jobId, callerId: CALLER_ID, reason: "operator stopped export" });
    await worker.abortObserved;
    worker.settleWorker();
    await recordEntered;
    const lateCancel = jobs.cancel({ jobId, callerId: CALLER_ID, reason: "too late" });
    releaseTerminalRecord();

    await expect(firstCancel).resolves.toMatchObject({ ok: true });
    await expect(lateCancel).resolves.toMatchObject({ ok: false, code: "job_not_terminal" });
    await expect(jobs.events({ jobId, callerId: CALLER_ID })).resolves.toMatchObject({
      ok: true,
      value: { events: [expect.objectContaining({ type: "submitted" }), expect.objectContaining({ type: "cancel_requested" }), expect.objectContaining({ type: "cancelled" })] }
    });
  });

});
