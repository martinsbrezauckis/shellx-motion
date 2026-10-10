/** V1 plan/evidence persistence tests kept separate from the legacy registry behavior suite. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMotionJobEvidence } from "./job-evidence";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry, type MotionJobRecord } from "./job-registry";
import { MotionJobView } from "./job-view";
import { MotionHostJob } from "./host-job";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const tempRoots: string[] = [];
const NOW = Date.now();

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("V1 terminal job identity and evidence", () => {
  it("carries a host-derived plan through pending, running, and terminal evidence", async () => {
    const { root, leases, records, view } = await stores();
    await inJobWorkspace(root, async () => {
      const jobId = "cut:v1-status";
      const planFingerprint = "a".repeat(64);
      const receiptId = "receipt-v1-status";
      const producerEvidence = { frameLane: "gpu" as const, schema: "shellx-motion/gpu-streaming-producer@1" };
      const warnings = ["fallback encoder used"];
      const evidence = createMotionJobEvidence({
        jobId, callerId: "cut:workspace-7", operation: "render.final", planFingerprint,
        outcome: "succeeded", warnings, receiptIds: [receiptId], producerEvidence, artifacts: []
      });
      const job = await MotionHostJob.begin({
        jobId, callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", planFingerprint, leases, records
      });

      await expect(view.get({ jobId, callerId: "cut:workspace-7" })).resolves.toMatchObject({
        ok: true, job: { lifecycle: "pending", planFingerprint }
      });
      const pending = await view.get({ jobId, callerId: "cut:workspace-7" });
      expect((pending as { ok: true; job: { evidence?: unknown } }).job.evidence).toBeUndefined();

      await job.markRunning();
      await expect(view.get({ jobId, callerId: "cut:workspace-7" })).resolves.toMatchObject({
        ok: true, job: { lifecycle: "running", planFingerprint }
      });

      await job.succeeded({ receiptId, producerEvidence, warnings, evidence });
      await expect(view.get({ jobId, callerId: "cut:workspace-7" })).resolves.toMatchObject({
        ok: true,
        job: {
          lifecycle: "ended", planFingerprint, outcome: "succeeded", warnings, receiptId,
          producerEvidence, evidence: { fingerprint: evidence.fingerprint, artifacts: [] }
        }
      });
    });
  });

  it("drops optional evidence whose valid warning mirror differs from the terminal record", async () => {
    const { root, leases, records, view } = await stores();
    await inJobWorkspace(root, async () => {
      const jobId = "cut:v1-canonical-warning-mirror";
      const planFingerprint = "a".repeat(64);
      const evidence = createMotionJobEvidence({
        jobId, callerId: "cut:workspace-7", operation: "render.final", planFingerprint,
        outcome: "succeeded", warnings: ["evidence-only warning"], receiptIds: [], producerEvidence: null, artifacts: []
      });
      const job = await MotionHostJob.begin({
        jobId, callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final", planFingerprint, leases, records
      });

      await job.succeeded({ warnings: ["terminal-only warning"], evidence });
      await expect(view.get({ jobId, callerId: "cut:workspace-7" })).resolves.toMatchObject({
        ok: true, job: { state: "succeeded", warnings: ["terminal-only warning"] }
      });
      const result = await view.get({ jobId, callerId: "cut:workspace-7" });
      expect(result.ok && result.job.evidence).toBeUndefined();
    });
  });

  it("rejects a malformed host plan before opening a job", async () => {
    await expect(MotionHostJob.begin({
      jobId: "cut:bad-plan", callerId: "cut:workspace-7", lane: "ffmpeg", operation: "render.final",
      planFingerprint: "not-a-sha256", leases: null, records: null
    })).rejects.toThrow(/planFingerprint/i);
  });

  it("retains matching compact receipt and producer links", async () => {
    const { root, records, view } = await stores();
    await inJobWorkspace(root, async () => {
      const jobId = "cut:v1-compact-links";
      const callerId = "cut:workspace-7";
      const planFingerprint = "c".repeat(64);
      const receiptId = "receipt-final-1";
      const producerEvidence = { frameLane: "gpu" as const, schema: "shellx-motion/gpu-streaming-producer@1" };
      const evidence = createMotionJobEvidence({
        jobId, callerId, operation: "render.final", planFingerprint, outcome: "succeeded", warnings: [],
        receiptIds: [receiptId], producerEvidence, artifacts: []
      });
      await records.record(endedRecord({ jobId, planFingerprint, receiptId, producerEvidence, evidence }));

      await expect(view.get({ jobId, callerId })).resolves.toMatchObject({
        ok: true, job: { receiptId, producerEvidence, evidence: { fingerprint: evidence.fingerprint } }
      });
    });
  });

  it("keeps historical terminal records without V1 fields readable", async () => {
    const { root, records, view } = await stores();
    await inJobWorkspace(root, async () => {
      const jobId = "cut:historical-terminal";
      const callerId = "cut:workspace-7";
      await records.record(endedRecord({ jobId, callerId }));

      const answer = await view.get({ jobId, callerId });
      expect(answer).toMatchObject({ ok: true, job: { lifecycle: "ended", state: "succeeded" } });
      expect((answer as { ok: true; job: { planFingerprint?: unknown; evidence?: unknown } }).job.planFingerprint).toBeUndefined();
      expect((answer as { ok: true; job: { planFingerprint?: unknown; evidence?: unknown } }).job.evidence).toBeUndefined();
    });
  });

  it("rejects evidence that disagrees with record identity or compact links", async () => {
    const { root, records, view } = await stores();
    await inJobWorkspace(root, async () => {
      const planFingerprint = "b".repeat(64);
      const callerId = "cut:workspace-7";
      const rejected = async (record: MotionJobRecord) => {
        await records.record(record);
        await expect(view.get({ jobId: record.jobId, callerId })).resolves.toEqual({ ok: false, code: "job_unknown" });
      };

      const receiptConflict = evidence("cut:v1-receipt-conflict", callerId, planFingerprint, { receiptIds: ["receipt-evidence"] });
      await rejected(endedRecord({ jobId: "cut:v1-receipt-conflict", planFingerprint, receiptId: "receipt-record", evidence: receiptConflict }));

      const producerConflict = evidence("cut:v1-producer-conflict", callerId, planFingerprint, { producerEvidence: { frameLane: "browser" } });
      await rejected(endedRecord({ jobId: "cut:v1-producer-conflict", planFingerprint, producerEvidence: { frameLane: "native" }, evidence: producerConflict }));

      const warningConflict = evidence("cut:v1-warning-conflict", callerId, planFingerprint);
      await rejected(endedRecord({ jobId: "cut:v1-warning-conflict", planFingerprint, warnings: ["terminal warning"], evidence: warningConflict }));

      await rejected(endedRecord({
        jobId: "cut:v1-missing-plan", evidence: evidence("cut:v1-missing-plan", callerId, planFingerprint)
      }));
      await rejected(endedRecord({
        jobId: "cut:v1-record-id", planFingerprint, evidence: evidence("cut:v1-evidence-id", callerId, planFingerprint)
      }));
      await rejected(endedRecord({
        jobId: "cut:v1-caller-conflict", planFingerprint,
        evidence: evidence("cut:v1-caller-conflict", "cut:other", planFingerprint)
      }));
      await rejected(endedRecord({
        jobId: "cut:v1-outcome-conflict", planFingerprint,
        evidence: evidence("cut:v1-outcome-conflict", callerId, planFingerprint, { outcome: "failed" })
      }));
      await rejected(endedRecord({
        jobId: "cut:v1-plan-conflict", planFingerprint: "d".repeat(64),
        evidence: evidence("cut:v1-plan-conflict", callerId, planFingerprint)
      }));
      await rejected(endedRecord({
        jobId: "cut:v1-operation-conflict", operation: "preview.frame", planFingerprint,
        evidence: evidence("cut:v1-operation-conflict", callerId, planFingerprint)
      }));
      await rejected({
        ...endedRecord({
          jobId: "cut:v1-nonterminal", planFingerprint,
          evidence: evidence("cut:v1-nonterminal", callerId, planFingerprint)
        }),
        lifecycle: "running" as never
      });
      await rejected(endedRecord({
        jobId: "cut:v1-invalid-plan", planFingerprint: "not-a-sha256",
        evidence: evidence("cut:v1-invalid-plan", callerId, planFingerprint)
      }));
    });
  });

  it("keeps evidenced warnings fixed while attaching a later receipt path", async () => {
    const { root, records, view } = await stores();
    await inJobWorkspace(root, async () => {
      const jobId = "cut:evidenced-amend";
      const callerId = "cut:workspace-7";
      const planFingerprint = "f".repeat(64);
      const warnings = ["terminal warning"];
      const terminalEvidence = evidence(jobId, callerId, planFingerprint, { warnings });
      await records.record(endedRecord({ jobId, callerId, planFingerprint, warnings, evidence: terminalEvidence }));

      await records.amend({
        jobId, callerId,
        patch: { receiptPath: "/receipts/evidenced-amend.json", warnings: ["late warning"] }
      });

      await expect(view.get({ jobId, callerId })).resolves.toMatchObject({
        ok: true,
        job: {
          receiptPath: "/receipts/evidenced-amend.json", warnings,
          evidence: { fingerprint: terminalEvidence.fingerprint }, lifecycle: "ended", outcome: "succeeded", state: "succeeded"
        }
      });
    });
  });

  it("attaches later metadata without changing terminal lifecycle or outcome when evidence is absent", async () => {
    const { root, records, view } = await stores();
    await inJobWorkspace(root, async () => {
      await records.record(endedRecord({ jobId: "cut:render-9" }));
      await records.amend({
        jobId: "cut:render-9", callerId: "cut:workspace-7",
        patch: { receiptPath: "/receipts/render-9.json", warnings: ["native text was case-folded"] }
      });

      await expect(view.get({ jobId: "cut:render-9", callerId: "cut:workspace-7" })).resolves.toMatchObject({
        ok: true,
        job: {
          receiptPath: "/receipts/render-9.json", warnings: ["native text was case-folded"],
          lifecycle: "ended", outcome: "succeeded", state: "succeeded"
        }
      });
    });
  });
});

async function stores() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-v1-"));
  tempRoots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  return { root, leases, records, view: new MotionJobView({ leases, records }) };
}

async function inJobWorkspace<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation);
}

function endedRecord(overrides: Partial<MotionJobRecord> & Pick<MotionJobRecord, "jobId">): MotionJobRecord {
  return {
    schema: "shellx-motion/job-record@1", callerId: "cut:workspace-7", lane: "ffmpeg",
    operation: "render.final", lifecycle: "ended", outcome: "succeeded",
    createdAtMs: NOW - 2_000, startedAtMs: NOW - 1_990, endedAtMs: NOW - 1_000,
    durationMs: 990, queueWaitMs: 10, warnings: [], ...overrides
  };
}

function evidence(
  jobId: string,
  callerId: string,
  planFingerprint: string,
  overrides: Partial<Pick<Parameters<typeof createMotionJobEvidence>[0], "outcome" | "receiptIds" | "producerEvidence" | "warnings">> = {}
) {
  return createMotionJobEvidence({
    jobId, callerId, operation: "render.final", planFingerprint,
    outcome: overrides.outcome ?? "succeeded", warnings: overrides.warnings ?? [], receiptIds: overrides.receiptIds ?? [],
    producerEvidence: overrides.producerEvidence ?? null, artifacts: []
  });
}
