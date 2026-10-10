import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MotionJobEventStore } from "./job-event-store";
import { JOB_RECORD_RETENTION_COUNT, JOB_RECORD_RETENTION_MS, MotionJobRegistry, type MotionJobRecord } from "./job-registry";
import { motionJobRecordFileName, readMotionJobRecord, writeMotionJobRecord } from "./job-registry-storage";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { MotionRenderAdmissionStore } from "./render-admission-store";
import { createMotionRenderPlan, type MotionRenderPlan } from "./render-plan";
import { MotionRenderPlanStore, motionRenderPlanBindingFileName } from "./render-plan-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });
const NOW = 20 * JOB_RECORD_RETENTION_MS;
const OWNER = "cut:retention-owner";
const OTHER_OWNER = "design:retention-owner";
const JOB = "retention:shared-id";

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".scratch-durable-retention-"));
  roots.push(root);
  const records = new MotionJobRegistry({ recordRoot: join(root, "records"), now: () => NOW });
  const trusted = async <T>(operation: () => Promise<T>) => await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation);
  return { root, records, trusted };
}

function record(callerId: string, jobId: string, endedAtMs = NOW - JOB_RECORD_RETENTION_MS - 1): MotionJobRecord {
  return {
    schema: "shellx-motion/job-record@1", callerId, jobId, lane: "ffmpeg", operation: "render.final", lifecycle: "ended", outcome: "succeeded",
    createdAtMs: endedAtMs - 10, startedAtMs: endedAtMs - 5, endedAtMs, durationMs: 5, queueWaitMs: 5, warnings: []
  };
}

function plan(): MotionRenderPlan {
  const manifestSha256 = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  return createMotionRenderPlan({
    package: { id: "pkg_retention", manifestSha256 }, motion: { id: "motion_retention", documentSha256 },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256, motionSha256: documentSha256 },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "c".repeat(64) }, quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: { engine: "ffmpeg@7.1", routeFingerprint: "d".repeat(64), presetFingerprint: "e".repeat(64), capabilityFingerprint: "f".repeat(64) },
    compatibility: { version: 1, state: "current" }
  });
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

describe("durable terminal query retention", () => {
  it("keeps deprecated prune non-destructive while read/list apply age retention", async () => {
    const state = await fixture();
    const expired = record(OWNER, "quiet:read");
    const path = join(state.root, "records", motionJobRecordFileName(OWNER, expired.jobId, expired.endedAtMs));
    await state.trusted(async () => {
      await writeMotionJobRecord(join(state.root, "records"), expired);
      await state.records.prune();
      expect(state.records.isDegraded).toBe(false);
      await expect(state.records.read({ callerId: OWNER, jobId: expired.jobId })).resolves.toEqual({ ok: false, code: "job_unknown" });
      await expect(state.records.list({ callerId: OWNER })).resolves.toEqual([]);
      expect(await exists(path)).toBe(true);
    });
  });

  it("applies the count projection per owner while preserving records on disk", async () => {
    const state = await fixture();
    const oldest = record(OWNER, "count:0", NOW - JOB_RECORD_RETENTION_COUNT);
    const oldestPath = join(state.root, "records", motionJobRecordFileName(OWNER, oldest.jobId, oldest.endedAtMs));
    await state.trusted(async () => {
      for (let index = 0; index <= JOB_RECORD_RETENTION_COUNT; index += 1) {
        await writeMotionJobRecord(join(state.root, "records"), record(OWNER, `count:${index}`, NOW - JOB_RECORD_RETENTION_COUNT + index));
      }
      const other = record(OTHER_OWNER, "count:other", NOW - 1);
      await writeMotionJobRecord(join(state.root, "records"), other);
      await expect(state.records.read({ callerId: OWNER, jobId: oldest.jobId })).resolves.toEqual({ ok: false, code: "job_unknown" });
      await expect(state.records.read({ callerId: OTHER_OWNER, jobId: other.jobId })).resolves.toMatchObject({ ok: true, record: { callerId: OTHER_OWNER } });
      await expect(state.records.list({ callerId: OWNER })).resolves.toHaveLength(JOB_RECORD_RETENTION_COUNT);
      expect(await exists(oldestPath)).toBe(true);
    });
  }, 45_000);

  it("keeps older and current records through terminal writes and an amend", async () => {
    const state = await fixture();
    const older = record(OWNER, "rewrite:preserved", NOW - 2_000);
    const current = record(OWNER, "rewrite:preserved", NOW - 1_000);
    const olderPath = join(state.root, "records", motionJobRecordFileName(OWNER, older.jobId, older.endedAtMs));
    const currentPath = join(state.root, "records", motionJobRecordFileName(OWNER, current.jobId, current.endedAtMs));
    await state.trusted(async () => {
      await state.records.record(older);
      await state.records.record(current);
      expect(await exists(olderPath)).toBe(true);
      expect(await exists(currentPath)).toBe(true);

      await state.records.amend({
        callerId: OWNER, jobId: current.jobId, patch: { receiptPath: "/receipts/rewrite-preserved.json" }
      });

      expect(await exists(olderPath)).toBe(true);
      expect(await exists(currentPath)).toBe(true);
      await expect(readMotionJobRecord(join(state.root, "records"), motionJobRecordFileName(OWNER, current.jobId, current.endedAtMs)))
        .resolves.toMatchObject({ receiptPath: "/receipts/rewrite-preserved.json" });
    });
  });

  it("preserves aged legacy records because logical retention applies only to current owner-qualified files", async () => {
    const state = await fixture();
    const legacy = record(OWNER, "legacy:retention");
    const path = join(state.root, "records", `legacy--${legacy.endedAtMs}.job.json`);
    await state.trusted(async () => {
      await mkdir(join(state.root, "records"), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(legacy)}\n`);
      await expect(state.records.read({ callerId: OWNER, jobId: legacy.jobId })).resolves.toMatchObject({ ok: true, record: { jobId: legacy.jobId } });
      await expect(state.records.list({ callerId: OWNER })).resolves.toMatchObject([expect.objectContaining({ jobId: legacy.jobId })]);
      expect(await exists(path)).toBe(true);
    });
  });

  it("ignores a corrupt current-looking record during the retention projection without removing it", async () => {
    const state = await fixture();
    const current = record(OWNER, "corrupt:retention", NOW - 1);
    const path = join(state.root, "records", motionJobRecordFileName(OWNER, current.jobId, current.endedAtMs));
    await state.trusted(async () => {
      await mkdir(join(state.root, "records"), { recursive: true, mode: 0o700 });
      await writeFile(path, "{bad-json}");
      await expect(state.records.list({ callerId: OWNER })).resolves.toEqual([]);
      expect(await exists(path)).toBe(true);
    });
  });

  it("does not remove companions while an aged record is hidden", async () => {
    const state = await fixture();
    const plans = new MotionRenderPlanStore({ planRoot: join(state.root, "plans") });
    const admissions = new MotionRenderAdmissionStore({ admissionRoot: join(state.root, "admissions") });
    const events = new MotionJobEventStore(join(state.root, "events"));
    await state.trusted(async () => {
      await writeMotionJobRecord(join(state.root, "records"), record(OWNER, JOB));
      await plans.bind({ callerId: OWNER, jobId: JOB, plan: plan() });
      await admissions.bind({ callerId: OWNER, jobId: JOB, admission: { mode: "planned", planFingerprint: plan().fingerprint } });
      await events.write({ callerId: OWNER, jobId: JOB, events: [
        { schema: "shellx-motion/job-event@1", seq: 1, atMs: NOW - 1, type: "submitted" }
      ] });
      await expect(state.records.list({ callerId: OWNER })).resolves.toEqual([]);
      await expect(events.read({ callerId: OWNER, jobId: JOB })).resolves.toHaveLength(1);
      await expect(plans.read({ callerId: OWNER, jobId: JOB })).resolves.toMatchObject({ ok: true });
      await expect(admissions.read({ callerId: OWNER, jobId: JOB })).resolves.toMatchObject({ ok: true });
      expect(await exists(join(state.root, "plans", motionRenderPlanBindingFileName(OWNER, JOB)))).toBe(true);
    });
  });

  it("never deletes an atomically amended aged record during concurrent quiet queries", async () => {
    const state = await fixture();
    const expired = record(OWNER, "amend:retention");
    const name = motionJobRecordFileName(OWNER, expired.jobId, expired.endedAtMs);
    const path = join(state.root, "records", name);
    await state.trusted(async () => {
      await writeMotionJobRecord(join(state.root, "records"), expired);
      await Promise.all([
        state.records.list({ callerId: OWNER }),
        state.records.read({ callerId: OWNER, jobId: expired.jobId }),
        state.records.amend({ callerId: OWNER, jobId: expired.jobId, patch: { receiptPath: "/receipts/amended.json" } })
      ]);
      expect(await exists(path)).toBe(true);
      await expect(readMotionJobRecord(join(state.root, "records"), name)).resolves.toMatchObject({ receiptPath: "/receipts/amended.json" });
    });
  });

  it.skipIf(process.platform === "win32")("does not count a current-looking symlink as a retained current record", async () => {
    const state = await fixture();
    const retained = record(OWNER, "symlink:retention", NOW - 1);
    const target = join(state.root, "outside-record.json");
    const path = join(state.root, "records", motionJobRecordFileName(retained.callerId, retained.jobId, retained.endedAtMs));
    await state.trusted(async () => {
      await mkdir(join(state.root, "records"), { recursive: true, mode: 0o700 });
      await writeFile(target, `${JSON.stringify(retained)}\n`);
      await symlink(target, path);
      await expect(state.records.list({ callerId: OWNER })).resolves.toEqual([]);
      expect(await exists(path)).toBe(true);
      expect(await exists(target)).toBe(true);
    });
  });
});
