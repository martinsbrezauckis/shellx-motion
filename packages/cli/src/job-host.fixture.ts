/**
 * A standalone Motion host process, used by `job-two-hosts.test.ts`.
 *
 * Role: stand in for ShellX Cut or Design Studio running Motion on a shared machine. It runs one
 * governed job under a caller id and job id supplied on the command line, holds the job open for a
 * fixed time or a parent-created release signal, and prints the resulting evidence as JSON.
 *
 * It runs a governed job rather than a real render on purpose: the subject under test is job
 * identity and cross-process visibility, and a real encode would add minutes and an ffmpeg
 * dependency without exercising one additional line of it. The release signal makes an observed
 * running state independent of scheduler speed without weakening the real cross-process boundary.
 *
 * This is a fixture, not a test — it is a real file in the package rather than a script written to
 * a temp directory because Node resolves `@shellx-motion/core` by walking up from the importing
 * file, and the workspace publishes that package as TypeScript source in development. A script
 * outside the package tree cannot resolve it, and a plain `node` child cannot load it. Run with
 * `tsx`.
 *
 * Usage: tsx job-host.fixture.ts <leaseRoot> <recordRoot> <callerId> <jobId> <holdMs> <scratchRoot> [readyPath] [releasePath]
 */
import { access, writeFile } from "node:fs/promises";
import {
  LocalMotionJobGovernor,
  MotionHostJob,
  runInMotionHostJob,
  MotionJobLeaseDirectory,
  MotionJobRegistry,
  type LocalMotionJobPolicy
} from "@shellx-motion/core";

const [leaseRoot, recordRoot, callerId, jobId, holdMs, scratchRoot, readyPath, releasePath] = process.argv.slice(2);

async function waitForRelease(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Parent did not release the admitted fixture job.");
}

/** One slot, so two of these processes must take turns — which is the point of the cap test. */
const POLICY: LocalMotionJobPolicy = {
  maxConcurrentJobs: 1,
  maxQueueDepth: 8,
  maxQueueWaitMs: 30_000,
  maxWallClockMs: 30_000,
  minFreeScratchBytes: 0,
  scratchReservationBytes: 0,
  maxProcessTreeRssBytes: 64 * 1024 * 1024,
  rssPollIntervalMs: 250
};

const leases = new MotionJobLeaseDirectory({ leaseRoot });
const records = new MotionJobRegistry({ recordRoot });
const governor = new LocalMotionJobGovernor(POLICY, {
  freeScratchBytes: async () => 1_000_000_000,
  leases
});

// Exactly the shape a host uses: one named job for what was asked for, wrapping the governed
// operations performed to deliver it. The host job is what `motion.job.*` reports; the governed
// operation is what takes a slot.
const job = await MotionHostJob.begin({ jobId, callerId, lane: "ffmpeg", operation: "render.final", leases, records });
try {
  // Inside the job's async context — that is what lets the governor promote the host job from
  // pending to running when the operation is admitted. A host that forgets this wrapper gets a job
  // stuck at `pending` for its whole life.
  const { evidence } = await runInMotionHostJob(job, () => governor.run(
    { lane: "ffmpeg", operation: "ffmpeg.render", scratchRoot, callerId },
    async () => {
      // Signal that the work is genuinely admitted and running, so the test observes a live job
      // instead of racing process startup.
      if (readyPath) await writeFile(readyPath, "running");
      if (releasePath) await waitForRelease(releasePath);
      else await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
    }
  ));
  await job.succeeded();
  process.stdout.write(JSON.stringify({ jobId: job.jobId, state: evidence.state }));
} catch (error) {
  await job.failed({ error: { code: "job_queue_timeout", message: error instanceof Error ? error.message : "failed" } });
  process.stdout.write(JSON.stringify({ jobId: job.jobId, state: "failed" }));
  process.exitCode = 1;
}
