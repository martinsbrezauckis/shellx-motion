/**
 * Coverage for machine-wide job admission.
 *
 * The defect these guard: the governor's concurrency counter lived in one process, so three
 * callers each got the full cap — a "2 concurrent jobs" policy admitted six renders and the
 * memory ceiling multiplied by the number of callers instead of holding.
 *
 * The safety posture matters as much as the coordination: a host whose runtime directory is
 * missing or read-only must still render, bounded process-locally, rather than fail closed.
 */
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { motionJobFileKey } from "./job-id-file";
import {
  defaultMotionJobLeaseRoot,
  LEASE_STALE_AFTER_MS,
  motionCallerId,
  MotionJobLeaseDirectory,
  UNATTRIBUTED_CALLER_ID
} from "./job-lease";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function leaseRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-lease-test-"));
  tempDirs.push(dir);
  return join(dir, "leases");
}

/** A lease directory standing in for one independent Motion process. */
function processView(root: string, pid: number, clock: { now: number }, alive: Set<number>): MotionJobLeaseDirectory {
  return new MotionJobLeaseDirectory({
    leaseRoot: root,
    pid,
    now: () => clock.now,
    isProcessAlive: (candidate) => alive.has(candidate)
  });
}

describe("machine-wide admission", () => {
  it("holds one concurrency cap across three independent processes", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([101, 102, 103]);
    const cut = processView(root, 101, clock, alive);
    const studio = processView(root, 102, clock, alive);
    const cli = processView(root, 103, clock, alive);

    // The exact scenario from the regression: three callers, a limit of 2.
    const first = await cut.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 2 });
    clock.now += 1;
    const second = await studio.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 2 });
    clock.now += 1;
    const third = await cli.claim({ jobId: "job-c", lane: "ffmpeg", operation: "render.final", limit: 2 });

    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    // Before this existed, the third caller counted only its own process and admitted itself.
    expect(third.admitted).toBe(false);
    expect(third.observed).toBe(3);
    expect(third.rank).toBe(2);
    expect(third.machineWide).toBe(true);
  });

  it("frees the slot for the next process when a holder releases", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([201, 202]);
    const holder = processView(root, 201, clock, alive);
    const waiter = processView(root, 202, clock, alive);

    const holderClaim = await holder.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });
    expect(holderClaim.run).not.toBeNull();
    clock.now += 1;
    expect((await waiter.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })).admitted).toBe(false);

    await holder.release(holderClaim.run!);
    clock.now += 1;

    expect((await waiter.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })).admitted).toBe(true);
  });

  it("removes its own lease when it loses, so a rejected claim consumes nothing", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([301, 302]);
    const holder = processView(root, 301, clock, alive);
    const loser = processView(root, 302, clock, alive);

    await holder.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });
    clock.now += 1;
    await loser.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 });

    // A losing claim that left its lease behind would permanently shrink the machine's capacity.
    expect((await holder.readLiveLeases()).map((entry) => entry.jobId)).toEqual(["job-a"]);
  });

  it("reclaims a slot from a process that died without releasing", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([401, 402]);
    const crashed = processView(root, 401, clock, alive);
    const survivor = processView(root, 402, clock, alive);

    await crashed.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });
    clock.now += 1;
    expect((await survivor.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })).admitted).toBe(false);

    // The process disappears without ever running its release path.
    alive.delete(401);
    clock.now += 1;

    expect((await survivor.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })).admitted).toBe(true);
    expect((await survivor.readLiveLeases()).map((entry) => entry.jobId)).toEqual(["job-b"]);
  });

  it("reclaims a slot from a live process that stopped heartbeating", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([501, 502]);
    const hung = processView(root, 501, clock, alive);
    const survivor = processView(root, 502, clock, alive);

    await hung.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });
    // The pid is still alive, but the holder is wedged and never refreshes.
    clock.now += LEASE_STALE_AFTER_MS + 1;

    expect((await survivor.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })).admitted).toBe(true);
  });

  it("keeps a slot for a holder that is still heartbeating", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([601, 602]);
    const holder = processView(root, 601, clock, alive);
    const other = processView(root, 602, clock, alive);

    const holderClaim = await holder.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });
    expect(holderClaim.run).not.toBeNull();
    // A long render that keeps reporting in must not be evicted.
    for (let tick = 0; tick < 20; tick += 1) {
      clock.now += LEASE_STALE_AFTER_MS / 2;
      await holder.heartbeat(holderClaim.run!);
    }

    expect((await other.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })).admitted).toBe(false);
  });

  it("orders admission deterministically, so racing processes agree on who goes first", async () => {
    const root = await leaseRoot();
    const clock = { now: 5_000 };
    const alive = new Set([701, 702, 703]);
    const a = processView(root, 701, clock, alive);
    const b = processView(root, 702, clock, alive);
    const c = processView(root, 703, clock, alive);

    // Same timestamp: the tie breaks on jobId, which every process computes identically.
    const results = [
      await c.claim({ jobId: "job-c", lane: "ffmpeg", operation: "render.final", limit: 1 }),
      await a.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 }),
      await b.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })
    ];

    // Exactly one wins, and it is the lowest jobId rather than whoever asked first.
    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    expect((await c.readLiveLeases()).map((entry) => entry.jobId)).toEqual(["job-c"]);
  });

  it("discards a corrupt lease rather than letting it consume a slot forever", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([801]);
    const view = processView(root, 801, clock, alive);
    const first = await view.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });
    expect(first.run).not.toBeNull();
    await view.release(first.run!);
    await writeFile(join(root, "garbage.lease.json"), "{ not json", "utf8");

    expect((await view.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 })).admitted).toBe(true);
    expect((await view.readLiveLeases()).map((entry) => entry.jobId)).toEqual(["job-b"]);
  });
});

describe("per-run lease capabilities", () => {
  it("keeps duplicate exact job ids as independent live admissions", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([851, 852, 853]);
    const firstProducer = processView(root, 851, clock, alive);
    const secondProducer = processView(root, 852, clock, alive);
    const thirdProducer = processView(root, 853, clock, alive);

    const first = await firstProducer.claim({ jobId: "shared:render", lane: "ffmpeg", operation: "render.final", limit: 2, callerId: "cut:A" });
    const second = await secondProducer.claim({ jobId: "shared:render", lane: "ffmpeg", operation: "render.final", limit: 2, callerId: "cut:B" });

    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(first.run?.runNonce).not.toBe(second.run?.runNonce);
    expect((await firstProducer.readLiveLeases())
      .filter((entry) => entry.jobId === "shared:render")
      .map((entry) => ({ pid: entry.pid, callerId: entry.callerId })))
      .toEqual(expect.arrayContaining([{ pid: 851, callerId: "cut:A" }, { pid: 852, callerId: "cut:B" }]));

    // Two equal public handles still consume two real slots. A third producer cannot sneak past
    // the cap just because a same-id run was overwritten or omitted from the order.
    const third = await thirdProducer.claim({ jobId: "other:render", lane: "ffmpeg", operation: "render.final", limit: 2 });
    expect(third).toMatchObject({ admitted: false, machineWide: true, observed: 3, rank: 2 });
  });

  it("does not recreate a released run when its heartbeat arrives late", async () => {
    const root = await leaseRoot();
    let clock = 1_000;
    const leases = new MotionJobLeaseDirectory({ leaseRoot: root, now: () => clock, isProcessAlive: () => true });
    const run = await leases.announce({ jobId: "late:heartbeat", lane: "ffmpeg", operation: "render.final" });
    expect(run).not.toBeNull();

    await leases.release(run!);
    clock += 1;
    await leases.heartbeat(run!);

    expect((await leases.readLiveLeases()).filter((entry) => entry.jobId === "late:heartbeat")).toEqual([]);
  });

  it("does not let an old run heartbeat or release mutate its successor", async () => {
    const root = await leaseRoot();
    let clock = 1_000;
    const leases = new MotionJobLeaseDirectory({ leaseRoot: root, now: () => clock, isProcessAlive: () => true });
    const oldRun = await leases.announce({ jobId: "reused:render", lane: "ffmpeg", operation: "render.final", callerId: "cut:A", visibility: "host" });
    expect(oldRun).not.toBeNull();
    await leases.release(oldRun!);

    clock = 2_000;
    const successor = await leases.announce({ jobId: "reused:render", lane: "browser", operation: "preview.frame", callerId: "cut:B", visibility: "host", admitted: true });
    expect(successor).not.toBeNull();
    await leases.heartbeat(oldRun!);
    await leases.release(oldRun!);

    const visible = await leases.readVisibleLease({ jobId: "reused:render", callerId: "cut:B" });
    expect(visible).toMatchObject({ ok: true, lease: { runNonce: successor!.runNonce, callerId: "cut:B", lane: "browser", admitted: true, heartbeatAtMs: 2_000 } });
    expect((await leases.readVisibleLease({ jobId: "reused:render", callerId: "cut:A" })))
      .toEqual({ ok: false, code: "job_not_visible" });
  });

  it("keeps bare job-id lifecycle calls away from nonce-protected runs", async () => {
    const root = await leaseRoot();
    let clock = 1_000;
    const leases = new MotionJobLeaseDirectory({ leaseRoot: root, now: () => clock, isProcessAlive: () => true });
    const run = await leases.announce({ jobId: "modern:run", lane: "ffmpeg", operation: "render.final", callerId: "cut:A", visibility: "host" });
    expect(run).not.toBeNull();

    clock = 2_000;
    await leases.heartbeat("modern:run");
    await leases.release("modern:run");

    const visible = await leases.readVisibleLease({ jobId: "modern:run", callerId: "cut:A" });
    expect(visible).toMatchObject({ ok: true, lease: { runNonce: run!.runNonce, heartbeatAtMs: 1_000 } });
  });
});

describe("degrading safely", () => {
  it("admits with machineWide false when the lease directory cannot be used", async () => {
    // A path under a regular file can never be created, standing in for a read-only or
    // otherwise unusable runtime directory.
    const blocker = await mkdtemp(join(tmpdir(), "shellx-motion-lease-blocked-"));
    tempDirs.push(blocker);
    const filePath = join(blocker, "not-a-directory");
    await writeFile(filePath, "", "utf8");
    const view = new MotionJobLeaseDirectory({ leaseRoot: join(filePath, "leases"), pid: 901, now: () => 1_000 });

    const claim = await view.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });

    // Coordination is an optimisation over a correctness floor: a host must still render.
    expect(claim.admitted).toBe(true);
    expect(claim.machineWide).toBe(false);
    expect(view.isDegraded).toBe(true);
  });

  it("stops retrying the filesystem once it has degraded", async () => {
    const blocker = await mkdtemp(join(tmpdir(), "shellx-motion-lease-blocked2-"));
    tempDirs.push(blocker);
    const filePath = join(blocker, "not-a-directory");
    await writeFile(filePath, "", "utf8");
    const view = new MotionJobLeaseDirectory({ leaseRoot: join(filePath, "leases"), pid: 902, now: () => 1_000 });

    await view.claim({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", limit: 1 });
    const second = await view.claim({ jobId: "job-b", lane: "ffmpeg", operation: "render.final", limit: 1 });

    expect(second).toMatchObject({ admitted: true, machineWide: false, observed: 0, rank: null, run: null });
  });
});

describe("lease root selection", () => {
  it("prefers an explicit override, then the user runtime directory", () => {
    expect(defaultMotionJobLeaseRoot({ SHELLX_MOTION_LEASE_ROOT: "/custom/leases" })).toBe("/custom/leases");
    expect(defaultMotionJobLeaseRoot({ XDG_RUNTIME_DIR: "/run/user/1000" }))
      .toBe(join("/run/user/1000", "shellx-motion", "job-leases"));
    expect(defaultMotionJobLeaseRoot({ LOCALAPPDATA: "C:\\Users\\U\\AppData\\Local" }))
      .toContain("job-leases");
  });

  it("namespaces the fallback per user so a shared machine does not mix leases", () => {
    const fallback = defaultMotionJobLeaseRoot({});
    // Per-user scope is the documented boundary; a world-shared path would be a security change.
    expect(fallback.startsWith(tmpdir())).toBe(true);
    expect(fallback).toMatch(/shellx-motion-[^/]+[\\/]job-leases$/);
  });

  it.skipIf(process.platform === "win32")("refuses a preclaimed shared-write fallback root and degrades safely", async () => {
    const parent = await mkdtemp(join(tmpdir(), "shellx-motion-lease-preclaim-"));
    tempDirs.push(parent);
    const root = join(parent, "job-leases");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o777);
    const leases = new MotionJobLeaseDirectory({ leaseRoot: root, pid: 991, now: () => 1_000 });

    await expect(leases.claim({ jobId: "preclaimed", lane: "ffmpeg", operation: "render.final", limit: 1 }))
      .resolves.toMatchObject({ admitted: true, machineWide: false, run: null });
    expect(leases.isDegraded).toBe(true);
  });
});

describe("visibility is a boundary, not a filter", () => {
  /**
   * Two hosts and an operator surface, all sharing one machine.
   *
   * These are host jobs: the owner boundary is what a reporting surface enforces, and reporting
   * only ever shows work a host asked for. The resource admissions Motion makes to satisfy them
   * are internal and never listed — see the visibility field on the lease record.
   */
  async function threeOwners() {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const alive = new Set([1101, 1102]);
    const cut = processView(root, 1101, clock, alive);
    const studio = processView(root, 1102, clock, alive);
    // Announced, not claimed: these are host jobs, which are reported and never ranked. Claiming
    // is for the governed operations underneath them.
    await cut.announce({ jobId: "job-cut-1", lane: "ffmpeg", operation: "render.final", callerId: "cut:workspace-7", visibility: "host", admitted: true });
    clock.now += 1;
    await cut.announce({ jobId: "job-cut-2", lane: "browser", operation: "preview.frame", callerId: "cut:workspace-7", visibility: "host", admitted: true });
    clock.now += 1;
    await studio.announce({ jobId: "job-studio-1", lane: "ffmpeg", operation: "render.final", callerId: "design-studio:main", visibility: "host", admitted: true });
    return { cut, studio, clock };
  }

  it("shows a caller only its own work by default", async () => {
    const { cut } = await threeOwners();

    const mine = await cut.readVisibleLeases({ callerId: "cut:workspace-7"});

    expect(mine.map((entry) => entry.jobId).sort()).toEqual(["job-cut-1", "job-cut-2"]);
  });

  it("never leaks another host's jobs, even though they share the machine's capacity", async () => {
    const { cut } = await threeOwners();

    const mine = await cut.readVisibleLeases({ callerId: "cut:workspace-7"});

    // Design Studio's job is real, is running, and counts against the cap — but Cut's agent
    // must not be able to enumerate it.
    expect(mine.some((entry) => entry.callerId === "design-studio:main")).toBe(false);
    // Scheduling is global even though visibility is not: all three still hold capacity.
    expect(await cut.readLiveLeases()).toHaveLength(3);
  });

  it("distinguishes a job that does not exist from one that is not yours", async () => {
    const { cut } = await threeOwners();

    const missing = await cut.readVisibleLease({ jobId: "job-nope", callerId: "cut:workspace-7"});
    const someoneElses = await cut.readVisibleLease({ jobId: "job-studio-1", callerId: "cut:workspace-7"});

    // Told "unknown" for a job that exists, an agent concludes Motion lost the work.
    expect(missing).toEqual({ ok: false, code: "job_unknown" });
    expect(someoneElses).toEqual({ ok: false, code: "job_not_visible" });
  });

  it("lets an explicitly granted operator scope see everything", async () => {
    const { cut } = await threeOwners();

    const all = await cut.readVisibleLeases({ callerId: "cut:workspace-7", scope: "all" });
    const one = await cut.readVisibleLease({ jobId: "job-studio-1", callerId: "cut:workspace-7", scope: "all" });

    expect(all).toHaveLength(3);
    expect(one.ok).toBe(true);
  });

  it("records an owner for work whose caller supplied none", async () => {
    const root = await leaseRoot();
    const clock = { now: 1_000 };
    const view = processView(root, 1201, clock, new Set([1201]));

    await view.announce({ jobId: "job-a", lane: "ffmpeg", operation: "render.final", visibility: "host", admitted: true });

    // Unattributed work still has AN owner, so it cannot accidentally match every query.
    const visible = await view.readVisibleLeases({ callerId: UNATTRIBUTED_CALLER_ID });
    expect(visible.map((entry) => entry.jobId)).toEqual(["job-a"]);
    expect(await view.readVisibleLeases({ callerId: "cut:workspace-7" })).toEqual([]);
  });
});

describe("motionCallerId", () => {
  it("prefers an explicit host-chosen id", () => {
    expect(motionCallerId({ callerId: "cut:workspace-7", transport: "cli", label: "claude" })).toBe("cut:workspace-7");
  });

  it("falls back to a value stable across a host's processes", () => {
    // Deliberately not a pid or per-connection session id: a fresh CLI process must be able to
    // see the job it started a moment ago.
    expect(motionCallerId({ transport: "cli", label: "claude-code" })).toBe("cli:claude-code");
    expect(motionCallerId({ label: "claude-code" })).toBe("claude-code");
    expect(motionCallerId({ transport: "mcp" })).toBe("mcp");
    expect(motionCallerId(undefined)).toBe(UNATTRIBUTED_CALLER_ID);
  });
});

/**
 * Job ids that differ only in characters the filename encoding used to fold together.
 *
 * `leasePath` once folded every disallowed
 * character to `-`, so `cut:render-42` and `cut-render-42` — both legal ids, and the first is the
 * form this product documents to Cut — shared ONE lease file. A second caller starting a render
 * silently destroyed the first caller's live lease, and the victim's still-running job answered
 * `job_unknown`. No authentication of any kind was required.
 */
describe("job id filename collisions", () => {
  it("keeps two ids that fold to the same string in separate leases", async () => {
    const root = await leaseRoot();
    const leases = new MotionJobLeaseDirectory({ leaseRoot: root });
    await leases.announce({ jobId: "a:b", lane: "ffmpeg", operation: "render.final", callerId: "A", visibility: "host", admitted: true });
    await leases.announce({ jobId: "a-b", lane: "ffmpeg", operation: "render.final", callerId: "B", visibility: "host", admitted: true });

    expect((await readdir(root)).length).toBe(2);
    const first = await leases.readVisibleLease({ jobId: "a:b", callerId: "A" });
    const second = await leases.readVisibleLease({ jobId: "a-b", callerId: "B" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.ok && first.lease.callerId).toBe("A");
    expect(second.ok && second.lease.callerId).toBe("B");
  });

  // Asserted on the KEY, not on the directory: this machine is Linux, where the old encoding kept
  // "Render-1" and "render-1" apart anyway. The defect only appears on the case-insensitive
  // filesystems Motion also ships to (Windows, macOS), so the property to pin is that the two names
  // differ even when compared case-insensitively — which a filename-shaped test here cannot observe.
  it("keeps ids that differ only by case apart on a case-insensitive filesystem", () => {
    expect(motionJobFileKey("Render-1").toLowerCase()).not.toBe(motionJobFileKey("render-1").toLowerCase());
  });

  it("releasing one job leaves the other caller's lease alone", async () => {
    const root = await leaseRoot();
    const leases = new MotionJobLeaseDirectory({ leaseRoot: root });
    await leases.announce({ jobId: "a:b", lane: "ffmpeg", operation: "render.final", callerId: "A", visibility: "host", admitted: true });
    const secondRun = await leases.announce({ jobId: "a-b", lane: "ffmpeg", operation: "render.final", callerId: "B", visibility: "host", admitted: true });
    expect(secondRun).not.toBeNull();
    await leases.release(secondRun!);

    const survivor = await leases.readVisibleLease({ jobId: "a:b", callerId: "A" });
    expect(survivor.ok).toBe(true);
    expect((await leases.readVisibleLease({ jobId: "a-b", callerId: "B" })).ok).toBe(false);
  });
});

/**
 * The queue wait a caller polls must be the queue wait that happened.
 *
 * The defect this guards: `markRunning()` re-announces with `admitted: true`, and `announce()`
 * recomputed `startedAtMs` from the clock each time. A job that waited 4.9s reported
 * `queueWaitMs: 0` and a `createdAtMs` 4.9s later than the truth for its entire run — correct only
 * once it ended and the terminal record, built from another source, replaced it.
 */
describe("announce preserves request time across promotion", () => {
  it("keeps startedAtMs from the first announce when the job is later admitted", async () => {
    const root = await leaseRoot();
    let clock = 1_000;
    const leases = new MotionJobLeaseDirectory({ leaseRoot: root, now: () => clock });
    const run = await leases.announce({ jobId: "q1", lane: "ffmpeg", operation: "render.final", callerId: "A", visibility: "host" });
    expect(run).not.toBeNull();
    clock = 6_000;
    await leases.announce({ jobId: "q1", lane: "ffmpeg", operation: "render.final", callerId: "A", visibility: "host", admitted: true, run: run! });

    const answer = await leases.readVisibleLease({ jobId: "q1", callerId: "A" });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.lease.startedAtMs).toBe(1_000);
    expect(answer.lease.admittedAtMs).toBe(6_000);
    expect((answer.lease.admittedAtMs ?? 0) - answer.lease.startedAtMs).toBe(5_000);
  });
});
