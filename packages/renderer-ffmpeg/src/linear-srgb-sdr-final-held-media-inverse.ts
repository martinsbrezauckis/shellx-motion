/**
 * Descriptor-backed inverse primitive shared by the existing strict-SDR lease and three-slot lease.
 * It owns the decoded leaf through callback completion and removes it before returning or rejecting.
 */
import { canonicalJsonSha256 } from "@shellx-motion/core";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { runLinearSrgbSdrHeldInverseChild, strictSdrHeldInverseTerminalContainmentEstablished, type StrictSdrHeldInverseTerminalObservation } from "./ffmpeg-process-lifecycle.js";
import { portableFfmpegContainmentEvidence } from "./ffmpeg-process-control.js";
import { heldInverseCommand } from "./linear-srgb-sdr-final-held-media-command.js";
import {
  assertCurrentHeldToolResolution,
  assertHeldTool,
  createExclusiveHeldLeaf,
  hashHeldLeaf,
  readExactHeldLeaf,
  removeHeldLeaf,
  type HeldFileFacts,
  type HeldLeaf,
  type HeldTool,
} from "./linear-srgb-sdr-final-held-media-files.js";
import { revalidateStreamingFinalLaunch } from "./streaming-final-lineage-revalidation.js";
import { resolveFfmpegExecutable } from "./index.js";
import type { LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";
import type { FileHandle } from "node:fs/promises";

export async function runLinearSrgbSdrHeldMediaInverse<T>(input: Readonly<{
  label: "F2a" | "three-slot";
  root: FileHandle;
  rootIdentity: HeldFileFacts;
  decodedPath: string;
  trackDecoded(leaf: HeldLeaf | undefined): HeldLeaf | undefined;
  route: LinearSrgbSdrFinalRoute;
  ffmpeg: HeldTool;
  sourceFd: number;
  job: LinearSrgbSdrFinalJob;
  consumeDecoded(input: Readonly<{
    bytes: Buffer;
    decoded: Readonly<{ sha256: string; byteLength: number }>;
    inverseCommandSha256: string;
  }>): Promise<T> | T;
  recordDecodedCleanupError(error: unknown): void;
}>): Promise<T> {
  const expectedBytes = input.route.canvas.width * input.route.canvas.height * 4;
  const decodedLeaf = await createExclusiveHeldLeaf(
    input.root,
    input.rootIdentity,
    input.decodedPath,
    `Strict SDR held-media ${input.label} decoded output`,
  );
  input.trackDecoded(decodedLeaf);
  let completed: T | undefined;
  let primary: unknown, hasPrimary = false;
  try {
    const inverse = heldInverseCommand(input.ffmpeg.path);
    assertCurrentHeldToolResolution(input.ffmpeg, resolveFfmpegExecutable, `FFmpeg before strict held ${input.label} inverse`);
    await assertHeldTool(input.ffmpeg, `FFmpeg before strict held ${input.label} inverse`);
    await revalidateStreamingFinalLaunch();
    let terminal: StrictSdrHeldInverseTerminalObservation | undefined;
    const decodedResult = await runLinearSrgbSdrHeldInverseChild(
      inverse,
      input.ffmpeg.handle.fd,
      input.sourceFd,
      decodedLeaf.handle.fd,
      input.job.signal,
      input.job.watchProcess,
      unixProcessGroup,
      {},
      (observation) => { terminal = observation; },
    );
    if (!strictSdrHeldInverseTerminalContainmentEstablished(terminal)) {
      throw new Error(`Strict SDR held-media ${input.label} inverse could not prove terminal contained FFmpeg cleanup.`);
    }
    input.job.reportProcessContainment(portableFfmpegContainmentEvidence("unix-process-group"));
    if (decodedResult.exitCode !== 0) throw new Error(`Strict SDR held-media ${input.label} inverse decode did not complete successfully.`);
    const decodedFacts = await hashHeldLeaf(input.root, input.rootIdentity, decodedLeaf, expectedBytes, `Strict SDR held-media ${input.label} decoded frame`);
    if (decodedFacts.byteLength !== expectedBytes) throw new Error(`Strict SDR held-media ${input.label} inverse did not produce one exact RGBA frame.`);
    const bytes = await readExactHeldLeaf(input.root, input.rootIdentity, decodedLeaf, expectedBytes, `Strict SDR held-media ${input.label} decoded frame`);
    completed = await input.consumeDecoded(Object.freeze({
      bytes,
      decoded: Object.freeze({ sha256: decodedFacts.sha256, byteLength: decodedFacts.byteLength }),
      inverseCommandSha256: canonicalJsonSha256(inverse),
    }));
  } catch (error) {
    primary = error;
    hasPrimary = true;
    throw error;
  } finally {
    try {
      const cleanupLeaf = input.trackDecoded(undefined);
      if (cleanupLeaf) await removeHeldLeaf(input.root, input.rootIdentity, cleanupLeaf, `Strict SDR held-media ${input.label} decoded output`);
    } catch (cleanupError) {
      input.recordDecodedCleanupError(cleanupError);
      if (hasPrimary) throw new AggregateError([primary, cleanupError], `Strict SDR held-media ${input.label} inverse failed and retained uncertain decoded cleanup.`);
      throw cleanupError;
    }
  }
  assertCurrentHeldToolResolution(input.ffmpeg, resolveFfmpegExecutable, `FFmpeg after strict held ${input.label} inverse`);
  await assertHeldTool(input.ffmpeg, `FFmpeg after strict held ${input.label} inverse`);
  if (completed === undefined) throw new Error(`Strict SDR held-media ${input.label} inverse did not produce a verified terminal result.`);
  return completed;
}

function unixProcessGroup(): "unix-process-group" { return "unix-process-group"; }
