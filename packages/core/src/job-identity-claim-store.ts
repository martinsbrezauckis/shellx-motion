/** Private owner-qualified execution claims use nonce-scoped state to reject delayed holders. */
import { join, resolve } from "node:path";
import { defaultMotionRuntimeRoot } from "./job-lease";
import { mintMotionJobLeaseRun } from "./job-lease-run-storage";
import { inspectInjectedClaimLiveness, inspectSystemClaimLiveness } from "./job-identity-claim-store-liveness";
import {
  claimIdentity,
  defaultIsProcessAlive,
  parseAdmission,
  phaseIndex,
  positiveInteger,
  sameAdmission,
  samePointer,
  sameToken,
  serializePointer,
  serializeState,
  snapshot,
  type ClaimIdentity,
  type ClaimToken,
  type CurrentRead,
  type MotionJobIdentityClaimAcquireFailure,
  type MotionJobIdentityClaimAcquireInput,
  type MotionJobIdentityClaimMutationResult,
  type MotionJobIdentityClaimReleaseResult,
  type MotionJobIdentityClaimSnapshot,
  type MotionJobIdentityClaimStoreServices,
  type StoredState
} from "./job-identity-claim-store-model";
import {
  createClaimDirectory,
  readClaimPointer,
  readClaimState,
  removeClaimDirectory,
  removeExactPointer,
  writeNoClobber,
  writeStateAtomic
} from "./job-identity-claim-store-storage";
import { inspectExistingPrivateRuntimeDirectory } from "./private-runtime-directory-inspection";
import type { RetainedDirectoryAuthority } from "./output-path-topology";
import { PrivateMotionRuntimeDirectory } from "./private-runtime-directory";
import { bindMotionJobIdentityClaimExactProof, type MotionJobIdentityClaimExactHeldProof } from "./job-identity-claim-store-exact-proof";

export type {
  MotionJobIdentityClaimAdmissionIntent,
  MotionJobIdentityClaimAcquireInput,
  MotionJobIdentityClaimMutationResult,
  MotionJobIdentityClaimPhase,
  MotionJobIdentityClaimRecoveryDecision,
  MotionJobIdentityClaimReleaseResult,
  MotionJobIdentityClaimSnapshot,
  MotionJobIdentityClaimStoreServices
} from "./job-identity-claim-store-model";

const HANDLE_CAPABILITY = Symbol("MotionJobIdentityClaimHandle");

export type MotionJobIdentityClaimAcquireResult =
  | Readonly<{ ok: true; handle: MotionJobIdentityClaimHandle; claim: MotionJobIdentityClaimSnapshot; recovered: boolean }>
  | MotionJobIdentityClaimAcquireFailure;

/** @internal Exact planned-claim proof for companion provenance; it is deliberately not barrel-exported. */
type MotionJobIdentityClaimInspection =
  | Readonly<{ ok: true; kind: "missing" }>
  | Readonly<{ ok: true; kind: "held"; claim: MotionJobIdentityClaimSnapshot; liveness: "live" | "dead" | "unknown" }>
  | Readonly<{ ok: false; code: "claim_invalid" | "claim_unavailable" }>;

/** Coordinator-adjacent default root, overrideable only by trusted host configuration. */
export function defaultMotionJobIdentityClaimRoot(env: NodeJS.ProcessEnv = process.env): string {
  const coordinator = env.SHELLX_MOTION_JOB_COORDINATOR_ROOT?.trim();
  return join(coordinator || defaultMotionRuntimeRoot(env), "job-identity-claims");
}

/** Opaque, path-free capability for the one claimant that won the no-clobber pointer. */
export class MotionJobIdentityClaimHandle {
  private readonly store: MotionJobIdentityClaimStore;

  constructor(store: MotionJobIdentityClaimStore, capability: symbol) {
    if (capability !== HANDLE_CAPABILITY) throw new Error("Motion job identity claim handles are store-issued only.");
    this.store = store;
  }

  async assertHeld(): Promise<MotionJobIdentityClaimMutationResult> {
    return await this.store.assertHeld(this);
  }

  async advance(phase: import("./job-identity-claim-store-model").MotionJobIdentityClaimPhase): Promise<MotionJobIdentityClaimMutationResult> {
    return await this.store.advance(this, phase);
  }

  async heartbeat(): Promise<MotionJobIdentityClaimMutationResult> {
    return await this.store.heartbeat(this);
  }

  async release(): Promise<MotionJobIdentityClaimReleaseResult> {
    return await this.store.release(this);
  }
}

/** One private pointer per owner/job; dead-owner recovery is always explicitly host-directed. */
export class MotionJobIdentityClaimStore {
  private readonly root: string;
  private runtime: PrivateMotionRuntimeDirectory;
  /** A first-root race may be retried once; an established authority never adopts a replacement. */
  private runtimeEstablished = false;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly inspectLiveness: (pid: number) => "live" | "dead" | "unknown";
  private readonly handles = new WeakMap<MotionJobIdentityClaimHandle, ClaimToken>();
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(services: MotionJobIdentityClaimStoreServices = {}) {
    this.root = resolve(services.claimRoot ?? defaultMotionJobIdentityClaimRoot());
    this.runtime = new PrivateMotionRuntimeDirectory(this.root);
    this.now = services.now ?? Date.now;
    this.pid = positiveInteger(services.pid ?? process.pid, "Motion job identity claim pid");
    this.isProcessAlive = services.isProcessAlive ?? defaultIsProcessAlive;
    this.inspectLiveness = services.isProcessAlive === undefined
      ? inspectSystemClaimLiveness
      : (candidate) => inspectInjectedClaimLiveness(services.isProcessAlive!, candidate);
  }

  /** @internal Read without acquiring, recovering, or establishing store state. */
  async inspect(input: { callerId: string; jobId: string }): Promise<MotionJobIdentityClaimInspection> {
    let identity: ClaimIdentity;
    try {
      identity = claimIdentity(input.callerId, input.jobId);
    } catch {
      return { ok: false, code: "claim_invalid" };
    }
    try {
      const root = await this.inspectExistingRuntime();
      if (!root) return { ok: true, kind: "missing" };
      await root.assertCurrent();
      const pointer = await readClaimPointer(this.pointerPath(identity));
      await root.assertCurrent();
      if (pointer.kind === "missing") return { ok: true, kind: "missing" };
      if (pointer.kind !== "pointer") return { ok: false, code: "claim_invalid" };
      if (pointer.pointer.callerId !== identity.callerId || pointer.pointer.jobId !== identity.jobId || pointer.pointer.ownerKey !== identity.ownerKey) {
        return { ok: false, code: "claim_invalid" };
      }
      await root.assertCurrent();
      const state = await readClaimState(this.directoryPath(pointer.pointer));
      await root.assertCurrent();
      if (!state || !samePointer(state, pointer.pointer)) return { ok: false, code: "claim_invalid" };
      const liveness = this.inspectLiveness(pointer.pointer.pid);
      await root.assertCurrent();
      return { ok: true, kind: "held", claim: snapshot(state), liveness };
    } catch {
      return { ok: false, code: "claim_unavailable" };
    }
  }

  async acquire(input: MotionJobIdentityClaimAcquireInput): Promise<MotionJobIdentityClaimAcquireResult> {
    let identity: ClaimIdentity;
    try {
      identity = claimIdentity(input.callerId, input.jobId);
      await this.assertRuntime();
      parseAdmission(input.admission);
    } catch {
      return { ok: false, code: "claim_unavailable" };
    }
    return await this.serial(identity.ownerKey, async () => await this.acquireCurrent(identity, input));
  }

  async assertHeld(handle: MotionJobIdentityClaimHandle): Promise<MotionJobIdentityClaimMutationResult> {
    const token = this.handles.get(handle);
    return !token ? { ok: false, code: "claim_lost" } : await this.serial(token.ownerKey, async () => await this.readHeld(token));
  }

  /** Exact opaque-handle proof consumed only through the non-barrel companion capability bridge. */
  private async assertHeldPlannedExact(handle: MotionJobIdentityClaimHandle, input: Readonly<{ callerId: string; jobId: string; planFingerprint: string }>): Promise<MotionJobIdentityClaimExactHeldProof> {
    const token = this.handles.get(handle);
    if (!token) return { ok: false, code: "claim_lost" };
    let identity: ClaimIdentity;
    let admission: import("./job-identity-claim-store-model").MotionJobIdentityClaimAdmissionIntent;
    try {
      identity = claimIdentity(input.callerId, input.jobId);
      admission = parseAdmission({ mode: "planned", planFingerprint: input.planFingerprint });
    } catch {
      return { ok: false, code: "claim_invalid" };
    }
    if (token.callerId !== identity.callerId || token.jobId !== identity.jobId || token.ownerKey !== identity.ownerKey) return { ok: false, code: "claim_lost" };
    return await this.serial(token.ownerKey, async () => {
      const held = await this.readHeld(token);
      if (!held.ok || !sameAdmission(held.claim.admission, admission)) return held.ok ? { ok: false, code: "claim_lost" } : held;
      return Object.freeze({ ok: true, claim: held.claim, ownerKey: token.ownerKey, runNonce: token.runNonce });
    });
  }

  async advance(handle: MotionJobIdentityClaimHandle, phase: import("./job-identity-claim-store-model").MotionJobIdentityClaimPhase): Promise<MotionJobIdentityClaimMutationResult> {
    const token = this.handles.get(handle);
    if (!token) return { ok: false, code: "claim_lost" };
    return await this.serial(token.ownerKey, async () => {
      const held = await this.readHeldState(token);
      if (!held.ok) return held.result;
      if (phaseIndex(phase) <= phaseIndex(held.state.phase)) return { ok: false, code: "claim_phase_invalid" };
      return await this.writeHeldState(token, Object.freeze({ ...held.state, phase, heartbeatAtMs: Math.max(this.now(), held.state.heartbeatAtMs) }));
    });
  }

  async heartbeat(handle: MotionJobIdentityClaimHandle): Promise<MotionJobIdentityClaimMutationResult> {
    const token = this.handles.get(handle);
    if (!token) return { ok: false, code: "claim_lost" };
    return await this.serial(token.ownerKey, async () => {
      const held = await this.readHeldState(token);
      return !held.ok ? held.result : await this.writeHeldState(token, Object.freeze({ ...held.state, heartbeatAtMs: Math.max(this.now(), held.state.heartbeatAtMs) }));
    });
  }

  async release(handle: MotionJobIdentityClaimHandle): Promise<MotionJobIdentityClaimReleaseResult> {
    const token = this.handles.get(handle);
    if (!token) return { ok: false, code: "claim_lost" };
    return await this.serial(token.ownerKey, async () => {
      try {
        await this.assertRuntime();
        const current = await this.readCurrent(token);
        if (current.kind === "missing" || (current.kind === "current" && !sameToken(current.pointer, token))) return { ok: false, code: "claim_lost" };
        if (current.kind === "invalid") return { ok: false, code: "claim_invalid" };
        if (!await removeExactPointer(this.pointerPath(token), current.pointerMetadata)) return { ok: false, code: "claim_lost" };
        await removeClaimDirectory(this.directoryPath(token));
        this.handles.delete(handle);
        return { ok: true, released: true };
      } catch {
        return { ok: false, code: "claim_unavailable" };
      }
    });
  }

  private async acquireCurrent(identity: ClaimIdentity, input: MotionJobIdentityClaimAcquireInput, recovered = false): Promise<MotionJobIdentityClaimAcquireResult> {
    const admission = parseAdmission(input.admission);
    const current = await this.readCurrent(identity);
    if (current.kind === "invalid") return { ok: false, code: "claim_invalid" };
    if (current.kind === "current") {
      if (!sameAdmission(current.pointer.admission, admission)) return { ok: false, code: "claim_conflict", claim: snapshot(current.state) };
      let liveness: unknown;
      try { liveness = this.isProcessAlive(current.pointer.pid); } catch { return { ok: false, code: "claim_unavailable" }; }
      if (liveness === true) return { ok: false, code: "claim_held", claim: snapshot(current.state) };
      // Process liveness is a runtime host boundary: only an exact `false` proves the holder dead.
      if (liveness !== false) return { ok: false, code: "claim_unavailable" };
      const decision = decideRecovery(input.recoverDeadOwner, current.state);
      if (decision === "required") return { ok: false, code: "claim_recovery_required", claim: snapshot(current.state) };
      if (decision === "refuse") return { ok: false, code: "claim_recovery_refused", claim: snapshot(current.state) };
      if (!await removeExactPointer(this.pointerPath(identity), current.pointerMetadata)) return await this.acquireCurrent(identity, input, recovered);
      await removeClaimDirectory(this.directoryPath(current.pointer));
      return await this.acquireCurrent(identity, input, true);
    }

    const token: ClaimToken = Object.freeze({ ...identity, runNonce: mintMotionJobLeaseRun(identity.jobId).runNonce, pid: this.pid });
    const claimedAtMs = this.now();
    const state: StoredState = Object.freeze({ ...token, admission, claimedAtMs, heartbeatAtMs: claimedAtMs, phase: "claimed" });
    try {
      await createClaimDirectory(this.directoryPath(token), serializeState(state));
      const pointer = Object.freeze({ ...token, admission, claimedAtMs });
      if (!await writeNoClobber(this.pointerPath(identity), serializePointer(pointer))) {
        await removeClaimDirectory(this.directoryPath(token));
        return await this.acquireCurrent(identity, input, recovered);
      }
      const handle = new MotionJobIdentityClaimHandle(this, HANDLE_CAPABILITY);
      this.handles.set(handle, token);
      bindMotionJobIdentityClaimExactProof(handle, async (exact) => await this.assertHeldPlannedExact(handle, exact));
      return { ok: true, handle, claim: snapshot(state), recovered };
    } catch {
      await removeClaimDirectory(this.directoryPath(token)).catch(() => {});
      return { ok: false, code: "claim_unavailable" };
    }
  }

  private async readHeld(token: ClaimToken): Promise<MotionJobIdentityClaimMutationResult> {
    const held = await this.readHeldState(token);
    return held.ok ? { ok: true, claim: snapshot(held.state) } : held.result;
  }

  private async readHeldState(token: ClaimToken): Promise<
    | Readonly<{ ok: true; state: StoredState }>
    | Readonly<{ ok: false; result: Extract<MotionJobIdentityClaimMutationResult, { ok: false }> }>
  > {
    try {
      await this.assertRuntime();
      const current = await this.readCurrent(token);
      if (current.kind === "missing") return { ok: false, result: { ok: false, code: "claim_lost" } };
      if (current.kind === "invalid") return { ok: false, result: { ok: false, code: "claim_invalid" } };
      if (!sameToken(current.pointer, token) || !sameToken(current.state, token)) return { ok: false, result: { ok: false, code: "claim_lost" } };
      return { ok: true, state: current.state };
    } catch {
      return { ok: false, result: { ok: false, code: "claim_unavailable" } };
    }
  }

  private async writeHeldState(token: ClaimToken, state: StoredState): Promise<MotionJobIdentityClaimMutationResult> {
    try {
      await writeStateAtomic(this.directoryPath(token), serializeState(state));
      return await this.readHeld(token);
    } catch {
      return { ok: false, code: "claim_unavailable" };
    }
  }

  private async readCurrent(identity: ClaimIdentity): Promise<CurrentRead> {
    const pointer = await readClaimPointer(this.pointerPath(identity));
    if (pointer.kind !== "pointer") return pointer;
    if (pointer.pointer.callerId !== identity.callerId || pointer.pointer.jobId !== identity.jobId || pointer.pointer.ownerKey !== identity.ownerKey) {
      return { kind: "invalid" };
    }
    const state = await readClaimState(this.directoryPath(pointer.pointer));
    return !state || !samePointer(state, pointer.pointer) ? { kind: "invalid" } : { kind: "current", pointer: pointer.pointer, pointerMetadata: pointer.metadata, state };
  }

  private pointerPath(identity: ClaimIdentity): string {
    return join(this.root, `${identity.ownerKey}.claim-pointer.json`);
  }

  private directoryPath(token: Pick<ClaimToken, "ownerKey" | "runNonce">): string {
    return join(this.root, `${token.ownerKey}--${token.runNonce}.claim`);
  }

  private async serial<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(identity) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(operation);
    this.writes.set(identity, write);
    try { return await write as T; } finally { if (this.writes.get(identity) === write) this.writes.delete(identity); }
  }

  private async assertRuntime(): Promise<void> {
    if (this.runtimeEstablished) return await this.runtime.assertCurrent();
    try {
      await this.runtime.assertCurrent();
    } catch {
      // Before this store retains authority, reopen a concurrently created private root once.
      this.runtime = new PrivateMotionRuntimeDirectory(this.root);
      await this.runtime.assertCurrent();
    }
    this.runtimeEstablished = true;
  }
  /** Existing-only root authority for inspection: unlike assertRuntime(), it never creates a root. */
  private async inspectExistingRuntime(): Promise<RetainedDirectoryAuthority | undefined> {
    if (this.runtimeEstablished) { await this.runtime.assertCurrent(); return this.runtime; }
    return await inspectExistingPrivateRuntimeDirectory(this.root);
  }
}

function decideRecovery(recover: MotionJobIdentityClaimAcquireInput["recoverDeadOwner"], state: StoredState): "takeover" | "refuse" | "required" {
  if (!recover) return "required";
  try {
    const decision: unknown = recover(snapshot(state));
    return decision === "takeover" || decision === "refuse" ? decision : "refuse";
  } catch {
    return "refuse";
  }
}
