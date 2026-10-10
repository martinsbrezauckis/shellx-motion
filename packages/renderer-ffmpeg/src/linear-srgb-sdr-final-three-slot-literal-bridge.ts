/**
 * Exact literal bridges from the diagnostic lifecycle owner to Core pair APIs and held tools.
 * This source-relative module exposes no child selector, request option, or reusable authority.
 */
import {
  registerStrictSdrCandidateF2bScreenControlsFinalizer,
  registerStrictSdrCandidateF2bScreenFinalizer,
  registerStrictSdrCandidateThreeSlotF2aFinalizer,
  strictSdrCandidateHeldPairForConsumedF2bScreenControlsRendererBinding,
  strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding,
  strictSdrCandidateHeldPairForConsumedThreeSlotF2aRendererBinding,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldPairRendererBinding,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import {
  borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools,
  borrowStrictSdrCandidateF2bScreenThreeSlotTools,
  borrowStrictSdrCandidateThreeSlotF2aTools,
  markStrictSdrCandidateF2bScreenControlsThreeSlotToolsFailure,
  markStrictSdrCandidateF2bScreenThreeSlotToolsFailure,
  markStrictSdrCandidateThreeSlotF2aToolsFailure,
  settleStrictSdrCandidateF2bScreenControlsThreeSlotTools,
  settleStrictSdrCandidateF2bScreenThreeSlotTools,
  settleStrictSdrCandidateThreeSlotF2aTools,
  type StrictSdrCandidateThreeSlotHeldTools,
} from "./linear-srgb-sdr-final-three-slot-held-tools.js";
import type { StrictSdrCandidateThreeSlot } from "./linear-srgb-sdr-final-three-slot-measurement.js";

export async function borrowStrictSdrCandidateThreeSlotLiteralTools(
  slot: StrictSdrCandidateThreeSlot,
  tools: StrictSdrCandidateThreeSlotHeldTools,
): Promise<void> {
  if (slot === "f2a") await borrowStrictSdrCandidateThreeSlotF2aTools(tools);
  else if (slot === "f2b-screen") await borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools);
  else await borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools);
}

export function settleStrictSdrCandidateThreeSlotLiteralTools(
  slot: StrictSdrCandidateThreeSlot,
  tools: StrictSdrCandidateThreeSlotHeldTools,
  success: boolean,
): void {
  if (slot === "f2a") settleStrictSdrCandidateThreeSlotF2aTools(tools, success);
  else if (slot === "f2b-screen") settleStrictSdrCandidateF2bScreenThreeSlotTools(tools, success);
  else settleStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools, success);
}

export function markStrictSdrCandidateThreeSlotLiteralToolsFailure(
  slot: StrictSdrCandidateThreeSlot,
  tools: StrictSdrCandidateThreeSlotHeldTools,
): void {
  if (slot === "f2a") markStrictSdrCandidateThreeSlotF2aToolsFailure(tools);
  else if (slot === "f2b-screen") markStrictSdrCandidateF2bScreenThreeSlotToolsFailure(tools);
  else markStrictSdrCandidateF2bScreenControlsThreeSlotToolsFailure(tools);
}

export function resolveStrictSdrCandidateThreeSlotLiteralPair(
  slot: StrictSdrCandidateThreeSlot,
  binding: StrictSdrCandidateHeldPairRendererBinding,
): StrictSdrCandidateHeldPair {
  if (slot === "f2a") return strictSdrCandidateHeldPairForConsumedThreeSlotF2aRendererBinding(binding);
  if (slot === "f2b-screen") return strictSdrCandidateHeldPairForConsumedF2bScreenRendererBinding(binding);
  return strictSdrCandidateHeldPairForConsumedF2bScreenControlsRendererBinding(binding);
}

export function registerStrictSdrCandidateThreeSlotLiteralFinalizer(
  slot: StrictSdrCandidateThreeSlot,
  pair: StrictSdrCandidateHeldPair,
  finalizer: () => Promise<void>,
): void {
  if (slot === "f2a") registerStrictSdrCandidateThreeSlotF2aFinalizer(pair, finalizer);
  else if (slot === "f2b-screen") registerStrictSdrCandidateF2bScreenFinalizer(pair, finalizer);
  else registerStrictSdrCandidateF2bScreenControlsFinalizer(pair, finalizer);
}

export function strictSdrCandidateThreeSlotDescriptor(
  slot: StrictSdrCandidateThreeSlot,
  observation: StrictSdrCandidateHeldPairObservation,
): <T>(operation: (input: Readonly<{ fd: number; media: Readonly<{ sha256: string; byteLength: number }> }>) => Promise<T> | T) => Promise<T> {
  if (slot === "f2a") return observation.withThreeSlotF2aCommittedMediaDescriptor.bind(observation);
  if (slot === "f2b-screen") return observation.withF2bScreenCommittedMediaDescriptor.bind(observation);
  return observation.withF2bScreenControlsCommittedMediaDescriptor.bind(observation);
}
