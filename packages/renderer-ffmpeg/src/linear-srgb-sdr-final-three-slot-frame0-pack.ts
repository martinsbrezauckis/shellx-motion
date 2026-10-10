/**
 * Private frame-zero review-pack registry for the sealed same-parent three-slot child.
 * It has no public export-map entry, selector, path, crop, or format parameter.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  matchesCurrentStrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldPairRendererBinding,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  recordStrictSdrCandidateThreeSlotFinalization,
  strictSdrCandidateF2bScreenControlsThreeSlotFinalization,
  strictSdrCandidateF2bScreenThreeSlotFinalization,
  strictSdrCandidateThreeSlotF2aFinalization,
} from "./linear-srgb-sdr-final-three-slot-finalization.js";
import {
  STRICT_SDR_FRAME0_PACK_BYTES,
  type StrictSdrCandidateF2bScreenControlsFrame0PackAllocation,
  type StrictSdrCandidateF2bScreenFrame0PackAllocation,
  type StrictSdrCandidateFrame0PackAllocation,
  type StrictSdrCandidateFrame0PackSlot,
  type StrictSdrCandidateThreeSlotF2aFrame0PackAllocation,
} from "./linear-srgb-sdr-final-three-slot-frame0-pack-layout.js";
import {
  assertStrictSdrCandidateFrame0PackAllocation,
  closeStrictSdrCandidateFrame0PackAllocation,
  revalidateStrictSdrCandidateFrame0PackImages,
  stageStrictSdrCandidateFrame0PackImages,
  type StrictSdrCandidateFrame0PackImageFact,
  type StrictSdrCandidateFrame0PackStaged,
} from "./linear-srgb-sdr-final-three-slot-frame0-pack-write.js";
import { resolveStrictSdrCandidateThreeSlotLiteralPair } from "./linear-srgb-sdr-final-three-slot-literal-bridge.js";
import {
  snapshotStrictSdrCandidateFrame0PackInverseJob,
  type StrictSdrCandidateFrame0PackInverseJob,
} from "./linear-srgb-sdr-final-three-slot-frame0-pack-evidence.js";

const PREPARATION = /^[a-f0-9]{64}$/u;
type PairFinalization = Readonly<{
  schema: string;
  state: "complete";
  sourceFrameReleased: true;
  heldToolDescriptorsRetained: true;
  privateDecodeLeafRemoved: true;
  privateRootClosed: true;
}>;
type Snapshot = Readonly<{ bytes: Buffer; sha256: string; byteLength: number; route: LinearSrgbSdrFinalRoute }>;
type DescriptorFacts = Readonly<{
  media: Readonly<{ sha256: string; byteLength: number }>;
  receipt: Readonly<{ sha256: string; byteLength: number }>;
}>;
type Scope = {
  readonly slot: StrictSdrCandidateFrame0PackSlot;
  readonly preparation: string;
  readonly allocation: StrictSdrCandidateFrame0PackAllocation;
  active: boolean;
  pair: StrictSdrCandidateHeldPair | undefined;
};
type Lease = {
  readonly slot: StrictSdrCandidateFrame0PackSlot;
  readonly allocation: StrictSdrCandidateFrame0PackAllocation;
  readonly signal: AbortSignal | undefined;
  staging: boolean;
  sealing: boolean;
  staged: StrictSdrCandidateFrame0PackStaged | undefined;
  descriptorFacts: DescriptorFacts | undefined;
  evidence: StrictSdrCandidateFrame0PackEvidence | undefined;
  sealed: StrictSdrCandidateFrame0PackSealed | undefined;
  descriptorCloseAttempted: boolean;
  read: boolean;
};
export type { StrictSdrCandidateFrame0PackInverseJob } from "./linear-srgb-sdr-final-three-slot-frame0-pack-evidence.js";
export type StrictSdrCandidateFrame0PackEvidence = Readonly<{
  media: Readonly<{ sha256: string; byteLength: number }>;
  receipt: Readonly<{ sha256: string; byteLength: number }>;
  sourceFrame: Readonly<{ sha256: string; byteLength: number }>;
  decodedFrame: Readonly<{ sha256: string; byteLength: number }>;
  inverseCommandSha256: string;
  inverseJob: StrictSdrCandidateFrame0PackInverseJob;
}>;
export type StrictSdrCandidateFrame0PackSealed = Readonly<{
  schema: "shellx-motion/strict-sdr-candidate-frame0-review-pack@1";
  slot: StrictSdrCandidateFrame0PackSlot;
  frameIndex: 0;
  evidence: StrictSdrCandidateFrame0PackEvidence;
  images: readonly StrictSdrCandidateFrame0PackImageFact[];
  pairFinalization: PairFinalization;
  descriptorsClosed: true;
}>;

const scopes = new AsyncLocalStorage<Scope>();
const leases = new WeakMap<object, Lease>();

export function withStrictSdrCandidateThreeSlotF2aFrame0Pack<T>(allocation: StrictSdrCandidateThreeSlotF2aFrame0PackAllocation, preparation: string, operation: () => Promise<T> | T): Promise<T> {
  return withScope("f2a", allocation, preparation, operation);
}
export function withStrictSdrCandidateF2bScreenFrame0Pack<T>(allocation: StrictSdrCandidateF2bScreenFrame0PackAllocation, preparation: string, operation: () => Promise<T> | T): Promise<T> {
  return withScope("f2b-screen", allocation, preparation, operation);
}
export function withStrictSdrCandidateF2bScreenControlsFrame0Pack<T>(allocation: StrictSdrCandidateF2bScreenControlsFrame0PackAllocation, preparation: string, operation: () => Promise<T> | T): Promise<T> {
  return withScope("f2b-screen-controls", allocation, preparation, operation);
}

/** Called only by the existing staged-publication transfer after it resolved the live Core pair. */
export function initializeCurrentStrictSdrCandidateFrame0Pack(
  slot: StrictSdrCandidateFrame0PackSlot,
  binding: StrictSdrCandidateHeldPairRendererBinding,
  preparation: string,
  signal: AbortSignal | undefined,
): StrictSdrCandidateHeldPair {
  const scope = scopes.getStore();
  if (!scope || !scope.active || scope.slot !== slot || scope.preparation !== preparation || scope.pair || !binding) {
    throw new Error("Strict-SDR frame-zero pack initializer does not match its active literal Core transfer.");
  }
  const pair = resolveStrictSdrCandidateThreeSlotLiteralPair(slot, binding);
  if (leases.has(pair as object)) {
    throw new Error("Strict-SDR frame-zero pack initializer duplicated its active Core pair.");
  }
  leases.set(pair as object, { slot, allocation: scope.allocation, signal, staging: false, sealing: false, staged: undefined, descriptorFacts: undefined, evidence: undefined, sealed: undefined, descriptorCloseAttempted: false, read: false });
  scope.pair = pair;
  return pair;
}

/** The diagnostic uses this only to preserve ordinary THREE's existing no-pack resolver route. */
export function hasCurrentStrictSdrCandidateFrame0PackScope(slot: StrictSdrCandidateFrame0PackSlot, preparation: string): boolean {
  const scope = scopes.getStore();
  return !!scope && scope.active && scope.slot === slot && scope.preparation === preparation && !scope.pair;
}

/** Called inside the existing inverse callback, while decoded bytes and the Core descriptor are live. */
export async function stageCurrentStrictSdrCandidateFrame0Pack(input: Readonly<{
  slot: StrictSdrCandidateFrame0PackSlot;
  pair: StrictSdrCandidateHeldPair;
  observation: StrictSdrCandidateHeldPairObservation;
  snapshot: Snapshot;
  decoded: Buffer;
}>): Promise<void> {
  const lease = activeLeaseFor(input.pair, input.slot);
  if (!lease) return;
  if (lease.staging || lease.staged || lease.evidence || lease.sealing || lease.sealed || input.snapshot.byteLength !== STRICT_SDR_FRAME0_PACK_BYTES
    || input.snapshot.bytes.byteLength !== STRICT_SDR_FRAME0_PACK_BYTES
    || hash(input.snapshot.bytes) !== input.snapshot.sha256
    || input.decoded.byteLength !== STRICT_SDR_FRAME0_PACK_BYTES
    || !matchesCurrentStrictSdrCandidateHeldPairObservation(input.pair, input.observation)
    || !sha256(input.observation.media.sha256) || !positive(input.observation.media.byteLength)
    || !sha256(input.observation.receipt.sha256) || !positive(input.observation.receipt.byteLength)) {
    throw new Error("Strict-SDR frame-zero pack stage does not retain its exact descriptor-bound frame identities.");
  }
  lease.staging = true;
  try {
    lease.staged = await stageStrictSdrCandidateFrame0PackImages({ slot: input.slot, allocation: lease.allocation, source: input.snapshot.bytes, decoded: input.decoded, signal: lease.signal });
    lease.descriptorFacts = Object.freeze({
      media: Object.freeze({ ...input.observation.media }),
      receipt: Object.freeze({ ...input.observation.receipt }),
    });
  } finally {
    lease.staging = false;
  }
}

/** Called by the diagnostic evaluator only after its fresh inverse result was validated. */
export function recordCurrentStrictSdrCandidateFrame0Pack(
  pair: StrictSdrCandidateHeldPair,
  slot: StrictSdrCandidateFrame0PackSlot,
  evidence: StrictSdrCandidateFrame0PackEvidence,
): void {
  const lease = activeLeaseFor(pair, slot);
  if (!lease) return;
  if (lease.staging || !lease.staged || !lease.descriptorFacts || lease.evidence || lease.sealing || lease.sealed || !sameFacts(evidence, lease.staged, lease.descriptorFacts)) {
    throw new Error("Strict-SDR frame-zero pack inverse facts do not match its descriptor-bound staged images.");
  }
  lease.evidence = Object.freeze({
    media: Object.freeze({ ...evidence.media }), receipt: Object.freeze({ ...evidence.receipt }),
    sourceFrame: Object.freeze({ ...evidence.sourceFrame }), decodedFrame: Object.freeze({ ...evidence.decodedFrame }),
    inverseCommandSha256: evidence.inverseCommandSha256, inverseJob: snapshotStrictSdrCandidateFrame0PackInverseJob(evidence.inverseJob),
  });
}

/** Diagnostic `withScope` calls this before successful held-tool settlement. It accepts no caller finalization record. */
export async function recordAndSealCurrentStrictSdrCandidateFrame0Pack(pair: StrictSdrCandidateHeldPair, slot: StrictSdrCandidateFrame0PackSlot): Promise<void> {
  const lease = activeLeaseFor(pair, slot);
  if (!lease) {
    recordStrictSdrCandidateThreeSlotFinalization(pair, slot);
    return;
  }
  if (lease.staging || lease.sealing || !lease.staged || !lease.evidence || lease.sealed) throw new Error("Strict-SDR frame-zero pack cannot seal before its complete descriptor-bound evaluation.");
  lease.sealing = true;
  try {
    recordStrictSdrCandidateThreeSlotFinalization(pair, slot);
    const finalization = finalizationFor(pair, slot);
    await revalidateStrictSdrCandidateFrame0PackImages(slot, lease.allocation, lease.staged);
    await closeLeaseDescriptors(lease);
    lease.sealed = Object.freeze({
      schema: "shellx-motion/strict-sdr-candidate-frame0-review-pack@1", slot, frameIndex: 0,
      evidence: lease.evidence, images: lease.staged.images, pairFinalization: finalization, descriptorsClosed: true,
    });
  } catch (error) {
    await closeLeaseDescriptors(lease).catch((closeError) => { throw new AggregateError([error, closeError], "Strict-SDR frame-zero pack seal and descriptor closure both failed."); });
    throw error;
  }
}

export function readStrictSdrCandidateThreeSlotF2aFrame0Pack(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateFrame0PackSealed { return read(pair, "f2a"); }
export function readStrictSdrCandidateF2bScreenFrame0Pack(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateFrame0PackSealed { return read(pair, "f2b-screen"); }
export function readStrictSdrCandidateF2bScreenControlsFrame0Pack(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateFrame0PackSealed { return read(pair, "f2b-screen-controls"); }

async function withScope<T>(slot: StrictSdrCandidateFrame0PackSlot, allocation: StrictSdrCandidateFrame0PackAllocation, preparation: string, operation: () => Promise<T> | T): Promise<T> {
  if (!PREPARATION.test(preparation) || scopes.getStore()) throw new Error("Strict-SDR frame-zero pack scope is malformed or nested.");
  const scope: Scope = { slot, preparation, allocation, active: true, pair: undefined };
  let primary: unknown, failed = false;
  try {
    await assertStrictSdrCandidateFrame0PackAllocation(slot, allocation);
    return await scopes.run(scope, operation);
  } catch (error) {
    primary = error;
    failed = true;
    throw error;
  } finally {
    scope.active = false;
    const lease = scope.pair ? leases.get(scope.pair as object) : undefined;
    if (!lease) {
      try { await closeStrictSdrCandidateFrame0PackAllocation(slot, allocation); } catch (cleanup) {
        if (failed) throw new AggregateError([primary, cleanup], "Strict-SDR frame-zero pack scope and pre-transfer descriptor closure failed.");
        throw cleanup;
      }
      if (!failed) throw new Error("Strict-SDR frame-zero pack scope returned without a Core pair transfer.");
    } else if (!lease.sealed || !lease.read) {
      try { await closeLeaseDescriptors(lease); } catch (cleanup) {
        if (failed) throw new AggregateError([primary, cleanup], "Strict-SDR frame-zero pack scope and retained descriptor closure failed.");
        throw cleanup;
      }
      leases.delete(scope.pair as object);
      if (!failed) throw new Error("Strict-SDR frame-zero pack scope returned without a sealed pack reader.");
    } else {
      leases.delete(scope.pair as object);
    }
  }
}

function read(pair: StrictSdrCandidateHeldPair, slot: StrictSdrCandidateFrame0PackSlot): StrictSdrCandidateFrame0PackSealed {
  const scope = scopes.getStore(), lease = activeLeaseFor(pair, slot);
  if (!scope || !scope.active || scope.pair !== pair || !lease || !lease.sealed || lease.read) throw new Error("Strict-SDR sealed frame-zero pack is absent, expired, or already read.");
  lease.read = true;
  return lease.sealed;
}
function leaseFor(pair: StrictSdrCandidateHeldPair, slot: StrictSdrCandidateFrame0PackSlot): Lease | undefined {
  const lease = leases.get(pair as object);
  if (!lease) return undefined;
  if (lease.slot !== slot) throw new Error("Strict-SDR frame-zero pack pair does not match its literal slot.");
  return lease;
}
function activeLeaseFor(pair: StrictSdrCandidateHeldPair, slot: StrictSdrCandidateFrame0PackSlot): Lease | undefined {
  const lease = leaseFor(pair, slot);
  if (!lease) return undefined;
  const scope = scopes.getStore();
  if (!scope || !scope.active || scope.slot !== slot || scope.pair !== pair || scope.allocation !== lease.allocation) {
    throw new Error("Strict-SDR frame-zero pack lease is absent from its live matching literal scope.");
  }
  return lease;
}
function finalizationFor(pair: StrictSdrCandidateHeldPair, slot: StrictSdrCandidateFrame0PackSlot): PairFinalization {
  const value = slot === "f2a" ? strictSdrCandidateThreeSlotF2aFinalization(pair)
    : slot === "f2b-screen" ? strictSdrCandidateF2bScreenThreeSlotFinalization(pair)
      : strictSdrCandidateF2bScreenControlsThreeSlotFinalization(pair);
  if (value.state !== "complete" || value.sourceFrameReleased !== true || value.heldToolDescriptorsRetained !== true || value.privateDecodeLeafRemoved !== true || value.privateRootClosed !== true) {
    throw new Error("Strict-SDR frame-zero pack did not observe complete pair-local finalization.");
  }
  return value;
}
async function closeLeaseDescriptors(lease: Lease): Promise<void> {
  if (lease.descriptorCloseAttempted) return;
  lease.descriptorCloseAttempted = true;
  await closeStrictSdrCandidateFrame0PackAllocation(lease.slot, lease.allocation);
}
function sameFacts(evidence: StrictSdrCandidateFrame0PackEvidence, staged: StrictSdrCandidateFrame0PackStaged, descriptor: DescriptorFacts): boolean {
  return sha256(evidence.media.sha256) && positive(evidence.media.byteLength)
    && sha256(evidence.receipt.sha256) && positive(evidence.receipt.byteLength)
    && evidence.media.sha256 === descriptor.media.sha256 && evidence.media.byteLength === descriptor.media.byteLength
    && evidence.receipt.sha256 === descriptor.receipt.sha256 && evidence.receipt.byteLength === descriptor.receipt.byteLength
    && sha256(evidence.sourceFrame.sha256) && evidence.sourceFrame.byteLength === STRICT_SDR_FRAME0_PACK_BYTES
    && evidence.sourceFrame.sha256 === staged.sourceFrame.sha256 && evidence.sourceFrame.byteLength === staged.sourceFrame.byteLength
    && sha256(evidence.decodedFrame.sha256) && evidence.decodedFrame.byteLength === STRICT_SDR_FRAME0_PACK_BYTES
    && evidence.decodedFrame.sha256 === staged.decodedFrame.sha256 && evidence.decodedFrame.byteLength === staged.decodedFrame.byteLength
    && sha256(evidence.inverseCommandSha256) && staged.images.length > 0;
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function sha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
