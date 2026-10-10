import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionJobCoordinator } from "./job-coordinator";
import { currentMotionHostJob } from "./host-job";
import { MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { createMotionRenderPlan, type MotionRenderPlan } from "./render-plan";
import { MotionRenderAdmissionStore } from "./render-admission-store";
import { motionRenderPlanBindingFileName, MotionRenderPlanStore } from "./render-plan-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function coordinator() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-planned-coordinator-"));
  roots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  const eventsRoot = join(root, "events");
  const renderPlans = new MotionRenderPlanStore({ planRoot: join(root, "render-plans") });
  const renderAdmissions = new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") });
  return { root, records, renderPlans, renderAdmissions, jobs: new MotionJobCoordinator({ leases, records, eventsRoot, renderPlans, renderAdmissions }) };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  return await vi.waitFor(async () => {
    const value = await read();
    if (predicate(value)) return value;
    throw new Error(`Coordinator state has not reached the expected predicate; last observation: ${JSON.stringify(value) ?? String(value)}`);
  }, { timeout: 5_000, interval: 10 });
}

function renderPlan(intentSha256 = "c".repeat(64)): MotionRenderPlan {
  const manifestSha256 = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  return createMotionRenderPlan({
    package: { id: "pkg_demo", manifestSha256 },
    motion: { id: "motion_demo", documentSha256 },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256, motionSha256: documentSha256 },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256 },
    quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: {
      engine: "ffmpeg@7.1", routeFingerprint: "d".repeat(64), presetFingerprint: "e".repeat(64), capabilityFingerprint: "f".repeat(64)
    },
    compatibility: { version: 1, state: "current" }
  });
}

async function inCoordinatorWorkspace<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation);
}

// Planned-submit fixtures require POSIX trusted workspace anchors.
describe.skipIf(process.platform === "win32")("MotionJobCoordinator planned submit", () => {
  it("binds one planned submission before its event and replays concurrent identical calls without a second execution", async () => {
    const { jobs, renderPlans, root } = await coordinator();
    const plan = renderPlan();
    let executions = 0;
    let entered!: () => void;
    const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let markRunning!: () => void;
    const mayMarkRunning = new Promise<void>((resolve) => { markRunning = resolve; });
    let running!: () => void;
    const executionRunning = new Promise<void>((resolve) => { running = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const input = {
      jobId: "cut:planned-concurrent", callerId: "cut:workspace", lane: "ffmpeg", frameLane: "gpu" as const,
      operation: "render.final", renderPlan: plan,
      submissionData: { renderPlan: { output: { intentSha256: "must-not-appear" } }, hostBinding: "v1" },
      execute: async () => {
        executions += 1;
        entered();
        await mayMarkRunning;
        await currentMotionHostJob()?.markRunning();
        running();
        await released;
        return { ok: true };
      }
    };

    const [first, second] = await inCoordinatorWorkspace(root, async () => await Promise.all([jobs.submit(input), jobs.submit(input)]));
    expect([first, second].filter((answer) => answer.ok && answer.value.replayed !== true)).toHaveLength(1);
    expect([first, second].filter((answer) => answer.ok && answer.value.replayed === true)).toHaveLength(1);
    await executionEntered;
    expect(executions).toBe(1);
    await expect(inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: input.jobId, callerId: input.callerId })))
      .resolves.toMatchObject({ ok: true, job: { lifecycle: "pending", planFingerprint: plan.fingerprint } });
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.read({ callerId: input.callerId, jobId: input.jobId })))
      .resolves.toMatchObject({ ok: true, plan: { fingerprint: plan.fingerprint } });
    markRunning();
    await executionRunning;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: input.jobId, callerId: input.callerId })))
      .resolves.toMatchObject({ ok: true, job: { lifecycle: "running", planFingerprint: plan.fingerprint } });
    const events = await inCoordinatorWorkspace(root, async () => await jobs.events({ jobId: input.jobId, callerId: input.callerId }));
    if (!events.ok) throw new Error("planned events unavailable");
    expect(events.value.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "submitted", data: expect.objectContaining({
        frameLane: "gpu", hostBinding: "v1", renderPlan: { schema: plan.schema, fingerprint: plan.fingerprint }
      })
    })]));
    const submitted = events.value.events[0]!;
    expect(Object.keys((submitted.data?.renderPlan ?? {}) as Record<string, unknown>).sort()).toEqual(["fingerprint", "schema"]);
    expect(JSON.stringify(submitted)).not.toContain("intentSha256");
    release();
    const terminal = await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: input.jobId, callerId: input.callerId })),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    expect(terminal).toMatchObject({ ok: true, job: { lifecycle: "ended", planFingerprint: plan.fingerprint } });
  });

  it("refuses a changed or orphaned plan without executing, while keeping owner-qualified ids independent", async () => {
    const { jobs, renderPlans, root } = await coordinator();
    const jobId = "host:planned-owner-qualified";
    const original = renderPlan();
    const changed = renderPlan("d".repeat(64));
    let calls = 0;
    const submit = async (callerId: string, plan: MotionRenderPlan) => await inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => { calls += 1; return { ok: true }; }
    }));

    await expect(submit("cut:workspace-a", original)).resolves.toMatchObject({ ok: true, value: { jobId } });
    await expect(submit("design-studio:workspace-b", original)).resolves.toMatchObject({ ok: true, value: { jobId } });
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId, callerId: "cut:workspace-a" })),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId, callerId: "design-studio:workspace-b" })),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    expect(calls).toBe(2);
    const beforeReplay = await inCoordinatorWorkspace(root, async () => await jobs.events({ jobId, callerId: "cut:workspace-a" }));
    await expect(submit("cut:workspace-a", original)).resolves.toMatchObject({ ok: true, value: { jobId, replayed: true } });
    const afterReplay = await inCoordinatorWorkspace(root, async () => await jobs.events({ jobId, callerId: "cut:workspace-a" }));
    expect(afterReplay).toEqual(beforeReplay);
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId: "cut:workspace-a", lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      execute: async () => { calls += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    await expect(submit("cut:workspace-a", changed)).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    expect(calls).toBe(2);

    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.bind({ callerId: "cut:orphan", jobId: "cut:planned-orphan", plan: original })))
      .resolves.toMatchObject({ ok: true, replayed: false });
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId: "cut:planned-orphan", callerId: "cut:orphan", lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: original,
      execute: async () => { calls += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
    expect(calls).toBe(2);
  });

  it("refuses a planless submit for an orphaned durable plan binding without executing", async () => {
    const { jobs, renderPlans, root } = await coordinator();
    const callerId = "cut:orphan";
    const jobId = "cut:planned-orphan-planless";
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.bind({ callerId, jobId, plan: renderPlan() })))
      .resolves.toMatchObject({ ok: true, replayed: false });
    let executions = 0;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    expect(executions).toBe(0);
  });

  it("releases a new claim after deterministic admission conflicts so the stored class can still proceed", async () => {
    const { jobs, renderAdmissions, root } = await coordinator();
    const callerId = "cut:admission-conflict-release";
    const plannedJobId = "cut:orphan-admission-planned";
    const planned = renderPlan();
    const wrong = renderPlan("d".repeat(64));
    let executions = 0;
    await expect(inCoordinatorWorkspace(root, async () => await renderAdmissions.bind({
      callerId, jobId: plannedJobId, admission: { mode: "planned", planFingerprint: planned.fingerprint }
    }))).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId: plannedJobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: wrong,
      execute: async () => { executions += 100; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId: plannedJobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: planned,
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: true, value: { jobId: plannedJobId } });
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: plannedJobId, callerId })),
      (result) => result.ok && result.job.state === "succeeded"
    );

    const planlessJobId = "cut:orphan-admission-planless";
    await expect(inCoordinatorWorkspace(root, async () => await renderAdmissions.bind({
      callerId, jobId: planlessJobId, admission: { mode: "planned", planFingerprint: planned.fingerprint }
    }))).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId: planlessJobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      execute: async () => { executions += 100; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId: planlessJobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: planned,
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: true, value: { jobId: planlessJobId } });
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: planlessJobId, callerId })),
      (result) => result.ok && result.job.state === "succeeded"
    );
    expect(executions).toBe(2);
  });

  it("fails closed for an invalid same-owner plan binding before planless execution", async () => {
    const { jobs, renderPlans, root } = await coordinator();
    const callerId = "cut:invalid-planless";
    const jobId = "cut:planned-invalid-planless";
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.bind({ callerId, jobId, plan: renderPlan() })))
      .resolves.toMatchObject({ ok: true, replayed: false });
    await writeFile(join(root, "render-plans", motionRenderPlanBindingFileName(callerId, jobId)), "{not-json}");
    let executions = 0;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_plan_invalid" });
    expect(executions).toBe(0);
  });

  it("returns capability_unavailable when the plan-store root is unreadable before planless execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-planless-store-unreadable-"));
    const target = await mkdtemp(join(tmpdir(), "shellx-motion-planless-store-target-"));
    roots.push(root, target);
    await symlink(target, join(root, "render-plans"), "dir");
    const jobs = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot: join(root, "events"),
      renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "render-plans") }),
      renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") })
    });
    let executions = 0;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId: "cut:planless-unreadable-store", callerId: "cut:workspace", lane: "ffmpeg", operation: "render.final",
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(executions).toBe(0);
  });

  it("never binds a plan when it loses a paused planless reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-planless-first-race-"));
    roots.push(root);
    const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const renderPlans = new MotionRenderPlanStore({ planRoot: join(root, "render-plans") });
    const jobs = new MotionJobCoordinator({ leases, records: new MotionJobRegistry({ recordRoot: join(root, "records") }), eventsRoot: join(root, "events"), renderPlans, renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") }) });
    let announced!: () => void;
    const announcementPaused = new Promise<void>((resolve) => { announced = resolve; });
    let releaseAnnouncement!: () => void;
    const announcementReleased = new Promise<void>((resolve) => { releaseAnnouncement = resolve; });
    const announce = leases.announce.bind(leases);
    let pauseFirstAnnouncement = true;
    vi.spyOn(leases, "announce").mockImplementation(async (input) => {
      if (pauseFirstAnnouncement) {
        pauseFirstAnnouncement = false;
        announced();
        await announcementReleased;
      }
      return await announce(input);
    });
    const callerId = "cut:cross-mode";
    const jobId = "cut:planless-first-race";
    let planlessExecutions = 0;
    let plannedExecutions = 0;
    const planless = inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      execute: async () => { planlessExecutions += 1; return { ok: true }; }
    }));
    await announcementPaused;
    const planned = inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: renderPlan(),
      execute: async () => { plannedExecutions += 1; return { ok: true }; }
    }));
    releaseAnnouncement();
    await expect(planless).resolves.toMatchObject({ ok: true, value: { jobId } });
    await expect(planned).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    const completed = await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId, callerId })),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    if (!completed.ok) throw new Error("planless job was not visible");
    expect(completed.job.planFingerprint).toBeUndefined();
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.read({ callerId, jobId }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
    expect(planlessExecutions).toBe(1);
    expect(plannedExecutions).toBe(0);
  });

  it("keeps the planned binding when planless loses the paused planned reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-planned-first-race-"));
    roots.push(root);
    const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const renderPlans = new MotionRenderPlanStore({ planRoot: join(root, "render-plans") });
    const jobs = new MotionJobCoordinator({ leases, records: new MotionJobRegistry({ recordRoot: join(root, "records") }), eventsRoot: join(root, "events"), renderPlans, renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") }) });
    let announced!: () => void;
    const announcementPaused = new Promise<void>((resolve) => { announced = resolve; });
    let releaseAnnouncement!: () => void;
    const announcementReleased = new Promise<void>((resolve) => { releaseAnnouncement = resolve; });
    const announce = leases.announce.bind(leases);
    let pauseFirstAnnouncement = true;
    vi.spyOn(leases, "announce").mockImplementation(async (input) => {
      if (pauseFirstAnnouncement) {
        pauseFirstAnnouncement = false;
        announced();
        await announcementReleased;
      }
      return await announce(input);
    });
    const callerId = "cut:cross-mode";
    const jobId = "cut:planned-first-race";
    const plan = renderPlan();
    let planlessExecutions = 0;
    let plannedExecutions = 0;
    const planned = inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => { plannedExecutions += 1; return { ok: true }; }
    }));
    await announcementPaused;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      execute: async () => { planlessExecutions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    releaseAnnouncement();
    await expect(planned).resolves.toMatchObject({ ok: true, value: { jobId } });
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId, callerId })),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.read({ callerId, jobId })))
      .resolves.toMatchObject({ ok: true, plan: { fingerprint: plan.fingerprint } });
    expect(plannedExecutions).toBe(1);
    expect(planlessExecutions).toBe(0);
  });

  it("rejects operation, delivery lane, and frame-lane mismatches before a plan can bind or execute", async () => {
    const { jobs, renderPlans, root } = await coordinator();
    const plan = renderPlan();
    let executions = 0;
    const mismatches = [
      { jobId: "cut:planned-operation-mismatch", operation: "connector.unrelated@1", lane: "ffmpeg", frameLane: "gpu" as const },
      { jobId: "cut:planned-lane-mismatch", operation: "render.final", lane: "connector", frameLane: "gpu" as const },
      { jobId: "cut:planned-frame-lane-mismatch", operation: "render.final", lane: "ffmpeg", frameLane: "browser" as const }
    ];

    for (const mismatch of mismatches) {
      await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
        ...mismatch, callerId: "cut:workspace", renderPlan: plan,
        execute: async () => { executions += 1; return { ok: true }; }
      }))).resolves.toMatchObject({ ok: false, code: "job_plan_invalid" });
      await expect(inCoordinatorWorkspace(root, async () => await renderPlans.read({ callerId: "cut:workspace", jobId: mismatch.jobId })))
        .resolves.toEqual({ ok: false, code: "plan_unknown" });
    }
    expect(executions).toBe(0);
  });

  it("refuses an exact stored-plan replay when accepted status carries another plan fingerprint", async () => {
    const { jobs, records, renderPlans, root } = await coordinator();
    const jobId = "cut:planned-status-fingerprint-conflict";
    const callerId = "cut:workspace";
    const plan = renderPlan();
    const otherPlan = renderPlan("d".repeat(64));
    const endedAtMs = Date.now();
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.bind({ callerId, jobId, plan })))
      .resolves.toMatchObject({ ok: true, replayed: false });
    await inCoordinatorWorkspace(root, async () => await records.record({
      schema: "shellx-motion/job-record@1", jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      planFingerprint: otherPlan.fingerprint, lifecycle: "ended", outcome: "succeeded",
      createdAtMs: endedAtMs - 2, startedAtMs: endedAtMs - 1, endedAtMs, durationMs: 2, queueWaitMs: 1, warnings: []
    }));
    let executions = 0;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    expect(executions).toBe(0);
  });

  it("never fills missing immutable facts beside an accepted planned status", async () => {
    const { jobs, records, renderPlans, renderAdmissions, root } = await coordinator();
    const jobId = "cut:planned-missing-facts";
    const callerId = "cut:workspace";
    const plan = renderPlan();
    const endedAtMs = Date.now();
    await inCoordinatorWorkspace(root, async () => await records.record({
      schema: "shellx-motion/job-record@1", jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final",
      planFingerprint: plan.fingerprint, lifecycle: "ended", outcome: "succeeded",
      createdAtMs: endedAtMs - 2, startedAtMs: endedAtMs - 1, endedAtMs, durationMs: 2, queueWaitMs: 1, warnings: []
    }));
    let executions = 0;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.read({ callerId, jobId }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
    await expect(inCoordinatorWorkspace(root, async () => await renderAdmissions.read({ callerId, jobId }))).resolves.toEqual({ ok: false, code: "admission_unknown" });
    expect(executions).toBe(0);
  });

  it("refuses a dead executing planned claim without recovery or execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-planned-dead-claim-"));
    roots.push(root);
    const claimsRoot = join(root, "job-identity-claims");
    const deadOwner = new MotionJobIdentityClaimStore({ claimRoot: claimsRoot, pid: 41_001, isProcessAlive: () => false });
    const callerId = "cut:workspace";
    const jobId = "cut:planned-dead-executing";
    const plan = renderPlan();
    const held = await inCoordinatorWorkspace(root, async () => await deadOwner.acquire({
      callerId, jobId, admission: { mode: "planned", planFingerprint: plan.fingerprint }
    }));
    if (!held.ok) throw new Error("Could not seed dead executing claim.");
    await expect(held.handle.advance("admission_bound")).resolves.toMatchObject({ ok: true });
    await expect(held.handle.advance("plan_bound")).resolves.toMatchObject({ ok: true });
    await expect(held.handle.advance("host_lease_published")).resolves.toMatchObject({ ok: true });
    await expect(held.handle.advance("submitted")).resolves.toMatchObject({ ok: true });
    await expect(held.handle.advance("executing")).resolves.toMatchObject({ ok: true });
    const recoveryRefusingClaims = new MotionJobIdentityClaimStore({ claimRoot: claimsRoot, pid: 41_002, isProcessAlive: () => false });
    const jobs = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }), records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot: join(root, "events"), renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "render-plans") }),
      renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") }), identityClaims: recoveryRefusingClaims
    });
    let executions = 0;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => { executions += 1; return { ok: true }; }
    }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
    expect(executions).toBe(0);
  });

  it("requires terminal proof after a peer coordinator releases its held planned claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-planned-peer-"));
    roots.push(root);
    const planRoot = join(root, "render-plans");
    const admissionRoot = join(root, "render-admissions");
    const leasesA = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const leasesB = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const recordsA = new MotionJobRegistry({ recordRoot: join(root, "records") });
    const recordsB = new MotionJobRegistry({ recordRoot: join(root, "records") });
    const first = new MotionJobCoordinator({
      leases: leasesA, records: recordsA, eventsRoot: join(root, "events"), renderPlans: new MotionRenderPlanStore({ planRoot }), renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot })
    });
    const second = new MotionJobCoordinator({
      leases: leasesB, records: recordsB, eventsRoot: join(root, "events"), renderPlans: new MotionRenderPlanStore({ planRoot }), renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot })
    });
    let announceEntered!: () => void;
    const firstAnnounceEntered = new Promise<void>((resolve) => { announceEntered = resolve; });
    let releaseAnnounce!: () => void;
    const mayAnnounce = new Promise<void>((resolve) => { releaseAnnounce = resolve; });
    const announce = leasesA.announce.bind(leasesA);
    let pauseFirstAnnounce = true;
    vi.spyOn(leasesA, "announce").mockImplementation(async (input) => {
      if (pauseFirstAnnounce) {
        pauseFirstAnnounce = false;
        announceEntered();
        await mayAnnounce;
      }
      return await announce(input);
    });
    const plan = renderPlan();
    let executions = 0;
    let executionEntered!: () => void;
    const entered = new Promise<void>((resolve) => { executionEntered = resolve; });
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const input = {
      jobId: "cut:planned-peer-race", callerId: "cut:workspace", lane: "ffmpeg", frameLane: "gpu" as const,
      operation: "render.final", renderPlan: plan,
      execute: async () => { executions += 1; executionEntered(); await executionReleased; return { ok: true }; }
    };

    const firstSubmit = inCoordinatorWorkspace(root, async () => await first.submit(input));
    await firstAnnounceEntered;
    const secondSubmit = inCoordinatorWorkspace(root, async () => await second.submit(input));
    releaseAnnounce();
    const accepted = await firstSubmit;
    expect(accepted).toMatchObject({ ok: true, value: { jobId: input.jobId } });
    await entered;
    await expect(secondSubmit).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
    expect(executions).toBe(1);
    releaseExecution();
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await second.jobView().get({ jobId: input.jobId, callerId: input.callerId })),
      (result) => result.ok && result.job.state === "succeeded"
    );
    await expect(inCoordinatorWorkspace(root, async () => await second.submit(input)))
      .resolves.toMatchObject({ ok: true, value: { jobId: input.jobId, replayed: true } });
  });

  it("retains execution receipt and producer mirrors when a planned job settles cancelled", async () => {
    const { jobs, root } = await coordinator();
    let entered!: () => void;
    const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
    const jobId = "cut:planned-cancelled-mirrors";
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId, callerId: "cut:workspace", lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: renderPlan(),
      execute: async (signal) => await new Promise((resolve) => {
        entered();
        signal.addEventListener("abort", () => resolve({
          ok: false,
          receiptId: "planned-cancelled-receipt",
          producerEvidence: { frameLane: "gpu" as const, schema: "shellx-motion/gpu-streaming-producer@1" }
        }), { once: true });
      })
    }))).resolves.toMatchObject({ ok: true, value: { jobId } });
    await executionEntered;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.cancel({ jobId, callerId: "cut:workspace", reason: "operator stopped export" })))
      .resolves.toMatchObject({ ok: true });
    const status = await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId, callerId: "cut:workspace" })),
      (answer) => answer.ok && answer.job.state === "cancelled"
    );
    expect(status).toMatchObject({ ok: true, job: {
      receiptId: "planned-cancelled-receipt",
      producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" },
      cancellation: { requestedBy: "cut:workspace", reason: "operator stopped export" }
    } });
  });

  it("preserves planless active-id behavior when the durable plan store proves no binding", async () => {
    const { jobs, renderPlans, root } = await coordinator();
    let entered!: () => void;
    const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const input = {
      jobId: "cut:legacy-without-plan", callerId: "cut:workspace", lane: "ffmpeg", operation: "render.final",
      execute: async () => { entered(); await released; return { ok: true }; }
    };
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit(input))).resolves.toMatchObject({ ok: true, value: { jobId: input.jobId } });
    await executionEntered;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit(input))).resolves.toMatchObject({ ok: false, code: "job_not_terminal" });
    await expect(inCoordinatorWorkspace(root, async () => await renderPlans.read({ callerId: input.callerId, jobId: input.jobId })))
      .resolves.toEqual({ ok: false, code: "plan_unknown" });
    release();
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: input.jobId, callerId: input.callerId })),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
  });

  it("retries a retryable planned job under a distinct id with the exact retained plan", async () => {
    const { jobs, renderPlans, root } = await coordinator();
    const plan = renderPlan();
    let calls = 0;
    await expect(inCoordinatorWorkspace(root, async () => await jobs.submit({
      jobId: "cut:planned-retry-source", callerId: "cut:workspace", lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => (++calls === 1
        ? {
            ok: false, receiptId: "planned-retry-source-receipt",
            producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" },
            error: { code: "job_queue_timeout", message: "busy", retryable: true }
          }
        : { ok: true })
    }))).resolves.toMatchObject({ ok: true, value: { jobId: "cut:planned-retry-source" } });
    const sourceStatus = await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: "cut:planned-retry-source", callerId: "cut:workspace" })),
      (answer) => answer.ok && answer.job.state === "failed"
    );
    expect(sourceStatus).toMatchObject({ ok: true, job: {
      receiptId: "planned-retry-source-receipt",
      producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" }
    } });
    await expect(inCoordinatorWorkspace(root, async () => await jobs.retry({ jobId: "cut:planned-retry-source", callerId: "cut:workspace", newJobId: "cut:planned-retry-next" })))
      .resolves.toMatchObject({ ok: true, value: { jobId: "cut:planned-retry-next", priorJobId: "cut:planned-retry-source" } });
    await eventually(
      async () => await inCoordinatorWorkspace(root, async () => await jobs.jobView().get({ jobId: "cut:planned-retry-next", callerId: "cut:workspace" })),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    const [source, retry] = await inCoordinatorWorkspace(root, async () => await Promise.all([
      renderPlans.read({ callerId: "cut:workspace", jobId: "cut:planned-retry-source" }),
      renderPlans.read({ callerId: "cut:workspace", jobId: "cut:planned-retry-next" })
    ]));
    expect(source).toMatchObject({ ok: true, plan: { fingerprint: plan.fingerprint } });
    expect(retry).toMatchObject({ ok: true, plan: { fingerprint: plan.fingerprint } });
    expect(calls).toBe(2);
  });
});
