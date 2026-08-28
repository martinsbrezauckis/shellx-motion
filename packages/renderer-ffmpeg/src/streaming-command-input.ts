import type { FfmpegCommand } from "./index.js";

/** Convert the existing image-sequence command shape without altering audio/filter/output args. */
export function image2PipeCommandFromImageSequence(command: FfmpegCommand): FfmpegCommand {
  return pipeCommandFromImageSequence(command, ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]);
}

/** Replace the materialized frame input with tightly packed straight-alpha sRGB rawvideo. */
export function rawVideoCommandFromImageSequence(
  command: FfmpegCommand,
  input: { width: number; height: number; fps: number }
): FfmpegCommand {
  if (!Number.isSafeInteger(input.width) || input.width <= 0 || !Number.isSafeInteger(input.height) || input.height <= 0 || !Number.isFinite(input.fps) || input.fps <= 0) {
    throw new Error("Rawvideo conversion requires positive dimensions and frame rate.");
  }
  return pipeCommandFromImageSequence(command, [
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${input.width}x${input.height}`,
    "-framerate", String(input.fps),
    "-i", "pipe:0"
  ]);
}

function pipeCommandFromImageSequence(command: FfmpegCommand, replacement: string[]): FfmpegCommand {
  const args = [...command.args];
  const framerateIndexes = args.flatMap((arg, index) => arg === "-framerate" ? [index] : []);
  const startNumberIndexes = args.flatMap((arg, index) => arg === "-start_number" ? [index] : []);
  if (framerateIndexes.length !== 1 || startNumberIndexes.length !== 1) {
    throw new Error("Image2pipe conversion requires exactly one standard image-sequence input.");
  }
  const framerate = framerateIndexes[0];
  const startNumber = startNumberIndexes[0];
  const frameInput = args[startNumber + 2] === "-protocol_whitelist" && args[startNumber + 3] === "file"
    ? startNumber + 4
    : startNumber + 2;
  const source = args[frameInput + 1];
  if (startNumber !== framerate + 2 || args[startNumber + 1] !== "1" || args[frameInput] !== "-i" || !source || source === "pipe:0") {
    throw new Error("Image2pipe conversion requires -framerate <fps> -start_number 1 -i <frames> as the unique frame input.");
  }
  args.splice(startNumber, frameInput + 2 - startNumber, ...replacement);
  return { executable: command.executable, args, shell: false };
}
