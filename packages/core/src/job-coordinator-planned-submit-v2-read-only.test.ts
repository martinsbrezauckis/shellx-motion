/** Current planned submission must not turn a readable historical V2 record into execution authority. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "./canonical-json";
import { MotionJobCoordinator } from "./job-coordinator";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { createMotionRenderPlan, MOTION_RENDER_PLAN_V2_SCHEMA } from "./render-plan";
import { MotionRenderAdmissionStore } from "./render-admission-store";
import { MotionRenderPlanStore } from "./render-plan-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-v2-read-only-"));
  roots.push(root);
  const plans = new MotionRenderPlanStore({ planRoot: join(root, "render-plans") });
  return {
    root,
    plans,
    jobs: new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot: join(root, "events"),
      renderPlans: plans,
      renderAdmissions: new MotionRenderAdmissionStore({ admissionRoot: join(root, "render-admissions") })
    })
  };
}

async function trusted<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation);
}

function historicalV2Plan(): Record<string, unknown> {
  const manifestSha256 = "a".repeat(64);
  const motionSha256 = "b".repeat(64);
  const v1 = createMotionRenderPlan({
    package: { id: "pkg_demo", manifestSha256 }, motion: { id: "motion_demo", documentSha256: motionSha256 },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256, motionSha256 },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "c".repeat(64) }, quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: { engine: "ffmpeg@7.1", routeFingerprint: "d".repeat(64), presetFingerprint: "e".repeat(64), capabilityFingerprint: "f".repeat(64) },
    compatibility: { version: 1, state: "current" }
  });
  const { fingerprint: _v1Fingerprint, ...v1Content } = v1;
  const { capabilityFingerprint: _opaqueCapabilityFingerprint, ...runtime } = v1.runtime;
  const capability = {
    schema: "shellx-motion/render-capability-snapshot@1",
    tools: {
      ffmpeg: { source: "shellx-family", executableSha256: "a".repeat(64), versionSha256: "b".repeat(64), configurationSha256: "c".repeat(64), filtersSha256: "d".repeat(64), encodersSha256: "e".repeat(64) },
      ffprobe: { source: "shellx-family", executableSha256: "f".repeat(64), versionSha256: "a".repeat(64), configurationSha256: "b".repeat(64) }
    },
    filterGraph: { schema: "shellx-motion/ffmpeg-filter-graph-contract@1", sha256: "c".repeat(64), requiredFilters: [] },
    encoder: { attempts: [{ source: "software", encoder: "libx264" }], fallback: "none" },
    implementation: { frameLane: "gpu", renderer: "renderer-gpu@1", launch: "chromium@1", adapterFingerprint: "d".repeat(64), containment: "contained@1" }
  };
  const content = { ...v1Content, schema: MOTION_RENDER_PLAN_V2_SCHEMA, runtime, capability, compatibility: { version: 2, state: "current" } };
  return { ...content, fingerprint: canonicalJsonSha256(content) };
}

describe("planned V2 read-only boundary", () => {
  it("refuses direct binding plus clones, alternate callers/jobs, substitute execute closures, and replay before any event or execution", async () => {
    const { jobs, plans, root } = await fixture();
    let executions = 0;
    const original = historicalV2Plan();
    await expect(trusted(root, async () => await plans.bind({
      callerId: "cut:workspace", jobId: "cut:v2-direct-bind", plan: original
    }))).resolves.toEqual({ ok: false, code: "plan_invalid" });
    await expect(trusted(root, async () => await plans.read({ callerId: "cut:workspace", jobId: "cut:v2-direct-bind" }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
    await expect(trusted(root, async () => await jobs.events({ jobId: "cut:v2-direct-bind", callerId: "cut:workspace" }))).resolves.toMatchObject({ ok: false, code: "job_unknown" });
    const attempts = [
      { jobId: "cut:v2-read-only", callerId: "cut:workspace", renderPlan: original, execute: async () => { executions += 1; return { ok: true }; } },
      { jobId: "cut:v2-read-only", callerId: "cut:workspace", renderPlan: original, execute: async () => { executions += 10; return { ok: true }; } },
      { jobId: "cut:v2-read-only-clone", callerId: "cut:workspace", renderPlan: structuredClone(original), execute: async () => { executions += 100; return { ok: true }; } },
      { jobId: "cut:v2-read-only", callerId: "cut:other-workspace", renderPlan: structuredClone(original), execute: async () => { executions += 1_000; return { ok: true }; } }
    ];
    for (const attempt of attempts) {
      await expect(trusted(root, async () => await jobs.submit({
        ...attempt, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: attempt.renderPlan as never
      }))).resolves.toMatchObject({ ok: false, code: "job_plan_invalid" });
    }
    expect(executions).toBe(0);
    await expect(trusted(root, async () => await plans.read({ callerId: "cut:workspace", jobId: "cut:v2-read-only" }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
    await expect(trusted(root, async () => await plans.read({ callerId: "cut:other-workspace", jobId: "cut:v2-read-only" }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
    await expect(trusted(root, async () => await jobs.events({ jobId: "cut:v2-read-only", callerId: "cut:workspace" }))).resolves.toMatchObject({ ok: false, code: "job_unknown" });
    await expect(trusted(root, async () => await jobs.events({ jobId: "cut:v2-read-only-clone", callerId: "cut:workspace" }))).resolves.toMatchObject({ ok: false, code: "job_unknown" });
  });
});
