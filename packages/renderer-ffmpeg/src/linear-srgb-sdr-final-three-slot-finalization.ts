/**
 * Immutable completed three-slot finalization records. Scope/lease lifetime remains in the diagnostic owner.
 */
import type { StrictSdrCandidateHeldPair } from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { StrictSdrCandidateThreeSlot } from "./linear-srgb-sdr-final-three-slot-measurement.js";

type Finalization = Readonly<{
  state: "complete";
  sourceFrameReleased: true;
  heldToolDescriptorsRetained: true;
  privateDecodeLeafRemoved: true;
  privateRootClosed: true;
}>;
type Record = Readonly<Finalization & { slot: StrictSdrCandidateThreeSlot }>;

export type StrictSdrCandidateThreeSlotF2aFinalization = Readonly<Finalization & {
  schema: "shellx-motion/strict-sdr-candidate-three-slot-f2a-finalization@1";
}>;
export type StrictSdrCandidateF2bScreenThreeSlotFinalization = Readonly<Finalization & {
  schema: "shellx-motion/strict-sdr-candidate-f2b-screen-three-slot-finalization@1";
}>;
export type StrictSdrCandidateF2bScreenControlsThreeSlotFinalization = Readonly<Finalization & {
  schema: "shellx-motion/strict-sdr-candidate-f2b-screen-controls-three-slot-finalization@1";
}>;

const finalizations = new WeakMap<object, Record>();

/** Called after complete pair-local Core and held-media cleanup, before the enclosing literal tool borrow settles. */
export function recordStrictSdrCandidateThreeSlotFinalization(
  pair: StrictSdrCandidateHeldPair,
  slot: StrictSdrCandidateThreeSlot,
): void {
  finalizations.set(pair as object, Object.freeze({
    slot,
    state: "complete",
    sourceFrameReleased: true,
    heldToolDescriptorsRetained: true,
    privateDecodeLeafRemoved: true,
    privateRootClosed: true,
  }));
}

export function strictSdrCandidateThreeSlotF2aFinalization(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateThreeSlotF2aFinalization {
  return read(pair, "f2a") as StrictSdrCandidateThreeSlotF2aFinalization;
}
export function strictSdrCandidateF2bScreenThreeSlotFinalization(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateF2bScreenThreeSlotFinalization {
  return read(pair, "f2b-screen") as StrictSdrCandidateF2bScreenThreeSlotFinalization;
}
export function strictSdrCandidateF2bScreenControlsThreeSlotFinalization(pair: StrictSdrCandidateHeldPair): StrictSdrCandidateF2bScreenControlsThreeSlotFinalization {
  return read(pair, "f2b-screen-controls") as StrictSdrCandidateF2bScreenControlsThreeSlotFinalization;
}

function read(pair: StrictSdrCandidateHeldPair, slot: StrictSdrCandidateThreeSlot): Finalization {
  const result = finalizations.get(pair as object);
  if (!result || result.slot !== slot) throw new Error("Strict-SDR three-slot finalization is absent or does not match its literal slot.");
  return Object.freeze({
    state: result.state,
    sourceFrameReleased: result.sourceFrameReleased,
    heldToolDescriptorsRetained: result.heldToolDescriptorsRetained,
    privateDecodeLeafRemoved: result.privateDecodeLeafRemoved,
    privateRootClosed: result.privateRootClosed,
    schema: schema(slot),
  }) as Finalization;
}

function schema(slot: StrictSdrCandidateThreeSlot):
  | "shellx-motion/strict-sdr-candidate-three-slot-f2a-finalization@1"
  | "shellx-motion/strict-sdr-candidate-f2b-screen-three-slot-finalization@1"
  | "shellx-motion/strict-sdr-candidate-f2b-screen-controls-three-slot-finalization@1" {
  if (slot === "f2a") return "shellx-motion/strict-sdr-candidate-three-slot-f2a-finalization@1";
  if (slot === "f2b-screen") return "shellx-motion/strict-sdr-candidate-f2b-screen-three-slot-finalization@1";
  return "shellx-motion/strict-sdr-candidate-f2b-screen-controls-three-slot-finalization@1";
}
