/** Closed candidate-local three-slot diagnostic lifecycle. */
import { AsyncLocalStorage } from "node:async_hooks";
import { takeStrictSdrCandidateHeldPairCompletion, matchesCurrentStrictSdrCandidateHeldPairObservation, type StrictSdrCandidateHeldPair, type StrictSdrCandidateHeldPairObservation } from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import type { HeldTool } from "./linear-srgb-sdr-final-held-media-files.js";
import { evaluateStrictSdrCandidateThreeSlotCommittedDescriptor } from "./linear-srgb-sdr-final-three-slot-evaluation.js";
import { attachStrictSdrEvent18CoreCompletion, acceptStrictSdrEvent18LocalSlot, hasStrictSdrEvent18Pending, revokeStrictSdrEvent18Pending } from "./linear-srgb-sdr-final-three-slot-event18-pending.js";
import { strictSdrCandidateF2bSemanticVectors } from "./linear-srgb-sdr-final-three-slot-f2b-semantics.js";
import { borrowStrictSdrCandidateThreeSlotLiteralTools, markStrictSdrCandidateThreeSlotLiteralToolsFailure,
  registerStrictSdrCandidateThreeSlotLiteralFinalizer, resolveStrictSdrCandidateThreeSlotLiteralPair,
  settleStrictSdrCandidateThreeSlotLiteralTools, strictSdrCandidateThreeSlotDescriptor } from "./linear-srgb-sdr-final-three-slot-literal-bridge.js";
import { hasCurrentStrictSdrCandidateFrame0PackScope, initializeCurrentStrictSdrCandidateFrame0Pack, recordAndSealCurrentStrictSdrCandidateFrame0Pack } from "./linear-srgb-sdr-final-three-slot-frame0-pack.js";
import { hasCurrentStrictSdrCandidateAllDeliveredFrameObservationScope, initializeCurrentStrictSdrCandidateAllDeliveredFrameObservation, sealCurrentStrictSdrCandidateAllDeliveredFrameObservation } from "./linear-srgb-sdr-final-three-slot-temporal-observation.js";
import type { StrictSdrCandidateThreeSlotLeaseOwner, StrictSdrCandidateThreeSlotLeaseTransfer } from "./linear-srgb-sdr-final-three-slot-diagnostic-types.js";
import { assertStrictSdrCandidateThreeSlotFrame, strictSdrCandidateThreeSlotFrameSha256,
  type StrictSdrCandidateF2bScreenControlsThreeSlotMeasurement, type StrictSdrCandidateF2bScreenControlsThreeSlotSamples,
  type StrictSdrCandidateF2bScreenThreeSlotMeasurement, type StrictSdrCandidateThreeSlot,
  type StrictSdrCandidateThreeSlotBaseMeasurement, type StrictSdrCandidateThreeSlotF2aMeasurement } from "./linear-srgb-sdr-final-three-slot-measurement.js";
import { currentStrictSdrCandidateThreeSlotHeldToolsForActiveBorrow, type StrictSdrCandidateThreeSlotHeldTools } from "./linear-srgb-sdr-final-three-slot-held-tools.js";

const PREPARATION = /^[a-f0-9]{64}$/u;
type Snapshot = Readonly<{ bytes: Buffer; sha256: string; byteLength: number; route: LinearSrgbSdrFinalRoute }>;
type Scope = {
  readonly slot: StrictSdrCandidateThreeSlot;
  readonly tools: StrictSdrCandidateThreeSlotHeldTools;
  readonly preparation: string; readonly f2bSemanticVectors?: ReturnType<typeof strictSdrCandidateF2bSemanticVectors>;
  readonly event18PendingRequested: boolean;
  active: boolean;
  precommitActive: boolean;
  transferred: boolean;
  pair: StrictSdrCandidateHeldPair | undefined;
  pairFinalized: boolean;
  pairFinalizationSucceeded: boolean;
  temporal: boolean;
  snapshot: Snapshot | undefined;
};
export type { StrictSdrCandidateThreeSlotLeaseOwner, StrictSdrCandidateThreeSlotLeaseTransfer } from "./linear-srgb-sdr-final-three-slot-diagnostic-types.js";

export type { StrictSdrCandidateF2bScreenControlsThreeSlotMeasurement, StrictSdrCandidateF2bScreenThreeSlotMeasurement,
  StrictSdrCandidateThreeSlotAllPixelMeasurement, StrictSdrCandidateThreeSlotDecodedMeasurement,
  StrictSdrCandidateThreeSlotF2aMeasurement } from "./linear-srgb-sdr-final-three-slot-measurement.js";

export { strictSdrCandidateF2bScreenControlsThreeSlotFinalization, strictSdrCandidateF2bScreenThreeSlotFinalization, strictSdrCandidateThreeSlotF2aFinalization } from "./linear-srgb-sdr-final-three-slot-finalization.js";
export type { StrictSdrCandidateF2bScreenControlsThreeSlotFinalization, StrictSdrCandidateF2bScreenThreeSlotFinalization, StrictSdrCandidateThreeSlotF2aFinalization } from "./linear-srgb-sdr-final-three-slot-finalization.js";

type Lease = {
  readonly slot: StrictSdrCandidateThreeSlot;
  readonly scope: Scope;
  readonly owner: StrictSdrCandidateThreeSlotLeaseOwner;
  readonly snapshot: Snapshot;
  readonly transfer: StrictSdrCandidateThreeSlotLeaseTransfer;
  evaluating: boolean;
  evaluated: boolean;
  evaluationSucceeded: boolean;
  closed: boolean;
};

const scopes = new AsyncLocalStorage<Scope>();
const leases = new WeakMap<object, Lease>();

/** Scope the literal F2a slot, borrowing the already-open tool owner explicitly. */
export function withStrictSdrCandidateThreeSlotF2aEvaluation<T>(
  tools: StrictSdrCandidateThreeSlotHeldTools,
  preparation: string,
  operation: () => Promise<T> | T,
  event18PendingRequested = false,
): Promise<T> { return withScope("f2a", tools, preparation, operation, undefined, event18PendingRequested); }

/** Scope the literal F2b screen slot, borrowing the already-open tool owner explicitly. */
export function withStrictSdrCandidateF2bScreenThreeSlotEvaluation<T>(
  tools: StrictSdrCandidateThreeSlotHeldTools,
  preparation: string,
  operation: () => Promise<T> | T,
  event18PendingRequested = false,
): Promise<T> { return withScope("f2b-screen", tools, preparation, operation, undefined, event18PendingRequested); }

/** Scope the literal F2b controls slot, borrowing the already-open tool owner explicitly. */
export function withStrictSdrCandidateF2bScreenControlsThreeSlotEvaluation<T>(
  tools: StrictSdrCandidateThreeSlotHeldTools,
  preparation: string,
  operation: () => Promise<T> | T,
  admittedVectorFixture?: Buffer,
  event18PendingRequested = false,
): Promise<T> { return withScope("f2b-screen-controls", tools, preparation, operation, admittedVectorFixture, event18PendingRequested); }

/** Only the child calls this after Core's whole consume promise, while its literal diagnostic scope remains live. */
export function attachCurrentStrictSdrEvent18CoreCompletion(pair: StrictSdrCandidateHeldPair): void {
  const scope = scopes.getStore();
  if (!scope || !scope.active || !scope.event18PendingRequested || scope.pair !== pair || !scope.pairFinalized || !scope.pairFinalizationSucceeded || !hasStrictSdrEvent18Pending(pair)) {
    throw new Error("Strict-SDR Event-18 Core completion is outside its finalized literal diagnostic scope.");
  }
  attachStrictSdrEvent18CoreCompletion(pair, takeStrictSdrCandidateHeldPairCompletion(pair));
}

/** Bounded slot proof after all literal slots, held tools and review pack settle. */
export { acceptStrictSdrEvent18LocalSlot, revokeStrictSdrEvent18Pending };

/** Held-media calls this after ordinary route validation and before publication staging. */
export function captureCurrentStrictSdrCandidateThreeSlotFrame(
  route: LinearSrgbSdrFinalRoute,
  frame: LinearSrgbSdrFinalWebGpuFrame,
): void {
  const scope = scopes.getStore();
  if (!scope) return;
  assertPrecommitScope(scope);
  if (scope.snapshot || scope.transferred) throw new Error("Strict-SDR three-slot source frame capture was duplicated.");
  assertStrictSdrCandidateThreeSlotFrame(scope.slot, route, frame);
  const bytes = Buffer.from(frame.rgba8Srgb);
  if (strictSdrCandidateThreeSlotFrameSha256(bytes) !== frame.rgba8SrgbSha256) {
    bytes.fill(0);
    throw new Error("Strict-SDR three-slot frame copy did not preserve the producer hash.");
  }
  scope.snapshot = Object.freeze({ bytes, sha256: frame.rgba8SrgbSha256, byteLength: bytes.byteLength, route });
}

/** Held-media reads the active opaque borrower only while a literal scope is live. */
export async function currentStrictSdrCandidateThreeSlotHeldTools(): Promise<Readonly<{
  ffmpeg: HeldTool;
  ffprobe: HeldTool;
}> | undefined> {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  assertPrecommitScope(scope);
  return await currentStrictSdrCandidateThreeSlotHeldToolsForActiveBorrow(scope.tools);
}

/** Release an untransferred frame before a failed held-media root closes. */
export function discardCurrentStrictSdrCandidateThreeSlotFrame(): void {
  const scope = scopes.getStore();
  if (!scope || !scope.snapshot) return;
  scope.snapshot.bytes.fill(0);
  scope.snapshot = undefined;
}

/** Held-media invokes this only at its staged-publication boundary; the active named scope chooses the literal Core path. */
export function transferCurrentStrictSdrCandidateThreeSlotLease(
  owner: StrictSdrCandidateThreeSlotLeaseOwner,
  transfer: StrictSdrCandidateThreeSlotLeaseTransfer,
): boolean {
  const scope = scopes.getStore();
  if (!scope) return false;
  assertPrecommitScope(scope);
  if (!scope.snapshot || scope.transferred) throw new Error("Strict-SDR three-slot frame lease is absent or already transferred.");
  assertTransfer(transfer);
  if (scope.preparation !== transfer.preparation || !owner || typeof owner.close !== "function" || typeof owner.runThreeSlotInverse !== "function" || typeof owner.runThreeSlotAllDeliveredFrames !== "function") {
    throw new Error("Strict-SDR three-slot held-media transfer does not match its active scope.");
  }
  const frame0 = hasCurrentStrictSdrCandidateFrame0PackScope(scope.slot, scope.preparation);
  const temporal = hasCurrentStrictSdrCandidateAllDeliveredFrameObservationScope(scope.slot, scope.preparation);
  if (frame0 !== temporal) throw new Error("Strict-SDR same-parent temporal scope must be paired with its literal frame-zero scope.");
  const pair = frame0
    ? initializeCurrentStrictSdrCandidateFrame0Pack(scope.slot, transfer.binding, scope.preparation, transfer.signal)
    : resolveStrictSdrCandidateThreeSlotLiteralPair(scope.slot, transfer.binding);
  if (temporal) initializeCurrentStrictSdrCandidateAllDeliveredFrameObservation(scope.slot, pair, scope.preparation);
  if (leases.has(pair as object)) throw new Error("Strict-SDR three-slot pair already has a private lease.");
  const lease: Lease = { slot: scope.slot, scope, owner, snapshot: scope.snapshot, transfer, evaluating: false, evaluated: false, evaluationSucceeded: false, closed: false };
  leases.set(pair as object, lease);
  try {
    registerFinalizer(scope.slot, pair, async () => await closeLease(pair, lease));
  } catch (error) {
    leases.delete(pair as object);
    throw error;
  }
  scope.snapshot = undefined;
  scope.pair = pair;
  scope.temporal = temporal;
  scope.transferred = true;
  scope.precommitActive = false;
  return true;
}

/** F2a’s literal post-commit evaluator; it records observations and never introduces F2b policy. */
export async function evaluateStrictSdrCandidateThreeSlotF2aHeldPair(
  pair: StrictSdrCandidateHeldPair,
  observation: StrictSdrCandidateHeldPairObservation,
): Promise<StrictSdrCandidateThreeSlotF2aMeasurement> {
  const base = await evaluate(pair, observation, "f2a");
  return Object.freeze({ schema: "shellx-motion/strict-sdr-candidate-three-slot-f2a-measurement@1", ...base });
}

/** F2b screen’s literal post-commit evaluator; output is measurement-only. */
export async function evaluateStrictSdrCandidateF2bScreenThreeSlotHeldPair(
  pair: StrictSdrCandidateHeldPair,
  observation: StrictSdrCandidateHeldPairObservation,
): Promise<StrictSdrCandidateF2bScreenThreeSlotMeasurement> {
  const base = await evaluate(pair, observation, "f2b-screen");
  return Object.freeze({ schema: "shellx-motion/strict-sdr-candidate-f2b-screen-three-slot-measurement@1", ...base });
}

/** F2b controls’ literal post-commit evaluator records the three sealed vector locations only. */
export async function evaluateStrictSdrCandidateF2bScreenControlsThreeSlotHeldPair(
  pair: StrictSdrCandidateHeldPair,
  observation: StrictSdrCandidateHeldPairObservation,
): Promise<StrictSdrCandidateF2bScreenControlsThreeSlotMeasurement> {
  const base = await evaluate(pair, observation, "f2b-screen-controls", true);
  return Object.freeze({ schema: "shellx-motion/strict-sdr-candidate-f2b-screen-controls-three-slot-measurement@1", ...base, samples: base.samples! });
}

async function withScope<T>(slot: StrictSdrCandidateThreeSlot, tools: StrictSdrCandidateThreeSlotHeldTools, preparation: string, operation: () => Promise<T> | T, admittedVectorFixture?: Buffer, event18PendingRequested = false): Promise<T> {
  if (!PREPARATION.test(preparation)) throw new Error("Strict-SDR three-slot evaluation requires an exact preparation fingerprint.");
  if (scopes.getStore()) throw new Error("Strict-SDR three-slot evaluation scopes are nonnestable.");
  if (admittedVectorFixture !== undefined && slot !== "f2b-screen-controls") throw new Error("Strict SDR F2b controls vector fixture was passed to another slot.");
  if (event18PendingRequested && slot === "f2b-screen-controls" && admittedVectorFixture === undefined) throw new Error("Strict-SDR Event-18 pending controls require the immutable F2b vector fixture.");
  const f2bSemanticVectors = admittedVectorFixture === undefined ? undefined : strictSdrCandidateF2bSemanticVectors(admittedVectorFixture);
  await borrow(slot, tools);
  const scope: Scope = {
    slot,
    tools,
    preparation, event18PendingRequested, ...(f2bSemanticVectors ? { f2bSemanticVectors } : {}),
    active: true,
    precommitActive: true,
    transferred: false,
    pair: undefined,
    pairFinalized: false,
    pairFinalizationSucceeded: false,
    temporal: false,
    snapshot: undefined,
  };
  let primary: unknown;
  let hasPrimary = false;
  try {
    return await scopes.run(scope, operation);
  } catch (error) {
    primary = error;
    hasPrimary = true;
    throw error;
  } finally {
    scope.active = false;
    let scopeClosedSuccessfully = false;
    try {
      if (scope.snapshot) scope.snapshot.bytes.fill(0);
      scope.snapshot = undefined;
      if (scope.transferred && !scope.pairFinalized) {
        markFailure(slot, tools);
        if (!hasPrimary) throw new Error("Strict-SDR three-slot scope returned before its Core pair finalizer completed.");
      } else {
        const requiredFailure = !scope.transferred
          ? new Error("Strict-SDR three-slot terminal returned without registering its literal pair lease.")
          : !scope.pairFinalizationSucceeded
            ? new Error("Strict-SDR three-slot pair finalizer retained uncertain cleanup.")
            : undefined;
        let sealFailure: unknown;
        let hasSealFailure = false;
        if (!hasPrimary && !requiredFailure && scope.pair) {
          try {
            await recordAndSealCurrentStrictSdrCandidateFrame0Pack(scope.pair, slot);
            if (scope.temporal) sealCurrentStrictSdrCandidateAllDeliveredFrameObservation(scope.pair, slot);
          } catch (error) {
            sealFailure = error;
            hasSealFailure = true;
            primary = error;
            hasPrimary = true;
          }
        }
        const settled = !hasPrimary && !requiredFailure;
        if (!settled) markFailure(slot, tools);
        try {
          settle(slot, tools, settled);
        } catch (cleanup) {
          if (hasPrimary) throw new AggregateError([primary, cleanup], "Strict-SDR three-slot scope failed and its tool borrow did not settle.");
          throw new AggregateError([requiredFailure!, cleanup], "Strict-SDR three-slot scope could not settle its tool borrow.");
        }
        if (!settled && !hasPrimary) throw requiredFailure;
        if (hasSealFailure) throw sealFailure;
      }
      scopeClosedSuccessfully = !hasPrimary;
    } finally {
      if (!scopeClosedSuccessfully) revokeStrictSdrEvent18Pending(scope.pair);
    }
  }
}

async function evaluate(
  pair: StrictSdrCandidateHeldPair,
  observation: StrictSdrCandidateHeldPairObservation,
  slot: StrictSdrCandidateThreeSlot,
  controls = false,
): Promise<StrictSdrCandidateThreeSlotBaseMeasurement & { samples?: StrictSdrCandidateF2bScreenControlsThreeSlotSamples }> {
  const lease = leases.get(pair as object);
  if (!lease || lease.slot !== slot || lease.closed || lease.evaluating || lease.evaluated) throw new Error("Strict-SDR three-slot lease is absent, closed, already evaluated, or does not match its literal evaluator.");
  if (!matchesCurrentStrictSdrCandidateHeldPairObservation(pair, observation)) throw new Error("Strict-SDR three-slot evaluator requires Core's exact active pair observation.");
  const descriptor = strictSdrCandidateThreeSlotDescriptor(slot, observation);
  lease.evaluating = true;
  lease.evaluated = true;
  try {
    const result = await evaluateStrictSdrCandidateThreeSlotCommittedDescriptor({
      pair,
      observation,
      slot,
      controls,
      descriptor,
      expectedMedia: observation.media,
      snapshot: lease.snapshot,
      transfer: lease.transfer,
      owner: lease.owner,
      temporal: lease.scope.temporal, f2bSemanticVectors: lease.scope.f2bSemanticVectors,
      event18PendingRequested: lease.scope.event18PendingRequested,
    });
    lease.evaluationSucceeded = true;
    return result;
  } finally {
    lease.evaluating = false;
  }
}

async function closeLease(pair: StrictSdrCandidateHeldPair, lease: Lease): Promise<void> {
  if (lease.closed) return;
  lease.closed = true;
  const errors: unknown[] = [];
  let succeeded = lease.evaluationSucceeded && lease.scope.active;
  try { lease.snapshot.bytes.fill(0); } catch (error) { errors.push(error); succeeded = false; }
  try { await lease.owner.close(); } catch (error) { errors.push(error); succeeded = false; }
  leases.delete(pair as object);
  lease.scope.pairFinalized = true;
  lease.scope.pairFinalizationSucceeded = succeeded;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Strict-SDR three-slot pair finalizer retained uncertain cleanup.");
}

async function borrow(slot: StrictSdrCandidateThreeSlot, tools: StrictSdrCandidateThreeSlotHeldTools): Promise<void> {
  await borrowStrictSdrCandidateThreeSlotLiteralTools(slot, tools);
}
function settle(slot: StrictSdrCandidateThreeSlot, tools: StrictSdrCandidateThreeSlotHeldTools, success: boolean): void {
  settleStrictSdrCandidateThreeSlotLiteralTools(slot, tools, success);
}
function markFailure(slot: StrictSdrCandidateThreeSlot, tools: StrictSdrCandidateThreeSlotHeldTools): void {
  markStrictSdrCandidateThreeSlotLiteralToolsFailure(slot, tools);
}
function registerFinalizer(slot: StrictSdrCandidateThreeSlot, pair: StrictSdrCandidateHeldPair, finalizer: () => Promise<void>): void {
  registerStrictSdrCandidateThreeSlotLiteralFinalizer(slot, pair, finalizer);
}
function assertScope(scope: Scope): void {
  if (!scope.active || !PREPARATION.test(scope.preparation)) throw new Error("Strict-SDR three-slot evaluation scope is expired or malformed.");
}
function assertPrecommitScope(scope: Scope): void {
  assertScope(scope);
  if (!scope.precommitActive) throw new Error("Strict-SDR three-slot precommit capture and held-tool access expired after lease transfer.");
}
function assertTransfer(transfer: StrictSdrCandidateThreeSlotLeaseTransfer): void {
  if (!transfer || !transfer.binding || !transfer.governor || typeof transfer.governor.run !== "function" || !transfer.governor.policy
    || !Number.isSafeInteger(transfer.governor.policy.maxProcessTreeRssBytes) || transfer.governor.policy.maxProcessTreeRssBytes < 64 * 1024 * 1024
    || typeof transfer.scratchRoot !== "string" || transfer.scratchRoot.trim().length === 0 || !PREPARATION.test(transfer.preparation)
    || transfer.signal !== undefined && typeof transfer.signal.aborted !== "boolean"
    || transfer.callerId !== undefined && (typeof transfer.callerId !== "string" || transfer.callerId.trim().length === 0)) {
    throw new Error("Strict-SDR three-slot lease transfer lacks bounded governor and caller facts.");
  }
}
