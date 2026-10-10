import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionJobCoordinator, type MotionJobCoordinatorExecution } from "./job-coordinator";
import { MotionJobEventStore } from "./job-event-store";
import { MotionJobIdentityClaimHandle, MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { LEASE_HEARTBEAT_INTERVAL_MS, MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { parseMotionJobEvidence, type MotionJobEvidence } from "./job-evidence";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { createMotionRenderPlan, type MotionRenderPlan } from "./render-plan";
import { MotionRenderPlanStore } from "./render-plan-store";

const roots: string[] = [];
const CALLER_ID = "cut:terminal-evidence";
const PRODUCER = { frameLane: "gpu" as const, schema: "shellx-motion/gpu-streaming-producer@1" };

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

// Every case enters the POSIX-only trusted workspace anchor via inWorkspace.
describe.runIf(process.platform !== "win32")("MotionJobCoordinator terminal evidence integration", () => {
  it("persists parser-readable planned success evidence with exact compact mirrors and no artifact claim", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    await submitPlanned(fixture, "cut:evidence-success", plan, async () => ({
      ok: true,
      receiptId: "receipt-success",
      producerEvidence: PRODUCER,
      warnings: ["fallback encoder used"]
    }));

    const status = await terminal(fixture, "cut:evidence-success", "succeeded");
    expect(status).toMatchObject({
      lifecycle: "ended",
      outcome: "succeeded",
      planFingerprint: plan.fingerprint,
      warnings: ["fallback encoder used"],
      receiptId: "receipt-success",
      producerEvidence: PRODUCER
    });
    expectEvidence(status.evidence, {
      jobId: "cut:evidence-success",
      planFingerprint: plan.fingerprint,
      outcome: "succeeded",
      warnings: ["fallback encoder used"],
      receiptIds: ["receipt-success"],
      producerEvidence: PRODUCER,
      root: fixture.root
    });
  });

  it("persists the exact failed outcome and compact mirrors from a returned failure", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    await submitPlanned(fixture, "cut:evidence-returned-failure", plan, async () => ({
      ok: false,
      receiptId: "receipt-returned-failure",
      producerEvidence: PRODUCER,
      warnings: ["retry after capacity clears"],
      committed: true,
      error: { code: "job_queue_timeout", message: "render admission timed out", retryable: true }
    }));

    const status = await terminal(fixture, "cut:evidence-returned-failure", "failed");
    expect(status).toMatchObject({
      outcome: "failed",
      committed: true,
      error: { code: "job_queue_timeout", retryable: true },
      warnings: ["retry after capacity clears"],
      receiptId: "receipt-returned-failure",
      producerEvidence: PRODUCER
    });
    expectEvidence(status.evidence, {
      jobId: "cut:evidence-returned-failure",
      planFingerprint: plan.fingerprint,
      outcome: "failed",
      warnings: ["retry after capacity clears"],
      receiptIds: ["receipt-returned-failure"],
      producerEvidence: PRODUCER,
      root: fixture.root
    });
    expect(status).not.toHaveProperty("artifacts");
  });

  it("persists cancelled evidence only after the real worker settles", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    let entered!: () => void;
    const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
    await submitPlanned(fixture, "cut:evidence-cancelled", plan, async (signal) => await new Promise((resolve) => {
      entered();
      signal.addEventListener("abort", () => resolve({
        ok: false,
        receiptId: "receipt-cancelled",
        producerEvidence: PRODUCER,
        warnings: ["render stopped by operator"]
      }), { once: true });
    }));
    await executionEntered;
    await inWorkspace(fixture.root, async () => await fixture.jobs.cancel({
      jobId: "cut:evidence-cancelled", callerId: CALLER_ID, reason: "operator stopped export"
    }));

    const status = await terminal(fixture, "cut:evidence-cancelled", "cancelled");
    expect(status).toMatchObject({
      outcome: "cancelled",
      cancellation: { requestedBy: CALLER_ID, reason: "operator stopped export" },
      warnings: ["render stopped by operator"],
      receiptId: "receipt-cancelled",
      producerEvidence: PRODUCER
    });
    expectEvidence(status.evidence, {
      jobId: "cut:evidence-cancelled",
      planFingerprint: plan.fingerprint,
      outcome: "cancelled",
      warnings: ["render stopped by operator"],
      receiptIds: ["receipt-cancelled"],
      producerEvidence: PRODUCER,
      root: fixture.root
    });
  });

  it("retains a caught planned failure without inventing receipt, producer, warning, or artifact evidence", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    await submitPlanned(fixture, "cut:evidence-thrown-failure", plan, async () => {
      throw new Error("executor threw before producing terminal details");
    });

    const status = await terminal(fixture, "cut:evidence-thrown-failure", "failed");
    expect(status).toMatchObject({ outcome: "failed", error: { code: "invalid_args" }, warnings: [] });
    expectEvidence(status.evidence, {
      jobId: "cut:evidence-thrown-failure",
      planFingerprint: plan.fingerprint,
      outcome: "failed",
      warnings: [],
      receiptIds: [],
      producerEvidence: null,
      root: fixture.root
    });
  });

  it.each([
    ["local path", "render receipt at /private/output.mp4"],
    ["secret-shaped text", "authorization bearer token"]
  ])("keeps a planned success unchanged but omits V1 evidence for an unsafe %s warning", async (_label, warning) => {
    const fixture = await coordinator();
    const plan = renderPlan();
    await submitPlanned(fixture, `cut:evidence-unsafe-${_label.replaceAll(" ", "-")}`, plan, async () => ({
      ok: true,
      receiptId: "receipt-unsafe-warning",
      producerEvidence: PRODUCER,
      warnings: [warning]
    }));

    const jobId = `cut:evidence-unsafe-${_label.replaceAll(" ", "-")}`;
    const status = await terminal(fixture, jobId, "succeeded");
    expect(status).toMatchObject({
      outcome: "succeeded",
      planFingerprint: plan.fingerprint,
      warnings: [warning],
      receiptId: "receipt-unsafe-warning",
      producerEvidence: PRODUCER
    });
    expect(status.evidence).toBeUndefined();
  });

  it("keeps legacy planless final jobs terminally readable without V1 evidence", async () => {
    const fixture = await coordinator();
    await inWorkspace(fixture.root, async () => await fixture.jobs.submit({
      jobId: "cut:evidence-legacy",
      callerId: CALLER_ID,
      lane: "ffmpeg",
      frameLane: "gpu",
      operation: "render.final",
      execute: async () => ({
        ok: true,
        receiptId: "receipt-legacy",
        producerEvidence: PRODUCER,
        warnings: ["legacy render warning"]
      })
    }));

    const status = await terminal(fixture, "cut:evidence-legacy", "succeeded");
    expect(status).toMatchObject({
      outcome: "succeeded",
      warnings: ["legacy render warning"],
      receiptId: "receipt-legacy",
      producerEvidence: PRODUCER
    });
    expect(status.planFingerprint).toBeUndefined();
    expect(status.evidence).toBeUndefined();
  });

  it("holds the identity through durable lease, submitted, and execution phases before terminal release and exact replay", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-claim-phases";
    const announce = fixture.leases.announce.bind(fixture.leases);
    let leasePaused!: () => void;
    const leasePause = new Promise<void>((resolve) => { leasePaused = resolve; });
    let releaseLease!: () => void;
    const leaseReleased = new Promise<void>((resolve) => { releaseLease = resolve; });
    let pauseLease = true;
    vi.spyOn(fixture.leases, "announce").mockImplementation(async (input) => {
      if (pauseLease) {
        pauseLease = false;
        leasePaused();
        await leaseReleased;
      }
      return await announce(input);
    });
    const write = MotionJobEventStore.prototype.write;
    let submittedPaused!: () => void;
    const submittedPause = new Promise<void>((resolve) => { submittedPaused = resolve; });
    let releaseSubmitted!: () => void;
    const submittedReleased = new Promise<void>((resolve) => { releaseSubmitted = resolve; });
    let pauseSubmitted = true;
    const writeSpy = vi.spyOn(MotionJobEventStore.prototype, "write").mockImplementation(async function (this: MotionJobEventStore, input) {
      if (pauseSubmitted && input.events.at(-1)?.type === "submitted") {
        pauseSubmitted = false;
        submittedPaused();
        await submittedReleased;
      }
      await write.call(this, input);
    });
    let executingEntered!: () => void;
    const executing = new Promise<void>((resolve) => { executingEntered = resolve; });
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => { releaseExecution = resolve; });

    const submitted = inWorkspace(fixture.root, async () => await fixture.jobs.submit({
      jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => { executingEntered(); await executionReleased; return { ok: true }; }
    }));
    await leasePause;
    await expectHeldPhase(fixture, jobId, plan.fingerprint, "plan_bound");
    releaseLease();
    await submittedPause;
    await expectHeldPhase(fixture, jobId, plan.fingerprint, "host_lease_published");
    releaseSubmitted();
    await executing;
    await expectHeldPhase(fixture, jobId, plan.fingerprint, "executing");
    releaseExecution();
    await expect(submitted).resolves.toMatchObject({ ok: true, value: { jobId } });
    await terminal(fixture, jobId, "succeeded");

    const released = await eventuallyClaim(fixture, jobId, plan.fingerprint, (result) => result.ok);
    if (!released.ok) throw new Error("Terminal identity claim did not release.");
    await expect(released.handle.release()).resolves.toMatchObject({ ok: true, released: true });
    await expect(inWorkspace(fixture.root, async () => await fixture.jobs.submit({
      jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => ({ ok: true })
    }))).resolves.toMatchObject({ ok: true, value: { jobId, replayed: true } });
    writeSpy.mockRestore();
  });

  it("retains the claim, frees capacity, and withholds record/replay when terminal event persistence fails", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-terminal-event-failure";
    const write = MotionJobEventStore.prototype.write;
    const writeSpy = vi.spyOn(MotionJobEventStore.prototype, "write").mockImplementation(async function (this: MotionJobEventStore, input) {
      if (input.events.at(-1)?.type === "failed") throw new Error("terminal event storage offline");
      await write.call(this, input);
    });
    try {
      await submitPlanned(fixture, jobId, plan, async () => ({
        ok: false, error: { code: "job_queue_timeout", message: "retryable worker failure", retryable: true }
      }));
      await eventually(
        async () => await inWorkspace(fixture.root, async () => await fixture.leases.readLiveLeases()),
        (leases) => leases.length === 0
      );
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.jobView().get({ jobId, callerId: CALLER_ID })))
        .resolves.toEqual({ ok: false, code: "job_unknown" });
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.retry({ jobId, callerId: CALLER_ID, newJobId: "cut:evidence-terminal-event-failure-retry" })))
        .resolves.toMatchObject({ ok: false, code: "job_unknown" });
      let peerExecutions = 0;
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.submit({
        jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
        execute: async () => { peerExecutions += 1; return { ok: true }; }
      }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
      expect(peerExecutions).toBe(0);
      await expectHeldPhase(fixture, jobId, plan.fingerprint, "settling");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("retains the claim and withholds retry capability when terminal record acknowledgement is false", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-terminal-record-failure";
    let recordAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => { recordAttempted = resolve; });
    const recordSpy = vi.spyOn(fixture.records, "recordTerminalAcknowledged").mockImplementation(async () => {
      recordAttempted();
      return false;
    });
    try {
      await submitPlanned(fixture, jobId, plan, async () => ({
        ok: false, error: { code: "job_queue_timeout", message: "retryable worker failure", retryable: true }
      }));
      await attempted;
      const retry = await inWorkspace(fixture.root, async () => await fixture.jobs.retry({ jobId, callerId: CALLER_ID, newJobId: "cut:evidence-terminal-record-failure-retry" }));
      expect(retry.ok).toBe(false);
      let peerExecutions = 0;
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.submit({
        jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
        execute: async () => { peerExecutions += 1; return { ok: true }; }
      }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
      expect(peerExecutions).toBe(0);
      await expectHeldPhase(fixture, jobId, plan.fingerprint, "terminal_evidence");
    } finally {
      recordSpy.mockRestore();
    }
  });

  it.each(["terminal event", "terminal record"] as const)("keeps the retained identity heartbeat alive after %s persistence fails", async (failurePoint) => {
    vi.useFakeTimers();
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = `cut:evidence-heartbeat-${failurePoint.replaceAll(" ", "-")}`;
    let terminalAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => { terminalAttempted = resolve; });
    const heartbeatSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "heartbeat");
    const write = MotionJobEventStore.prototype.write;
    const writeSpy = failurePoint === "terminal event"
      ? vi.spyOn(MotionJobEventStore.prototype, "write").mockImplementation(async function (this: MotionJobEventStore, input) {
          if (input.events.at(-1)?.type === "failed") {
            terminalAttempted();
            throw new Error("terminal event storage offline");
          }
          await write.call(this, input);
        })
      : undefined;
    const recordSpy = failurePoint === "terminal record"
      ? vi.spyOn(fixture.records, "recordTerminalAcknowledged").mockImplementation(async () => {
          terminalAttempted();
          return false;
        })
      : undefined;
    try {
      await submitPlanned(fixture, jobId, plan, async () => ({
        ok: false, error: { code: "job_queue_timeout", message: "retryable worker failure", retryable: true }
      }));
      await attempted;
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS + 1);
      expect(heartbeatSpy).toHaveBeenCalled();
    } finally {
      recordSpy?.mockRestore();
      writeSpy?.mockRestore();
      heartbeatSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains the claim and withholds retry capability when final claim advancement fails", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-terminal-claim-advance-failure";
    const advance = MotionJobIdentityClaimHandle.prototype.advance;
    const advanceSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "advance").mockImplementation(async function (this: MotionJobIdentityClaimHandle, phase) {
      if (phase === "terminal_recorded") return { ok: false, code: "claim_unavailable" };
      return await advance.call(this, phase);
    });
    try {
      await submitPlanned(fixture, jobId, plan, async () => ({
        ok: false, error: { code: "job_queue_timeout", message: "retryable worker failure", retryable: true }
      }));
      await terminal(fixture, jobId, "failed");
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.retry({ jobId, callerId: CALLER_ID, newJobId: "cut:evidence-terminal-claim-advance-failure-retry" })))
        .resolves.toMatchObject({ ok: false, code: "job_not_retryable" });
      await expectHeldPhase(fixture, jobId, plan.fingerprint, "terminal_evidence");
    } finally {
      advanceSpy.mockRestore();
    }
  });

  it("retains the claim and withholds retry capability when final claim release fails", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-terminal-claim-release-failure";
    const releaseSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "release").mockResolvedValue({ ok: false, code: "claim_unavailable" });
    try {
      await submitPlanned(fixture, jobId, plan, async () => ({
        ok: false, error: { code: "job_queue_timeout", message: "retryable worker failure", retryable: true }
      }));
      await terminal(fixture, jobId, "failed");
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.retry({ jobId, callerId: CALLER_ID, newJobId: "cut:evidence-terminal-claim-release-failure-retry" })))
        .resolves.toMatchObject({ ok: false, code: "job_not_retryable" });
      await expectHeldPhase(fixture, jobId, plan.fingerprint, "terminal_recorded");
    } finally {
      releaseSpy.mockRestore();
    }
  });

  it("leaves a replay-only claim at claimed when its direct release fails", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-replay-release-failure";
    let executions = 0;
    await submitPlanned(fixture, jobId, plan, async () => { executions += 1; return { ok: true }; });
    await terminal(fixture, jobId, "succeeded");
    const released = await eventuallyClaim(fixture, jobId, plan.fingerprint, (result) => result.ok);
    if (!released.ok) throw new Error("Initial identity claim did not release.");
    await expect(released.handle.release()).resolves.toMatchObject({ ok: true, released: true });
    const releaseSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "release").mockResolvedValue({ ok: false, code: "claim_unavailable" });
    try {
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.submit({
        jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
        execute: async () => { executions += 100; return { ok: true }; }
      }))).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
      await expectHeldPhase(fixture, jobId, plan.fingerprint, "claimed");
      expect(executions).toBe(1);
    } finally {
      releaseSpy.mockRestore();
    }
  });

  it("requires the exact persisted submitted plan identity before a completed planned job can replay", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-replay-requires-submitted-event";
    let executions = 0;
    await submitPlanned(fixture, jobId, plan, async () => { executions += 1; return { ok: true }; });
    await terminal(fixture, jobId, "succeeded");
    const released = await eventuallyClaim(fixture, jobId, plan.fingerprint, (result) => result.ok);
    if (!released.ok) throw new Error("Initial identity claim did not release.");
    await expect(released.handle.release()).resolves.toMatchObject({ ok: true, released: true });
    const readSpy = vi.spyOn(MotionJobEventStore.prototype, "read").mockResolvedValue([{
      schema: "shellx-motion/job-event@1", seq: 1, atMs: 1, type: "submitted",
      data: { renderPlan: { schema: plan.schema, fingerprint: plan.fingerprint, unexpected: "must-refuse" } }
    }] as never);
    try {
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.submit({
        jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
        execute: async () => { executions += 100; return { ok: true }; }
      }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
      expect(executions).toBe(1);
    } finally {
      readSpy.mockRestore();
    }
  });
});

async function coordinator() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-terminal-evidence-"));
  roots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  const identityClaims = new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") });
  return {
    root,
    leases,
    records,
    identityClaims,
    jobs: new MotionJobCoordinator({
      leases,
      records,
      eventsRoot: join(root, "events"),
      renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "render-plans") }),
      identityClaims
    })
  };
}

async function submitPlanned(
  fixture: Awaited<ReturnType<typeof coordinator>>,
  jobId: string,
  plan: MotionRenderPlan,
  execute: (signal: AbortSignal) => Promise<MotionJobCoordinatorExecution>
): Promise<void> {
  await expect(inWorkspace(fixture.root, async () => await fixture.jobs.submit({
    jobId,
    callerId: CALLER_ID,
    lane: "ffmpeg",
    frameLane: "gpu",
    operation: "render.final",
    renderPlan: plan,
    execute
  }))).resolves.toMatchObject({ ok: true, value: { jobId } });
}

async function terminal(
  fixture: Awaited<ReturnType<typeof coordinator>>,
  jobId: string,
  state: "succeeded" | "failed" | "cancelled"
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await inWorkspace(fixture.root, async () => await fixture.jobs.jobView().get({ jobId, callerId: CALLER_ID }));
    if (result.ok && result.job.state === state) return result.job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${jobId} to settle ${state}.`);
}

function expectEvidence(
  evidence: MotionJobEvidence | undefined,
  expected: {
    jobId: string;
    planFingerprint: string;
    outcome: "succeeded" | "failed" | "cancelled";
    warnings: string[];
    receiptIds: string[];
    producerEvidence: MotionJobEvidence["producerEvidence"];
    root: string;
  }
): void {
  expect(evidence).toBeDefined();
  const parsed = parseMotionJobEvidence(evidence);
  expect(parsed).toMatchObject({
    schema: "shellx-motion/job-evidence@1",
    jobId: expected.jobId,
    callerId: CALLER_ID,
    operation: "render.final",
    planFingerprint: expected.planFingerprint,
    outcome: expected.outcome,
    warnings: expected.warnings,
    receiptIds: expected.receiptIds,
    producerEvidence: expected.producerEvidence,
    artifacts: [],
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
  });
  expect(parsed.artifacts).toEqual([]);
  expect(parsed).not.toHaveProperty("rootRelativePath");
  expect(JSON.stringify(parsed)).not.toContain(expected.root);
}

function renderPlan(): MotionRenderPlan {
  const manifestSha256 = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  return createMotionRenderPlan({
    package: { id: "pkg_terminal_evidence", manifestSha256 },
    motion: { id: "motion_terminal_evidence", documentSha256 },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256, motionSha256: documentSha256 },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "c".repeat(64) },
    quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: {
      engine: "ffmpeg@7.1",
      routeFingerprint: "d".repeat(64),
      presetFingerprint: "e".repeat(64),
      capabilityFingerprint: "f".repeat(64)
    },
    compatibility: { version: 1, state: "current" }
  });
}

async function inWorkspace<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation);
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for retained coordinator state.");
}

async function expectHeldPhase(
  fixture: Awaited<ReturnType<typeof coordinator>>,
  jobId: string,
  planFingerprint: string,
  phase: "claimed" | "plan_bound" | "host_lease_published" | "executing" | "settling" | "terminal_evidence" | "terminal_recorded"
): Promise<void> {
  const acquired = await inWorkspace(fixture.root, async () => await fixture.identityClaims.acquire({
    callerId: CALLER_ID, jobId, admission: { mode: "planned", planFingerprint }
  }));
  expect(acquired).toMatchObject({ ok: false, code: "claim_held", claim: { phase } });
}

async function eventuallyClaim(
  fixture: Awaited<ReturnType<typeof coordinator>>,
  jobId: string,
  planFingerprint: string,
  predicate: (result: Awaited<ReturnType<MotionJobIdentityClaimStore["acquire"]>>) => boolean
): Promise<Awaited<ReturnType<MotionJobIdentityClaimStore["acquire"]>>> {
  let result = await inWorkspace(fixture.root, async () => await fixture.identityClaims.acquire({
    callerId: CALLER_ID, jobId, admission: { mode: "planned", planFingerprint }
  }));
  for (let attempt = 0; attempt < 100 && !predicate(result); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    result = await inWorkspace(fixture.root, async () => await fixture.identityClaims.acquire({
      callerId: CALLER_ID, jobId, admission: { mode: "planned", planFingerprint }
    }));
  }
  return result;
}
