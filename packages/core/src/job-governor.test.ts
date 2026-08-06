import { lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MotionJobLeaseDirectory } from "./job-lease";
import {
  assertLocalMotionFrameBudget,
  assertLocalMotionFrameCountBudget,
  LocalMotionJobError,
  LocalMotionJobGovernor,
  prepareLocalMotionScratchRoot,
  sumBoundedProcessTreeRss,
  type LocalMotionJobPolicy,
} from "./job-governor";

const POLICY: LocalMotionJobPolicy = {
  maxConcurrentJobs: 1,
  maxQueueDepth: 2,
  maxQueueWaitMs: 1_000,
  maxWallClockMs: 1_000,
  minFreeScratchBytes: 100,
  scratchReservationBytes: 50,
  maxProcessTreeRssBytes: 64 * 1024 * 1024,
  rssPollIntervalMs: 25,
};

describe("local Motion job governor", () => {
  const tempRoots: string[] = [];
  // Governors built without explicit stores use the per-user runtime directory, which
  // scripts/vitest-setup-job-stores.ts redirects into a temp root for the whole run.
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("rejects oversized frame allocations and hostile frame counts before execution", () => {
    expect(() => assertLocalMotionFrameBudget({ width: 7_680, height: 4_320 })).not.toThrow();
    expect(() => assertLocalMotionFrameBudget({ width: 7_680, height: 4_320, deviceScaleFactor: 2 }))
      .toThrow(expect.objectContaining({ code: "job_input_budget_exceeded" }));
    expect(() => assertLocalMotionFrameBudget({ width: 100_000, height: 100_000 }))
      .toThrow(expect.objectContaining({ code: "job_input_budget_exceeded" }));
    expect(() => assertLocalMotionFrameCountBudget(216_000)).not.toThrow();
    expect(() => assertLocalMotionFrameCountBudget(Number.MAX_SAFE_INTEGER))
      .toThrow(expect.objectContaining({ code: "job_input_budget_exceeded" }));
  });

  it("serializes jobs through one shared admission limit and records queue evidence", async () => {
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
    const started: string[] = [];
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000 });
    const first = governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async () => {
      started.push("first");
      reportFirstStarted();
      await firstGate;
      return 1;
    });
    await firstStarted;
    const second = governor.run({ lane: "browser", operation: "preview.frames", scratchRoot: ".scratch/test" }, async () => {
      started.push("second");
      return 2;
    });
    await expect.poll(() => governor.snapshot(), { timeout: 1_000 }).toMatchObject({ activeJobs: 1, queuedJobs: 1 });
    expect(started).toEqual(["first"]);
    releaseFirst();
    expect((await first).value).toBe(1);
    const secondResult = await second;
    expect(secondResult.value).toBe(2);
    expect(secondResult.evidence.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(governor.snapshot()).toMatchObject({ activeJobs: 0, queuedJobs: 0 });
  });

  it("fails before execution when free scratch cannot cover the floor and reservation", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 149 });
    let ran = false;
    await expect(governor.run({ lane: "batch", operation: "render.batch", scratchRoot: ".scratch/test" }, async () => {
      ran = true;
    })).rejects.toMatchObject({
      code: "job_scratch_budget_failed",
      evidence: { state: "scratch_budget_failed", scratch: { freeBytesAtStart: 149, reservedBytes: 50, minFreeBytes: 100 } },
    });
    expect(ran).toBe(false);
    expect(governor.snapshot().activeJobs).toBe(0);
  });

  it("creates canonical scratch directories without traversing symlink or junction components", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-scratch-guard-"));
    const outside = await mkdtemp(join(tmpdir(), "shellx-motion-scratch-outside-"));
    try {
      const safeRoot = join(root, "safe", "nested");
      const prepared = await prepareLocalMotionScratchRoot(safeRoot);
      expect(prepared).toBe(await realpath(safeRoot));
      expect((await lstat(prepared)).isDirectory()).toBe(true);

      const link = join(root, "redirect");
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      await expect(prepareLocalMotionScratchRoot(join(link, "escaped"))).rejects.toMatchObject({
        code: "job_scratch_path_unsafe",
        message: "Motion job scratch root must be a canonical directory without symlink or reparse-point components."
      });
      await expect(lstat(join(outside, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it("records unsafe scratch admission as a typed non-execution result", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, {
      prepareScratchRoot: async () => {
        throw new LocalMotionJobError("job_scratch_path_unsafe", "unsafe scratch");
      },
      freeScratchBytes: async () => 1_000,
    });
    let ran = false;
    await expect(governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/unsafe" }, async () => {
      ran = true;
    })).rejects.toMatchObject({
      code: "job_scratch_path_unsafe",
      evidence: {
        state: "scratch_path_unsafe",
        scratch: { pathSafety: "canonical-no-symlink", freeBytesAtStart: 0 }
      }
    });
    expect(ran).toBe(false);
  });

  it("does not overbook one filesystem through different scratch directory names", async () => {
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
    const governor = new LocalMotionJobGovernor({ ...POLICY, maxConcurrentJobs: 2 }, { freeScratchBytes: async () => 180 });
    const first = governor.run({ lane: "ffmpeg", operation: "render.first", scratchRoot: ".scratch/one" }, async () => {
      reportFirstStarted();
      return firstGate;
    });
    await firstStarted;
    await expect(governor.run({ lane: "browser", operation: "render.second", scratchRoot: ".scratch/two" }, async () => undefined))
      .rejects.toMatchObject({ code: "job_scratch_budget_failed", evidence: { state: "scratch_budget_failed" } });
    releaseFirst();
    await first;
  });

  it("aborts a cooperative job after its wall-clock budget", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000 });
    await expect(governor.run({
      lane: "browser", operation: "preview.frames", scratchRoot: ".scratch/test", policy: { maxWallClockMs: 100 },
    }, async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    })).rejects.toMatchObject({ code: "job_deadline_exceeded", evidence: { state: "deadline_exceeded" } });
    expect(governor.snapshot().activeJobs).toBe(0);
  });

  it("aborts a watched process tree above the RSS budget", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, {
      freeScratchBytes: async () => 1_000,
      processTreeRssBytes: async () => 65 * 1024 * 1024,
    });
    await expect(governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async ({ signal, watchProcess }) => {
      watchProcess(42);
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    })).rejects.toMatchObject({
      code: "job_rss_limit_exceeded",
      evidence: { state: "rss_limit_exceeded", peakProcessTreeRssBytes: 65 * 1024 * 1024, watchedProcessCount: 1 },
    });
  });

  it("records one validated trusted process-containment mode in job evidence", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000 });
    const result = await governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async ({ scratchRoot, reportProcessContainment }) => {
      expect(scratchRoot).toContain(".scratch");
      reportProcessContainment({
        schema: "shellx-motion/process-containment@1",
        mode: "windows-job-object",
        status: "enforced",
        killTree: true,
        memoryLimit: "job-commit",
        maxJobMemoryBytes: 512 * 1024 * 1024,
        maxActiveProcesses: 64,
        launcher: { kind: "powershell-csharp", sha256: "a".repeat(64) },
      });
      return "ok";
    });

    expect(result.evidence.processContainment).toEqual({
      schema: "shellx-motion/process-containment@1",
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxJobMemoryBytes: 512 * 1024 * 1024,
      maxActiveProcesses: 64,
      launcher: { kind: "powershell-csharp", sha256: "a".repeat(64) },
    });
  });

  it("records requested runtime sandbox evidence without claiming enforcement", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000 });
    const result = await governor.run({ lane: "browser", operation: "preview.frame", scratchRoot: ".scratch/test" }, async ({ reportSandbox }) => {
      reportSandbox({
        schema: "shellx-motion/runtime-sandbox@1",
        provider: "chromium",
        status: "requested",
        scope: "browser-process",
      });
      return "ok";
    });

    expect(result.evidence.sandbox).toEqual({
      schema: "shellx-motion/runtime-sandbox@1",
      provider: "chromium",
      status: "requested",
      scope: "browser-process",
    });
  });

  it("rejects invalid or duplicate runtime sandbox reports", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000 });
    await expect(governor.run({ lane: "browser", operation: "preview.frame", scratchRoot: ".scratch/test" }, async ({ reportSandbox }) => {
      reportSandbox({
        schema: "shellx-motion/runtime-sandbox@1",
        provider: "chromium",
        status: "disabled",
        scope: "browser-process",
        reasonCode: "trusted_host_opt_out",
      });
      reportSandbox({
        schema: "shellx-motion/runtime-sandbox@1",
        provider: "chromium",
        status: "requested",
        scope: "browser-process",
      });
    })).rejects.toThrow("already reported");

    await expect(governor.run({ lane: "browser", operation: "preview.frame", scratchRoot: ".scratch/test" }, async ({ reportSandbox }) => {
      reportSandbox({
        schema: "shellx-motion/runtime-sandbox@1",
        provider: "chromium",
        status: "disabled",
        scope: "browser-process",
      });
    })).rejects.toThrow("requires the trusted host opt-out reason");
  });

  it("rejects invalid or duplicate containment reports before they can rewrite evidence", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000 });
    await expect(governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async ({ reportProcessContainment }) => {
      reportProcessContainment({
        schema: "shellx-motion/process-containment@1",
        mode: "unix-process-group",
        status: "enforced",
        killTree: true,
        memoryLimit: "rss-monitor",
      });
      reportProcessContainment({
        schema: "shellx-motion/process-containment@1",
        mode: "direct-child",
        status: "fallback",
        killTree: false,
        memoryLimit: "none",
      });
    })).rejects.toThrow("already reported");

    await expect(governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async ({ reportProcessContainment }) => {
      reportProcessContainment({
        schema: "shellx-motion/process-containment@1",
        mode: "windows-job-object",
        status: "fallback",
        killTree: false,
        memoryLimit: "none",
      });
    })).rejects.toThrow("must report enforced tree kill, native limits, and launcher identity");

    await expect(governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async ({ reportProcessContainment }) => {
      reportProcessContainment({
        schema: "shellx-motion/process-containment@1",
        mode: "windows-taskkill-fallback",
        status: "fallback",
        killTree: true,
        memoryLimit: "rss-monitor",
      });
    })).rejects.toThrow("must report a reasoned tree-kill fallback");

    await expect(governor.run({ lane: "browser", operation: "preview.frame", scratchRoot: ".scratch/test" }, async ({ reportProcessContainment }) => {
      reportProcessContainment({
        schema: "shellx-motion/process-containment@1",
        mode: "cooperative-browser-session",
        status: "enforced",
        killTree: true,
        memoryLimit: "rss-monitor",
        reasonCode: "worker_process_unavailable",
      });
    })).rejects.toThrow("must report PID-unavailable fallback close");
  });

  it("sums only one bounded process family for cross-platform RSS inspection", () => {
    expect(sumBoundedProcessTreeRss([
      { pid: 10, parentPid: 1, rssBytes: 100 },
      { pid: 11, parentPid: 10, rssBytes: 200 },
      { pid: 12, parentPid: 11, rssBytes: 300 },
      { pid: 99, parentPid: 1, rssBytes: 9_999 },
      { pid: "invalid", parentPid: 10, rssBytes: 50 }
    ], 10)).toBe(600);
    expect(() => sumBoundedProcessTreeRss([
      { pid: 10, parentPid: 1, rssBytes: 100 },
      { pid: 11, parentPid: 10, rssBytes: 200 },
      { pid: 12, parentPid: 11, rssBytes: 300 }
    ], 10, 2)).toThrow("Motion process tree exceeds the 2-process inspection budget.");
  });

  it("fails closed with a distinct code when RSS inspection itself is unavailable", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, {
      freeScratchBytes: async () => 1_000,
      processTreeRssBytes: async () => { throw new Error("private host detail"); },
    });
    await expect(governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async ({ signal, watchProcess }) => {
      watchProcess(42);
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    })).rejects.toMatchObject({
      code: "job_rss_inspection_failed",
      message: "Motion job RSS inspection failed.",
      evidence: { state: "failed" },
    });
  });

  it("removes a cancelled queued job without consuming the next slot", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000 });
    const first = governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async () => firstGate);
    const controller = new AbortController();
    const queued = governor.run({ lane: "quality", operation: "quality.check", scratchRoot: ".scratch/test", signal: controller.signal }, async () => undefined);
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(LocalMotionJobError);
    releaseFirst();
    await first;
    expect(governor.snapshot()).toMatchObject({ activeJobs: 0, queuedJobs: 0 });
  });

  it("does not start expensive work when cancellation arrives during scratch admission", async () => {
    let finishScratch!: (bytes: number) => void;
    const scratch = new Promise<number>((resolve) => { finishScratch = resolve; });
    let enteredScratch!: () => void;
    const inScratchAdmission = new Promise<void>((resolve) => { enteredScratch = resolve; });
    const governor = new LocalMotionJobGovernor(POLICY, {
      freeScratchBytes: async () => { enteredScratch(); return scratch; },
    });
    const controller = new AbortController();
    let ran = false;
    const job = governor.run({
      lane: "native",
      operation: "native.preview.frame",
      scratchRoot: ".scratch/test",
      signal: controller.signal,
    }, async () => { ran = true; });
    // Wait for admission before cancelling, so this exercises the path it names. Aborting straight
    // after run() now lands in the pre-admission check instead, which is a different code path with
    // a different (typed) error — covered by "removes a cancelled queued job" above.
    await inScratchAdmission;
    controller.abort();
    finishScratch(1_000);

    await expect(job).rejects.toMatchObject({ name: "AbortError" });
    expect(ran).toBe(false);
    expect(governor.snapshot()).toMatchObject({ activeJobs: 0, queuedJobs: 0 });
  });
  it("holds one concurrency cap across separate governor instances sharing a lease directory", async () => {
    // Two governors stand in for two Motion processes — a Cut agent and a CLI invocation. Before
    // machine-wide leases each counted only its own activeJobs, so a maxConcurrentJobs of 1
    // admitted both and the memory ceiling doubled.
    const leaseRoot = join(await mkdtemp(join(tmpdir(), "shellx-motion-governor-lease-")), "leases");
    tempRoots.push(leaseRoot);
    const alive = new Set([9001, 9002]);
    const clock = { now: 1_000 };
    const leasesFor = (pid: number) => new MotionJobLeaseDirectory({
      leaseRoot, pid, now: () => clock.now, isProcessAlive: (candidate) => alive.has(candidate)
    });
    const services = (pid: number) => ({ freeScratchBytes: async () => 1_000, leases: leasesFor(pid) });
    const cutProcess = new LocalMotionJobGovernor(POLICY, services(9001));
    const cliProcess = new LocalMotionJobGovernor(POLICY, services(9002));

    let releaseFirst!: () => void;
    let reportStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    const started: string[] = [];

    const first = cutProcess.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async () => {
      started.push("cut");
      reportStarted();
      await firstGate;
    });
    await firstStarted;

    const second = cliProcess.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async () => {
      started.push("cli");
    });
    // Give the second process room to admit itself if the cap were still process-local.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(started).toEqual(["cut"]);
    expect(cliProcess.snapshot()).toMatchObject({ machineWide: true });

    releaseFirst();
    await first;
    await second;
    expect(started).toEqual(["cut", "cli"]);
  });

  it("reports machineWide false when coordination is deliberately off", async () => {
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000, leases: null });
    // A single-process embedder can opt out; the snapshot must say so rather than imply a
    // machine-wide guarantee it is not making.
    expect(governor.snapshot()).toMatchObject({ machineWide: false });
    await governor.run({ lane: "ffmpeg", operation: "render.final", scratchRoot: ".scratch/test" }, async () => undefined);
  });
  it("records the caller identity a host supplied, so per-owner visibility is not inert", async () => {
    // Regression: acquireLease accepted callerId and never forwarded it to claim(). It type-checked
    // silently because claim treats callerId as optional and defaults to "unattributed", so every
    // job landed in one shared bucket and the whole owner boundary did nothing.
    const leaseRoot = join(await mkdtemp(join(tmpdir(), "shellx-motion-governor-caller-")), "leases");
    tempRoots.push(leaseRoot);
    const leases = new MotionJobLeaseDirectory({ leaseRoot, pid: 7001, isProcessAlive: () => true });
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000, leases });

    let observed: string[] = [];
    await governor.run(
      { lane: "browser", operation: "browser.preview.frames", scratchRoot: ".scratch/test", callerId: "cut:workspace-7" },
      async () => { observed = (await leases.readLiveLeases()).map((entry) => entry.callerId); }
    );

    expect(observed).toEqual(["cut:workspace-7"]);
  });

  it("falls back to an explicit unattributed owner when the host supplies none", async () => {
    const leaseRoot = join(await mkdtemp(join(tmpdir(), "shellx-motion-governor-anon-")), "leases");
    tempRoots.push(leaseRoot);
    const leases = new MotionJobLeaseDirectory({ leaseRoot, pid: 7002, isProcessAlive: () => true });
    const governor = new LocalMotionJobGovernor(POLICY, { freeScratchBytes: async () => 1_000, leases });

    let observed: string[] = [];
    await governor.run(
      { lane: "browser", operation: "browser.preview.frames", scratchRoot: ".scratch/test" },
      async () => { observed = (await leases.readLiveLeases()).map((entry) => entry.callerId); }
    );

    // Unattributed work still has AN owner, so it cannot accidentally match a named caller's query.
    expect(observed).toEqual(["unattributed"]);
  });
});
