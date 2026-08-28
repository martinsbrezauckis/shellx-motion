import {
  LocalMotionJobError,
  assertLocalMotionFrameCountBudget,
  streamingFrameDimensionsRefusal
} from "@shellx-motion/core";
import type { FfmpegCommand } from "./index";
import { toError } from "./streaming-foundation-helpers";
import type { StreamingEncodeAttempt, StreamingFfmpegFinalInput } from "./streaming-foundation-types";

/** Fixed allowance for PNG container, compression, and renderer metadata beyond decoded RGBA. */
export const STREAMING_PNG_CODEC_OVERHEAD_BYTES = 1_048_576;

/**
 * The producer may hold only one frame, so its one frame must be bounded too. PNG's compressed
 * payload can exceed raw RGBA slightly and renderer metadata needs room; the fixed allowance keeps
 * that legitimate variation without admitting an arbitrary ancillary-data blob.
 */
export function streamingMaxPngBytes(width: number, height: number): number {
  return (width * height * 4) + STREAMING_PNG_CODEC_OVERHEAD_BYTES;
}

export function streamingMaxRgbaBytes(width: number, height: number): number {
  return width * height * 4;
}

export function streamingAttemptPolicyError(attempts: readonly StreamingEncodeAttempt[]): {
  code: "streaming_retry_policy_invalid";
  message: string;
} | undefined {
  if (attempts.length === 1 && attempts[0].source === "software") return undefined;
  if (attempts.length === 2 && attempts[0].source === "hardware" && attempts[1].source === "software") return undefined;
  return {
    code: "streaming_retry_policy_invalid",
    message: "Streaming FFmpeg accepts one software attempt or one hardware attempt followed by one software fallback."
  };
}

export function streamingCommandError(
  command: FfmpegCommand,
  input: Pick<StreamingFfmpegFinalInput, "frameFormat" | "width" | "height" | "fps">
): { code: "streaming_command_invalid"; message: string } | undefined {
  if ((input.frameFormat ?? "png") === "rgba") return rawStreamingCommandError(command, input);
  const pipeInputs = command.args.flatMap((arg, index) => arg === "-i" && command.args[index + 1] === "pipe:0" ? [index] : []);
  const stdinAliases = command.args.flatMap((arg, index) => arg === "-i" && (command.args[index + 1] === "-" || command.args[index + 1] === "pipe:0") ? [index] : []);
  const image2PipeFormats = command.args.flatMap((arg, index) => arg === "-f" && command.args[index + 1] === "image2pipe" ? [index] : []);
  const pngCodecs = command.args.flatMap((arg, index) => arg === "-vcodec" && command.args[index + 1] === "png" ? [index] : []);
  const pipeInput = pipeInputs[0];
  const format = image2PipeFormats[0];
  const codec = pngCodecs[0];
  const stdinTokens = command.args.flatMap((arg, index) => isStdinToken(arg) ? [index] : []);
  const canonicalStdinToken = pipeInput === undefined ? undefined : pipeInput + 1;
  if (
    command.shell !== false
    || pipeInputs.length !== 1
    || stdinAliases.length !== 1
    || image2PipeFormats.length !== 1
    || pngCodecs.length !== 1
    || format + 2 !== codec
    || codec + 2 !== pipeInput
    || stdinTokens.length !== 1
    || stdinTokens[0] !== canonicalStdinToken
  ) {
    return {
      code: "streaming_command_invalid",
      message: "Streaming FFmpeg commands require exactly -f image2pipe -vcodec png -i pipe:0, with shell:false and no additional stdin input."
    };
  }
  return undefined;
}

function rawStreamingCommandError(
  command: FfmpegCommand,
  input: Pick<StreamingFfmpegFinalInput, "width" | "height" | "fps">
): { code: "streaming_command_invalid"; message: string } | undefined {
  const pipeInputs = command.args.flatMap((arg, index) => arg === "-i" && command.args[index + 1] === "pipe:0" ? [index] : []);
  const stdinAliases = command.args.flatMap((arg, index) => arg === "-i" && (command.args[index + 1] === "-" || command.args[index + 1] === "pipe:0") ? [index] : []);
  const starts = command.args.flatMap((arg, index) => arg === "-f" && command.args[index + 1] === "rawvideo" ? [index] : []);
  const start = starts[0] ?? -1;
  const expected = ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${input.width}x${input.height}`, "-framerate", String(input.fps), "-i", "pipe:0"];
  const rawInputTokens = ["-pixel_format", "-video_size"].flatMap((token) => command.args.flatMap((arg, index) => arg === token ? [index] : []));
  const stdinTokens = command.args.flatMap((arg, index) => isStdinToken(arg) ? [index] : []);
  const canonicalStdinToken = pipeInputs[0] === undefined ? undefined : pipeInputs[0] + 1;
  if (
    command.shell !== false
    || starts.length !== 1
    || rawInputTokens.length !== 2
    || command.args.slice(start, start + expected.length).join("\0") !== expected.join("\0")
    || pipeInputs.length !== 1
    || stdinAliases.length !== 1
    || stdinTokens.length !== 1
    || stdinTokens[0] !== canonicalStdinToken
  ) {
    return {
      code: "streaming_command_invalid",
      message: `Raw streaming FFmpeg commands require exactly -f rawvideo -pixel_format rgba -video_size ${input.width}x${input.height} -framerate ${input.fps} -i pipe:0, with shell:false and no additional stdin input.`
    };
  }
  return undefined;
}

/** Any standalone reference that asks FFmpeg to read file descriptor zero. */
function isStdinToken(value: string): boolean {
  const normalized = value.toLowerCase();
  return value === "-"
    || normalized === "pipe:"
    // The generated command has exactly one permitted descriptor-zero spelling: `pipe:0`.
    // Treat any wrapper/protocol/options form as a descriptor-zero consumer too, so it cannot share
    // stdin with image2pipe through a filter/script or a second protocol input.
    || normalized.includes("pipe:0")
    || normalized.includes("fd:0")
    || normalized === "/dev/stdin"
    || /^\/dev\/fd\/0+$/.test(normalized)
    || /^\/proc\/(?:self|thread-self)\/fd\/0+$/.test(normalized);
}

export function streamingMetadataError(input: Pick<StreamingFfmpegFinalInput, "frameCount" | "durationMs" | "fps" | "width" | "height"> & { frameFormat?: unknown }): {
  code: "streaming_metadata_invalid" | "job_input_budget_exceeded";
  message: string;
} | undefined {
  if (input.frameFormat !== undefined && input.frameFormat !== "png" && input.frameFormat !== "rgba") {
    return { code: "streaming_metadata_invalid", message: "Streaming frameFormat must be png or rgba." };
  }
  if (!Number.isSafeInteger(input.frameCount) || input.frameCount <= 0) {
    return { code: "streaming_metadata_invalid", message: "Streaming frameCount must be a positive safe integer." };
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || !Number.isFinite(input.fps) || input.fps <= 0) {
    return { code: "streaming_metadata_invalid", message: "Streaming durationMs and fps must be finite positive numbers." };
  }
  const expectedFrameCount = Math.ceil((input.durationMs / 1_000) * input.fps);
  if (input.frameCount !== expectedFrameCount) {
    return { code: "streaming_metadata_invalid", message: `Streaming frameCount ${input.frameCount} must equal ceil(durationMs / 1000 * fps) (${expectedFrameCount}).` };
  }
  const dimensionRefusal = streamingFrameDimensionsRefusal(input.width, input.height);
  if (dimensionRefusal) return { code: "streaming_metadata_invalid", message: dimensionRefusal };
  try {
    assertLocalMotionFrameCountBudget(input.frameCount);
  } catch (error) {
    if (error instanceof LocalMotionJobError && error.code === "job_input_budget_exceeded") {
      return { code: error.code, message: error.message };
    }
    return { code: "job_input_budget_exceeded", message: toError(error).message };
  }
  return undefined;
}
