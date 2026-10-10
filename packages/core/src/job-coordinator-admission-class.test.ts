import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionJobCoordinator } from "./job-coordinator";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { createMotionRenderPlan, type MotionRenderPlan } from "./render-plan";
import { motionRenderAdmissionFileName, MotionRenderAdmissionStore } from "./render-admission-store";
import { MotionRenderPlanStore } from "./render-plan-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function workspace<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation);
}

async function settleSuccessfulJob(root: string, jobs: MotionJobCoordinator, callerId: string, jobId: string): Promise<void> {
  // `submit` returns after durable submission. On a known successful job, `retry` is an exact
  // completion fence: it awaits settlement, then returns nonretryable without starting new work.
  await expect(workspace(root, async () => await jobs.retry({ jobId, callerId })))
    .resolves.toMatchObject({ ok: false, code: "job_not_retryable" });
  await expect(workspace(root, async () => await jobs.jobView().get({ jobId, callerId })))
    .resolves.toMatchObject({ ok: true, job: { state: "succeeded" } });
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for admission-class state.");
}

function plan(intentSha256 = "c".repeat(64)): MotionRenderPlan {
  const manifestSha256 = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  return createMotionRenderPlan({
    package: { id: "pkg_demo", manifestSha256 }, motion: { id: "motion_demo", documentSha256 },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256, motionSha256: documentSha256 },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256 }, quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: { engine: "ffmpeg@7.1", routeFingerprint: "d".repeat(64), presetFingerprint: "e".repeat(64), capabilityFingerprint: "f".repeat(64) },
    compatibility: { version: 1, state: "current" }
  });
}

function coordinator(root: string, admissions = new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") })) {
  const plans = new MotionRenderPlanStore({ planRoot: join(root, "render-plans") });
  const jobs = new MotionJobCoordinator({
    leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
    records: new MotionJobRegistry({ recordRoot: join(root, "records") }), eventsRoot: join(root, "events"),
    renderPlans: plans, renderAdmissions: admissions
  });
  return { jobs, plans, admissions };
}

describe("MotionJobCoordinator durable admission class", () => {
  it("allows a legacy-planless class replay but never lets that id switch to planned", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admission-replay-"));
    roots.push(root);
    const { jobs, plans, admissions } = coordinator(root);
    const callerId = "cut:legacy-replay";
    const jobId = "cut:legacy-class";
    let executions = 0;
    const legacy = { jobId, callerId, lane: "ffmpeg", frameLane: "gpu" as const, operation: "render.final", execute: async () => { executions += 1; return { ok: true }; } };
    await expect(workspace(root, async () => await jobs.submit(legacy))).resolves.toMatchObject({ ok: true, value: { jobId } });
    await eventually(async () => executions, (value) => value === 1);
    await settleSuccessfulJob(root, jobs, callerId, jobId);
    await expect(workspace(root, async () => await jobs.submit(legacy))).resolves.toMatchObject({ ok: true, value: { jobId } });
    await eventually(async () => executions, (value) => value === 2);
    await settleSuccessfulJob(root, jobs, callerId, jobId);
    await expect(workspace(root, async () => await jobs.submit({ ...legacy, renderPlan: plan(), execute: async () => ({ ok: true }) })))
      .resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    await expect(workspace(root, async () => await admissions.read({ callerId, jobId })))
      .resolves.toEqual({ ok: true, admission: { mode: "legacy-planless" } });
    await expect(workspace(root, async () => await plans.read({ callerId, jobId }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
  });

  it("fails closed on corrupt and unreadable admission classes before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admission-invalid-"));
    const target = await mkdtemp(join(tmpdir(), "shellx-motion-admission-target-"));
    roots.push(root, target);
    const callerId = "cut:admission-invalid";
    const jobId = "cut:admission-invalid";
    const { jobs } = coordinator(root);
    const admissionsRoot = join(root, "render-admissions");
    await workspace(root, async () => await new MotionRenderAdmissionStore({ admissionRoot: admissionsRoot }).bind({ callerId, jobId, admission: { mode: "legacy-planless" } }));
    await writeFile(join(admissionsRoot, motionRenderAdmissionFileName(callerId, jobId)), "{not-json}");
    let executions = 0;
    await expect(workspace(root, async () => await jobs.submit({ jobId, callerId, lane: "ffmpeg", operation: "render.final", execute: async () => { executions += 1; return { ok: true }; } })))
      .resolves.toMatchObject({ ok: false, code: "job_plan_invalid" });
    const unsafe = join(root, "unsafe-admissions");
    await symlink(target, unsafe, "dir");
    const unsafeJobs = coordinator(root, new MotionRenderAdmissionStore({ admissionRoot: unsafe })).jobs;
    await expect(workspace(root, async () => await unsafeJobs.submit({ jobId: "cut:admission-unreadable", callerId, lane: "ffmpeg", operation: "render.final", execute: async () => { executions += 1; return { ok: true }; } })))
      .resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(executions).toBe(0);
  });

  it("keeps a paused cross-process planless admission exclusive of planned", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admission-planless-first-"));
    roots.push(root);
    const admissionsA = new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") });
    const first = coordinator(root, admissionsA);
    const second = coordinator(root, new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") }));
    const bind = admissionsA.bind.bind(admissionsA);
    let bound!: () => void;
    const classBound = new Promise<void>((resolve) => { bound = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(admissionsA, "bind").mockImplementation(async (input) => { const result = await bind(input); bound(); await released; return result; });
    const callerId = "cut:cross-class";
    const jobId = "cut:planless-first";
    let firstExecutions = 0;
    let secondExecutions = 0;
    const winner = workspace(root, async () => await first.jobs.submit({ jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", execute: async () => { firstExecutions += 1; return { ok: true }; } }));
    await classBound;
    await expect(workspace(root, async () => await second.jobs.submit({ jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan(), execute: async () => { secondExecutions += 1; return { ok: true }; } })))
      .resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    release();
    await expect(winner).resolves.toMatchObject({ ok: true, value: { jobId } });
    await eventually(async () => firstExecutions, (value) => value === 1);
    await settleSuccessfulJob(root, first.jobs, callerId, jobId);
    await expect(workspace(root, async () => await first.admissions.read({ callerId, jobId }))).resolves.toEqual({ ok: true, admission: { mode: "legacy-planless" } });
    await expect(workspace(root, async () => await first.plans.read({ callerId, jobId }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
    expect(secondExecutions).toBe(0);
  });

  it("keeps a paused cross-process planned admission exclusive of planless", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admission-planned-first-"));
    roots.push(root);
    const admissionsA = new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") });
    const first = coordinator(root, admissionsA);
    const second = coordinator(root, new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") }));
    const bind = admissionsA.bind.bind(admissionsA);
    let bound!: () => void;
    const classBound = new Promise<void>((resolve) => { bound = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(admissionsA, "bind").mockImplementation(async (input) => { const result = await bind(input); bound(); await released; return result; });
    const callerId = "cut:cross-class";
    const jobId = "cut:planned-first";
    const retainedPlan = plan();
    let firstExecutions = 0;
    let secondExecutions = 0;
    const winner = workspace(root, async () => await first.jobs.submit({ jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: retainedPlan, execute: async () => { firstExecutions += 1; return { ok: true }; } }));
    await classBound;
    await expect(workspace(root, async () => await second.jobs.submit({ jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", execute: async () => { secondExecutions += 1; return { ok: true }; } })))
      .resolves.toMatchObject({ ok: false, code: "job_id_conflict" });
    release();
    await expect(winner).resolves.toMatchObject({ ok: true, value: { jobId } });
    await eventually(async () => firstExecutions, (value) => value === 1);
    await settleSuccessfulJob(root, first.jobs, callerId, jobId);
    await expect(workspace(root, async () => await first.admissions.read({ callerId, jobId })))
      .resolves.toEqual({ ok: true, admission: { mode: "planned", planFingerprint: retainedPlan.fingerprint } });
    await expect(workspace(root, async () => await first.plans.read({ callerId, jobId })))
      .resolves.toMatchObject({ ok: true, plan: { fingerprint: retainedPlan.fingerprint } });
    expect(secondExecutions).toBe(0);
  });

  it("lets only one sibling coordinator execute a planless same-id submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admission-planless-peer-"));
    roots.push(root);
    const firstLeases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const first = new MotionJobCoordinator({
      leases: firstLeases, records: new MotionJobRegistry({ recordRoot: join(root, "records") }), eventsRoot: join(root, "events"),
      renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "render-plans") }), renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") })
    });
    const second = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }), records: new MotionJobRegistry({ recordRoot: join(root, "records") }), eventsRoot: join(root, "events"),
      renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "render-plans") }), renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") })
    });
    const announce = firstLeases.announce.bind(firstLeases);
    let announcePaused!: () => void;
    const paused = new Promise<void>((resolve) => { announcePaused = resolve; });
    let releaseAnnounce!: () => void;
    const released = new Promise<void>((resolve) => { releaseAnnounce = resolve; });
    vi.spyOn(firstLeases, "announce").mockImplementation(async (input) => {
      announcePaused();
      await released;
      return await announce(input);
    });
    const input = {
      jobId: "cut:planless-peer", callerId: "cut:workspace", lane: "ffmpeg", frameLane: "gpu" as const, operation: "render.final"
    };
    let firstExecutions = 0;
    let secondExecutions = 0;
    const firstSubmit = workspace(root, async () => await first.submit({ ...input, execute: async () => { firstExecutions += 1; return { ok: true }; } }));
    await paused;
    const secondSubmit = workspace(root, async () => await second.submit({ ...input, execute: async () => { secondExecutions += 1; return { ok: true }; } }));
    releaseAnnounce();
    await expect(firstSubmit).resolves.toMatchObject({ ok: true, value: { jobId: input.jobId } });
    await expect(secondSubmit).resolves.toMatchObject({ ok: false, code: "job_not_terminal" });
    await eventually(async () => firstExecutions, (value) => value === 1);
    await settleSuccessfulJob(root, first, input.callerId, input.jobId);
    expect(secondExecutions).toBe(0);
  });
});
