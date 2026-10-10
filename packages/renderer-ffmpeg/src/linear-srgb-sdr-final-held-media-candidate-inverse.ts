/** Private candidate inverse bridge; HeldMediaOperation retains root/leaf ownership. */
import type { FileHandle } from "node:fs/promises";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse, type StrictSdrCandidateAllDeliveredFramesInverseResult } from "./linear-srgb-sdr-final-held-media-all-frames-inverse.js";
import { runLinearSrgbSdrHeldMediaInverse } from "./linear-srgb-sdr-final-held-media-inverse.js";
import type { LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";
import type { HeldFileFacts, HeldLeaf, HeldTool } from "./linear-srgb-sdr-final-held-media-files.js";
import type { StrictSdrCandidateThreeSlotDecodedMeasurement, StrictSdrCandidateThreeSlotInverseResult } from "./linear-srgb-sdr-final-three-slot-measurement.js";

export type { StrictSdrCandidateAllDeliveredFramesInverseResult } from "./linear-srgb-sdr-final-held-media-all-frames-inverse.js";

export async function runHeldMediaF2aInverse<TComparison extends Readonly<{ accepted: boolean }>>(input: Readonly<{
  root: FileHandle;
  rootIdentity: HeldFileFacts;
  decodedPath: string;
  route: LinearSrgbSdrFinalRoute;
  ffmpeg: HeldTool;
  sourceFd: number;
  job: LinearSrgbSdrFinalJob;
  trackDecoded(leaf: HeldLeaf | undefined): HeldLeaf | undefined;
  compareDecoded(bytes: Buffer): TComparison;
  recordDecodedCleanupError(error: unknown): void;
}>): Promise<Readonly<{ decoded: Readonly<{ sha256: string; byteLength: number }>; comparison: TComparison; inverseCommandSha256: string }>> {
  return await runLinearSrgbSdrHeldMediaInverse({
    label: "F2a", root: input.root, rootIdentity: input.rootIdentity, decodedPath: input.decodedPath,
    trackDecoded: input.trackDecoded, route: input.route, ffmpeg: input.ffmpeg, sourceFd: input.sourceFd, job: input.job,
    consumeDecoded: ({ bytes, decoded, inverseCommandSha256 }) => {
      const comparison = input.compareDecoded(bytes);
      if (!comparison.accepted) throw new Error("Strict SDR held-media F2a all-pixel first-frame comparison refused the committed media.");
      return Object.freeze({ decoded, comparison, inverseCommandSha256 });
    },
    recordDecodedCleanupError: input.recordDecodedCleanupError,
  });
}

export async function runHeldMediaThreeSlotInverse(input: Readonly<{
  root: FileHandle;
  rootIdentity: HeldFileFacts;
  decodedPath: string;
  route: LinearSrgbSdrFinalRoute;
  ffmpeg: HeldTool;
  sourceFd: number;
  job: LinearSrgbSdrFinalJob;
  trackDecoded(leaf: HeldLeaf | undefined): HeldLeaf | undefined;
  measureDecoded(decoded: Buffer): StrictSdrCandidateThreeSlotDecodedMeasurement | Promise<StrictSdrCandidateThreeSlotDecodedMeasurement>;
  recordDecodedCleanupError(error: unknown): void;
}>): Promise<StrictSdrCandidateThreeSlotInverseResult> {
  return await runLinearSrgbSdrHeldMediaInverse({
    label: "three-slot", root: input.root, rootIdentity: input.rootIdentity, decodedPath: input.decodedPath,
    trackDecoded: input.trackDecoded, route: input.route, ffmpeg: input.ffmpeg, sourceFd: input.sourceFd, job: input.job,
    consumeDecoded: async ({ bytes, decoded, inverseCommandSha256 }) => Object.freeze({
      decoded,
      measurement: await input.measureDecoded(bytes),
      inverseCommandSha256,
    }),
    recordDecodedCleanupError: input.recordDecodedCleanupError,
  });
}

export async function runHeldMediaThreeSlotAllDeliveredFrames<T>(input: Readonly<{
  slot: "f2a" | "f2b-screen" | "f2b-screen-controls";
  route: LinearSrgbSdrFinalRoute;
  ffmpeg: HeldTool;
  sourceFd: number;
  job: LinearSrgbSdrFinalJob;
  observeFrame(input: Readonly<{
    frame: import("./linear-srgb-sdr-final-held-media-all-frames-inverse.js").StrictSdrCandidateAllDeliveredFrame;
    withOwnedRgba(operation: (rgba: Buffer) => Promise<T> | T): Promise<T>;
  }>): T | Promise<T>;
}>): Promise<StrictSdrCandidateAllDeliveredFramesInverseResult<T>> {
  return await runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse(input);
}
