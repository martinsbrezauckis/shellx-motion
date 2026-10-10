/** Runtime status shapes must stay within the authored public contract. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMotionJobEvidence } from "./job-evidence";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import { JOB_STATUS_CONTRACT } from "./generated/job-status";
import { MotionHostJob } from "./host-job";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { MotionJobView, type MotionJobStatus } from "./job-view";

const tempRoots: string[] = [];
const callerId = "cut:status-contract";
const jobId = "cut:status-shape";
const planFingerprint = "a".repeat(64);
const receiptId = "receipt-status-shape";
type StatusLifecycle = "pending" | "running" | "ended";
type StatusOutcome = "succeeded" | "failed" | "cancelled" | "skipped";
type OptionalStatusField = {
  name: string;
  lifecycle: readonly StatusLifecycle[];
  outcomes?: readonly StatusOutcome[];
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MotionJobView public runtime shape", () => {
  it("projects pending, running, and terminal records without exposing the internal lease pid", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-view-shape-"));
    tempRoots.push(root);
    let now = 1_000;
    const leases = new MotionJobLeaseDirectory({
      leaseRoot: join(root, "leases"), pid: 42_424, now: () => now, isProcessAlive: () => true
    });
    const records = new MotionJobRegistry({ recordRoot: join(root, "records"), now: () => now });
    const view = new MotionJobView({ leases, records });

    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const job = await MotionHostJob.begin({
        jobId, callerId, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", planFingerprint,
        lineage: { priorJobId: "cut:prior-status-shape", priorReceiptId: "receipt-prior-status-shape", retryAttempt: 1 },
        leases, records, now: () => now
      });

      const pending = await publicJob(view, "pending");
      expect(pending).toMatchObject({ frameLane: "gpu", planFingerprint, state: "pending" });
      expect((await leases.readVisibleLease({ jobId, callerId }))).toMatchObject({ ok: true, lease: { pid: 42_424 } });

      now = 1_025;
      await job.markRunning();
      const running = await publicJob(view, "running");
      expect(running).toMatchObject({ frameLane: "gpu", planFingerprint, startedAtMs: 1_025, queueWaitMs: 25, state: "running" });

      now = 1_100;
      const producerEvidence = { frameLane: "gpu" as const, schema: "shellx-motion/gpu-streaming-producer@1" };
      const evidence = createMotionJobEvidence({
        jobId, callerId, operation: "render.final", planFingerprint, outcome: "succeeded", warnings: ["quality note"],
        receiptIds: [receiptId], producerEvidence, artifacts: []
      });
      await job.succeeded({
        receiptPath: "/host-local/status-shape.receipt.json", receiptId, producerEvidence,
        warnings: ["quality note"], evidence
      });

      const ended = await publicJob(view, "ended", "succeeded");
      expect(ended).toMatchObject({
        frameLane: "gpu", planFingerprint, receiptPath: "/host-local/status-shape.receipt.json", receiptId,
        producerEvidence, evidence: { fingerprint: evidence.fingerprint },
        lineage: { priorJobId: "cut:prior-status-shape", priorReceiptId: "receipt-prior-status-shape", retryAttempt: 1 },
        state: "succeeded"
      });
    });
  });

  it("admits the committed marker only on a failed terminal status", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-view-committed-"));
    tempRoots.push(root);
    const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
    const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
    const view = new MotionJobView({ leases, records });

    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const committedPlanFingerprint = "a".repeat(64);
      const job = await MotionHostJob.begin({
        jobId: "cut:status-committed", callerId, lane: "ffmpeg", operation: "render.final", planFingerprint: committedPlanFingerprint, leases, records
      });
      const hostileEvidence = createMotionJobEvidence({
        jobId: "cut:status-committed", callerId, operation: "render.final", planFingerprint: committedPlanFingerprint, outcome: "failed", warnings: [], receiptIds: [], producerEvidence: null,
        artifacts: [{ schema: "shellx-motion/artifact-handle@1", id: `artifact-${"b".repeat(24)}`, operationHash: "c".repeat(64), sha256: "d".repeat(64) }]
      });
      await job.failed({ error: { code: "invalid_args", message: "publication may have completed", retryable: false }, committed: true, evidence: hostileEvidence });

      const result = await view.get({ jobId: "cut:status-committed", callerId });
      expect(result).toMatchObject({ ok: true, job: { lifecycle: "ended", outcome: "failed" } });
      if (!result.ok) throw new Error("Committed failed status was not readable.");
      const status = result.job;
      assertAuthoredPublicShape(status, "ended", "failed");
      expect(status).toMatchObject({ committed: true, state: "failed" });
      expect(status).not.toHaveProperty("artifacts");
      expect(status.evidence?.artifacts).toEqual([]);
    });
  });
});

async function publicJob(
  view: MotionJobView,
  lifecycle: StatusLifecycle,
  outcome?: StatusOutcome
): Promise<MotionJobStatus> {
  const result = await view.get({ jobId, callerId });
  expect(result).toMatchObject({ ok: true, job: { lifecycle, ...(outcome ? { outcome } : {}) } });
  const status = (result as Extract<typeof result, { ok: true }>).job;
  assertAuthoredPublicShape(status, lifecycle, outcome);
  return status;
}

function assertAuthoredPublicShape(
  status: MotionJobStatus,
  lifecycle: StatusLifecycle,
  outcome?: StatusOutcome
): void {
  const lifecycleEntry = JOB_STATUS_CONTRACT.lifecycle.find((entry) => entry.name === lifecycle);
  expect(lifecycleEntry).toBeDefined();
  const allowed = new Set<string>(lifecycleEntry!.guaranteed);
  for (const field of JOB_STATUS_CONTRACT.optionalFields as readonly OptionalStatusField[]) {
    if (!field.lifecycle.includes(lifecycle)) continue;
    if (field.outcomes && (!outcome || !field.outcomes.includes(outcome))) continue;
    allowed.add(field.name);
  }

  expect(Object.keys(status).sort()).toEqual(expect.arrayContaining([...lifecycleEntry!.guaranteed].sort()));
  expect(Object.keys(status).every((name) => allowed.has(name))).toBe(true);
  for (const absent of lifecycleEntry!.absent) expect(status).not.toHaveProperty(absent);
  for (const field of JOB_STATUS_CONTRACT.notPublicFields) expect(status).not.toHaveProperty(field.name);
}
