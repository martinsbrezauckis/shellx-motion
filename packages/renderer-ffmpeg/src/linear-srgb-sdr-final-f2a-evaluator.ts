/**
 * Candidate-local F2a measurement only. This source-relative module has no barrel, request, or
 * receipt surface: the private child imports it only through the sealed one-slot topology.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  registerStrictSdrCandidateF2aFinalizer,
  matchesCurrentStrictSdrCandidateHeldPairObservation,
  strictSdrCandidateHeldPairForConsumedRendererBinding,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldPairRendererBinding,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import {
  type LocalMotionJobContext,
  type LocalMotionJobEvidence,
  type LocalMotionJobGovernor,
  type LocalMotionProcessContainmentEvidence,
} from "@shellx-motion/core";
import {
  LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT,
  LINEAR_SRGB_SDR_FINAL_MAX_WIDTH,
  type LinearSrgbSdrFinalRoute,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import { compareLinearSrgbSdrFinalFrames, type LinearSrgbSdrFinalComparison } from "./linear-srgb-sdr-final-compare.js";
import type { LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";

const F2A_PREPARATION = /^[a-f0-9]{64}$/u;
const F2A_WIDTH = 1_280;
const F2A_HEIGHT = 720;
const F2A_FPS = 30;
const F2A_DURATION_MS = 2_000;
const F2A_SCHEMA = "shellx-motion/strict-sdr-candidate-f2a-measurement@1" as const;

declare const f2aSnapshotBrand: unique symbol;

/** Opaque frame copy handle: only this source-relative evaluator can access its bytes. */
export interface StrictSdrCandidateF2aFrameSnapshot { readonly [f2aSnapshotBrand]: never; }

export type StrictSdrCandidateF2aLeaseOwner = Readonly<{
  runF2aInverse(input: Readonly<{
    sourceFd: number;
    job: LinearSrgbSdrFinalJob;
    compareDecoded(decoded: Buffer): LinearSrgbSdrFinalComparison;
  }>): Promise<Readonly<{
    decoded: Readonly<{ sha256: string; byteLength: number }>;
    comparison: LinearSrgbSdrFinalComparison;
    inverseCommandSha256: string;
  }>>;
  close(): Promise<void>;
}>;

export type StrictSdrCandidateF2aLeaseTransfer = Readonly<{
  binding: StrictSdrCandidateHeldPairRendererBinding;
  preparation: string;
  governor: LocalMotionJobGovernor;
  scratchRoot: string;
  signal: AbortSignal | undefined;
  callerId: string | undefined;
}>;

export type StrictSdrCandidateF2aMeasurement = Readonly<{
  schema: typeof F2A_SCHEMA;
  media: Readonly<{ sha256: string; byteLength: number }>;
  sourceFrame: Readonly<{ sha256: string; byteLength: number }>;
  decodedFrame: Readonly<{ sha256: string; byteLength: number }>;
  comparison: LinearSrgbSdrFinalComparison;
  inverseCommandSha256: string;
  inverseJob: LocalMotionJobEvidence;
}>;

/** Private only: available after Core consumption proves the registered finalizer settled. */
export type StrictSdrCandidateF2aFinalization = Readonly<{
  schema: "shellx-motion/strict-sdr-candidate-f2a-finalization@1";
  state: "complete";
  sourceFrameReleased: true;
  heldToolDescriptorsClosed: true;
  privateDecodeLeafRemoved: true;
  privateRootClosed: true;
}>;

type SnapshotState = {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
  readonly route: LinearSrgbSdrFinalRoute;
};
type F2aScope = {
  readonly preparation: string;
  active: boolean;
  snapshot: StrictSdrCandidateF2aFrameSnapshot | undefined;
  transferred: boolean;
};
type F2aLease = {
  readonly owner: StrictSdrCandidateF2aLeaseOwner;
  readonly snapshot: SnapshotState;
  readonly transfer: StrictSdrCandidateF2aLeaseTransfer;
  evaluating: boolean;
  closed: boolean;
};

const scopes = new AsyncLocalStorage<F2aScope>();
const snapshots = new WeakMap<object, SnapshotState>();
const leases = new WeakMap<object, F2aLease>();
const finalizations = new WeakMap<object, StrictSdrCandidateF2aFinalization>();

/** Scope exactly the sealed F2a terminal call. Nested or detached scopes never gain retention. */
export async function withStrictSdrCandidateF2aEvaluation<T>(
  preparation: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!F2A_PREPARATION.test(preparation)) {
    throw new Error("Strict-SDR candidate F2a evaluation requires an exact preparation fingerprint.");
  }
  if (scopes.getStore()) throw new Error("Strict-SDR candidate F2a evaluation scope is nonnestable.");
  const scope: F2aScope = { preparation, active: true, snapshot: undefined, transferred: false };
  try {
    return await scopes.run(scope, operation);
  } finally {
    scope.active = false;
    if (scope.snapshot) discardStrictSdrCandidateF2aFrameSnapshot(scope.snapshot);
    scope.snapshot = undefined;
  }
}

/** Capture only after held-media validation while the exact sealed F2a scope remains live. */
export function captureCurrentStrictSdrCandidateF2aFrame(
  route: LinearSrgbSdrFinalRoute,
  frame: LinearSrgbSdrFinalWebGpuFrame,
): StrictSdrCandidateF2aFrameSnapshot | undefined {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  assertActiveScope(scope, scope.preparation);
  if (scope.snapshot || scope.transferred) {
    throw new Error("Strict-SDR candidate F2a frame capture was duplicated.");
  }
  assertFrameMatchesRoute(route, frame);
  const bytes = Buffer.from(frame.rgba8Srgb);
  if (sha256(bytes) !== frame.rgba8SrgbSha256) {
    bytes.fill(0);
    throw new Error("Strict-SDR candidate F2a frame copy did not preserve the producer hash.");
  }
  const snapshot = Object.freeze({}) as StrictSdrCandidateF2aFrameSnapshot;
  snapshots.set(snapshot as object, Object.freeze({ bytes, sha256: frame.rgba8SrgbSha256, byteLength: bytes.byteLength, route }));
  scope.snapshot = snapshot;
  return snapshot;
}

/** An ordinary R2 close releases any untransferred capture before its held-media root closes. */
export function discardStrictSdrCandidateF2aFrameSnapshot(snapshot: StrictSdrCandidateF2aFrameSnapshot): void {
  const state = snapshots.get(snapshot as object);
  if (!state) return;
  state.bytes.fill(0);
  snapshots.delete(snapshot as object);
}

/**
 * Move exactly one already verified frame into the pair-keyed private lease. Missing scope means
 * ordinary R2 behavior; any active-scope mismatch is a refusal, never a fallback.
 */
export function transferCurrentStrictSdrCandidateF2aLease(
  snapshot: StrictSdrCandidateF2aFrameSnapshot | undefined,
  owner: StrictSdrCandidateF2aLeaseOwner,
  transfer: StrictSdrCandidateF2aLeaseTransfer,
): boolean {
  const scope = scopes.getStore();
  if (!scope) return false;
  assertActiveScope(scope, transfer.preparation);
  if (!snapshot || scope.snapshot !== snapshot || scope.transferred) {
    throw new Error("Strict-SDR candidate F2a frame lease is absent, mismatched, or already transferred.");
  }
  const snapshotState = snapshots.get(snapshot as object);
  if (!snapshotState || !sameF2aRoute(snapshotState.route)) {
    throw new Error("Strict-SDR candidate F2a lease does not hold the fixed sealed frame route.");
  }
  if (!owner || typeof owner.close !== "function" || typeof owner.runF2aInverse !== "function") {
    throw new Error("Strict-SDR candidate F2a lease owner is invalid.");
  }
  assertTransfer(transfer);
  const pair = strictSdrCandidateHeldPairForConsumedRendererBinding(transfer.binding);
  if (leases.has(pair as object)) throw new Error("Strict-SDR candidate F2a pair already has a private lease.");
  const lease: F2aLease = { owner, snapshot: snapshotState, transfer, evaluating: false, closed: false };
  leases.set(pair as object, lease);
  try {
    registerStrictSdrCandidateF2aFinalizer(pair, async () => await closeStrictSdrCandidateF2aLease(pair, lease));
  } catch (error) {
    leases.delete(pair as object);
    throw error;
  }
  snapshots.delete(snapshot as object);
  scope.snapshot = undefined;
  scope.transferred = true;
  return true;
}

/** Run the fresh governed inverse inside Core's one-shot committed-pair descriptor callback. */
export async function evaluateStrictSdrCandidateF2aHeldPair(
  pair: StrictSdrCandidateHeldPair,
  observation: StrictSdrCandidateHeldPairObservation,
): Promise<StrictSdrCandidateF2aMeasurement> {
  const lease = leases.get(pair as object);
  if (!lease || lease.closed || lease.evaluating) {
    throw new Error("Strict-SDR candidate F2a lease is absent, closed, or already evaluating.");
  }
  if (!observation || typeof observation.withF2aCommittedMediaDescriptor !== "function") {
    throw new Error("Strict-SDR candidate F2a evaluator requires Core's callback-scoped committed media descriptor.");
  }
  if (!matchesCurrentStrictSdrCandidateHeldPairObservation(pair, observation)) {
    throw new Error("Strict-SDR candidate F2a evaluator requires Core's exact active pair observation.");
  }
  lease.evaluating = true;
  try {
    return await observation.withF2aCommittedMediaDescriptor(async ({ fd, media }) => {
      if (!Number.isInteger(fd) || fd < 3 || media.sha256 !== observation.media.sha256 || media.byteLength !== observation.media.byteLength) {
        throw new Error("Strict-SDR candidate F2a Core descriptor callback did not preserve the committed media identity.");
      }
      const governor = lease.transfer.governor;
      const inverse = await governor.run({
        lane: "ffmpeg",
        operation: "ffmpeg.strict-sdr-candidate-f2a-inverse",
        scratchRoot: lease.transfer.scratchRoot,
        ...(lease.transfer.signal ? { signal: lease.transfer.signal } : {}),
        ...(lease.transfer.callerId ? { callerId: lease.transfer.callerId } : {}),
      }, async (context) => await lease.owner.runF2aInverse({
        sourceFd: fd,
        job: inverseJob(context, governor),
        compareDecoded: (decoded) => compareLinearSrgbSdrFinalFrames({
          width: lease.snapshot.route.canvas.width,
          height: lease.snapshot.route.canvas.height,
          source: lease.snapshot.bytes,
          decoded,
        }),
      }));
      if (!inverse.value.comparison.accepted) {
        throw new Error("Strict-SDR candidate F2a all-pixel first-frame comparison refused the committed media.");
      }
      return Object.freeze({
        schema: F2A_SCHEMA,
        media: Object.freeze({ sha256: media.sha256, byteLength: media.byteLength }),
        sourceFrame: Object.freeze({ sha256: lease.snapshot.sha256, byteLength: lease.snapshot.byteLength }),
        decodedFrame: Object.freeze({ ...inverse.value.decoded }),
        comparison: inverse.value.comparison,
        inverseCommandSha256: inverse.value.inverseCommandSha256,
        inverseJob: inverse.evidence,
      });
    });
  } finally {
    lease.evaluating = false;
  }
}

/** The child may read this only after `consumeStrictSdrCandidateHeldPair` itself resolved. */
export function strictSdrCandidateF2aFinalization(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateF2aFinalization {
  const finalization = finalizations.get(pair as object);
  if (!finalization) throw new Error("Strict-SDR candidate F2a finalization is absent or did not settle completely.");
  return finalization;
}

async function closeStrictSdrCandidateF2aLease(pair: StrictSdrCandidateHeldPair, lease: F2aLease): Promise<void> {
  if (lease.closed) return;
  lease.closed = true;
  const errors: unknown[] = [];
  try {
    lease.snapshot.bytes.fill(0);
  } catch (error) {
    errors.push(error);
  }
  try {
    await lease.owner.close();
  } catch (error) {
    errors.push(error);
  } finally {
    leases.delete(pair as object);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Strict-SDR candidate F2a private lease cleanup was uncertain.");
  finalizations.set(pair as object, Object.freeze({
    schema: "shellx-motion/strict-sdr-candidate-f2a-finalization@1",
    state: "complete",
    sourceFrameReleased: true,
    heldToolDescriptorsClosed: true,
    privateDecodeLeafRemoved: true,
    privateRootClosed: true,
  }));
}

function inverseJob(context: LocalMotionJobContext, governor: LocalMotionJobGovernor): LinearSrgbSdrFinalJob {
  return Object.freeze({
    admission: "pre-acquired" as const,
    signal: context.signal,
    scratchRoot: context.scratchRoot,
    maxProcessTreeRssBytes: governor.policy.maxProcessTreeRssBytes,
    watchProcess: (pid: number) => context.watchProcess(pid),
    reportProcessContainment: (evidence: LocalMotionProcessContainmentEvidence) => context.reportProcessContainment(evidence),
  });
}

function assertActiveScope(scope: F2aScope, preparation: string): void {
  if (!scope.active || scope.preparation !== preparation || !F2A_PREPARATION.test(preparation)) {
    throw new Error("Strict-SDR candidate F2a scope is expired or does not match the strict preparation.");
  }
}

function assertFrameMatchesRoute(route: LinearSrgbSdrFinalRoute, frame: LinearSrgbSdrFinalWebGpuFrame): void {
  const expected = route.canvas.width * route.canvas.height * 4;
  if (!Number.isSafeInteger(expected) || expected < 4 || route.canvas.width > LINEAR_SRGB_SDR_FINAL_MAX_WIDTH || route.canvas.height > LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT
    || frame.width !== route.canvas.width || frame.height !== route.canvas.height
    || frame.routeFingerprint !== route.fingerprint || frame.documentFingerprint !== route.documentFingerprint
    || frame.bytesPerRow !== route.canvas.width * 4 || frame.rgba8Srgb.byteLength !== expected) {
    throw new Error("Strict-SDR candidate F2a frame does not match its admitted route-bound RGBA layout.");
  }
}

function assertTransfer(transfer: StrictSdrCandidateF2aLeaseTransfer): void {
  if (!transfer || !transfer.binding || !transfer.governor || typeof transfer.governor.run !== "function"
    || !transfer.governor.policy || !Number.isSafeInteger(transfer.governor.policy.maxProcessTreeRssBytes) || transfer.governor.policy.maxProcessTreeRssBytes < 64 * 1024 * 1024
    || typeof transfer.scratchRoot !== "string" || transfer.scratchRoot.trim().length === 0
    || !F2A_PREPARATION.test(transfer.preparation)
    || transfer.signal !== undefined && typeof transfer.signal.aborted !== "boolean"
    || transfer.callerId !== undefined && (typeof transfer.callerId !== "string" || transfer.callerId.trim().length === 0)
  ) {
    throw new Error("Strict-SDR candidate F2a lease transfer did not retain bounded caller and governor facts.");
  }
}

function sameF2aRoute(route: LinearSrgbSdrFinalRoute): boolean {
  return route.canvas.width === F2A_WIDTH
    && route.canvas.height === F2A_HEIGHT
    && route.canvas.fps === F2A_FPS
    && route.canvas.durationMs === F2A_DURATION_MS;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
