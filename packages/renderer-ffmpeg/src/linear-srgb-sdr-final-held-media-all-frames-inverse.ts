/**
 * Same-parent-only all-delivered-frame inverse. It retains no decoded leaf: one
 * private rolling RGBA buffer is filled, observed, zeroed and reused in order.
 */
import { createHash } from "node:crypto";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { strictSdrHeldAllFramesTerminalEstablished, runLinearSrgbSdrHeldAllFramesChild, type StrictSdrHeldAllFramesTerminalObservation } from "./linear-srgb-sdr-final-held-media-all-frames-process.js";
import { portableFfmpegContainmentEvidence } from "./ffmpeg-process-control.js";
import { heldAllDeliveredFramesInverseCommand } from "./linear-srgb-sdr-final-held-media-command.js";
import { assertCurrentHeldToolResolution, assertHeldTool, type HeldTool } from "./linear-srgb-sdr-final-held-media-files.js";
import { revalidateStreamingFinalLaunch } from "./streaming-final-lineage-revalidation.js";
import { resolveFfmpegExecutable } from "./index.js";
import type { LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";

const WIDTH = 1_280;
const HEIGHT = 720;
const FPS = 30;
const DURATION_MS = 2_000;
const FRAME_COUNT = 60;
const FRAME_BYTES = WIDTH * HEIGHT * 4;
const DECODED_BYTE_LENGTH = FRAME_BYTES * FRAME_COUNT;
const MAXIMUM_ADMITTED_CHUNK_BYTES = 1_048_576;

export type StrictSdrCandidateAllDeliveredFrame = Readonly<{
  frameIndex: number;
  decoded: Readonly<{ sha256: string; byteLength: number }>;
}>;

export type StrictSdrCandidateAllDeliveredFramesInverseResult<T> = Readonly<{
  frames: readonly T[];
  heldFfmpeg: Readonly<{ sha256: string }>;
  inverseCommandSha256: string;
  decodedByteLength: number;
}>;

export async function runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse<T>(input: Readonly<{
  slot: "f2a" | "f2b-screen" | "f2b-screen-controls";
  route: LinearSrgbSdrFinalRoute;
  ffmpeg: HeldTool;
  sourceFd: number;
  job: LinearSrgbSdrFinalJob;
  observeFrame(input: Readonly<{
    frame: StrictSdrCandidateAllDeliveredFrame;
    withOwnedRgba(operation: (rgba: Buffer) => Promise<T> | T): Promise<T>;
  }>): Promise<T> | T;
}>): Promise<StrictSdrCandidateAllDeliveredFramesInverseResult<T>> {
  assertLiteralRoute(input.route);
  if (!Number.isInteger(input.sourceFd) || input.sourceFd < 3) {
    throw new Error("Strict SDR all-delivered-frame inverse did not retain Core's committed media descriptor.");
  }
  const rolling = Buffer.allocUnsafe(FRAME_BYTES);
  let frameOffset = 0, frameIndex = 0;
  const values: T[] = [];
  let terminal: StrictSdrHeldAllFramesTerminalObservation | undefined;
  try {
    const inverse = heldAllDeliveredFramesInverseCommand(input.ffmpeg.path);
    assertCurrentHeldToolResolution(input.ffmpeg, resolveFfmpegExecutable, `FFmpeg before strict held ${input.slot} all-delivered-frame inverse`);
    await assertHeldTool(input.ffmpeg, `FFmpeg before strict held ${input.slot} all-delivered-frame inverse`);
    await revalidateStreamingFinalLaunch();
    const result = await runLinearSrgbSdrHeldAllFramesChild({
      ffmpegFd: input.ffmpeg.handle.fd,
      sourceFd: input.sourceFd,
      signal: input.job.signal,
      watchProcess: input.job.watchProcess,
      terminationMode: unixProcessGroup,
      maximumChunkBytes: MAXIMUM_ADMITTED_CHUNK_BYTES,
      consumeChunk: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          if (frameIndex >= FRAME_COUNT) {
            throw new Error("Strict SDR all-delivered-frame inverse produced a byte beyond its 60th decoded frame.");
          }
          const copy = Math.min(FRAME_BYTES - frameOffset, chunk.byteLength - offset);
          chunk.copy(rolling, frameOffset, offset, offset + copy);
          frameOffset += copy;
          offset += copy;
          if (frameOffset !== FRAME_BYTES) continue;
          const frame = Object.freeze({
            frameIndex,
            decoded: Object.freeze({ sha256: sha256(rolling), byteLength: FRAME_BYTES }),
          });
          let active = true, work: Promise<T> | undefined;
          const withOwnedRgba = (operation: (rgba: Buffer) => Promise<T> | T): Promise<T> => {
            if (!active || work) throw new Error("Strict SDR all-delivered-frame callback reused an expired or duplicate scoped RGBA capability.");
            const started = Promise.resolve().then(async () => await operation(rolling));
            // The outer observer can reject after it starts this work. Attach a
            // handler immediately, then await the same work before buffer reuse.
            void started.catch(() => undefined);
            work = started;
            return started;
          };
          let returned: T | undefined, primary: unknown, hasPrimary = false;
          try {
            returned = await input.observeFrame(Object.freeze({ frame, withOwnedRgba }));
          } catch (error) {
            primary = error;
            hasPrimary = true;
          } finally {
            let measured: T | undefined, workFailure: unknown, hasWorkFailure = false;
            if (work) {
              try {
                measured = await work;
              } catch (error) {
                workFailure = error;
                hasWorkFailure = true;
              }
            }
            active = false;
            rolling.fill(0);
            if (hasPrimary) {
              if (hasWorkFailure) throw new AggregateError([primary, workFailure], "Strict SDR all-delivered-frame observer and its owned RGBA work both failed.");
              throw primary;
            }
            if (!work) throw new Error("Strict SDR all-delivered-frame callback did not consume its current RGBA capability.");
            if (hasWorkFailure) throw workFailure;
            if (!Object.is(returned, measured)) throw new Error("Strict SDR all-delivered-frame callback did not return its owned RGBA observation.");
            values.push(measured!);
          }
          frameIndex += 1;
          frameOffset = 0;
        }
      },
      observeTerminal: (observation) => { terminal = observation; },
      label: `Strict SDR ${input.slot} all-delivered-frame inverse`,
    });
    if (result.exitCode !== 0 || !strictSdrHeldAllFramesTerminalEstablished(terminal)) {
      throw new Error(`Strict SDR ${input.slot} all-delivered-frame inverse could not prove clean natural-EOF FFmpeg settlement.`);
    }
    if (frameOffset !== 0 || frameIndex !== FRAME_COUNT || values.length !== FRAME_COUNT) {
      throw new Error(`Strict SDR ${input.slot} all-delivered-frame inverse did not deliver exactly 60 complete RGBA frames.`);
    }
    input.job.reportProcessContainment(portableFfmpegContainmentEvidence("unix-process-group"));
    assertCurrentHeldToolResolution(input.ffmpeg, resolveFfmpegExecutable, `FFmpeg after strict held ${input.slot} all-delivered-frame inverse`);
    await assertHeldTool(input.ffmpeg, `FFmpeg after strict held ${input.slot} all-delivered-frame inverse`);
    return Object.freeze({
      frames: Object.freeze([...values]),
      heldFfmpeg: Object.freeze({ sha256: input.ffmpeg.sha256 }),
      inverseCommandSha256: canonicalJsonSha256(inverse),
      decodedByteLength: DECODED_BYTE_LENGTH,
    });
  } finally {
    rolling.fill(0);
  }
}

function assertLiteralRoute(route: LinearSrgbSdrFinalRoute): void {
  if (route.canvas.width !== WIDTH || route.canvas.height !== HEIGHT || route.canvas.fps !== FPS || route.canvas.durationMs !== DURATION_MS) {
    throw new Error("Strict SDR all-delivered-frame inverse requires the admitted 1280x720 30fps 2000ms route.");
  }
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function unixProcessGroup(): "unix-process-group" { return "unix-process-group"; }
