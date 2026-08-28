import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionJobEventStore, MOTION_JOB_EVENT_MAX_BYTES, MOTION_JOB_EVENT_MAX_DATA_BYTES, type MotionJobCoordinatorEvent } from "./job-event-store";
import { MotionJobCoordinator } from "./job-coordinator";
import { motionJobFileKey, motionJobOwnerKey } from "./job-id-file";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry, type MotionJobRecord } from "./job-registry";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function coordinator() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-coordinator-"));
  roots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  const eventsRoot = join(root, "events");
  return { root, leases, records, eventsRoot, jobs: new MotionJobCoordinator({ leases, records, eventsRoot }) };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for coordinator state.");
}

function eventPath(eventsRoot: string, jobId: string, callerId = "cut:workspace"): string {
  return join(eventsRoot, `${motionJobOwnerKey(callerId, jobId)}.events.json`);
}

function event(seq: number, type: MotionJobCoordinatorEvent["type"], data?: Record<string, unknown>): MotionJobCoordinatorEvent {
  return { schema: "shellx-motion/job-event@1", seq, atMs: 1_780_000_000_000 + seq, type, ...(data ? { data } : {}) };
}

function terminalRecord(jobId: string, callerId: string, endedAtMs: number): MotionJobRecord {
  return {
    schema: "shellx-motion/job-record@1", jobId, callerId, lane: "connector", operation: "connector.legacy@1",
    lifecycle: "ended", outcome: "succeeded", createdAtMs: endedAtMs - 100, startedAtMs: endedAtMs - 50,
    endedAtMs, durationMs: 50, queueWaitMs: 50, warnings: []
  };
}

async function submitStoppable(jobs: MotionJobCoordinator, jobId: string) {
  let entered!: () => void;
  const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
  let observedAbort!: () => void;
  const abortObserved = new Promise<void>((resolve) => { observedAbort = resolve; });
  let settleWorker!: () => void;
  const workerSettled = new Promise<void>((resolve) => { settleWorker = resolve; });
  const submitted = await jobs.submit({
    jobId, callerId: "cut:workspace", lane: "ffmpeg", operation: "render.final",
    execute: async (signal) => await new Promise((resolve) => {
      entered();
      signal.addEventListener("abort", () => observedAbort(), { once: true });
      void workerSettled.then(() => resolve({ ok: false, error: { code: "job_cancelled", message: "worker saw coordinator signal" } }));
    })
  });
  await executionEntered;
  return { submitted, abortObserved, settleWorker };
}

async function submitSucceeded(jobs: MotionJobCoordinator, jobId: string) {
  const submitted = await jobs.submit({
    jobId, callerId: "cut:workspace", lane: "ffmpeg", operation: "render.final", execute: async () => ({ ok: true })
  });
  expect(submitted.ok).toBe(true);
  await eventually(async () => await jobs.jobView().get({ jobId, callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "succeeded");
}

describe("MotionJobCoordinator", () => {
  it("keeps the job nonterminal while cancellation is requested, aborts its real execution signal, then records cancelled", async () => {
    const { jobs } = await coordinator();
    const { submitted, abortObserved, settleWorker } = await submitStoppable(jobs, "cut:cancel-real-worker");
    expect(submitted).toMatchObject({ ok: true, value: { jobId: "cut:cancel-real-worker" } });

    const accepted = await jobs.cancel({ jobId: "cut:cancel-real-worker", callerId: "cut:workspace", reason: "operator stopped export" });
    expect(accepted).toMatchObject({ ok: true, value: { job: { jobId: "cut:cancel-real-worker", cancelRequested: { requestedBy: "cut:workspace" } } } });
    await abortObserved;
    expect(await jobs.jobView().get({ jobId: "cut:cancel-real-worker", callerId: "cut:workspace" })).toMatchObject({ ok: true, job: { lifecycle: "pending", state: "pending", outcome: null } });
    settleWorker();

    const ended = await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:cancel-real-worker", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.state === "cancelled"
    );
    expect(ended).toMatchObject({ ok: true, job: { state: "cancelled", cancellation: { requestedBy: "cut:workspace", reason: "operator stopped export" } } });
    expect((ended as { ok: true; job: { error?: unknown } }).job.error).toBeUndefined();
    const events = await jobs.events({ jobId: "cut:cancel-real-worker", callerId: "cut:workspace" });
    expect(events).toMatchObject({ ok: true, value: { events: expect.arrayContaining([
      expect.objectContaining({ type: "submitted" }), expect.objectContaining({ type: "cancel_requested" }), expect.objectContaining({ type: "cancelled" })
    ]) } });
  });

  it("records success when cancellation races only after an irreversible connector commit", async () => {
    const { jobs } = await coordinator();
    let committed!: () => void;
    const commitReached = new Promise<void>((resolve) => { committed = resolve; });
    let returnResult!: () => void;
    const mayReturn = new Promise<void>((resolve) => { returnResult = resolve; });
    const submitted = await jobs.submit({
      jobId: "cut:connector-commit-fence", callerId: "cut:workspace", lane: "connector", operation: "connector.template-to-cut@1",
      execute: async () => {
        committed();
        await mayReturn;
        return { ok: true, committed: true, receiptPath: "/receipts/connector.json" };
      }
    });
    expect(submitted.ok).toBe(true);
    await commitReached;
    await expect(jobs.cancel({ jobId: "cut:connector-commit-fence", callerId: "cut:workspace" })).resolves.toMatchObject({ ok: true });
    returnResult();
    const terminal = await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:connector-commit-fence", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.lifecycle === "ended"
    );
    expect(terminal).toMatchObject({ ok: true, job: { state: "succeeded", receiptPath: "/receipts/connector.json" } });
    const events = await jobs.events({ jobId: "cut:connector-commit-fence", callerId: "cut:workspace" });
    expect(events).toMatchObject({ ok: true, value: { events: expect.arrayContaining([
      expect.objectContaining({ type: "cancel_requested" }), expect.objectContaining({ type: "succeeded" })
    ]) } });
  });

  it("retries only a retryable failure as a new linked job and retains durable events", async () => {
    const { jobs } = await coordinator();
    let calls = 0;
    const submitted = await jobs.submit({
      jobId: "cut:retry-source", callerId: "cut:workspace", lane: "custom-lane", operation: "custom.operation",
      execute: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, receiptId: "receipt-source", error: { code: "job_queue_timeout", message: "busy", retryable: true } }
          : { ok: true, receiptId: "receipt-retry" };
      }
    });
    expect(submitted.ok).toBe(true);
    await eventually(async () => await jobs.jobView().get({ jobId: "cut:retry-source", callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "failed");

    const retry = await jobs.retry({ jobId: "cut:retry-source", callerId: "cut:workspace", newJobId: "cut:retry-2" });
    expect(retry).toMatchObject({ ok: true, value: { jobId: "cut:retry-2", priorJobId: "cut:retry-source" } });
    const ended = await eventually(async () => await jobs.jobView().get({ jobId: "cut:retry-2", callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "succeeded");
    expect(ended).toMatchObject({ ok: true, job: { lane: "custom-lane", operation: "custom.operation", lineage: { priorJobId: "cut:retry-source", priorReceiptId: "receipt-source", retryAttempt: 1 } } });
    expect(calls).toBe(2);
    const events = await jobs.events({ jobId: "cut:retry-2", callerId: "cut:workspace" });
    expect(events).toMatchObject({ ok: true, value: { events: [expect.objectContaining({ type: "submitted", seq: 1 }), expect.objectContaining({ type: "retry_submitted", seq: 2 }), expect.objectContaining({ type: "succeeded", seq: 3 })] } });
  });

  it("retains bounded protocol binding data in submitted events and retries", async () => {
    const { jobs } = await coordinator();
    let calls = 0;
    const submissionData = {
      capabilityId: "connector.future-scene@1",
      descriptorRevision: 7,
      descriptorFingerprint: "a".repeat(64),
      requestSchemaId: "shellx-motion/connector-request/future-scene@1"
    };
    const submitted = await jobs.submit({
      jobId: "cut:connector-binding", callerId: "cut:workspace", lane: "connector",
      operation: "connector.future-scene@1", submissionData,
      execute: async () => (++calls === 1
        ? { ok: false, error: { code: "job_queue_timeout", message: "busy", retryable: true } }
        : { ok: true })
    });
    expect(submitted.ok).toBe(true);
    await eventually(async () => await jobs.jobView().get({ jobId: "cut:connector-binding", callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "failed");
    const retried = await jobs.retry({ jobId: "cut:connector-binding", callerId: "cut:workspace", newJobId: "cut:connector-binding-retry" });
    expect(retried.ok).toBe(true);
    await eventually(async () => await jobs.jobView().get({ jobId: "cut:connector-binding-retry", callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "succeeded");
    for (const jobId of ["cut:connector-binding", "cut:connector-binding-retry"]) {
      const events = await jobs.events({ jobId, callerId: "cut:workspace" });
      expect(events).toMatchObject({ ok: true, value: { events: expect.arrayContaining([expect.objectContaining({ type: "submitted", data: expect.objectContaining(submissionData) })]) } });
    }
    expect(calls).toBe(2);
  });

  it("preserves a future connector error and retry policy through events and terminal storage", async () => {
    const { jobs, root, eventsRoot } = await coordinator();
    await expect(jobs.submit({
      jobId: "cut:future-typed-error",
      callerId: "cut:workspace",
      lane: "connector",
      operation: "connector.future-scene@1",
      execute: async () => ({
        ok: false,
        error: {
          code: "connector_future_backpressure",
          message: "future renderer is saturated",
          retryable: true,
          remedy: "wait",
          retryAfterMs: 2_500,
          suggestedAction: "Wait, then retry the same immutable binding."
        }
      })
    })).resolves.toMatchObject({ ok: true });

    const terminal = await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:future-typed-error", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.state === "failed"
    );
    expect(terminal).toMatchObject({ ok: true, job: { error: {
      code: "connector_future_backpressure",
      message: "future renderer is saturated",
      retryable: true,
      remedy: "wait",
      retryAfterMs: 2_500,
      suggestedAction: "Wait, then retry the same immutable binding."
    } } });
    await expect(jobs.events({ jobId: "cut:future-typed-error", callerId: "cut:workspace" }))
      .resolves.toMatchObject({ ok: true, value: { events: expect.arrayContaining([
        expect.objectContaining({ type: "failed", data: expect.objectContaining({
          code: "connector_future_backpressure", retryable: true, remedy: "wait", retryAfterMs: 2_500
        }) })
      ]) } });

    const restarted = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot
    });
    await expect(restarted.jobView().get({ jobId: "cut:future-typed-error", callerId: "cut:workspace" }))
      .resolves.toMatchObject({ ok: true, job: { error: {
        code: "connector_future_backpressure", retryable: true, retryAfterMs: 2_500
      } } });
  });

  it("preserves a typed connector exception without serializing its private stack or detail", async () => {
    const { jobs } = await coordinator();
    await expect(jobs.submit({
      jobId: "cut:future-typed-exception",
      callerId: "cut:workspace",
      lane: "connector",
      operation: "connector.future-scene@1",
      execute: async () => {
        const error = Object.assign(new Error("future renderer is saturated"), {
          code: "connector_future_backpressure",
          retryable: true,
          remedy: "wait",
          retryAfterMs: 2_500,
          suggestedAction: "Wait, then retry the same immutable binding.",
          detail: { privatePath: "/private/connector/input.json" }
        });
        error.stack = "Error: future renderer is saturated\n    at /private/connector/stack.ts:1:1";
        throw error;
      }
    })).resolves.toMatchObject({ ok: true });

    const terminal = await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:future-typed-exception", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.state === "failed"
    );
    expect(terminal).toMatchObject({ ok: true, job: { error: {
      code: "connector_future_backpressure",
      message: "future renderer is saturated",
      retryable: true,
      remedy: "wait",
      retryAfterMs: 2_500,
      suggestedAction: "Wait, then retry the same immutable binding."
    } } });
    expect(JSON.stringify(terminal)).not.toContain("/private/connector");
    expect(JSON.stringify(terminal)).not.toContain("stack.ts");
    await expect(jobs.events({ jobId: "cut:future-typed-exception", callerId: "cut:workspace" }))
      .resolves.toMatchObject({ ok: true, value: { events: expect.arrayContaining([
        expect.objectContaining({ type: "failed", data: expect.objectContaining({
          code: "connector_future_backpressure", retryable: true, remedy: "wait", retryAfterMs: 2_500
        }) })
      ]) } });
  });

  it("keeps a strict GPU frame lane and receipt-owned producer link through submit, events, cancellation-safe retry, and terminal state", async () => {
    const { jobs } = await coordinator();
    let executions = 0;
    const signals: AbortSignal[] = [];
    const submitted = await jobs.submit({
      jobId: "cut:gpu-source", callerId: "cut:workspace", lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      execute: async (signal) => {
        executions += 1;
        signals.push(signal);
        return executions === 1
          ? { ok: false, receiptId: "gpu-source-receipt", error: { code: "job_queue_timeout", message: "admission timed out", retryable: true } }
          : {
              ok: true,
              receiptId: "gpu-retry-receipt",
              receiptPath: "/receipts/gpu-retry-receipt.json",
              producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" }
            };
      }
    });
    expect(submitted).toMatchObject({ ok: true, value: { jobId: "cut:gpu-source" } });
    const source = await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:gpu-source", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.state === "failed"
    );
    expect(source).toMatchObject({ ok: true, job: { frameLane: "gpu", lane: "ffmpeg", state: "failed" } });
    const sourceEvents = await jobs.events({ jobId: "cut:gpu-source", callerId: "cut:workspace" });
    expect(sourceEvents).toMatchObject({ ok: true, value: { events: expect.arrayContaining([
      expect.objectContaining({ type: "submitted", data: expect.objectContaining({ frameLane: "gpu" }) }),
      expect.objectContaining({ type: "failed", data: expect.objectContaining({ frameLane: "gpu" }) })
    ]) } });

    const retried = await jobs.retry({ jobId: "cut:gpu-source", callerId: "cut:workspace", newJobId: "cut:gpu-retry" });
    expect(retried).toMatchObject({ ok: true, value: { jobId: "cut:gpu-retry", priorJobId: "cut:gpu-source" } });
    const terminal = await eventually(
      async () => await jobs.jobView().get({ jobId: "cut:gpu-retry", callerId: "cut:workspace" }),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    expect(terminal).toMatchObject({ ok: true, job: {
      frameLane: "gpu",
      receiptId: "gpu-retry-receipt",
      receiptPath: "/receipts/gpu-retry-receipt.json",
      producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" },
      lineage: { priorJobId: "cut:gpu-source", priorReceiptId: "gpu-source-receipt", retryAttempt: 1 }
    } });
    expect(executions).toBe(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted === false)).toBe(true);
    const events = await jobs.events({ jobId: "cut:gpu-retry", callerId: "cut:workspace" });
    expect(events).toMatchObject({ ok: true, value: { events: [
      expect.objectContaining({ type: "submitted", data: expect.objectContaining({ frameLane: "gpu" }) }),
      expect.objectContaining({ type: "retry_submitted", data: expect.objectContaining({ frameLane: "gpu", priorJobId: "cut:gpu-source" }) }),
      expect.objectContaining({ type: "succeeded", data: expect.objectContaining({
        frameLane: "gpu", receiptId: "gpu-retry-receipt",
        producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" }
      }) })
    ] } });
  });

  it("reserves a caller-provided job id before any asynchronous setup", async () => {
    const { jobs } = await coordinator();
    let entered!: () => void;
    const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const input = {
      jobId: "cut:submit-race", callerId: "cut:workspace", lane: "ffmpeg", operation: "render.final",
      execute: async () => {
        executions += 1;
        entered();
        await released;
        return { ok: true };
      }
    };
    const [first, second] = await Promise.all([jobs.submit(input), jobs.submit(input)]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((answer) => !answer.ok)).toMatchObject({ ok: false, code: "job_not_terminal" });
    await executionEntered;
    expect(executions).toBe(1);
    release();
    await eventually(async () => await jobs.jobView().get({ jobId: "cut:submit-race", callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "succeeded");
  });

  it("coordinates concurrent duplicate external ids by authenticated owner, including events and replay", async () => {
    const { jobs, eventsRoot } = await coordinator();
    const jobId = "host:shared-external-id";
    const ownerA = "cut:workspace-a";
    const ownerB = "design-studio:workspace-b";
    let releaseA!: () => void;
    let releaseB!: () => void;
    let enteredA!: () => void;
    let enteredB!: () => void;
    const waitingA = new Promise<void>((resolve) => { releaseA = resolve; });
    const waitingB = new Promise<void>((resolve) => { releaseB = resolve; });
    const entered = Promise.all([
      new Promise<void>((resolve) => { enteredA = resolve; }),
      new Promise<void>((resolve) => { enteredB = resolve; })
    ]);
    let callsA = 0;
    let callsB = 0;
    const submit = (callerId: string, owner: "A" | "B") => jobs.submit({
      jobId,
      callerId,
      lane: "connector",
      operation: "connector.owner-qualified@1",
      submissionData: { owner },
      execute: async () => {
        if (owner === "A") {
          callsA += 1;
          if (callsA === 1) {
            enteredA();
            await waitingA;
            return { ok: false, error: { code: "job_queue_timeout", message: "retry A", retryable: true } };
          }
        } else {
          callsB += 1;
          if (callsB === 1) {
            enteredB();
            await waitingB;
            return { ok: false, error: { code: "job_queue_timeout", message: "retry B", retryable: true } };
          }
        }
        return { ok: true };
      }
    });

    const [acceptedA, acceptedB] = await Promise.all([submit(ownerA, "A"), submit(ownerB, "B")]);
    expect(acceptedA).toMatchObject({ ok: true, value: { jobId } });
    expect(acceptedB).toMatchObject({ ok: true, value: { jobId } });
    await entered;
    expect((await jobs.jobView().list({ callerId: "operator", scope: "all" })).filter((job) => job.jobId === jobId)).toHaveLength(2);

    releaseA();
    releaseB();
    await eventually(async () => await jobs.jobView().get({ jobId, callerId: ownerA }), (answer) => answer.ok && answer.job.state === "failed");
    await eventually(async () => await jobs.jobView().get({ jobId, callerId: ownerB }), (answer) => answer.ok && answer.job.state === "failed");
    await expect(jobs.events({ jobId, callerId: ownerA })).resolves.toMatchObject({ ok: true, value: { events: expect.arrayContaining([expect.objectContaining({ type: "submitted", data: expect.objectContaining({ owner: "A" }) })]) } });
    await expect(jobs.events({ jobId, callerId: ownerB })).resolves.toMatchObject({ ok: true, value: { events: expect.arrayContaining([expect.objectContaining({ type: "submitted", data: expect.objectContaining({ owner: "B" }) })]) } });

    await expect(jobs.retry({ jobId, callerId: ownerA, newJobId: "owner-a-retry" })).resolves.toMatchObject({ ok: true, value: { jobId: "owner-a-retry", priorJobId: jobId } });
    await expect(jobs.retry({ jobId, callerId: ownerB, newJobId: "owner-b-retry" })).resolves.toMatchObject({ ok: true, value: { jobId: "owner-b-retry", priorJobId: jobId } });
    await eventually(async () => await jobs.jobView().get({ jobId: "owner-a-retry", callerId: ownerA }), (answer) => answer.ok && answer.job.state === "succeeded");
    await eventually(async () => await jobs.jobView().get({ jobId: "owner-b-retry", callerId: ownerB }), (answer) => answer.ok && answer.job.state === "succeeded");
    expect([callsA, callsB]).toEqual([2, 2]);
    const files = await readdir(eventsRoot);
    expect(files).toHaveLength(4);
    expect(files.some((name) => name.includes(ownerA) || name.includes(ownerB))).toBe(false);
  });

  it("signals the owned worker and returns a structured failure when the lease cancel intent cannot persist", async () => {
    const { jobs, leases } = await coordinator();
    const worker = await submitStoppable(jobs, "cut:lease-cancel-failure");
    const original = leases.announce.bind(leases);
    vi.spyOn(leases, "announce").mockImplementation(async (input) => {
      if (input.cancelRequested) throw new Error("lease storage offline");
      return await original(input);
    });

    await expect(jobs.cancel({ jobId: "cut:lease-cancel-failure", callerId: "cut:workspace" })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
    await worker.abortObserved;
    worker.settleWorker();
    await eventually(async () => await jobs.jobView().get({ jobId: "cut:lease-cancel-failure", callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "cancelled");
  });

  it("signals the owned worker and returns a structured failure when the cancel event cannot persist", async () => {
    const { jobs, eventsRoot } = await coordinator();
    const worker = await submitStoppable(jobs, "cut:event-cancel-failure");
    await rm(eventsRoot, { recursive: true, force: true });
    await writeFile(eventsRoot, "not a directory");

    await expect(jobs.cancel({ jobId: "cut:event-cancel-failure", callerId: "cut:workspace" })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
    await worker.abortObserved;
    const visible = await jobs.events({ jobId: "cut:event-cancel-failure", callerId: "cut:workspace" });
    expect(visible).toMatchObject({ ok: true });
    expect(visible.ok && visible.value.events.some((entry) => entry.type === "cancel_requested")).toBe(false);
    await rm(eventsRoot, { force: true });
    await mkdir(eventsRoot, { recursive: true });
    worker.settleWorker();
    await eventually(async () => await jobs.jobView().get({ jobId: "cut:event-cancel-failure", callerId: "cut:workspace" }), (answer) => answer.ok && answer.job.state === "cancelled");
  });

  it("reads a legacy event log only for its sole matching legacy terminal owner", async () => {
    const { root, records, eventsRoot, jobs } = await coordinator();
    const jobId = "legacy:events";
    const ownerA = "cut:legacy-owner";
    const ownerB = "design-studio:current-owner";
    const endedAtMs = Date.now() - 1_000;
    await mkdir(join(root, "records"), { recursive: true });
    await writeFile(join(root, "records", `${motionJobFileKey(jobId)}--${endedAtMs}.job.json`), `${JSON.stringify(terminalRecord(jobId, ownerA, endedAtMs))}\n`);
    await mkdir(eventsRoot, { recursive: true });
    await writeFile(join(eventsRoot, `${motionJobFileKey(jobId)}.events.json`), `${JSON.stringify([event(1, "submitted"), event(2, "succeeded")])}\n`);

    await expect(jobs.events({ jobId, callerId: ownerA })).resolves.toMatchObject({
      ok: true, value: { events: [expect.objectContaining({ type: "submitted" }), expect.objectContaining({ type: "succeeded" })] }
    });

    // A current record for another owner sharing the external id must never use A's legacy log.
    await records.record(terminalRecord(jobId, ownerB, endedAtMs + 1));
    await expect(jobs.events({ jobId, callerId: ownerB })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
    await expect(jobs.events({ jobId, callerId: "other:owner" })).resolves.toMatchObject({ ok: false, code: "job_not_visible" });
  });

  it("fails closed on event schema/type and sequence tampering", async () => {
    const { jobs, eventsRoot } = await coordinator();
    const jobId = "cut:event-tamper";
    await submitSucceeded(jobs, jobId);
    const path = eventPath(eventsRoot, jobId);
    await writeFile(path, `${JSON.stringify([event(1, "submitted"), { ...event(2, "succeeded"), schema: "wrong" }])}\n`);
    await expect(jobs.events({ jobId, callerId: "cut:workspace" })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });

    await writeFile(path, `${JSON.stringify([event(1, "submitted"), event(3, "succeeded")])}\n`);
    await expect(jobs.events({ jobId, callerId: "cut:workspace" })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
  });

  it("fails closed on an oversized event data payload or file", async () => {
    const { jobs, eventsRoot } = await coordinator();
    const jobId = "cut:event-bounds";
    await submitSucceeded(jobs, jobId);
    const path = eventPath(eventsRoot, jobId);
    await writeFile(path, `${JSON.stringify([event(1, "submitted", { note: "x".repeat(MOTION_JOB_EVENT_MAX_DATA_BYTES + 1) })])}\n`);
    await expect(jobs.events({ jobId, callerId: "cut:workspace" })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });

    await writeFile(path, "x".repeat(MOTION_JOB_EVENT_MAX_BYTES + 1));
    await expect(jobs.events({ jobId, callerId: "cut:workspace" })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
  });

  it("fails closed when a terminal record and its final event disagree", async () => {
    const { jobs, eventsRoot } = await coordinator();
    const jobId = "cut:event-terminal-mismatch";
    await submitSucceeded(jobs, jobId);
    await writeFile(eventPath(eventsRoot, jobId), `${JSON.stringify([event(1, "submitted"), event(2, "failed")])}\n`);
    await expect(jobs.events({ jobId, callerId: "cut:workspace" })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
  });

  it("serializes snapshots so a delayed older append cannot overwrite a terminal event", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-event-store-"));
    roots.push(root);
    let firstWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondWrites = 0;
    const store = new MotionJobEventStore(root, {
      writeSnapshot: async (path, serialized) => {
        if (serialized.includes('"seq":1') && !serialized.includes('"seq":2')) {
          firstWriteStarted();
          await firstReleased;
        } else {
          secondWrites += 1;
        }
        await writeFile(path, serialized);
      }
    });
    const jobId = "cut:event-write-order";
    const callerId = "cut:workspace";
    const older = store.write({ callerId, jobId, events: [event(1, "submitted")] });
    await firstStarted;
    const newer = store.write({ callerId, jobId, events: [event(1, "submitted"), event(2, "succeeded")] });
    await Promise.resolve();
    expect(secondWrites).toBe(0);
    releaseFirst();
    await Promise.all([older, newer]);
    expect(await store.read({ callerId, jobId })).toEqual([event(1, "submitted"), event(2, "succeeded")]);
  });
});
