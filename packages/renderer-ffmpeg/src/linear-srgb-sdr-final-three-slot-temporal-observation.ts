/**
 * Private same-parent all-delivered-frame observation registry. It has no public
 * barrel, request, selector, path or frame-buffer surface.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  strictSdrCandidateF2bScreenControlsThreeSlotFinalization,
  strictSdrCandidateF2bScreenThreeSlotFinalization,
  strictSdrCandidateThreeSlotF2aFinalization,
} from "./linear-srgb-sdr-final-three-slot-finalization.js";
import { snapshotStrictSdrCandidateFrame0PackInverseJob, type StrictSdrCandidateFrame0PackInverseJob } from "./linear-srgb-sdr-final-three-slot-frame0-pack-evidence.js";
import {
  assertStrictSdrCandidateThreeSlot2dTemporalSpatialRecord,
  assertStrictSdrCandidateThreeSlot2dTemporalSpatialStage,
  assertStrictSdrCandidateThreeSlotM1aMeasurementExpectation,
  type StrictSdrCandidateThreeSlot2dSpatialFrame,
  type StrictSdrCandidateThreeSlot2dSpatialPlan,
  type StrictSdrCandidateThreeSlotM1aMeasurementExpectation,
  type StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair,
} from "./linear-srgb-sdr-final-three-slot-2d-measurement.js";
import type { StrictSdrCandidateF2bScreenControlsThreeSlotSamples, StrictSdrCandidateThreeSlot, StrictSdrCandidateThreeSlotAllPixelMeasurement } from "./linear-srgb-sdr-final-three-slot-measurement.js";
import { hasStrictSdrEvent18Pending, revokeStrictSdrEvent18Pending, sealStrictSdrEvent18OuterScope } from "./linear-srgb-sdr-final-three-slot-event18-pending.js";
import {
  assertStrictSdrCandidateAllDeliveredFrameCanonicalBound,
  assertStrictSdrCandidateAllDeliveredFrameObservationBinding,
  assertStrictSdrCandidateAllDeliveredFrameStageInput,
  assertStrictSdrCandidateThreeSlotQ1StaticContinuityCapability,
  assertStrictSdrCandidateThreeSlotQ1StaticContinuityFactoryPlan,
  assertStrictSdrCandidateThreeSlotQ1StaticContinuityRecord,
  assertStrictSdrCandidateThreeSlotQ1StaticContinuityStage,
  assertStrictSdrDecodedQualityCapability,
  type StrictSdrCandidateAllDeliveredFrameFact,
  type StrictSdrCandidateAllDeliveredFrameObservation,
  type StrictSdrCandidateAllDeliveredFrameObservationBinding,
  type StrictSdrCandidateThreeSlotQ1StaticContinuityCapability,
  type StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan,
  type StrictSdrDecodedQualityCapability,
} from "./linear-srgb-sdr-final-three-slot-observation-contract.js";
export {
  assertStrictSdrCandidateAllDeliveredFrameObservationBinding,
  assertStrictSdrCandidateAllDeliveredFrameObservationEnvelope,
} from "./linear-srgb-sdr-final-three-slot-observation-contract.js";
export type {
  StrictSdrCandidateAllDeliveredFrameFact,
  StrictSdrCandidateAllDeliveredFrameObservation,
  StrictSdrCandidateThreeSlotQ1StaticContinuityCapability,
} from "./linear-srgb-sdr-final-three-slot-observation-contract.js";
const PREPARATION = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FRAME_BYTES = 3_686_400;
const FRAME_COUNT = 60;
const DECODED_BYTES = 221_184_000;

type Slot = StrictSdrCandidateThreeSlot;
type Snapshot = Readonly<{ bytes: Buffer; sha256: string; byteLength: number; route: LinearSrgbSdrFinalRoute }>;
type PairFacts = Readonly<{ media: Readonly<{ sha256: string; byteLength: number }>; receipt: Readonly<{ sha256: string; byteLength: number }> }>;
type Scope = { readonly slot: Slot; readonly preparation: string; readonly binding: StrictSdrCandidateAllDeliveredFrameObservationBinding; readonly m1a: StrictSdrCandidateThreeSlotM1aMeasurementExpectation | undefined; readonly q1: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability | undefined; readonly quality: StrictSdrDecodedQualityCapability | undefined; active: boolean; pair: StrictSdrCandidateHeldPair | undefined };
type Lease = { readonly slot: Slot; readonly binding: StrictSdrCandidateAllDeliveredFrameObservationBinding; readonly preparation: string;
  readonly m1a: StrictSdrCandidateThreeSlotM1aMeasurementExpectation | undefined; readonly q1: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability | undefined;
  pairFacts: PairFacts | undefined; snapshot: Snapshot | undefined;
  spatialPlan: StrictSdrCandidateThreeSlot2dSpatialPlan | undefined; q1Plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan | undefined; spatialContinuityPlan: unknown;
  frames: StrictSdrCandidateAllDeliveredFrameFact[];
  recording: boolean;
  recorded: StrictSdrCandidateAllDeliveredFrameObservation | undefined;
  sealed: StrictSdrCandidateAllDeliveredFrameObservation | undefined;
  read: boolean;
};

const scopes = new AsyncLocalStorage<Scope>();
const leases = new WeakMap<object, Lease>();

export function withStrictSdrCandidateThreeSlotF2aAllDeliveredFrameObservation<T>(binding: unknown, preparation: string, operation: () => Promise<T> | T, m1a?: StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair, q1?: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability, quality?: StrictSdrDecodedQualityCapability): Promise<T> {
  return withScope("f2a", binding, preparation, operation, m1a, q1, quality);
}
export function withStrictSdrCandidateF2bScreenAllDeliveredFrameObservation<T>(binding: unknown, preparation: string, operation: () => Promise<T> | T, m1a?: StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair, q1?: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability, quality?: StrictSdrDecodedQualityCapability): Promise<T> {
  return withScope("f2b-screen", binding, preparation, operation, m1a, q1, quality);
}
export function withStrictSdrCandidateF2bScreenControlsAllDeliveredFrameObservation<T>(binding: unknown, preparation: string, operation: () => Promise<T> | T, m1a?: StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair, q1?: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability, quality?: StrictSdrDecodedQualityCapability): Promise<T> {
  return withScope("f2b-screen-controls", binding, preparation, operation, m1a, q1, quality);
}
/** The diagnostic has already resolved Core's literal pair exactly once. */
export function initializeCurrentStrictSdrCandidateAllDeliveredFrameObservation(slot: Slot, pair: StrictSdrCandidateHeldPair, preparation: string): void {
  const scope = scopes.getStore();
  if (!scope || !scope.active || scope.slot !== slot || scope.preparation !== preparation || scope.pair || !pair || leases.has(pair as object)) {
    throw new Error("Strict-SDR all-delivered-frame initializer does not match its active literal pair transfer.");
  }
  scope.pair = pair;
  leases.set(pair as object, { slot, binding: scope.binding, preparation, m1a: scope.m1a, q1: scope.q1, pairFacts: undefined, snapshot: undefined, spatialPlan: undefined, q1Plan: undefined, spatialContinuityPlan: undefined, frames: [], recording: false, recorded: undefined, sealed: undefined, read: false });
}

export function hasCurrentStrictSdrCandidateAllDeliveredFrameObservationScope(slot: Slot, preparation: string): boolean {
  const scope = scopes.getStore();
  return !!scope && scope.active && scope.slot === slot && scope.preparation === preparation && !scope.pair;
}
export function currentStrictSdrCandidateThreeSlotM1aMeasurementExpectation(slot: Slot, preparation: string): StrictSdrCandidateThreeSlotM1aMeasurementExpectation | undefined {
  const scope = scopes.getStore();
  if (!scope || !scope.active || scope.slot !== slot || scope.preparation !== preparation || !scope.pair) {
    throw new Error("Strict-SDR M1a spatial expectation is unavailable outside its active literal all-delivered-frame scope.");
  }
  return activeLease(scope.pair, slot)?.m1a;
}
export function currentStrictSdrCandidateThreeSlotQ1StaticContinuityCapability(slot: Slot, preparation: string): StrictSdrCandidateThreeSlotQ1StaticContinuityCapability | undefined {
  const scope = scopes.getStore();
  if (!scope || !scope.active || scope.slot !== slot || scope.preparation !== preparation || !scope.pair) {
    throw new Error("Strict-SDR Q1 static-continuity capability is unavailable outside its active literal all-delivered-frame scope.");
  }
  return activeLease(scope.pair, slot)?.q1;
}
export function currentStrictSdrDecodedQualityCapability(slot: Slot, preparation: string): StrictSdrDecodedQualityCapability | undefined {
  const scope = scopes.getStore();
  if (!scope || !scope.active || scope.slot !== slot || scope.preparation !== preparation || !scope.pair) {
    throw new Error("Strict SDR decoded quality capability is unavailable outside its literal scope");
  }
  return scope.quality;
}
export function registerCurrentStrictSdrCandidateThreeSlotQ1StaticContinuityPlan(slot: Slot, preparation: string, plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan): void {
  const scope = scopes.getStore(), lease = scope?.pair && activeLease(scope.pair, slot);
  if (!scope || !scope.active || scope.slot !== slot || scope.preparation !== preparation || !lease || !lease.m1a?.q1StaticContinuity || !lease.q1 || lease.q1Plan !== undefined || lease.spatialContinuityPlan !== undefined || lease.frames.length !== 0) {
    throw new Error("Strict-SDR Q1 factory plan is unavailable outside its pre-governor literal scope.");
  }
  lease.spatialContinuityPlan = assertStrictSdrCandidateThreeSlotQ1StaticContinuityFactoryPlan({
    expected: lease.m1a,
    capability: lease.q1,
    spatialContinuityPlan: plan.spatialContinuityPlan,
  });
  lease.q1Plan = plan;
}
/** Called by the fixed all-frame evaluator; no raw RGBA bytes are retained here. */
export function stageCurrentStrictSdrCandidateAllDeliveredFrameObservation(input: Readonly<{
  slot: Slot;
  pair: StrictSdrCandidateHeldPair;
  observation: StrictSdrCandidateHeldPairObservation;
  snapshot: Snapshot;
  frameIndex: number;
  decodedFrame: Readonly<{ sha256: string; byteLength: number }>;
  allPixels: StrictSdrCandidateThreeSlotAllPixelMeasurement;
  samples?: StrictSdrCandidateF2bScreenControlsThreeSlotSamples;
  spatialPlan?: StrictSdrCandidateThreeSlot2dSpatialPlan;
  spatial?: StrictSdrCandidateThreeSlot2dSpatialFrame;
  spatialContinuityPlan?: unknown;
  spatialContinuity?: unknown;
}>): void {
  const lease = activeLease(input.pair, input.slot);
  if (!lease || lease.recording || lease.recorded || lease.sealed) {
    throw new Error("Strict-SDR all-delivered-frame stage does not retain its exact descriptor-bound literal frame facts.");
  }
  assertStrictSdrCandidateAllDeliveredFrameStageInput({
    pair: input.pair, slot: input.slot, expectedFrameIndex: lease.frames.length, observation: input.observation,
    snapshot: input.snapshot, frameIndex: input.frameIndex, decodedFrame: input.decodedFrame,
    allPixels: input.allPixels, ...(input.samples === undefined ? {} : { samples: input.samples }),
  });
  const spatial = assertStrictSdrCandidateThreeSlot2dTemporalSpatialStage({
    expected: lease.m1a,
    priorSpatialPlan: lease.spatialPlan,
    spatialPlan: input.spatialPlan,
    spatial: input.spatial,
  });
  const q1 = assertStrictSdrCandidateThreeSlotQ1StaticContinuityStage({
    expected: lease.m1a, capability: lease.q1, plan: lease.q1Plan,
    registeredSpatialContinuityPlan: lease.spatialContinuityPlan,
    spatialContinuityPlan: input.spatialContinuityPlan, spatialContinuity: input.spatialContinuity,
  });
  const pairFacts = Object.freeze({ media: Object.freeze({ ...input.observation.media }), receipt: Object.freeze({ ...input.observation.receipt }) });
  if (lease.pairFacts && (lease.pairFacts.media.sha256 !== pairFacts.media.sha256 || lease.pairFacts.media.byteLength !== pairFacts.media.byteLength
    || lease.pairFacts.receipt.sha256 !== pairFacts.receipt.sha256 || lease.pairFacts.receipt.byteLength !== pairFacts.receipt.byteLength)) {
    throw new Error("Strict-SDR all-delivered-frame descriptor facts changed between literal frames.");
  }
  if (lease.snapshot && (lease.snapshot !== input.snapshot || lease.snapshot.sha256 !== input.snapshot.sha256)) {
    throw new Error("Strict-SDR all-delivered-frame source snapshot changed between literal frames.");
  }
  lease.pairFacts ??= pairFacts;
  lease.snapshot ??= input.snapshot;
  lease.spatialPlan ??= spatial.spatialPlan;
  lease.frames.push(Object.freeze({
    frameIndex: input.frameIndex,
    decodedFrame: Object.freeze({ sha256: input.decodedFrame.sha256, byteLength: FRAME_BYTES }),
    allPixels: Object.freeze({ ...input.allPixels }),
    ...(input.samples === undefined ? {} : { samples: Object.freeze(input.samples.map((sample) => Object.freeze({
      name: sample.name, x: sample.x, y: sample.y,
      sourceRgba8: Object.freeze([...sample.sourceRgba8]) as readonly [number, number, number, number],
      decodedRgba8: Object.freeze([...sample.decodedRgba8]) as readonly [number, number, number, number],
    }))) }),
    ...(spatial.spatial === undefined ? {} : { spatial: spatial.spatial.spatial }),
    ...(q1 === undefined ? {} : { spatialContinuity: q1.spatialContinuity }),
  }));
}

/** Called only after binary settlement and Core's one-shot fresh pair verification. */
export function recordCurrentStrictSdrCandidateAllDeliveredFrameObservation(input: Readonly<{
  pair: StrictSdrCandidateHeldPair;
  slot: Slot;
  heldFfmpeg: Readonly<{ sha256: string }>;
  inverseCommandSha256: string;
  inverseJob: StrictSdrCandidateFrame0PackInverseJob;
}>): StrictSdrCandidateAllDeliveredFrameObservation {
  const lease = activeLease(input.pair, input.slot);
  if (!lease || lease.recording || lease.recorded || lease.sealed || !lease.pairFacts || !lease.snapshot || lease.frames.length !== FRAME_COUNT
    || !SHA256.test(input.heldFfmpeg.sha256) || !SHA256.test(input.inverseCommandSha256)) {
    throw new Error("Strict-SDR all-delivered-frame record lacks complete fresh descriptor-bound frame facts.");
  }
  const snapshot = lease.snapshot, route = snapshot.route;
  assertStrictSdrCandidateThreeSlot2dTemporalSpatialRecord({ expected: lease.m1a, spatialPlan: lease.spatialPlan, snapshot, frames: lease.frames });
  assertStrictSdrCandidateThreeSlotQ1StaticContinuityRecord({
    expected: lease.m1a, capability: lease.q1, plan: lease.q1Plan,
    spatialContinuityPlan: lease.spatialContinuityPlan, frames: lease.frames,
  });
  if (route.canvas.width !== 1280 || route.canvas.height !== 720 || route.canvas.fps !== 30 || route.canvas.durationMs !== 2_000
    || !SHA256.test(route.fingerprint) || !SHA256.test(route.documentFingerprint)
    || lease.frames.some((frame, index) => frame.frameIndex !== index)) {
    throw new Error("Strict-SDR all-delivered-frame record no longer matches its admitted static route.");
  }
  lease.recording = true;
  try {
    const sourceSequence: StrictSdrCandidateAllDeliveredFrameObservation["sourceSequence"] = Object.freeze({ mode: "repeated-static", frameSha256: snapshot.sha256, frameCount: FRAME_COUNT, sequenceSha256: canonicalJsonSha256({ mode: "repeated-static", frameSha256: snapshot.sha256, frameCount: FRAME_COUNT }) });
    const record: StrictSdrCandidateAllDeliveredFrameObservation = Object.freeze({
      schema: "shellx-motion/strict-sdr-candidate-all-delivered-frame-observation@1",
      slot: input.slot,
      media: Object.freeze({ ...lease.pairFacts.media }),
      receipt: Object.freeze({ ...lease.pairFacts.receipt }),
      sourceFrame: Object.freeze({ sha256: snapshot.sha256, byteLength: FRAME_BYTES }),
      route: Object.freeze({ fingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint }),
      preparation: lease.preparation,
      sourceSequence,
      heldFfmpeg: Object.freeze({ sha256: input.heldFfmpeg.sha256 }),
      inverseCommandSha256: input.inverseCommandSha256,
      inverseJob: snapshotStrictSdrCandidateFrame0PackInverseJob(input.inverseJob),
      frameCount: FRAME_COUNT,
      decodedByteLength: DECODED_BYTES,
      sequenceSha256: canonicalJsonSha256(lease.frames),
      ...(lease.spatialPlan === undefined ? {} : { spatialPlan: lease.spatialPlan }),
      ...(lease.spatialContinuityPlan === undefined ? {} : { spatialContinuityPlan: lease.spatialContinuityPlan }),
      frames: Object.freeze([...lease.frames]),
    });
    assertStrictSdrCandidateAllDeliveredFrameCanonicalBound(record, lease.binding.maxSlotReportBytes, "Strict-SDR all-delivered-frame slot record");
    lease.recorded = record;
    return record;
  } finally {
    lease.recording = false;
  }
}

/** Diagnostic scope calls this after pair-local finalization and before held-tool settlement. */
export function sealCurrentStrictSdrCandidateAllDeliveredFrameObservation(pair: StrictSdrCandidateHeldPair, slot: Slot): void {
  const lease = activeLease(pair, slot);
  if (!lease || !lease.recorded || lease.sealed || lease.recording || !finalizationComplete(pair, slot)) {
    throw new Error("Strict-SDR all-delivered-frame observation cannot seal before complete pair-local finalization.");
  }
  lease.sealed = lease.recorded;
}

export function readStrictSdrCandidateThreeSlotF2aAllDeliveredFrameObservation(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateAllDeliveredFrameObservation { return read(pair, "f2a"); }
export function readStrictSdrCandidateF2bScreenAllDeliveredFrameObservation(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateAllDeliveredFrameObservation { return read(pair, "f2b-screen"); }
export function readStrictSdrCandidateF2bScreenControlsAllDeliveredFrameObservation(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateAllDeliveredFrameObservation { return read(pair, "f2b-screen-controls"); }

async function withScope<T>(slot: Slot, rawBinding: unknown, preparation: string, operation: () => Promise<T> | T, rawM1a: StrictSdrCandidateThreeSlotM1aSpatialMeasurementPair | undefined, rawQ1: StrictSdrCandidateThreeSlotQ1StaticContinuityCapability | undefined, rawQuality: StrictSdrDecodedQualityCapability | undefined): Promise<T> {
  if (scopes.getStore() || !PREPARATION.test(preparation)) throw new Error("Strict-SDR all-delivered-frame scope is malformed or nested.");
  const m1a = rawM1a === undefined ? undefined : assertStrictSdrCandidateThreeSlotM1aMeasurementExpectation(rawM1a, slot);
  const q1 = rawQ1 === undefined ? undefined : assertStrictSdrCandidateThreeSlotQ1StaticContinuityCapability(rawQ1);
  if ((m1a?.q1StaticContinuity !== undefined) !== (q1 !== undefined)) {
    throw new Error("Strict-SDR Q1 static-continuity capability must be present exactly for an @3 M1 binding.");
  }
  const quality = rawQuality === undefined ? undefined : assertStrictSdrDecodedQualityCapability(rawQuality, slot);
  if (quality && (!m1a?.q1StaticContinuity || !q1)) {
    throw new Error("Strict SDR decoded quality requires a complete held @3 M1/Q1 scope");
  }
  const scope: Scope = { slot, preparation, binding: assertStrictSdrCandidateAllDeliveredFrameObservationBinding(rawBinding), m1a, q1, quality, active: true, pair: undefined };
  let primary: unknown, failed = false;
  try {
    return await scopes.run(scope, operation);
  } catch (error) {
    primary = error;
    failed = true;
    throw error;
  } finally {
    scope.active = false;
    const lease = scope.pair ? leases.get(scope.pair as object) : undefined;
    try {
      if (failed && scope.pair) revokeStrictSdrEvent18Pending(scope.pair);
      if (!lease || !lease.sealed || !lease.read) {
        if (!failed) throw new Error("Strict-SDR all-delivered-frame scope returned without one sealed reader.");
        if (primary) throw primary;
      } else if (!failed && scope.pair && hasStrictSdrEvent18Pending(scope.pair)) {
        if (!scope.m1a?.q1StaticContinuity || !scope.q1 || !scope.quality) {
          throw new Error("Strict-SDR Event-18 outer seal requires the held M1, Q1 and decoded quality scopes.");
        }
        sealStrictSdrEvent18OuterScope(scope.pair, slot, preparation, lease.sealed);
      }
    } catch (error) {
      if (scope.pair) revokeStrictSdrEvent18Pending(scope.pair);
      throw error;
    } finally {
      if (scope.pair) leases.delete(scope.pair as object);
    }
  }
}

function read(pair: StrictSdrCandidateHeldPair, slot: Slot): StrictSdrCandidateAllDeliveredFrameObservation {
  const scope = scopes.getStore(), lease = activeLease(pair, slot);
  if (!scope || !scope.active || scope.pair !== pair || !lease || !lease.sealed || lease.read) {
    throw new Error("Strict-SDR all-delivered-frame observation is absent, expired, or already read.");
  }
  lease.read = true;
  return lease.sealed;
}
function activeLease(pair: StrictSdrCandidateHeldPair, slot: Slot): Lease | undefined {
  const lease = leases.get(pair as object);
  if (!lease) return undefined;
  const scope = scopes.getStore();
  if (!scope || !scope.active || scope.slot !== slot || scope.pair !== pair || lease.slot !== slot || lease.binding !== scope.binding) {
    throw new Error("Strict-SDR all-delivered-frame lease is absent from its live matching literal scope.");
  }
  return lease;
}
function finalizationComplete(pair: StrictSdrCandidateHeldPair, slot: Slot): boolean {
  const value = slot === "f2a" ? strictSdrCandidateThreeSlotF2aFinalization(pair)
    : slot === "f2b-screen" ? strictSdrCandidateF2bScreenThreeSlotFinalization(pair)
      : strictSdrCandidateF2bScreenControlsThreeSlotFinalization(pair);
  return value.state === "complete" && value.sourceFrameReleased === true && value.heldToolDescriptorsRetained === true
    && value.privateDecodeLeafRemoved === true && value.privateRootClosed === true;
}
