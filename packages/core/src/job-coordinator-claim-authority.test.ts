import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionJobCoordinator, type MotionJobCoordinatorExecution } from "./job-coordinator";
import { MotionJobEventStore } from "./job-event-store";
import { MotionJobIdentityClaimHandle, MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { createMotionRenderPlan, type MotionRenderPlan } from "./render-plan";
import { MotionRenderPlanStore } from "./render-plan-store";

const roots: string[] = [];
const CALLER_ID = "cut:terminal-evidence";

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("MotionJobCoordinator claim authority", () => {
  it("refuses before submitted evidence or execution when the initial host lease has no exact run", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const announceSpy = vi.spyOn(fixture.leases, "announce").mockImplementation(async () => null as never);
    let executions = 0;
    try {
      const plannedJobId = "cut:evidence-missing-initial-lease-planned";
      await expect(submit(fixture, { jobId: plannedJobId, renderPlan: plan, execute: async () => { executions += 1; return { ok: true }; } }))
        .resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
      await expectHeldPhase(fixture, plannedJobId, { mode: "planned", planFingerprint: plan.fingerprint }, "plan_bound");
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.jobView().get({ jobId: plannedJobId, callerId: CALLER_ID })))
        .resolves.toEqual({ ok: false, code: "job_unknown" });
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.events({ jobId: plannedJobId, callerId: CALLER_ID })))
        .resolves.toMatchObject({ ok: false, code: "job_unknown" });
      await expect(inWorkspace(fixture.root, async () => await fixture.jobs.cancel({ jobId: plannedJobId, callerId: CALLER_ID })))
        .resolves.toMatchObject({ ok: false, code: "job_unknown" });

      const legacyJobId = "cut:evidence-missing-initial-lease-legacy";
      await expect(submit(fixture, { jobId: legacyJobId, execute: async () => { executions += 1; return { ok: true }; } }))
        .resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
      await expectHeldPhase(fixture, legacyJobId, { mode: "legacy-planless" }, "admission_bound");
      expect(executions).toBe(0);
      await expect(inWorkspace(fixture.root, async () => await fixture.leases.readLiveLeases())).resolves.toHaveLength(0);
    } finally {
      announceSpy.mockRestore();
    }
  });

  it("releases capacity without a terminal record when the terminal claim phase cannot advance", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-terminal-phase-lost";
    const advance = MotionJobIdentityClaimHandle.prototype.advance;
    const advanceSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "advance").mockImplementation(async function (this: MotionJobIdentityClaimHandle, phase) {
      return phase === "terminal_evidence" ? { ok: false, code: "claim_unavailable" } : await advance.call(this, phase);
    });
    try {
      await expect(submit(fixture, {
        jobId, renderPlan: plan,
        execute: async () => ({ ok: false, error: { code: "job_queue_timeout", message: "retryable worker failure", retryable: true } })
      })).resolves.toMatchObject({ ok: true, value: { jobId } });
      await expectNoTerminalRecord(fixture, jobId);
      await expectHeldPhase(fixture, jobId, { mode: "planned", planFingerprint: plan.fingerprint }, "settling");
    } finally {
      advanceSpy.mockRestore();
    }
  });

  it("does not locally replay a live planned job after its exact claim authority becomes unavailable", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-local-replay-authority-lost";
    let executionEntered!: () => void;
    const entered = new Promise<void>((resolve) => { executionEntered = resolve; });
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => { releaseExecution = resolve; });
    await expect(submit(fixture, {
      jobId, renderPlan: plan,
      execute: async () => { executionEntered(); await executionReleased; return { ok: true }; }
    })).resolves.toMatchObject({ ok: true, value: { jobId } });
    await entered;

    const heldSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "assertHeld").mockResolvedValue({ ok: false, code: "claim_unavailable" });
    let duplicateExecutions = 0;
    try {
      await expect(submit(fixture, {
        jobId, renderPlan: plan,
        execute: async () => { duplicateExecutions += 1; return { ok: true }; }
      })).resolves.toMatchObject({ ok: false, code: "job_plan_unresolved" });
      expect(duplicateExecutions).toBe(0);
      expect(heldSpy).toHaveBeenCalled();
      releaseExecution();
      await expectNoTerminalRecord(fixture, jobId);
    } finally {
      releaseExecution?.();
      heldSpy.mockRestore();
    }
  });

  it("releases capacity without a terminal record when the post-event held check loses authority", async () => {
    const fixture = await coordinator();
    const plan = renderPlan();
    const jobId = "cut:evidence-terminal-held-lost";
    const write = MotionJobEventStore.prototype.write;
    const assertHeld = MotionJobIdentityClaimHandle.prototype.assertHeld;
    let denyPostEventHeld = false;
    const writeSpy = vi.spyOn(MotionJobEventStore.prototype, "write").mockImplementation(async function (this: MotionJobEventStore, input) {
      await write.call(this, input);
      if (input.events.at(-1)?.type === "failed") denyPostEventHeld = true;
    });
    const heldSpy = vi.spyOn(MotionJobIdentityClaimHandle.prototype, "assertHeld").mockImplementation(async function (this: MotionJobIdentityClaimHandle) {
      return denyPostEventHeld ? { ok: false, code: "claim_lost" } : await assertHeld.call(this);
    });
    try {
      await expect(submit(fixture, {
        jobId, renderPlan: plan,
        execute: async () => ({ ok: false, error: { code: "job_queue_timeout", message: "retryable worker failure", retryable: true } })
      })).resolves.toMatchObject({ ok: true, value: { jobId } });
      await expectNoTerminalRecord(fixture, jobId);
      await expectHeldPhase(fixture, jobId, { mode: "planned", planFingerprint: plan.fingerprint }, "terminal_evidence");
    } finally {
      heldSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});

async function coordinator() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-claim-authority-"));
  roots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  const identityClaims = new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") });
  return {
    root, leases, identityClaims,
    jobs: new MotionJobCoordinator({ leases, records, eventsRoot: join(root, "events"), renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "render-plans") }), identityClaims })
  };
}

async function submit(
  fixture: Awaited<ReturnType<typeof coordinator>>,
  input: { jobId: string; renderPlan?: MotionRenderPlan; execute: (signal: AbortSignal) => Promise<MotionJobCoordinatorExecution> }
) {
  return await inWorkspace(fixture.root, async () => await fixture.jobs.submit({
    ...input, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final"
  }));
}

async function expectNoTerminalRecord(fixture: Awaited<ReturnType<typeof coordinator>>, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const leases = await inWorkspace(fixture.root, async () => await fixture.leases.readLiveLeases());
    if (leases.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await expect(inWorkspace(fixture.root, async () => await fixture.jobs.jobView().get({ jobId, callerId: CALLER_ID })))
    .resolves.toEqual({ ok: false, code: "job_unknown" });
}

async function expectHeldPhase(
  fixture: Awaited<ReturnType<typeof coordinator>>,
  jobId: string,
  admission: { mode: "legacy-planless" } | { mode: "planned"; planFingerprint: string },
  phase: "admission_bound" | "plan_bound" | "executing" | "settling" | "terminal_evidence"
): Promise<void> {
  const acquired = await inWorkspace(fixture.root, async () => await fixture.identityClaims.acquire({ callerId: CALLER_ID, jobId, admission }));
  expect(acquired).toMatchObject({ ok: false, code: "claim_held", claim: { phase } });
}

function renderPlan(): MotionRenderPlan {
  const manifestSha256 = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  return createMotionRenderPlan({
    package: { id: "pkg_claim_authority", manifestSha256 }, motion: { id: "motion_claim_authority", documentSha256 },
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
