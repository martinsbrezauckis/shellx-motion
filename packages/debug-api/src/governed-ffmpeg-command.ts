/** Caller-bound FFmpeg execution shared by Debug render and procedural-envelope decoding. */
import {
  createGovernedFfmpegRunner,
  type FfmpegCommand,
  type FfmpegProcessResult,
  type FfmpegRunner,
} from "@shellx-motion/renderer-ffmpeg";

export async function runGovernedFfmpegCommand(
  command: FfmpegCommand,
  runner?: FfmpegRunner,
  callerId?: string,
): Promise<FfmpegProcessResult> {
  if (runner) return runner(command);
  return createGovernedFfmpegRunner(callerId ? { callerId } : {})(command);
}

export function callerBoundFfmpegRunner(runner: FfmpegRunner | undefined, callerId: string): FfmpegRunner {
  return async (command) => await runGovernedFfmpegCommand(command, runner, callerId);
}
