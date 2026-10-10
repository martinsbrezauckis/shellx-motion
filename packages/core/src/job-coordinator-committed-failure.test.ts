import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MotionJobCoordinator } from "./job-coordinator";
import { motionJobOwnerKey } from "./job-id-file";
import { MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import type { MotionJobCoordinatorEvent } from "./job-event-store";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const roots: string[] = [];
const CALLER = "cut:workspace";

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function coordinator() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-committed-failure-"));
  roots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  const eventsRoot = join(root, "events");
  const jobs = new MotionJobCoordinator({
    leases, records, eventsRoot,
    identityClaims: new MotionJobIdentityClaimStore({ claimRoot: join(root, "job-identity-claims") })
  });
  await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
    const initialized = await jobs.submit({
      jobId: "cut:committed-initialization", callerId: "cut:committed-initialization", lane: "test", operation: "test.initialization",
      execute: async () => ({ ok: true })
    });
    if (!initialized.ok) throw new Error("Could not initialize committed-failure coordinator authority.");
    await terminal(jobs, "cut:committed-initialization", "cut:committed-initialization", "succeeded");
    await settleSuccessfulJob(jobs, "cut:committed-initialization", "cut:committed-initialization");
  });
  return { eventsRoot, jobs };
}

async function terminal(
  jobs: MotionJobCoordinator, jobId: string, callerId: string, state: "succeeded" | "failed"
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await jobs.jobView().get({ jobId, callerId });
    if (status.ok && status.job.state === state) return status;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for committed-failure terminal state.");
}

async function settleSuccessfulJob(jobs: MotionJobCoordinator, jobId: string, callerId: string): Promise<void> {
  // A known-success retry waits for settlement and starts no new work.
  await expect(jobs.retry({ jobId, callerId })).resolves.toMatchObject({ ok: false, code: "job_not_retryable" });
  await expect(jobs.jobView().get({ jobId, callerId })).resolves.toMatchObject({ ok: true, job: { state: "succeeded" } });
}

function eventPath(eventsRoot: string, jobId: string): string {
  return join(eventsRoot, `${motionJobOwnerKey(CALLER, jobId)}.events.json`);
}

describe("MotionJobCoordinator committed failure fences", () => {
  it("never grants process-local replay authority to a committed retryable failure", async () => {
    const { jobs } = await coordinator();
    let executions = 0;
    await expect(jobs.submit({
      jobId: "cut:committed-retry-fence", callerId: CALLER, lane: "ffmpeg", operation: "render.final",
      execute: async () => {
        executions += 1;
        return { ok: false, committed: true, error: { code: "job_queue_timeout", message: "publication may have completed", retryable: true } };
      }
    })).resolves.toMatchObject({ ok: true });
    const status = await terminal(jobs, "cut:committed-retry-fence", CALLER, "failed");
    expect(status).toMatchObject({ ok: true, job: { committed: true, error: { retryable: true } } });
    await expect(jobs.retry({ jobId: "cut:committed-retry-fence", callerId: CALLER, newJobId: "cut:committed-retry-fence-retry" }))
      .resolves.toMatchObject({ ok: false, code: "job_not_retryable" });
    expect(executions).toBe(1);
  });

  it("fails closed when terminal record and event committed markers disagree in either direction", async () => {
    const { jobs, eventsRoot } = await coordinator();
    const recordOnly = "cut:event-committed-record-only";
    await expect(jobs.submit({
      jobId: recordOnly, callerId: CALLER, lane: "ffmpeg", operation: "render.final",
      execute: async () => ({ ok: false, committed: true, error: { code: "invalid_args", message: "publication may have completed", retryable: false } })
    })).resolves.toMatchObject({ ok: true });
    await terminal(jobs, recordOnly, CALLER, "failed");
    const recordOnlyEvents = JSON.parse(await readFile(eventPath(eventsRoot, recordOnly), "utf8")) as MotionJobCoordinatorEvent[];
    const recordOnlyTerminal = recordOnlyEvents.at(-1);
    if (!recordOnlyTerminal?.data) throw new Error("Expected failed terminal data.");
    delete recordOnlyTerminal.data.committed;
    await writeFile(eventPath(eventsRoot, recordOnly), `${JSON.stringify(recordOnlyEvents)}\n`);
    await expect(jobs.events({ jobId: recordOnly, callerId: CALLER })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });

    const eventOnly = "cut:event-committed-event-only";
    await expect(jobs.submit({
      jobId: eventOnly, callerId: CALLER, lane: "ffmpeg", operation: "render.final",
      execute: async () => ({ ok: false, error: { code: "invalid_args", message: "ordinary failure", retryable: false } })
    })).resolves.toMatchObject({ ok: true });
    await terminal(jobs, eventOnly, CALLER, "failed");
    const eventOnlyEvents = JSON.parse(await readFile(eventPath(eventsRoot, eventOnly), "utf8")) as MotionJobCoordinatorEvent[];
    const eventOnlyTerminal = eventOnlyEvents.at(-1);
    if (!eventOnlyTerminal?.data) throw new Error("Expected failed terminal data.");
    eventOnlyTerminal.data.committed = true;
    await writeFile(eventPath(eventsRoot, eventOnly), `${JSON.stringify(eventOnlyEvents)}\n`);
    await expect(jobs.events({ jobId: eventOnly, callerId: CALLER })).resolves.toMatchObject({ ok: false, code: "capability_unavailable" });
  });
});
