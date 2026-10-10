import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MotionJobIdentityClaimStore,
  type MotionJobIdentityClaimAdmissionIntent
} from "./job-identity-claim-store";
import { motionJobOwnerKey } from "./job-id-file";
import { OutputPathTopology } from "./output-path-topology";
import { PrivateMotionRuntimeDirectory } from "./private-runtime-directory";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { canonicalJson } from "./canonical-json";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

const CALLER = "cut:claim-owner";
const JOB = "cut:claim-id";
const LEGACY: MotionJobIdentityClaimAdmissionIntent = Object.freeze({ mode: "legacy-planless" });
const PLANNED: MotionJobIdentityClaimAdmissionIntent = Object.freeze({ mode: "planned", planFingerprint: "a".repeat(64) });
const OTHER_PLANNED: MotionJobIdentityClaimAdmissionIntent = Object.freeze({ mode: "planned", planFingerprint: "b".repeat(64) });

interface Fixture {
  readonly root: string;
  readonly claimRoot: string;
  readonly alive: Set<number>;
  readonly clock: { now: number };
  readonly trusted: <T>(operation: () => Promise<T>) => Promise<T>;
  store(pid: number, isProcessAlive?: (pid: number) => boolean): MotionJobIdentityClaimStore;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), ".scratch-job-identity-claim-"));
  roots.push(root);
  const claimRoot = join(root, "claims");
  const alive = new Set<number>();
  const clock = { now: 1_000 };
  return {
    root,
    claimRoot,
    alive,
    clock,
    trusted: async <T>(operation: () => Promise<T>) => await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation),
    store: (pid, isProcessAlive = (candidate) => alive.has(candidate)) => new MotionJobIdentityClaimStore({
      claimRoot, pid, now: () => clock.now, isProcessAlive
    })
  };
}

function input(admission: MotionJobIdentityClaimAdmissionIntent = LEGACY) {
  return { callerId: CALLER, jobId: JOB, admission };
}

function ownerKey(): string {
  return motionJobOwnerKey(CALLER, JOB);
}

async function statePath(claimRoot: string): Promise<string> {
  const entry = (await readdir(claimRoot)).find((name) => name.endsWith(".claim"));
  if (!entry) throw new Error("Expected claim state directory.");
  return join(claimRoot, entry, "claim.json");
}

// Every fixture enters a trusted workspace anchor, which is POSIX-only.
describe.skipIf(process.platform === "win32")("MotionJobIdentityClaimStore", () => {
  it("inspects a missing claim root without creating it", async () => {
    const state = await fixture();
    await expect(state.trusted(async () => await state.store(11).inspect({ callerId: CALLER, jobId: JOB })))
      .resolves.toEqual({ ok: true, kind: "missing" });
    await expect(lstat(state.claimRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses a missing claim root beneath a symlinked ancestor without creating it", async () => {
    const state = await fixture();
    const trusted = join(state.root, "trusted");
    const target = join(state.root, "target");
    await mkdir(trusted, { mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(trusted, "redirect"), "dir");
    const unsafeRoot = join(trusted, "redirect", "claims");
    const store = new MotionJobIdentityClaimStore({ claimRoot: unsafeRoot, pid: 111, isProcessAlive: () => true });

    await expect(state.trusted(async () => await store.inspect({ callerId: CALLER, jobId: JOB })))
      .resolves.toEqual({ ok: false, code: "claim_unavailable" });
    await expect(lstat(join(target, "claims"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses a symlink inserted at a missing intermediate inspection route", async () => {
    const state = await fixture();
    const intermediate = join(state.root, "missing-route");
    const target = join(state.root, "redirect-target");
    await mkdir(target, { mode: 0o700 });
    const store = new MotionJobIdentityClaimStore({ claimRoot: join(intermediate, "claims"), pid: 112, isProcessAlive: () => true });
    const inspect = OutputPathTopology.inspect;
    let inserted = false;
    const inspectSpy = vi.spyOn(OutputPathTopology, "inspect").mockImplementation(async (path) => {
      const topology = await inspect(path);
      if (!inserted) { inserted = true; await symlink(target, intermediate, "dir"); }
      return topology;
    });
    try {
      await expect(state.trusted(async () => await store.inspect({ callerId: CALLER, jobId: JOB })))
        .resolves.toEqual({ ok: false, code: "claim_unavailable" });
      expect(inserted).toBe(true);
      await expect(lstat(join(target, "claims"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      inspectSpy.mockRestore();
    }
  });

  it("inspects exact held claim bytes and inode identities without mutation", async () => {
    const state = await fixture();
    state.alive.add(12);
    const store = state.store(12);
    const acquired = await state.trusted(async () => await store.acquire(input(PLANNED)));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const before = await claimFilesystemFacts(state.claimRoot);

    await expect(state.trusted(async () => await store.inspect({ callerId: CALLER, jobId: JOB }))).resolves.toMatchObject({
      ok: true, kind: "held", liveness: "live", claim: { admission: PLANNED, phase: "claimed", pid: 12 }
    });
    await expect(claimFilesystemFacts(state.claimRoot)).resolves.toEqual(before);
  });

  it("inspects only the requested owner identity and rejects a copied foreign pointer", async () => {
    const state = await fixture();
    const ownerA = { callerId: "cut:inspect-owner-a", jobId: "cut:inspect-id-a", admission: LEGACY };
    const ownerB = { callerId: "cut:inspect-owner-b", jobId: "cut:inspect-id-b", admission: PLANNED };
    state.alive.add(13);
    const store = state.store(13);
    const claimedB = await state.trusted(async () => await store.acquire(ownerB));
    if (!claimedB.ok) throw new Error("B claim was not acquired.");
    await expect(state.trusted(async () => await store.inspect(ownerA))).resolves.toEqual({ ok: true, kind: "missing" });
    await expect(state.trusted(async () => await store.inspect(ownerB))).resolves.toMatchObject({
      ok: true, kind: "held", claim: { admission: PLANNED, pid: 13 }
    });

    const pointerB = join(state.claimRoot, `${motionJobOwnerKey(ownerB.callerId, ownerB.jobId)}.claim-pointer.json`);
    const pointerA = join(state.claimRoot, `${motionJobOwnerKey(ownerA.callerId, ownerA.jobId)}.claim-pointer.json`);
    await writeFile(pointerA, await readFile(pointerB), { mode: 0o600 });
    await expect(state.trusted(async () => await store.inspect(ownerA))).resolves.toEqual({ ok: false, code: "claim_invalid" });
    await expect(state.trusted(async () => await store.inspect(ownerB))).resolves.toMatchObject({ ok: true, kind: "held", claim: { pid: 13 } });
  });

  it("inspects every durable claim phase, including settling and terminal recording", async () => {
    const state = await fixture();
    state.alive.add(14);
    const store = state.store(14);
    const acquired = await state.trusted(async () => await store.acquire(input(PLANNED)));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    for (const phase of ["claimed", "admission_bound", "plan_bound", "host_lease_published", "submitted", "executing", "settling", "terminal_evidence", "terminal_recorded"] as const) {
      if (phase !== "claimed") await expect(state.trusted(async () => await acquired.handle.advance(phase))).resolves.toMatchObject({ ok: true });
      await expect(state.trusted(async () => await store.inspect({ callerId: CALLER, jobId: JOB })))
        .resolves.toMatchObject({ ok: true, kind: "held", liveness: "live", claim: { phase, admission: PLANNED } });
    }
  });

  it("reports live, dead, and unknown inspection liveness without changing claim ownership", async () => {
    const state = await fixture();
    const owner = state.store(15, () => true);
    const acquired = await state.trusted(async () => await owner.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    await expect(state.trusted(async () => await state.store(16, () => true).inspect({ callerId: CALLER, jobId: JOB })))
      .resolves.toMatchObject({ ok: true, kind: "held", liveness: "live" });
    await expect(state.trusted(async () => await state.store(17, () => false).inspect({ callerId: CALLER, jobId: JOB })))
      .resolves.toMatchObject({ ok: true, kind: "held", liveness: "dead" });
    const untyped = (() => undefined) as unknown as (pid: number) => boolean;
    await expect(state.trusted(async () => await state.store(18, untyped).inspect({ callerId: CALLER, jobId: JOB })))
      .resolves.toMatchObject({ ok: true, kind: "held", liveness: "unknown" });
    const throwing = (() => { throw new Error("liveness unavailable"); }) as unknown as (pid: number) => boolean;
    await expect(state.trusted(async () => await state.store(19, throwing).inspect({ callerId: CALLER, jobId: JOB })))
      .resolves.toMatchObject({ ok: true, kind: "held", liveness: "unknown" });

    const killSpy = vi.spyOn(process, "kill");
    try {
      killSpy.mockImplementation((() => { throw errno("EPERM"); }) as never);
      await expect(state.trusted(async () => await new MotionJobIdentityClaimStore({ claimRoot: state.claimRoot, pid: 20 }).inspect({ callerId: CALLER, jobId: JOB })))
        .resolves.toMatchObject({ ok: true, kind: "held", liveness: "live" });
      killSpy.mockImplementation((() => { throw errno("ESRCH"); }) as never);
      await expect(state.trusted(async () => await new MotionJobIdentityClaimStore({ claimRoot: state.claimRoot, pid: 21 }).inspect({ callerId: CALLER, jobId: JOB })))
        .resolves.toMatchObject({ ok: true, kind: "held", liveness: "dead" });
      killSpy.mockImplementation((() => { throw errno("EIO"); }) as never);
      await expect(state.trusted(async () => await new MotionJobIdentityClaimStore({ claimRoot: state.claimRoot, pid: 22 }).inspect({ callerId: CALLER, jobId: JOB })))
        .resolves.toMatchObject({ ok: true, kind: "held", liveness: "unknown" });
    } finally {
      killSpy.mockRestore();
    }
    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toMatchObject({ ok: true, claim: { pid: 15 } });
  });

  it("fails closed when inspection sees corrupt pointer/state data or a replaced root", async () => {
    const state = await fixture();
    state.alive.add(23);
    const store = state.store(23);
    const acquired = await state.trusted(async () => await store.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const pointer = join(state.claimRoot, `${ownerKey()}.claim-pointer.json`);
    await writeFile(pointer, "{bad-json}", { mode: 0o600 });
    await expect(state.trusted(async () => await store.inspect({ callerId: CALLER, jobId: JOB }))).resolves.toEqual({ ok: false, code: "claim_invalid" });

    const separate = await fixture();
    separate.alive.add(24);
    const separateStore = separate.store(24);
    const second = await separate.trusted(async () => await separateStore.acquire(input()));
    if (!second.ok) throw new Error("Second claim was not acquired.");
    await writeFile(await statePath(separate.claimRoot), "{bad-json}", { mode: 0o600 });
    await expect(separate.trusted(async () => await separateStore.inspect({ callerId: CALLER, jobId: JOB }))).resolves.toEqual({ ok: false, code: "claim_invalid" });

    const replacement = `${separate.claimRoot}-replaced`;
    await rename(separate.claimRoot, replacement);
    await mkdir(separate.claimRoot, { mode: 0o700 });
    await expect(separate.trusted(async () => await separateStore.inspect({ callerId: CALLER, jobId: JOB }))).resolves.toEqual({ ok: false, code: "claim_unavailable" });
  });

  it("does not adopt a valid replacement root after retained inspection authority is asserted", async () => {
    const state = await fixture();
    state.alive.add(28);
    state.alive.add(29);
    const store = state.store(28);
    const acquired = await state.trusted(async () => await store.acquire(input(PLANNED)));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const replacementRoot = join(state.root, "replacement-claims");
    const replacementStore = new MotionJobIdentityClaimStore({ claimRoot: replacementRoot, pid: 29, isProcessAlive: (candidate) => state.alive.has(candidate) });
    const replacement = await state.trusted(async () => await replacementStore.acquire(input(PLANNED)));
    if (!replacement.ok) throw new Error("Replacement claim was not acquired.");
    const retained = `${state.claimRoot}-retained`;
    const assertCurrent = PrivateMotionRuntimeDirectory.prototype.assertCurrent;
    let swapped = false;
    const assertSpy = vi.spyOn(PrivateMotionRuntimeDirectory.prototype, "assertCurrent").mockImplementation(async function (this: PrivateMotionRuntimeDirectory) {
      await assertCurrent.call(this);
      if (!swapped) { swapped = true; await rename(state.claimRoot, retained); await rename(replacementRoot, state.claimRoot); }
    });
    try {
      await expect(state.trusted(async () => await store.inspect({ callerId: CALLER, jobId: JOB })))
        .resolves.toEqual({ ok: false, code: "claim_unavailable" });
      expect(swapped).toBe(true);
    } finally {
      assertSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("fails closed for inspection through a claim leaf or root symlink", async () => {
    const state = await fixture();
    state.alive.add(25);
    const store = state.store(25);
    const acquired = await state.trusted(async () => await store.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const claimState = await statePath(state.claimRoot);
    const outside = join(state.root, "outside-inspection-claim.json");
    await writeFile(outside, "{}", { mode: 0o600 });
    await unlink(claimState);
    await symlink(outside, claimState);
    await expect(state.trusted(async () => await store.inspect({ callerId: CALLER, jobId: JOB }))).resolves.toEqual({ ok: false, code: "claim_invalid" });

    const target = await mkdtemp(join(process.cwd(), ".scratch-job-identity-claim-inspect-target-"));
    roots.push(target);
    const unsafeRoot = join(state.root, "unsafe-inspection-claims");
    await symlink(target, unsafeRoot, "dir");
    const throughSymlink = new MotionJobIdentityClaimStore({ claimRoot: unsafeRoot, pid: 26, isProcessAlive: () => true });
    await expect(state.trusted(async () => await throughSymlink.inspect({ callerId: CALLER, jobId: JOB }))).resolves.toEqual({ ok: false, code: "claim_unavailable" });

    const publicRoot = join(state.root, "public-inspection-claims");
    await mkdir(publicRoot, { mode: 0o700 });
    await chmod(publicRoot, 0o755);
    const publicStore = new MotionJobIdentityClaimStore({ claimRoot: publicRoot, pid: 27, isProcessAlive: () => true });
    await expect(state.trusted(async () => await publicStore.inspect({ callerId: CALLER, jobId: JOB }))).resolves.toEqual({ ok: false, code: "claim_unavailable" });
  });

  it("atomically gives two independent store instances one opaque owner-qualified claimant", async () => {
    const state = await fixture();
    state.alive.add(101);
    state.alive.add(202);
    const first = state.store(101);
    const second = state.store(202);
    const [a, b] = await state.trusted(async () => await Promise.all([first.acquire(input()), second.acquire(input())]));
    const successes = [a, b].filter((result) => result.ok);
    const held = [a, b].find((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(held).toMatchObject({ ok: false, code: "claim_held", claim: { admission: LEGACY, phase: "claimed" } });
    const names = await readdir(state.claimRoot);
    expect(names).toContain(`${ownerKey()}.claim-pointer.json`);
    expect(names.some((name) => name.includes(CALLER) || name.includes(JOB))).toBe(false);
  });

  it("advances only forward and heartbeats the exact issued handle", async () => {
    const state = await fixture();
    state.alive.add(301);
    const claims = state.store(301);
    const acquired = await state.trusted(async () => await claims.acquire(input(PLANNED)));
    if (!acquired.ok) throw new Error("Claim was not acquired.");

    state.clock.now = 1_050;
    await expect(state.trusted(async () => await acquired.handle.advance("admission_bound")))
      .resolves.toMatchObject({ ok: true, claim: { phase: "admission_bound", heartbeatAtMs: 1_050, admission: PLANNED } });
    await expect(state.trusted(async () => await acquired.handle.advance("claimed")))
      .resolves.toEqual({ ok: false, code: "claim_phase_invalid" });
    for (const phase of ["plan_bound", "host_lease_published", "submitted", "executing", "settling", "terminal_evidence", "terminal_recorded"] as const) {
      await expect(state.trusted(async () => await acquired.handle.advance(phase))).resolves.toMatchObject({ ok: true, claim: { phase } });
    }
    state.clock.now = 1_075;
    await expect(state.trusted(async () => await acquired.handle.heartbeat()))
      .resolves.toMatchObject({ ok: true, claim: { phase: "terminal_recorded", heartbeatAtMs: 1_075 } });
    await expect(state.trusted(async () => await acquired.handle.assertHeld()))
      .resolves.toMatchObject({ ok: true, claim: { phase: "terminal_recorded" } });
  });

  it("conflicts on another admission intent without changing the first pointer", async () => {
    const state = await fixture();
    state.alive.add(401);
    state.alive.add(402);
    const first = state.store(401);
    const second = state.store(402);
    const acquired = await state.trusted(async () => await first.acquire(input(LEGACY)));
    if (!acquired.ok) throw new Error("Claim was not acquired.");

    await expect(state.trusted(async () => await second.acquire(input(PLANNED))))
      .resolves.toMatchObject({ ok: false, code: "claim_conflict", claim: { admission: LEGACY } });
    await expect(state.trusted(async () => await second.acquire(input(OTHER_PLANNED))))
      .resolves.toMatchObject({ ok: false, code: "claim_conflict", claim: { admission: LEGACY } });
    await expect(state.trusted(async () => await acquired.handle.assertHeld()))
      .resolves.toMatchObject({ ok: true, claim: { admission: LEGACY, phase: "claimed" } });
  });

  it("never reclaims a stale claim while the holder remains live, including an EPERM-equivalent liveness answer", async () => {
    const state = await fixture();
    state.alive.add(501);
    const first = state.store(501);
    const acquired = await state.trusted(async () => await first.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    state.clock.now += 60_000;

    const livePeer = state.store(502);
    await expect(state.trusted(async () => await livePeer.acquire({ ...input(), recoverDeadOwner: () => "takeover" })))
      .resolves.toMatchObject({ ok: false, code: "claim_held", claim: { pid: 501, heartbeatAtMs: 1_000 } });
    // `true` is the same conservative answer a real `kill(pid, 0)` EPERM produces.
    const epermPeer = state.store(503, () => true);
    await expect(state.trusted(async () => await epermPeer.acquire({ ...input(), recoverDeadOwner: () => "takeover" })))
      .resolves.toMatchObject({ ok: false, code: "claim_held", claim: { pid: 501 } });
    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toMatchObject({ ok: true });
  });

  it("never treats malformed or throwing runtime liveness answers as a dead owner", async () => {
    const state = await fixture();
    state.alive.add(511);
    const first = state.store(511);
    const acquired = await state.trusted(async () => await first.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const untypedLiveness = (() => undefined) as unknown as (pid: number) => boolean;
    const throwingLiveness = (() => { throw new Error("untrusted liveness failure"); }) as unknown as (pid: number) => boolean;

    await expect(state.trusted(async () => await state.store(512, untypedLiveness).acquire({ ...input(), recoverDeadOwner: () => "takeover" })))
      .resolves.toEqual({ ok: false, code: "claim_unavailable" });
    await expect(state.trusted(async () => await state.store(513, throwingLiveness).acquire({ ...input(), recoverDeadOwner: () => "takeover" })))
      .resolves.toEqual({ ok: false, code: "claim_unavailable" });
    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toMatchObject({ ok: true, claim: { pid: 511 } });
  });

  it("requires an explicit dead-owner policy and lets that policy refuse an executing claim", async () => {
    const state = await fixture();
    state.alive.add(601);
    state.alive.add(602);
    const first = state.store(601);
    const second = state.store(602);
    const acquired = await state.trusted(async () => await first.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    for (const phase of ["admission_bound", "plan_bound", "host_lease_published", "submitted", "executing"] as const) {
      await expect(state.trusted(async () => await acquired.handle.advance(phase))).resolves.toMatchObject({ ok: true, claim: { phase } });
    }
    state.alive.delete(601);

    await expect(state.trusted(async () => await second.acquire(input()))).resolves.toMatchObject({
      ok: false, code: "claim_recovery_required", claim: { phase: "executing", pid: 601 }
    });
    await expect(state.trusted(async () => await second.acquire({ ...input(), recoverDeadOwner: (claim) => claim.phase === "executing" ? "refuse" : "takeover" })))
      .resolves.toMatchObject({ ok: false, code: "claim_recovery_refused", claim: { phase: "executing" } });
    await expect(state.trusted(async () => await second.acquire({ ...input(), recoverDeadOwner: () => "takeover" })))
      .resolves.toMatchObject({ ok: true, recovered: true, claim: { pid: 602, phase: "claimed" } });
  });

  it("refuses malformed or throwing untyped dead-owner recovery callbacks without unlinking", async () => {
    const state = await fixture();
    state.alive.add(611);
    const first = state.store(611);
    const second = state.store(612);
    const acquired = await state.trusted(async () => await first.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    state.alive.delete(611);
    const untypedCallbacks = [() => undefined, () => "unexpected", () => { throw new Error("untrusted callback failure"); }];

    for (const recoverDeadOwner of untypedCallbacks) {
      await expect(state.trusted(async () => await second.acquire({ ...input(), recoverDeadOwner: recoverDeadOwner as never })))
        .resolves.toMatchObject({ ok: false, code: "claim_recovery_refused", claim: { pid: 611 } });
    }
    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toMatchObject({ ok: true, claim: { pid: 611 } });
  });

  it("does not let an old nonce mutate or release a recovered successor", async () => {
    const state = await fixture();
    state.alive.add(701);
    state.alive.add(702);
    const oldStore = state.store(701);
    const successorStore = state.store(702);
    const old = await state.trusted(async () => await oldStore.acquire(input()));
    if (!old.ok) throw new Error("Claim was not acquired.");
    state.alive.delete(701);
    const successor = await state.trusted(async () => await successorStore.acquire({ ...input(), recoverDeadOwner: () => "takeover" }));
    if (!successor.ok) throw new Error("Successor was not acquired.");

    await expect(state.trusted(async () => await old.handle.advance("admission_bound"))).resolves.toEqual({ ok: false, code: "claim_lost" });
    await expect(state.trusted(async () => await old.handle.release())).resolves.toEqual({ ok: false, code: "claim_lost" });
    await expect(state.trusted(async () => await successor.handle.heartbeat())).resolves.toMatchObject({ ok: true, claim: { pid: 702, phase: "claimed" } });
  });

  it("rejects a canonical foreign pointer copied below another owner's opaque leaf without touching the foreign state", async () => {
    const state = await fixture();
    const ownerA = { callerId: "cut:claim-owner-a", jobId: "cut:claim-id-a", admission: LEGACY };
    const ownerB = { callerId: "cut:claim-owner-b", jobId: "cut:claim-id-b", admission: LEGACY };
    state.alive.add(721);
    state.alive.add(722);
    const storeA = state.store(721);
    const storeB = state.store(722);
    const claimedB = await state.trusted(async () => await storeB.acquire(ownerB));
    if (!claimedB.ok) throw new Error("B claim was not acquired.");
    const pointerB = join(state.claimRoot, `${motionJobOwnerKey(ownerB.callerId, ownerB.jobId)}.claim-pointer.json`);
    const pointerA = join(state.claimRoot, `${motionJobOwnerKey(ownerA.callerId, ownerA.jobId)}.claim-pointer.json`);
    await writeFile(pointerA, await readFile(pointerB), { mode: 0o600 });
    state.alive.delete(722);

    await expect(state.trusted(async () => await storeA.acquire({ ...ownerA, recoverDeadOwner: () => "takeover" })))
      .resolves.toEqual({ ok: false, code: "claim_invalid" });
    await expect(state.trusted(async () => await claimedB.handle.assertHeld())).resolves.toMatchObject({ ok: true, claim: { pid: 722, admission: LEGACY } });
  });

  it("fails closed for a corrupt or atomically replaced nonce state", async () => {
    const state = await fixture();
    state.alive.add(801);
    state.alive.add(802);
    const first = state.store(801);
    const acquired = await state.trusted(async () => await first.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const claimState = await statePath(state.claimRoot);
    await writeFile(claimState, "{bad-json}", { mode: 0o600 });

    await expect(state.trusted(async () => await acquired.handle.heartbeat())).resolves.toEqual({ ok: false, code: "claim_invalid" });
    await expect(state.trusted(async () => await state.store(802).acquire(input()))).resolves.toEqual({ ok: false, code: "claim_invalid" });

    const pointer = join(state.claimRoot, `${ownerKey()}.claim-pointer.json`);
    const replacement = join(state.claimRoot, "replacement-pointer.json");
    await writeFile(replacement, "{replacement}", { mode: 0o600 });
    await rename(replacement, pointer);
    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toEqual({ ok: false, code: "claim_invalid" });
  });

  it("fails closed when a canonical nonce state is atomically replaced with another holder", async () => {
    const state = await fixture();
    state.alive.add(811);
    state.alive.add(812);
    const acquired = await state.trusted(async () => await state.store(811).acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const claimState = await statePath(state.claimRoot);
    const replacement = join(state.claimRoot, "replacement-state.json");
    const parsed = JSON.parse(await readFile(claimState, "utf8")) as Record<string, unknown>;
    await writeFile(replacement, canonicalJson({ ...parsed, pid: 812 }), { mode: 0o600 });
    await rename(replacement, claimState);

    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toEqual({ ok: false, code: "claim_invalid" });
    await expect(state.trusted(async () => await state.store(812).acquire(input()))).resolves.toEqual({ ok: false, code: "claim_invalid" });
  });

  it.skipIf(process.platform === "win32")("does not follow a claim-state symlink", async () => {
    const state = await fixture();
    state.alive.add(901);
    state.alive.add(902);
    const first = state.store(901);
    const acquired = await state.trusted(async () => await first.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    const claimState = await statePath(state.claimRoot);
    const outside = join(state.root, "outside-claim.json");
    await writeFile(outside, "{}", { mode: 0o600 });
    await unlink(claimState);
    await symlink(outside, claimState);

    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toEqual({ ok: false, code: "claim_invalid" });
    await expect(state.trusted(async () => await state.store(902).acquire(input()))).resolves.toEqual({ ok: false, code: "claim_invalid" });
  });

  it.skipIf(process.platform === "win32")("fails closed for a symlink or non-private claim root", async () => {
    const state = await fixture();
    const target = await mkdtemp(join(process.cwd(), ".scratch-job-identity-claim-target-"));
    roots.push(target);
    const unsafe = join(state.root, "unsafe-claims");
    await symlink(target, unsafe, "dir");
    const throughSymlink = new MotionJobIdentityClaimStore({ claimRoot: unsafe, pid: 1_001, isProcessAlive: () => true });
    await expect(state.trusted(async () => await throughSymlink.acquire(input()))).resolves.toEqual({ ok: false, code: "claim_unavailable" });

    const shared = join(state.root, "shared-claims");
    await rm(shared, { recursive: true, force: true });
    await writeFile(shared, "not-a-directory", { mode: 0o600 });
    const blocked = new MotionJobIdentityClaimStore({ claimRoot: join(shared, "child"), pid: 1_002, isProcessAlive: () => true });
    await expect(state.trusted(async () => await blocked.acquire(input()))).resolves.toEqual({ ok: false, code: "claim_unavailable" });

    const publicRoot = join(state.root, "public-claims");
    await mkdir(publicRoot, { mode: 0o700 });
    await chmod(publicRoot, 0o755);
    const publicStore = new MotionJobIdentityClaimStore({ claimRoot: publicRoot, pid: 1_003, isProcessAlive: () => true });
    await expect(state.trusted(async () => await publicStore.acquire(input()))).resolves.toEqual({ ok: false, code: "claim_unavailable" });
  });

  it("does not adopt a replacement claim root after it has acquired authority", async () => {
    const state = await fixture();
    state.alive.add(1_101);
    const store = state.store(1_101);
    const acquired = await state.trusted(async () => await store.acquire(input()));
    if (!acquired.ok) throw new Error("Claim was not acquired.");
    await rename(state.claimRoot, `${state.claimRoot}-replaced`);
    await mkdir(state.claimRoot, { mode: 0o700 });

    await expect(state.trusted(async () => await acquired.handle.assertHeld())).resolves.toEqual({ ok: false, code: "claim_unavailable" });
  });
});

async function claimFilesystemFacts(claimRoot: string): Promise<object> {
  const pointer = join(claimRoot, `${ownerKey()}.claim-pointer.json`);
  const state = await statePath(claimRoot);
  const directory = join(state, "..");
  const [rootFacts, pointerFacts, directoryFacts, stateFacts, pointerBytes, stateBytes] = await Promise.all([
    lstat(claimRoot), lstat(pointer), lstat(directory), lstat(state), readFile(pointer, "utf8"), readFile(state, "utf8")
  ]);
  return {
    root: identityFacts(rootFacts), pointer: { ...identityFacts(pointerFacts), bytes: pointerBytes },
    stateDirectory: identityFacts(directoryFacts), state: { ...identityFacts(stateFacts), bytes: stateBytes }
  };
}

function identityFacts(facts: Awaited<ReturnType<typeof lstat>>): { dev: number; ino: number; mode: number; size: number; mtimeMs: number } {
  return { dev: Number(facts.dev), ino: Number(facts.ino), mode: Number(facts.mode), size: Number(facts.size), mtimeMs: Number(facts.mtimeMs) };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
