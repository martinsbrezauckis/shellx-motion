/**
 * Cut and Design Studio, rendering at the same time, as real operating-system processes.
 *
 * Why this is not a unit test: every defect this file exists to catch lives in the gap between
 * processes. The job stores are a per-user directory precisely so a *different* process can answer
 * "what is my render doing", and an in-process test shares module state, so it cannot fail the way
 * production fails. Three defects in this subsystem were only ever found with real processes — an
 * unref'd retry timer that let a waiting process exit, Playwright's signal handlers killing the
 * host, and the lease-versus-record split — so the two-process form is the point.
 *
 * The scenario is the one ShellX Cut described: two independent hosts on one machine, each with its
 * own stable caller id, each naming its own job, both competing for one concurrency cap.
 *
 * What must hold:
 *  - Each host sees its own job while it is still running.
 *  - Neither host can see the other's, even though they share the machine's capacity.
 *  - The outcome is still readable after the rendering process has exited.
 *  - The cap holds across processes, so two hosts cannot each get the full allowance.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { MotionJobLeaseDirectory, MotionJobRegistry, MotionJobView } from "@shellx-motion/core";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * The host fixture is a real file in this package, not a script written to a temp directory: Node
 * resolves @shellx-motion/core by walking up from the importing file, and the workspace publishes
 * it as TypeScript source in development. Only a path inside the package resolves, and only tsx
 * can load it.
 */
const HOST_FIXTURE = fileURLToPath(new URL("./job-host.fixture.ts", import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

function runTsx(args: string[], options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {}) {
  return execFileAsync(process.execPath, [TSX_CLI, ...args], { ...options, encoding: "utf8" });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-two-hosts-"));
  tempRoots.push(root);
  const leaseRoot = join(root, "leases");
  const recordRoot = join(root, "records");
  const view = new MotionJobView({
    leases: new MotionJobLeaseDirectory({ leaseRoot }),
    records: new MotionJobRegistry({ recordRoot })
  });
  const spawnHost = (callerId: string, jobId: string, holdMs: number, readyName: string) => {
    const readyPath = join(root, readyName);
    const releasePath = join(root, `${readyName}.release`);
    const done = runTsx([
      HOST_FIXTURE, leaseRoot, recordRoot, callerId, jobId, String(holdMs), join(root, "scratch"), readyPath, releasePath
    ]);
    return { done, readyPath, release: () => writeFile(releasePath, "release") };
  };
  return { root, view, spawnHost, leases: new MotionJobLeaseDirectory({ leaseRoot }) };
}

async function waitForReady(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Host fixture never signalled admission at ${path}.`);
}

/**
 * Wait until a job reaches a state, as seen by its own caller.
 *
 * Every assertion below has to be anchored to an observed state rather than to elapsed time: a
 * freshly spawned host has not announced its lease yet, so an immediate query correctly answers
 * job_unknown and would make the visibility assertions pass for the wrong reason.
 */
async function waitFor(
  view: MotionJobView,
  jobId: string,
  callerId: string,
  lifecycle: "pending" | "running"
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const answer = await view.get({ jobId, callerId });
    if (answer.ok && answer.job.lifecycle === lifecycle) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} never reached ${lifecycle}.`);
}

describe("two hosts sharing one machine", () => {
  it("lets each host watch its own render and neither watch the other's", async () => {
    const { view, spawnHost } = await workspace();

    const cut = spawnHost("cut:workspace-7", "cut:render-1", 2_500, "cut.ready");
    await waitForReady(cut.readyPath);
    await waitFor(view, "cut:render-1", "cut:workspace-7", "running");
    const studio = spawnHost("design-studio:main", "ds:render-1", 400, "ds.ready");
    // Anchor on the studio job actually existing before asserting Cut cannot see it, so the
    // assertion tests the owner boundary rather than a process that has not started yet.
    await waitFor(view, "ds:render-1", "design-studio:main", "pending");

    // Cut's own job is visible to Cut, live, from this third process.
    const own = await view.get({ jobId: "cut:render-1", callerId: "cut:workspace-7" });
    expect(own).toMatchObject({ ok: true, job: { callerId: "cut:workspace-7", lifecycle: "running" } });

    // Design Studio's job exists and holds real capacity, but Cut may not read it. This is the
    // boundary Cut asked for: shared scheduling, separate evidence.
    const other = await view.get({ jobId: "ds:render-1", callerId: "cut:workspace-7" });
    expect(other).toEqual({ ok: false, code: "job_not_visible" });

    // And a list never leaks it either — the boundary is not only on the by-id path.
    const cutJobs = await view.list({ callerId: "cut:workspace-7" });
    expect(cutJobs.map((job) => job.jobId)).toEqual(["cut:render-1"]);

    await cut.release();
    await waitForReady(studio.readyPath);
    await studio.release();
    await Promise.all([cut.done, studio.done]);
  }, 60_000);

  it("still answers after the rendering process has exited", async () => {
    // The lease is gone the moment the process ends. Without a terminal record this is the query
    // that used to answer job_unknown for a job that had just succeeded.
    const { view, spawnHost } = await workspace();

    const host = spawnHost("cut:workspace-7", "cut:render-2", 100, "cut.ready");
    await waitForReady(host.readyPath);
    await host.release();
    const { done } = host;
    const { stdout } = await done;

    const reported = JSON.parse(stdout) as { jobId: string; state: string };
    // The id the child reports is the id the child was given: one value end to end.
    expect(reported.jobId).toBe("cut:render-2");

    const answer = await view.get({ jobId: "cut:render-2", callerId: "cut:workspace-7" });
    expect(answer).toMatchObject({
      ok: true,
      job: { jobId: "cut:render-2", lifecycle: "ended", outcome: "succeeded", state: "succeeded" }
    });
  }, 60_000);

  it("holds one concurrency cap across both hosts", async () => {
    // Each process caps itself at one job. Without machine-wide admission both would run at once
    // and the memory ceiling would be double what the policy promises.
    const { view, spawnHost, leases } = await workspace();

    const cut = spawnHost("cut:workspace-7", "cut:render-3", 1_500, "cut.ready");
    await waitForReady(cut.readyPath);
    await waitFor(view, "cut:render-3", "cut:workspace-7", "running");
    const studio = spawnHost("design-studio:main", "ds:render-3", 2_500, "ds.ready");

    // THE POINT: while Cut holds the machine's only rendering slot, Design Studio's job is visible
    // and honestly reports that it is WAITING, not working. Telling that caller "rendering..." for
    // 14 seconds while nothing is produced is the confusion this whole split exists to prevent.
    await waitFor(view, "ds:render-3", "design-studio:main", "pending");

    // And the cap really is what is holding it: at most one governed operation admitted machine-wide.
    const admitted = (await leases.readLiveLeases())
      .filter((lease) => lease.visibility !== "host" && lease.admitted);
    expect(admitted.length).toBeLessThanOrEqual(1);

    // Then it gets its turn.
    await cut.release();
    await waitForReady(studio.readyPath);
    await waitFor(view, "ds:render-3", "design-studio:main", "running");
    await studio.release();

    await Promise.all([cut.done, studio.done]);
    // Both eventually succeed: the cap delays work, it does not fail it.
    const studioJob = await view.get({ jobId: "ds:render-3", callerId: "design-studio:main" });
    expect(studioJob).toMatchObject({ ok: true, job: { outcome: "succeeded" } });
  }, 60_000);
});

/**
 * The connector path, which is the one ShellX Cut actually drives.
 *
 * `render` and `render-batch` were wrapped in a host job first and the connectors were not, so
 * `--job-id` and `--caller-id` were ACCEPTED on a connector command and bound to nothing. A Cut-side
 * review proved it the only way it can be proved: a real 50-second `connector template-to-cut`, polled
 * 60 times from a second process with the matching caller id, reported `jobCount: 0` every time.
 *
 * This is deliberately the real CLI running a real template render in a real child process. A faster
 * substitute — a stubbed connector, or an in-process call — cannot fail the way this failed, because
 * the defect was in the dispatch wiring between the flags and the job, not in any renderer.
 */
describe("the connector path Cut drives", () => {
  it("publishes exactly one observable job while a real connector render runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-job-"));
    tempRoots.push(root);
    const leaseRoot = join(root, "leases");
    const recordRoot = join(root, "records");
    const view = new MotionJobView({
      leases: new MotionJobLeaseDirectory({ leaseRoot }),
      records: new MotionJobRegistry({ recordRoot })
    });
    const caller = "cut:connector-test";
    const jobId = "cut:connector-test-1";

    const connector = runTsx([
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "connector", "template-to-cut",
      fileURLToPath(new URL("../../../templates/shellx-product-pack/feature-announcement", import.meta.url)),
      "--out", join(root, "out"),
      "--caller-id", caller, "--job-id", jobId
    ], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: { ...process.env, SHELLX_MOTION_LEASE_ROOT: leaseRoot, SHELLX_MOTION_JOB_RECORD_ROOT: recordRoot },
      maxBuffer: 32 * 1024 * 1024
    });

    // Own-caller visibility WHILE the render runs — the assertion that was failing.
    let liveStates: string[] = [];
    let sawLive = false;
    for (let attempt = 0; attempt < 400 && !sawLive; attempt += 1) {
      const answer = await view.get({ jobId, callerId: caller });
      if (answer.ok) {
        liveStates.push(answer.job.state);
        if (answer.job.lifecycle === "running") sawLive = true;
      }
      if (!sawLive) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(sawLive).toBe(true);
    expect(liveStates).toContain("running");

    // Exactly ONE visible job: the browser and ffmpeg work the connector performs stays internal.
    const mine = await view.list({ callerId: caller });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ jobId, operation: "connector.template_to_cut", lane: "connector" });

    // Cross-caller refusal, distinguishable from "no such job".
    await expect(view.get({ jobId, callerId: "design-studio:main" }))
      .resolves.toEqual({ ok: false, code: "job_not_visible" });

    const { stdout } = await connector;

    // Terminal lookup after the process is gone, and the id the connector reported is the same id.
    const ended = await view.get({ jobId, callerId: caller });
    expect(ended).toMatchObject({ ok: true, job: { jobId, lifecycle: "ended", outcome: "succeeded" } });
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, jobId });
  }, 300_000);

  it("rejects a malformed --job-id instead of crashing the command", async () => {
    // The ids are validated at the boundary that accepts them. Without this the CLI exits with a
    // stack trace, which is the one thing a host binding to these flags must never see.
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-job-"));
    tempRoots.push(root);

    // A rejected argument exits non-zero, so the payload arrives on the rejection rather than the
    // resolution. The assertion is that it is a REPORTED failure at all — before this, the command
    // died with an uncaught exception and no JSON envelope of any kind.
    const stdout = await runTsx([
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "connector", "template-to-cut",
      fileURLToPath(new URL("../../../templates/shellx-product-pack/feature-announcement", import.meta.url)),
      "--out", join(root, "out"),
      "--caller-id", "cut:x", "--job-id", "not/a/valid/id"
    ], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), maxBuffer: 8 * 1024 * 1024 })
      .then((result) => result.stdout)
      .catch((error: { stdout?: string }) => error.stdout ?? "");

    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: expect.stringMatching(/Motion job id must be/) }
    });
  }, 120_000);
});
