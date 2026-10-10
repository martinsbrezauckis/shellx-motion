import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionJobCoordinator } from "./job-coordinator";
import { MotionJobEventStore } from "./job-event-store";
import { MotionJobIdentityClaimHandle, MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { createMotionRenderPlan, type MotionRenderPlan } from "./render-plan";
import { MotionRenderAdmissionStore } from "./render-admission-store";
import { MotionRenderPlanStore } from "./render-plan-store";

const roots: string[] = [];
const CALLER_ID = "cut:settling-race";

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("MotionJobCoordinator settling claim", () => {
  it("never replays a sibling when durable settlement advance is unavailable and its executing claim's capacity release is paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-settling-advance-race-"));
    roots.push(root);
    const leasesA = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const leasesB = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const claimsA = new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") });
    const claimsB = new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") });
    const plansRoot = join(root, "render-plans");
    const admissionsRoot = join(root, "render-admissions");
    const eventsRoot = join(root, "events");
    const first = coordinator(root, leasesA, claimsA, plansRoot, admissionsRoot, eventsRoot);
    const second = coordinator(root, leasesB, claimsB, plansRoot, admissionsRoot, eventsRoot);
    const jobId = "cut:settling-advance-unavailable";
    const plan = renderPlan();
    const advance = MotionJobIdentityClaimHandle.prototype.advance;
    const advanceSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "advance").mockImplementation(async function (this: MotionJobIdentityClaimHandle, phase) {
      return phase === "settling" ? { ok: false, code: "claim_unavailable" } : await advance.call(this, phase);
    });
    const release = leasesA.release.bind(leasesA);
    let releaseEntered!: () => void;
    const releasePaused = new Promise<void>((resolve) => { releaseEntered = resolve; });
    let allowRelease!: () => void;
    const releaseAllowed = new Promise<void>((resolve) => { allowRelease = resolve; });
    const releaseSpy = vi.spyOn(leasesA, "release").mockImplementation(async (run) => {
      releaseEntered();
      await releaseAllowed;
      await release(run);
    });
    let firstExecutions = 0;
    let peerExecutions = 0;
    const input = {
      jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu" as const, operation: "render.final", renderPlan: plan
    };
    try {
      await expect(inWorkspace(root, async () => await first.submit({
        ...input,
        execute: async () => {
          firstExecutions += 1;
          return { ok: false, error: { code: "job_queue_timeout", message: "settlement advance unavailable", retryable: true } };
        }
      }))).resolves.toMatchObject({ ok: true, value: { jobId } });
      await releasePaused;
      await expect(inWorkspace(root, async () => await claimsB.acquire({
        callerId: CALLER_ID, jobId, admission: { mode: "planned", planFingerprint: plan.fingerprint }
      }))).resolves.toMatchObject({ ok: false, code: "claim_held", claim: { phase: "executing" } });
      await expect(inWorkspace(root, async () => await second.jobView().get({ jobId, callerId: CALLER_ID })))
        .resolves.toMatchObject({ ok: true, job: { state: "pending", planFingerprint: plan.fingerprint } });

      await expect(inWorkspace(root, async () => await second.submit({
        ...input,
        execute: async () => { peerExecutions += 1; return { ok: true }; }
      }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
      expect(firstExecutions).toBe(1);
      expect(peerExecutions).toBe(0);

      allowRelease();
      await eventually(async () => await inWorkspace(root, async () => await leasesA.readLiveLeases()), (leases) => leases.length === 0);
      await expect(inWorkspace(root, async () => await first.jobView().get({ jobId, callerId: CALLER_ID })))
        .resolves.toEqual({ ok: false, code: "job_unknown" });
      await expect(inWorkspace(root, async () => await claimsB.acquire({
        callerId: CALLER_ID, jobId, admission: { mode: "planned", planFingerprint: plan.fingerprint }
      }))).resolves.toMatchObject({ ok: false, code: "claim_held", claim: { phase: "executing" } });
    } finally {
      allowRelease?.();
      releaseSpy.mockRestore();
      advanceSpy.mockRestore();
    }
  });

  it("never replays a sibling during failed terminal-event settlement while its pending lease release is paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-settling-race-"));
    roots.push(root);
    const leasesA = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const leasesB = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const claimsA = new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") });
    const claimsB = new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") });
    const plansRoot = join(root, "render-plans");
    const admissionsRoot = join(root, "render-admissions");
    const eventsRoot = join(root, "events");
    const first = coordinator(root, leasesA, claimsA, plansRoot, admissionsRoot, eventsRoot);
    const second = coordinator(root, leasesB, claimsB, plansRoot, admissionsRoot, eventsRoot);
    const jobId = "cut:settling-event-failure";
    const plan = renderPlan();
    const write = MotionJobEventStore.prototype.write;
    const writeSpy = vi.spyOn(MotionJobEventStore.prototype, "write").mockImplementation(async function (this: MotionJobEventStore, input) {
      if (input.jobId === jobId && input.events.at(-1)?.type === "failed") throw new Error("terminal event storage offline");
      await write.call(this, input);
    });
    const release = leasesA.release.bind(leasesA);
    let releaseEntered!: () => void;
    const releasePaused = new Promise<void>((resolve) => { releaseEntered = resolve; });
    let allowRelease!: () => void;
    const releaseAllowed = new Promise<void>((resolve) => { allowRelease = resolve; });
    const releaseSpy = vi.spyOn(leasesA, "release").mockImplementation(async (run) => {
      releaseEntered();
      await releaseAllowed;
      await release(run);
    });
    let firstExecutions = 0;
    let peerExecutions = 0;
    const input = {
      jobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu" as const, operation: "render.final", renderPlan: plan
    };
    try {
      await expect(inWorkspace(root, async () => await first.submit({
        ...input,
        execute: async () => {
          firstExecutions += 1;
          return { ok: false, error: { code: "job_queue_timeout", message: "terminal event failure", retryable: true } };
        }
      }))).resolves.toMatchObject({ ok: true, value: { jobId } });
      await releasePaused;
      await expect(inWorkspace(root, async () => await second.jobView().get({ jobId, callerId: CALLER_ID })))
        .resolves.toMatchObject({ ok: true, job: { state: "pending", planFingerprint: plan.fingerprint } });
      await expect(inWorkspace(root, async () => await claimsB.acquire({
        callerId: CALLER_ID, jobId, admission: { mode: "planned", planFingerprint: plan.fingerprint }
      }))).resolves.toMatchObject({ ok: false, code: "claim_held", claim: { phase: "settling" } });

      await expect(inWorkspace(root, async () => await second.submit({
        ...input,
        execute: async () => { peerExecutions += 1; return { ok: true }; }
      }))).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
      expect(firstExecutions).toBe(1);
      expect(peerExecutions).toBe(0);

      allowRelease();
      await eventually(async () => await inWorkspace(root, async () => await leasesA.readLiveLeases()), (leases) => leases.length === 0);
      await expect(inWorkspace(root, async () => await first.jobView().get({ jobId, callerId: CALLER_ID })))
        .resolves.toEqual({ ok: false, code: "job_unknown" });
      await expect(inWorkspace(root, async () => await claimsB.acquire({
        callerId: CALLER_ID, jobId, admission: { mode: "planned", planFingerprint: plan.fingerprint }
      }))).resolves.toMatchObject({ ok: false, code: "claim_held", claim: { phase: "settling" } });
    } finally {
      allowRelease?.();
      releaseSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});

function coordinator(root: string, leases: MotionJobLeaseDirectory, claims: MotionJobIdentityClaimStore, planRoot: string, admissionRoot: string, eventsRoot: string): MotionJobCoordinator {
  return new MotionJobCoordinator({
    leases, records: new MotionJobRegistry({ recordRoot: join(root, "records") }), eventsRoot,
    renderPlans: new MotionRenderPlanStore({ planRoot }), renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot }), identityClaims: claims
  });
}

function renderPlan(): MotionRenderPlan {
  const manifestSha256 = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  return createMotionRenderPlan({
    package: { id: "pkg_settling_race", manifestSha256 }, motion: { id: "motion_settling_race", documentSha256 },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256, motionSha256: documentSha256 },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "c".repeat(64) }, quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: { engine: "ffmpeg@7.1", routeFingerprint: "d".repeat(64), presetFingerprint: "e".repeat(64), capabilityFingerprint: "f".repeat(64) },
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
  throw new Error("Timed out waiting for settling-race state.");
}
