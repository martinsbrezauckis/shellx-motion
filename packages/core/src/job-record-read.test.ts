import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMotionJobEvidence } from "./job-evidence";
import { MotionJobLeaseDirectory, UNATTRIBUTED_CALLER_ID } from "./job-lease";
import { parseStoredMotionJobRecord } from "./job-record-read";
import { MotionJobRegistry, type MotionJobRecord } from "./job-registry";
import { motionJobRecordFileName } from "./job-registry-storage";
import { MotionJobView } from "./job-view";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const roots: string[] = [];
const callerId = "cut:record-boundary";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable terminal job-record boundary", () => {
  it("fails closed instead of projecting hostile terminal fields", () => {
    const validError = { code: "invalid_args", message: "bad input", retryable: false };
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["an open terminal outcome", { outcome: "invented" }],
      ["failure detail on a successful outcome", { error: validError }],
      ["false committed failure uncertainty", { outcome: "failed", committed: false }],
      ["nonboolean committed failure uncertainty", { outcome: "failed", committed: "possibly" }],
      ["committed uncertainty on a successful outcome", { committed: true }],
      ["cancellation detail on a failed outcome", { outcome: "failed", cancellation: { requestedBy: callerId } }],
      ["skip detail on a cancelled outcome", { outcome: "cancelled", skip: { code: "already_satisfied" } }],
      ["an untyped cancellation", { outcome: "cancelled", cancellation: { requestedBy: 7 } }],
      ["an unknown skip code", { outcome: "skipped", skip: { code: "invented" } }],
      ["a non-string receipt path", { receiptPath: { path: "/host/receipt.json" } }],
      ["a control-bearing receipt path", { receiptPath: "/host/receipt\u0000.json" }],
      ["an invalid receipt id", { receiptId: "../receipt" }],
      ["an open producer-evidence object", { producerEvidence: { frameLane: "gpu", ignored: true } }],
      ["an invalid producer schema", { producerEvidence: { frameLane: "gpu", schema: "https://host/schema" } }],
      ["a partial lineage", { lineage: { priorJobId: "cut:prior" } }],
      ["a self-referential lineage", { lineage: { priorJobId: "cut:hostile", retryAttempt: 1 } }],
      ["a non-positive lineage attempt", { lineage: { priorJobId: "cut:prior", retryAttempt: 0 } }],
      ["a present non-string caller id", { callerId: 7 }],
      ["an untyped warning", { warnings: [7] }],
      ["present non-array warnings", { warnings: { note: "not an array" } }],
      ["impossible duration", { durationMs: 1_001 }]
    ];

    for (const [label, mutation] of hostile) {
      expect(parseStoredMotionJobRecord(JSON.stringify({ ...terminalRecord("cut:hostile"), ...mutation })), label).toBeNull();
    }
  });

  it("keeps historical terminal records readable when optional retained detail is unavailable", () => {
    for (const outcome of ["succeeded", "failed", "cancelled", "skipped"] as const) {
      const record = parseStoredMotionJobRecord(JSON.stringify(terminalRecord(`cut:historical-${outcome}`, outcome)));
      expect(record).toMatchObject({ lifecycle: "ended", outcome });
      expect(record).not.toHaveProperty("error");
      expect(record).not.toHaveProperty("committed");
      expect(record).not.toHaveProperty("cancellation");
      expect(record).not.toHaveProperty("skip");
      expect(record).not.toHaveProperty("receiptPath");
      expect(record).not.toHaveProperty("receiptId");
      expect(record).not.toHaveProperty("producerEvidence");
      expect(record).not.toHaveProperty("evidence");
      expect(record).not.toHaveProperty("lineage");
    }
  });

  it("round-trips the literal committed marker only on a failed terminal record", () => {
    const committed = parseStoredMotionJobRecord(JSON.stringify({
      ...terminalRecord("cut:committed-failure", "failed"),
      error: { code: "invalid_args", message: "output link may have completed", retryable: false },
      committed: true
    }));
    expect(committed).toMatchObject({ outcome: "failed", committed: true });
    expect(committed).not.toHaveProperty("evidence");

    const historical = parseStoredMotionJobRecord(JSON.stringify(terminalRecord("cut:committed-historical", "failed")));
    expect(historical).toMatchObject({ outcome: "failed" });
    expect(historical).not.toHaveProperty("committed");
  });

  it("refuses a committed failure carrying a correctly fingerprinted artifact envelope", () => {
    const jobId = "cut:committed-artifact";
    const planFingerprint = "a".repeat(64);
    const evidence = createMotionJobEvidence({
      jobId, callerId, operation: "render.final", planFingerprint, outcome: "failed", warnings: [], receiptIds: [], producerEvidence: null,
      artifacts: [{ schema: "shellx-motion/artifact-handle@1", id: `artifact-${"b".repeat(24)}`, operationHash: "c".repeat(64), sha256: "d".repeat(64) }]
    });
    expect(parseStoredMotionJobRecord(JSON.stringify({
      ...terminalRecord(jobId, "failed"), planFingerprint,
      error: { code: "invalid_args", message: "publication may have completed", retryable: false }, committed: true, evidence
    }))).toBeNull();
  });

  it("normalizes only omitted legacy owner and warnings fields", () => {
    const omissions: ReadonlyArray<ReadonlyArray<"callerId" | "warnings">> = [["callerId"], ["warnings"], ["callerId", "warnings"]];
    for (const omitted of omissions) {
      const raw = terminalRecord(`cut:legacy-${omitted.join("-")}`);
      const expectedCallerId = omitted.includes("callerId") ? UNATTRIBUTED_CALLER_ID : callerId;
      for (const field of omitted) delete raw[field];
      expect(parseStoredMotionJobRecord(JSON.stringify(raw))).toMatchObject({
        callerId: expectedCallerId,
        warnings: [],
        lifecycle: "ended",
        outcome: "succeeded"
      });
    }
  });

  it("accepts the renderer warning capacity and refuses a larger durable warning vector", () => {
    const warnings = Array.from({ length: 64 }, (_, index) => `renderer warning ${index}`);
    expect(parseStoredMotionJobRecord(JSON.stringify({ ...terminalRecord("cut:renderer-warning-cap"), warnings })))
      .toMatchObject({ warnings });
    expect(parseStoredMotionJobRecord(JSON.stringify({ ...terminalRecord("cut:renderer-warning-overflow"), warnings: [...warnings, "overflow"] })))
      .toBeNull();
  });

  it("does not project a malformed durable leaf, while a historical leaf remains a truthful terminal view", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-record-boundary-"));
    roots.push(root);
    const recordRoot = join(root, "records");
    const records = new MotionJobRegistry({ recordRoot, now: () => 2_500 });
    const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases"), now: () => 2_500 });
    const view = new MotionJobView({ leases, records });
    const historical = terminalRecord("cut:historical-projection", "failed") as unknown as MotionJobRecord;
    const hostile = terminalRecord("cut:hostile-projection") as unknown as MotionJobRecord;

    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      await records.record(historical);
      await records.record(hostile);
      await writeFile(
        join(recordRoot, motionJobRecordFileName(callerId, hostile.jobId, hostile.endedAtMs)),
        JSON.stringify({ ...hostile, lineage: { priorJobId: "cut:prior", retryAttempt: "many" } })
      );

      await expect(view.get({ jobId: historical.jobId, callerId })).resolves.toEqual(expect.objectContaining({
        ok: true,
        job: expect.objectContaining({ lifecycle: "ended", outcome: "failed", state: "failed" })
      }));
      const historicalView = await view.get({ jobId: historical.jobId, callerId });
      if (!historicalView.ok) throw new Error("Historical record was not projected.");
      expect(historicalView.job).not.toHaveProperty("error");
      expect(historicalView.job).not.toHaveProperty("lineage");
      await expect(view.get({ jobId: hostile.jobId, callerId })).resolves.toEqual({ ok: false, code: "job_unknown" });
    });
  });

  it("projects omitted legacy fields only to the unattributed owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-job-record-legacy-"));
    roots.push(root);
    const recordRoot = join(root, "records");
    const records = new MotionJobRegistry({ recordRoot, now: () => 2_500 });
    const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases"), now: () => 2_500 });
    const view = new MotionJobView({ leases, records });
    const omissions: ReadonlyArray<ReadonlyArray<"callerId" | "warnings">> = [["callerId"], ["warnings"], ["callerId", "warnings"]];

    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      for (const [index, omitted] of omissions.entries()) {
        const jobId = `cut:legacy-projection-${index}`;
        const expectedCallerId = omitted.includes("callerId") ? UNATTRIBUTED_CALLER_ID : callerId;
        const otherCallerId = expectedCallerId === callerId ? UNATTRIBUTED_CALLER_ID : callerId;
        const durable = { ...terminalRecord(jobId), callerId: expectedCallerId } as unknown as MotionJobRecord;
        const legacy = terminalRecord(jobId);
        for (const field of omitted) delete legacy[field];
        await records.record(durable);
        await writeFile(
          join(recordRoot, motionJobRecordFileName(expectedCallerId, jobId, durable.endedAtMs)),
          JSON.stringify(legacy)
        );

        await expect(records.read({ jobId, callerId: expectedCallerId })).resolves.toMatchObject({
          ok: true, record: { callerId: expectedCallerId, warnings: [], outcome: "succeeded" }
        });
        await expect(records.read({ jobId, callerId: otherCallerId })).resolves.toEqual({ ok: false, code: "job_not_visible" });
        await expect(view.get({ jobId, callerId: expectedCallerId })).resolves.toMatchObject({
          ok: true, job: { callerId: expectedCallerId, warnings: [], state: "succeeded" }
        });
        await expect(view.get({ jobId, callerId: otherCallerId })).resolves.toEqual({ ok: false, code: "job_not_visible" });
      }
    });
  });
});

function terminalRecord(jobId: string, outcome: "succeeded" | "failed" | "cancelled" | "skipped" = "succeeded"): Record<string, unknown> {
  return {
    schema: "shellx-motion/job-record@1",
    jobId,
    callerId,
    lane: "ffmpeg",
    operation: "render.final",
    lifecycle: "ended",
    outcome,
    createdAtMs: 1_000,
    startedAtMs: 1_010,
    endedAtMs: 2_000,
    durationMs: 1_000,
    queueWaitMs: 10,
    warnings: []
  };
}
