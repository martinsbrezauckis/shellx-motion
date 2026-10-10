/** Private renderer lease types shared by held-media and the literal diagnostic lifecycle. */
import type { LocalMotionJobGovernor } from "@shellx-motion/core";
import type { StrictSdrCandidateHeldPairRendererBinding } from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";
import type {
  StrictSdrCandidateAllDeliveredFrame,
  StrictSdrCandidateAllDeliveredFramesInverseResult,
} from "./linear-srgb-sdr-final-held-media-all-frames-inverse.js";
import type {
  StrictSdrCandidateThreeSlot,
  StrictSdrCandidateThreeSlotDecodedMeasurement,
  StrictSdrCandidateThreeSlotInverseResult,
} from "./linear-srgb-sdr-final-three-slot-measurement.js";

export type StrictSdrCandidateThreeSlotLeaseOwner = Readonly<{
  runThreeSlotInverse(input: Readonly<{
    sourceFd: number;
    job: LinearSrgbSdrFinalJob;
    measureDecoded(decoded: Buffer): StrictSdrCandidateThreeSlotDecodedMeasurement | Promise<StrictSdrCandidateThreeSlotDecodedMeasurement>;
  }>): Promise<StrictSdrCandidateThreeSlotInverseResult>;
  runThreeSlotAllDeliveredFrames<T>(input: Readonly<{
    slot: StrictSdrCandidateThreeSlot;
    sourceFd: number;
    job: LinearSrgbSdrFinalJob;
    observeFrame(input: Readonly<{
      frame: StrictSdrCandidateAllDeliveredFrame;
      withOwnedRgba(operation: (rgba: Buffer) => Promise<T> | T): Promise<T>;
    }>): T | Promise<T>;
  }>): Promise<StrictSdrCandidateAllDeliveredFramesInverseResult<T>>;
  close(): Promise<void>;
}>;

export type StrictSdrCandidateThreeSlotLeaseTransfer = Readonly<{
  binding: StrictSdrCandidateHeldPairRendererBinding;
  preparation: string;
  governor: LocalMotionJobGovernor;
  scratchRoot: string;
  signal: AbortSignal | undefined;
  callerId: string | undefined;
}>;
